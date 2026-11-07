import { targetOfRequest, type BackendPhase, type DraftEvent, type MigrationEvent, type StartRequest, type Target } from './events'
import type { EnterContext, MigrationProvider, ProviderHost } from './provider'
import type { ReviewResult } from './review'
import { TRAFFIC_READY_EVENTS, trafficPrepareTimeline, approvalTimeline, reportFor, timelineFor, type ScriptedPhase, type TimedDraft } from './script'
import { DATA_LSN_TICK_MS, DATA_TABLES, dataTickAt, dataTimeline } from './dataScript'
import { cutoverPlan, cutoverRun } from './cutoverScript'
import { TrafficSim } from './trafficSim'
import { aiFixCount, analysisItemsDemo, cutoverScenario, deliveryFailDemo, digestMismatchDemo, preflightScenario, reviewDemo, sandboxScenario, mockSpeed, stabilizeDemoSeconds } from '../demoConfig'

/**
 * 백엔드 없이 지금까지와 똑같이 움직이게 하는 공급자. 단계 화면이 준비되면 그 단계의 대본(script.ts)을
 * 정해진 시각에 이벤트로 내보낸다. 화면은 이벤트가 만든 상태만 읽는다.
 */
export class MockProvider implements MigrationProvider {
  readonly mode = 'mock' as const
  private host: ProviderHost
  private seq = 0
  private target: Target = 'onprem'
  private analysisDone = false
  /** 계획 버전: 처음 1, 계획 수정 요청마다 +1 */
  private revision = 1
  /** ?review=1 데모: 처음 샌드박스는 3회 실패해 사람 검토를 기다리고, 재시도하면 성공한다. */
  private reviewPending = reviewDemo()
  private retried = false
  private buildPlay: (() => void) | null = null
  private traffic: TrafficSim | null = null
  private cutoverCancel: (() => void) | null = null
  private cutoverAttempt = 0
  /** 승인 결정 대본(접수 → 전달)과 전달 시도 횟수 */
  private approvalPlay: (() => void) | null = null
  private deliveryAttempts = 0
  private disposers = new Set<() => void>()

  constructor(host: ProviderHost) {
    this.host = host
  }

  private emit(draft: DraftEvent) {
    this.seq += 1
    if (draft.type === 'analysis.done') this.analysisDone = true
    this.host.dispatch({ type: 'event', event: { ...draft, seq: this.seq, at: new Date().toISOString() } as MigrationEvent })
  }

  /** 대본을 시각대로 내보내고, 멈추는 함수를 돌려준다. */
  private play(items: TimedDraft[]): () => void {
    const speed = mockSpeed()
    const timers = items.map(({ after, event }) => window.setTimeout(() => this.emit(event), after / speed))
    return () => timers.forEach(timer => window.clearTimeout(timer))
  }

  private scripted(phase: ScriptedPhase) {
    return timelineFor(phase, { target: this.target, aiFixes: aiFixCount(), revision: this.revision, review: this.reviewPending, retried: this.retried, digestMismatch: digestMismatchDemo(), sandbox: sandboxScenario(), analysisItems: analysisItemsDemo() })
  }

  start(request: StartRequest) {
    this.target = targetOfRequest(request)
    this.analysisDone = false
    this.revision = 1
    this.reviewPending = reviewDemo()
    this.retried = false
    this.host.dispatch({ type: 'started', migrationId: 'mock' })
  }

