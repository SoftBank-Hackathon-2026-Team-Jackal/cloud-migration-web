/**
 * 실제 모드(SSE) 데모를 멈추게 하던 네 가지:
 * ① 검토 상태를 읽기 전에 분석이 '끝남'으로 보여 게이트를 건너뛰던 것 · 검토 패널이 분석 화면에서만 보이던 것
 * ② 승인·거절에 scope를 FULL로 고정해 보내 409(APPROVAL_TARGET_MISMATCH)가 나던 것
 * ③ 조용히 멈춘 스트림을 알아채지 못하던 것(감시견)
 * ④ 새로 고침하면 돌고 있는 이전을 잃던 것(?migration=<id> · sessionStorage)
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reducer, type Action } from '../../src/lib/migration/reducer.ts'
import { SseProvider, STALL_MS, approvalScope } from '../../src/lib/migration/sseProvider.ts'
import { startRequestFor, type PlanReadyData } from '../../src/lib/migration/events.ts'
import { analysisFinished, reviewSettled, showReviewPanel, type ReviewView } from '../../src/lib/migration/review.ts'
import { clearMigration, readMigration, saveMigration, stageForPhase, SESSION_KEY, type SessionEnv } from '../../src/lib/migration/session.ts'

// ---- ① 검토 게이트 시점 ----

const view = (phase: string, pending: ReviewView['pending'] = null): ReviewView =>
  ({ phase, analysis_ref: { id: 'a', version: '1' }, pending, items: [], security: [], blocked: [] })

test('① 실제 모드: analysis.done이면 막힘이 아닌 한 다음으로 간다', () => {
  const base = { mode: 'sse' as const, done: true, streamsFull: true, pastAnalysis: false }
  // 새 흐름: analysis.done이면 바로 샌드박스로 간다(게이트는 그 화면 위에 뜬다). 막혔을 때만 가지 않는다.
  assert.equal(analysisFinished({ ...base, view: null, known: false }), true, '아직 읽지 않았어도 간다')
  assert.equal(analysisFinished({ ...base, view: view('ANALYZING'), known: true }), true, '매핑 중이어도 간다')
  assert.equal(analysisFinished({ ...base, view: view('WAITING_CONFIRMATION', 'confirm_requirements'), known: true }), true, '게이트는 다음 화면 위에서 처리')
  assert.equal(analysisFinished({ ...base, view: view('BLOCKED'), known: true }), false, '막혔다')
  assert.equal(analysisFinished({ ...base, done: false, streamsFull: false, view: null, known: true }), false)
})

test('① 목업은 예전 그대로: 검토를 읽지 않아도 분석이 끝나면 끝난 것이다', () => {
  assert.equal(analysisFinished({ mode: 'mock', done: true, streamsFull: false, view: null, known: false, pastAnalysis: false }), true)
  assert.equal(analysisFinished({ mode: 'mock', done: false, streamsFull: true, view: null, known: false, pastAnalysis: false }), true)
  assert.equal(analysisFinished({ mode: 'mock', done: false, streamsFull: false, view: null, known: false, pastAnalysis: false }), false)
})

test('① 검토 패널은 기다리거나 막히면 분석 화면 밖(샌드박스·계획 등)에서도 뜬다', () => {
  const waiting = view('WAITING_APPROVAL', 'approve_losses')
  for (const stage of ['analysis', 'rehearsal', 'planning', 'setup']) assert.equal(showReviewPanel({ mode: 'sse', stage, view: waiting }), true, stage)
  assert.equal(showReviewPanel({ mode: 'sse', stage: 'rehearsal', view: view('BLOCKED') }), true)
  assert.equal(showReviewPanel({ mode: 'sse', stage: 'intro', view: waiting }), false, '첫 화면은 가리지 않는다')
  assert.equal(showReviewPanel({ mode: 'mock', stage: 'rehearsal', view: waiting }), false)
  assert.equal(showReviewPanel({ mode: 'sse', stage: 'rehearsal', view: view('APPROVED') }), false)
  assert.equal(reviewSettled({ view: waiting, known: true, pastAnalysis: true }), false, '기다리는 동안은 다음 단계 이벤트가 있어도 끝나지 않았다')
})

// ---- 공급자 시험 도구: 스트림을 직접 흘린다 ----

type Call = { method: string; url: string; headers: Headers; body: unknown }
function harness(options: { events?: 'stream' | 404; approvalBase?: string; stallMs?: number } = {}) {
  const original = globalThis.fetch
  const calls: Call[] = []
  const streams: Array<ReadableStreamDefaultController<Uint8Array>> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url.endsWith('/events')) {
      if (options.events === 404) return new Response(null, { status: 404 })
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller) } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (method === 'POST' && url.endsWith('/migrations')) return Response.json({ workflow_id: 'm-1' }, { status: 202 })
    return Response.json({ approval_id: 'apr-1', plan_id: 'p', revision: 1, decision: 'APPROVE', scope: 'FULL', delivery_status: 'PENDING', delivery_attempts: 1 }, { status: 201 })
  }) as typeof fetch
  const actions: Action[] = []
  let state = initialState
  const provider = new SseProvider({ dispatch: action => { actions.push(action); state = reducer(state, action) } }, {
    baseUrl: 'http://backend.test', startMode: 'legacy',
    ...(options.approvalBase ? { approvalBase: options.approvalBase } : {}),
    ...(options.stallMs ? { stallMs: options.stallMs } : {}),
  })
  const encoder = new TextEncoder()
  const push = (text: string) => streams.at(-1)?.enqueue(encoder.encode(text))
  const events = () => calls.filter(call => call.url.endsWith('/events'))
  return { provider, calls, actions, events, push, state: () => state, restore: () => { provider.dispose(); globalThis.fetch = original } }
}
/** setImmediate는 가짜 시계가 건드리지 않는다: 약속(fetch·read)이 풀리게 몇 번 돌린다. */
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)) }
const block = (seq: number, type: string, phase: string, data: object, status = 'done') =>
  'id: ' + seq + '\ndata: ' + JSON.stringify({ seq, at: '2026-11-07T00:00:00Z', phase, type, status, data }) + '\n\n'
