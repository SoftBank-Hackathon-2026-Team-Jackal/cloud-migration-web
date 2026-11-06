/**
 * 이벤트를 화면이 읽는 상태로 바꾸는 reducer. 순수 함수만 두고 React에 의존하지 않는다(런타임 import는 순수 모듈 events·previewAdapter뿐).
 * 같은 id의 이벤트는 덮어쓰므로(upsert) 재접속·단계 재전송으로 같은 이벤트가 다시 와도 결과가 같다.
 */
import type {
  AnalysisFindingData, AnalysisScanData, BackendPreviewData, ApprovalDecisionData, ApprovalRequiredData, DataVerifyData, HandoverData, TrafficReadyData, BackendPhase, BuildCheckData, BuildFixData, BuildResultData, BuildReviewData, PlanPreviewData, PlanReadyData, ProvisionCheckData, CutoverResultData, CutoverPlanData, CutoverReadyData, CutoverStepData, CutoverOutcomeData, CutoverVerifyData,
  DataProgressData, ErrorData, MigrationEvent, MigrationStatus, PlanStepData, ProvisionResourceData,
  ReportData, TrafficNote, TrafficPrepareData, TrafficSnapshotData,
  DataLsnData, DataPhase, DataPreflightData, DataReadinessData, DataTableData,
  SandboxAttemptData, SandboxDoneData, SandboxEnvData, SandboxStep, SandboxStepData, SandboxTestsData,
} from './events'
import { isBackendPreview, normalizeEvidence } from './events.ts'
import { adaptBackendPreview } from './previewAdapter.ts'

export const LAG_HISTORY_POINTS = 48
/** 복제 지연 오실로스코프가 그리는 표본 수(data.lsn, 250ms마다 → 약 40초) */
export const LAG_TRACE_POINTS = 160
const TRAFFIC_LOG_LIMIT = 30
/** 게이트 패널의 p99 추이에 남길 점 수 */
export const TRAFFIC_TRACE_POINTS = 160

/** activity: Temporal Activity 이름(서버가 보낸 값, 없으면 화면이 key로 기본 이름을 고른다). prepareFail은 사전 확인 실패. */
export type TrafficLogEntry = { id: number; at: string; key: Exclude<TrafficNote['key'], 'restart'> | 'prepareFail'; params: Record<string, string | number>; activity?: string }
export type Failure = { code: string; message: string; retryable: boolean }

