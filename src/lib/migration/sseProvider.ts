import { startRequestFor, type BackendPhase, type ErrorData, type MigrationEvent, type StartRequest } from './events'
import type { EnterContext, MigrationProvider, ProviderHost } from './provider'
import type { ReportData } from './events'

type Options = {
  baseUrl: string
  /**
   * 요청마다 붙일 헤더(인증 토큰 등). EventSource는 헤더를 못 붙이지만 fetch로 읽으므로 여기서 붙일 수 있다.
   * 인증 방식이 정해지면 이 한 곳만 채우면 된다.
   */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>
}

const RETRY_FIRST_MS = 500
const RETRY_MAX_MS = 5000

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

/**
 * 서버가 보내는 SSE 이벤트로 화면을 움직이는 공급자.
 * - fetch 스트림으로 읽는다(요청 헤더를 붙일 수 있다).
 * - 끊기면 자동으로 다시 연결하고, 마지막으로 받은 id를 Last-Event-ID로 보내 이어 받는다.
 * - 연결 직후 서버가 보내는 snapshot 이벤트가 화면 상태를 복원한다.
 */
export class SseProvider implements MigrationProvider {
  readonly mode = 'sse' as const
  private host: ProviderHost
  private options: Options
  private migrationId: string | null = null
  private starting: Promise<void> | null = null
  private controller: AbortController | null = null
  private lastId = ''

  constructor(host: ProviderHost, options: Options) {
    this.host = host
    this.options = options
  }

  private async headers(extra: Record<string, string> = {}) {
    return { ...(this.options.getHeaders ? await this.options.getHeaders() : {}), ...extra }
  }

  private fail(error: ErrorData) {
    this.host.dispatch({ type: 'fail', error })
  }

  private async post(path: string, body?: object): Promise<boolean> {
    if (!this.migrationId) return false
    try {
      const response = await fetch(this.options.baseUrl + '/migrations/' + this.migrationId + path, {
        method: 'POST',
        headers: await this.headers(body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return true
    } catch (error) {
      this.fail({ code: 'request_failed', message: error instanceof Error ? error.message : String(error), phase: null, retryable: true })
      return false
    }
  }

  /** 시연용 쿼리(?review=1)를 목업 서버에 넘긴다. 실제 백엔드는 무시한다. */
  private demoQuery() {
    return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('review') === '1' ? '?review=1' : ''
  }

  start(request: StartRequest) {
    this.closeStream()
    this.migrationId = null
    this.lastId = ''
    this.host.dispatch({ type: 'reset' })
    this.starting = (async () => {
      try {
        const response = await fetch(this.options.baseUrl + '/migrations' + this.demoQuery(), {
          method: 'POST',
          headers: await this.headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(request),
        })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        const body = await response.json() as { id: string }
        this.migrationId = body.id
        this.host.dispatch({ type: 'started', migrationId: body.id })
        this.connect(body.id)
      } catch (error) {
        this.fail({ code: 'start_failed', message: error instanceof Error ? error.message : String(error), phase: null, retryable: false })
      }
    })()
  }

  enter(_phase: BackendPhase, context: EnterContext): () => void {
    // 설정 화면을 거치지 않고 주소로 단계를 연 경우에는 기본 요청으로 이전을 하나 시작한다.
    if (!this.migrationId && !this.starting) this.start(startRequestFor(context.target))
    return () => {}
  }

  approve(revision?: number) { void this.post('/approve', revision === undefined ? undefined : { revision }) }
  revisePlan() { void this.post('/plan/revise') }
  retrySandbox() { void this.post('/sandbox/retry') }
  approveCutover() { void this.post('/approve?gate=cutover') }
  cancel() { void this.post('/cancel') }
  rollbackTraffic() { void this.post('/traffic/rollback') }
  retryTraffic() { void this.post('/traffic/retry') }
  injectFailure() { /* 데모 전용: SSE 모드에서는 쓰지 않는다. */ }

  loadReport() {
    if (!this.migrationId) return
    void (async () => {
      try {
        const response = await fetch(this.options.baseUrl + '/migrations/' + this.migrationId + '/report', { headers: await this.headers() })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        this.host.dispatch({ type: 'report', report: await response.json() as ReportData })
      } catch (error) {
        this.fail({ code: 'report_failed', message: error instanceof Error ? error.message : String(error), phase: 'verification', retryable: true })
      }
    })()
  }

  dispose() {
    this.closeStream()
  }

  private closeStream() {
    this.controller?.abort()
    this.controller = null
  }

  private connect(id: string) {
    this.closeStream()
    const controller = new AbortController()
    this.controller = controller
    void this.run(id, controller.signal)
  }

  private async run(id: string, signal: AbortSignal) {
    let delay = RETRY_FIRST_MS
    while (!signal.aborted) {
      try {
        const extra: Record<string, string> = { Accept: 'text/event-stream' }
        if (this.lastId) extra['Last-Event-ID'] = this.lastId
        const response = await fetch(this.options.baseUrl + '/migrations/' + id + '/events', { headers: await this.headers(extra), signal })
        if (response.status === 404) {
          // 서버가 이 이전을 모른다(서버가 다시 시작되며 기록을 잃은 경우): 다시 연결해도 소용없다.
          this.host.dispatch({ type: 'connection', value: 'connected' })
          this.fail({ code: 'migration_not_found', message: 'migration ' + id + ' not found', phase: null, retryable: false })
          return
        }
        if (!response.ok || !response.body) throw new Error('HTTP ' + response.status)
        this.host.dispatch({ type: 'connection', value: 'connected' })
        delay = RETRY_FIRST_MS
        await this.read(response.body, signal)
      } catch {
        if (signal.aborted) return
      }
      if (signal.aborted) return
      // 끊겼다: 잠시 뒤 다시 연결한다(마지막으로 받은 id부터 이어 받는다).
      this.host.dispatch({ type: 'connection', value: 'reconnecting' })
      await sleep(delay, signal)
      delay = Math.min(delay * 2, RETRY_MAX_MS)
    }
  }

  private async read(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n')
        let split = buffer.indexOf('\n\n')
        while (split >= 0) {
          this.handleBlock(buffer.slice(0, split))
          buffer = buffer.slice(split + 2)
          split = buffer.indexOf('\n\n')
        }
      }
    } finally {
      reader.cancel().catch(() => {})
    }
  }

  /** SSE 블록 하나(id·event·data 줄)를 이벤트로 바꿔 상태에 보낸다. 주석(:)과 빈 data는 무시한다. */
  private handleBlock(block: string) {
    let id = ''
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'id') id = value
      else if (field === 'data') data.push(value)
    }
    if (data.length === 0) return
    let event: MigrationEvent
    try { event = JSON.parse(data.join('\n')) as MigrationEvent } catch { return }
    if (id) this.lastId = id
    this.host.dispatch({ type: 'event', event })
  }
}
