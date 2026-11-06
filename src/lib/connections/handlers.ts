import type { AgentIdStore, AgentsApi, ConnectionsApi } from './adapter.ts'
import { PlatformError } from './platform.ts'
import {
  agentState, AWS_REGIONS, installCommand, isAgentId, isRoleArn, ttlSeconds,
  type AgentView, type ApiErrorCode, type ConnectionsList, type PlatformAgent, type ScopeLevel, type ScopeSelection,
} from './types.ts'

/**
 * /api/connections·/api/agents·/api/scope 라우트의 본체(BFF). 의존성을 주입받아 단위 테스트에서 가짜 플랫폼으로 시험한다.
 * - 운영자 키는 deps 안(서버 환경변수)에만 있고 응답에 넣지 않는다.
 * - 등록 토큰은 발급 응답 한 번에만 싣고 저장·기록하지 않는다(Cache-Control: no-store).
 */
export type ConnectionsDeps = {
  connections: ConnectionsApi
  agents: AgentsApi
  agentIds: AgentIdStore
  ownerId: string
  /** 설치 명령의 platform.url(플랫폼 공개 HTTPS 주소). 비어 있으면 발급을 막는다. */
  platformUrl: string
  now?: () => number
}

const json = (status: number, body: object) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const fail = (status: number, error: ApiErrorCode, detail: string | null = null) => json(status, detail ? { error, detail } : { error })

function fromError(error: unknown): Response {
  if (error instanceof PlatformError) return fail(error.status, error.code, error.detail)
  return fail(502, 'platform_error')
}

/** 목록 묶음의 오류: 코드와(있으면) 설정 누락 같은 원인 코드 */
const errorMeta = (reason: unknown) => reason instanceof PlatformError ? { error: reason.code, detail: reason.detail } : { error: 'platform_error' as const, detail: null }

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json() as unknown
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch { return null }
}

const nowSec = (deps: ConnectionsDeps) => Math.floor((deps.now?.() ?? Date.now()) / 1000)

async function viewOf(deps: ConnectionsDeps, agent: PlatformAgent): Promise<AgentView> {
  const tunnel = await deps.connections.tunnelStatus(agent.agent_id, agent).catch(() => null)
  return {
    agent_id: agent.agent_id, cluster_uid: agent.cluster_uid, last_seen_at: agent.last_seen_at, revoked: agent.revoked,
    online: agentState(agent, nowSec(deps)) === 'online', version: null, tunnel,
  }
}

/** 등록 토큰은 발급했지만 에이전트가 아직 등록하지 않은 상태(실제 API 404) */
const enrolledOnly = (agentId: string): AgentView => ({ agent_id: agentId, cluster_uid: null, last_seen_at: null, online: false, revoked: false, version: null, tunnel: null, enrolled_only: true })

async function agentView(deps: ConnectionsDeps, agentId: string): Promise<AgentView> {
  try {
    return await viewOf(deps, await deps.agents.getAgent(agentId))
  } catch (error) {
    if (error instanceof PlatformError && error.status === 404) return enrolledOnly(agentId)
    throw error
  }
}

/** 웹이 등록한 id + (실제 API면) 플랫폼에 등록된 id. 플랫폼 목록을 못 읽으면 오류를 그대로 알린다. */
async function agentIdsFor(deps: ConnectionsDeps): Promise<string[]> {
  const known = deps.agentIds.list()
  if (!deps.agents.listAgentIds) return known
  const platform = await deps.agents.listAgentIds()
  return [...new Set([...platform, ...known])]
}

