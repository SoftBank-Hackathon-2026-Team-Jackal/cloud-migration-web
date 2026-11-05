import { targetOfRequest, type BackendPhase, type DraftEvent, type MigrationEvent, type StartRequest, type Target } from './events'
import type { EnterContext, MigrationProvider, ProviderHost } from './provider'
import { DATA_TICK_MS, TRAFFIC_READY_EVENTS, trafficPrepareTimeline, dataProgressAt, dueDataVerify, reportFor, timelineFor, type ScriptedPhase, type TimedDraft } from './script'
import { TrafficSim } from './trafficSim'
import { aiFixCount, digestMismatchDemo, reviewDemo, sandboxScenario } from '../demoConfig'

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
    const timers = items.map(({ after, event }) => window.setTimeout(() => this.emit(event), after))
    return () => timers.forEach(timer => window.clearTimeout(timer))
  }

  private scripted(phase: ScriptedPhase) {
    return timelineFor(phase, { target: this.target, aiFixes: aiFixCount(), revision: this.revision, review: this.reviewPending, retried: this.retried, digestMismatch: digestMismatchDemo(), sandbox: sandboxScenario() })
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
    // 분석 결과는 뒤 단계(계획)도, 계획 결과(이미지 Digest·계획 버전)는 승인 화면도 읽으므로 화면을 떠나도 지우지 않는다. 다른 단계는 떠날 때 비워 두었다가 다시 들어오면 처음부터 시작한다.
    const clearOnLeave = phase !== 'analysis' && phase !== 'planning'
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
        // 승인 화면은 계획 결과(Digest·버전)를 읽는다. 계획 단계를 거치지 않고 열었을 때도 같은 값이 있도록 한 번 알린다.
        const ready = this.scripted('planning').find(item => item.event.type === 'plan.ready')
        if (ready) this.emit(ready.event)
        this.emit({ type: 'approval.required', phase: 'awaiting_approval', status: 'waiting', data: { excluded: [], rollback_policy: '' } })
        break
      }
      case 'data_copy': {
        // 복제 시작부터 250ms마다 그 시점의 진행 값을 내보낸다(화면이 열려 있는 동안 계속).
        const began = performance.now()
        let readyAt = 0
        let verifyCursor = 0
        const timer = window.setInterval(() => {
          const data = dataProgressAt((performance.now() - began) / 1000)
          this.emit({ type: 'data.progress', phase: 'data_copy', status: data.step === 'ready' ? 'done' : 'running', data })
          // 복제가 준비되면 정합성 확인(행 수 → 체크섬)을 이어서 보낸다.
          if (data.step === 'ready') {
            if (!readyAt) readyAt = performance.now()
            const due = dueDataVerify(performance.now() - readyAt, verifyCursor)
            verifyCursor = due.cursor
            for (const event of due.events) this.emit(event)
          }
        }, DATA_TICK_MS)
        stop = () => window.clearInterval(timer)
        break
      }
      case 'traffic': {
        const sim = new TrafficSim(data => this.emit({ type: 'traffic.snapshot', phase: 'traffic', status: data.phase === 'complete' ? 'done' : 'running', data }))
        this.traffic = sim
        // 먼저 전환 조건을 확인하고(전환 가능 시점), 확인이 끝나면 트래픽을 옮기기 시작한다.
        const timers = TRAFFIC_READY_EVENTS.map(item => window.setTimeout(() => this.emit({ type: 'traffic.ready', phase: 'traffic', status: 'running', data: item.data }), item.after))
        // [가정] 사전 확인(traffic_prepare): 인계 상태·ready·external_endpoint·헬스를 확인하고 연결 정보를 알린다.
        const prepare = trafficPrepareTimeline(this.target)
        for (const item of prepare) timers.push(window.setTimeout(() => this.emit({ type: 'traffic.prepare', phase: 'traffic', status: item.data.state === 'done' ? 'done' : 'running', data: item.data }), item.after))
        const startAt = Math.max(TRAFFIC_READY_EVENTS[TRAFFIC_READY_EVENTS.length - 1].after, prepare[prepare.length - 1].after)
        timers.push(window.setTimeout(() => sim.start(), startAt))
        stop = () => { timers.forEach(timer => window.clearTimeout(timer)); sim.stop(); if (this.traffic === sim) this.traffic = null }
        break
      }
      case 'verification':
        // 두 번째 승인(approveCutover)이 있어야 시작한다. 승인 뒤의 대본은 여기서 정리한다.
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

  approve(_revision?: number) { /* 목업은 승인을 기다리지 않는다: 다음 단계는 화면이 넘긴다. */ }

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
    this.cutoverCancel = this.play(this.scripted('verification'))
  }

  cancel() { this.host.dispatch({ type: 'cancelled' }) }
  rollbackTraffic() { this.traffic?.rollback() }
  retryTraffic() { this.traffic?.retry() }
  injectFailure() { this.traffic?.inject() }
  loadReport() { this.host.dispatch({ type: 'report', report: reportFor(aiFixCount()) }) }

  dispose() {
    for (const cleanup of [...this.disposers]) cleanup()
  }
}
