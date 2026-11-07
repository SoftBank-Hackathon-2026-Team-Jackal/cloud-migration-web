/**
 * 실제 모드 화면 순서가 백엔드 Workflow 순서(데이터 복제 → DB 전환 → 트래픽 전환 → 완료)에 고정되는지.
 * 이벤트 순서는 실제 리허설 migration-b0d3f658(2026-11-07 UTC)을 그대로 재생한다:
 *   06:07:52 data.phase streaming(data_copy) → 06:08:20 cutover.plan·approval.required gate=cutover(verification, waiting)
 *   → (웹 승인 POST /approve?gate=cutover) → cutover.ready·cutover.step×12·cutover.outcome·cutover.verify
 *   → traffic.prepare … 그 사이·뒤에도 data.phase(streaming, data_copy)가 계속 온다.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reducer, type Action, type MigrationState } from '../../src/lib/migration/reducer.ts'
import { canApproveCutover, cutoverEntry, cutoverGate, dataNextStage, dbSwitched, resumeStage, trafficDone, trafficWait } from '../../src/lib/migration/flow.ts'
import { nextFlowStage, stageOfEvent } from '../../src/lib/migration/stageOf.ts'
import { SseProvider } from '../../src/lib/migration/sseProvider.ts'
import { RAIL, STAGE_ORDER } from '../../src/lib/stages.ts'
import { nextStageOf } from '../../src/lib/voice/reports.ts'
import { startRequestFor, type CutoverOutcomeData, type DraftEvent, type MigrationEvent } from '../../src/lib/migration/events.ts'

let seq = 0
const ev = (draft: DraftEvent): MigrationEvent => { seq += 1; return { ...draft, seq, at: '2026-11-07T06:08:20.000Z' } as MigrationEvent }
const run = (state: MigrationState, ...drafts: DraftEvent[]) => drafts.reduce((current, draft) => reducer(current, { type: 'event', event: ev(draft) }), state)
const running = (): MigrationState => ({ ...initialState, migrationId: 'migration-b0d3f658', status: 'running' })

const PLAN = {
  method: 'fast', expected_pause_ms: { min: 4, max: 110 }, preconditions: [], steps: [],
  rehearsal: { source: 'lab', runs: 3, methods: [{ method: 'fast', pause_ms: 110 }] },
  rollback: { standby_hours: 24 }, handover: [],
  topology: { app: 'chat', pooler: 'PgBouncer', source_db: 'src', target_db: 'tgt', source_where: 'EKS', target_where: 'k3d', writes_per_sec: 0 },
}
const SWITCHED: CutoverOutcomeData = { result: 'switched', active: 'target', pause_ms: 7.4, steps: [], replication: { direction: 'reverse', lag_ms: null } }
const REFUSED: CutoverOutcomeData = { result: 'refused', message: 'reverted to source', active: 'source', pause_ms: null, replication: { direction: 'forward', lag_ms: null } }

// ---- 리허설 이벤트 ----
const provisioned = { type: 'provision.resource', phase: 'provisioning', status: 'done', data: { id: 'vpc', kind: 'network', name: 'vpc', state: 'done' } } as unknown as DraftEvent
const streaming = { type: 'data.phase', phase: 'data_copy', status: 'running', data: { phase: 'streaming' } } as DraftEvent
const readiness = { type: 'data.readiness', phase: 'data_copy', status: 'running', data: { longest_tx_ms: 0, lock_waits: 0, commits_per_sec: 12, ready: true } } as DraftEvent
const cutoverPlan = { type: 'cutover.plan', phase: 'verification', status: 'waiting', data: PLAN } as DraftEvent
const cutoverRequest = { type: 'approval.required', phase: 'verification', status: 'waiting', data: { excluded: [], rollback_policy: 'reverse_replication', gate: 'cutover' } } as DraftEvent
const cutoverReady = (attempt = 1) => ({ type: 'cutover.ready', phase: 'verification', status: 'running', data: { attempt, longest_tx_ms: 0, lock_waits: 0, commits_per_sec: 12, ready: true, limits: { longest_tx_ms: 1000, lock_waits: 0 } } }) as DraftEvent
const steps = Array.from({ length: 12 }, (_, index) => ({ type: 'cutover.step', phase: 'verification', status: 'running', data: { n: index + 1, state: 'done', id: 's' + (index + 1), method: 'fast', of: 12, result: 'ok' } }) as DraftEvent)
const outcome = (data: CutoverOutcomeData) => ({ type: 'cutover.outcome', phase: 'verification', status: 'running', data }) as DraftEvent
const verify = { type: 'cutover.verify', phase: 'verification', status: 'running', data: { table: 'orders', source_rows: 10, target_rows: 10, checksum: 'match' } } as DraftEvent
const trafficPrepare = { type: 'traffic.prepare', phase: 'traffic', status: 'running', data: { state: 'running', checks: [] } } as unknown as DraftEvent
const snapshot = (phase: string, target: number) => ({
  type: 'traffic.snapshot', phase: 'traffic', status: 'running',
  data: { phase, weights: { origin: 100 - target, target }, step: target, gate: { failed_requests: 0, max_failed_requests: 0, p99_ratio: 1, max_p99_ratio: 1.5, observe_left_seconds: 0 }, residual: { requests_per_sec: 0, streams: 0 }, notes: [], results: [] },
}) as unknown as DraftEvent

/** 06:07:52: 복제가 streaming이고 게이트 1을 지났다(데이터 화면 "다음"이 켜진다). 아직 승인 요청은 없다. */
const replicated = () => { seq = 0; return run(running(), provisioned, streaming, readiness) }
/** 06:08:20: 전환 계획과 DB 전환 승인 요청 */
const requested = () => run(replicated(), cutoverPlan, cutoverRequest)
/** 06:12:16 이후: 승인이 받아들여지고 전환이 끝났다 */
const switched = () => run(reducer(requested(), { type: 'cutoverApproved' }), cutoverReady(), ...steps, outcome(SWITCHED), verify)

