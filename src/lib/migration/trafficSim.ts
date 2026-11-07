/**
 * 트래픽 이전 단계의 데모 시뮬레이터. 10% → 50% → 100% 가중치를 적용하고, 관찰 창의 지표가 게이트 기준을 넘으면 롤백한다.
 * 화면에 있던 단계 기계를 그대로 옮긴 것이며, 브라우저의 MockProvider와 목업 SSE 서버가 함께 쓴다.
 * 바뀔 때마다 traffic.snapshot의 data 모양으로 상태를 내보낸다. 런타임 import 없음(Node가 그대로 읽는다).
 */
import type { TrafficAlertData, TrafficHealthJudgement, TrafficNote, TrafficPhase, TrafficSnapshotData, TrafficStepResult } from './events'

export const TRAFFIC_STEPS = [10, 50, 100] as const
/** 지금 단계의 위치. 목록에 없는 값이면 그 값을 넘지 않는 가장 큰 단계로 본다. */
export function stepIndexOf(steps: readonly number[], step: number | undefined): number {
  if (step === undefined) return 0
  const exact = steps.indexOf(step)
  if (exact >= 0) return exact
  let index = 0
  steps.forEach((value, i) => { if (value <= step) index = i })
  return index
}

/** 관찰 창 길이(초)와 게이트 기준 */
export const OBSERVE_SECONDS = 4
const MAX_FAILED = 0
const MAX_P99_RATIO = 1.5
/** 관찰 창에서 지표를 갱신하는 간격(초) */
const OBSERVE_TICK = 0.5
/** [가정] 데모 지표: 전체 요청량과 원본의 p99(ms). 대상 p99는 원본 × p99 비율이다. */
const DEMO_RPS = 127
const DEMO_ORIGIN_P99_MS = 41
/** 안정화 구간(플랫폼 stability.py와 같은 기준): 대상 오류율 5% 초과 또는 p99가 원본 × MAX_P99_RATIO 초과면 알린다. */
const ALERT_ERROR_RATE = 0.05
const STABILIZE_TICK = 1

export type TrafficSimOptions = {
  /** 100% 뒤 안정화 구간 길이(초). 0이면 예전처럼 바로 완료다. */
  stabilizeSeconds?: number
  /** 켜면 10%·50% 단계가 판정을 통과해도 자동으로 넘어가지 않고 advance()를 기다린다(?manual=1). */
  manualSteps?: boolean
  /** 안정화 구간에서 기준을 넘기 시작하거나 회복할 때 한 번씩 부른다(traffic.alert). */
  emitAlert?: (data: TrafficAlertData) => void
}

export class TrafficSim {
  private emitSnapshot: (data: TrafficSnapshotData) => void
  private timers: Array<ReturnType<typeof setTimeout>> = []
  private intervals: Array<ReturnType<typeof setInterval>> = []
  private stepIndex = 0
  private phase: TrafficPhase = 'applying'
  private weightNew = 0
  private observeLeft = 0
  private failed = 0
  private p99 = 1
  private residual = { requests: 0, streams: 0 }
  private injected = false
  private decision: TrafficSnapshotData['decision']
  private running = false
  private results: TrafficStepResult[] = []
  private stabilizeLeft = 0
  private health: TrafficHealthJudgement | null = null
  private breached = false
  /** 사람의 "다음 단계로"를 기다리는 중(manual_steps) */
  private awaiting = false
  private options: TrafficSimOptions

  /** 전환 단계(대상 비율 %). 서버가 정한 단계(예: [50, 100])를 줄 수 있고, 없으면 10 · 50 · 100이다. */
  private steps: number[]

  /** 시계 배속(시험용). 1이면 실제 시간 그대로다. 화면에 보이는 관찰 시간 값은 바꾸지 않는다. */
  private speed = 1

  constructor(emit: (data: TrafficSnapshotData) => void, steps: readonly number[] = TRAFFIC_STEPS, speed = 1, options: TrafficSimOptions = {}) {
    this.options = options
    this.speed = speed >= 1 ? speed : 1
    this.emitSnapshot = emit
    this.steps = steps.length > 0 ? [...steps] : [...TRAFFIC_STEPS]
  }