const HEX = 'a'.repeat(64)
const plan = (revision: number, scope?: string): PlanReadyData => ({ plan_id: 'plan-1', revision, manifest_digest: HEX, preview_digest: HEX, ...(scope ? { scope: scope as PlanReadyData['scope'] } : {}) })

// ---- ② 승인 scope ----

test('② approvalScope: plan.ready의 scope, 없거나 모르는 값이면 FULL', () => {
  assert.equal(approvalScope(plan(1, 'WORKLOADS')), 'WORKLOADS')
  assert.equal(approvalScope(plan(1, 'INFRASTRUCTURE')), 'INFRASTRUCTURE')
  assert.equal(approvalScope(plan(1)), 'FULL')
  assert.equal(approvalScope({ ...plan(1), scope: 'ALL' as never }), 'FULL')
  assert.equal(approvalScope(null), 'FULL')
})

test('② 승인·거절 본문의 scope는 plan.ready.scope이고, 새 Revision이 오면 그 값으로 바뀐다', async () => {
  const h = harness({ approvalBase: '/api/approvals' })
  try {
    h.provider.start(startRequestFor('onprem'))
    await flush()
    h.push(block(1, 'plan.ready', 'planning', plan(1, 'WORKLOADS')))
    await flush()
    h.provider.revisePlan()
    await flush()
    // 거절 뒤 revision + 1이 다시 온다(scope도 그 Revision 값).
    h.push(block(2, 'plan.ready', 'planning', plan(2, 'INFRASTRUCTURE')))
    await flush()
    h.provider.approve(2)
    await flush()
    const relay = h.calls.filter(call => call.url.startsWith('/api/approvals/'))
    assert.deepEqual(relay.map(call => [call.url, (call.body as { decision: string; scope: string }).decision, (call.body as { scope: string }).scope]), [
      ['/api/approvals/plan-1/1', 'REJECT', 'WORKLOADS'],
      ['/api/approvals/plan-1/2', 'APPROVE', 'INFRASTRUCTURE'],
    ])
  } finally { h.restore() }
})