// ---- 순서 상수 ----

test('순서: 화면·진행 표시는 데이터 복제 → DB 전환 → 트래픽 전환 → 완료다(실제·목업 같은 순서)', () => {
  assert.deepEqual(STAGE_ORDER.slice(STAGE_ORDER.indexOf('analysis')), ['analysis', 'rehearsal', 'planning', 'approval', 'provisioning', 'data', 'cutover', 'traffic', 'report'])
  assert.deepEqual(RAIL.map(item => item.stage), ['analysis', 'rehearsal', 'planning', 'approval', 'provisioning', 'data', 'cutover', 'traffic'])
  assert.equal(nextStageOf('data_copy'), 'stage.cutover', '음성: 데이터 다음은 DB 전환')
  assert.equal(nextStageOf('verification'), 'stage.traffic', '음성: DB 전환 다음은 트래픽')
  assert.equal(nextStageOf('traffic'), 'stage.report', '음성: 트래픽 다음은 완료 리포트')
})

// ---- 화면 고르기: phase가 아니라 type ----

test('화면은 이벤트 type으로 고른다: data.* 데이터, cutover.*·승인 요청(gate=cutover) DB 전환, traffic.* 트래픽', () => {
  assert.equal(stageOfEvent(ev(streaming)), 'data')
  assert.equal(stageOfEvent(ev(cutoverPlan)), 'cutover')
  assert.equal(stageOfEvent(ev(cutoverRequest)), 'cutover')
  assert.equal(stageOfEvent(ev({ type: 'approval.required', phase: 'awaiting_approval', status: 'waiting', data: { excluded: [], rollback_policy: '' } } as DraftEvent)), 'approval', '구축 승인(gate 없음)은 승인 화면')
  assert.equal(stageOfEvent(ev(trafficPrepare)), 'traffic')
  assert.equal(nextFlowStage('traffic', ev(streaming)), 'traffic', '트래픽 중 data.phase가 와도 그대로')
  assert.equal(nextFlowStage('cutover', ev(streaming)), 'cutover', 'DB 전환 중 data.phase가 와도 그대로')
  assert.equal(nextFlowStage('traffic', ev(verify)), 'traffic', '트래픽 시작 뒤 늦은 cutover.verify가 와도 그대로')
  assert.equal(nextFlowStage('traffic', ev(cutoverRequest)), 'cutover', '롤백 뒤 승인 요청이 오면 DB 전환 화면')
})

// ---- 리허설 재생 ----

test('리허설: 승인 요청 전 데이터 "다음"은 DB 전환 화면이고, 그 화면은 "전환 준비 중(승인 요청 대기)"이다', () => {
  const state = replicated()
  assert.equal(state.flowStage, 'data')
  assert.equal(dataNextStage(state), 'cutover', '트래픽으로 가지 않는다')
  assert.equal(cutoverEntry(state), 'approve')
  assert.equal(cutoverGate(state, false), 'waiting')
  assert.equal(canApproveCutover(cutoverGate(state, false)), false, '승인 요청 전에는 누를 수 없다')
  assert.equal(trafficWait(state), 'cutover', '트래픽 화면에 와도 DB 전환 대기')
})

