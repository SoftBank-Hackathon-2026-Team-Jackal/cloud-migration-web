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
  provisioning: 'provisioning', data: 'data_copy', cutover: 'verification', traffic: 'traffic',
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

/* ==== 분석 스캔 배치(analysis.scan) · 근거 종류 [백엔드 정렬] ====
 * 백엔드는 항목마다 이벤트를 내지 못한다(매핑은 submit_mapping으로 한 번에 온다). 대신 스캔 Activity
 * (fetch_source · scan_manifests · scan_code · scan_aws_infra · scan_network)가 끝날 때마다 한 번, 찾은 개수를 묶어 보낼 수 있다.
 * 진행률은 n/m(끝난 스캔 수 / 전체 스캔 수)으로만 정확하다. 근거 종류는 cmp_contracts.analysis.Evidence.kind와 같다.
 */
export type EvidenceKind = 'CODE' | 'MANIFEST' | 'CLOUD_RESOURCE' | 'IAM_POLICY' | 'CLOUDTRAIL' | 'CONFIG'
export const EVIDENCE_KINDS: EvidenceKind[] = ['CODE', 'MANIFEST', 'CONFIG', 'CLOUD_RESOURCE', 'IAM_POLICY', 'CLOUDTRAIL']
/** 백엔드가 늘 verified=false로 두는 근거(읽기 전용 조회 결과라 실제 사용을 확인하지 않는다) */
export const ALWAYS_UNVERIFIED: EvidenceKind[] = ['CLOUD_RESOURCE', 'IAM_POLICY', 'CLOUDTRAIL']
/** locator: 파일:줄 · ARN · 매니페스트 경로처럼 언어와 무관한 위치 값 */
export type Evidence = { kind: EvidenceKind; locator: string; verified: boolean }
/** 스캔이 찾은 것 하나의 개수. sku는 인스턴스 유형처럼 요금 추정에 쓰는 값(있을 때만). */
export type ScanItem = { key: string; n: number; sku?: string }
export type AnalysisScanData = {
  /** 스캔 Activity 실행 id(같은 id가 다시 오면 덮어쓴다) */
  id: string
  /** Temporal Activity 이름. 화면은 이 이름으로 자기 문구를 고른다(모르는 이름은 그대로). */
  activity: string
  stream: 'infrastructure' | 'code'
  /** n/m: 이 흐름에서 끝난 스캔 수 / 전체 스캔 수 */
  completed: number
  total: number
  items: ScanItem[]
  evidence: Evidence[]
}
/** 예전 방식(항목마다 한 건)의 근거 칩 → Evidence.kind */
export const KIND_OF_METHOD: Record<ScanMethod, EvidenceKind> = { code: 'CODE', iam: 'IAM_POLICY', trail: 'CLOUDTRAIL', config: 'CONFIG' }
/** 서버가 보낸 근거를 맞춘다: CLOUD_RESOURCE·IAM_POLICY·CLOUDTRAIL은 언제나 미확인이다. */
export function normalizeEvidence(evidence: Evidence): Evidence {
  return { kind: evidence.kind, locator: evidence.locator ?? '', verified: ALWAYS_UNVERIFIED.includes(evidence.kind) ? false : !!evidence.verified }
}
/* ==== 분석 스캔 배치 끝 ==== */

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

/*
 * 샌드박스 검증 루프 [가정: SSE 이벤트 이름·필드는 백엔드와 미정].
 * 모양은 백엔드 계약을 따른다: cmp_contracts.verification(SandboxAttempt · SandboxVerification · BuildAttempt),
 * 흐름은 specs/analysis-verification AV-011~019 (렌더 → 적용 → 준비 검사 → 테스트 → 판정, 실패 분류·수정 루프, 정리).
 */
export type SandboxStep = 'render' | 'apply' | 'ready' | 'test' | 'judge'
export type SandboxFailureClass = 'SPEC' | 'CODE' | 'BUILD' | 'RENDER' | 'INFRA'
/** 실행마다 하나 띄우는 임시 Namespace. 원본은 읽기만 한다. */
export type SandboxEnvData = { namespace: string; expires_minutes: number; egress_allowed: number }
/** run: 화면의 트랙 순번(프론트 [가정]). 환경(INFRA) 재시도는 시도 횟수(attempt)를 늘리지 않으므로 같은 attempt의 run이 둘일 수 있다. */
export type SandboxStepData = { run: number; attempt: number; step: SandboxStep; state: 'running' | 'done' | 'failed' }
/** 테스트 묶음(출처별 개수, 읽기 전용 개수). 시도마다 같은 묶음을 고정해 쓴다. */
export type SandboxTestsData = { total: number; catalog: number; original: number; generated: number; read_only: number }
/** 판정 조건(AV-014): 필수 테스트 통과 · 지원하지 않는 호출 없음 · 실제 호출 ⊆ 매핑 · 차단된 출구 시도 0 */
export type SandboxChecks = { required_passed: number; required_total: number; unsupported_calls: number; calls_in_mapping: number; calls_total: number; blocked_egress: number }
/** SandboxAttempt: 시도 하나의 판정. fix_ids는 이 실패를 고친 build.fix id(없으면 빈 배열). */
export type SandboxAttemptData = {
  run: number
  attempt: number
  max_attempts: number
  verdict: { passed: boolean; reasons: string[] }
  failure_class: SandboxFailureClass | null
  checks: SandboxChecks
  fix_ids: string[]
}
/** SandboxVerification의 최종 상태와 정리 상태(검증 상태와 따로 보고한다). digest는 통과 시 고정된 이미지. */
export type SandboxDoneData = {
  status: 'PASSED' | 'FAILED' | 'NEEDS_REVIEW' | 'STOPPED_RENDER'
  cleanup_status: 'CLEANED' | 'FAILED' | 'PENDING'
  digest: string | null
}
export type FixLine = { kind: 'del' | 'add'; text: string }
/**
 * 수정 하나. file은 고친 파일 경로 [가정] — 있으면 "변경 내용 전체 보기"가 파일별로 묶는다.
 * new_env_keys [가정]: 이 수정으로 코드가 새로 읽게 된 환경 변수 이름(값 없음). 값을 어떻게 받을지는 미정이다.
 */