test('② plan.ready에 scope가 없으면(옛 이벤트) FULL로 보낸다 · snapshot 안의 plan.ready도 쓴다', async () => {
  const h = harness({ approvalBase: '/api/approvals' })
  try {
    h.provider.start(startRequestFor('gcp'))
    await flush()
    const inner = { seq: 1, at: '2026-11-07T00:00:00Z', phase: 'planning', type: 'plan.ready', status: 'done', data: plan(3) }
    h.push('id: 1\ndata: ' + JSON.stringify({ seq: 1, at: inner.at, phase: 'planning', type: 'snapshot', status: 'running', data: { migration_id: 'm-1', status: 'waiting', reset: true, events: [inner] } }) + '\n\n')
    await flush()
    h.provider.approve(3)
    await flush()
    const sent = h.calls.find(call => call.url === '/api/approvals/plan-1/3')
    assert.equal((sent?.body as { scope?: string } | undefined)?.scope, 'FULL')
  } finally { h.restore() }
})

// ---- ③ 스트림 감시견(가짜 시계) ----

test('③ 아무것도 오지 않은 채 STALL_MS가 지나면 끊고 Last-Event-ID로 다시 연결한다', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()
  try {
    h.provider.start(startRequestFor('gcp'))
    await flush()
    h.push(block(7, 'analysis.done', 'analysis', {}))
    await flush()
    assert.equal(h.events().length, 1)
    mock.timers.tick(STALL_MS - 1000)
    await flush()
    assert.equal(h.events().length, 1, '아직 기다린다')
    mock.timers.tick(1001)
    await flush()
    assert.ok(h.actions.some(action => action.type === 'connection' && action.value === 'reconnecting'), '다시 연결 중으로 보인다')
    mock.timers.tick(500) // 재연결 대기(RETRY_FIRST_MS)
    await flush()
    assert.equal(h.events().length, 2, '다시 연결했다')
    assert.equal(h.events()[1].headers.get('Last-Event-ID'), '7')
  } finally { h.restore(); mock.timers.reset() }
})

test('③ : heartbeat 주석이 15초마다 오면 끊지 않는다', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const h = harness()
  try {
    h.provider.start(startRequestFor('gcp'))
    await flush()
    for (let i = 0; i < 8; i++) {
      mock.timers.tick(15_000)
      h.push(': heartbeat\n\n')
      await flush()
    }
    assert.equal(h.events().length, 1)
    assert.ok(!h.actions.some(action => action.type === 'connection' && action.value === 'reconnecting'))
  } finally { h.restore(); mock.timers.reset() }
})

test('③ 응답 헤더조차 오지 않아도(fetch가 멈춤) 감시견이 다시 연결한다', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') return Promise.resolve(Response.json({ workflow_id: 'm-1' }))
    if (url.endsWith('/events')) {
      calls++
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    return Promise.resolve(new Response(null, { status: 404 }))
  }) as typeof fetch
  const provider = new SseProvider({ dispatch: () => {} }, { baseUrl: 'http://backend.test', startMode: 'legacy' })
  try {
    provider.start(startRequestFor('gcp'))
    await flush()
    assert.equal(calls, 1)
    mock.timers.tick(STALL_MS)
    await flush()
    mock.timers.tick(500)
    await flush()
    assert.equal(calls, 2)
  } finally { provider.dispose(); globalThis.fetch = original; mock.timers.reset() }
})

// ---- ④ 다시 붙기 ----

function fakeEnv(href: string, stored: Record<string, string> = {}): SessionEnv & { data: Record<string, string> } {
  const data = { ...stored }
  const env = {
    data,
    location: { href },
    history: {
      state: { guard: true } as unknown,
      replaceState(state: unknown, _unused: string, url?: string | URL | null) { env.history.state = state; if (url) env.location.href = String(url) },
    },
    storage: {
      getItem: (key: string) => data[key] ?? null,
      setItem: (key: string, value: string) => { data[key] = value },
      removeItem: (key: string) => { delete data[key] },
    },
  }
  return env
}

