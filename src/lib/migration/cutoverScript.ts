/**
 * DB 전환 데모 대본 [가정]: 전환 계획(승인 2/2) → 전환 가능 시점 대기 → 쓰기 중단 구간 단계 → 결과 → 테이블 검증 → 합계 → 인계.
 * 값은 소울님 리허설(poc/cdc · poc/demo)의 측정에 맞춘 데모 값이다(fast 4–8 ms, classic ≈600 ms, batch 잠금 4.6 s 대기).
 * 브라우저 MockProvider와 목업 SSE 서버(scripts/mock-sse-server.mjs)가 함께 쓰므로 런타임 import가 없다(타입만).
 * 시나리오(?cutover=…): fast(기본) 빠른 전환 통과 · classic PAUSE 안 체크섬 통과 · kill 전환 중 대상 DB가 죽어 거부 → 원본으로 RESUME.
 * kill은 첫 시도만 거부되고, 다시 시도(attempt 2)는 fast로 통과한다.
 */
import type { CutoverMethod, CutoverPlanData, CutoverStepPlan, DraftEvent, HandoverItem, Target } from './events'

export type CutoverScenario = 'fast' | 'classic' | 'kill'
type Timed = { after: number; event: DraftEvent }

/** 화면이 입자로 만들어지는 동안(2.4초)은 내용이 아직 안 보이므로, 그만큼 기다렸다가 시작한다. */
export const CUTOVER_START_MS = 2400
const READY_TICK_MS = 700
const STEP_TICK_MS = 50
/** 화면이 쓰기 중단 구간을 느리게 다시 보여 주는 동안(약 3.6초) 검증 결과를 미뤄 둔다. */
const AFTER_REPLAY_MS = 4200

const FAST_STEPS: CutoverStepPlan[] = [
  { id: 'pause', ms: 0.6 }, { id: 'marker', ms: 2.1 }, { id: 'sub_off', ms: 0.4 }, { id: 'seq', ms: 0.9 },
  { id: 'reverse', ms: 0.7 }, { id: 'liveness', ms: 0.5 }, { id: 'retarget', ms: 0.8 }, { id: 'resume', ms: 0.3 },
]
const CLASSIC_STEPS: CutoverStepPlan[] = [
  { id: 'pause', ms: 18 }, { id: 'marker', ms: 34 }, { id: 'checksum', ms: 290 }, { id: 'subseq', ms: 190 },
  { id: 'liveness', ms: 12 }, { id: 'retarget', ms: 48 },
]
/** kill-target: 대상 확인(select 1)이 응답 없이 끝나 원본으로 되돌리고 RESUME한다. */
const KILL_STEPS: Array<CutoverStepPlan & { result?: 'fail' | 'revert' }> = [
  { id: 'pause', ms: 0.6 }, { id: 'marker', ms: 2.0 }, { id: 'sub_off', ms: 0.4 }, { id: 'seq', ms: 0.9 },
  { id: 'reverse', ms: 0.7 }, { id: 'liveness', ms: 3.0, result: 'fail' }, { id: 'revert', ms: 1.1, result: 'revert' }, { id: 'resume_source', ms: 0.3, result: 'revert' },
]

const methodOf = (scenario: CutoverScenario): CutoverMethod => (scenario === 'classic' ? 'classic' : 'fast')

/** 두 번째 승인 화면이 읽는 전환 계획. */
export function cutoverPlan(target: Target, scenario: CutoverScenario): CutoverPlanData {
  const method = methodOf(scenario)
  return {
    method,
    expected_pause_ms: method === 'fast' ? { min: 4, max: 8 } : { min: 540, max: 640 },
    rehearsal: { source: 'poc/demo', runs: 12, methods: [{ method: 'fast', pause_ms: 6 }, { method: 'classic', pause_ms: 600 }] },
    preconditions: [
      { id: 'gate2', state: 'pass', value: '0:100', evidence: 'env-a:env-b 0:100 · failed 0 · p99 1.08× · env-a STOPPED' },
      { id: 'lag', state: 'pass', value: '0 B · 14 ms', evidence: 'source 0/3AF47DE = replay 0/3AF47DE' },
      { id: 'long_tx', state: 'pass', value: '0.04 s · 0', evidence: 'longest_tx ≤ 1 s · lock_waits = 0' },
      { id: 'reverse_sub', state: 'pass', value: 'disabled', evidence: 'sub_reverse pg-b → pg-a · created, enabled at switch' },
    ],
    steps: method === 'fast' ? FAST_STEPS : CLASSIC_STEPS,
    rollback: { standby_hours: 72 },
    topology: {
      app: 'env-b', pooler: 'PgBouncer', source_db: 'pg-a', target_db: 'pg-b',
      source_where: 'AWS RDS', target_where: target === 'onprem' ? 'K3s' : 'Cloud SQL', writes_per_sec: 128,
    },
    handover: [
      { item: 'dns', detail: 'app.example.com → env-b · TTL 60 s' },
      { item: 'origin', detail: 'pg-a 72 h · sub_reverse' },
      { item: 'access', detail: 'DB role · secret → ' + (target === 'onprem' ? 'K3s' : 'GKE') + ' · DNS kept' },
    ],
  }
}

