/**
 * 실제(SSE) 모드 온프레미스 데이터 이전: 데이터 복제 → DB 전환(2차 승인) → 트래픽 전환 → 완료 리포트가 멈추지 않는지.
 * 플랫폼 순서: apps/worker/src/cmp_worker/workflows/migration.py(data_copy → traffic → verification),
 * DB 전환은 data_copy 안의 DataMigrationWorkflow가 낸다(cutover.* 이벤트의 phase는 verification).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reducer, type Action, type MigrationState } from '../../src/lib/migration/reducer.ts'
import { SseProvider } from '../../src/lib/migration/sseProvider.ts'
import { cutoverAfter, cutoverEntry, cutoverRunView, dataNextStage, reportPauseMs } from '../../src/lib/migration/flow.ts'
import { startRequestFor, type CutoverOutcomeData, type DraftEvent, type MigrationEvent } from '../../src/lib/migration/events.ts'

let seq = 0
function ev(draft: DraftEvent): MigrationEvent {
  seq += 1
  return { ...draft, seq, at: '2026-11-07T00:00:00.000Z' } as MigrationEvent
}
const run = (state: MigrationState, ...drafts: DraftEvent[]) =>
  drafts.reduce((current, draft) => reducer(current, { type: 'event', event: ev(draft) }), state)
const running = (): MigrationState => ({ ...initialState, migrationId: 'm-1', status: 'running' })

const SWITCHED: CutoverOutcomeData = { result: 'switched', active: 'target', pause_ms: 7.4, steps: [], replication: { direction: 'reverse', lag_ms: null } }
const PLAN = {
  method: 'fast', expected_pause_ms: { min: 4, max: 110 }, preconditions: [], steps: [],
  rehearsal: { source: 'lab', runs: 3, methods: [{ method: 'fast', pause_ms: 110 }] },
  rollback: { standby_hours: 24 }, handover: [],
  topology: { app: 'chat', pooler: 'PgBouncer', source_db: 'src', target_db: 'tgt', source_where: 'EKS', target_where: 'k3d', writes_per_sec: 0 },
}

// ---- 1. 2차 승인 실패는 이전 전체 실패가 아니다 ----

function harness(respond: (url: string, init?: RequestInit) => Response) {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/events')) return new Response(null, { status: 404 })
    calls.push((init?.method ?? 'GET') + ' ' + url)
    if (url.endsWith('/migrations') && init?.method === 'POST') return Response.json({ workflow_id: 'm-1' })
    return respond(url, init)
  }) as typeof fetch
  const actions: Action[] = []
  const provider = new SseProvider({ dispatch: action => actions.push(action) }, { baseUrl: 'http://backend.test', startMode: 'legacy', capabilities: new Set(['report']) })
  return { provider, calls, actions, restore: () => { provider.dispose(); globalThis.fetch = original } }
}
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const replay = (actions: Action[], state: MigrationState = running()) => actions.reduce(reducer, state)

for (const [status, body, code] of [
  [409, { detail: { code: 'CUTOVER_NOT_READY', phase: 'data_copy' } }, 'CUTOVER_NOT_READY'],
  [404, { detail: 'Data migration not found or unavailable' }, 'HTTP_404'],
  [503, { detail: 'Data migration unavailable' }, 'HTTP_503'],
] as const) {
  test(`2차 승인 ${status}: 이전은 failed가 되지 않고 전환 화면 오류(${code})로만 남는다`, async () => {
    const { provider, calls, actions, restore } = harness(() => Response.json(body, { status }))
    try {
      provider.start(startRequestFor('onprem'))
      await settle()
      actions.length = 0
      provider.approveCutover()
      await settle()
      assert.ok(calls.includes('POST http://backend.test/migrations/m-1/approve?gate=cutover'))
      assert.ok(!actions.some(action => action.type === 'fail'), 'fail 액션을 보내지 않는다')
      const state = replay(actions)
      assert.equal(state.status, 'running')
      assert.deepEqual(state.failures, {})
      assert.equal(state.requestErrors.cutover?.detail, code)
    } finally { restore() }
  })
}

test('2차 승인: 다시 승인하면 지난 오류를 지우고, 성공하면 오류가 없다', async () => {
  let ok = false
  const { provider, actions, restore } = harness(() => ok ? Response.json({ status: 'accepted' }) : Response.json({ detail: { code: 'CUTOVER_NOT_READY' } }, { status: 409 }))
  try {
    provider.start(startRequestFor('onprem'))
    await settle()
    actions.length = 0
    provider.approveCutover()
    await settle()
    assert.ok(replay(actions).requestErrors.cutover)
    ok = true
    provider.approveCutover()
    await settle()
    assert.equal(replay(actions).requestErrors.cutover, undefined)
  } finally { restore() }
})

test('다른 POST 실패는 호출한 단계의 실패로 기록한다(analysis로 떨어지지 않는다)', async () => {
  const { provider, actions, restore } = harness(() => new Response('boom', { status: 500 }))
  try {
    provider.start(startRequestFor('onprem'))
    await settle()
    actions.length = 0
    provider.approve()
    await settle()
    const failure = actions.find(action => action.type === 'fail')
    assert.ok(failure && failure.type === 'fail')
    assert.equal(failure.error.phase, 'awaiting_approval')
    assert.equal(replay(actions).failures.analysis, undefined)
  } finally { restore() }
})

test('리포트 읽기 실패는 이전을 실패로 바꾸지 않는다(완료 화면이 멈추지 않는다)', async () => {
  const { provider, actions, restore } = harness(() => new Response('nope', { status: 500 }))
  try {
    provider.start(startRequestFor('onprem'))
    await settle()
    actions.length = 0
    provider.loadReport()
    await settle()
    const state = replay(actions, { ...running(), status: 'done' })
    assert.equal(state.status, 'done')
    assert.ok(state.requestErrors.report)
  } finally { restore() }
})

// ---- 2. 단계 순서: 데이터 → DB 전환 → 트래픽 → 완료 ----

test('순서: 데이터 단계 중 2차 승인 요청(gate=cutover)이 오면 데이터 "다음"은 전환 화면으로 간다', () => {
  seq = 0
  let state = running()
  assert.equal(dataNextStage(state), 'traffic', '목업·옛 순서: 승인 요청이 없으면 트래픽')
  state = run(state,
    { type: 'cutover.plan', phase: 'verification', status: 'waiting', data: PLAN } as DraftEvent,
    { type: 'approval.required', phase: 'verification', status: 'waiting', data: { excluded: [], rollback_policy: 'reverse_replication', gate: 'cutover' } } as DraftEvent)
  assert.equal(state.approval.cutoverRequired, true)
  assert.equal(dataNextStage(state), 'cutover')
})

test('순서: 전환이 통과했고 트래픽이 아직이면 전환 화면 "다음"은 트래픽, 트래픽 뒤에는 완료 리포트', () => {
  seq = 0
  let state = run(running(),
    { type: 'cutover.plan', phase: 'verification', status: 'waiting', data: PLAN } as DraftEvent,
    { type: 'cutover.step', phase: 'verification', status: 'running', data: { n: 1, state: 'done', id: 'pause', method: 'fast', of: 1, result: 'ok', window: 'pause' } } as DraftEvent,
    { type: 'cutover.outcome', phase: 'verification', status: 'running', data: SWITCHED } as DraftEvent)
  assert.equal(cutoverAfter(state), 'traffic')
  assert.equal(cutoverEntry(state), 'approve')
  assert.equal(dataNextStage(state), 'traffic', '이미 전환했으면 데이터 다음은 트래픽')
  state = run(state, { type: 'traffic.snapshot', phase: 'traffic', status: 'running', data: { stage: 'complete', weight: 100, steps: [], notes: [], results: [] } } as unknown as DraftEvent)
  assert.equal(cutoverEntry(state), 'report')
  assert.equal(cutoverAfter(state), 'report')
})

test('순서(목업): 트래픽 뒤에 전환하면 전환 "다음"은 완료 리포트', () => {
  seq = 0
  const state = run(running(),
    { type: 'traffic.snapshot', phase: 'traffic', status: 'running', data: { stage: 'drained', weight: 100, steps: [], notes: [], results: [] } } as unknown as DraftEvent,
    { type: 'cutover.outcome', phase: 'verification', status: 'running', data: SWITCHED } as DraftEvent)
  assert.equal(cutoverAfter(state), 'report')
})

// ---- 3. handover가 비면 완료 ----

test('전환 화면: 통과·검증 일치이고 인계 항목이 없으면(플랫폼 계획 handover=[]) 완료로 본다', () => {
  seq = 0
  const state = run(running(),
    { type: 'cutover.plan', phase: 'verification', status: 'waiting', data: PLAN } as DraftEvent,
    { type: 'cutover.step', phase: 'verification', status: 'running', data: { n: 1, state: 'done', id: 'pause', method: 'fast', of: 1, result: 'ok', window: 'pause' } } as DraftEvent,
    { type: 'cutover.outcome', phase: 'verification', status: 'running', data: SWITCHED } as DraftEvent,
    { type: 'cutover.step', phase: 'verification', status: 'running', data: { n: 1, state: 'verify', of: 1 } } as DraftEvent,
    { type: 'cutover.verify', phase: 'verification', status: 'running', data: { table: 'public.messages', source_rows: 10, target_rows: 10, checksum: 'match' } } as DraftEvent)
  assert.equal(cutoverRunView(state.cutover, false), 'done')
  assert.equal(cutoverRunView(state.cutover, true), 'pause', '재생 중에는 아직')
})

test('전환 화면: 계획에 인계 항목이 있으면(목업) 인계가 끝날 때까지 검증 중', () => {
  seq = 0
  const state = run(running(),
    { type: 'cutover.plan', phase: 'verification', status: 'waiting', data: { ...PLAN, handover: [{ item: 'dns' }] } } as DraftEvent,
    { type: 'cutover.step', phase: 'verification', status: 'running', data: { n: 1, state: 'done', id: 'pause', method: 'fast', of: 1, result: 'ok', window: 'pause' } } as DraftEvent,
    { type: 'cutover.outcome', phase: 'verification', status: 'running', data: SWITCHED } as DraftEvent,
    { type: 'cutover.verify', phase: 'verification', status: 'running', data: { table: 'public.messages', source_rows: 10, target_rows: 10, checksum: 'match' } } as DraftEvent)
  assert.equal(cutoverRunView(state.cutover, false), 'verify')
})

test('전환 화면: 검증을 끈 전환(verify=none, 표 없음)도 검증 단계가 오면 완료', () => {
  seq = 0
  const state = run(running(),
    { type: 'cutover.plan', phase: 'verification', status: 'waiting', data: PLAN } as DraftEvent,
    { type: 'cutover.step', phase: 'verification', status: 'running', data: { n: 1, state: 'done', id: 'pause', method: 'fast', of: 1, result: 'ok', window: 'pause' } } as DraftEvent,
    { type: 'cutover.outcome', phase: 'verification', status: 'running', data: SWITCHED } as DraftEvent,
    { type: 'cutover.step', phase: 'verification', status: 'running', data: { n: 1, state: 'verify', of: 1 } } as DraftEvent)
  assert.equal(cutoverRunView(state.cutover, false), 'done')
})

// ---- 4. 검증 불일치는 표의 "불일치"일 뿐 이전 실패가 아니다 ----

test('검증 불일치: cutover.verify mismatch·data.verify failed가 와도 status는 failed가 아니고 화면은 mismatch', () => {
  seq = 0
  const state = run(running(),
    { type: 'cutover.step', phase: 'verification', status: 'running', data: { n: 1, state: 'done', id: 'pause', method: 'fast', of: 1, result: 'ok', window: 'pause' } } as DraftEvent,
    { type: 'cutover.outcome', phase: 'verification', status: 'running', data: SWITCHED } as DraftEvent,
    { type: 'cutover.verify', phase: 'verification', status: 'failed', data: { table: 'public.messages', source_rows: 10, target_rows: 9, checksum: 'mismatch' } } as DraftEvent,
    { type: 'data.verify', phase: 'data_copy', status: 'failed', data: { name: 'rows', state: 'failed', source: 10, target: 9 } } as DraftEvent,
    { type: 'data.verify', phase: 'data_copy', status: 'failed', data: { name: 'checksum', state: 'failed' } } as DraftEvent)
  assert.equal(state.status, 'running')
  assert.deepEqual(state.failures, {})
  assert.equal(cutoverRunView(state.cutover, false), 'mismatch')
  assert.equal(state.data.verify.find(item => item.name === 'checksum')?.state, 'failed')
})

test('다른 이벤트의 failed는 여전히 그 단계 실패다', () => {
  seq = 0
  const state = run(running(), { type: 'provision.check', phase: 'provisioning', status: 'failed', data: { name: 'dns', state: 'failed' } } as DraftEvent)
  assert.equal(state.status, 'failed')
  assert.ok(state.failures.provisioning)
})

// ---- 6. report cutover_outcome ----

test('리포트: cutover_outcome이 있으면 그 쓰기 중단 시간, 없으면 이벤트 결과, 둘 다 없으면 null', () => {
  const base = running()
  assert.equal(reportPauseMs(base), null)
  const withReport = reducer(base, { type: 'report', report: { stages: [], ai_fixes: 0, cutover_outcome: { ...SWITCHED, pause_ms: 12 } } })
  assert.equal(reportPauseMs(withReport), 12)
  const nullOutcome = reducer(base, { type: 'report', report: { stages: [], ai_fixes: 0, cutover_outcome: null } })
  assert.equal(reportPauseMs(nullOutcome), null)
  const refused = reducer(base, { type: 'report', report: { stages: [], ai_fixes: 0, cutover_outcome: { ...SWITCHED, result: 'refused', pause_ms: null } } })
  assert.equal(reportPauseMs(refused), null)
  seq = 0
  const fromEvent = run(base, { type: 'cutover.outcome', phase: 'verification', status: 'running', data: SWITCHED } as DraftEvent)
  assert.equal(reportPauseMs(fromEvent), 7.4)
})

// ---- 데이터: 복제 통로 단계(data.phase tunnel) ----

test('data.phase tunnel을 받아 둔다(데이터 화면이 통로 여는 중으로 보인다), 사전 검사 결과가 와도 phase 값은 그대로', () => {
  seq = 0
  const state = run(running(), { type: 'data.phase', phase: 'data_copy', status: 'running', data: { phase: 'tunnel' } } as DraftEvent)
  assert.equal(state.data.phase, 'tunnel')
  assert.equal(state.status, 'running')
})
