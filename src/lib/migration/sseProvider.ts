import { normalizePlanStep, startRequestFor, type ApprovalDecisionData, type BackendPhase, type ErrorData, type MigrationEvent, type PlanReadyData, type StartRequest } from './events.ts'
import type { EnterContext, MigrationProvider, ProviderHost } from './provider'
import type { ReportData } from './events'
import type { SseStartMode } from './config'

type Options = {
  baseUrl: string
  /**
   * 요청마다 붙일 헤더(인증 토큰 등). EventSource는 헤더를 못 붙이지만 fetch로 읽으므로 여기서 붙일 수 있다.
   * 인증 방식이 정해지면 이 한 곳만 채우면 된다.
   */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>
  /** 시작 방식(config.ts의 sseStartMode). 기본 wait: 백엔드가 source를 받기 전까지 POST /migrations를 부르지 않는다. */
  startMode?: SseStartMode
}

/** 이전을 시작하지 않고 멈춘 이유(StatusPanel이 실패가 아니라 대기 안내로 보여 준다). */
export const BACKEND_PENDING = 'backend_pending'
export const SOURCE_REQUIRED = 'source_required'

// 백엔드 시작 요청의 project_id. 프로젝트 개념이 정해지기 전까지 고정값을 쓴다.
const PROJECT_ID = 'demo'
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
  /** 가장 최근 plan.ready 값: 승인 API가 계획 ID·버전·digest를 요구한다. */
  private plan: PlanReadyData | null = null
  /** 가장 최근 승인 결정(API 응답·approval.decision). 전달이 실패했으면 다시 전달할 때 approval_id를 쓴다. */
  private decision: ApprovalDecisionData | null = null

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

  /** POST를 보내고 응답 본문(JSON이 아니면 null)을 돌려준다. 실패하면 화면에 요청 실패를 알리고 undefined. */
  private async post(path: string, body?: object, absolute = false): Promise<unknown> {
    if (!this.migrationId) return undefined
    try {
      const response = await fetch(this.options.baseUrl + (absolute ? '' : '/migrations/' + this.migrationId) + path, {
        method: 'POST',
        headers: await this.headers(body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      return await response.json().catch(() => null)
    } catch (error) {
      this.fail({ code: 'request_failed', message: error instanceof Error ? error.message : String(error), phase: null, retryable: true })
      return undefined
    }
  }

  /** 승인 API 응답(ApprovalResponse)이면 상태에 넣는다. 전달 상태가 없는 응답(옛 경로)은 넣지 않는다: 그때는 구축 이벤트가 진행을 알려 준다. */
  private takeDecision(body: unknown) {
    const data = body as Partial<ApprovalDecisionData> | null | undefined
    if (!data || typeof data !== 'object' || !data.approval_id || !data.delivery_status) return
    this.decision = data as ApprovalDecisionData
    this.host.dispatch({ type: 'approvalDecision', data: this.decision })
  }

  /** 시연용 쿼리(?review=1 · ?preflight=route|unknown)를 목업 서버에 넘긴다. 실제 백엔드는 무시한다. */
  private demoQuery() {
    if (typeof window === 'undefined') return ''
    const search = new URLSearchParams(window.location.search)
    const query = new URLSearchParams()
    if (search.get('review') === '1') query.set('review', '1')
    const preflight = search.get('preflight')
    if (preflight === 'route' || preflight === 'unknown') query.set('preflight', preflight)
    const text = query.toString()
    return text ? '?' + text : ''
  }

  private get startMode(): SseStartMode {
    return this.options.startMode ?? 'wait'
  }

  /** 시작하지 않고 대기 안내를 띄운다(분석이 시작된 것처럼 보이지 않게). */
  private hold(code: typeof BACKEND_PENDING | typeof SOURCE_REQUIRED) {
    this.fail({ code, message: '', phase: null, retryable: false })
  }

  start(request: StartRequest) {
    this.closeStream()
    this.migrationId = null
    this.lastId = ''
    this.plan = null
    this.starting = null
    this.host.dispatch({ type: 'reset' })
    // [#60 전] 백엔드 /migrations는 source를 아직 받지 않는다: 부르지 않는다.
    if (this.startMode === 'wait') { this.hold(BACKEND_PENDING); return }
    if (this.startMode === 'source' && !request.source) { this.hold(SOURCE_REQUIRED); return }
    this.starting = (async () => {
      try {
        const response = await fetch(this.options.baseUrl + '/migrations' + this.demoQuery(), {
          method: 'POST',
          headers: await this.headers({ 'Content-Type': 'application/json' }),
          // 백엔드 학습용 뼈대는 project_id(필수)·source_provider(AWS)·target_provider를 읽는다. 목업 서버는 target 객체를 읽는다. 둘 다 보낸다.
          body: JSON.stringify({ project_id: PROJECT_ID, source_provider: 'AWS', target_provider: request.target.provider, ...request }),
        })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        // 백엔드는 workflow_id, 목업 서버는 id로 답한다.
        const created = await response.json() as { workflow_id?: string; id?: string }
        const id = created.workflow_id ?? created.id
        if (!id) throw new Error('missing migration id')
        this.migrationId = id
        this.host.dispatch({ type: 'started', migrationId: id })
        this.connect(id)
      } catch (error) {
        this.fail({ code: 'start_failed', message: error instanceof Error ? error.message : String(error), phase: null, retryable: false })
      }
    })()
  }

  enter(_phase: BackendPhase, context: EnterContext): () => void {
    // 설정 화면을 거치지 않고 주소로 단계를 연 경우: 저장소(source)가 없으므로 시작하지 않고 대기 안내를 띄운다.
    // 목업 SSE 서버 시험(legacy)만 예전처럼 기본 요청으로 이전을 하나 시작한다.
    if (!this.migrationId && !this.starting) {
      if (this.startMode === 'legacy') this.start(startRequestFor(context.target))
      else this.hold(this.startMode === 'wait' ? BACKEND_PENDING : SOURCE_REQUIRED)
    }
    return () => {}
  }

  /**
   * 계획 승인·거절. [백엔드 openapi 확정] POST /provisioning/plans/{plan_id}/revisions/{revision}/approvals
   * 본문 {decision: APPROVE|REJECT, scope, manifest_digest, preview_digest}, 승인자 인증은 getHeaders(Bearer).
   * plan.ready에 계획 ID·버전·digest가 없으면 옛 경로로 보낸다. 옛 경로 [확정: 학습용 뼈대] POST /migrations/{id}/approve
   */
  private decide(decision: 'APPROVE' | 'REJECT', fallback: () => void) {
    const plan = this.plan
    if (!plan?.plan_id || plan.revision === undefined || !plan.manifest_digest || !plan.preview_digest) { fallback(); return }
    const path = '/provisioning/plans/' + encodeURIComponent(plan.plan_id) + '/revisions/' + plan.revision + '/approvals'
    // 같은 계획 버전의 승인이 기록됐지만 전달에 실패했으면, 새로 결정하지 않고 같은 승인을 다시 전달한다(openapi: POST …/approvals/{approval_id}/delivery).
    const last = this.decision
    const redeliver = decision === 'APPROVE' && last && last.decision === 'APPROVE' && last.plan_id === plan.plan_id && last.revision === plan.revision && last.delivery_status === 'FAILED'
    const request = redeliver
      ? this.post(path + '/' + encodeURIComponent(last.approval_id) + '/delivery', undefined, true)
      : this.post(path, { decision, scope: 'FULL', manifest_digest: plan.manifest_digest, preview_digest: plan.preview_digest }, true)
    void request.then(body => this.takeDecision(body))
  }

  approve(revision?: number) { this.decide('APPROVE', () => { void this.post('/approve', revision === undefined ? undefined : { revision }).then(body => this.takeDecision(body)) }) }
  /**
   * 계획 수정 요청. [가정] 백엔드는 재계획 의미를 아직 정하지 않았다(openapi: REJECT만 구현, revision 요청은 undecided).
   * 그래서 거절(REJECT)로 보내고 revision + 1의 plan.ready가 다시 온다고 기대한다. 계획 정보가 없으면 [가정] POST /plan/revise.
   */
  revisePlan() { this.decide('REJECT', () => { void this.post('/plan/revise') }) }
  /** [가정] 백엔드 계약에 없다: 샌드박스 3회 초과 뒤 사람 검토가 어떻게 이뤄지는지 정해지지 않았다. */
  retrySandbox() { void this.post('/sandbox/retry') }
  /** [가정] 두 번째 승인(DB 전환) 경로는 정해지지 않았다. */
  approveCutover() { void this.post('/approve?gate=cutover') }
  /** [확정: 학습용 뼈대] POST /migrations/{id}/cancel */
  cancel() { void this.post('/cancel') }
  /** [가정] 트래픽 롤백·재시도 경로는 정해지지 않았다. */
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
    event = normalizeEvent(event)
    if (event.type === 'plan.ready') this.plan = event.data
    if (event.type === 'approval.decision') this.decision = event.data
    if (event.type === 'snapshot') {
      for (const item of event.data.events) {
        if (item.type === 'plan.ready') this.plan = item.data
        if (item.type === 'approval.decision') this.decision = item.data
      }
    }
    this.host.dispatch({ type: 'event', event })
  }
}

/**
 * 서버 값을 화면이 읽는 모양으로 맞춘다 [가정: 백엔드 계약 미정].
 * - plan.step: 예전 등급(direct/convert/none)과 빠진 처리·원본 유지·검증 상태를 채운다.
 * - plan.preview: 빠진 목록은 빈 목록으로.
 * - traffic.prepare·traffic.snapshot [가정]: 빠진 목록은 빈 목록으로.
 * - snapshot 안의 이벤트도 같은 규칙으로.
 */
export function normalizeEvent(event: MigrationEvent): MigrationEvent {
  switch (event.type) {
    case 'plan.step':
      return { ...event, data: normalizePlanStep(event.data) }
    case 'plan.preview': {
      const data = event.data
      return { ...event, data: {
        ...data,
        resources: data.resources ?? [],
        env_remap: data.env_remap ?? [],
        security_rules: data.security_rules ?? [],
        validation: { errors: data.validation?.errors ?? [], warnings: data.validation?.warnings ?? [] },
      } }
    }
    // [가정] 트래픽 사전 확인: 빠진 확인 목록은 빈 목록으로.
    case 'traffic.prepare':
      return { ...event, data: { ...event.data, checks: event.data.checks ?? [] } }
    // [가정] 트래픽 스냅샷: 빠진 notes·results는 빈 목록으로, steps가 비어 있으면 지운다(화면이 기본 단계를 쓴다).
    case 'traffic.snapshot': {
      const { steps, ...data } = event.data
      return { ...event, data: { ...data, ...(steps?.length ? { steps } : {}), notes: data.notes ?? [], results: data.results ?? [] } }
    }
    case 'snapshot':
      return { ...event, data: { ...event.data, events: (event.data.events ?? []).map(normalizeEvent) } }
    default:
      return event
  }
}