  /** 처음부터 시작한다. */
  start() {
    this.stop()
    this.running = true
    this.reset()
    this.emit()
    this.beginApplying()
  }

  /** 멈춘다(화면을 떠나거나 서버가 끝날 때). */
  stop() {
    this.running = false
    this.timers.forEach(timer => clearTimeout(timer))
    this.intervals.forEach(timer => clearInterval(timer))
    this.timers = []
    this.intervals = []
  }

  /** 수동 롤백: 가중치를 0으로 되돌린다. 이미 롤백된 상태에서는 아무 일도 하지 않는다. */
  rollback() {
    if (!this.running || this.phase === 'rolledback') return
    const stabilizing = this.phase === 'stabilizing'
    this.awaiting = false
    this.clearTimers()
    this.injected = false
    this.weightNew = 0
    this.phase = 'rolledback'
    this.decision = 'rollback'
    this.health = null
    this.emit([{ key: 'manual', activity: 'traffic_rollback', params: { origin: 100, target: 0 } }])
    // 안정화 구간(DB 전환 뒤)에서 되돌리면 DB 쓰기 주체도 원본으로 되돌린다(플랫폼: data 워크플로에 rollback Signal).
    if (stabilizing) this.after(1500, () => this.emit([{ key: 'dbRollback', activity: 'traffic_rollback' }]))
  }

  /** 사람이 "다음 단계로"를 누름: 대기 중일 때만 다음 단계의 가중치 적용을 시작한다. */
  advance() {
    if (!this.running || !this.awaiting) return
    this.awaiting = false
    this.stepIndex += 1
    this.phase = 'applying'
    this.emit()
    this.beginApplying()
  }

  /** 안정화 구간을 끝내고 확정한다(사람이 누름). */
  finalize() {
    if (!this.running || this.phase !== 'stabilizing') return
    this.clearTimers()
    this.complete([{ key: 'finalized', activity: 'traffic_stabilize' }])
  }

  /** 데모 전용: 새 환경에서 오류가 나게 한다(관찰 창 안의 지표가 기준을 넘어 롤백된다). */
  inject() {
    if (this.awaiting) return
    if (!this.running || (this.phase !== 'observing' && this.phase !== 'applying' && this.phase !== 'stabilizing')) return
    this.injected = true
    this.emit([{ key: 'inject' }])
  }

  /** 데모 전용: 넣은 장애를 끈다(안정화 구간에서 회복을 보이려고). */
  clearFault() {
    this.injected = false
  }

  /** 롤백된 뒤 처음부터 다시 시도한다. */
  retry() {
    if (!this.running || this.phase !== 'rolledback') return
    this.clearTimers()
    this.reset()
    this.emit([{ key: 'restart' }])
    this.beginApplying()
  }

  private reset() {
    this.injected = false
    this.stepIndex = 0
    this.weightNew = 0
    this.failed = 0
    this.p99 = 1
    this.observeLeft = 0
    this.residual = { requests: 0, streams: 0 }
    this.phase = 'applying'
    this.decision = undefined
    this.results = []
    this.stabilizeLeft = 0
    this.health = null
    this.breached = false
    this.awaiting = false
  }

  private clearTimers() {
    this.timers.forEach(timer => clearTimeout(timer))
    this.intervals.forEach(timer => clearInterval(timer))
    this.timers = []
    this.intervals = []
  }

  private after(ms: number, run: () => void) {
    this.timers.push(setTimeout(run, ms / this.speed))
  }

  private emit(notes?: TrafficNote[]) {
    const percent = this.steps[this.stepIndex]
    const data: TrafficSnapshotData = {
      phase: this.phase,
      weights: { origin: 100 - this.weightNew, target: this.weightNew },
      step: percent,
      steps: [...this.steps],
      gate: {
        failed_requests: this.failed,
        max_failed_requests: MAX_FAILED,
        p99_ratio: this.p99,
        max_p99_ratio: MAX_P99_RATIO,
        observe_left_seconds: this.observeLeft,
        observe_seconds: OBSERVE_SECONDS,
      },
      residual: { requests_per_sec: this.residual.requests, streams: this.residual.streams },
      backends: this.backends(),
      results: this.results.map(result => ({ ...result })),
      replication: { lag_ms: Math.round(10 + Math.abs(Math.sin(Date.now() / 900)) * 8) },
    }
    if (this.decision) data.decision = this.decision
    if (notes && notes.length > 0) data.notes = notes
    if (this.phase === 'stabilizing' && this.health) {
      data.health = { ...this.health, breach: this.health.breach.map(item => ({ ...item })) }
      data.stabilize_left_seconds = this.stabilizeLeft
    }
    this.decision = undefined
    this.emitSnapshot(data)
  }

