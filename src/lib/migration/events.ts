/**
 * 백엔드 SSE 이벤트 계약(초안). 형식이 바뀔 수 있으므로 이벤트 타입은 이 모듈 한 곳에만 정의한다.
 * 이 파일은 타입만 담는다(런타임 import 없음): 목업 서버와 단위 테스트가 Node에서 그대로 읽는다.
 */

export type Target = 'gcp' | 'onprem'

/** 백엔드 워크플로우의 phase 이름 */
export type BackendPhase =
  | 'analysis' | 'build' | 'planning' | 'awaiting_approval'
  | 'provisioning' | 'data_copy' | 'traffic' | 'verification'

/** 프론트 단계 → 백엔드 phase 대응(stages.ts의 RAIL과 같다). 값이 없는 단계(intro·setup)는 데이터 계층이 다루지 않는다. */
export const PHASE_OF_STAGE = {
  analysis: 'analysis', rehearsal: 'build', planning: 'planning', approval: 'awaiting_approval',
  provisioning: 'provisioning', data: 'data_copy', traffic: 'traffic', cutover: 'verification',
} as const satisfies Record<string, BackendPhase>

export type EventStatus = 'running' | 'done' | 'failed' | 'waiting'

// ---- 이벤트별 data ----

export type ScanMethod = 'code' | 'iam' | 'trail' | 'config'

/** 분석에서 발견한 항목. message·detail이 비면 화면이 key로 자기 문구를 쓴다. */
export type AnalysisFindingData = {
  id: string
  stream: 'infrastructure' | 'code'
  key: string
  via: ScanMethod[]
  progress: number
  message: string
  detail: string
}

export type CheckState = 'running' | 'failed' | 'fixing' | 'recheck' | 'done'
export type BuildCheckData = { id: string; state: CheckState; fixed?: number }
export type FixLine = { kind: 'del' | 'add'; text: string }
export type BuildFixData = { id: string; check: string; lines: FixLine[]; why: string; evidence: string }

export type Grade = 'direct' | 'convert' | 'none'
export type PlanStepData = {
  id: string
  group: 'infrastructure' | 'code'
  grade: Grade
  before: string
  after: string
  evidence: string
  change: string
}

export type ApprovalRequiredData = {
  excluded: string[]
  rollback_policy: string
  /** 두 번째 승인(DB 전환)이면 'cutover'. 비어 있으면 계획 승인이다. */
  gate?: 'cutover'
}

export type ProvisionResourceData = { id: string; key: string; state: 'running' | 'done' | 'failed'; progress: number }

export type DataStep = 'connect' | 'dump' | 'cdc' | 'ready'
export type DataProgressData = {
  step: DataStep
  rows: number
  total_rows: number
  lag_ms: number | null
  writes_per_sec: number
  dump_percent: number
}

export type TrafficPhase = 'applying' | 'observing' | 'gate' | 'complete' | 'rolledback'
/** 트래픽 피드에 남길 기록. key로 화면이 자기 문구를 고른다. restart는 피드를 비우라는 뜻이다. */
export type TrafficNote = { key: 'apply' | 'gatePass' | 'gateFail' | 'reached' | 'manual' | 'inject' | 'drained' | 'restart'; params?: Record<string, string | number> }
export type TrafficSnapshotData = {
  phase: TrafficPhase
  weights: { origin: number; target: number }
  step: 10 | 50 | 100
  gate: {
    failed_requests: number
    max_failed_requests: number
    p99_ratio: number
    max_p99_ratio: number
    observe_left_seconds: number
  }
  residual: { requests_per_sec: number; streams: number }
  decision?: 'advance' | 'rollback' | 'done'
  notes?: TrafficNote[]
}

/** state: running(진행 중) → done(완료) 이고 verify는 6단계가 끝난 뒤 측정 구간에 들어갔다는 표시다. */
export type CutoverStepData = { n: 1 | 2 | 3 | 4 | 5 | 6; state: 'running' | 'done' | 'verify' }
export type CutoverResultData = { id: 'fail' | 'delay' | 'loss'; value: string }

export type ErrorData = { code: string; message: string; phase: BackendPhase | null; retryable: boolean }

export type MigrationStatus = 'idle' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'

/** 연결 직후(재접속 포함) 오는 상태 복원 이벤트. reset이면 화면 상태를 비우고 events로 다시 쌓는다. */
export type SnapshotData = {
  migration_id: string
  status: MigrationStatus
  reset: boolean
  events: MigrationEvent[]
}

type Base<Type extends string, Data> = {
  seq: number
  /** UTC ISO */
  at: string
  phase: BackendPhase
  type: Type
  status: EventStatus
  progress?: number
  message?: string
  data: Data
}

export type MigrationEvent =
  | Base<'snapshot', SnapshotData>
  | Base<'analysis.finding', AnalysisFindingData>
  | Base<'analysis.done', Record<string, never>>
  | Base<'build.check', BuildCheckData>
  | Base<'build.fix', BuildFixData>
  | Base<'plan.step', PlanStepData>
  | Base<'plan.ready', Record<string, never>>
  | Base<'approval.required', ApprovalRequiredData>
  | Base<'provision.resource', ProvisionResourceData>
  | Base<'data.progress', DataProgressData>
  | Base<'traffic.snapshot', TrafficSnapshotData>
  | Base<'cutover.step', CutoverStepData>
  | Base<'cutover.result', CutoverResultData>
  | Base<'error', ErrorData>

export type MigrationEventType = MigrationEvent['type']
/** 대본·서버가 만드는 이벤트(seq·at은 내보낼 때 붙인다) */
export type DraftEvent = MigrationEvent extends infer E ? E extends MigrationEvent ? Omit<E, 'seq' | 'at'> : never : never

/** 이전 시작 요청. 설정 화면의 나머지 입력(자격 증명 등)은 전달 방식이 정해질 때까지 보내지 않는다. */
export type StartRequest = { target: Target }

/** 리포트(GET /migrations/{id}/report). 단계별 소요 시간과 AI 수정 개수. */
export type ReportData = {
  stages: Array<{ id: string; seconds: number }>
  ai_fixes: number
}