  enter(phase: BackendPhase, context: EnterContext): () => void {
    this.target = context.target
    let stop: () => void = () => {}
    // 분석은 한 번 끝나면(결과가 남아 있으면) 다시 보러 올 때 처음부터 돌리지 않고 결과를 그대로 보여 준다.
    const keepResult = phase === 'analysis' && this.analysisDone
    // 분석 결과는 뒤 단계(계획)도, 샌드박스 결과(Fixer 수정·새 환경 변수)는 계획 화면도, 계획 결과(이미지 Digest·계획 버전)는 승인 화면도 읽으므로 화면을 떠나도 지우지 않는다.
    // 다른 단계는 떠날 때 비워 두었다가 다시 들어오면 처음부터 시작한다(들어올 때는 어느 단계든 위에서 비운다).
    const clearOnLeave = phase !== 'analysis' && phase !== 'planning' && phase !== 'build'
    if (!keepResult) this.host.dispatch({ type: 'resetPhase', phase })
    switch (phase) {
      case 'analysis':
        if (!keepResult) stop = this.play(this.scripted('analysis'))
        break
      case 'build':
        this.buildPlay = this.play(this.scripted('build'))
        stop = () => { this.buildPlay?.(); this.buildPlay = null }
        break
      case 'planning':
      case 'provisioning':
        stop = this.play(this.scripted(phase))
        break
      case 'awaiting_approval': {
        // 승인 화면은 계획 결과(매핑·미리보기·Digest·버전)로 요약을 그린다. 계획 단계를 거치지 않고 열었을 때도 같은 값이 있도록 한 번 알린다(같은 id는 덮어써 결과가 같다).
        for (const item of this.scripted('planning')) this.emit(item.event)
        this.emit({ type: 'approval.required', phase: 'awaiting_approval', status: 'waiting', data: { excluded: [], rollback_policy: '' } })
        this.deliveryAttempts = 0
        stop = () => { this.approvalPlay?.(); this.approvalPlay = null }
        break
      }
      case 'data_copy': {
        // 사전 검사 → (PASS면) 스키마 → 초기 복사 → CDC → 스트리밍 대본(dataScript.ts)을 내보내고,
        // 250ms마다 그 시점의 WAL 위치·지연(data.lsn)과 예전 진행 값(data.progress)을 보낸다(화면이 열려 있는 동안 계속).
        const scenario = preflightScenario()
        const began = performance.now()
        const stopScript = this.play(dataTimeline(this.target, scenario, Date.now()))
        const timer = window.setInterval(() => {
          for (const event of dataTickAt((performance.now() - began) * mockSpeed(), scenario)) this.emit(event)
        }, DATA_LSN_TICK_MS / mockSpeed())
        stop = () => { stopScript(); window.clearInterval(timer) }
        break
      }
      case 'traffic': {
        const sim = new TrafficSim(data => this.emit({ type: 'traffic.snapshot', phase: 'traffic', status: data.phase === 'complete' ? 'done' : 'running', data }), undefined, mockSpeed(), {
          stabilizeSeconds: stabilizeDemoSeconds(),
          emitAlert: data => this.emit({ type: 'traffic.alert', phase: 'traffic', status: 'running', data }),
        })
        this.traffic = sim
        // 먼저 전환 조건을 확인하고(전환 가능 시점), 확인이 끝나면 트래픽을 옮기기 시작한다.
        const timers = TRAFFIC_READY_EVENTS.map(item => window.setTimeout(() => this.emit({ type: 'traffic.ready', phase: 'traffic', status: 'running', data: item.data }), item.after / mockSpeed()))
        // [가정] 사전 확인(traffic_prepare): 인계 상태·ready·external_endpoint·헬스를 확인하고 연결 정보를 알린다.
        const prepare = trafficPrepareTimeline(this.target)
        for (const item of prepare) timers.push(window.setTimeout(() => this.emit({ type: 'traffic.prepare', phase: 'traffic', status: item.data.state === 'done' ? 'done' : 'running', data: item.data }), item.after / mockSpeed()))
        const startAt = Math.max(TRAFFIC_READY_EVENTS[TRAFFIC_READY_EVENTS.length - 1].after, prepare[prepare.length - 1].after)
        timers.push(window.setTimeout(() => sim.start(), startAt / mockSpeed()))
        stop = () => { timers.forEach(timer => window.clearTimeout(timer)); sim.stop(); if (this.traffic === sim) this.traffic = null }
        break
      }
      case 'verification':
        // 승인 화면이 읽을 전환 계획을 먼저 알린다. 두 번째 승인(approveCutover)이 있어야 전환을 시작한다. 승인 뒤의 대본은 여기서 정리한다.
        this.cutoverAttempt = 0
        this.emit({ type: 'cutover.plan', phase: 'verification', status: 'waiting', data: cutoverPlan(this.target, cutoverScenario()) })
        stop = () => { this.cutoverCancel?.(); this.cutoverCancel = null }
        break
    }
    const cleanup = () => {
      stop()
      this.disposers.delete(cleanup)
      if (clearOnLeave) this.host.dispatch({ type: 'resetPhase', phase })
    }
    this.disposers.add(cleanup)
    return cleanup
  }

  /**
   * 승인: 결정 기록(PENDING) → 실행 엔진에 전달(DELIVERED). 화면은 전달 완료를 받은 뒤에 다음 단계로 넘어간다.
   * ?delivery=fail이면 첫 전달이 실패하고(FAILED), 다시 누르면(다시 전달) 성공한다.
   */
  approve(_revision?: number) {
    this.approvalPlay?.()
    this.deliveryAttempts += 1
    const fail = deliveryFailDemo() && this.deliveryAttempts === 1
    this.approvalPlay = this.play(approvalTimeline(this.revision, { attempt: this.deliveryAttempts, fail }))
  }

  /** 계획 수정 요청: 계획 버전을 하나 올린다. 화면이 계획 단계로 돌아가면 새 버전의 계획이 다시 나온다. */
  revisePlan() { this.revision += 1 }

  /** 사람 검토 뒤 샌드박스를 다시 시도한다: 검토 대기 값을 지우고 성공하는 빌드(이전 빌드 재사용)를 처음부터 흘린다. */
  retrySandbox() {
    this.buildPlay?.()
    this.reviewPending = false
    this.retried = true
    this.host.dispatch({ type: 'resetPhase', phase: 'build' })
    this.buildPlay = this.play(this.scripted('build'))
  }

  approveCutover() {
    this.cutoverCancel?.()
    this.cutoverAttempt += 1
    this.cutoverCancel = this.play(cutoverRun(cutoverScenario(), this.cutoverAttempt, DATA_TABLES))
  }

  cancel() { this.host.dispatch({ type: 'cancelled' }) }
  rollbackTraffic() { this.traffic?.rollback() }
  retryTraffic() { this.traffic?.retry() }
  /** 안정화 구간을 끝내고 확정한다(?stabilize=N일 때만 안정화 구간이 있다). */
  finalizeTraffic() { this.traffic?.finalize() }
  injectFailure() { this.traffic?.inject() }
  loadReport() { this.host.dispatch({ type: 'report', report: reportFor(aiFixCount()) }) }
  // 목업 흐름에는 분석 검토 게이트가 없다(실제 서버에서만 사람의 확인을 기다린다).
  attach() { /* 목업은 다시 붙을 이전이 없다. */ }
  async loadReview() { return null }
  async confirmReview(): Promise<ReviewResult> { return { ok: false, code: 'REVIEW_NOT_PENDING' } }
  async approveReview(): Promise<ReviewResult> { return { ok: false, code: 'REVIEW_NOT_PENDING' } }

  dispose() {
    for (const cleanup of [...this.disposers]) cleanup()
  }
}
