/**
 * 연결 관리(/settings)·설정 화면·이전 범위 선택이 함께 쓰는 형태와 순수 함수.
 * 브라우저와 웹 서버(BFF)가 모두 import하므로 비밀값·환경변수·런타임 import를 두지 않는다(단위 테스트가 직접 읽는다).
 *
 * [가정] 표시가 붙은 형태는 백엔드에 아직 없다. 웹 서버의 목업 어댑터(mock.ts)가 같은 형태로 답하고,
 * 백엔드가 생기면 어댑터만 바꿔 끼운다.
 */

export type ConnectionKind = 'AWS_SOURCE' | 'AWS_TARGET' | 'GCP_TARGET'
export type ConnectionStatus = 'PENDING' | 'CONNECTED' | 'FAILED'

/** [가정] GET /connections 의 connections[] 항목 */
export type Connection = {
  connection_id: string
  kind: ConnectionKind
  display_name: string
  status: ConnectionStatus
  last_verified_at: string | null
  /** AWS: 확인에 성공하면 채워진다 */
  account_id?: string
  region?: string
  /** AWS: 사용자가 붙여 넣은 역할 ARN */
  role_arn?: string
  /** AWS: 신뢰 정책에 넣을 External ID. 비밀값이 아니라 "혼동된 대리인" 방지용 식별자라 화면에 보여 준다. */
  external_id?: string
  /** AWS_SOURCE: 확인 때 읽어 온 EKS 클러스터 */
  eks_clusters?: string[]
  /** GCP */
  project_id?: string
  /** FAILED일 때 */
  error_code?: string
}

/** [가정] POST /connections 응답 */
export type CreatedConnection = { connection: Connection; external_id: string; launch_stack_url: string }

/** [가정] 터널 상태. 백엔드 DB에는 있지만 조회 API가 아직 없다. */
export type TunnelStatus = {
  tunnel_ip: string | null
  last_handshake_at: number | null
  app_health_ok: boolean | null
  db_connect_ok: boolean | null
}

/** 실제 API: GET /agent-admin/agents/{agent_id} */
export type PlatformAgent = {
  agent_id: string
  owner_id: string
  cluster_uid: string | null
  last_seen_at: number | null
  revoked: boolean
}

/** 화면이 받는 에이전트(GET /connections 의 agents[] 형태) */
export type AgentView = {
  agent_id: string
  cluster_uid: string | null
  last_seen_at: number | null
  online: boolean
  revoked: boolean
  /** 백엔드가 아직 저장하지 않는다: 늘 null */
  version: string | null
  /** [가정] 목업 */
  tunnel: TunnelStatus | null
  /** 등록 토큰을 발급했지만 에이전트가 아직 플랫폼에 등록하지 않았다(실제 API 404) */
  enrolled_only?: boolean
}

export type ListSection<T> = { items: T[]; error: ApiErrorCode | null; mock: boolean }

/** 웹 서버 /api/connections 응답 */
export type ConnectionsList = {
  connections: Connection[]
  agents: AgentView[]
  /** 각 묶음이 목업에서 왔는지·오류가 났는지(화면은 개발 모드에서만 목업 표시를 띄운다) */
  meta: { connections: { mock: boolean; error: ApiErrorCode | null }; agents: { mock: boolean; error: ApiErrorCode | null } }
  checked_at: number
}

/** BFF가 브라우저에 돌려주는 오류 코드(상태 코드와 짝) */
export type ApiErrorCode =
  | 'operator_key' // 403: 운영자 키가 없거나 틀림
  | 'not_found' // 404
  | 'conflict' // 409: 이미 쓰는 agent_id 등
  | 'unavailable' // 503: 플랫폼에 닿지 못함·설정 없음
  | 'bad_request' // 400
  | 'platform_error' // 502: 그 밖의 응답

export type AgentState = 'revoked' | 'pending' | 'online' | 'offline'

export const ONLINE_WINDOW_SECONDS = 60

/** 상태 칩: 폐기 > 설치 대기(접속 기록 없음) > 온라인(60초 이내) > 오프라인 */
export function agentState(agent: Pick<AgentView, 'revoked' | 'last_seen_at'>, nowSeconds: number): AgentState {
  if (agent.revoked) return 'revoked'
  if (agent.last_seen_at === null) return 'pending'
  return nowSeconds - agent.last_seen_at <= ONLINE_WINDOW_SECONDS ? 'online' : 'offline'
}

/** Kubernetes 이름 규칙(백엔드 KubernetesName과 같다): 소문자·숫자·'-', 63자 이하, 영숫자로 시작·끝 */
export const AGENT_ID_PATTERN = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/
export function isAgentId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_ID_PATTERN.test(value)
}

export const TTL_DEFAULT_MINUTES = 10
export const TTL_MAX_MINUTES = 60
export function ttlSeconds(minutes: unknown): number | null {
  const value = typeof minutes === 'number' ? minutes : Number(minutes)
  if (!Number.isInteger(value) || value < 1 || value > TTL_MAX_MINUTES) return null
  return value * 60
}

/** arn:aws:iam::<12자리>:role/<경로·이름> */
export const ROLE_ARN_PATTERN = /^arn:aws:iam::\d{12}:role\/[\w+=,.@\-/]{1,512}$/
export function isRoleArn(value: unknown): value is string {
  return typeof value === 'string' && ROLE_ARN_PATTERN.test(value.trim())
}

export const CHART_REF = 'oci://ghcr.io/softbank-hackathon-2026-team-jackal/charts/onprem-agent'
export const CHART_VERSION = '0.1.0'

/** 온프레미스 Agent 설치 명령. 웹 서버가 플랫폼 공개 주소를 채워 만든다. */
export function installCommand(agentId: string, platformUrl: string, token: string): string {
  return ['helm install cmp-agent ' + CHART_REF, '--version ' + CHART_VERSION, '-n cmp-system --create-namespace',
    '--set agentId=' + agentId, '--set platform.url=' + platformUrl, '--set enrollmentToken=' + token].join(' ')
}

// ---- 이전 범위 선택 [가정] ----

/** 분석 계약 Evidence.kind 그대로 */
export type EvidenceKind = 'CODE' | 'MANIFEST' | 'CLOUD_RESOURCE' | 'IAM_POLICY' | 'CLOUDTRAIL' | 'CONFIG'
export const EVIDENCE_KINDS: EvidenceKind[] = ['CODE', 'MANIFEST', 'CLOUD_RESOURCE', 'IAM_POLICY', 'CLOUDTRAIL', 'CONFIG']

export type ScopeLevel = 'regions' | 'clusters' | 'namespaces' | 'workloads'
export type ScopeSelection = { connection_id: string; region: string; cluster: string; namespace: string; workload: string }

export type ScopeEvidence = { kind: EvidenceKind; location: string }
export type ScopeCandidate = {
  candidate_id: string
  /** ALB, RDS, S3, SQS, IAM_ROLE … */
  resource_type: string
  name: string
  arn: string | null
  evidence: ScopeEvidence[]
  /** 분석이 기본으로 포함하자고 제안하는지 */
  suggested: boolean
}
export type ScopeAnalysis = { analysis_id: string; selection: ScopeSelection; candidates: ScopeCandidate[] }
export type ScopeConfirmation = { scope_id: string; analysis_id: string; included: string[]; excluded: string[]; confirmed_at: string }