export type MigrationState = {
  migrationId: string | null
  status: MigrationStatus
  /** 연결이 끊겨 다시 연결하는 중이면 reconnecting */
  connection: 'connected' | 'reconnecting'
  lastSeq: number
  /** findings: 예전 방식(항목마다 한 건) · scans: 스캔 Activity가 끝날 때마다 한 건(백엔드 방식, 개수 묶음) */
  analysis: { findings: AnalysisFindingData[]; scans: AnalysisScanData[]; done: boolean }
  /** attempt: 지금 몇 번째 시도인지(build.check·build.result에서). review: 사람 검토 대기 */
  build: { checks: Record<string, BuildCheckData>; lastCheck: BuildCheckData | null; fixes: BuildFixData[]; attempt: number | null; result: BuildResultData | null; review: BuildReviewData | null }
  /** 샌드박스 검증 루프: steps[트랙 순번][단계], attempts는 판정이 끝난 트랙들 */
  sandbox: { env: SandboxEnvData | null; steps: Record<number, Partial<Record<SandboxStep, SandboxStepData['state']>>>; tests: SandboxTestsData | null; attempts: SandboxAttemptData[]; done: SandboxDoneData | null }
  /** preview: 계획 미리보기(만들 리소스·재매핑·보안 규칙·검증). 없으면 화면은 매핑 항목만 보인다. */
  /** backend: 백엔드 Preview 원본. 오면 preview는 이 값과 매핑·계획 완료 값으로 다시 만든다(previewAdapter). */
  plan: { steps: PlanStepData[]; ready: boolean; meta: PlanReadyData | null; preview: PlanPreviewData | null; backend: BackendPreviewData | null }
  /** decision: 승인 결정의 접수·전달·실행 상태(approval.decision 또는 승인 API 응답). 전달 전에는 완료가 아니다. */
  /** pendingDecisions: 승인 요청이 보낸 정해야 할 값(code). 계획 미리보기의 pending_decisions와 함께 요약에 쓴다. */
  approval: { required: boolean; excluded: string[]; rollbackPolicy: string; pendingDecisions: string[]; cutoverRequired: boolean; decision: ApprovalDecisionData | null }
  provision: { resources: ProvisionResourceData[]; checks: ProvisionCheckData[] }
  /** preflight·phase·lsn·lagTrace·tables·readiness: 데이터 이전 단계 상세(사전 검사 → 스키마 → 초기 복사 → CDC → 스트리밍) [가정] */
  data: {
    current: DataProgressData | null; lagHistory: number[]; verify: DataVerifyData[]
    preflight: DataPreflightData | null; phase: DataPhase | null; lsn: DataLsnData | null; lagTrace: number[]; tables: DataTableData[]; readiness: DataReadinessData | null
  }
  /** prepare: 사전 확인·연결 정보 [가정]. trace: 관찰 중 p99 비율 추이. startedAt: 이 단계의 첫 이벤트 시각(기록의 +초 기준) */
  traffic: { snapshot: TrafficSnapshotData | null; logs: TrafficLogEntry[]; logCounter: number; ready: TrafficReadyData | null; prepare: TrafficPrepareData | null; trace: number[]; startedAt: string | null }
  /**
   * plan: 승인 2/2가 읽는 전환 계획 · ready: 전환 가능 시점 · steps: 쓰기 중단 구간 단계(받은 순서, n순) ·
   * outcome: 전환 결과(통과·거부) · tables: 테이블별 검증 · attempt: 몇 번째 전환 시도인지 [가정]
   */
  cutover: {
    doneSteps: number; verifying: boolean; results: CutoverResultData[]; handover: HandoverData[]
    plan: CutoverPlanData | null; ready: CutoverReadyData | null; steps: CutoverStepData[]; outcome: CutoverOutcomeData | null; tables: CutoverVerifyData[]; attempt: number
  }
  report: ReportData | null
  failures: Partial<Record<BackendPhase, Failure>>
  error: ErrorData | null
}

export const initialState: MigrationState = {
  migrationId: null,
  status: 'idle',
  connection: 'connected',
  lastSeq: 0,
  analysis: { findings: [], scans: [], done: false },
  build: { checks: {}, lastCheck: null, fixes: [], attempt: null, result: null, review: null },
  sandbox: { env: null, steps: {}, tests: null, attempts: [], done: null },
  plan: { steps: [], ready: false, meta: null, preview: null, backend: null },
  approval: { required: false, excluded: [], rollbackPolicy: '', pendingDecisions: [], cutoverRequired: false, decision: null },
  provision: { resources: [], checks: [] },
  data: { current: null, lagHistory: [], verify: [], preflight: null, phase: null, lsn: null, lagTrace: [], tables: [], readiness: null },
  traffic: { snapshot: null, logs: [], logCounter: 0, ready: null, prepare: null, trace: [], startedAt: null },
  cutover: { doneSteps: 0, verifying: false, results: [], handover: [], plan: null, ready: null, steps: [], outcome: null, tables: [], attempt: 0 },
  report: null,
  failures: {},
  error: null,
}

export type Action =
  | { type: 'event'; event: MigrationEvent }
  | { type: 'reset' }
  /** 목업 전용: 단계 화면을 떠날 때 그 단계의 값을 비운다(다시 들어오면 처음부터 시작한다). */
  | { type: 'resetPhase'; phase: BackendPhase }
  | { type: 'started'; migrationId: string }
  | { type: 'connection'; value: MigrationState['connection'] }
  | { type: 'report'; report: ReportData }
  | { type: 'cancelled' }
  /** 승인 API 응답(ApprovalResponse)을 이벤트와 같은 자리에 넣는다. */
  | { type: 'approvalDecision'; data: ApprovalDecisionData }
  /** 공급자가 직접 알리는 실패(요청 실패, 이전을 찾을 수 없음 등) */
  | { type: 'fail'; error: ErrorData }

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex(entry => entry.id === item.id)
  if (index < 0) return [...list, item]
  const next = list.slice()
  next[index] = item
  return next
}