/** 전환 가능 시점 표본: [가장 긴 트랜잭션 ms, 잠금 대기, 초당 커밋]. 마지막이 전환 가능(ready). */
const READY_SAMPLES: Record<CutoverScenario, Array<[number, number, number]>> = {
  fast: [[4600, 1, 128], [2100, 1, 131], [600, 0, 127], [40, 0, 128]],
  classic: [[4600, 1, 128], [900, 0, 126], [40, 0, 128]],
  kill: [[300, 0, 128], [40, 0, 128]],
}

const DONE_RESULTS = (maxLatency: string) => [
  { id: 'orders_lost', value: '0' }, { id: 'msg_lost', value: '0' }, { id: 'msg_dup', value: '0' },
  { id: 'fail', value: '0' }, { id: 'latency_max', value: maxLatency },
]

/** 승인(approveCutover) 시점부터의 대본. attempt는 몇 번째 시도인지(1부터). */
export function cutoverRun(scenario: CutoverScenario, attempt: number, tables: Array<[string, number]>): Timed[] {
  const effective: CutoverScenario = scenario === 'kill' && attempt > 1 ? 'fast' : scenario
  const method = methodOf(effective)
  const refused = effective === 'kill'
  const items: Timed[] = []
  const phase = 'verification' as const
  const push = (after: number, event: DraftEvent) => items.push({ after, event })

  // 1) 전환 가능 시점 대기
  const samples = READY_SAMPLES[effective]
  samples.forEach(([longest, locks, commits], index) => {
    const ready = index === samples.length - 1
    push(CUTOVER_START_MS + index * READY_TICK_MS, {
      type: 'cutover.ready', phase, status: 'running',
      data: { attempt, longest_tx_ms: longest, lock_waits: locks, commits_per_sec: commits, ready, limits: { longest_tx_ms: 1000, lock_waits: 0 }, ...(locks > 0 ? { waiting_on: 'batch lock' } : {}), waited_ms: index * READY_TICK_MS },
    })
  })
  const pauseAt = CUTOVER_START_MS + (samples.length - 1) * READY_TICK_MS + 300

  // 2) 쓰기 중단 구간: 단계마다 걸린 시간(ms)
  const steps: Array<CutoverStepPlan & { result?: 'fail' | 'revert' }> = refused ? KILL_STEPS : method === 'fast' ? FAST_STEPS : CLASSIC_STEPS
  steps.forEach((step, index) => {
    push(pauseAt + index * STEP_TICK_MS, {
      type: 'cutover.step', phase, status: 'running', progress: Math.round(((index + 1) / steps.length) * 100),
      data: { n: index + 1, state: 'done', id: step.id, ms: step.ms, method, of: steps.length, result: step.result ?? 'ok' },
    })
  })
  const pauseMs = Math.round(steps.reduce((sum, step) => sum + step.ms, 0) * 10) / 10
  const outcomeAt = pauseAt + steps.length * STEP_TICK_MS + 50
  push(outcomeAt, {
    type: 'cutover.outcome', phase, status: refused ? 'waiting' : 'running',
    data: refused
      ? { result: 'refused', reason: 'TARGET_LIVENESS_FAILED', active: 'source', pause_ms: pauseMs, held_requests: 2, failed_requests: 0, replication: { direction: 'forward', lag_ms: null } }
      : { result: 'switched', active: 'target', pause_ms: pauseMs, held_requests: method === 'fast' ? 1 : 76, failed_requests: 0, replication: { direction: 'reverse', lag_ms: method === 'fast' ? 11 : 13 } },
  })

  // 3) 검증: 전환 순간 스냅샷과 테이블별 행 수·체크섬 비교(거부면 비교하지 않는다)
  const verifyAt = outcomeAt + AFTER_REPLAY_MS
  push(verifyAt, { type: 'cutover.step', phase, status: 'running', data: { n: steps.length, state: 'verify', of: steps.length } })
  tables.forEach(([table, rows], index) => {
    const sourceRows = rows + (table === 'mig.marker' ? 0 : Math.round(rows * 0.02))
    push(verifyAt + 200 + index * 260, {
      type: 'cutover.verify', phase, status: 'running',
      data: refused ? { table, source_rows: sourceRows, target_rows: null, checksum: 'skipped' } : { table, source_rows: sourceRows, target_rows: sourceRows, checksum: 'match' },
    })
  })
  const totalsAt = verifyAt + 200 + tables.length * 260 + 200
  const results = refused
    ? [{ id: 'orders_lost', value: '0' }, { id: 'msg_lost', value: '0' }, { id: 'msg_dup', value: '0' }, { id: 'fail', value: '0' }, { id: 'latency_max', value: '12 ms' }]
    : DONE_RESULTS(method === 'fast' ? '9 ms' : '612 ms')
  results.forEach((result, index) => {
    const last = index === results.length - 1
    push(totalsAt + index * 220, { type: 'cutover.result', phase, status: last ? (refused ? 'waiting' : 'done') : 'running', data: { ...result, ok: true } })
  })

  // 4) 인계(통과일 때만 진행, 거부면 보류)
  const handoverAt = totalsAt + results.length * 220 + 400
  const HANDOVER: HandoverItem[] = ['dns', 'origin', 'access']
  HANDOVER.forEach((item, index) => {
    if (refused) { push(handoverAt, { type: 'cutover.handover', phase, status: 'waiting', data: { item, state: 'held' } }); return }
    push(handoverAt + index * 700, { type: 'cutover.handover', phase, status: 'running', data: { item, state: 'running' } })
    push(handoverAt + index * 700 + 600, { type: 'cutover.handover', phase, status: 'done', data: { item, state: 'done' } })
  })
  return items
}