test('리허설: 승인 요청(approval.required gate=cutover)을 받으면 버튼이 열리고 화면은 DB 전환이다', () => {
  const state = requested()
  assert.equal(state.approval.cutoverRequired, true)
  assert.equal(state.approval.required, false, '구축 승인과 섞이지 않는다')
  assert.equal(state.flowStage, 'cutover')
  assert.equal(resumeStage(state), 'cutover', '새로 고침해도 DB 전환 화면')
  assert.equal(cutoverGate(state, false), 'ready')
  assert.equal(canApproveCutover(cutoverGate(state, false)), true)
  assert.equal(cutoverGate(state, true), 'sending', '보내는 중에는 다시 누를 수 없다')
  assert.equal(canApproveCutover(cutoverGate(state, true)), false)
})

test('리허설: 승인 요청을 기다리는 중 data.phase가 계속 와도 DB 전환 화면에 머문다', () => {
  const state = run(requested(), streaming, readiness, streaming)
  assert.equal(state.lastPhase, 'data_copy', 'phase는 data_copy지만')
  assert.equal(state.flowStage, 'cutover')
  assert.equal(resumeStage(state), 'cutover')
})

test('리허설: 202 → 승인 요청을 닫고 진행 화면, 전환이 끝나면 "트래픽 전환으로"', () => {
  let state = reducer(requested(), { type: 'cutoverApproved' })
  assert.equal(state.approval.cutoverRequired, false)
  state = run(state, cutoverReady(), ...steps.slice(0, 4))
  assert.equal(cutoverEntry(state), 'run', '다시 들어와도 진행 화면')
  assert.equal(dbSwitched(state), false)
  state = run(state, ...steps.slice(4), outcome(SWITCHED), verify)
  assert.equal(dbSwitched(state), true)
  assert.equal(dataNextStage(state), 'traffic', '전환 뒤 데이터 "다음"은 트래픽')
  assert.equal(trafficWait(state), 'starting', '트래픽 화면은 시작 대기(DB 전환 버튼 없음)')
})

test('리허설: 전환 뒤 data.phase(streaming, data_copy)가 와도 데이터 화면으로 되돌아가지 않는다', () => {
  const state = run(switched(), streaming, readiness, streaming)
  assert.equal(state.lastPhase, 'data_copy')
  assert.equal(state.flowStage, 'cutover')
  assert.equal(resumeStage(state), 'cutover')
})

test('리허설: traffic.* 가 오면 트래픽 화면, 그 뒤 data.phase·늦은 cutover.verify가 와도 트래픽에 머문다', () => {
  let state = run(switched(), trafficPrepare)
  assert.equal(state.flowStage, 'traffic')
  assert.equal(trafficWait(state), null)
  state = run(state, streaming, verify, snapshot('observing', 10), streaming, snapshot('observing', 50))
  assert.equal(state.flowStage, 'traffic')
  assert.equal(resumeStage(state), 'traffic')
  assert.equal(trafficDone(state), false)
  state = run(state, snapshot('complete', 100))
  assert.equal(trafficDone(state), true)
  assert.equal(resumeStage(state), 'report', '트래픽이 끝났으면 다시 접속 시 완료 리포트')
})

test('리허설: 409 CUTOVER_NOT_READY → 안내를 보이고 다시 누를 수 있다. 새 승인 요청이 오면 안내를 지운다', () => {
  let state = reducer(requested(), { type: 'requestError', key: 'cutover', error: { code: 'request_failed', message: 'HTTP 409', phase: 'verification', retryable: true, detail: 'CUTOVER_NOT_READY' } })
  assert.equal(state.status, 'waiting', '이전 전체는 실패가 아니다')
  assert.equal(cutoverGate(state, false), 'rejected')
  assert.equal(canApproveCutover(cutoverGate(state, false)), true)
  state = run(state, cutoverRequest)
  assert.equal(cutoverGate(state, false), 'ready')
})