function addTrafficLogs(state: MigrationState, data: TrafficSnapshotData, at: string) {
  let logs = state.traffic.logs
  let counter = state.traffic.logCounter
  let trace = state.traffic.trace
  for (const note of data.notes ?? []) {
    if (note.key === 'restart') { logs = []; trace = []; continue }
    counter += 1
    logs = [{ id: counter, at, key: note.key, params: note.params ?? {}, ...(note.activity ? { activity: note.activity } : {}) }, ...logs].slice(0, TRAFFIC_LOG_LIMIT)
  }
  // 관찰 중·판정 중의 p99 비율만 추이에 남긴다(가중치 적용 중에는 아직 관찰하지 않는다).
  if (data.phase === 'observing' || data.phase === 'gate') trace = [...trace, data.gate.p99_ratio].slice(-TRAFFIC_TRACE_POINTS)
  return { logs, logCounter: counter, trace }
}

/** 사전 확인 결과. 끝난(done·failed) 결과가 처음 올 때만 기록에 남긴다(재전송으로 겹쳐 와도 한 번). */
function applyTrafficPrepare(state: MigrationState, data: TrafficPrepareData, at: string): MigrationState['traffic'] {
  const traffic = state.traffic
  const finished = data.state === 'done' || data.state === 'failed'
  const already = traffic.prepare?.state === data.state
  let logs = traffic.logs
  let counter = traffic.logCounter
  if (finished && !already) {
    counter += 1
    const params: Record<string, string | number> = {}
    if (data.target?.external_endpoint) params.endpoint = data.target.external_endpoint
    if (data.reason) params.reason = data.reason
    logs = [{ id: counter, at, key: data.state === 'failed' ? 'prepareFail' as const : 'prepare' as const, params }, ...logs].slice(0, TRAFFIC_LOG_LIMIT)
  }
  return { ...traffic, prepare: data, logs, logCounter: counter, startedAt: traffic.startedAt ?? at }
}

/**
 * 같은 승인(approval_id)의 상태는 뒤로 가지 않는다: 이벤트와 API 응답이 엇갈려 와도 DELIVERED가 PENDING으로 돌아가지 않게 한다.
 * 다시 전달(재시도)로 시도 횟수가 늘면 FAILED → PENDING/DELIVERED는 받아들인다.
 */
const DELIVERY_RANK = { PENDING: 0, FAILED: 1, DELIVERED: 2 } as const
export function mergeDecision(current: ApprovalDecisionData | null, incoming: ApprovalDecisionData): ApprovalDecisionData {
  if (!current || current.approval_id !== incoming.approval_id) return incoming
  if (incoming.delivery_attempts > current.delivery_attempts) return incoming
  if (incoming.delivery_attempts < current.delivery_attempts) return current
  return DELIVERY_RANK[incoming.delivery_status] >= DELIVERY_RANK[current.delivery_status] ? incoming : { ...current, execution_status: incoming.execution_status }
}

/** 백엔드 Preview가 와 있으면 매핑·계획 완료 값이 바뀔 때마다 화면 미리보기를 다시 만든다(원본 유지·Digest 고정을 매핑에서 채우므로). */
function withPreview(plan: MigrationState['plan'], digest: string | null | undefined): MigrationState['plan'] {
  return plan.backend ? { ...plan, preview: adaptBackendPreview(plan.backend, { steps: plan.steps, meta: plan.meta, digest }) } : plan
}

function fail(state: MigrationState, phase: BackendPhase, failure: Failure): MigrationState {
  return { ...state, status: 'failed', failures: { ...state.failures, [phase]: failure } }
}

