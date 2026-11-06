import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getAgent, issueEnrollment, revokeAgent, PlatformError } from '../../src/lib/connections/platform.ts'
import {
  handleAgentStatus, handleCreateConnection, handleDeleteConnection, handleEnroll, handleList, handleRevoke, handleScopeAnalyze, handleScopeConfirm,
  handleScopeOptions, handleSetRole, handleVerifyConnection,
  type ConnectionsDeps,
} from '../../src/lib/connections/handlers.ts'
import { createMockAgents, createMockConnections, memoryAgentIds, resetMock } from '../../src/lib/connections/mock.ts'
import { createRealConnections } from '../../src/lib/connections/real.ts'
import { platformMode } from '../../src/lib/connections/server.ts'
import { decideAccess, parseAllowedLogins } from '../../src/lib/connections/access.ts'
import { listAgentIds } from '../../src/lib/connections/platform.ts'
import { agentState, installCommand, isAgentId, isRoleArn, ttlSeconds } from '../../src/lib/connections/types.ts'
import type { AgentsApi } from '../../src/lib/connections/adapter.ts'

const KEY = 'operator-key-not-real-123'
const TOKEN = 'enroll-token-not-real-abc'
type Call = { url: string; method: string; headers: Headers; body: unknown }

/** 가짜 플랫폼: 실제 FastAPI와 같은 경로·응답·오류(403·404·409) */
function fakePlatform() {
  const calls: Call[] = []
  const agents = new Map<string, { last_seen_at: number | null; revoked: boolean; registered: boolean }>()
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = new Headers(init?.headers)
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: url.pathname, method: init?.method ?? 'GET', headers, body })
    if (headers.get('x-enrollment-admin-key') !== KEY) return Response.json({ detail: 'Enrollment administration unavailable' }, { status: 403 })
    if (url.pathname === '/agent-enrollments') {
      if (agents.has(body.agent_id)) return Response.json({ detail: 'AGENT_ID_RESERVED' }, { status: 409 })
      agents.set(body.agent_id, { last_seen_at: null, revoked: false, registered: false })
      return Response.json({ enrollment_token: TOKEN, expires_in_seconds: body.ttl_seconds })
    }
    const match = url.pathname.match(/^\/agent-admin\/agents\/([^/]+)(\/revoke)?$/)
    const agent = match && agents.get(decodeURIComponent(match[1]))
    if (!match || !agent?.registered) return Response.json({ detail: 'AGENT_NOT_FOUND' }, { status: 404 })
    if (match[2]) agent.revoked = true
    return Response.json({ agent_id: match[1], owner_id: 'platform', cluster_uid: 'uid-1', last_seen_at: agent.last_seen_at, revoked: agent.revoked })
  }) as typeof fetch
  return { calls, agents, fetchImpl }
}

function deps(platform: ReturnType<typeof fakePlatform>, extra: Partial<ConnectionsDeps> = {}): ConnectionsDeps {
  resetMock()
  const p = { base: 'http://platform.test', enrollmentAdminKey: KEY, fetchImpl: platform.fetchImpl }
  const agents: AgentsApi = { mock: false, issueEnrollment: input => issueEnrollment(p, input), getAgent: id => getAgent(p, id), revokeAgent: id => revokeAgent(p, id) }
  return { connections: createMockConnections({ delayMs: 0 }), agents, agentIds: memoryAgentIds(), ownerId: 'platform', platformUrl: 'https://cmp.example.test', ...extra }
}