test('롤백: 전환이 거부된 뒤 승인 요청이 다시 오면 버튼이 다시 열린다', () => {
  let state = run(reducer(requested(), { type: 'cutoverApproved' }), cutoverReady(), ...steps.slice(0, 3), outcome(REFUSED))
  assert.equal(cutoverGate(state, false), 'waiting')
  state = run(state, cutoverRequest)
  assert.equal(cutoverGate(state, false), 'ready')
  assert.equal(cutoverEntry(state), 'approve')
  state = reducer(state, { type: 'cutoverApproved' })
  state = run(state, cutoverReady(2), outcome(SWITCHED))
  assert.equal(state.cutover.attempt, 2)
  assert.equal(dbSwitched(state), true)
})

test('롤백: 전환을 마친 뒤 되돌려 승인 요청이 다시 오면 전환되지 않은 것으로 보고 DB 전환 화면을 연다', () => {
  const state = run(switched(), cutoverRequest)
  assert.equal(dbSwitched(state), false)
  assert.equal(dataNextStage(state), 'cutover')
  assert.equal(cutoverEntry(state), 'approve')
  assert.equal(resumeStage(state), 'cutover')
})

// ---- 새로 고침 복원(snapshot reset) ----

function replayed(drafts: DraftEvent[]): MigrationState {
  seq = 0
  const events = drafts.map(ev)
  const snap = { seq: seq + 1, at: '2026-11-07T06:13:00.000Z', type: 'snapshot', phase: 'data_copy', status: 'running', data: { migration_id: 'migration-b0d3f658', status: 'running', reset: true, events } } as unknown as MigrationEvent
  return reducer(initialState, { type: 'event', event: snap })
}

test('새로 고침: snapshot으로 다시 쌓아도 마지막 이벤트 type의 화면을 연다', () => {
  assert.equal(resumeStage(replayed([provisioned, streaming, readiness])), 'data')
  assert.equal(resumeStage(replayed([provisioned, streaming, cutoverPlan, cutoverRequest, streaming])), 'cutover')
  assert.equal(resumeStage(replayed([provisioned, streaming, cutoverPlan, cutoverRequest, cutoverReady(), ...steps, outcome(SWITCHED), verify, streaming])), 'cutover')
  assert.equal(resumeStage(replayed([provisioned, streaming, cutoverPlan, cutoverRequest, cutoverReady(), outcome(SWITCHED), trafficPrepare, streaming])), 'traffic')
  assert.equal(resumeStage(replayed([provisioned, streaming, cutoverPlan, cutoverRequest, cutoverReady(), outcome(SWITCHED), trafficPrepare, snapshot('complete', 100)])), 'report')
  assert.equal(resumeStage(initialState), 'analysis')
})

// ---- 승인 요청 보내기(SseProvider) ----

function harness(respond: () => Response) {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/events')) return new Response(null, { status: 404 })
    calls.push((init?.method ?? 'GET') + ' ' + url)
    if (url.endsWith('/migrations') && init?.method === 'POST') return Response.json({ workflow_id: 'm-1' })
    return respond()
  }) as typeof fetch
  const actions: Action[] = []
  const provider = new SseProvider({ dispatch: action => actions.push(action) }, { baseUrl: 'http://backend.test', startMode: 'legacy' })
  return { provider, calls, actions, restore: () => { provider.dispose(); globalThis.fetch = original } }
}
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }

test('승인: 202면 true를 돌려주고 승인 요청을 닫는다(cutoverApproved)', async () => {
  const { provider, calls, actions, restore } = harness(() => Response.json({ status: 'accepted' }, { status: 202 }))
  try {
    provider.start(startRequestFor('onprem'))
    await settle()
    actions.length = 0
    assert.equal(await provider.approveCutover(), true)
    assert.ok(calls.includes('POST http://backend.test/migrations/m-1/approve?gate=cutover'))
    const state = actions.reduce(reducer, requested())
    assert.equal(state.approval.cutoverRequired, false)
    assert.equal(state.requestErrors.cutover, undefined)
  } finally { restore() }
})

test('승인: 409 CUTOVER_NOT_READY면 false를 돌려주고 승인 요청은 열린 채 안내가 남는다', async () => {
  const { provider, actions, restore } = harness(() => Response.json({ detail: { code: 'CUTOVER_NOT_READY' } }, { status: 409 }))
  try {
    provider.start(startRequestFor('onprem'))
    await settle()
    actions.length = 0
    assert.equal(await provider.approveCutover(), false)
    const state = actions.reduce(reducer, requested())
    assert.equal(state.approval.cutoverRequired, true)
    assert.equal(state.requestErrors.cutover?.detail, 'CUTOVER_NOT_READY')
    assert.equal(cutoverGate(state, false), 'rejected')
  } finally { restore() }
})
