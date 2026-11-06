import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guardedRelay, handleApprovalRelay, type RelayDeps, type RelayTarget } from '../../src/lib/approvals/relay.ts'
import { guard } from '../../src/lib/connections/guard.ts'
import { SseProvider } from '../../src/lib/migration/sseProvider.ts'
import { startRequestFor } from '../../src/lib/migration/events.ts'
import type { Action } from '../../src/lib/migration/reducer.ts'

// 가짜 승인자 토큰. 어떤 응답에도 이 값이 나오면 안 된다.
const TOKEN = 'approver-token-NOT-REAL-4242'
const HEX = 'a'.repeat(64)
const DECISION_BODY = { decision: 'APPROVE', scope: 'FULL', manifest_digest: HEX, preview_digest: HEX }
const APPROVAL = { approval_id: 'apr-1', plan_id: 'plan-1', revision: 2, decision: 'APPROVE', approver_id: 'demo', scope: 'FULL', delivery_status: 'PENDING', delivery_attempts: 1, execution_status: 'NOT_STARTED', workflow_state: 'WAITING_FOR_APPROVAL' }

type Call = { url: string; headers: Headers; body: string | undefined }
function fakePlatform(reply: (call: Call) => Response) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), headers: new Headers(init?.headers), body: init?.body ? String(init.body) : undefined }
    calls.push(call)
    return reply(call)
  }) as typeof fetch
  return { calls, fetchImpl }
}