const post = (body: object) => new Request('http://web.test/api', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const get = (path = '/api') => new Request('http://web.test' + path)

test('규칙: agent_id·유효 시간·역할 ARN·상태 칩', () => {
  assert.ok(isAgentId('laptop-k3s') && isAgentId('a') && isAgentId('a'.repeat(63)))
  assert.ok(!isAgentId('Laptop') && !isAgentId('-x') && !isAgentId('x-') && !isAgentId('a'.repeat(64)) && !isAgentId('a_b'))
  assert.equal(ttlSeconds(10), 600)
  assert.equal(ttlSeconds(60), 3600)
  assert.equal(ttlSeconds(61), null)
  assert.equal(ttlSeconds(0), null)
  assert.ok(isRoleArn('arn:aws:iam::123456789012:role/cmp-source-readonly'))
  assert.ok(isRoleArn('arn:aws:iam::123456789012:role/path/to/role'))
  assert.ok(!isRoleArn('arn:aws:iam::12345:role/x') && !isRoleArn('arn:aws:iam::123456789012:user/x'))
  assert.equal(agentState({ revoked: true, last_seen_at: 100 }, 100), 'revoked')
  assert.equal(agentState({ revoked: false, last_seen_at: null }, 100), 'pending')
  assert.equal(agentState({ revoked: false, last_seen_at: 40 }, 100), 'online')
  assert.equal(agentState({ revoked: false, last_seen_at: 39 }, 100), 'offline')
  assert.equal(installCommand('laptop-k3s', 'https://cmp.example.test', 'tok'),
    'helm install cmp-agent oci://ghcr.io/softbank-hackathon-2026-team-jackal/charts/onprem-agent --version 0.1.0 -n cmp-system --create-namespace --set agentId=laptop-k3s --set platform.url=https://cmp.example.test --set enrollmentToken=tok')
})

test('Agent 발급: 실제 API 형태로 부르고 토큰·설치 명령은 응답 한 번에만 싣는다', async () => {
  const platform = fakePlatform()
  const d = deps(platform)
  const response = await handleEnroll(post({ agent_id: 'laptop-k3s', ttl_minutes: 15 }), d)
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.equal(body.enrollment_token, TOKEN)
  assert.ok(body.install_command.endsWith('--set enrollmentToken=' + TOKEN))
  assert.equal(body.expires_in_seconds, 900)
  assert.deepEqual(platform.calls[0].body, { owner_id: 'platform', agent_id: 'laptop-k3s', cluster_uid: null, ttl_seconds: 900 })
  assert.equal(platform.calls[0].headers.get('x-enrollment-admin-key'), KEY)
  assert.deepEqual(d.agentIds.list(), ['laptop-k3s'])

  // 설치 전: 실제 API는 404 → 설치 대기
  const pending = await (await handleAgentStatus(get(), d, 'laptop-k3s')).json()
  assert.equal(pending.agent.enrolled_only, true)
  assert.equal(agentState(pending.agent, 0), 'pending')

  // 등록 후 목록에 실제 상태가 보이고, 응답 어디에도 토큰·운영자 키가 없다
  platform.agents.get('laptop-k3s')!.registered = true
  platform.agents.get('laptop-k3s')!.last_seen_at = Math.floor(Date.now() / 1000) - 5
  const list = await (await handleList(get(), d)).text()
  assert.ok(!list.includes(TOKEN) && !list.includes(KEY))
  const parsed = JSON.parse(list)
  assert.equal(parsed.agents[0].online, true)
  assert.equal(parsed.meta.agents.mock, false)
  assert.equal(parsed.meta.connections.mock, true)

  // 폐기
  const revoked = await (await handleRevoke(post({}), d, 'laptop-k3s')).json()
  assert.equal(revoked.agent.revoked, true)
  assert.equal(platform.calls.at(-1)!.url, '/agent-admin/agents/laptop-k3s/revoke')
})

test('오류 매핑: 403 운영자 키 · 409 이미 쓰는 id · 503 닿지 않음 · 400 입력', async () => {
  const platform = fakePlatform()
  const wrongKey = deps(platform)
  const p = { base: 'http://platform.test', enrollmentAdminKey: 'wrong', fetchImpl: platform.fetchImpl }
  wrongKey.agents = { mock: false, issueEnrollment: input => issueEnrollment(p, input), getAgent: id => getAgent(p, id), revokeAgent: id => revokeAgent(p, id) }
  const forbidden = await handleEnroll(post({ agent_id: 'a1' }), wrongKey)
  assert.equal(forbidden.status, 403)
  assert.deepEqual(await forbidden.json(), { error: 'operator_key' })

  const d = deps(platform)
  await handleEnroll(post({ agent_id: 'dup' }), d)
  const conflict = await handleEnroll(post({ agent_id: 'dup' }), d)
  assert.equal(conflict.status, 409)
  assert.deepEqual(await conflict.json(), { error: 'conflict', detail: 'AGENT_ID_RESERVED' })

  const down = { base: 'http://platform.test', enrollmentAdminKey: KEY, fetchImpl: (async () => { throw new TypeError('ECONNREFUSED') }) as typeof fetch }
  await assert.rejects(getAgent(down, 'x'), (error: PlatformError) => error.status === 503 && error.code === 'unavailable')
  await assert.rejects(getAgent({ base: 'x', enrollmentAdminKey: '' }, 'x'), (error: PlatformError) => error.status === 503 && error.detail === 'PLATFORM_ADMIN_KEY_NOT_CONFIGURED')

  assert.equal((await handleEnroll(post({ agent_id: 'Bad_ID' }), d)).status, 400)
  assert.equal((await handleEnroll(post({ agent_id: 'ok', ttl_minutes: 90 }), d)).status, 400)
  assert.equal((await handleAgentStatus(get(), d, 'unknown')).status, 404)
  const noUrl = await handleEnroll(post({ agent_id: 'ok2' }), { ...d, platformUrl: '' })
  assert.equal(noUrl.status, 503)
})

test('목록: Agent 쪽이 실패해도 연결 목록은 보여 준다', async () => {
  const platform = fakePlatform()
  const d = deps(platform)
  d.agentIds.add('a1')
  d.agents = { ...d.agents, getAgent: async () => { throw new PlatformError(503, 'unavailable') } }
  const body = await (await handleList(get(), d)).json()
  assert.equal(body.connections.length, 2)
  assert.equal(body.meta.agents.error, 'unavailable')
})

test('[가정 · #23 형태] AWS 연결: 만들기 → 역할 등록 → 확인 → 삭제, 범위 선택 목업 흐름', async () => {
  const d = deps(fakePlatform())
  assert.equal((await handleCreateConnection(post({ kind: 'AWS_SOURCE', display_name: 'x', region: 'mars-1' }), d)).status, 400)
  const created = await (await handleCreateConnection(post({ kind: 'AWS_SOURCE', display_name: 'prod', region: 'ap-northeast-2' }), d)).json()
  assert.deepEqual(Object.keys(created).sort(), ['connection_id', 'display_name', 'external_id', 'kind', 'launch_stack_url', 'status'])
  assert.equal(created.status, 'PENDING')
  const notSet = await handleVerifyConnection(post({}), d, created.connection_id)
  assert.deepEqual(await notSet.json(), { error: 'conflict', detail: 'ROLE_NOT_SET' })
  assert.equal((await handleSetRole(post({ role_arn: 'nope' }), d, created.connection_id)).status, 400)
  await handleSetRole(post({ role_arn: 'arn:aws:iam::111122223333:role/denied' }), d, created.connection_id)
  const denied = await (await handleVerifyConnection(post({}), d, created.connection_id)).json()
  assert.deepEqual([denied.status, denied.code], ['FAILED', 'ASSUME_ROLE_DENIED'])
  await handleSetRole(post({ role_arn: 'arn:aws:iam::111122223333:role/cmp' }), d, created.connection_id)
  const okay = await (await handleVerifyConnection(post({}), d, created.connection_id)).json()
  assert.deepEqual([okay.status, okay.account_id, okay.eks_clusters], ['CONNECTED', '111122223333', ['chat-prod']])
  assert.equal(typeof okay.checked_at, 'number')
  const listed = (await (await handleList(get(), d)).json()).connections.find((item: { connection_id: string }) => item.connection_id === created.connection_id)
  assert.equal(typeof listed.last_verified_at, 'number')
  const removed = await (await handleDeleteConnection(get(), d, created.connection_id)).json()
  assert.equal(removed.deleted, true)
  assert.equal(removed.stack_name, 'cmp-source-role')
  assert.equal((await handleVerifyConnection(post({}), d, 'c-404')).status, 404)

  const regions = await (await handleScopeOptions(get('/api/scope/options?level=regions&connection_id=c-1'), d)).json()
  assert.ok(regions.options.includes('ap-northeast-2'))
  const empty = await (await handleScopeOptions(get('/api/scope/options?level=clusters&connection_id=c-1&region=us-east-1'), d)).json()
  assert.deepEqual(empty.options, [])
  const analysis = await (await handleScopeAnalyze(post({ connection_id: 'c-1', region: 'ap-northeast-2', cluster: 'chat-prod', namespace: 'chat', workload: 'chat-api' }), d)).json()
  assert.ok(analysis.candidates.length >= 5)
  const kinds = new Set(analysis.candidates.flatMap((item: { evidence: Array<{ kind: string }> }) => item.evidence.map(e => e.kind)))
  for (const kind of ['MANIFEST', 'IAM_POLICY', 'CLOUDTRAIL', 'CODE', 'CONFIG']) assert.ok(kinds.has(kind), kind)
  assert.equal((await handleScopeConfirm(post({ analysis_id: analysis.analysis_id, included: [] }), d)).status, 400)
  const confirmed = await (await handleScopeConfirm(post({ analysis_id: analysis.analysis_id, included: ['rds', 's3'] }), d)).json()
  assert.deepEqual(confirmed.included, ['rds', 's3'])
  assert.ok(confirmed.excluded.includes('alb'))
})

test('목업 Agent는 실제 API처럼 409·404를 흉내 낸다', async () => {
  resetMock(0)
  let now = 0
  const agents = createMockAgents({ now: () => now })
  await agents.issueEnrollment({ ownerId: 'platform', agentId: 'new-one', ttlSeconds: 600 })
  await assert.rejects(agents.issueEnrollment({ ownerId: 'platform', agentId: 'new-one', ttlSeconds: 600 }), (error: PlatformError) => error.status === 409)
  await assert.rejects(agents.getAgent('new-one'), (error: PlatformError) => error.status === 404)
  now = 20_000
  assert.equal(agentState(await agents.getAgent('new-one'), 20), 'online')
})

// ---- 실제 연결 어댑터(real.ts) · 백엔드 Ticket 23 /connections ----

const LAUNCH = 'https://ap-northeast-2.console.aws.amazon.com/cloudformation/home?region=ap-northeast-2#/stacks/quickcreate?templateURL=https%3A%2F%2Fb.s3.ap-northeast-2.amazonaws.com%2Fconnections%2Fv1%2Fsource-role.yaml&param_PlatformPrincipalArn=arn%3Aaws%3Aiam%3A%3A111111111111%3Arole%2Fcmp-platform&param_ExternalId=ext-1'

/** 가짜 플랫폼 /connections: 백엔드 routes/connections.py와 같은 경로·응답 형태 */
function fakeConnectionsPlatform() {
  const calls: { method: string; path: string; body: unknown }[] = []
  const rows = new Map<string, Record<string, unknown>>()
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, path: url.pathname + url.search, body })
    if (new Headers(init?.headers).get('x-enrollment-admin-key') !== KEY) return Response.json({ detail: 'nope' }, { status: 403 })
    const path = url.pathname
    if (path === '/connections' && method === 'POST') {
      const row = { connection_id: 'conn-1', kind: body.kind, display_name: body.display_name, region: body.region, status: 'PENDING', external_id: 'ext-1', role_arn: null, account_id: null, last_code: null, last_verified_at: null }
      rows.set('conn-1', row)
      return Response.json({ connection_id: 'conn-1', kind: body.kind, display_name: body.display_name, status: 'PENDING', external_id: 'ext-1', launch_stack_url: LAUNCH }, { status: 201 })
    }
    if (path === '/connections' && method === 'GET') {
      return Response.json({ connections: [...rows.values()].map(r => ({ connection_id: r.connection_id, kind: r.kind, display_name: r.display_name, account_id: r.account_id, region: r.region, status: r.status, last_verified_at: r.last_verified_at })), agents: [] })
    }
    if (path === '/agent-admin/agents') {
      return Response.json({ agents: [{ agent_id: 'laptop', cluster_uid: 'u', last_seen_at: 1, online: true, revoked: false, version: null,
        tunnel: { tunnel_ip: '10.8.0.5', last_handshake_at: 100, app_health_ok: true, db_connect_ok: true, stale: true, fresh_until: null } }] })
    }
    const m = path.match(/^\/connections\/([^/]+)(\/role|\/verify|\/eks-clusters)?$/)
    const row = m && rows.get(decodeURIComponent(m[1]))
    if (!m || !row) return Response.json({ detail: 'CONNECTION_NOT_FOUND' }, { status: 404 })
    if (m[2] === '/role') { row.role_arn = body.role_arn; return Response.json({ ...row, launch_stack_url: LAUNCH }) }
    if (m[2] === '/verify') {
      row.status = 'CONNECTED'; row.account_id = '123456789012'; row.last_code = 'OK'; row.last_verified_at = 200
      return Response.json({ status: 'CONNECTED', code: 'OK', checked_at: 200, account_id: '123456789012', principal: 'p', eks_clusters: ['prod-a'] })
    }
    if (m[2] === '/eks-clusters') return Response.json({ connection_id: row.connection_id, region: row.region, eks_clusters: ['prod-a'] })
    if (method === 'DELETE') { rows.delete(row.connection_id as string); return Response.json({ connection_id: row.connection_id, deleted: true, stack_name: 'cmp-source-conn-1', notice: 'n' }) }
    return Response.json({ ...row, launch_stack_url: LAUNCH })
  }) as typeof fetch
  return { calls, rows, fetchImpl }
}

