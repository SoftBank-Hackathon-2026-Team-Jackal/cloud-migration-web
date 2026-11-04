/**
 * 백엔드 SSE 이벤트 계약(초안). 형식이 바뀔 수 있으므로 이벤트 타입은 이 모듈 한 곳에만 정의한다.
 * 이 파일은 타입만 담는다(런타임 import 없음): 목업 서버와 단위 테스트가 Node에서 그대로 읽는다.
 */

export type Target = 'gcp' | 'onprem'

/** 화면 흐름(구성도·구축 대본)이 쓰는 경로. 원본은 AWS이고 대상은 GCP·온프레미스다. */
/** 이미지 Digest 앞 12자리(sha256: 제외) */
export function shortDigest(digest: string | null | undefined): string {
  return digest ? digest.replace(/^sha256:/, '').slice(0, 12) : ''
}

export type FlowPath = 'gcp' | 'onprem'
export function pathOf(target: Target): FlowPath {
  return target === 'onprem' ? 'onprem' : 'gcp'
}

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
export type BuildCheckData = { id: string; state: CheckState; fixed?: number; attempt?: number }

export type BuildErrorCode = 'SOURCE_NOT_FOUND' | 'DOCKERFILE_MISSING' | 'BUILD_FAILED' | 'PUSH_FAILED' | 'TIMEOUT'
/** 이미지 빌드 결과(시도마다 하나). 실패해도 시도가 남아 있으면 status는 running이다(단계 실패가 아니다). */
export type BuildResultData = {
  attempt: number
  max_attempts: number
  status: 'SUCCEEDED' | 'FAILED'
  digest: string | null
  image_uri: string | null
  reused: boolean
  error_code: BuildErrorCode | null
}
/** 샌드박스 루프가 최대 시도를 넘어 사람 검토를 기다린다(status: waiting). */
export type BuildReviewData = { reason: 'max_attempts'; attempts: number }
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

/** 계획 완료. 필드는 모두 선택이라 예전의 빈 객체도 유효하다. */
export type PlanReadyData = { plan_id?: string; revision?: number; template_version?: string; built_digest?: string; verified_digest?: string }

export type ApprovalRequiredData = {
  excluded: string[]
  rollback_policy: string
  /** 두 번째 승인(DB 전환)이면 'cutover'. 비어 있으면 계획 승인이다. */
  gate?: 'cutover'
}

export type ProvisionResourceData = { id: string; key: string; state: 'running' | 'done' | 'failed'; progress: number }

export type ProvisionCheckName = 'pods_ready' | 'db_connect' | 'app_health' | 'retest'
/** 준비 상태 검사. retest는 승인 뒤 같은 테스트 묶음을 다시 돌린 결과(passed/total). */
export type ProvisionCheckData = { name: ProvisionCheckName; state: 'running' | 'done' | 'failed'; passed?: number; total?: number }

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
  | Base<'build.result', BuildResultData>
  | Base<'build.review', BuildReviewData>
  | Base<'plan.ready', PlanReadyData>
  | Base<'approval.required', ApprovalRequiredData>
  | Base<'provision.resource', ProvisionResourceData>
  | Base<'provision.check', ProvisionCheckData>
  | Base<'data.progress', DataProgressData>
  | Base<'traffic.snapshot', TrafficSnapshotData>
  | Base<'cutover.step', CutoverStepData>
  | Base<'cutover.result', CutoverResultData>
  | Base<'error', ErrorData>

export type MigrationEventType = MigrationEvent['type']
/** 대본·서버가 만드는 이벤트(seq·at은 내보낼 때 붙인다) */
export type DraftEvent = MigrationEvent extends infer E ? E extends MigrationEvent ? Omit<E, 'seq' | 'at'> : never : never

export type ProviderName = 'AWS' | 'GCP' | 'ON_PREM'
export const PROFILE_OF: Record<Target, { provider: ProviderName; profile: string }> = {
  gcp: { provider: 'GCP', profile: 'gcp-vm-basic' },
  onprem: { provider: 'ON_PREM', profile: 'onprem-k3s-basic' },
}
export const DEFAULT_REGION: Partial<Record<Target, string>> = { gcp: 'asia-northeast3' }

/**
 * 이전 시작 요청. 설정 화면의 나머지 입력(액세스 키, 저장소 주소)은 계속 보내지 않는다.
 * env_file_ref는 .env 파일의 내용이 아니라 참조 문자열만 담는다.
 */
export type StartRequest = {
  target: { provider: ProviderName; profile: string; region?: string; agent_id?: string; credential_ref?: string }
  env_file_ref?: string
}

/** 설정 화면의 선택으로 시작 요청을 만든다(profile은 provider에서 정한다). */
export function startRequestFor(target: Target, options: { region?: string; agentId?: string; envFileRef?: string } = {}): StartRequest {
  const { provider, profile } = PROFILE_OF[target]
  const request: StartRequest = { target: { provider, profile } }
  if (target === 'onprem') { if (options.agentId) request.target.agent_id = options.agentId }
  else request.target.region = options.region || DEFAULT_REGION[target]
  if (options.envFileRef) request.env_file_ref = options.envFileRef
  return request
}

/** 시작 요청에서 대상(gcp·onprem)을 읽는다. 예전 형식({target:'gcp'})도 받아 준다. */
export function targetOfRequest(request: { target: unknown }): Target {
  const raw = request.target
  if (raw === 'gcp' || raw === 'onprem') return raw
  const provider = typeof raw === 'object' && raw ? (raw as { provider?: string }).provider : undefined
  return provider === 'ON_PREM' ? 'onprem' : 'gcp'
}

/** 리포트(GET /migrations/{id}/report). 단계별 소요 시간과 AI 수정 개수. */
export type ReportData = {
  stages: Array<{ id: string; seconds: number }>
  ai_fixes: number
}