/** GET /api/connections → 통합 목록. 한 묶음이 실패해도 다른 묶음은 보여 준다. */
export async function handleList(_request: Request, deps: ConnectionsDeps): Promise<Response> {
  const body: ConnectionsList = {
    connections: [], agents: [], checked_at: nowSec(deps),
    meta: { connections: { mock: deps.connections.mock, error: null }, agents: { mock: deps.agents.mock, error: null } },
  }
  const [connections, agents] = await Promise.allSettled([
    deps.connections.listConnections(),
    agentIdsFor(deps).then(ids => Promise.all(ids.map(id => agentView(deps, id)))),
  ])
  if (connections.status === 'fulfilled') body.connections = connections.value
  else Object.assign(body.meta.connections, errorMeta(connections.reason))
  if (agents.status === 'fulfilled') body.agents = agents.value
  else Object.assign(body.meta.agents, errorMeta(agents.reason))
  return json(200, body)
}

/** POST /api/connections {kind, display_name, region} [가정 · #23] */
export async function handleCreateConnection(request: Request, deps: ConnectionsDeps): Promise<Response> {
  const body = await readJson(request)
  const kind = body?.kind
  const name = typeof body?.display_name === 'string' ? body.display_name.trim() : ''
  const region = body?.region
  if ((kind !== 'AWS_SOURCE' && kind !== 'AWS_TARGET') || !name || name.length > 120 || !(AWS_REGIONS as readonly unknown[]).includes(region)) return fail(400, 'bad_request')
  try { return json(201, await deps.connections.createConnection({ kind, display_name: name, region: region as string })) } catch (error) { return fromError(error) }
}

/** PUT /api/connections/{id}/role {role_arn} [가정 · #23] */
export async function handleSetRole(request: Request, deps: ConnectionsDeps, connectionId: string): Promise<Response> {
  const body = await readJson(request)
  if (!isRoleArn(body?.role_arn)) return fail(400, 'bad_request', 'INVALID_ROLE_ARN')
  try { return json(200, { connection: await deps.connections.setRole(connectionId, (body!.role_arn as string).trim()) }) } catch (error) { return fromError(error) }
}

/** POST /api/connections/{id}/verify [가정 · #23] → 늘 200 {status, code, checked_at, account_id?, eks_clusters?} */
export async function handleVerifyConnection(_request: Request, deps: ConnectionsDeps, connectionId: string): Promise<Response> {
  try { return json(200, await deps.connections.verifyConnection(connectionId)) } catch (error) { return fromError(error) }
}

/** DELETE /api/connections/{id} [가정 · #23] */
export async function handleDeleteConnection(_request: Request, deps: ConnectionsDeps, connectionId: string): Promise<Response> {
  try { return json(200, await deps.connections.deleteConnection(connectionId)) } catch (error) { return fromError(error) }
}

/**
 * POST /api/agents {agent_id, ttl_minutes} → 실제 API POST /agent-enrollments.
 * 응답에 토큰과 설치 명령을 한 번만 싣는다. 웹 서버는 토큰을 저장·기록하지 않고 agent_id만 기억한다.
 */
export async function handleEnroll(request: Request, deps: ConnectionsDeps): Promise<Response> {
  const body = await readJson(request)
  const agentId = body?.agent_id
  const ttl = ttlSeconds(body?.ttl_minutes ?? 10)
  if (!isAgentId(agentId) || ttl === null) return fail(400, 'bad_request')
  if (!deps.platformUrl) return fail(503, 'unavailable', 'PLATFORM_URL_NOT_CONFIGURED')
  try {
    const issued = await deps.agents.issueEnrollment({ ownerId: deps.ownerId, agentId, ttlSeconds: ttl })
    deps.agentIds.add(agentId)
    const expires = issued.expires_in_seconds > 0 ? issued.expires_in_seconds : ttl
    return json(201, {
      agent_id: agentId, expires_in_seconds: expires,
      enrollment_token: issued.enrollment_token,
      install_command: installCommand(agentId, deps.platformUrl, issued.enrollment_token),
    })
  } catch (error) {
    return fromError(error)
  }
}