/** seq 검사 없이 이벤트 하나를 상태에 반영한다. */
function applyEvent(state: MigrationState, event: MigrationEvent): MigrationState {
  let next: MigrationState = state
  // 일시 정지(승인 대기) 중이던 이전은 다음 이벤트가 오면 다시 진행 중이다.
  if (state.status === 'idle' || state.status === 'waiting') next = { ...next, status: 'running' }
  if (event.status === 'failed' && event.type !== 'error') {
    next = fail(next, event.phase, { code: event.type, message: event.message ?? '', retryable: false })
  }
  switch (event.type) {
    case 'snapshot':
      return next
    case 'analysis.finding':
      return { ...next, analysis: { ...next.analysis, findings: upsert(next.analysis.findings, event.data) } }
    case 'analysis.scan': {
      const scan = { ...event.data, items: event.data.items ?? [], evidence: (event.data.evidence ?? []).map(normalizeEvidence) }
      return { ...next, analysis: { ...next.analysis, scans: upsert(next.analysis.scans, scan) } }
    }
    case 'analysis.done':
      return { ...next, analysis: { ...next.analysis, done: true } }
    case 'build.check':
      return { ...next, build: { ...next.build, checks: { ...next.build.checks, [event.data.id]: event.data }, lastCheck: event.data, attempt: event.data.attempt ?? next.build.attempt } }
    case 'build.result':
      // 새 시도의 결과가 오면 사람 검토 대기는 끝난 것이다(수정 후 재시도).
      return { ...next, build: { ...next.build, result: event.data, attempt: event.data.attempt, review: null } }
    case 'build.review':
      return { ...next, status: 'waiting', build: { ...next.build, review: event.data } }
    case 'sandbox.env':
      return { ...next, sandbox: { ...next.sandbox, env: event.data } }
    case 'sandbox.step': {
      const { run, attempt, step, state } = event.data
      // 사람 검토 뒤 다시 돌기 시작하면 지난 끝(NEEDS_REVIEW)과 검토 대기를 지운다.
      const resumed = next.sandbox.done?.status === 'NEEDS_REVIEW'
      return { ...next, build: { ...next.build, attempt, ...(resumed ? { review: null } : {}) }, sandbox: { ...next.sandbox, ...(resumed ? { done: null } : {}), steps: { ...next.sandbox.steps, [run]: { ...next.sandbox.steps[run], [step]: state } } } }
    }
    case 'sandbox.tests':
      return { ...next, sandbox: { ...next.sandbox, tests: event.data } }
    case 'sandbox.attempt':
      return { ...next, build: { ...next.build, attempt: event.data.attempt }, sandbox: { ...next.sandbox, attempts: [...next.sandbox.attempts.filter(item => item.run !== event.data.run), event.data].sort((a, b) => a.run - b.run) } }
    case 'sandbox.done': {
      const sandbox = { ...next.sandbox, done: event.data }
      // 사람 검토로 멈춤: build.review가 따로 오지 않아도 검토 안내(수정 후 재시도·취소)를 띄운다.
      if (event.data.status === 'NEEDS_REVIEW') {
        const attempts = Math.max(1, next.build.attempt ?? 0, ...next.sandbox.attempts.map(item => item.attempt))
        return { ...next, status: 'waiting', sandbox, build: { ...next.build, review: next.build.review ?? { reason: 'max_attempts', attempts } } }
      }
      // 검증 실패로 끝남: 뒤따르는 error 이벤트가 없어도 샌드박스 화면이 실패 안내를 보인다(error가 오면 그 코드로 바뀐다).
      if (event.data.status === 'FAILED' && !next.failures.build) {
        return { ...fail(next, 'build', { code: 'SANDBOX_FAILED', message: event.message ?? '', retryable: false }), sandbox }
      }
      return { ...next, sandbox }
    }
    case 'build.fix':
      return { ...next, build: { ...next.build, fixes: upsert(next.build.fixes, event.data) } }
    case 'plan.step':
      return { ...next, plan: withPreview({ ...next.plan, steps: upsert(next.plan.steps, event.data) }, next.build.result?.digest) }
    case 'plan.preview': {
      const data = event.data
      return { ...next, plan: isBackendPreview(data)
        ? withPreview({ ...next.plan, backend: data }, next.build.result?.digest)
        : { ...next.plan, backend: null, preview: data } }
    }
    case 'plan.ready':
      return { ...next, plan: withPreview({ ...next.plan, ready: true, meta: Object.keys(event.data).length > 0 ? event.data : next.plan.meta }, next.build.result?.digest) }
    case 'approval.required': {
      const data: ApprovalRequiredData = event.data
      const approval = data.gate === 'cutover'
        ? { ...next.approval, cutoverRequired: true }
        : { ...next.approval, required: true, excluded: data.excluded ?? [], rollbackPolicy: data.rollback_policy ?? '', pendingDecisions: (data.pending_decisions ?? []).map(issue => issue.code) }
      return { ...next, status: 'waiting', approval }
    }
    case 'approval.decision':
      return { ...next, approval: { ...next.approval, decision: mergeDecision(next.approval.decision, event.data) } }
    case 'provision.resource':
      return { ...next, provision: { ...next.provision, resources: upsert(next.provision.resources, event.data) } }
    case 'provision.check': {
      const checks = next.provision.checks.slice()
      const index = checks.findIndex(item => item.name === event.data.name)
      if (index < 0) checks.push(event.data); else checks[index] = event.data
      return { ...next, provision: { ...next.provision, checks } }
    }
    case 'data.progress': {
      const lag = event.data.lag_ms
      const lagHistory = lag === null ? next.data.lagHistory : [...next.data.lagHistory.slice(-(LAG_HISTORY_POINTS - 1)), lag]
      return { ...next, data: { ...next.data, current: event.data, lagHistory } }
    }
    case 'data.verify': {
      const verify = next.data.verify.slice()
      const index = verify.findIndex(item => item.name === event.data.name)
      if (index < 0) verify.push(event.data); else verify[index] = event.data
      return { ...next, data: { ...next.data, verify } }
    }
    // ---- 데이터 이전 단계 상세 ----
    case 'data.preflight':
      return { ...next, data: { ...next.data, preflight: event.data } }
    case 'data.phase':
      return { ...next, data: { ...next.data, phase: event.data.phase } }
    case 'data.lsn': {
      const lag = event.data.lag_ms
      const lagTrace = lag === null ? next.data.lagTrace : [...next.data.lagTrace.slice(-(LAG_TRACE_POINTS - 1)), lag]
      return { ...next, data: { ...next.data, lsn: event.data, lagTrace } }
    }
    case 'data.table': {
      const tables = next.data.tables.slice()
      const index = tables.findIndex(item => item.name === event.data.name)
      if (index < 0) tables.push(event.data); else tables[index] = event.data
      return { ...next, data: { ...next.data, tables } }
    }
    case 'data.readiness':
      return { ...next, data: { ...next.data, readiness: event.data } }
    case 'traffic.ready':
      return { ...next, traffic: { ...next.traffic, ready: event.data } }
    case 'traffic.prepare':
      return { ...next, traffic: applyTrafficPrepare(next, event.data, event.at) }
    case 'traffic.snapshot':
      return { ...next, traffic: { ...next.traffic, snapshot: event.data, startedAt: next.traffic.startedAt ?? event.at, ...addTrafficLogs(next, event.data, event.at) } }
    case 'cutover.plan':
      return { ...next, cutover: { ...next.cutover, plan: event.data } }
    case 'cutover.ready': {
      // 새 시도(attempt가 바뀜)면 지난 시도의 단계·결과·검증·인계를 비운다. 계획은 남긴다.
      const fresh = event.data.attempt !== next.cutover.attempt
      const base = fresh ? { ...initialState.cutover, plan: next.cutover.plan } : next.cutover
      return { ...next, cutover: { ...base, ready: event.data, attempt: event.data.attempt } }
    }
    case 'cutover.step': {
      const { n, state: stepState } = event.data
      const doneSteps = stepState === 'running' ? Math.max(next.cutover.doneSteps, n - 1) : Math.max(next.cutover.doneSteps, n)
      // 단계 상태를 n순으로 쌓는다(같은 n은 덮어쓴다). 걸린 시간은 끝에 cutover.outcome.steps로 온다.
      const steps = stepState === 'verify'
        ? next.cutover.steps
        : [...next.cutover.steps.filter(step => step.n !== n), event.data].sort((a, b) => a.n - b.n)
      return { ...next, cutover: { ...next.cutover, doneSteps, steps, verifying: next.cutover.verifying || stepState === 'verify' } }
    }
    case 'cutover.outcome':
      return { ...next, cutover: { ...next.cutover, outcome: event.data } }
    case 'cutover.verify': {
      const tables = next.cutover.tables.slice()
      const index = tables.findIndex(item => item.table === event.data.table)
      if (index < 0) tables.push(event.data); else tables[index] = event.data
      return { ...next, cutover: { ...next.cutover, tables } }
    }
    case 'cutover.result': {
      const results = upsert(next.cutover.results, event.data)
      // 서버가 마지막 결과를 done으로 보내면 이전 완료. 예전 방식(실패·지연·유실 3개가 모두 모임)도 완료로 본다.
      const legacyDone = ['fail', 'delay', 'loss'].every(id => results.some(result => result.id === id))
      return { ...next, cutover: { ...next.cutover, results }, status: event.status === 'done' || legacyDone ? 'done' : next.status }
    }
    case 'cutover.handover': {
      const handover = next.cutover.handover.slice()
      const index = handover.findIndex(item => item.item === event.data.item)
      if (index < 0) handover.push(event.data); else handover[index] = event.data
      return { ...next, cutover: { ...next.cutover, handover } }
    }
    case 'error': {
      const phase = event.data.phase ?? event.phase
      if (event.data.code === 'cancelled') return { ...next, status: 'cancelled', error: event.data }
      return { ...fail(next, phase, { code: event.data.code, message: event.data.message, retryable: event.data.retryable }), error: event.data }
    }
    // 모르는 이벤트(서버가 먼저 새 이벤트를 보낸 경우): 상태를 망가뜨리지 않고 넘긴다.
    default:
      return next
  }
}