  /** 백엔드별 지표: 요청량은 가중치대로 나뉘고, 대상의 p99는 원본 × 비율, 실패는 대상에서만 난다(데모). */
  private backends(): NonNullable<TrafficSnapshotData['backends']> {
    const wobble = Math.round(Math.sin(Date.now() / 1300) * 2)
    const originP99 = DEMO_ORIGIN_P99_MS + wobble
    const observing = this.phase === 'observing' || this.phase === 'gate'
    return {
      origin: { requests_per_sec: Math.round(DEMO_RPS * (100 - this.weightNew) / 100), p99_ms: originP99, failed_requests: 0 },
      target: {
        requests_per_sec: Math.round(DEMO_RPS * this.weightNew / 100),
        p99_ms: this.weightNew > 0 ? Math.round(originP99 * (observing ? this.p99 : 1.04)) : 0,
        failed_requests: this.failed,
      },
    }
  }

  // 1. 가중치 적용
  private beginApplying() {
    const percent = this.steps[this.stepIndex]
    this.after(250, () => {
      this.weightNew = percent
      this.emit([{ key: 'apply', activity: 'traffic_set_weight', params: { pct: percent, old: 100 - percent, new: percent } }])
    })
    this.after(1300, () => {
      this.failed = 0
      this.p99 = 1
      this.observeLeft = OBSERVE_SECONDS
      this.phase = 'observing'
      this.emit([{ key: 'observe', activity: 'traffic_observe', params: { pct: percent, sec: OBSERVE_SECONDS } }])
      this.observe()
    })
  }

  // 2. 관찰 창: 0.5초마다 지표 갱신, 실패 요청이 생기면 곧바로 게이트로
  private observe() {
    const timer = setInterval(() => {
      if (this.injected) {
        this.failed += 2
        this.p99 = Number(Math.min(2.4, this.p99 + 0.3).toFixed(2))
      } else {
        this.failed = 0
        this.p99 = Number((1.03 + Math.abs(Math.sin(Date.now() / 700)) * 0.12).toFixed(2))
      }
      this.observeLeft = Math.max(0, this.observeLeft - OBSERVE_TICK)
      if (this.failed > MAX_FAILED || this.observeLeft <= 0) {
        clearInterval(timer)
        this.phase = 'gate'
        this.emit()
        this.after(700, () => this.judge())
      } else {
        this.emit()
      }
    }, OBSERVE_TICK * 1000 / this.speed)
    this.intervals.push(timer)
  }

  // 3. 게이트 판정
  private judge() {
    const percent = this.steps[this.stepIndex]
    const observed = OBSERVE_SECONDS - this.observeLeft
    if (this.failed > MAX_FAILED || this.p99 > MAX_P99_RATIO) {
      this.results.push({ step: percent, verdict: 'rollback', failed_requests: this.failed, p99_ratio: this.p99, observed_seconds: observed })
      const failed = this.failed
      const ratio = this.p99
      this.injected = false
      this.weightNew = 0
      this.phase = 'rolledback'
      this.decision = 'rollback'
      this.emit([
        { key: 'gateFail', activity: 'gate', params: { pct: percent, failed, ratio: ratio.toFixed(2), maxFailed: MAX_FAILED, maxRatio: MAX_P99_RATIO } },
        { key: 'rollback', activity: 'traffic_rollback', params: { origin: 100, target: 0 } },
      ])
      return
    }
    this.results.push({ step: percent, verdict: 'pass', failed_requests: this.failed, p99_ratio: this.p99, observed_seconds: observed })
    const pass: TrafficNote = { key: 'gatePass', activity: 'gate', params: { pct: percent, failed: this.failed, ratio: this.p99.toFixed(2) } }
    if (this.stepIndex === this.steps.length - 1) {
      const reached: TrafficNote = { key: 'reached', activity: 'gate', params: { pct: percent } }
      if ((this.options.stabilizeSeconds ?? 0) > 0) {
        this.phase = 'stabilizing'
        this.stabilizeLeft = this.options.stabilizeSeconds ?? 0
        this.health = this.judgeHealth()
        this.emit([pass, reached])
        this.stabilize()
      } else {
        this.complete([pass, reached])
      }
    } else if (this.options.manualSteps) {
      // 수동 단계: 통과한 단계에서 멈추고 사람이 누를 때까지 기다린다(플랫폼 manual_steps와 같은 알림).
      this.awaiting = true
      this.phase = 'gate'
      this.decision = 'advance'
      this.emit([pass, { key: 'awaitNext', activity: 'gate', params: { pct: percent, next: this.steps[this.stepIndex + 1] } }])
    } else {
      this.stepIndex += 1
      this.phase = 'applying'
      this.decision = 'advance'
      this.emit([pass])
      this.beginApplying()
    }
  }

