/**
 * 트래픽 이전 화면이 읽는 값을 이벤트(traffic.prepare · traffic.snapshot)에서 고르는 순수 함수들.
 * 화면은 여기서 고른 상태 이름만 보고 문구는 i18n 키로 찾는다. 런타임 import 없음(단위 테스트가 Node에서 그대로 읽는다).
 */
import type { TrafficNoteKey, TrafficPrepareData, TrafficSnapshotData, TrafficStepResult } from './events'

/** 기록 key별 기본 Activity 이름(서버가 activity를 보내지 않을 때). 백엔드 Temporal Activity 이름을 따른다. */
export const DEFAULT_ACTIVITY: Partial<Record<TrafficNoteKey | 'prepareFail' | 'alert' | 'recovered', string>> = {
  prepare: 'traffic_prepare',
  prepareFail: 'traffic_prepare',
  apply: 'traffic_set_weight',
  observe: 'traffic_observe',
  gatePass: 'gate',
  gateFail: 'gate',
  reached: 'gate',
  rollback: 'traffic_rollback',
  manual: 'traffic_rollback',
  finalized: 'traffic_stabilize',
  dbRollback: 'traffic_rollback',
}

/** 정책 기본값(서버가 snapshot의 gate나 prepare.policy에 실어 보내면 그 값을 쓴다). */
export const DEFAULT_POLICY = { steps: [10, 50, 100], observe_seconds: 4, max_failed_requests: 0, max_p99_ratio: 1.5 } as const

export type Policy = { steps: number[]; observeSeconds: number; maxFailed: number; maxP99Ratio: number }

/** 스냅샷 → 사전 확인 정책 → 기본값 순서로 고른다. */
export function policyOf(snapshot: TrafficSnapshotData | null, prepare: TrafficPrepareData | null): Policy {
  const fromPrepare = prepare?.policy
  return {
    steps: snapshot?.steps?.length ? snapshot.steps : fromPrepare?.steps?.length ? fromPrepare.steps : [...DEFAULT_POLICY.steps],
    observeSeconds: snapshot?.gate.observe_seconds ?? fromPrepare?.observe_seconds ?? DEFAULT_POLICY.observe_seconds,
    maxFailed: snapshot?.gate.max_failed_requests ?? fromPrepare?.max_failed_requests ?? DEFAULT_POLICY.max_failed_requests,
    maxP99Ratio: snapshot?.gate.max_p99_ratio ?? fromPrepare?.max_p99_ratio ?? DEFAULT_POLICY.max_p99_ratio,
  }
}

/** 화면 전체의 국면: 사전 확인 → 적용 → 관찰 → 판정 → (안정화 구간) → 완료(정리 중·정리 끝) / 롤백 / 실행 안 함 */
export type Stage = 'prepare' | 'blocked' | 'applying' | 'observing' | 'gate' | 'stabilizing' | 'complete' | 'drained' | 'rolledback'

export function stageOf(snapshot: TrafficSnapshotData | null, prepare: TrafficPrepareData | null): Stage {
  if (!snapshot) return prepare?.state === 'failed' ? 'blocked' : 'prepare'
  if (snapshot.phase === 'complete') return snapshot.residual.requests_per_sec === 0 && snapshot.residual.streams === 0 ? 'drained' : 'complete'
  return snapshot.phase
}

/** 단계 카드 하나의 판정 칩: 대기 · 가중치 적용 · 관찰 중 · 판정 · 통과 · 롤백 */
export type CardState = 'wait' | 'applying' | 'observing' | 'gate' | 'pass' | 'rollback'
export type StepCard = {
  step: number
  state: CardState
  /** 이 카드에 보일 실패 요청·p99 비율(대기 중이면 null) */
  failed: number | null
  p99Ratio: number | null
  /** 관찰 창 진행(0~1). 관찰 중일 때만 0보다 크다. */
  observe: number
}

function stepIndexIn(steps: number[], step: number | undefined) {
  if (step === undefined) return 0
  const exact = steps.indexOf(step)
  if (exact >= 0) return exact
  let index = 0
  steps.forEach((value, i) => { if (value <= step) index = i })
  return index
}