export type BuildFixData = { id: string; check: string; lines: FixLine[]; why: string; evidence: string; file?: string; new_env_keys?: string[] }

/*
 * 계획(매핑·미리보기) [가정: SSE 이벤트 이름·필드는 백엔드와 미정].
 * 값의 이름은 백엔드 명세를 따른다: specs/analysis-verification AV-008(매핑 등급·처리·검증 상태),
 * specs/provisioning PROV-014(Preview: 제공자·위치, 만들 리소스, 네트워크·보안 규칙, 검증 오류, Plan ID·Revision, 비밀값 없음).
 */
/** AV-008 매핑 등급: 그대로 대응 · API 차이 · 일부 대응 · 대응 없음 */
export type Grade = 'DIRECT' | 'API_DIFF' | 'PARTIAL' | 'NONE'
/** AV-008 처리: 진행 · 승인 필요 · 차단 */
export type MappingAction = 'PROCEED' | 'APPROVAL' | 'BLOCK'
/** 근거 수준: 확인 안 됨 · 근거 확인 · 샌드박스 검증 */
export type VerificationState = 'UNVERIFIED' | 'EVIDENCE_CHECKED' | 'SANDBOX_VERIFIED'
/** 구성도가 노드를 놓을 자리를 고르는 분류 [가정]. 없으면 화면이 id·문구로 짐작한다. */
export type PlanNodeKind = 'ingress' | 'network' | 'compute' | 'proxy' | 'database' | 'cache' | 'queue' | 'storage' | 'config' | 'other'
export type PlanStepData = {
  id: string
  group: 'infrastructure' | 'code'
  grade: Grade
  before: string
  after: string
  evidence: string
  change: string
  action: MappingAction
  /** AV-022 원본 유지: 이번 이전에서 옮기지 않고 원본을 그대로 쓴다(등급과 관계없이 원본 유지로 보인다). */
  keep_source: boolean
  verification: VerificationState
  kind?: PlanNodeKind
}

/** 원본·대상 환경 이름(예: AWS · EKS · ap-northeast-2). 문구가 아니라 값이다. */
export type PlanEnvironment = { provider: string; platform: string; location: string }
export type PlanResourceGroup = 'network' | 'compute' | 'data' | 'other'
/** 새로 만듦 · Digest 고정(검증한 이미지) · 원본 유지 · 바꿈 · 지움 · 기존 사용(대상에 이미 있다) */
export type PlanResourceChange = 'CREATE' | 'PINNED' | 'KEEP_SOURCE' | 'UPDATE' | 'DELETE' | 'EXISTING'
/** 만들 리소스 한 줄. name·detail이 비면 화면이 id로 자기 문구를 쓴다. size·size_detail은 값 그대로 보인다. */
export type PlanResource = {
  id: string
  group: PlanResourceGroup
  name: string
  detail: string
  size: string
  size_detail?: string
  change: PlanResourceChange
  kind?: PlanNodeKind
  /** 이 리소스에 걸린 경고(검증 경고와 같은 값이면 하나로 합쳐 보인다) */
  warning?: string
  /** 백엔드 Preview의 resource_type·quantity(어댑터가 옮긴 값). 요금 추정이 읽는다. */
  resource_type?: string
  quantity?: number
  /** 백엔드 ResourceChange.name(예: demo-gke). 화면 사전에 설명이 없을 때 보조 설명으로 보인다. */
  backend_name?: string
  /** Preview의 applied_defaults에서 온 줄(사용자가 정하지 않아 기본값을 쓴 리소스) */
  defaulted?: boolean
}
/** 환경변수 재매핑. 비밀값은 원문 없이 참조(to)만 온다. */
export type EnvRemap = { key: string; from: string; to: string; secret: boolean; keep?: boolean }
/** 보안 규칙. from·to는 internet·lb·app·db 같은 역할 이름(모르는 값은 그대로 보인다). '*'는 그 외 전부. */
export type SecurityRule = { from: string; to: string; port: number | null; protocol: 'TCP' | 'UDP' | 'ANY'; action: 'ALLOW' | 'DENY' }
/** 검증 문제. message가 비면 화면이 id로 자기 문구를 쓴다. resource는 걸린 리소스 id. */
export type PlanIssue = { id: string; resource?: string; message: string }
/**
 * 전환 방법 [가정: 백엔드 계약 없음]. traffic_steps는 대상 비율(%) 단계, traffic_method는 정해졌을 때만 온다
 * (Route 53 가중치·중계 프록시 중 아직 미정이라 비어 있으면 화면은 방식을 이름 붙이지 않는다).
 * expected_write_pause_ms는 DB 전환 순간의 예상 쓰기 중단, data_method는 데이터 복제 방식이다.
 */
export type PlanRollout = {
  traffic_steps: number[]
  traffic_method?: 'DNS_WEIGHTED' | 'PROXY_WEIGHTED' | (string & {})
  expected_write_pause_ms?: number
  data_method?: 'DUMP_CDC' | (string & {})
}
/**
 * 고정 요금 추정 한 줄 [가정]. id는 control·lb·nat·nodes 같은 항목 이름(모르는 id는 label을 보인다).
 * 값이 null이면 그 쪽은 아직 추정하지 못했다(화면은 '추정 대기'로 보인다). 단위는 USD/월.
 */
