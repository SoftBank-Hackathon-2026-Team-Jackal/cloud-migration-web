import type { AgentsApi } from './adapter.ts'
import type { ConnectionsDeps } from './handlers.ts'
import { createMockAgents, createMockConnections, memoryAgentIds } from './mock.ts'
import { getAgent, issueEnrollment, listAgentIds, revokeAgent, type PlatformDeps } from './platform.ts'
import { createRealConnections } from './real.ts'

/**
 * 라우트 파일이 쓰는 서버 전용 설정. 환경변수는 모두 NEXT_PUBLIC_ 없이 서버에만 있다(클라이언트 번들에 들어가지 않는다).
 *   PLATFORM_API_BASE               플랫폼 API(기본 http://127.0.0.1:8000, 데모 서버에서는 루프백에만 열려 있다)
 *   PLATFORM_ENROLLMENT_ADMIN_KEY   X-Enrollment-Admin-Key 값(Agent 등록·조회·폐기)
 *   PLATFORM_PUBLIC_URL             설치 명령의 platform.url(에이전트가 닿는 플랫폼 공개 HTTPS 주소)
 *   PLATFORM_OWNER_ID               등록 요청의 owner_id(기본 platform)
 *   PLATFORM_KNOWN_AGENT_IDS        (선택) 웹 서버 재시작 뒤에도 목록에 보일 agent_id, 쉼표 구분
 *   PLATFORM_CONNECTIONS            real | mock. 클라우드 연결(Ticket 23 /connections)과 Agent를 실제 API로 부를지 목업으로 답할지.
 *                                   비우면 프로덕션(next start)은 real, 개발 서버·NEXT_PUBLIC_API_MODE=mock 빌드는 mock이다.
 * real에서 PLATFORM_API_BASE·PLATFORM_ENROLLMENT_ADMIN_KEY가 비어 있으면 목업으로 떨어지지 않고 503과 설정 누락 코드를 돌려준다.
 * mock이어도 운영자 키가 있으면 Agent는 실제 API를 쓴다(연결만 목업).
 */
const env = (name: string) => (process.env[name] ?? '').trim()

export type PlatformMode = 'real' | 'mock'

/** 연결·Agent 모드: 명시한 PLATFORM_CONNECTIONS > 프로덕션 기본 real > 개발·목업 빌드 mock */
export function platformMode(values: { connections?: string; nodeEnv?: string; apiMode?: string } = {
  connections: env('PLATFORM_CONNECTIONS'), nodeEnv: process.env.NODE_ENV, apiMode: process.env.NEXT_PUBLIC_API_MODE,
}): PlatformMode {
  const explicit = (values.connections ?? '').trim().toLowerCase()
  if (explicit === 'real' || explicit === 'mock') return explicit
  if (values.apiMode === 'mock') return 'mock'
  return values.nodeEnv === 'production' ? 'real' : 'mock'
}

export function platformDeps(): PlatformDeps {
  // 개발 서버에서만 로컬 플랫폼 기본 주소를 쓴다. 프로덕션에서 비어 있으면 호출 때 설정 누락으로 실패한다.
  const fallback = process.env.NODE_ENV === 'production' ? '' : 'http://127.0.0.1:8000'
  return { base: env('PLATFORM_API_BASE') || fallback, enrollmentAdminKey: env('PLATFORM_ENROLLMENT_ADMIN_KEY') }
}

function realAgents(deps: PlatformDeps): AgentsApi {
  return {
    mock: false,
    issueEnrollment: input => issueEnrollment(deps, input),
    getAgent: id => getAgent(deps, id),
    revokeAgent: id => revokeAgent(deps, id),
    listAgentIds: () => listAgentIds(deps),
  }
}

/** Agent 목업: 연결도 목업이고 운영자 키도 없을 때만 */
export function mockAgentsEnabled(mode = platformMode()): boolean {
  return mode === 'mock' && !env('PLATFORM_ENROLLMENT_ADMIN_KEY')
}

export function connectionsDeps(): ConnectionsDeps {
  const mode = platformMode()
  const mockAgents = mockAgentsEnabled(mode)
  const seed = env('PLATFORM_KNOWN_AGENT_IDS').split(',').map(id => id.trim()).filter(Boolean)
  return {
    connections: mode === 'real' ? createRealConnections(platformDeps()) : createMockConnections(),
    agents: mockAgents ? createMockAgents() : realAgents(platformDeps()),
    agentIds: memoryAgentIds(mockAgents ? ['office-seoul-01', ...seed] : seed),
    ownerId: env('PLATFORM_OWNER_ID') || 'platform',
    platformUrl: env('PLATFORM_PUBLIC_URL') || (mockAgents ? 'https://platform.jackal.example' : ''),
  }
}

/**
 * 상태를 바꾸는 요청은 같은 출처에서 온 것만 받는다(다른 사이트가 숨은 폼으로 토큰을 발급·폐기하지 못하게).
 * 브라우저는 POST·DELETE에 Origin을 붙인다. 헤더가 없으면(서버 간 호출·curl) 막지 않는다.
 */
export function crossOrigin(request: Request): Response | null {
  const origin = request.headers.get('origin')
  if (!origin) return null
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
  try {
    if (new URL(origin).host === host) return null
  } catch { /* 잘못된 Origin */ }
  return Response.json({ error: 'bad_request', detail: 'CROSS_ORIGIN' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
}
