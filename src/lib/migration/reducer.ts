/**
 * 이벤트를 화면이 읽는 상태로 바꾸는 reducer. 순수 함수만 두고 React에 의존하지 않는다(런타임 import 없음).
 * 같은 id의 이벤트는 덮어쓰므로(upsert) 재접속·단계 재전송으로 같은 이벤트가 다시 와도 결과가 같다.
 */
import type {
  AnalysisFindingData, ApprovalRequiredData, DataVerifyData, HandoverData, TrafficReadyData, BackendPhase, BuildCheckData, BuildFixData, BuildResultData, BuildReviewData, PlanPreviewData, PlanReadyData, ProvisionCheckData, CutoverResultData,
  DataProgressData, ErrorData, MigrationEvent, MigrationStatus, PlanStepData, ProvisionResourceData,
  ReportData, TrafficNote, TrafficSnapshotData,
  DataLsnData, DataPhase, DataPreflightData, DataReadinessData, DataTableData,
  SandboxAttemptData, SandboxDoneData, SandboxEnvData, SandboxStep, SandboxStepData, SandboxTestsData,
} from './events'

export const LAG_HISTORY_POINTS = 48
/** 복제 지연 오실로스코프가 그리는 표본 수(data.lsn, 250ms마다 → 약 40초) */
export const LAG_TRACE_POINTS = 160
const TRAFFIC_LOG_LIMIT = 30

export type TrafficLogEntry = { id: number; at: string; key: Exclude<TrafficNote['key'], 'restart'>; params: Record<string, string | number> }
export type Failure = { code: string; message: string; retryable: boolean }

export type MigrationState = {
  migrationId: string | null
  status: MigrationStatus
  /** 연결이 끊겨 다시 연결하는 중이면 reconnecting */
  connection: 'connected' | 'reconnecting'
  lastSeq: number
  analysis: { findings: AnalysisFindingData[]; done: boolean }
  /** attempt: 지금 몇 번째 시도인지(build.check·build.result에서). review: 사람 검토 대기 */
  build: { checks: Record<string, BuildCheckData>; lastCheck: BuildCheckData | null; fixes: BuildFixData[]; attempt: number | null; result: BuildResultData | null; review: BuildReviewData | null }
  /** 샌드박스 검증 루프: steps[트랙 순번][단계], attempts는 판정이 끝난 트랙들 */
  sandbox: { env: SandboxEnvData | null; steps: Record<number, Partial<Record<SandboxStep, SandboxStepData['state']>>>; tests: SandboxTestsData | null; attempts: SandboxAttemptData[]; done: SandboxDoneData | null }
  /** preview: 계획 미리보기(만들 리소스·재매핑·보안 규칙·검증). 없으면 화면은 매핑 항목만 보인다. */
  plan: { steps: PlanStepData[]; ready: boolean; meta: PlanReadyData | null; preview: PlanPreviewData | null }
  approval: { required: boolean; excluded: string[]; rollbackPolicy: string; cutoverRequired: boolean }
  provision: { resources: ProvisionResourceData[]; checks: ProvisionCheckData[] }
  /** preflight·phase·lsn·lagTrace·tables·readiness: 데이터 이전 단계 상세(사전 검사 → 스키마 → 초기 복사 → CDC → 스트리밍) [가정] */
  data: {
    current: DataProgressData | null; lagHistory: number[]; verify: DataVerifyData[]
    preflight: DataPreflightData | null; phase: DataPhase | null; lsn: DataLsnData | null; lagTrace: number[]; tables: DataTableData[]; readiness: DataReadinessData | null
  }
  traffic: { snapshot: TrafficSnapshotData | null; logs: TrafficLogEntry[]; logCounter: number; ready: TrafficReadyData | null }
  cutover: { doneSteps: number; verifying: boolean; results: CutoverResultData[]; handover: HandoverData[] }
  report: ReportData | null
  failures: Partial<Record<BackendPhase, Failure>>
  error: ErrorData | null
}

export const initialState: MigrationState = {
  migrationId: null,
  status: 'idle',
  connection: 'connected',
  lastSeq: 0,
  analysis: { findings: [], done: false },
  build: { checks: {}, lastCheck: null, fixes: [], attempt: null, result: null, review: null },
  sandbox: { env: null, steps: {}, tests: null, attempts: [], done: null },
  plan: { steps: [], ready: false, meta: null, preview: null },
  approval: { required: false, excluded: [], rollbackPolicy: '', cutoverRequired: false },
  provision: { resources: [], checks: [] },
  data: { current: null, lagHistory: [], verify: [], preflight: null, phase: null, lsn: null, lagTrace: [], tables: [], readiness: null },
  traffic: { snapshot: null, logs: [], logCounter: 0, ready: null },
  cutover: { doneSteps: 0, verifying: false, results: [], handover: [] },
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
  for (const note of data.notes ?? []) {
    if (note.key === 'restart') { logs = []; continue }
    counter += 1
    logs = [{ id: counter, at, key: note.key, params: note.params ?? {} }, ...logs].slice(0, TRAFFIC_LOG_LIMIT)
  }
  return { logs, logCounter: counter }
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
      return { ...next, build: { ...next.build, attempt }, sandbox: { ...next.sandbox, steps: { ...next.sandbox.steps, [run]: { ...next.sandbox.steps[run], [step]: state } } } }
    }
    case 'sandbox.tests':
      return { ...next, sandbox: { ...next.sandbox, tests: event.data } }
    case 'sandbox.attempt':
      return { ...next, build: { ...next.build, attempt: event.data.attempt }, sandbox: { ...next.sandbox, attempts: [...next.sandbox.attempts.filter(item => item.run !== event.data.run), event.data].sort((a, b) => a.run - b.run) } }
    case 'sandbox.done':
      return { ...next, sandbox: { ...next.sandbox, done: event.data } }
    case 'build.fix':
      return { ...next, build: { ...next.build, fixes: upsert(next.build.fixes, event.data) } }
    case 'plan.step':
      return { ...next, plan: { ...next.plan, steps: upsert(next.plan.steps, event.data) } }
    case 'plan.preview':
      return { ...next, plan: { ...next.plan, preview: event.data } }
    case 'plan.ready':
      return { ...next, plan: { ...next.plan, ready: true, meta: Object.keys(event.data).length > 0 ? event.data : next.plan.meta } }
    case 'approval.required': {
      const data: ApprovalRequiredData = event.data
      const approval = data.gate === 'cutover'
        ? { ...next.approval, cutoverRequired: true }
        : { ...next.approval, required: true, excluded: data.excluded, rollbackPolicy: data.rollback_policy }
      return { ...next, status: 'waiting', approval }
    }
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
    case 'traffic.snapshot':
      return { ...next, traffic: { ...next.traffic, snapshot: event.data, ...addTrafficLogs(next, event.data, event.at) } }
    case 'cutover.step': {
      const { n, state: stepState } = event.data
      const doneSteps = stepState === 'running' ? Math.max(next.cutover.doneSteps, n - 1) : Math.max(next.cutover.doneSteps, n)
      return { ...next, cutover: { ...next.cutover, doneSteps, verifying: next.cutover.verifying || stepState === 'verify' } }
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