/** 단계 하나의 값을 초기 상태로 되돌린다. */
function clearPhase(state: MigrationState, phase: BackendPhase): MigrationState {
  const failures = { ...state.failures }
  delete failures[phase]
  const base = { ...state, failures }
  switch (phase) {
    case 'analysis': return { ...base, analysis: initialState.analysis }
    case 'build': return { ...base, build: initialState.build, sandbox: initialState.sandbox }
    case 'planning': return { ...base, plan: initialState.plan }
    case 'awaiting_approval': return { ...base, approval: initialState.approval }
    case 'provisioning': return { ...base, provision: initialState.provision }
    case 'data_copy': return { ...base, data: initialState.data }
    case 'traffic': return { ...base, traffic: initialState.traffic }
    case 'verification': return { ...base, cutover: initialState.cutover, approval: { ...base.approval, cutoverRequired: false } }
  }
}

export function reducer(state: MigrationState, action: Action): MigrationState {
  switch (action.type) {
    case 'reset':
      return { ...initialState, connection: state.connection, report: state.report }
    case 'resetPhase':
      return clearPhase(state, action.phase)
    case 'started':
      return { ...initialState, migrationId: action.migrationId, status: 'running', connection: state.connection, report: state.report }
    case 'connection':
      return state.connection === action.value ? state : { ...state, connection: action.value }
    case 'report':
      return { ...state, report: action.report }
    case 'cancelled':
      return { ...state, status: 'cancelled' }
    case 'approvalDecision':
      return { ...state, approval: { ...state.approval, decision: mergeDecision(state.approval.decision, action.data) } }
    case 'fail':
      return { ...fail(state, action.error.phase ?? 'analysis', { code: action.error.code, message: action.error.message, retryable: action.error.retryable }), error: action.error }
    case 'event': {
      const event = action.event
      if (event.type === 'snapshot') {
        const data = event.data
        let next: MigrationState = data.reset
          ? { ...initialState, connection: state.connection, report: state.report, migrationId: data.migration_id }
          : { ...state, migrationId: data.migration_id }
        for (const item of data.events) {
          if (item.seq > next.lastSeq || data.reset) next = { ...applyEvent(next, item), lastSeq: Math.max(next.lastSeq, item.seq) }
        }
        return { ...next, status: data.status, lastSeq: Math.max(next.lastSeq, event.seq) }
      }
      // 이미 반영한 이벤트(재접속으로 겹쳐 온 것)는 건너뛴다.
      if (event.seq <= state.lastSeq) return state
      return { ...applyEvent(state, event), lastSeq: event.seq }
    }
  }
}
