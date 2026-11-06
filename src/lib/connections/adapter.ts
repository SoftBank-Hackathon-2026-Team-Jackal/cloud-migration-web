import type {
  ClusterList, Connection, CreateConnectionInput, CreatedConnection, DeletedConnection, PlatformAgent, ScopeAnalysis, ScopeConfirmation,
  ScopeLevel, ScopeSelection, TunnelStatus, VerifyResult,
} from './types.ts'

/**
 * 웹 서버가 플랫폼에 묻는 일의 함수 시그니처. 실제 API와 [가정] 목업이 같은 모양을 따르므로 나중에 구현만 바꿔 끼운다.
 * - AgentsApi: 실제 API(platform.ts)가 있다. 운영자 키가 없는 목업 데모 모드에서만 목업을 쓴다.
 * - ConnectionsApi: 백엔드 #23 /connections. 실제 구현은 real.ts, 목업 모드(PLATFORM_CONNECTIONS=mock·개발 서버)에서만 mock.ts가 답한다.
 *   이전 범위 선택(listScopeOptions·analyzeScope·confirmScope)은 백엔드에 아직 없어서 두 구현 모두 목업(mockScope)이다.
 */
export interface AgentsApi {
  readonly mock: boolean
  issueEnrollment(input: { ownerId: string; agentId: string; ttlSeconds: number }): Promise<{ enrollment_token: string; expires_in_seconds: number }>
  getAgent(agentId: string): Promise<PlatformAgent>
  revokeAgent(agentId: string): Promise<PlatformAgent>
  /** 실제 API: GET /agent-admin/agents의 agent_id. 목업은 없다(웹이 기억한 id만 쓴다). */
  listAgentIds?(): Promise<string[]>
}

export interface ConnectionsApi {
  readonly mock: boolean
  /** [가정 · #23] GET /connections 의 connections[] */
  listConnections(): Promise<Connection[]>
  /** [가정 · #23] POST /connections {kind, display_name, region} → external_id, launch_stack_url */
  createConnection(input: CreateConnectionInput): Promise<CreatedConnection>
  /** [가정 · #23] PUT /connections/{id}/role {role_arn} — 스택 출력 RoleArn 등록 */
  setRole(connectionId: string, roleArn: string): Promise<Connection>
  /** [가정 · #23] POST /connections/{id}/verify — 늘 200, status·code로 결과 */
  verifyConnection(connectionId: string): Promise<VerifyResult>
  /** [가정 · #23] DELETE /connections/{id} — 플랫폼의 연결 정보만 지운다(계정의 IAM 역할은 남는다) */
  deleteConnection(connectionId: string): Promise<DeletedConnection>
  /** [가정 · #23] GET /connections/{id}/eks-clusters?region= */
  listEksClusters(connectionId: string, region?: string): Promise<ClusterList>
  /** [가정] 터널 상태(tunnel_ip, last_handshake_at, 앱 헬스·DB 확인) — #23 병합 뒤에는 GET /agent-admin/agents의 tunnel 필드로 대신한다 */
  tunnelStatus(agentId: string, agent: PlatformAgent): Promise<TunnelStatus | null>
  /** [가정] 범위 선택 단계별 목록: 리전 → EKS 클러스터 → Namespace → Deployment */
  listScopeOptions(level: ScopeLevel, selection: Partial<ScopeSelection>): Promise<string[]>
  /** [가정] 고른 워크로드에서 출발해 이전 범위 후보를 찾는다 */
  analyzeScope(selection: ScopeSelection): Promise<ScopeAnalysis>
  /** [가정] 포함할 후보를 확정한다 */
  confirmScope(analysisId: string, included: string[]): Promise<ScopeConfirmation>
}

/** 웹이 등록한 agent_id 기억. [가정] #23의 GET /agent-admin/agents(터널 상태 포함)가 병합되면 이것을 지운다. */
export interface AgentIdStore {
  list(): string[]
  add(agentId: string): void
  remove(agentId: string): void
}
