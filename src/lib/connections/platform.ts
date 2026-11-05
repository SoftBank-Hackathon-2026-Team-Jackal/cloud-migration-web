import type { ApiErrorCode, PlatformAgent } from './types.ts'

/**
 * 플랫폼 API(FastAPI)의 온프레미스 Agent 운영자 엔드포인트. 웹 서버 안에서만 부른다.
 * 플랫폼에는 CORS가 없고 운영자 키 헤더로 보호되므로 브라우저가 직접 부르지 않는다(BFF).
 * 운영자 키·등록 토큰은 오류 메시지·로그에 넣지 않는다.
 */
export type PlatformDeps = {
  base: string
  enrollmentAdminKey: string
  fetchImpl?: typeof fetch
}

export class PlatformError extends Error {
  readonly status: number
  readonly code: ApiErrorCode
  readonly detail: string | null
  constructor(status: number, code: ApiErrorCode, detail: string | null = null) {
    super(code)
    this.status = status
    this.code = code
    this.detail = detail
  }
}

const TIMEOUT_MS = 8000

/** 플랫폼 응답 상태를 BFF 오류로 바꾼다. 404 detail(AGENT_NOT_FOUND 등)과 409 detail(AGENT_ID_RESERVED)은 코드만 남긴다. */
export function errorFor(status: number, detail: string | null): PlatformError {
  if (status === 403 || status === 401) return new PlatformError(403, 'operator_key')
  if (status === 404) return new PlatformError(404, 'not_found', detail)
  if (status === 409) return new PlatformError(409, 'conflict', detail)
  if (status === 422 || status === 400) return new PlatformError(400, 'bad_request')
  if (status === 503) return new PlatformError(503, 'unavailable')
  return new PlatformError(502, 'platform_error')
}

/** detail은 코드 형태(대문자·숫자·밑줄)일 때만 쓴다. 자유 문장은 버린다. */
function codeOnly(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : null
}

async function call<T>(deps: PlatformDeps, method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
  if (!deps.enrollmentAdminKey) throw new PlatformError(503, 'unavailable', 'NOT_CONFIGURED')
  const fetchImpl = deps.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(deps.base.replace(/\/+$/, '') + path, {
      method,
      headers: { 'X-Enrollment-Admin-Key': deps.enrollmentAdminKey, ...(body ? { 'Content-Type': 'application/json' } : {}), Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new PlatformError(503, 'unavailable', 'UNREACHABLE')
  }
  if (!response.ok) {
    const detail = await response.json().then((data: { detail?: unknown }) => codeOnly(data?.detail), () => null)
    throw errorFor(response.status, detail)
  }
  return await response.json() as T
}

function toAgent(value: unknown): PlatformAgent {
  const data = value as Partial<PlatformAgent> | null
  if (!data || typeof data.agent_id !== 'string') throw new PlatformError(502, 'platform_error')
  return {
    agent_id: data.agent_id,
    owner_id: typeof data.owner_id === 'string' ? data.owner_id : '',
    cluster_uid: typeof data.cluster_uid === 'string' ? data.cluster_uid : null,
    last_seen_at: typeof data.last_seen_at === 'number' ? data.last_seen_at : null,
    revoked: data.revoked === true,
  }
}

/** POST /agent-enrollments → 등록 토큰(한 번만 쓰는 값) */
export async function issueEnrollment(deps: PlatformDeps, input: { ownerId: string; agentId: string; ttlSeconds: number }): Promise<{ enrollment_token: string; expires_in_seconds: number }> {
  const data = await call<{ enrollment_token?: unknown; expires_in_seconds?: unknown }>(deps, 'POST', '/agent-enrollments',
    { owner_id: input.ownerId, agent_id: input.agentId, cluster_uid: null, ttl_seconds: input.ttlSeconds })
  if (typeof data.enrollment_token !== 'string' || !data.enrollment_token) throw new PlatformError(502, 'platform_error')
  return { enrollment_token: data.enrollment_token, expires_in_seconds: typeof data.expires_in_seconds === 'number' ? data.expires_in_seconds : input.ttlSeconds }
}

/** GET /agent-admin/agents/{agent_id} */
export async function getAgent(deps: PlatformDeps, agentId: string): Promise<PlatformAgent> {
  return toAgent(await call(deps, 'GET', '/agent-admin/agents/' + encodeURIComponent(agentId)))
}

/** POST /agent-admin/agents/{agent_id}/revoke */
export async function revokeAgent(deps: PlatformDeps, agentId: string): Promise<PlatformAgent> {
  return toAgent(await call(deps, 'POST', '/agent-admin/agents/' + encodeURIComponent(agentId) + '/revoke'))
}