test('실제 연결: 백엔드 Launch Stack 링크를 그대로 돌려주고, 운영자 키를 응답에 싣지 않는다', async () => {
  const platform = fakeConnectionsPlatform()
  const api = createRealConnections({ base: 'http://platform.test/', enrollmentAdminKey: KEY, fetchImpl: platform.fetchImpl })
  assert.equal(api.mock, false)
  const response = await handleCreateConnection(post({ kind: 'AWS_SOURCE', display_name: 'prod', region: 'ap-northeast-2' }), deps(fakePlatform(), { connections: api }))
  assert.equal(response.status, 201)
  const text = await response.text()
  assert.ok(!text.includes(KEY))
  const created = JSON.parse(text)
  assert.equal(created.launch_stack_url, LAUNCH)
  assert.equal(created.external_id, 'ext-1')
  assert.deepEqual(platform.calls[0], { method: 'POST', path: '/connections', body: { kind: 'AWS_SOURCE', display_name: 'prod', region: 'ap-northeast-2' } })
})

test('실제 연결: 목록은 상세로 역할·External ID를 채우고, 확인한 EKS 목록을 기억해 다시 AWS를 부르지 않는다', async () => {
  const platform = fakeConnectionsPlatform()
  const api = createRealConnections({ base: 'http://platform.test', enrollmentAdminKey: KEY, fetchImpl: platform.fetchImpl })
  await api.createConnection({ kind: 'AWS_SOURCE', display_name: 'prod', region: 'ap-northeast-2' })
  const pending = (await api.listConnections())[0]
  assert.equal(pending.status, 'PENDING')
  assert.equal(pending.external_id, 'ext-1')
  assert.equal(pending.role_arn, undefined)

  const role = await api.setRole('conn-1', 'arn:aws:iam::123456789012:role/cmp-source')
  assert.equal(role.role_arn, 'arn:aws:iam::123456789012:role/cmp-source')
  const verified = await api.verifyConnection('conn-1')
  assert.deepEqual(verified.eks_clusters, ['prod-a'])

  platform.calls.length = 0
  const connected = (await api.listConnections())[0]
  assert.equal(connected.status, 'CONNECTED')
  assert.equal(connected.account_id, '123456789012')
  assert.deepEqual(connected.eks_clusters, ['prod-a'])
  assert.ok(!platform.calls.some(c => c.path.endsWith('/eks-clusters')), '확인 때 받은 EKS 목록을 다시 쓰므로 AWS 조회를 안 한다')

  const deleted = await api.deleteConnection('conn-1')
  assert.equal(deleted.deleted, true)
  assert.deepEqual(await api.listConnections(), [])
})