/** GET /api/agents/{id} → 실제 API GET /agent-admin/agents/{id} (+ [가정] 터널 상태) */
export async function handleAgentStatus(_request: Request, deps: ConnectionsDeps, agentId: string): Promise<Response> {
  if (!isAgentId(agentId)) return fail(400, 'bad_request')
  try {
    const agent = await deps.agents.getAgent(agentId)
    return json(200, { agent: await viewOf(deps, agent) })
  } catch (error) {
    // 웹이 등록한 적 있는 id의 404는 "설치 대기"(아직 에이전트가 등록하지 않음)
    if (error instanceof PlatformError && error.status === 404 && deps.agentIds.list().includes(agentId)) return json(200, { agent: enrolledOnly(agentId) })
    return fromError(error)
  }
}

/** POST /api/agents/{id}/revoke → 실제 API POST /agent-admin/agents/{id}/revoke */
export async function handleRevoke(_request: Request, deps: ConnectionsDeps, agentId: string): Promise<Response> {
  if (!isAgentId(agentId)) return fail(400, 'bad_request')
  try { return json(200, { agent: await viewOf(deps, await deps.agents.revokeAgent(agentId)) }) } catch (error) { return fromError(error) }
}

/** DELETE /api/agents/{id} → 웹 서버의 기억에서만 지운다(플랫폼에는 아무 것도 보내지 않는다) */
export async function handleForget(_request: Request, deps: ConnectionsDeps, agentId: string): Promise<Response> {
  if (!isAgentId(agentId)) return fail(400, 'bad_request')
  deps.agentIds.remove(agentId)
  return json(200, { forgotten: agentId })
}

const LEVELS: ScopeLevel[] = ['regions', 'clusters', 'namespaces', 'workloads']
// 클러스터 단계는 #23의 GET /connections/{id}/eks-clusters?region= 로 바꿔 끼울 자리다(지금은 목업 어댑터가 같은 값을 준다).
const NAME = /^[\w.\-:/]{1,128}$/
const field = (value: unknown) => (typeof value === 'string' && NAME.test(value) ? value : undefined)

/** GET /api/scope/options?level=&connection_id=&region=&cluster=&namespace= [가정] */
export async function handleScopeOptions(request: Request, deps: ConnectionsDeps): Promise<Response> {
  const params = new URL(request.url).searchParams
  const level = params.get('level') as ScopeLevel
  const connectionId = field(params.get('connection_id'))
  if (!LEVELS.includes(level) || !connectionId) return fail(400, 'bad_request')
  const selection: Partial<ScopeSelection> = { connection_id: connectionId, region: field(params.get('region')), cluster: field(params.get('cluster')), namespace: field(params.get('namespace')) }
  try { return json(200, { level, options: await deps.connections.listScopeOptions(level, selection) }) } catch (error) { return fromError(error) }
}

/** POST /api/scope/analyze {connection_id, region, cluster, namespace, workload} [가정] */
export async function handleScopeAnalyze(request: Request, deps: ConnectionsDeps): Promise<Response> {
  const body = await readJson(request)
  const selection = { connection_id: field(body?.connection_id), region: field(body?.region), cluster: field(body?.cluster), namespace: field(body?.namespace), workload: field(body?.workload) }
  if (Object.values(selection).some(value => !value)) return fail(400, 'bad_request')
  try { return json(200, await deps.connections.analyzeScope(selection as ScopeSelection)) } catch (error) { return fromError(error) }
}

/** POST /api/scope/confirm {analysis_id, included[]} [가정] */
export async function handleScopeConfirm(request: Request, deps: ConnectionsDeps): Promise<Response> {
  const body = await readJson(request)
  const analysisId = field(body?.analysis_id)
  const included = Array.isArray(body?.included) ? body.included.filter((id): id is string => typeof id === 'string' && NAME.test(id)) : null
  if (!analysisId || !included || !included.length) return fail(400, 'bad_request')
  try { return json(200, await deps.connections.confirmScope(analysisId, included)) } catch (error) { return fromError(error) }
}