export function stepCards(snapshot: TrafficSnapshotData | null, policy: Policy): StepCard[] {
  const results = new Map<number, TrafficStepResult>()
  for (const result of snapshot?.results ?? []) results.set(result.step, result)
  const current = stepIndexIn(policy.steps, snapshot?.step)
  const phase = snapshot?.phase
  return policy.steps.map((step, index) => {
    const result = results.get(step)
    if (result) return { step, state: result.verdict === 'pass' ? 'pass' : 'rollback', failed: result.failed_requests, p99Ratio: result.p99_ratio, observe: 0 }
    if (!snapshot || phase === 'rolledback') return { step, state: 'wait', failed: null, p99Ratio: null, observe: 0 }
    // 결과 기록이 없는 서버: 지나간 단계와 완료는 통과로 본다.
    if (phase === 'complete' || phase === 'stabilizing' || index < current) return { step, state: 'pass', failed: null, p99Ratio: null, observe: 0 }
    if (index > current) return { step, state: 'wait', failed: null, p99Ratio: null, observe: 0 }
    const observing = phase === 'observing' || phase === 'gate'
    const left = snapshot.gate.observe_left_seconds
    const observe = phase === 'gate' ? 1 : phase === 'observing' && policy.observeSeconds > 0 ? Math.min(1, Math.max(0, 1 - left / policy.observeSeconds)) : 0
    return {
      step,
      state: phase === 'applying' ? 'applying' : phase === 'observing' ? 'observing' : 'gate',
      failed: observing ? snapshot.gate.failed_requests : null,
      p99Ratio: observing ? snapshot.gate.p99_ratio : null,
      observe,
    }
  })
}

/** 게이트 패널의 판정 안내: 어떤 문구(키 꼬리)를 어떤 색으로 보일지. step: 문구에 넣을 단계(%) */
export type Verdict = { key: 'prepare' | 'blocked' | 'applying' | 'observing' | 'gate' | 'advance' | 'rollback' | 'manual' | 'done' | 'drained' | 'stabilizing' | 'stabilizingAlert'; tone: 'neutral' | 'pass' | 'fail'; step?: number }

/** manual: 마지막 롤백이 사람이 누른 롤백인지(기록 key가 manual). alert: 안정화 구간에서 대상이 기준을 넘은 상태인지 */
export function verdictOf(stage: Stage, cards: StepCard[], manual: boolean, alert = false): Verdict {
  const active = cards.find(card => card.state === 'applying' || card.state === 'observing' || card.state === 'gate')
  const passed = cards.filter(card => card.state === 'pass')
  switch (stage) {
    case 'prepare': return { key: 'prepare', tone: 'neutral' }
    case 'blocked': return { key: 'blocked', tone: 'fail' }
    case 'rolledback': return { key: manual ? 'manual' : 'rollback', tone: 'fail', step: cards.find(card => card.state === 'rollback')?.step }
    case 'stabilizing': return alert ? { key: 'stabilizingAlert', tone: 'fail' } : { key: 'stabilizing', tone: 'neutral' }
    case 'complete': return { key: 'done', tone: 'pass', step: cards[cards.length - 1]?.step }
    case 'drained': return { key: 'drained', tone: 'pass', step: cards[cards.length - 1]?.step }
    // 앞 단계를 통과하고 다음 가중치를 적용하는 중이면 "통과 → 다음 단계"로 보인다.
    case 'applying': return passed.length > 0 ? { key: 'advance', tone: 'pass', step: passed[passed.length - 1].step } : { key: 'applying', tone: 'neutral', step: active?.step }
    case 'observing': return { key: 'observing', tone: 'neutral', step: active?.step }
    case 'gate': return { key: 'gate', tone: 'neutral', step: active?.step }
  }
}

/**
 * 안정화 구간에서 대상이 기준을 넘었는가. traffic.alert(breach)가 왔거나, 마지막 스냅샷 판정에 넘은 항목이 있으면 참.
 * 판정하지 않은 창(요청이 적음)은 넘지 않은 것으로 본다(꾸미지 않는다).
 */
export function breachOf(snapshot: TrafficSnapshotData | null, alert: { state: string } | null): boolean {
  if (snapshot?.phase !== 'stabilizing') return false
  if (alert?.state === 'breach') return true
  return Boolean(snapshot.health?.judged && snapshot.health.breach.length > 0)
}