test('실제 연결: 404·403은 BFF 오류 코드로 바뀌고, 오래된 터널 보고의 앱·DB 결과는 모름이다', async () => {
  const platform = fakeConnectionsPlatform()
  const api = createRealConnections({ base: 'http://platform.test', enrollmentAdminKey: KEY, fetchImpl: platform.fetchImpl })
  await assert.rejects(api.verifyConnection('nope'), (error: PlatformError) => error.status === 404 && error.detail === 'CONNECTION_NOT_FOUND')
  const wrongKey = createRealConnections({ base: 'http://platform.test', enrollmentAdminKey: 'wrong', fetchImpl: platform.fetchImpl })
  await assert.rejects(wrongKey.listConnections(), (error: PlatformError) => error.code === 'operator_key')
  const noKey = createRealConnections({ base: 'http://platform.test', enrollmentAdminKey: '', fetchImpl: platform.fetchImpl })
  await assert.rejects(noKey.listConnections(), (error: PlatformError) => error.code === 'unavailable')
  const tunnel = await api.tunnelStatus('laptop', { agent_id: 'laptop', owner_id: 'platform', cluster_uid: 'u', last_seen_at: 1, revoked: false })
  assert.deepEqual(tunnel, { tunnel_ip: '10.8.0.5', last_handshake_at: 100, app_health_ok: null, db_connect_ok: null })
  assert.equal(await api.tunnelStatus('other', { agent_id: 'other', owner_id: 'platform', cluster_uid: null, last_seen_at: null, revoked: false }), null)
})

