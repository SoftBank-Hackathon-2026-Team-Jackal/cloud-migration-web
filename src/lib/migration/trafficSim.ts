/**
 * 트래픽 이전 단계의 데모 시뮬레이터. 10% → 50% → 100% 가중치를 적용하고, 관찰 창의 지표가 게이트 기준을 넘으면 롤백한다.
 * 화면에 있던 단계 기계를 그대로 옮긴 것이며, 브라우저의 MockProvider와 목업 SSE 서버가 함께 쓴다.
 * 바뀔 때마다 traffic.snapshot의 data 모양으로 상태를 내보낸다. 런타임 import 없음(Node가 그대로 읽는다).
 */
import type { TrafficNote, TrafficPhase, TrafficSnapshotData, TrafficStepResult } from './events'

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

  /** 전환 단계(대상 비율 %). 서버가 정한 단계(예: [50, 100])를 줄 수 있고, 없으면 10 · 50 · 100이다. */
  private steps: number[]

  constructor(emit: (data: TrafficSnapshotData) => void, steps: readonly number[] = TRAFFIC_STEPS) {
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
    this.clearTimers()
    this.injected = false
    this.weightNew = 0
    this.phase = 'rolledback'
    this.decision = 'rollback'
    this.emit([{ key: 'manual', activity: 'traffic_rollback', params: { origin: 100, target: 0 } }])
  }

  /** 데모 전용: 새 환경에서 오류가 나게 한다(관찰 창 안의 지표가 기준을 넘어 롤백된다). */
  inject() {
    if (!this.running || (this.phase !== 'observing' && this.phase !== 'applying')) return
    this.injected = true
    this.emit([{ key: 'inject' }])
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
  }

  private clearTimers() {
    this.timers.forEach(timer => clearTimeout(timer))
    this.intervals.forEach(timer => clearInterval(timer))
    this.timers = []
    this.intervals = []
  }

  private after(ms: number, run: () => void) {
    this.timers.push(setTimeout(run, ms))
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
    }, OBSERVE_TICK * 1000)
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
      this.residual = { requests: 38, streams: 14 }
      this.phase = 'complete'
      this.decision = 'done'
      this.emit([pass, { key: 'reached', activity: 'gate', params: { pct: percent } }])
      this.drain()
    } else {
      this.stepIndex += 1
      this.phase = 'applying'
      this.decision = 'advance'
      this.emit([pass])
      this.beginApplying()
    }
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
    }, 500)
    this.intervals.push(timer)
  }
}