const post = (body?: unknown) => new Request('http://web.test/api/approvals/plan-1/2', { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
const decision: RelayTarget = { kind: 'decision', planId: 'plan-1', revision: '2' }
const delivery: RelayTarget = { kind: 'delivery', planId: 'plan-1', revision: '2', approvalId: 'apr-1' }
const deps = (fetchImpl: typeof fetch, extra: Partial<RelayDeps> = {}): RelayDeps => ({ base: 'http://platform.test/', approverToken: TOKEN, fetchImpl, ...extra })
const noLeak = async (response: Response) => {
  const text = await response.clone().text()
  assert.ok(!text.includes(TOKEN), '응답에 토큰이 없다: ' + text)
  for (const [, value] of response.headers) assert.ok(!value.includes(TOKEN))
  return JSON.parse(text)
}

test('승인 중계: 결정을 Bearer 승인자 토큰과 함께 플랫폼 승인 경로로 보내고 응답 본문을 그대로 돌려준다', async () => {
  const platform = fakePlatform(() => Response.json(APPROVAL, { status: 201 }))
  const response = await handleApprovalRelay(post({ ...DECISION_BODY, extra: 'dropped' }), deps(platform.fetchImpl), decision)
  assert.equal(response.status, 201)
  assert.deepEqual(await noLeak(response), APPROVAL)
  assert.equal(platform.calls.length, 1)
  assert.equal(platform.calls[0].url, 'http://platform.test/provisioning/plans/plan-1/revisions/2/approvals')
  assert.equal(platform.calls[0].headers.get('authorization'), 'Bearer ' + TOKEN)
  // 플랫폼이 읽는 값만 넘긴다
  assert.deepEqual(JSON.parse(platform.calls[0].body ?? ''), DECISION_BODY)
})

test('승인 중계: 다시 전달은 …/approvals/{approval_id}/delivery로 본문 없이 보낸다', async () => {
  const platform = fakePlatform(() => Response.json({ ...APPROVAL, delivery_status: 'DELIVERED' }))
  const response = await handleApprovalRelay(new Request('http://web.test/x', { method: 'POST' }), deps(platform.fetchImpl), delivery)
  assert.equal(response.status, 200)
  assert.equal((await noLeak(response)).delivery_status, 'DELIVERED')
  assert.equal(platform.calls[0].url, 'http://platform.test/provisioning/plans/plan-1/revisions/2/approvals/apr-1/delivery')
  assert.equal(platform.calls[0].headers.get('authorization'), 'Bearer ' + TOKEN)
  assert.equal(platform.calls[0].body, undefined)
})

test('승인 중계: 토큰·주소 설정이 없으면 플랫폼을 부르지 않고 503과 설정 누락 코드', async () => {
  const platform = fakePlatform(() => Response.json(APPROVAL))
  const noToken = await handleApprovalRelay(post(DECISION_BODY), deps(platform.fetchImpl, { approverToken: '' }), decision)
  assert.equal(noToken.status, 503)
  assert.deepEqual(await noToken.json(), { error: 'unavailable', detail: 'APPROVER_TOKEN_NOT_CONFIGURED' })
  const noBase = await handleApprovalRelay(post(DECISION_BODY), deps(platform.fetchImpl, { base: '' }), decision)
  assert.equal(noBase.status, 503)
  assert.equal((await noBase.json()).detail, 'PLATFORM_API_BASE_NOT_CONFIGURED')
  assert.equal(platform.calls.length, 0)
})

test('승인 중계: 플랫폼 오류는 코드만 넘긴다(401→502 approver_auth, 409·503 그대로, 연결 실패 503)', async () => {
  const cases: Array<[Response | null, number, object]> = [
    [Response.json({ detail: 'APPROVER_AUTH_REQUIRED' }, { status: 401 }), 502, { error: 'approver_auth', detail: 'APPROVER_AUTH_REQUIRED' }],
    // 자유 문장(토큰이 섞인)은 버리고 기본 코드만
    [Response.json({ detail: 'bad token ' + TOKEN }, { status: 403 }), 502, { error: 'approver_auth', detail: 'APPROVER_AUTH_REQUIRED' }],
    [Response.json({ detail: { code: 'STALE_REVISION' } }, { status: 409 }), 409, { error: 'conflict', detail: 'STALE_REVISION' }],
    [Response.json({ error: 'PLAN_NOT_FOUND' }, { status: 404 }), 404, { error: 'not_found', detail: 'PLAN_NOT_FOUND' }],
    [Response.json({ detail: 'VALIDATION_ERROR' }, { status: 422 }), 400, { error: 'bad_request', detail: 'VALIDATION_ERROR' }],
    [Response.json({ detail: 'WORKFLOW_UNAVAILABLE' }, { status: 503 }), 503, { error: 'unavailable', detail: 'WORKFLOW_UNAVAILABLE' }],
    [new Response('boom ' + TOKEN, { status: 500 }), 502, { error: 'platform_error' }],
    [null, 503, { error: 'unavailable', detail: 'UNREACHABLE' }],
  ]
  for (const [reply, status, body] of cases) {
    const fetchImpl = (async () => { if (!reply) throw new Error('connect ECONNREFUSED ' + TOKEN); return reply }) as unknown as typeof fetch
    const response = await handleApprovalRelay(post(DECISION_BODY), deps(fetchImpl), decision)
    assert.equal(response.status, status)
    assert.deepEqual(await noLeak(response), body)
  }
})

test('승인 중계: 맞지 않는 대상·본문은 플랫폼에 보내지 않는다', async () => {
  const platform = fakePlatform(() => Response.json(APPROVAL))
  for (const target of [{ ...decision, planId: '../agent-admin' }, { ...decision, revision: '1/../x' }, { ...delivery, approvalId: 'a/b' }] as RelayTarget[]) {
    const response = await handleApprovalRelay(post(DECISION_BODY), deps(platform.fetchImpl), target)
    assert.equal(response.status, 400)
  }
  for (const body of [{ ...DECISION_BODY, decision: 'MAYBE' }, { ...DECISION_BODY, scope: 'ALL' }, { ...DECISION_BODY, manifest_digest: '' }, 'nope']) {
    const response = await handleApprovalRelay(post(body), deps(platform.fetchImpl), decision)
    assert.equal(response.status, 400)
    assert.equal((await response.json()).detail, 'INVALID_DECISION')
  }
  assert.equal(platform.calls.length, 0)
})

test('승인 중계 입구: 입구 검사가 막으면 플랫폼을 부르지 않는다', async () => {
  const platform = fakePlatform(() => Response.json(APPROVAL))
  const blocked = Response.json({ error: 'operator_key', detail: 'LOGIN_REQUIRED' }, { status: 401 })
  const response = await guardedRelay(post(DECISION_BODY), decision, { guard: async () => blocked, deps: () => deps(platform.fetchImpl) })
  assert.equal(response.status, 401)
  assert.equal(platform.calls.length, 0)
  const passed = await guardedRelay(post(DECISION_BODY), decision, { guard: async () => null, deps: () => deps(platform.fetchImpl) })
  assert.equal(passed.status, 200)
  assert.equal(platform.calls.length, 1)
})

test('승인 중계 입구(guard): 다른 출처는 막고, 승인자 토큰이 있으면 목업 모드여도 로그인을 요구한다', async () => {
  const saved = { connections: process.env.PLATFORM_CONNECTIONS, key: process.env.PLATFORM_ENROLLMENT_ADMIN_KEY, secret: process.env.AUTH_SECRET }
  process.env.PLATFORM_CONNECTIONS = 'mock'
  delete process.env.PLATFORM_ENROLLMENT_ADMIN_KEY
  delete process.env.AUTH_SECRET
  try {
    const cross = new Request('http://web.test/api/approvals/plan-1/2', { method: 'POST', headers: { origin: 'https://evil.test', host: 'web.test' } })
    assert.equal((await guard(cross, { secretConfigured: true }))?.status, 400)
    const same = () => new Request('http://web.test/api/approvals/plan-1/2', { method: 'POST', headers: { origin: 'http://web.test', host: 'web.test' } })
    const needsLogin = await guard(same(), { secretConfigured: true })
    assert.equal(needsLogin?.status, 401)
    assert.equal((await needsLogin?.json()).detail, 'LOGIN_REQUIRED')
    // 비밀이 없는 목업 모드는 예전처럼 연다(연결 관리와 같다)
    assert.equal(await guard(same()), null)
  } finally {
    for (const [name, value] of [['PLATFORM_CONNECTIONS', saved.connections], ['PLATFORM_ENROLLMENT_ADMIN_KEY', saved.key], ['AUTH_SECRET', saved.secret]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('SSE 공급자: approvalBase가 있으면 승인·다시 전달을 웹 서버 중계로 보내고, 오류 코드를 화면에 넘긴다', async () => {
  const original = globalThis.fetch
  const posts: Array<{ url: string; headers: Headers; body: unknown }> = []
  let relayReply: () => Response = () => Response.json({ ...APPROVAL, delivery_status: 'FAILED' }, { status: 201 })
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/events')) return new Response(null, { status: 404 })
    posts.push({ url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url.startsWith('/api/approvals')) return relayReply()
    return Response.json({ id: 'm-1' })
  }) as typeof fetch
  const actions: Action[] = []
  const provider = new SseProvider({ dispatch: action => actions.push(action) }, { baseUrl: 'http://backend.test', startMode: 'legacy', approvalBase: '/api/approvals/', getHeaders: () => ({ 'X-Platform': 'only-for-platform' }) })
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  try {
    provider.start(startRequestFor('gcp'))
    await settle(); await settle()
    const plan = { plan_id: 'plan-1', revision: 2, manifest_digest: HEX, preview_digest: HEX }
    ;(provider as unknown as { handleBlock(block: string): void }).handleBlock('id: 1\ndata: ' + JSON.stringify({ type: 'plan.ready', phase: 'planning', status: 'done', seq: 1, data: plan }))
    provider.approve(2)
    await settle(); await settle()
    const first = posts.find(item => item.url === '/api/approvals/plan-1/2')
    assert.ok(first, '중계로 보냈다: ' + posts.map(item => item.url).join(', '))
    assert.deepEqual(first.body, DECISION_BODY)
    assert.equal(first.headers.get('authorization'), null)
    assert.equal(first.headers.get('x-platform'), null, '플랫폼용 헤더는 중계에 붙이지 않는다')
    assert.ok(!posts.some(item => item.url.includes('/provisioning/')), '브라우저가 플랫폼 승인 경로를 직접 부르지 않는다')
    // 전달 실패 → 같은 승인을 다시 전달(중계 경로), 웹 서버가 토큰 누락으로 503
    relayReply = () => Response.json({ error: 'unavailable', detail: 'APPROVER_TOKEN_NOT_CONFIGURED' }, { status: 503 })
    provider.approve(2)
    await settle(); await settle()
    assert.ok(posts.some(item => item.url === '/api/approvals/plan-1/2/apr-1/delivery'))
    const failed = actions.flatMap(action => action.type === 'fail' && action.error.code === 'request_failed' ? [action.error] : [])
    assert.equal(failed.at(-1)?.detail, 'APPROVER_TOKEN_NOT_CONFIGURED')
    // 옛 경로·DB 전환 승인은 그대로
    provider.approveCutover()
    await settle()
    assert.ok(posts.some(item => item.url === 'http://backend.test/migrations/m-1/approve?gate=cutover'))
  } finally {
    provider.dispose()
    globalThis.fetch = original
  }
})