// ---- 모드 선택 · 설정 누락 · 플랫폼 Agent 목록 ----

test('모드: 명시값 > 목업 빌드 > 프로덕션 기본 real · 개발 기본 mock', () => {
  assert.equal(platformMode({ connections: '', nodeEnv: 'production', apiMode: 'sse' }), 'real')
  assert.equal(platformMode({ connections: '', nodeEnv: 'production', apiMode: undefined }), 'real')
  assert.equal(platformMode({ connections: '', nodeEnv: 'production', apiMode: 'mock' }), 'mock')
  assert.equal(platformMode({ connections: 'real', nodeEnv: 'production', apiMode: 'mock' }), 'real')
  assert.equal(platformMode({ connections: 'mock', nodeEnv: 'production', apiMode: 'sse' }), 'mock')
  assert.equal(platformMode({ connections: '', nodeEnv: 'development', apiMode: 'sse' }), 'mock')
  assert.equal(platformMode({ connections: ' REAL ', nodeEnv: 'development' }), 'real')
})

test('실제 모드 설정 누락: 목업으로 떨어지지 않고 목록 meta에 503과 원인 코드가 실린다', async () => {
  const noKey = createRealConnections({ base: 'http://platform.test', enrollmentAdminKey: '' })
  const noBase = createRealConnections({ base: '', enrollmentAdminKey: KEY })
  await assert.rejects(noKey.listConnections(), (error: PlatformError) => error.status === 503 && error.detail === 'PLATFORM_ADMIN_KEY_NOT_CONFIGURED')
  await assert.rejects(noBase.listConnections(), (error: PlatformError) => error.status === 503 && error.detail === 'PLATFORM_API_BASE_NOT_CONFIGURED')

  const p = { base: 'http://platform.test', enrollmentAdminKey: '' }
  const agents: AgentsApi = { mock: false, issueEnrollment: input => issueEnrollment(p, input), getAgent: id => getAgent(p, id), revokeAgent: id => revokeAgent(p, id), listAgentIds: () => listAgentIds(p) }
  const response = await handleList(get(), deps(fakePlatform(), { connections: noKey, agents }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.meta.connections, { mock: false, error: 'unavailable', detail: 'PLATFORM_ADMIN_KEY_NOT_CONFIGURED' })
  assert.deepEqual(body.meta.agents, { mock: false, error: 'unavailable', detail: 'PLATFORM_ADMIN_KEY_NOT_CONFIGURED' })
  assert.deepEqual(body.connections, [])
})

test('실제 Agent 목록: 플랫폼에 등록된 Agent와 웹이 기억한 id를 합쳐 보여 준다', async () => {
  const platform = fakePlatform()
  platform.agents.set('laptop', { last_seen_at: 1, revoked: false, registered: true })
  const p = { base: 'http://platform.test', enrollmentAdminKey: KEY, fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname === '/agent-admin/agents') return Response.json({ agents: [{ agent_id: 'laptop' }] })
    return platform.fetchImpl(input, init)
  }) as typeof fetch }
  const agents: AgentsApi = { mock: false, issueEnrollment: input => issueEnrollment(p, input), getAgent: id => getAgent(p, id), revokeAgent: id => revokeAgent(p, id), listAgentIds: () => listAgentIds(p) }
  const d = deps(platform, { agents })
  d.agentIds.add('pending-one')
  const body = await (await handleList(get(), d)).json()
  assert.deepEqual(body.agents.map((a: { agent_id: string }) => a.agent_id).sort(), ['laptop', 'pending-one'])
  assert.equal(body.agents.find((a: { agent_id: string }) => a.agent_id === 'pending-one').enrolled_only, true)
})