export type CostLine = { id: string; label?: string; source_usd: number | null; target_usd: number | null; excluded?: boolean }
/** 고정 요금 추정 [가정]. credits_usd는 대상 쪽에 적용되는 월 크레딧(예: GKE 클러스터 하나 무료), basis는 가격 조회 근거. */
export type CostEstimate = { currency: 'USD'; lines: CostLine[]; credits_usd?: number; basis?: string }
/**
 * 화면이 읽는 계획 미리보기. 백엔드 Preview(BackendPreviewData)는 previewAdapter가 이 모양으로 옮긴다.
 * source·target·env_remap·security_rules는 Preview에 없고 앱 Values·계획 입력에서 오므로 비어 있을 수 있다(화면은 그 칸을 숨긴다).
 */
export type PlanPreviewData = {
  plan_id: string
  revision: number
  source?: PlanEnvironment
  target?: PlanEnvironment
  resources: PlanResource[]
  env_remap: EnvRemap[]
  security_rules: SecurityRule[]
  validation: { errors: PlanIssue[]; warnings: PlanIssue[] }
  /** 사람이 정해야 승인할 수 있는 값(Preview pending_decisions, id = code) */
  pending_decisions?: PlanIssue[]
  manifest_digest?: string
  rollout?: PlanRollout
  cost?: CostEstimate
}

/* ==== 백엔드 Preview(cmp_contracts.plan.Preview) ==== */
export type PreviewResourceType = 'NETWORK' | 'CLUSTER' | 'NODE' | 'APP' | 'DATABASE' | 'STORAGE' | 'INGRESS'
export type PreviewAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'READ' | 'NO_CHANGE'
/** ResourceChange. size는 검토된 표시용 문자열(비밀값·Terraform 원문 없음). */
export type PreviewChange = { resource_type: PreviewResourceType | (string & {}); action: PreviewAction | (string & {}); name: string; quantity?: number | null; size?: string | null }
/** ValidationIssue: code(예: CLEANUP_POLICY_REQUIRED) · path · message */
export type ValidationIssue = { code: string; path: string; message: string }
/**
 * 백엔드 Preview 그대로 + 프론트 감싸기 [가정]: plan_id·revision·source·target·env_remap·security_rules는
 * Preview에 없어 계획 입력·앱 Values에서 따로 채운다(없어도 된다).
 */
export type BackendPreviewData = {
  contract_version?: '1'
  manifest_digest: string
  changes: PreviewChange[]
  applied_defaults: PreviewChange[]
  warnings: ValidationIssue[]
  errors: ValidationIssue[]
  pending_decisions: ValidationIssue[]
  plan_id?: string
  revision?: number
  source?: PlanEnvironment
  target?: PlanEnvironment
  env_remap?: EnvRemap[]
  security_rules?: SecurityRule[]
}
export function isBackendPreview(data: PlanPreviewData | BackendPreviewData): data is BackendPreviewData {
  return Array.isArray((data as BackendPreviewData).changes)
}
/* ==== 백엔드 Preview 끝 ==== */

const LEGACY_GRADE: Record<string, Grade> = { direct: 'DIRECT', convert: 'API_DIFF', partial: 'PARTIAL', none: 'NONE' }
const GRADES: Grade[] = ['DIRECT', 'API_DIFF', 'PARTIAL', 'NONE']
/**
 * 서버가 보낸 계획 항목을 화면이 읽는 모양으로 맞춘다. 예전 등급(direct/convert/none)도 받고,
 * 빠진 처리·원본 유지·검증 상태는 등급으로 채운다(대응 없음은 원본 유지 + 승인 필요).
 */
export function normalizePlanStep(raw: Omit<Partial<PlanStepData>, 'grade'> & { id: string; grade?: string }): PlanStepData {
  const grade: Grade = GRADES.includes(raw.grade as Grade) ? raw.grade as Grade : LEGACY_GRADE[String(raw.grade ?? '').toLowerCase()] ?? 'PARTIAL'
  const keep = raw.keep_source ?? grade === 'NONE'
  return {
    id: raw.id,
    group: raw.group === 'code' ? 'code' : 'infrastructure',
    grade,
    before: raw.before ?? '',
    after: raw.after ?? '',
    evidence: raw.evidence ?? '',
    change: raw.change ?? '',
    action: raw.action ?? (grade === 'NONE' && !keep ? 'BLOCK' : grade === 'PARTIAL' ? 'APPROVAL' : 'PROCEED'),
    keep_source: keep,
    verification: raw.verification ?? 'UNVERIFIED',
    ...(raw.kind ? { kind: raw.kind } : {}),
  }
}

/** 계획 완료. 필드는 모두 선택이라 예전의 빈 객체도 유효하다. */
/** manifest_digest·preview_digest는 백엔드 승인 API(ApprovalRequest)가 요구하는 값이다(sha256 16진수 64자). 승인 때 그대로 되돌려 보낸다. */
/** 승인 대상 범위(백엔드 PlanManifest.scope). 승인·거절 요청의 scope와 같아야 한다(다르면 409 APPROVAL_TARGET_MISMATCH). */
export type ApprovalScope = 'INFRASTRUCTURE' | 'WORKLOADS' | 'FULL'
/** scope: 그 Revision의 PlanManifest.scope(ON_PREM은 WORKLOADS). 옛 이벤트에는 없다. */
export type PlanReadyData = { plan_id?: string; revision?: number; template_version?: string; built_digest?: string; verified_digest?: string; manifest_digest?: string; preview_digest?: string; scope?: ApprovalScope }

