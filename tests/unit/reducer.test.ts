import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reducer, type MigrationState } from '../../src/lib/migration/reducer.ts'
import type { DraftEvent, MigrationEvent } from '../../src/lib/migration/events.ts'

let seq = 0
/** 시험용 이벤트 만들기: seq·at은 자동으로 붙는다. */
function ev(draft: DraftEvent, at = '2026-01-01T00:00:00.000Z'): MigrationEvent {
  seq += 1
  return { ...draft, seq, at } as MigrationEvent
}
const run = (state: MigrationState, ...events: MigrationEvent[]) =>
  events.reduce((current, event) => reducer(current, { type: 'event', event }), state)

const finding = (id: string, progress: number): DraftEvent => ({
  type: 'analysis.finding', phase: 'analysis', status: 'running',
  data: { id, stream: 'infrastructure', key: 'vpc', via: ['config'], progress, message: '', detail: '' },
})

test('분석 발견 항목은 id별로 쌓이고 같은 id는 덮어쓴다', () => {
  seq = 0
  let state = run(initialState, ev(finding('a', 10)), ev(finding('b', 20)))
  assert.equal(state.analysis.findings.length, 2)
  assert.equal(state.status, 'running')
  state = run(state, ev(finding('a', 15)))
  assert.deepEqual(state.analysis.findings.map(item => [item.id, item.progress]), [['a', 15], ['b', 20]])
  state = run(state, ev({ type: 'analysis.done', phase: 'analysis', status: 'done', data: {} }))
  assert.equal(state.analysis.done, true)
})

test('이미 받은 seq의 이벤트는 무시한다', () => {
  seq = 0
  const first = ev(finding('a', 10))
  const state = run(initialState, first, ev(finding('b', 20)))
  assert.equal(reducer(state, { type: 'event', event: first }), state)
})

test('검증 항목은 id별 최신 상태와 마지막 이벤트를 가진다', () => {
  seq = 0
  const check = (id: string, state: 'running' | 'failed' | 'done', fixed?: number): DraftEvent =>
    ({ type: 'build.check', phase: 'build', status: 'running', data: { id, state, fixed } })
  const state = run(initialState, ev(check('db', 'running')), ev(check('db', 'failed')), ev(check('build', 'done')))
  assert.equal(state.build.checks.db.state, 'failed')
  assert.equal(state.build.checks.build.state, 'done')
  assert.equal(state.build.lastCheck?.id, 'build')
})

test('수정 목록과 계획 단계, 구축 리소스는 id로 upsert 된다', () => {
  seq = 0
  const fix: DraftEvent = { type: 'build.fix', phase: 'build', status: 'running', data: { id: 'db', check: 'db', lines: [{ kind: 'add', text: '+ x' }], why: '', evidence: '' } }
  const step: DraftEvent = { type: 'plan.step', phase: 'planning', status: 'running', data: { id: 'network', group: 'infrastructure', grade: 'convert', before: '', after: '', evidence: '', change: '' } }
  const resource: DraftEvent = { type: 'provision.resource', phase: 'provisioning', status: 'running', data: { id: 'gcp-network', key: 'network', state: 'done', progress: 17 } }
  const state = run(initialState, ev(fix), ev(fix), ev(step), ev(resource), ev({ type: 'plan.ready', phase: 'planning', status: 'done', data: {} }))
  assert.equal(state.build.fixes.length, 1)
  assert.equal(state.plan.steps.length, 1)
  assert.equal(state.plan.ready, true)
  assert.equal(state.provision.resources[0].progress, 17)
})

test('지연 기록은 값이 있을 때만 쌓이고 48개까지만 남는다', () => {
  seq = 0
  const progress = (lag: number | null): DraftEvent => ({
    type: 'data.progress', phase: 'data_copy', status: 'running',
    data: { step: 'cdc', rows: 1, total_rows: 2, lag_ms: lag, writes_per_sec: 100, dump_percent: 100 },
  })
  let state = run(initialState, ev(progress(null)))
  assert.deepEqual(state.data.lagHistory, [])
  for (let i = 0; i < 60; i++) state = run(state, ev(progress(i)))
  assert.equal(state.data.lagHistory.length, 48)
  assert.equal(state.data.lagHistory[47], 59)
  assert.equal(state.data.current?.lag_ms, 59)
})

test('트래픽 스냅샷의 기록(notes)은 최신순으로 쌓이고 restart는 비운다', () => {
  seq = 0
  const base = { phase: 'applying', weights: { origin: 100, target: 0 }, step: 10, gate: { failed_requests: 0, max_failed_requests: 0, p99_ratio: 1, max_p99_ratio: 1.5, observe_left_seconds: 0 }, residual: { requests_per_sec: 0, streams: 0 } } as const
  const snap = (notes: NonNullable<Extract<MigrationEvent, { type: 'traffic.snapshot' }>['data']['notes']>): DraftEvent =>
    ({ type: 'traffic.snapshot', phase: 'traffic', status: 'running', data: { ...base, notes } })
  let state = run(initialState, ev(snap([{ key: 'apply', params: { pct: 10 } }])), ev(snap([{ key: 'inject' }, { key: 'manual' }])))
  assert.deepEqual(state.traffic.logs.map(item => item.key), ['manual', 'inject', 'apply'])
  state = run(state, ev(snap([{ key: 'restart' }])))
  assert.equal(state.traffic.logs.length, 0)
  assert.equal(state.traffic.snapshot?.step, 10)
})

