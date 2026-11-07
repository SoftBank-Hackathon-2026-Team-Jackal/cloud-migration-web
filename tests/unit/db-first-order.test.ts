/**
 * 플랫폼 실제 순서(데이터 복제 → DB 전환(2차 승인) → 트래픽 → 완료)에서 화면 이동이 옛 순서로 새지 않는지.
 * 이벤트 순서는 실제 실행 migration-cf7c5262에서 가져왔다:
 *   seq 65 cutover.plan · 66 approval.required gate=cutover · 212 cutover.outcome switched ·
 *   219 traffic.prepare(전환 0.3초 뒤) · … · 800 error TRAFFIC_ROLLED_BACK.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reducer, type MigrationState } from '../../src/lib/migration/reducer.ts'
import { cutoverAfter, cutoverEntry, dataNextStage, trafficDone } from '../../src/lib/migration/flow.ts'
import type { CutoverOutcomeData, DraftEvent, MigrationEvent } from '../../src/lib/migration/events.ts'

let seq = 0
function ev(draft: DraftEvent, at: number): MigrationEvent {
  return { ...draft, seq: at, at: '2026-11-07T00:00:00.000Z' } as MigrationEvent
}
const run = (state: MigrationState, ...drafts: DraftEvent[]) =>
  drafts.reduce((current, draft) => { seq += 1; return reducer(current, { type: 'event', event: ev(draft, seq) }) }, state)
const running = (): MigrationState => ({ ...initialState, migrationId: 'migration-cf7c5262', status: 'running' })

const SWITCHED: CutoverOutcomeData = { result: 'switched', active: 'target', pause_ms: 7.4, steps: [], replication: { direction: 'reverse', lag_ms: null } }
const PLAN = {
  method: 'fast', expected_pause_ms: { min: 4, max: 110 }, preconditions: [], steps: [],
  rehearsal: { source: 'lab', runs: 3, methods: [{ method: 'fast', pause_ms: 110 }] },
  rollback: { standby_hours: 24 }, handover: [],
  topology: { app: 'chat', pooler: 'PgBouncer', source_db: 'src', target_db: 'tgt', source_where: 'EKS', target_where: 'k3d', writes_per_sec: 0 },
}
const snapshot = (phase: string) => ({
  type: 'traffic.snapshot', phase: 'traffic', status: 'running',
  data: { phase, weights: { origin: 0, target: 100 }, step: 100, gate: { failed_requests: 0, max_failed_requests: 0, p99_ratio: 1, max_p99_ratio: 1.5, observe_left_seconds: 0 }, residual: { requests_per_sec: 0, streams: 0 }, notes: [], results: [] },
}) as unknown as DraftEvent

/** seq 65 → 212 → 219: 전환 직후 트래픽 준비 이벤트까지 받은 상태 */
function switchedThenTrafficPrepare() {
  seq = 0
  return run(running(),
    { type: 'cutover.plan', phase: 'verification', status: 'waiting', data: PLAN } as DraftEvent,
    { type: 'approval.required', phase: 'verification', status: 'waiting', data: { excluded: [], rollback_policy: 'reverse_replication', gate: 'cutover' } } as DraftEvent,
    { type: 'cutover.outcome', phase: 'verification', status: 'running', data: SWITCHED } as DraftEvent,
    { type: 'traffic.prepare', phase: 'traffic', status: 'running', data: { state: 'running', checks: [] } } as unknown as DraftEvent)
}

test('실제 순서: 전환 계획·2차 승인이 트래픽보다 먼저 오면 dbFirst', () => {
  const state = switchedThenTrafficPrepare()
  assert.equal(state.cutover.dbFirst, true)
  assert.equal(dataNextStage(state), 'traffic', '전환을 마쳤으면 데이터 다음은 트래픽')
})

test('실제 순서: 전환 0.3초 뒤 traffic.prepare가 이미 와도 전환 "다음"은 트래픽이다(리포트로 건너뛰지 않는다)', () => {
  const state = switchedThenTrafficPrepare()
  assert.equal(trafficDone(state), false)
  assert.equal(cutoverAfter(state), 'traffic')
})

test('실제 순서: 트래픽 진행 중 전환 화면에 다시 들어오면 리포트가 아니라 전환 결과(통과)를 보인다', () => {
  let state = switchedThenTrafficPrepare()
  assert.equal(cutoverEntry(state), 'run')
  state = run(state, snapshot('observing'))
  assert.equal(cutoverEntry(state), 'run')
  assert.equal(cutoverAfter(state), 'traffic')
})

test('실제 순서: 트래픽이 끝나면(complete) 전환 화면은 완료 리포트', () => {
  const state = run(switchedThenTrafficPrepare(), snapshot('observing'), snapshot('complete'))
  assert.equal(trafficDone(state), true)
  assert.equal(cutoverEntry(state), 'report')
  assert.equal(cutoverAfter(state), 'report')
})

test('실제 순서: 트래픽 롤백(snapshot rolledback)이나 error TRAFFIC_ROLLED_BACK(seq 800)도 트래픽이 끝난 것으로 본다', () => {
  const rolled = run(switchedThenTrafficPrepare(), snapshot('rolledback'))
  assert.equal(trafficDone(rolled), true)
  assert.equal(cutoverAfter(rolled), 'report')
  const failed = run(switchedThenTrafficPrepare(), snapshot('observing'),
    { type: 'error', phase: 'traffic', status: 'failed', data: { code: 'TRAFFIC_ROLLED_BACK', message: 'rolled back', retryable: false } } as unknown as DraftEvent)
  assert.equal(failed.status, 'failed')
  assert.equal(trafficDone(failed), true)
  assert.equal(cutoverEntry(failed), 'report')
})

test('실제 순서: 이전이 done이면 트래픽 이벤트가 없어도 끝난 것으로 본다', () => {
  const state = { ...switchedThenTrafficPrepare(), status: 'done' as const }
  assert.equal(trafficDone(state), true)
  assert.equal(cutoverAfter(state), 'report')
})

test('옛 순서(목업): 트래픽 뒤 전환은 예전처럼 승인 화면으로 들어가고 다음은 완료 리포트', () => {
  seq = 0
  const state = run(running(), snapshot('complete'),
    { type: 'cutover.plan', phase: 'verification', status: 'waiting', data: PLAN } as DraftEvent,
    { type: 'cutover.outcome', phase: 'verification', status: 'running', data: SWITCHED } as DraftEvent)
  assert.equal(state.cutover.dbFirst, false)
  assert.equal(cutoverEntry(state), 'approve')
  assert.equal(cutoverAfter(state), 'report')
})