export type ApprovalRequiredData = {
  excluded: string[]
  rollback_policy: string
  /** 승인 전에 정해야 할 값(백엔드 Preview pending_decisions와 같은 모양). 제외 범위·롤백 정책 문구의 근거다. */
  pending_decisions?: ValidationIssue[]
  /** 두 번째 승인(DB 전환)이면 'cutover'. 비어 있으면 계획 승인이다. */
  gate?: 'cutover'
}

/*
 * 승인 결정의 접수·전달·실행 상태 [가정: SSE 이벤트 이름]. 필드는 백엔드 ApprovalResponse(openapi)와 같다.
 * ADR-002: 결정이 기록돼도 실행 엔진(Workflow)에 전달되지(DELIVERED) 않았으면 완료로 보이지 않는다.
 * SSE 공급자는 승인 API의 응답도 같은 모양으로 상태에 넣는다.
 */
export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED'
export type ExecutionStatus = 'NOT_STARTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'
export type ApprovalDecisionData = {
  approval_id: string
  plan_id: string
  revision: number
  decision: 'APPROVE' | 'REJECT'
  scope: ApprovalScope
  delivery_status: DeliveryStatus
  delivery_attempts: number
  execution_status: ExecutionStatus
  workflow_state?: string
}

/** 만든 리소스. name·detail이 오면 그대로 보이고, 없으면 화면이 key로 자기 문구를 쓴다(알려진 key만) [가정]. */
export type ProvisionResourceData = { id: string; key: string; state: 'running' | 'done' | 'failed'; progress: number; name?: string; detail?: string }

/** 알려진 검사 이름. 그 밖의 이름도 받아 이름 그대로 보인다 [가정]. */
export type ProvisionCheckName = 'pods_ready' | 'db_connect' | 'app_health' | 'retest' | (string & {})
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

/**
 * data.verify [확정: 플랫폼 cmp_data/cutover_events.py verify_events] — DB 전환이 통과하고 검증을 켰을 때만 온다.
 * rows running → rows 결과(source·target) → checksum running → checksum 결과(source·target 없음). 실패는 event status failed(표의 불일치, 이전 실패 아님).
 * traffic.ready [확정: cmp_traffic snapshot.py]. cutover.handover는 플랫폼이 아직 내지 않는다(목업 전용, 계획 handover=[]이면 화면이 기다리지 않는다).
 */
export type DataVerifyName = 'rows' | 'checksum'
export type DataVerifyData = { name: DataVerifyName; state: 'running' | 'done' | 'failed'; source?: number; target?: number }

/* ==== 데이터 이전 단계 상세 (data.preflight · data.phase · data.lsn · data.table · data.readiness) ====
 * [확정: 플랫폼 packages/contracts/src/cmp_contracts/events.py(DataPreflightData·DataPhaseData·DataLsnData·DataTableData·DataReadinessData)].
 * 플랫폼 이름(check_cidr_overlap·bytes_received·longest_xact_ms·copying 등)은 플랫폼 to_web이 아래 웹 이름으로 바꿔 보낸다.
 * 플랫폼이 보내지 않는 값: 검사·판정의 PENDING·RUNNING·SKIPPED(앞 검사 실패로 안 돈 검사는 UNKNOWN + NOT_RUN_AFTER_STATIC_FAILURE),
 * path.kind cloud_vpn, data.table matched(목업 전용). 흐름:
 * Migration Network Preflight(check_cidr_overlap · check_route · probe_db_path · probe_large_transfer → run_network_preflight)
 * → 스키마 덤프(pg_dump --schema-only + mig.marker) → 테이블별 초기 복사 → CDC 따라잡기 → 지연≈0 스트리밍.
 * 문구는 담지 않는다: evidence·endpoint·LSN처럼 언어와 무관한 값만 온다.
 */