test('전환 단계: 완료된 단계 수와 측정 구간, 결과 3개가 모이면 완료', () => {
  seq = 0
  const step = (n: 1 | 2 | 3 | 4 | 5 | 6, s: 'running' | 'done' | 'verify'): DraftEvent => ({ type: 'cutover.step', phase: 'verification', status: 'running', data: { n, state: s } })
  const result = (id: 'fail' | 'delay' | 'loss'): DraftEvent => ({ type: 'cutover.result', phase: 'verification', status: 'running', data: { id, value: '0' } })
  let state = run(initialState, ev(step(1, 'done')), ev(step(2, 'running')))
  assert.equal(state.cutover.doneSteps, 1)
  state = run(state, ev(step(6, 'done')), ev(step(6, 'verify')), ev(result('fail')), ev(result('delay')))
  assert.equal(state.cutover.doneSteps, 6)
  assert.equal(state.cutover.verifying, true)
  assert.notEqual(state.status, 'done')
  state = run(state, ev(result('loss')))
  assert.equal(state.status, 'done')
})

test('승인 요청은 대기 상태로, 두 번째 승인은 따로 표시한다', () => {
  seq = 0
  let state = run(initialState, ev({ type: 'approval.required', phase: 'awaiting_approval', status: 'waiting', data: { excluded: ['x'], rollback_policy: 'p' } }))
  assert.equal(state.status, 'waiting')
  assert.equal(state.approval.required, true)
  assert.deepEqual(state.approval.excluded, ['x'])
  state = run(state, ev({ type: 'approval.required', phase: 'verification', status: 'waiting', data: { excluded: [], rollback_policy: '', gate: 'cutover' } }))
  assert.equal(state.approval.cutoverRequired, true)
  assert.equal(state.approval.excluded.length, 1)
})

test('실패한 단계와 error 이벤트는 failures에 기록되고 취소는 cancelled가 된다', () => {
  seq = 0
  let state = run(initialState, ev({ type: 'provision.resource', phase: 'provisioning', status: 'failed', message: '쿼터 초과', data: { id: 'x', key: 'network', state: 'failed', progress: 0 } }))
  assert.equal(state.status, 'failed')
  assert.equal(state.failures.provisioning?.message, '쿼터 초과')
  state = run(initialState, ev({ type: 'error', phase: 'data_copy', status: 'failed', data: { code: 'db_unreachable', message: '연결 실패', phase: 'data_copy', retryable: false } }))
  assert.equal(state.failures.data_copy?.code, 'db_unreachable')
  assert.equal(state.error?.retryable, false)
  state = run(state, ev({ type: 'error', phase: 'traffic', status: 'failed', data: { code: 'cancelled', message: '', phase: 'traffic', retryable: false } }))
  assert.equal(state.status, 'cancelled')
})

test('snapshot(reset)은 상태를 비우고 이벤트로 다시 쌓으며, 이어 받기는 새 이벤트만 반영한다', () => {
  seq = 0
  const a = ev(finding('a', 10))
  const b = ev(finding('b', 20))
  const stale = run(initialState, ev(finding('zzz', 5)))
  const snapshot = (reset: boolean, events: MigrationEvent[]): MigrationEvent =>
    ev({ type: 'snapshot', phase: 'analysis', status: 'running', data: { migration_id: 'm1', status: 'running', reset, events } })
  let state = reducer(stale, { type: 'event', event: snapshot(true, [a, b]) })
  assert.deepEqual(state.analysis.findings.map(item => item.id), ['a', 'b'])
  assert.equal(state.migrationId, 'm1')
  const c = ev(finding('c', 30))
  state = reducer(state, { type: 'event', event: snapshot(false, [b, c]) })
  assert.deepEqual(state.analysis.findings.map(item => item.id), ['a', 'b', 'c'])
})

test('단계 초기화(resetPhase)는 그 단계 값만 비운다', () => {
  seq = 0
  let state = run(initialState, ev(finding('a', 10)), ev({ type: 'plan.ready', phase: 'planning', status: 'done', data: {} }))
  state = reducer(state, { type: 'resetPhase', phase: 'planning' })
  assert.equal(state.plan.ready, false)
  assert.equal(state.analysis.findings.length, 1)
})

test('연결 상태는 reset 후에도 유지된다', () => {
  let state = reducer(initialState, { type: 'connection', value: 'reconnecting' })
  state = reducer(state, { type: 'started', migrationId: 'm' })
  assert.equal(state.connection, 'reconnecting')
  assert.equal(state.migrationId, 'm')
})
