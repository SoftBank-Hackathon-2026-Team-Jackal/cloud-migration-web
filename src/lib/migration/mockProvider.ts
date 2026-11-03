import type { BackendPhase, DraftEvent, MigrationEvent, StartRequest, Target } from './events'
import type { EnterContext, MigrationProvider, ProviderHost } from './provider'
import { DATA_TICK_MS, dataProgressAt, reportFor, timelineFor, type ScriptedPhase, type TimedDraft } from './script'
import { TrafficSim } from './trafficSim'
import { aiFixCount } from '../demoConfig'

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
    return timelineFor(phase, { target: this.target, aiFixes: aiFixCount() })
  }

  start(request: StartRequest) {
    this.target = request.target
    this.analysisDone = false
    this.host.dispatch({ type: 'started', migrationId: 'mock' })
  }

  enter(phase: BackendPhase, context: EnterContext): () => void {
    this.target = context.target
    let stop: () => void = () => {}
    // 분석은 한 번 끝나면(결과가 남아 있으면) 다시 보러 올 때 처음부터 돌리지 않고 결과를 그대로 보여 준다.
    const keepResult = phase === 'analysis' && this.analysisDone
    // 분석 결과는 뒤 단계(계획)도 읽으므로 화면을 떠나도 지우지 않는다. 다른 단계는 떠날 때 비워 두었다가 다시 들어오면 처음부터 시작한다.
    const clearOnLeave = phase !== 'analysis'
    if (!keepResult) this.host.dispatch({ type: 'resetPhase', phase })
    switch (phase) {
      case 'analysis':
        if (!keepResult) stop = this.play(this.scripted('analysis'))
        break
      case 'build':
      case 'planning':
      case 'provisioning':
        stop = this.play(this.scripted(phase))
        break
      case 'awaiting_approval':
        this.emit({ type: 'approval.required', phase: 'awaiting_approval', status: 'waiting', data: { excluded: [], rollback_policy: '' } })
        break
      case 'data_copy': {
        // 복제 시작부터 250ms마다 그 시점의 진행 값을 내보낸다(화면이 열려 있는 동안 계속).
        const began = performance.now()
        const timer = window.setInterval(() => {
          const data = dataProgressAt((performance.now() - began) / 1000)
          this.emit({ type: 'data.progress', phase: 'data_copy', status: data.step === 'ready' ? 'done' : 'running', data })
        }, DATA_TICK_MS)
        stop = () => window.clearInterval(timer)
        break
      }
      case 'traffic': {
        const sim = new TrafficSim(data => this.emit({ type: 'traffic.snapshot', phase: 'traffic', status: data.phase === 'complete' ? 'done' : 'running', data }))
        this.traffic = sim
        sim.start()
        stop = () => { sim.stop(); if (this.traffic === sim) this.traffic = null }
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

  approve() { /* 목업은 승인을 기다리지 않는다: 다음 단계는 화면이 넘긴다. */ }

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