export type PreflightCheckName = 'cidr_overlap' | 'route' | 'db_path' | 'large_transfer'
/** PENDING 대기 · RUNNING 검사 중 · SKIPPED 앞 검사 실패로 실행하지 않음 */
export type PreflightStatus = 'PENDING' | 'RUNNING' | 'PASS' | 'FAIL' | 'UNKNOWN' | 'SKIPPED'
/** probe_db_path의 연결 사슬: DNS → TCP → TLS → 인증 → SELECT 1 */
export type DbPathStep = 'DNS' | 'TCP' | 'TLS' | 'AUTH' | 'QUERY'
export type PreflightCheck = {
  name: PreflightCheckName
  status: PreflightStatus
  /** 실패·확인 불가 코드(플랫폼: CIDR_OVERLAP·CIDR_INPUT_MISSING·NO_ROUTE·UNEXPECTED_PATH·ROUTE_UNVERIFIED·DNS_FAILED·TCP_UNREACHABLE·TLS_FAILED·AUTH_FAILED·QUERY_FAILED·TRANSFER_SHORT·TRANSFER_TIMEOUT·TRANSFER_INTERRUPTED·NOT_RUN_AFTER_STATIC_FAILURE 등. 목업은 ROUTE_NOT_TUNNEL) */
  code: string | null
  /** 증거 원문(mono로 그대로 보인다) */
  evidence: string
  checked_at?: string
  tested_endpoint?: string
  /** db_path: 연결 사슬 단계별 상태 */
  steps?: Array<{ name: DbPathStep; status: 'PENDING' | 'PASS' | 'FAIL' | 'UNKNOWN' }>
  /** large_transfer: 전송한 바이트 / 목표 바이트(기본 4 MiB, 최대 64 MiB) · 걸린 시간 · MTU 진단 */
  bytes_done?: number
  bytes_total?: number
  elapsed_ms?: number
  mtu?: 'NOT_ATTEMPTED' | 'PASS' | 'FAIL'
}
/** 이전 경로: AWS 원본 ↔ 대상 사이 사설 경로. wireguard(온프레미스 wg0) · cloud_vpn(새 클라우드 네트워크) */
export type PreflightNetwork = {
  source_cidr: string
  target_cidr: string
  path: { kind: 'wireguard' | 'cloud_vpn' | 'other'; name: string; cidr: string | null }
  /** 원본 DB 주소(DNS 이름:포트)와 해석된 IP */
  source_db: string
  source_addr: string
  /** 복제를 실행할 노드(검사 Pod가 뜨는 곳) */
  replication_node: string
  target_db: string
  target_db_detail: string
}
/** run_network_preflight 결과 전체(매번 전체를 다시 보낸다: 같은 이벤트가 다시 와도 결과가 같다). */
export type DataPreflightData = {
  status: 'RUNNING' | 'PASS' | 'FAIL' | 'UNKNOWN'
  checks: PreflightCheck[]
  probe_location: string
  /** 입력 지문: 입력(CIDR·엔드포인트·경로)이 바뀌면 달라진다. 다른 지문의 이전 PASS는 재사용하지 않는다. */
  input_fingerprint: string | null
  checked_at: string | null
  /** may_start_data_migration: 같은 입력 지문의 PASS일 때만 true */
  may_start: boolean
  network: PreflightNetwork
}
/** preflight 사전 검사 · blocked 시작 차단 · schema 스키마 복사 · copy 초기 복사 · catchup 변경분 따라잡기 · streaming 지연≈0 유지 */
/** tunnel: 원본 쪽 복제 통로(WireGuard 게이트웨이·NLB)를 여는 중(플랫폼 DataMigrationWorkflow phase "tunnel", 2분 30초 이상 걸릴 수 있다). */
export type DataPhase = 'tunnel' | 'preflight' | 'blocked' | 'schema' | 'copy' | 'catchup' | 'streaming'
export type DataPhaseData = { phase: DataPhase }
/** 원본 쓰기 위치(pg_current_wal_lsn)와 대상 재생 위치(replay LSN). 둘의 차이가 복제 지연이다. */
export type DataLsnData = { source_lsn: string; target_lsn: string | null; lag_bytes: number; lag_ms: number | null }
export type DataTableData = { name: string; rows_copied: number; rows_total: number; state: 'waiting' | 'copying' | 'copied' | 'matched' }
/** 전환 가능 시점(1초마다): 가장 긴 트랜잭션 · 잠금 대기 · 초당 커밋. ready면 지연≈0이고 트래픽을 옮겨도 된다(게이트 1). */
export type DataReadinessData = { longest_tx_ms: number; lock_waits: number; commits_per_sec: number; ready: boolean }
/* ==== 데이터 이전 단계 상세 끝 ==== */

/** 전환 조건 확인: 복제 지연·가장 긴 트랜잭션·초당 커밋을 보고 DB 전환이 가능한 시점인지 판단한다. */
export type TrafficReadyData = { state: 'running' | 'done' | 'waiting'; lag_ms: number; longest_tx_ms: number; commits_per_sec: number }

export type HandoverItem = 'dns' | 'origin' | 'access'
/** 목업 전용(플랫폼은 cutover.handover를 내지 않는다). held: 전환이 거부돼 인계를 보류했다. detail은 근거(예: 도메인·TTL, 보존 시간). */
export type HandoverData = { item: HandoverItem; state: 'running' | 'done' | 'held'; detail?: string }

/** stabilizing: 100% 전환 뒤 최종 확정 전 안정화 구간(정책 stabilize_seconds > 0일 때만). 사람이 확정하거나 롤백한다. */
export type TrafficPhase = 'applying' | 'observing' | 'gate' | 'stabilizing' | 'complete' | 'rolledback'
/** 트래픽 피드에 남길 기록. key로 화면이 자기 문구를 고른다. restart는 피드를 비우라는 뜻이다. */
/**
 * 트래픽 피드에 남길 기록. key로 화면이 자기 문구를 고른다. restart는 피드를 비우라는 뜻이다.
 * 플랫폼(cmp_traffic snapshot.py)이 보내는 key: apply·observe·gatePass·gateFail·rollback·reached·manual·restart·idleProbe 등. gateFail의 params에는 판정 근거(kind=p99|failed|requests와 수치), idleProbe는 사용자 트래픽이 없어 합성 요청으로 확인한 결과(requests·failed·p99_ms)가 온다. prepare·inject·drained는 화면·목업이 쓴다.
 * activity가 없으면 화면이 key로 기본 이름을 고른다(trafficModel.ts).
 */
export type TrafficNoteKey = 'prepare' | 'apply' | 'observe' | 'gatePass' | 'gateFail' | 'rollback' | 'reached' | 'manual' | 'inject' | 'drained' | 'restart' | 'finalized' | 'dbRollback' | 'idleProbe' | 'awaitNext'
export type TrafficNote = { key: TrafficNoteKey; params?: Record<string, string | number>; activity?: string }

/*
 * ---- 트래픽 이전 상세 [확정: 플랫폼 packages/traffic/src/cmp_traffic/snapshot.py · contracts events.py] ----
 * 플랫폼 traffic.prepare check id: handoff_status·ready·external_endpoint·health, reason: HANDOVER_NOT_READY·RELAY_NOT_CONFIGURED·TARGET_MISMATCH·TARGET_UNHEALTHY·PREPARE_FAILED.
 * 플랫폼이 보내지 않는 선택 값: entry_host·origin·data_path·target.platform·location·tunnel(prepare), steps·backends·results·replication·gate.observe_seconds(snapshot).
 * traffic.prepare: traffic_prepare Activity의 사전 확인(인계 상태 READY · ready=true · external_endpoint 있음 · 헬스).
 * 하나라도 실패하면 실행하지 않고 reason을 보낸다. 노드 이름·연결 정보는 화면이 그대로 보인다(문구가 아니라 값).
 */