  private complete(notes: TrafficNote[]) {
    this.residual = { requests: 38, streams: 14 }
    this.phase = 'complete'
    this.decision = 'done'
    this.health = null
    this.emit(notes)
    this.drain()
  }

  /** 안정화 구간 한 창의 대상 판정(데모 값). 장애를 넣으면 오류율 50% · p99 1000ms. */
  private judgeHealth(): TrafficHealthJudgement {
    const requests = DEMO_RPS * STABILIZE_TICK
    const failed = this.injected ? Math.round(requests * 0.5) : 0
    const errorRate = Number((failed / requests).toFixed(4))
    const p99 = this.injected ? 1000 : DEMO_ORIGIN_P99_MS + Math.round(Math.abs(Math.sin(Date.now() / 900)) * 6)
    const limit = Math.round(DEMO_ORIGIN_P99_MS * MAX_P99_RATIO)
    const breach: TrafficHealthJudgement['breach'] = []
    if (errorRate > ALERT_ERROR_RATE) breach.push({ code: 'ERROR_RATE', value: errorRate, limit: ALERT_ERROR_RATE })
    if (p99 > limit) breach.push({ code: 'P99', value: p99, limit })
    return { requests, failed, error_rate: errorRate, p99_ms: p99, baseline_p99_ms: DEMO_ORIGIN_P99_MS, p99_limit_ms: limit, alert_error_rate: ALERT_ERROR_RATE, judged: true, breach }
  }

  // 3-1. 안정화 구간: 창마다 대상을 판정하고, 기준을 넘기 시작하거나 회복할 때 한 번씩 알린다. 자동으로 되돌리지 않는다.
  private stabilize() {
    const timer = setInterval(() => {
      this.health = this.judgeHealth()
      const breached = this.health.breach.length > 0
      if (breached !== this.breached) {
        this.breached = breached
        this.options.emitAlert?.({ ...this.health, state: breached ? 'breach' : 'recovered', phase: 'stabilizing' })
      }
      this.stabilizeLeft = Math.max(0, this.stabilizeLeft - STABILIZE_TICK)
      if (this.stabilizeLeft <= 0 && !breached) {
        clearInterval(timer)
        this.complete([{ key: 'finalized', activity: 'traffic_stabilize' }])
        return
      }
      this.emit()
    }, STABILIZE_TICK * 1000 / this.speed)
    this.intervals.push(timer)
  }

  // 4. 100% 이후: 옛 환경에 남은 요청·열린 연결이 줄어드는지 확인
  private drain() {
    const timer = setInterval(() => {
      const current = this.residual
      this.residual = {
        requests: Math.max(0, Math.floor(current.requests * 0.62) - (current.requests < 4 ? 1 : 0)),
        streams: current.requests < 12 ? Math.max(0, current.streams - 2) : current.streams,
      }
      const drained = this.residual.requests === 0 && this.residual.streams === 0
      if (drained) clearInterval(timer)
      this.emit(drained ? [{ key: 'drained' }] : undefined)
    }, 500 / this.speed)
    this.intervals.push(timer)
  }
}
