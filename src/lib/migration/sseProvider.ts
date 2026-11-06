import { isBackendPreview, normalizePlanStep, startRequestFor, type ApprovalDecisionData, type BackendPhase, type ErrorData, type MigrationEvent, type MigrationStatus, type PlanReadyData, type StartRequest } from './events.ts'
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
  /**
   * 승인 중계(BFF) 주소(예: /api/approvals). 있으면 계획 승인·거절·다시 전달을 플랫폼이 아니라 우리 웹 서버로 보낸다:
   * 플랫폼 승인 API는 승인자 토큰(Bearer)이 필요하고, 그 토큰은 웹 서버만 갖는다(PLATFORM_APPROVER_TOKEN).
   * 없으면 예전처럼 baseUrl의 플랫폼 경로로 직접 보낸다(목업 SSE 서버 단독 시험용).
   */
  approvalBase?: string
}

/** 이전을 시작하지 않고 멈춘 이유(StatusPanel이 실패가 아니라 대기 안내로 보여 준다). */
export const BACKEND_PENDING = 'backend_pending'
export const SOURCE_REQUIRED = 'source_required'

// 백엔드 시작 요청의 project_id. 프로젝트 개념이 정해지기 전까지 고정값을 쓴다.
const PROJECT_ID = 'demo'
const RETRY_FIRST_MS = 500
const RETRY_MAX_MS = 5000
/** 서버가 이 상태가 되면 남은 이벤트를 보내고 스트림을 닫는다(event_stream.py). 그 뒤의 정상 종료는 끊김이 아니다. */
const TERMINAL: ReadonlySet<MigrationStatus> = new Set(['done', 'failed', 'cancelled'])

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
  /** 받은 snapshot·이벤트로 짐작한 이전 상태. 끝난 이전이면 스트림이 닫혀도 다시 연결하지 않는다. */
  private status: MigrationStatus = 'idle'
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

  /**
   * POST를 보내고 응답 본문(JSON이 아니면 null)을 돌려준다. 실패하면 화면에 요청 실패를 알리고 undefined.
   * to: 이전 경로(/migrations/{id} 뒤) · 플랫폼 절대 경로(baseUrl 뒤) · 웹 서버 중계 주소(그대로).
   * 오류 본문의 detail이 코드(APPROVER_TOKEN_NOT_CONFIGURED 등)면 함께 넘겨 화면이 원인 문구를 보여 준다.
   */
  private async post(path: string, body?: object, to: 'migration' | 'platform' | 'relay' = 'migration'): Promise<unknown> {
    if (!this.migrationId) return undefined
    try {
      const url = to === 'relay' ? path : this.options.baseUrl + (to === 'platform' ? '' : '/migrations/' + this.migrationId) + path
      const headers: Record<string, string> = body ? { 'Content-Type': 'application/json' } : {}
      const response = await fetch(url, {
        method: 'POST',
        // 중계(같은 출처)에는 플랫폼용 헤더를 붙이지 않는다. 로그인 쿠키는 브라우저가 붙인다.
        headers: to === 'relay' ? headers : await this.headers(headers),
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { detail?: unknown } | null
        const detail = typeof data?.detail === 'string' && /^[A-Z0-9_]{1,64}$/.test(data.detail) ? data.detail : undefined
        this.fail({ code: 'request_failed', message: 'HTTP ' + response.status, phase: null, retryable: true, ...(detail ? { detail } : {}) })
        return undefined
      }
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

  /** 시연용 쿼리(?review=1 · ?preflight=route|unknown · ?cutover=classic|kill|tamper|tamper-classic)를 목업 서버에 넘긴다. 실제 백엔드는 무시한다. */
  private demoQuery() {
    if (typeof window === 'undefined') return ''
    const search = new URLSearchParams(window.location.search)
    const query = new URLSearchParams()
    if (search.get('review') === '1') query.set('review', '1')
    const preflight = search.get('preflight')
    if (preflight === 'route' || preflight === 'unknown') query.set('preflight', preflight)
    const cutover = search.get('cutover')
    if (cutover && cutover !== 'fast' && ['classic', 'kill', 'tamper', 'tamper-classic'].includes(cutover)) query.set('cutover', cutover)
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
    this.status = 'idle'
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
   * 본문 {decision: APPROVE|REJECT, scope, manifest_digest, preview_digest}, 승인자 인증은 Bearer 토큰.
   * approvalBase가 있으면(실제 모드) 웹 서버 중계 {approvalBase}/{plan_id}/{revision}로 보내고, 웹 서버가 토큰을 붙인다.
   * plan.ready에 계획 ID·버전·digest가 없으면 옛 경로로 보낸다. 옛 경로 [확정: 학습용 뼈대] POST /migrations/{id}/approve
   */
  private decide(decision: 'APPROVE' | 'REJECT', fallback: () => void) {
    const plan = this.plan
    if (!plan?.plan_id || plan.revision === undefined || !plan.manifest_digest || !plan.preview_digest) { fallback(); return }
    const relay = this.options.approvalBase?.replace(/\/+$/, '')
    const to = relay ? 'relay' : 'platform'
    const path = relay
      ? relay + '/' + encodeURIComponent(plan.plan_id) + '/' + plan.revision
      : '/provisioning/plans/' + encodeURIComponent(plan.plan_id) + '/revisions/' + plan.revision + '/approvals'
    // 같은 계획 버전의 승인이 기록됐지만 전달에 실패했으면, 새로 결정하지 않고 같은 승인을 다시 전달한다(openapi: POST …/approvals/{approval_id}/delivery).
    const last = this.decision
    const redeliver = decision === 'APPROVE' && last && last.decision === 'APPROVE' && last.plan_id === plan.plan_id && last.revision === plan.revision && last.delivery_status === 'FAILED'
    const request = redeliver
      ? this.post(path + '/' + encodeURIComponent(last.approval_id) + '/delivery', undefined, to)
      : this.post(path, { decision, scope: 'FULL', manifest_digest: plan.manifest_digest, preview_digest: plan.preview_digest }, to)
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
        // 끝난 이전이면 서버가 남은 이벤트를 보내고 스트림을 닫는다: 정상 종료다(다시 연결하지 않는다).
        if (TERMINAL.has(this.status)) return
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

  /**
   * SSE 블록 하나(id·event·data 줄)를 이벤트로 바꿔 상태에 보낸다. 주석(:)과 빈 data는 무시한다.
   * 옛 화면용 Workflow 상태 블록(event: status)은 이전 이벤트가 아니므로 건너뛴다(parseSseBlock).
   */
  private handleBlock(block: string) {
    const parsed = parseSseBlock(block)
    if (!parsed) return
    let event = parsed.event
    if (parsed.id) this.lastId = parsed.id
    event = normalizeEvent(event)
    if (event.type === 'plan.ready') this.plan = event.data
    if (event.type === 'approval.decision') this.decision = event.data
    this.status = statusAfter(this.status, event)
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
 * SSE 블록 하나를 읽는다. 이전 이벤트가 아니면 null:
 * - 주석(: heartbeat)뿐이거나 data가 없는 블록
 * - 이름이 data의 type과 다른 블록(event: status, 백엔드가 옛 화면용으로 보내는 Workflow 상태).
 *   백엔드는 이전 이벤트를 이름 없이(기본 message), 목업 서버는 type을 이름으로 보낸다: 둘 다 받는다.
 * - JSON이 아니거나 type·seq가 없는 data
 */
export function parseSseBlock(block: string): { id: string; event: MigrationEvent } | null {
  let id = ''
  let name = ''
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'id') id = value
    else if (field === 'event') name = value
    else if (field === 'data') data.push(value)
  }
  if (data.length === 0) return null
  let event: unknown
  try { event = JSON.parse(data.join('\n')) } catch { return null }
  if (!event || typeof event !== 'object') return null
  const { type, seq } = event as { type?: unknown; seq?: unknown }
  if (typeof type !== 'string' || typeof seq !== 'number') return null
  if (name && name !== 'message' && name !== type) return null
  return { id, event: event as MigrationEvent }
}

/** 이벤트 하나를 받은 뒤의 이전 상태 짐작(백엔드 migration_status와 같은 규칙: snapshot 상태, error, 마지막 인계). */
export function statusAfter(current: MigrationStatus, event: MigrationEvent): MigrationStatus {
  if (event.type === 'snapshot') return event.data.status
  if (event.type === 'error') return event.data.code === 'cancelled' ? 'cancelled' : 'failed'
  if (event.type === 'cutover.handover' && event.data.item === 'access' && event.status === 'done') return 'done'
  return current
}

/**
 * 서버 값을 화면이 읽는 모양으로 맞춘다 [가정: 백엔드 계약 미정].
 * - plan.step: 예전 등급(direct/convert/none)과 빠진 처리·원본 유지·검증 상태를 채운다.
 * - plan.preview: 빠진 목록은 빈 목록으로(백엔드 Preview 모양도 받는다).
 * - traffic.prepare·traffic.snapshot [가정]: 빠진 목록은 빈 목록으로.
 * - snapshot 안의 이벤트도 같은 규칙으로.
 */
export function normalizeEvent(event: MigrationEvent): MigrationEvent {
  switch (event.type) {
    case 'plan.step':
      return { ...event, data: normalizePlanStep(event.data) }
    case 'plan.preview': {
      const data = event.data
      // 백엔드 Preview 모양은 reducer가 매핑과 함께 옮긴다(previewAdapter). 빠진 목록만 채운다.
      if (isBackendPreview(data)) return { ...event, data: { ...data, changes: data.changes ?? [], applied_defaults: data.applied_defaults ?? [], warnings: data.warnings ?? [], errors: data.errors ?? [], pending_decisions: data.pending_decisions ?? [] } }
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