export type TrafficPrepareCheck = { id: string; state: 'running' | 'done' | 'failed'; value?: string }
export type TrafficSide = { name: string; platform?: string; location?: string }
export type TrafficPrepareData = {
  state: 'running' | 'done' | 'failed'
  checks: TrafficPrepareCheck[]
  /** 실행하지 않는 이유(사전 조건 실패) */
  reason?: string
  /** 사용자가 들어오는 주소(예: app.example.com) */
  entry_host?: string
  /** 중계 서버(예: Envoy · weighted_clusters) */
  relay?: TrafficSide & { mode?: string }
  origin?: TrafficSide
  /** 대상. external_endpoint는 중계 서버가 대상으로 보내는 주소, tunnel은 온프레미스 터널(WireGuard) 정보 */
  target?: TrafficSide & { external_endpoint?: string; tunnel?: { interface: string; mtu: number } }
  /** 이 단계의 데이터 경로: 두 앱의 쓰기는 모두 pooler → source_db, target_db는 논리 복제로 따라온다 */
  data_path?: { pooler: string; source_db: string; target_db: string }
  /** 정책(단계·관찰 창·게이트 기준). 스냅샷 값이 오면 그 값을 쓴다. */
  policy?: { steps: number[]; observe_seconds: number; max_failed_requests: number; max_p99_ratio: number }
}
/** 백엔드별 관찰 지표(목업 전용: 플랫폼은 아직 보내지 않는다) */
export type TrafficBackendMetrics = { requests_per_sec: number; p99_ms: number; failed_requests: number }
/** 끝난 단계의 판정 기록(목업 전용: 플랫폼은 아직 보내지 않는다) */
export type TrafficStepResult = { step: number; verdict: 'pass' | 'rollback'; failed_requests: number; p99_ratio: number; observed_seconds?: number }
export type TrafficSnapshotData = {
  phase: TrafficPhase
  weights: { origin: number; target: number }
  /** 지금 단계의 대상 비율(%). steps가 오면 그 값 중 하나다. */
  step: number
  /** 전환 단계(대상 비율 %, 예: [50, 100]). 플랫폼은 보내지 않는다: 없으면 화면은 기본 단계(10 · 50 · 100)를 쓴다. */
  steps?: number[]
  gate: {
    failed_requests: number
    max_failed_requests: number
    p99_ratio: number
    max_p99_ratio: number
    observe_left_seconds: number
    /** 관찰 창 길이(정책 observe_seconds). 플랫폼은 보내지 않는다. */
    observe_seconds?: number
  }
  residual: { requests_per_sec: number; streams: number }
  decision?: 'advance' | 'rollback' | 'done'
  notes?: TrafficNote[]
  /** 백엔드별 지표(원본·대상). 목업 전용 */
  backends?: { origin: TrafficBackendMetrics; target: TrafficBackendMetrics }
  /** 끝난 단계들의 판정. 목업 전용 */
  results?: TrafficStepResult[]
  /** 이 구간에도 계속되는 논리 복제의 지연. 목업 전용 */
  replication?: { lag_ms: number | null }
  /** 안정화 구간의 대상 건강 상태(관찰 창 하나) [확정: 플랫폼 stability.py] */
  health?: TrafficHealthJudgement
  /** 안정화 구간에서 남은 시간(초) */
  stabilize_left_seconds?: number
}

/** 안정화 구간 판정에서 기준을 넘은 항목. ERROR_RATE는 0~1 비율, P99는 ms. */
export type TrafficHealthBreach = { code: 'ERROR_RATE' | 'P99'; value: number; limit: number }
/**
 * 안정화 구간의 대상 건강 판정 [확정: 플랫폼 packages/traffic/src/cmp_traffic/stability.py].
 * 요청이 너무 적으면 judged=false(판정하지 않음). p99 한도는 전환 전 원본 p99 × 정책 max_p99_ratio다.
 */
export type TrafficHealthJudgement = {
  requests: number
  failed: number
  error_rate: number | null
  p99_ms: number | null
  baseline_p99_ms: number
  p99_limit_ms: number
  alert_error_rate: number
  judged: boolean
  breach: TrafficHealthBreach[]
}
/** traffic.alert: 안정화 구간에서 대상이 기준을 넘기 시작했거나(breach) 회복했다(recovered). 상태가 바뀔 때만 한 번 온다. */
export type TrafficAlertData = TrafficHealthJudgement & { state: 'breach' | 'recovered'; phase: 'stabilizing' }

/* ==== 그림자 리허설 (shadow.progress · shadow.result, phase data_copy) ====
 * 복제가 따라잡은 뒤 DB 전환 승인 전에 실제 GET 요청을 대상에도 복사해 원본과 비교한다. 경고와 표시만 하고 절대 막지 않는다(기본 꺼짐).
 * 이벤트가 오지 않으면 화면은 예전과 같다. 결과는 cutover.plan.preconditions의 id shadow 한 줄(warn·skip 포함)로도 온다.
 */
export type ShadowProgressData = { run_id: string; compared: number; match: number; mismatch: number; elapsed_s: number; window_s: number }
/** reason 코드: SHADOW_NO_TRAFFIC · SHADOW_UNAVAILABLE · SHADOW_STOPPED_REPLICATION · SHADOW_DISABLED */
export type ShadowReason = 'SHADOW_NO_TRAFFIC' | 'SHADOW_UNAVAILABLE' | 'SHADOW_STOPPED_REPLICATION' | 'SHADOW_DISABLED'
export type ShadowDiff = { pointer: string; origin?: unknown; target?: unknown }
export type ShadowSample = { method: string; path: string; status_origin: number | null; status_target: number | null; diff: ShadowDiff[] }
export type ShadowAi = { category: 'noise' | 'data' | 'env' | 'code'; summary: string; hypotheses: string[] }
export type ShadowResultData = {
  run_id: string
  state: 'pass' | 'warn' | 'skipped' | 'stopped'
  compared: number
  match: number
  mismatch: number
  match_ratio: number | null
  target_5xx: number
  p99_ratio: number | null
  reason: string | null
  /** 불일치 샘플(최대 5) */
  samples: ShadowSample[]
  ai: ShadowAi | null
}
/* ==== 그림자 리허설 끝 ==== */

