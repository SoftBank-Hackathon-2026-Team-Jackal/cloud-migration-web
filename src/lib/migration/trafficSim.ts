/**
 * 트래픽 이전 단계의 데모 시뮬레이터. 10% → 50% → 100% 가중치를 적용하고, 관찰 창의 지표가 게이트 기준을 넘으면 롤백한다.
 * 화면에 있던 단계 기계를 그대로 옮긴 것이며, 브라우저의 MockProvider와 목업 SSE 서버가 함께 쓴다.
 * 바뀔 때마다 traffic.snapshot의 data 모양으로 상태를 내보낸다. 런타임 import 없음(Node가 그대로 읽는다).
 */
import type { TrafficNote, TrafficPhase, TrafficSnapshotData } from './events'

export const TRAFFIC_STEPS = [10, 50, 100] as const
/** 관찰 창 길이(초)와 게이트 기준 */
export const OBSERVE_SECONDS = 4
const MAX_FAILED = 0
const MAX_P99_RATIO = 1.5
const STEPS = TRAFFIC_STEPS

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

  constructor(emit: (data: TrafficSnapshotData) => void) {
    this.emitSnapshot = emit
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
    this.emit([{ key: 'manual' }])
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
    const percent = STEPS[this.stepIndex]
    const data: TrafficSnapshotData = {
      phase: this.phase,
      weights: { origin: 100 - this.weightNew, target: this.weightNew },
      step: percent,
      gate: {
        failed_requests: this.failed,
        max_failed_requests: MAX_FAILED,
        p99_ratio: this.p99,
        max_p99_ratio: MAX_P99_RATIO,
        observe_left_seconds: this.observeLeft,
      },
      residual: { requests_per_sec: this.residual.requests, streams: this.residual.streams },
    }
    if (this.decision) data.decision = this.decision
    if (notes && notes.length > 0) data.notes = notes
    this.decision = undefined
    this.emitSnapshot(data)
  }

  // 1. 가중치 적용
  private beginApplying() {
    const percent = STEPS[this.stepIndex]
    this.after(250, () => {
      this.weightNew = percent
      this.emit([{ key: 'apply', params: { pct: percent, old: 100 - percent, new: percent } }])
    })
    this.after(1300, () => {
      this.failed = 0
      this.p99 = 1
      this.observeLeft = OBSERVE_SECONDS
      this.phase = 'observing'
      this.emit()
      this.observe()
    })
  }

  // 2. 관찰 창: 1초마다 지표 갱신, 실패 요청이 생기면 곧바로 게이트로
  private observe() {
    const timer = setInterval(() => {
      if (this.injected) {
        this.failed += 3
        this.p99 = Math.min(2.4, this.p99 + 0.45)
      } else {
        this.failed = 0
        this.p99 = Number((1.03 + Math.abs(Math.sin(Date.now() / 700)) * 0.12).toFixed(2))
      }
      this.observeLeft = Math.max(0, this.observeLeft - 1)
      if (this.failed > MAX_FAILED || this.observeLeft <= 0) {
        clearInterval(timer)
        this.phase = 'gate'
        this.emit()
        this.after(700, () => this.judge())
      } else {
        this.emit()
      }
    }, 1000)
    this.intervals.push(timer)
  }

  // 3. 게이트 판정
  private judge() {
    const percent = STEPS[this.stepIndex]
    if (this.failed > MAX_FAILED || this.p99 > MAX_P99_RATIO) {
      this.injected = false
      this.weightNew = 0
      this.phase = 'rolledback'
      this.decision = 'rollback'
      this.emit([{ key: 'gateFail', params: { failed: this.failed, ratio: this.p99.toFixed(2), maxFailed: MAX_FAILED, maxRatio: MAX_P99_RATIO } }])
      return
    }
    const pass: TrafficNote = { key: 'gatePass', params: { pct: percent, ratio: this.p99.toFixed(2) } }
    if (this.stepIndex === STEPS.length - 1) {
      this.residual = { requests: 38, streams: 14 }
      this.phase = 'complete'
      this.decision = 'done'
      this.emit([pass, { key: 'reached' }])
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
