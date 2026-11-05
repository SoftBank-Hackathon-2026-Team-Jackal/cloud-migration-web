import type {
  Connection, ConnectionKind, CreatedConnection, PlatformAgent, ScopeAnalysis, ScopeConfirmation, ScopeLevel, ScopeSelection, TunnelStatus,
} from './types.ts'

/**
 * 웹 서버가 플랫폼에 묻는 일의 함수 시그니처. 실제 API와 [가정] 목업이 같은 모양을 따르므로 나중에 구현만 바꿔 끼운다.
 * - AgentsApi: 실제 API(platform.ts)가 있다. 운영자 키가 없는 목업 데모 모드에서만 목업을 쓴다.
 * - ConnectionsApi: [가정] 백엔드 미구현. 지금은 mock.ts가 답한다.
 */
export interface AgentsApi {
  readonly mock: boolean
  issueEnrollment(input: { ownerId: string; agentId: string; ttlSeconds: number }): Promise<{ enrollment_token: string; expires_in_seconds: number }>
  getAgent(agentId: string): Promise<PlatformAgent>
  revokeAgent(agentId: string): Promise<PlatformAgent>
}

export interface ConnectionsApi {
  readonly mock: boolean
  /** [가정] GET /connections */
  listConnections(): Promise<Connection[]>
  /** [가정] POST /connections {kind} → external_id, launch_stack_url */
  createConnection(kind: Extract<ConnectionKind, 'AWS_SOURCE' | 'AWS_TARGET'>): Promise<CreatedConnection>
  /** [가정] POST /connections/{id}/verify {role_arn?} */
  verifyConnection(connectionId: string, input: { role_arn?: string }): Promise<Connection>
  /** [가정] DELETE /connections/{id} — 플랫폼의 연결 정보만 지운다(계정의 IAM 역할은 남는다) */
  deleteConnection(connectionId: string): Promise<void>
  /** [가정] 터널 상태(tunnel_ip, last_handshake_at, 앱 헬스·DB 확인) — 백엔드 조회 API 없음 */
  tunnelStatus(agentId: string, agent: PlatformAgent): Promise<TunnelStatus | null>
  /** [가정] 범위 선택 단계별 목록: 리전 → EKS 클러스터 → Namespace → Deployment */
  listScopeOptions(level: ScopeLevel, selection: Partial<ScopeSelection>): Promise<string[]>
  /** [가정] 고른 워크로드에서 출발해 이전 범위 후보를 찾는다 */
  analyzeScope(selection: ScopeSelection): Promise<ScopeAnalysis>
  /** [가정] 포함할 후보를 확정한다 */
  confirmScope(analysisId: string, included: string[]): Promise<ScopeConfirmation>
}

/** 웹이 등록한 agent_id 기억. [가정] GET /agent-admin/agents 목록 API가 생기면 이것을 지운다. */
export interface AgentIdStore {
  list(): string[]
  add(agentId: string): void
  remove(agentId: string): void
}
