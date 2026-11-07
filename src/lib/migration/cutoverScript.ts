/**
 * DB 전환 데모 대본 [가정]: 전환 계획(승인 2/2) → 전환 가능 시점 대기 → 단계 상태 → 결과(통과면 단계별 ms) → 테이블 검증 → 합계 → 인계.
 * 단계 순서는 백엔드 PoC(poc/cdc · poc/demo)의 fast switchover를 따른다:
 *  PAUSE 전에 시퀀스를 미리 올리고, PAUSE → marker 커밋 도착 → 정방향 구독 disable ∥ 역방향 구독 enable(동시) → 대상 select 1 → 대상 변경(RELOAD+RECONNECT) → RESUME.
 *  classic은 PAUSE 안에서 체크섬까지 비교한다.
 * 백엔드는 단계별 시간(steps_ms)과 write_pause_ms를 통과했을 때 끝에 한 번 알려 주고, 중단이면 stderr 글만 준다. 그래서 실행 중에는 단계 상태만 보낸다.
 * 시나리오(?cutover=…): fast(기본) · classic · kill(대상 DB가 죽어 거부, 사유 코드 없이 stderr만) ·
 *  tamper(fast: 전환은 되고 뒤의 검증이 불일치) · tamper-classic(PAUSE 안 체크섬이 막아 거부, 사유 코드 있음).
 * 거부된 시나리오는 첫 시도만 거부되고 다시 시도하면 통과한다.
 * 브라우저 MockProvider와 목업 SSE 서버(scripts/mock-sse-server.mjs)가 함께 쓰므로 런타임 import가 없다(타입만).
 */
import type { CutoverMethod, CutoverPlanData, CutoverStepPlan, DraftEvent, HandoverItem, Target } from './events'

export type CutoverScenario = 'fast' | 'classic' | 'kill' | 'tamper' | 'tamper-classic'
type Timed = { after: number; event: DraftEvent }
type Step = CutoverStepPlan & { result?: 'fail' | 'revert' }

/** 화면이 입자로 만들어지는 동안(2.4초)은 내용이 아직 안 보이므로, 그만큼 기다렸다가 시작한다. */
export const CUTOVER_START_MS = 2400
const READY_TICK_MS = 700
/** 단계 상태를 하나씩 보여 주는 간격(실제 전환은 몇 ms 안에 끝나지만 상태가 읽히도록) */
const STEP_TICK_MS = 260
/** 화면이 쓰기 중단 구간을 느리게 다시 보여 주는 동안(약 3.6초) 검증 결과를 미뤄 둔다. */
const AFTER_REPLAY_MS = 4200

/** fast: 시퀀스는 PAUSE 전에 미리 올리고, 구독 두 개는 동시에 바꾼다. */
const FAST_STEPS: Step[] = [
  { id: 'seq_raise', ms: 1.2, window: 'pre' },
  { id: 'pause', ms: 0.6, start_ms: 0, window: 'pause' },
  { id: 'marker', ms: 2.1, start_ms: 0.6, window: 'pause' },
  { id: 'sub_off', ms: 0.4, start_ms: 2.7, window: 'pause' },
  { id: 'reverse', ms: 0.7, start_ms: 2.7, window: 'pause' },
  { id: 'liveness', ms: 0.5, start_ms: 3.4, window: 'pause' },
  { id: 'retarget', ms: 0.8, start_ms: 3.9, window: 'pause' },
  { id: 'resume', ms: 0.3, start_ms: 4.7, window: 'pause' },
]
/** classic: PAUSE 안에서 체크섬까지 비교하고, 시퀀스도 PAUSE 안에서 맞춘다. */
const CLASSIC_STEPS: Step[] = [
  { id: 'pause', ms: 18, start_ms: 0, window: 'pause' },
  { id: 'marker', ms: 34, start_ms: 18, window: 'pause' },
  { id: 'checksum', ms: 290, start_ms: 52, window: 'pause' },
  { id: 'sub_off', ms: 60, start_ms: 342, window: 'pause' },
  { id: 'reverse', ms: 100, start_ms: 342, window: 'pause' },
  { id: 'seq', ms: 80, start_ms: 402, window: 'pause' },
  { id: 'liveness', ms: 12, start_ms: 482, window: 'pause' },
  { id: 'retarget', ms: 42, start_ms: 494, window: 'pause' },
  { id: 'resume', ms: 12, start_ms: 536, window: 'pause' },
]
/** kill-target: 대상 확인(select 1)이 응답 없이 끝나 원본으로 되돌리고 RESUME한다. */
const KILL_STEPS: Step[] = [
  FAST_STEPS[0], FAST_STEPS[1], FAST_STEPS[2], FAST_STEPS[3], FAST_STEPS[4],
  { id: 'liveness', ms: 0, result: 'fail', window: 'pause' },
  { id: 'revert', ms: 0, result: 'revert', window: 'pause' },
  { id: 'resume_source', ms: 0, result: 'revert', window: 'pause' },
]
/** tamper(classic): PAUSE 안 체크섬이 불일치를 찾아 전환하지 않고 원본으로 RESUME한다. */
const TAMPER_CLASSIC_STEPS: Step[] = [
  CLASSIC_STEPS[0], CLASSIC_STEPS[1],
  { id: 'checksum', ms: 0, result: 'fail', window: 'pause' },
  { id: 'resume_source', ms: 0, result: 'revert', window: 'pause' },
]