test('④ 시작한 이전의 ID를 주소(?migration=)와 sessionStorage에 남기고, 다시 읽는다', () => {
  const env = fakeEnv('https://demo.test/?demo=1&stage=traffic')
  saveMigration(env, { id: 'mig-42', target: 'onprem' })
  const url = new URL(env.location.href)
  assert.equal(url.searchParams.get('migration'), 'mig-42')
  assert.equal(url.searchParams.get('demo'), '1', '다른 쿼리는 그대로')
  assert.equal(url.searchParams.get('stage'), null, '단계 바로 열기는 지운다')
  assert.deepEqual(env.history.state, { guard: true }, '뒤로가기 가드 상태를 지킨다')
  assert.deepEqual(JSON.parse(env.data[SESSION_KEY]), { id: 'mig-42', target: 'onprem' })
  assert.deepEqual(readMigration(env), { id: 'mig-42', target: 'onprem' })
  // 새 탭: 주소만 있다
  assert.deepEqual(readMigration(fakeEnv('https://demo.test/?migration=mig-7')), { id: 'mig-7', target: null })
  // 새로 고침인데 주소가 지워졌다: 이 탭의 저장 값
  assert.deepEqual(readMigration(fakeEnv('https://demo.test/', { [SESSION_KEY]: JSON.stringify({ id: 'mig-9', target: 'gcp' }) })), { id: 'mig-9', target: 'gcp' })
  // 이상한 값은 쓰지 않는다
  assert.equal(readMigration(fakeEnv('https://demo.test/?migration=' + encodeURIComponent('<script>'))), null)
  assert.equal(readMigration(fakeEnv('https://demo.test/')), null)
})

test('④ 404면 주소와 저장소에서 지운다', () => {
  const env = fakeEnv('https://demo.test/?migration=gone&target=gcp', { [SESSION_KEY]: JSON.stringify({ id: 'gone', target: 'gcp' }) })
  clearMigration(env)
  assert.equal(new URL(env.location.href).searchParams.get('migration'), null)
  assert.equal(new URL(env.location.href).searchParams.get('target'), 'gcp')
  assert.equal(env.data[SESSION_KEY], undefined)
  assert.equal(readMigration(env), null)
})

test('④ attach: 처음부터(Last-Event-ID 없이) 연결해 snapshot으로 상태를 다시 쌓고, 마지막 phase의 화면을 고른다', async () => {
  const h = harness()
  try {
    h.provider.attach('m-1')
    await flush()
    assert.equal(h.events().length, 1)
    assert.equal(h.events()[0].url, 'http://backend.test/migrations/m-1/events')
    assert.equal(h.events()[0].headers.get('Last-Event-ID'), null)
    const at = '2026-11-07T00:00:00Z'
    const items = [
      { seq: 1, at, phase: 'analysis', type: 'analysis.done', status: 'done', data: {} },
      { seq: 2, at, phase: 'build', type: 'sandbox.env', status: 'running', data: { namespace: 'ns', cluster: 'c' } },
      { seq: 3, at, phase: 'planning', type: 'plan.ready', status: 'done', data: plan(1, 'FULL') },
    ]
    h.push('id: 3\ndata: ' + JSON.stringify({ seq: 3, at, phase: 'planning', type: 'snapshot', status: 'running', data: { migration_id: 'm-1', status: 'running', reset: true, events: items } }) + '\n\n')
    await flush()
    const state = h.state()
    assert.equal(state.migrationId, 'm-1')
    assert.equal(state.analysis.done, true)
    assert.equal(state.lastPhase, 'planning')
    assert.equal(stageForPhase(state.lastPhase), 'planning')
  } finally { h.restore() }
})

test('④ attach: 서버가 모르는 이전(404)이면 migration_not_found를 알린다(화면이 저장한 ID를 지운다)', async () => {
  const h = harness({ events: 404 })
  try {
    h.provider.attach('gone')
    await flush()
    assert.ok(h.actions.some(action => action.type === 'fail' && action.error.code === 'migration_not_found'))
    assert.equal(h.events().length, 1, '다시 연결하지 않는다')
  } finally { h.restore() }
})

test('④ phase → 화면 대응', () => {
  assert.equal(stageForPhase(null), 'analysis')
  assert.equal(stageForPhase('analysis'), 'analysis')
  assert.equal(stageForPhase('build'), 'rehearsal')
  assert.equal(stageForPhase('awaiting_approval'), 'approval')
  assert.equal(stageForPhase('provisioning'), 'provisioning')
  assert.equal(stageForPhase('data_copy'), 'data')
  assert.equal(stageForPhase('verification'), 'cutover')
})