/* ==== DB 전환 상세 (cutover.plan · cutover.ready · cutover.step 확장 · cutover.outcome · cutover.verify) ====
 * [확정: 플랫폼 packages/data/src/cmp_data/cutover_events.py · apps/worker/src/cmp_worker/activities/data_cutover.py, phase는 verification].
 * 순서: cutover.plan(+ approval.required gate=cutover) → 승인 → cutover.ready → cutover.step(모두 done, 끝에 verify 한 번) → cutover.outcome → cutover.verify.
 * 플랫폼이 보내지 않는 값: plan.steps의 실제 ms(전환 전에는 0)·start_ms·proposal, step state running·ms, outcome held_requests·failed_requests,
 * verify checksum pending·skipped, cutover.result(목업·poc_bridge 전용). plan.handover는 늘 [].
 * 단계 순서·이름·시간·방식·임계값은 모두 이벤트로 오고, 화면은 받은 순서대로 그린다(순서가 바뀌어도 화면은 그대로).
 */
export type CutoverMethod = 'fast' | 'classic'
/** 전환 전 조건 한 줄. id로 화면이 이름을 고르고(cut.pre.<id>), value·evidence는 서버 값을 그대로 보인다. proposal이면 백엔드에 아직 없는 제안안 조건이다. */
export type CutoverPrecondition = { id: string; state: 'pass' | 'wait' | 'fail' | 'warn' | 'skip'; value?: string; evidence?: string; proposal?: boolean }
/** 전환 구간: pre는 PAUSE 전에 미리 하는 일(예: 시퀀스 미리 올림), pause는 쓰기 중단 구간 안이다. */
export type CutoverWindow = 'pre' | 'pause'
/**
 * 전환 단계 한 개. id로 화면 문구(cut.step.<id>)를 고르고, ms는 리허설 중앙값(미리보기) 또는 실제 측정값이다.
 * start_ms는 쓰기 중단 구간 시작부터의 시각이다. 같은 시각에 시작하는 단계는 동시에 실행된다(겹친 막대). 없으면 앞 단계 뒤에 이어진다.
 */
export type CutoverStepPlan = { id: string; ms: number; start_ms?: number; window?: CutoverWindow }
/** 두 번째 승인 전에 보내는 전환 계획: 조건 · 방식 · 예상 쓰기 중단 · 되돌리는 길 · 구성 · 인계 항목. */
export type CutoverPlanData = {
  method: CutoverMethod
  expected_pause_ms: { min: number; max: number }
  /** 리허설 근거: 어디서 몇 번 돌렸고 방식별 쓰기 중단이 얼마였는지 */
  rehearsal: { source: string; runs: number; methods: Array<{ method: CutoverMethod; pause_ms: number }> }
  preconditions: CutoverPrecondition[]
  /** 쓰기 중단 구간 미리보기(순서대로) */
  steps: CutoverStepPlan[]
  rollback: { standby_hours: number }
  topology: { app: string; pooler: string; source_db: string; target_db: string; source_where: string; target_where: string; writes_per_sec: number }
  handover: Array<{ item: HandoverItem; detail?: string }>
}
/** 전환 가능 시점 대기: 긴 트랜잭션·잠금이 풀릴 때까지 PAUSE를 미룬다. attempt가 바뀌면 새 시도라 지난 결과를 비운다. */
export type CutoverReadyData = {
  attempt: number
  longest_tx_ms: number
  lock_waits: number
  commits_per_sec: number
  ready: boolean
  limits: { longest_tx_ms: number; lock_waits: number }
  /** 기다리는 이유(예: batch 잠금) — 서버 값 그대로 */
  waiting_on?: string
  waited_ms?: number
}
/**
 * 전환 단계. state: running(진행 중) → done(완료), verify는 단계가 끝나고 검증 구간에 들어갔다는 표시다.
 * id·ms·method·of·result: 단계 이름(id), 걸린 시간(ms, 플랫폼은 보내지 않고 outcome.steps로 준다), 방식, 전체 단계 수(of), 결과(fail이면 대상 확인 실패, revert는 원본으로 되돌리는 단계 resume_source).
 */
export type CutoverStepData = { n: number; state: 'running' | 'done' | 'verify'; id?: string; ms?: number; method?: CutoverMethod; of?: number; result?: 'ok' | 'fail' | 'revert'; window?: CutoverWindow }
/**
 * 전환 결과: switched(대상이 주 DB) 또는 refused(전환 거부 → 원본 DB로 RESUME).
 * 백엔드는 끝났을 때 한 번 알려 준다: 통과면 write_pause_ms와 단계별 시간(steps_ms → steps), 중단이면 stderr 글(message)과 있으면 사유 코드(reason).
 * 중단된 실행은 단계별 시간·쓰기 중단 시간이 없을 수 있다(null·생략). held_requests·failed_requests는 목업 전용(플랫폼은 보내지 않는다).
 * 거부(refused)는 event status waiting으로 온다(이전은 계속 돌고 다시 승인할 수 있다).
 */