const isClassic = (scenario: CutoverScenario) => scenario === 'classic' || scenario === 'tamper-classic'
const methodOf = (scenario: CutoverScenario): CutoverMethod => (isClassic(scenario) ? 'classic' : 'fast')
/** 첫 시도가 거부되는 시나리오(다시 시도하면 통과) */
export const cutoverRefusesFirst = (scenario: CutoverScenario) => scenario === 'kill' || scenario === 'tamper-classic'
/** 단계들의 쓰기 중단 구간 길이(ms): PAUSE 안 단계 중 가장 늦게 끝나는 시각 */
export function pauseWindowMs(steps: CutoverStepPlan[]): number {
  let cursor = 0
  let end = 0
  for (const step of steps) {
    if (step.window === 'pre') continue
    const start = step.start_ms ?? cursor
    cursor = start + step.ms
    end = Math.max(end, cursor)
  }
  return Math.round(end * 10) / 10
}
const timing = (steps: Step[]): CutoverStepPlan[] => steps.map(({ id, ms, start_ms, window }) => ({ id, ms, ...(start_ms === undefined ? {} : { start_ms }), ...(window ? { window } : {}) }))

/** 두 번째 승인 화면이 읽는 전환 계획. gate2·인계는 백엔드 코드에 아직 없어 제안안이다. */
export function cutoverPlan(target: Target, scenario: CutoverScenario): CutoverPlanData {
  const method = methodOf(scenario)
  return {
    method,
    expected_pause_ms: method === 'fast' ? { min: 4, max: 8 } : { min: 540, max: 640 },
    rehearsal: { source: 'poc/demo', runs: 12, methods: [{ method: 'fast', pause_ms: 6 }, { method: 'classic', pause_ms: 600 }] },
    preconditions: [
      { id: 'gate2', state: 'pass', value: '0:100', evidence: 'env-a:env-b 0:100 · failed 0 · p99 1.08× · env-a STOPPED', proposal: true },
      { id: 'lag', state: 'pass', value: '0 B · 14 ms', evidence: 'source 0/3AF47DE = replay 0/3AF47DE' },
      { id: 'long_tx', state: 'pass', value: '0.04 s · 0', evidence: 'longest_tx ≤ 1 s · lock_waits = 0' },
      { id: 'reverse_sub', state: 'pass', value: 'disabled', evidence: 'sub_reverse pg-b → pg-a · created, enabled at switch' },
    ],
    steps: timing(method === 'fast' ? FAST_STEPS : CLASSIC_STEPS),
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
  tamper: [[300, 0, 128], [40, 0, 128]],
  'tamper-classic': [[300, 0, 128], [40, 0, 128]],
}

/** 승인(approveCutover) 시점부터의 대본. attempt는 몇 번째 시도인지(1부터). */
export function cutoverRun(scenario: CutoverScenario, attempt: number, tables: Array<[string, number]>): Timed[] {
  const effective: CutoverScenario = cutoverRefusesFirst(scenario) && attempt > 1 ? (isClassic(scenario) ? 'classic' : 'fast') : scenario
  const method = methodOf(effective)
  const refused = effective === 'kill' || effective === 'tamper-classic'
  const tampered = effective === 'tamper'
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
  const stepsAt = CUTOVER_START_MS + (samples.length - 1) * READY_TICK_MS + 300

  // 2) 단계 상태만(시간은 끝에 결과로). 같은 시각에 시작하는 단계(동시 실행)는 함께 끝난다.
  const steps = refused ? (effective === 'kill' ? KILL_STEPS : TAMPER_CLASSIC_STEPS) : method === 'fast' ? FAST_STEPS : CLASSIC_STEPS
  let tick = 0
  steps.forEach((step, index) => {
    const parallel = index > 0 && step.start_ms !== undefined && step.start_ms === steps[index - 1].start_ms
    if (!parallel && index > 0) tick++
    push(stepsAt + tick * STEP_TICK_MS, {
      type: 'cutover.step', phase, status: 'running', progress: Math.round(((index + 1) / steps.length) * 100),
      data: { n: index + 1, state: 'done', id: step.id, method, of: steps.length, result: step.result ?? 'ok', ...(step.window ? { window: step.window } : {}) },
    })
  })
  const outcomeAt = stepsAt + (tick + 1) * STEP_TICK_MS
  push(outcomeAt, {
    type: 'cutover.outcome', phase, status: refused ? 'waiting' : 'running',
    data: refused
      ? effective === 'kill'
        // 사유 코드 없이 stderr 글만 온다.
        ? { result: 'refused', message: 'target liveness: select 1 timed out after 2000 ms — reverted to source, RESUME', active: 'source', pause_ms: null, replication: { direction: 'forward', lag_ms: null } }
        : { result: 'refused', reason: 'CHECKSUM_MISMATCH', message: 'checksum mismatch on orders (in PAUSE) — switch refused, RESUME on source', active: 'source', pause_ms: null, replication: { direction: 'forward', lag_ms: null } }
      : { result: 'switched', active: 'target', pause_ms: pauseWindowMs(steps), steps: timing(steps), held_requests: method === 'fast' ? 1 : 70, failed_requests: 0, replication: { direction: 'reverse', lag_ms: method === 'fast' ? 11 : 13 } },
  })

  // 3) 검증: RESUME 뒤 전환 순간 스냅샷과 테이블별 행 수·체크섬 비교(거부면 비교하지 않는다).
  //    tamper(fast)는 PAUSE 안에서 체크섬을 보지 않으므로 전환은 되고, 여기서 불일치가 드러난다.
  const verifyAt = outcomeAt + (refused ? 600 : AFTER_REPLAY_MS)
  push(verifyAt, { type: 'cutover.step', phase, status: 'running', data: { n: steps.length, state: 'verify', of: steps.length } })
  tables.forEach(([table, rows], index) => {
    const sourceRows = rows + (table === 'mig.marker' ? 0 : Math.round(rows * 0.02))
    const bad = tampered && table === 'orders'
    push(verifyAt + 200 + index * 260, {
      type: 'cutover.verify', phase, status: 'running',
      data: refused ? { table, source_rows: sourceRows, target_rows: null, checksum: 'skipped' } : { table, source_rows: sourceRows, target_rows: bad ? sourceRows - 3 : sourceRows, checksum: bad ? 'mismatch' : 'match' },
    })
  })
  const totalsAt = verifyAt + 200 + tables.length * 260 + 200
  const results = [
    { id: 'orders_lost', value: tampered ? '3' : '0', ok: !tampered }, { id: 'msg_lost', value: '0', ok: true }, { id: 'msg_dup', value: '0', ok: true },
    { id: 'fail', value: '0', ok: true }, { id: 'latency_max', value: refused ? '12 ms' : method === 'fast' ? '9 ms' : '612 ms', ok: true },
  ]
  const stopped = refused || tampered
  results.forEach((result, index) => {
    const last = index === results.length - 1
    // 전환 뒤에는 트래픽 전환이 남았으므로 이전 전체를 끝내지 않는다(done을 보내지 않는다).
    push(totalsAt + index * 220, { type: 'cutover.result', phase, status: last && stopped ? 'waiting' : 'running', data: result })
  })

  // 4) 인계: 통과일 때만 진행하고, 거부·불일치면 보류한다.
  const handoverAt = totalsAt + results.length * 220 + 400
  const HANDOVER: HandoverItem[] = ['dns', 'origin', 'access']
  HANDOVER.forEach((item, index) => {
    if (stopped) { push(handoverAt, { type: 'cutover.handover', phase, status: 'waiting', data: { item, state: 'held' } }); return }
    push(handoverAt + index * 700, { type: 'cutover.handover', phase, status: 'running', data: { item, state: 'running' } })
    push(handoverAt + index * 700 + 600, { type: 'cutover.handover', phase, status: 'done', data: { item, state: 'done' } })
  })
  // 5) 거부돼 원본으로 되돌렸으면 백엔드처럼 DB 전환 승인을 다시 요청한다(승인 버튼이 다시 열린다).
  if (refused) push(handoverAt + 800, { type: 'approval.required', phase, status: 'waiting', data: { excluded: [], rollback_policy: 'reverse_replication', gate: 'cutover' } })
  return items
}