test('관리 API 접근: 운영자 키가 있으면 로그인한 허용 계정만 통과한다', () => {
  const real = { mock: false, hasAdminKey: true }
  const allowed = parseAllowedLogins(' Alice, bob ,')
  assert.deepEqual(allowed, ['alice', 'bob'])
  assert.equal(decideAccess({ ...real, login: null, allowed }), 'login_required')
  assert.equal(decideAccess({ ...real, login: 'mallory', allowed }), 'not_allowed')
  assert.equal(decideAccess({ ...real, login: 'ALICE', allowed }), 'allow')
})

test('관리 API 접근: 허용 목록이 비어 있으면 로그인해도 아무도 통과하지 못한다', () => {
  assert.equal(decideAccess({ mock: false, hasAdminKey: true, login: 'alice', allowed: [] }), 'not_allowed')
  // 키가 없어도 목업 모드가 아니면(real) 닫혀 있다
  assert.equal(decideAccess({ mock: false, hasAdminKey: false, login: null, allowed: ['alice'] }), 'login_required')
})

test('관리 API 접근: 목업 모드이고 운영자 키가 없으면 로그인 없이 열린다', () => {
  assert.equal(decideAccess({ mock: true, hasAdminKey: false, login: null, allowed: [] }), 'allow')
  // 목업이어도 키가 있으면 실제 권한이므로 닫는다
  assert.equal(decideAccess({ mock: true, hasAdminKey: true, login: null, allowed: ['alice'] }), 'login_required')
})