export type CutoverOutcomeData = {
  result: 'switched' | 'refused'
  reason?: string
  message?: string
  active: 'source' | 'target'
  pause_ms: number | null
  steps?: CutoverStepPlan[]
  held_requests?: number
  failed_requests?: number
  replication: { direction: 'reverse' | 'forward'; lag_ms: number | null }
}
/** RESUME 뒤, 전환 순간 스냅샷과 비교한 테이블별 결과. 거부면 target_rows가 없고 checksum은 skipped. */
export type CutoverVerifyData = { table: string; source_rows: number; target_rows: number | null; checksum: 'match' | 'mismatch' | 'pending' | 'skipped' }
/** 측정 결과(합계). 목업·poc_bridge 전용(플랫폼 Workflow는 보내지 않는다). id로 화면 문구(cutover.tile.<id>)를 고르고, 모르는 id는 label·value를 그대로 보인다. */
export type CutoverResultData = { id: string; value: string; label?: string; ok?: boolean }
/* ==== DB 전환 상세 끝 ==== */

/** detail: (화면 안에서만) 웹 서버가 돌려준 오류 코드(APPROVER_TOKEN_NOT_CONFIGURED 등). 화면이 cx.code.* 문구로 보여 준다. */
export type ErrorData = { code: string; message: string; phase: BackendPhase | null; retryable: boolean; detail?: string }

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
  | Base<'analysis.scan', AnalysisScanData>
  | Base<'analysis.done', Record<string, never>>
  | Base<'build.check', BuildCheckData>
  | Base<'build.fix', BuildFixData>
  | Base<'plan.step', PlanStepData>
  | Base<'build.result', BuildResultData>
  | Base<'build.review', BuildReviewData>
  | Base<'sandbox.env', SandboxEnvData>
  | Base<'sandbox.step', SandboxStepData>
  | Base<'sandbox.tests', SandboxTestsData>
  | Base<'sandbox.attempt', SandboxAttemptData>
  | Base<'sandbox.done', SandboxDoneData>
  | Base<'plan.ready', PlanReadyData>
  | Base<'plan.preview', PlanPreviewData | BackendPreviewData>
  | Base<'approval.required', ApprovalRequiredData>
  | Base<'approval.decision', ApprovalDecisionData>
  | Base<'provision.resource', ProvisionResourceData>
  | Base<'provision.check', ProvisionCheckData>
  | Base<'data.progress', DataProgressData>
  | Base<'data.verify', DataVerifyData>
  | Base<'data.preflight', DataPreflightData>
  | Base<'data.phase', DataPhaseData>
  | Base<'data.lsn', DataLsnData>
  | Base<'data.table', DataTableData>
  | Base<'data.readiness', DataReadinessData>
  | Base<'traffic.ready', TrafficReadyData>
  | Base<'traffic.snapshot', TrafficSnapshotData>
  | Base<'traffic.prepare', TrafficPrepareData>
  | Base<'traffic.alert', TrafficAlertData>
  | Base<'shadow.progress', ShadowProgressData>
  | Base<'shadow.result', ShadowResultData>
  | Base<'cutover.step', CutoverStepData>
  | Base<'cutover.result', CutoverResultData>
  | Base<'cutover.handover', HandoverData>
  | Base<'cutover.plan', CutoverPlanData>
  | Base<'cutover.ready', CutoverReadyData>
  | Base<'cutover.outcome', CutoverOutcomeData>
  | Base<'cutover.verify', CutoverVerifyData>
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
 * 이전할 소스 저장소. 화면이 고른 공개 GitHub 저장소를 서버(/api/github/source)가 다시 조회해
 * 기본 브랜치의 커밋 SHA를 고정한 값이다. GitHub 토큰이나 소스 코드는 담지 않는다.
 */
export type StartSource = {
  kind: 'GITHUB_PUBLIC'
  repository_id: number
  full_name: string
  commit_sha: string
}

/**
 * 이전 시작 요청. 설정 화면의 나머지 입력(액세스 키)은 계속 보내지 않는다.
 * env_file_ref는 .env 내용이 아니라 플랫폼 POST /env-files가 준 참조다: 정확한 버전 {id, version, sha256} 또는 envf- id 문자열.
 * 목업 모드에서는 업로드하지 않아 싣지 않는다.
 * scope_id는 확정한 이전 범위(POST /scope-analyses/{id}/confirm)다. 플랫폼은 이 ID로 범위와 원본 연결을 읽어 분석에 쓴다.
 */
export type StartRequest = {
  target: { provider: ProviderName; profile: string; region?: string; agent_id?: string; credential_ref?: string }
  source?: StartSource
  env_file_ref?: string | { id: string; version: string; sha256: string }
  scope_id?: string
}

/** 설정 화면의 선택으로 시작 요청을 만든다(profile은 provider에서 정한다). */
export function startRequestFor(target: Target, options: { region?: string; agentId?: string; envFileRef?: string | { id: string; version: string; sha256: string }; source?: StartSource; scopeId?: string } = {}): StartRequest {
  const { provider, profile } = PROFILE_OF[target]
  const request: StartRequest = { target: { provider, profile } }
  if (target === 'onprem') { if (options.agentId) request.target.agent_id = options.agentId }
  else request.target.region = options.region || DEFAULT_REGION[target]
  if (options.source) {
    // 허용한 필드만 옮긴다(default_branch 같은 화면용 값이 섞여 들어가지 않게).
    const { repository_id, full_name, commit_sha } = options.source
    request.source = { kind: 'GITHUB_PUBLIC', repository_id, full_name, commit_sha }
  }
  if (options.envFileRef) request.env_file_ref = typeof options.envFileRef === 'string' ? options.envFileRef : { id: options.envFileRef.id, version: options.envFileRef.version, sha256: options.envFileRef.sha256 }
  if (options.scopeId) request.scope_id = options.scopeId
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
  /** DB 전환 결과(마지막 cutover.outcome과 같은 모양). 전환하지 않았거나 옛 플랫폼이면 null·생략. */
  cutover_outcome?: CutoverOutcomeData | null
}
