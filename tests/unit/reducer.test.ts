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
  const step: DraftEvent = { type: 'plan.step', phase: 'planning', status: 'running', data: { id: 'network', group: 'infrastructure', grade: 'API_DIFF', before: '', after: '', evidence: '', change: '', action: 'PROCEED', keep_source: false, verification: 'UNVERIFIED' } }
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

test('DB 전환 상세: 계획·전환 가능 시점·단계(ms)·결과·테이블 검증, 새 시도면 지난 결과를 비운다 [가정]', () => {
  seq = 0
  const phase = 'verification' as const
  const ready = (attempt: number): DraftEvent => ({ type: 'cutover.ready', phase, status: 'running', data: { attempt, longest_tx_ms: 40, lock_waits: 0, commits_per_sec: 128, ready: true, limits: { longest_tx_ms: 1000, lock_waits: 0 } } })
  const step = (n: number, id: string, ms: number): DraftEvent => ({ type: 'cutover.step', phase, status: 'running', data: { n, state: 'done', id, ms, method: 'fast', of: 3 } })
  const plan: DraftEvent = { type: 'cutover.plan', phase, status: 'waiting', data: { method: 'fast', expected_pause_ms: { min: 4, max: 8 }, rehearsal: { source: 'poc/demo', runs: 1, methods: [] }, preconditions: [], steps: [], rollback: { standby_hours: 72 }, topology: { app: 'a', pooler: 'p', source_db: 's', target_db: 't', source_where: 'x', target_where: 'y', writes_per_sec: 1 }, handover: [] } }
  let state = run(initialState, ev(plan), ev(ready(1)), ev(step(2, 'marker', 2.1)), ev(step(1, 'pause', 0.6)), ev(step(3, 'liveness', 3)))
  assert.deepEqual(state.cutover.steps.map(item => item.id), ['pause', 'marker', 'liveness'], '받은 순서와 상관없이 n순')
  assert.equal(state.cutover.doneSteps, 3)
  state = run(state,
    ev({ type: 'cutover.outcome', phase, status: 'waiting', data: { result: 'refused', reason: 'TARGET_LIVENESS_FAILED', active: 'source', pause_ms: 5.7, held_requests: 2, failed_requests: 0, replication: { direction: 'forward', lag_ms: null } } }),
    ev({ type: 'cutover.verify', phase, status: 'running', data: { table: 'orders', source_rows: 10, target_rows: null, checksum: 'skipped' } }),
    ev({ type: 'cutover.verify', phase, status: 'running', data: { table: 'orders', source_rows: 11, target_rows: null, checksum: 'skipped' } }))
  assert.equal(state.cutover.outcome?.result, 'refused')
  assert.equal(state.cutover.tables.length, 1)
  assert.equal(state.cutover.tables[0].source_rows, 11)
  assert.notEqual(state.status, 'failed', '거부는 실패가 아니다')
  state = run(state, ev(ready(2)))
  assert.equal(state.cutover.attempt, 2)
  assert.equal(state.cutover.outcome, null)
  assert.deepEqual(state.cutover.steps, [])
  assert.equal(state.cutover.tables.length, 0)
  assert.ok(state.cutover.plan, '계획은 남는다')
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

// ---- 흐름 계약 v2: 빌드 결과·사람 검토·계획 버전·프로비저닝 검사 ----

const buildResult = (attempt: number, status: 'SUCCEEDED' | 'FAILED', extra: Partial<{ digest: string | null; reused: boolean; error_code: 'BUILD_FAILED' | null }> = {}): DraftEvent => ({
  type: 'build.result', phase: 'build', status: 'running',
  data: { attempt, max_attempts: 3, status, digest: status === 'SUCCEEDED' ? 'sha256:abc' : null, image_uri: null, reused: false, error_code: status === 'FAILED' ? 'BUILD_FAILED' : null, ...extra },
})

test('빌드 결과는 시도 횟수와 최신 결과를 남기고, 실패해도 단계 실패가 아니다', () => {
  seq = 0
  const state = run(initialState, ev(buildResult(1, 'FAILED')), ev(buildResult(2, 'SUCCEEDED', { reused: true })))
  assert.equal(state.build.attempt, 2)
  assert.equal(state.build.result?.status, 'SUCCEEDED')
  assert.equal(state.build.result?.reused, true)
  assert.equal(state.status, 'running')
  assert.deepEqual(state.failures, {})
})

test('build.check의 attempt가 시도 횟수에 반영된다', () => {
  seq = 0
  const state = run(initialState, ev({ type: 'build.check', phase: 'build', status: 'running', data: { id: 'build', state: 'running', attempt: 2 } }))
  assert.equal(state.build.attempt, 2)
})

test('사람 검토 대기: build.review는 waiting 상태가 되고 새 빌드 결과가 오면 풀린다', () => {
  seq = 0
  let state = run(initialState, ev(buildResult(3, 'FAILED')), ev({ type: 'build.review', phase: 'build', status: 'waiting', data: { reason: 'max_attempts', attempts: 3 } }))
  assert.equal(state.status, 'waiting')
  assert.deepEqual(state.build.review, { reason: 'max_attempts', attempts: 3 })
  state = run(state, ev(buildResult(1, 'SUCCEEDED')))
  assert.equal(state.build.review, null)
  assert.equal(state.status, 'running')
})

test('plan.ready는 계획 버전·Digest를 담고, 빈 객체는 이전 값을 지우지 않는다', () => {
  seq = 0
  const ready = (revision: number): DraftEvent => ({ type: 'plan.ready', phase: 'planning', status: 'done', data: { plan_id: 'p', revision, template_version: 't1', built_digest: 'sha256:a', verified_digest: 'sha256:a' } })
  let state = run(initialState, ev(ready(1)))
  assert.equal(state.plan.meta?.revision, 1)
  state = run(state, ev({ type: 'plan.ready', phase: 'planning', status: 'done', data: {} }))
  assert.equal(state.plan.ready, true)
  assert.equal(state.plan.meta?.template_version, 't1')
})

test('계획 수정으로 revision이 올라가면 같은 id의 단계는 덮어쓰고 새 버전이 반영된다', () => {
  seq = 0
  const step: DraftEvent = { type: 'plan.step', phase: 'planning', status: 'running', data: { id: 'network', group: 'infrastructure', grade: 'API_DIFF', before: '', after: '', evidence: '', change: '', action: 'PROCEED', keep_source: false, verification: 'UNVERIFIED' } }
  const ready = (revision: number): DraftEvent => ({ type: 'plan.ready', phase: 'planning', status: 'done', data: { revision } })
  let state = run(initialState, ev(step), ev(ready(1)))
  state = run(state, ev(step), ev(ready(2)))
  assert.equal(state.plan.steps.length, 1)
  assert.equal(state.plan.meta?.revision, 2)
})

test('프로비저닝 검사는 이름별로 덮어쓰고 같은 seq 중복은 무시한다', () => {
  seq = 0
  const check = (state: 'running' | 'done', extra: object = {}): DraftEvent => ({ type: 'provision.check', phase: 'provisioning', status: 'running', data: { name: 'retest', state, ...extra } })
  const first = ev(check('running'))
  let state = run(initialState, first, ev(check('done', { passed: 12, total: 12 })))
  assert.equal(state.provision.checks.length, 1)
  assert.equal(state.provision.checks[0].passed, 12)
  const before = state
  state = reducer(state, { type: 'event', event: first })
  assert.equal(state, before)
})

test('단계 초기화는 새 필드(시도·검토·검사)도 비운다', () => {
  seq = 0
  let state = run(initialState, ev(buildResult(1, 'FAILED')), ev({ type: 'provision.check', phase: 'provisioning', status: 'running', data: { name: 'pods_ready', state: 'done' } }))
  state = reducer(reducer(state, { type: 'resetPhase', phase: 'build' }), { type: 'resetPhase', phase: 'provisioning' })
  assert.equal(state.build.attempt, null)
  assert.equal(state.build.result, null)
  assert.equal(state.provision.checks.length, 0)
})

test('정합성 확인·전환 조건 확인·운영권 인계는 이름별 최신 상태를 가지고 단계 초기화로 비워진다', () => {
  seq = 0
  let state = run(initialState,
    ev({ type: 'data.verify', phase: 'data_copy', status: 'running', data: { name: 'rows', state: 'running' } }),
    ev({ type: 'data.verify', phase: 'data_copy', status: 'running', data: { name: 'rows', state: 'done', source: 10, target: 10 } }),
    ev({ type: 'data.verify', phase: 'data_copy', status: 'done', data: { name: 'checksum', state: 'done' } }),
    ev({ type: 'traffic.ready', phase: 'traffic', status: 'running', data: { state: 'running', lag_ms: 38, longest_tx_ms: 420, commits_per_sec: 118 } }),
    ev({ type: 'traffic.ready', phase: 'traffic', status: 'running', data: { state: 'done', lag_ms: 12, longest_tx_ms: 85, commits_per_sec: 118 } }),
    ev({ type: 'cutover.handover', phase: 'verification', status: 'running', data: { item: 'dns', state: 'running' } }),
    ev({ type: 'cutover.handover', phase: 'verification', status: 'done', data: { item: 'dns', state: 'done' } }))
  assert.equal(state.data.verify.length, 2)
  assert.equal(state.data.verify.find(item => item.name === 'rows')?.state, 'done')
  assert.equal(state.traffic.ready?.state, 'done')
  assert.deepEqual(state.cutover.handover, [{ item: 'dns', state: 'done' }])
  state = ['data_copy', 'traffic', 'verification'].reduce((current, phase) => reducer(current, { type: 'resetPhase', phase: phase as 'data_copy' | 'traffic' | 'verification' }), state)
  assert.equal(state.data.verify.length, 0)
  assert.equal(state.traffic.ready, null)
  assert.equal(state.cutover.handover.length, 0)
})

test('샌드박스 루프: 트랙별 단계·판정·최종 상태가 쌓이고, INFRA 재시도는 같은 attempt의 새 트랙이다', () => {
  const checks = { required_passed: 0, required_total: 24, unsupported_calls: 0, calls_in_mapping: 9, calls_total: 9, blocked_egress: 0 }
  let state = run(initialState,
    ev({ type: 'sandbox.env', phase: 'build', status: 'running', data: { namespace: 'sbx-run-1', expires_minutes: 120, egress_allowed: 3 } }),
    ev({ type: 'sandbox.step', phase: 'build', status: 'running', data: { run: 1, attempt: 1, step: 'apply', state: 'failed' } }),
    ev({ type: 'sandbox.attempt', phase: 'build', status: 'running', data: { run: 1, attempt: 1, max_attempts: 3, verdict: { passed: false, reasons: ['timeout'] }, failure_class: 'INFRA', checks, fix_ids: [] } }),
    ev({ type: 'sandbox.step', phase: 'build', status: 'running', data: { run: 2, attempt: 1, step: 'judge', state: 'done' } }),
    ev({ type: 'sandbox.attempt', phase: 'build', status: 'running', data: { run: 2, attempt: 1, max_attempts: 3, verdict: { passed: true, reasons: [] }, failure_class: null, checks: { ...checks, required_passed: 24 }, fix_ids: [] } }),
    ev({ type: 'sandbox.done', phase: 'build', status: 'done', data: { status: 'PASSED', cleanup_status: 'CLEANED', digest: 'sha256:abc' } }),
  )
  assert.equal(state.sandbox.env?.namespace, 'sbx-run-1')
  assert.equal(state.sandbox.steps[1].apply, 'failed')
  assert.equal(state.sandbox.steps[2].judge, 'done')
  assert.deepEqual(state.sandbox.attempts.map(item => [item.run, item.attempt, item.failure_class]), [[1, 1, 'INFRA'], [2, 1, null]])
  assert.equal(state.build.attempt, 1)
  assert.equal(state.sandbox.done?.cleanup_status, 'CLEANED')
  state = run(state, ev({ type: 'sandbox.attempt', phase: 'build', status: 'running', data: { run: 2, attempt: 1, max_attempts: 3, verdict: { passed: true, reasons: [] }, failure_class: null, checks, fix_ids: [] } }))
  assert.equal(state.sandbox.attempts.length, 2, '같은 트랙의 판정은 덮어쓴다')
})

// ---- 데이터 이전 단계 상세 [가정] ----
test('데이터 이전: 사전 검사는 통째로 바뀌고, 테이블은 이름으로 덮어쓰고, 지연 궤적은 160개까지 남는다', async () => {
  const { dataTimeline, dataTickAt, DATA_END_MS } = await import('../../src/lib/migration/dataScript.ts')
  seq = 0
  let state = initialState
  for (const { event } of dataTimeline('onprem', 'pass', 0)) state = run(state, ev(event))
  assert.equal(state.data.preflight?.status, 'PASS')
  assert.equal(state.data.preflight?.checks.length, 4)
  assert.equal(state.data.phase, 'streaming')
  assert.equal(state.data.tables.length, 6, '테이블은 이름당 하나')
  assert.ok(state.data.tables.every(table => table.state === 'matched'))
  assert.equal(state.data.readiness?.ready, true)
  assert.equal(state.status, 'running', '사전 검사·단계 이벤트가 이전을 실패로 만들지 않는다')
  for (let ms = 0; ms <= DATA_END_MS + 30000; ms += 250) for (const event of dataTickAt(ms, 'pass')) state = run(state, ev(event))
  assert.equal(state.data.lagTrace.length, 160)
  assert.equal(state.data.lsn?.lag_bytes, 0)
  assert.equal(state.data.current?.step, 'ready', '예전 진행 값도 함께 온다')
  state = reducer(state, { type: 'resetPhase', phase: 'data_copy' })
  assert.deepEqual(state.data, initialState.data)
})

test('데이터 이전: 경로 실패면 시작 차단이고 이전 자체는 실패가 아니다', async () => {
  const { dataTimeline } = await import('../../src/lib/migration/dataScript.ts')
  seq = 0
  let state = initialState
  for (const { event } of dataTimeline('gcp', 'route', 0)) state = run(state, ev(event))
  assert.equal(state.data.preflight?.status, 'FAIL')
  assert.equal(state.data.preflight?.may_start, false)
  assert.equal(state.data.preflight?.checks.find(check => check.name === 'route')?.code, 'ROUTE_NOT_TUNNEL')
  assert.deepEqual(state.data.preflight?.checks.filter(check => check.status === 'SKIPPED').map(check => check.name), ['db_path', 'large_transfer'])
  assert.equal(state.data.phase, 'blocked')
  assert.equal(state.data.tables.length, 0)
  assert.equal(state.failures.data_copy, undefined)
})

test('승인 결정: 전달 상태는 뒤로 가지 않고, 다시 전달하면 새 시도로 바뀐다 [가정: approval.decision]', () => {
  seq = 0
  const base = { approval_id: 'a1', plan_id: 'p', revision: 1, decision: 'APPROVE' as const, scope: 'FULL' as const, delivery_attempts: 1, execution_status: 'NOT_STARTED' as 'NOT_STARTED' | 'RUNNING' }
  const decision = (data: Partial<typeof base> & { delivery_status: 'PENDING' | 'DELIVERED' | 'FAILED'; execution_status?: 'NOT_STARTED' | 'RUNNING' }): DraftEvent =>
    ({ type: 'approval.decision', phase: 'awaiting_approval', status: 'waiting', data: { ...base, ...data } })
  let state = run(initialState, ev(decision({ delivery_status: 'PENDING' })))
  assert.equal(state.approval.decision?.delivery_status, 'PENDING')
  assert.notEqual(state.status, 'failed')
  // 이벤트(DELIVERED)가 API 응답(PENDING)보다 먼저 와도 PENDING으로 돌아가지 않는다.
  state = run(state, ev(decision({ delivery_status: 'DELIVERED', execution_status: 'RUNNING' })))
  state = reducer(state, { type: 'approvalDecision', data: { ...base, delivery_status: 'PENDING' } })
  assert.equal(state.approval.decision?.delivery_status, 'DELIVERED')
  // 전달 실패 → 다시 전달(시도 2)은 받아들인다. 전달 실패는 이전 실패가 아니다.
  state = reducer(initialState, { type: 'approvalDecision', data: { ...base, delivery_status: 'FAILED' } })
  assert.equal(state.status, 'idle')
  state = reducer(state, { type: 'approvalDecision', data: { ...base, delivery_attempts: 2, delivery_status: 'PENDING' } })
  assert.equal(state.approval.decision?.delivery_status, 'PENDING')
  assert.equal(reducer(state, { type: 'resetPhase', phase: 'awaiting_approval' }).approval.decision, null)
})
