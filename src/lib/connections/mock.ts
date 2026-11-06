import type { AgentIdStore, AgentsApi, ConnectionsApi } from './adapter.ts'
import { PlatformError } from './platform.ts'
import {
  isRoleArn, type Connection, type ConnectionKind, type PlatformAgent, type ScopeAnalysis, type ScopeCandidate, type ScopeConfirmation, type ScopeLevel, type ScopeSelection,
} from './types.ts'

/**
 * [가정] 백엔드에 아직 없는 API의 목업 어댑터(웹 서버 안에서만 돈다).
 * 상태는 프로세스 메모리에 둔다. Next가 라우트마다 모듈을 따로 묶어도 같은 값을 보도록 globalThis에 건다.
 */
type MockState = {
  connections: Map<string, Connection>
  analyses: Map<string, ScopeAnalysis>
  agents: Map<string, { agent: PlatformAgent; enrolledAt: number }>
  agentIds: Set<string>
  seededIds: boolean
  seq: number
}

const KEY = Symbol.for('jackal.connections.mock')
type Global = typeof globalThis & { [KEY]?: MockState }

const sec = (ms: number) => Math.floor(ms / 1000)

function seed(now: number): MockState {
  const connections = new Map<string, Connection>()
  connections.set('c-1', {
    connection_id: 'c-1', kind: 'AWS_SOURCE', display_name: 'chat-production', status: 'CONNECTED', last_verified_at: sec(now - 3600_000),
    account_id: '123456789012', region: 'ap-northeast-2', role_arn: 'arn:aws:iam::123456789012:role/cmp-source-readonly',
    external_id: 'cmp-ext-7f3a9c21', eks_clusters: ['chat-prod'],
  })
  connections.set('c-2', {
    connection_id: 'c-2', kind: 'GCP_TARGET', display_name: 'jackal-demo-gcp', status: 'CONNECTED', last_verified_at: sec(now - 3600_000),
    project_id: 'cmp-demo', region: 'asia-northeast3',
  })
  const agents = new Map<string, { agent: PlatformAgent; enrolledAt: number }>()
  agents.set('office-seoul-01', { agent: { agent_id: 'office-seoul-01', owner_id: 'platform', cluster_uid: '6c1f0d2e-6a43-4f7e-9d0b-2c4f5e8a1b37', last_seen_at: Math.floor(now / 1000) - 6, revoked: false }, enrolledAt: now - 86400_000 })
  return { connections, analyses: new Map(), agents, agentIds: new Set(), seededIds: false, seq: 2 }
}

export function mockState(now = Date.now()): MockState {
  const g = globalThis as Global
  g[KEY] ??= seed(now)
  return g[KEY]
}

/** 시험용: 목업 상태를 처음으로 되돌린다 */
export function resetMock(now = Date.now()) {
  (globalThis as Global)[KEY] = seed(now)
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('')

function launchStackUrl(kind: ConnectionKind, externalId: string): string {
  const template = kind === 'AWS_SOURCE' ? 'cmp-source-readonly.yaml' : 'cmp-target-eks-admin.yaml'
  const params = new URLSearchParams({
    templateURL: 'https://cmp-public-templates.s3.ap-northeast-2.amazonaws.com/' + template,
    stackName: kind === 'AWS_SOURCE' ? 'cmp-source-role' : 'cmp-target-role',
    param_ExternalId: externalId,
    param_PlatformPrincipal: 'arn:aws:iam::000000000000:role/cmp-platform',
  })
  return 'https://console.aws.amazon.com/cloudformation/home?region=ap-northeast-2#/stacks/quickcreate?' + params
}

// ---- 범위 선택 목업 데이터 ----
const TREE: Record<string, Record<string, Record<string, string[]>>> = {
  'ap-northeast-2': { 'chat-prod': { chat: ['chat-api', 'chat-worker'], payments: [] } },
  'us-east-1': {},
}

function candidatesFor(selection: ScopeSelection): ScopeCandidate[] {
  const account = '123456789012'
  const region = selection.region
  const workload = selection.workload
  const ns = selection.namespace
  const list: ScopeCandidate[] = [
    { candidate_id: 'alb', resource_type: 'ALB', name: 'k8s-' + ns + '-' + workload, arn: `arn:aws:elasticloadbalancing:${region}:${account}:loadbalancer/app/k8s-${ns}-${workload}/5f2c`,
      evidence: [{ kind: 'MANIFEST', location: 'k8s/ingress.yaml · alb.ingress.kubernetes.io/scheme' }], suggested: true },
    { candidate_id: 'rds', resource_type: 'RDS', name: 'chat-db', arn: `arn:aws:rds:${region}:${account}:db:chat-db`,
      evidence: [{ kind: 'CONFIG', location: 'Deployment env · DATABASE_URL (Secret chat-db)' }, { kind: 'CODE', location: 'src/db/pool.ts:12' }], suggested: true },
    { candidate_id: 's3', resource_type: 'S3', name: 'chat-attachments', arn: 'arn:aws:s3:::chat-attachments',
      evidence: [{ kind: 'IAM_POLICY', location: 'chat-api-irsa · s3:PutObject' }, { kind: 'CODE', location: 'src/upload.ts:31' }], suggested: true },
    { candidate_id: 'sqs', resource_type: 'SQS', name: 'chat-events', arn: `arn:aws:sqs:${region}:${account}:chat-events`,
      evidence: [{ kind: 'CLOUDTRAIL', location: 'sqs:SendMessage · 7d · 1,284 calls' }], suggested: true },
    { candidate_id: 'iam', resource_type: 'IAM_ROLE', name: 'chat-api-irsa', arn: `arn:aws:iam::${account}:role/chat-api-irsa`,
      evidence: [{ kind: 'MANIFEST', location: 'ServiceAccount chat-api · eks.amazonaws.com/role-arn' }], suggested: true },
    { candidate_id: 'redis', resource_type: 'ELASTICACHE', name: 'chat-cache', arn: `arn:aws:elasticache:${region}:${account}:cluster:chat-cache`,
      evidence: [{ kind: 'CONFIG', location: 'ConfigMap chat-config · REDIS_URL' }], suggested: true },
    { candidate_id: 'logs', resource_type: 'CLOUDWATCH_LOGS', name: '/aws/eks/chat-prod/' + workload, arn: null,
      evidence: [{ kind: 'CLOUD_RESOURCE', location: 'log group in same cluster · no direct reference' }], suggested: false },
  ]
  return workload === 'chat-worker' ? list.filter(item => item.candidate_id !== 'alb') : list
}

export function createMockConnections(options: { delayMs?: number; now?: () => number } = {}): ConnectionsApi {
  const delay = options.delayMs ?? 350
  const now = options.now ?? Date.now
  const state = () => mockState(now())
  const find = (id: string) => {
    const found = state().connections.get(id)
    if (!found) throw new PlatformError(404, 'not_found', 'CONNECTION_NOT_FOUND')
    return found
  }
  return {
    mock: true,
    async listConnections() {
      await wait(delay / 2)
      return [...state().connections.values()]
    },
    async createConnection({ kind, display_name, region }) {
      await wait(delay)
      const s = state()
      s.seq += 1
      const externalId = 'cmp-ext-' + randomHex(4)
      const connection: Connection = { connection_id: 'c-' + s.seq, kind, display_name, region, status: 'PENDING', last_verified_at: null, external_id: externalId, last_code: null }
      s.connections.set(connection.connection_id, connection)
      return { connection_id: connection.connection_id, kind, display_name, status: 'PENDING', external_id: externalId, launch_stack_url: launchStackUrl(kind, externalId) }
    },
    async setRole(id, roleArn) {
      await wait(delay)
      const current = find(id)
      if (current.kind === 'GCP_TARGET') throw new PlatformError(409, 'conflict', 'ROLE_NOT_APPLICABLE')
      if (!isRoleArn(roleArn)) throw new PlatformError(400, 'bad_request', 'INVALID_ROLE_ARN')
      // #23처럼 확인을 마친 연결의 역할은 바꾸지 않는다(새 연결로 다시 만든다).
      if (current.status === 'CONNECTED' && current.role_arn && current.role_arn !== roleArn) throw new PlatformError(409, 'conflict', 'ROLE_ALREADY_SET')
      const next = { ...current, role_arn: roleArn.trim() }
      state().connections.set(id, next)
      return next
    },
    async verifyConnection(id) {
      await wait(delay * 3)
      const current = find(id)
      const checked = sec(now())
      if (current.kind === 'GCP_TARGET') {
        state().connections.set(id, { ...current, status: 'CONNECTED', last_code: 'OK', last_verified_at: checked })
        return { status: 'CONNECTED', code: 'OK', checked_at: checked, project_id: current.project_id ?? null, principal: 'cmp-platform@' + current.project_id + '.iam.gserviceaccount.com' }
      }
      if (!current.role_arn) throw new PlatformError(409, 'conflict', 'ROLE_NOT_SET')
      // 목업 규칙: 역할 이름에 denied·notrust가 들어가면 실패로 답한다(오류 화면 시연용).
      if (/denied|notrust/i.test(current.role_arn)) {
        state().connections.set(id, { ...current, status: 'FAILED', last_code: 'ASSUME_ROLE_DENIED' })
        return { status: 'FAILED', code: 'ASSUME_ROLE_DENIED', checked_at: checked }
      }
      const account = current.role_arn.split(':')[4]
      const eks = current.kind === 'AWS_SOURCE' ? Object.keys(TREE[current.region] ?? {}) : undefined
      state().connections.set(id, { ...current, status: 'CONNECTED', last_code: 'OK', last_verified_at: checked, account_id: account, eks_clusters: eks })
      return { status: 'CONNECTED', code: 'OK', checked_at: checked, account_id: account, principal: current.role_arn, ...(eks ? { eks_clusters: eks } : {}) }
    },
    async deleteConnection(id) {
      await wait(delay)
      const current = find(id)
      state().connections.delete(id)
      const aws = current.kind !== 'GCP_TARGET'
      return { connection_id: id, deleted: true, stack_name: aws ? (current.kind === 'AWS_SOURCE' ? 'cmp-source-role' : 'cmp-target-role') : null,
        notice: aws ? 'Platform data removed. Delete the CloudFormation stack in your AWS account.' : 'Platform data removed.' }
    },
    async listEksClusters(id, region) {
      await wait(delay)
      const current = find(id)
      if (current.kind !== 'AWS_SOURCE') throw new PlatformError(409, 'conflict', 'SOURCE_CONNECTION_REQUIRED')
      if (current.status !== 'CONNECTED') throw new PlatformError(409, 'conflict', 'CONNECTION_NOT_READY')
      const chosen = region ?? current.region
      return { connection_id: id, region: chosen, eks_clusters: Object.keys(TREE[chosen] ?? {}) }
    },
    async tunnelStatus(_agentId, agent) {
      if (agent.revoked || agent.last_seen_at === null) return null
      return { tunnel_ip: '10.200.0.2', last_handshake_at: agent.last_seen_at, app_health_ok: true, db_connect_ok: true }
    },
    ...mockScope(find, { delayMs: delay, now }),
  }
}

/**
 * [가정] 이전 범위 선택(리전 → 클러스터 → Namespace → Deployment → 후보) 목업. 백엔드에 아직 없다.
 * 연결이 있는지·확인됐는지는 find로 묻는다: 목업 연결 저장소이거나, 실제 연결 API(real.ts)일 수 있다.
 */
export function mockScope(find: (id: string) => Connection | Promise<Connection>, options: { delayMs?: number; now?: () => number } = {}): Pick<ConnectionsApi, 'listScopeOptions' | 'analyzeScope' | 'confirmScope'> {
  const delay = options.delayMs ?? 350
  const now = options.now ?? Date.now
  const state = () => mockState(now())
  return {
    async listScopeOptions(level: ScopeLevel, selection: Partial<ScopeSelection>) {
      await wait(delay)
      if (selection.connection_id) await find(selection.connection_id)
      if (level === 'regions') return Object.keys(TREE)
      const region = TREE[selection.region ?? '']
      if (!region) throw new PlatformError(404, 'not_found', 'REGION_NOT_FOUND')
      if (level === 'clusters') return Object.keys(region) // #23: GET /connections/{id}/eks-clusters?region=
      const cluster = region[selection.cluster ?? '']
      if (!cluster) throw new PlatformError(404, 'not_found', 'CLUSTER_NOT_FOUND')
      if (level === 'namespaces') return Object.keys(cluster)
      const workloads = cluster[selection.namespace ?? '']
      if (!workloads) throw new PlatformError(404, 'not_found', 'NAMESPACE_NOT_FOUND')
      return workloads
    },
    async analyzeScope(selection) {
      await wait(delay * 4)
      const s = state()
      const source = await find(selection.connection_id)
      if (source.status !== 'CONNECTED') throw new PlatformError(409, 'conflict', 'CONNECTION_NOT_READY')
      // [가정] 범위 후보는 백엔드가 아직 못 만든다(앵커 목록 API·RDS/S3/SQS 스캔 없음, Evidence.kind는 매핑 뒤에만) — 목업 유지.
      const workloads = TREE[selection.region]?.[selection.cluster]?.[selection.namespace]
      if (!workloads?.includes(selection.workload)) throw new PlatformError(404, 'not_found', 'WORKLOAD_NOT_FOUND')
      s.seq += 1
      const analysis: ScopeAnalysis = { analysis_id: 'sa-' + s.seq, selection, candidates: candidatesFor(selection) }
      s.analyses.set(analysis.analysis_id, analysis)
      return analysis
    },
    async confirmScope(analysisId, included) {
      await wait(delay)
      const analysis = state().analyses.get(analysisId)
      if (!analysis) throw new PlatformError(404, 'not_found', 'ANALYSIS_NOT_FOUND')
      const ids = new Set(analysis.candidates.map(item => item.candidate_id))
      if (!included.length || included.some(id => !ids.has(id))) throw new PlatformError(400, 'bad_request', 'INVALID_SCOPE')
      const s = state()
      s.seq += 1
      return { scope_id: 'scope-' + s.seq, analysis_id: analysisId, included, excluded: [...ids].filter(id => !included.includes(id)), confirmed_at: new Date(now()).toISOString() } satisfies ScopeConfirmation
    },
  }
}

/**
 * 운영자 키가 없는 목업 데모 모드(NEXT_PUBLIC_API_MODE=mock)용 Agent 목업. 실제 API와 같은 응답·오류(404·409)를 흉내 낸다.
 * 토큰을 발급한 뒤 15초가 지나면 에이전트가 설치돼 접속한 것처럼 보인다.
 */
export function createMockAgents(options: { now?: () => number } = {}): AgentsApi {
  const now = options.now ?? Date.now
  const nowSec = () => Math.floor(now() / 1000)
  const state = () => mockState(now())
  const view = (id: string): PlatformAgent => {
    const found = state().agents.get(id)
    if (!found) throw new PlatformError(404, 'not_found', 'AGENT_NOT_FOUND')
    const { agent, enrolledAt } = found
    if (agent.revoked) return agent
    if (agent.last_seen_at === null && now() - enrolledAt < 15_000) throw new PlatformError(404, 'not_found', 'AGENT_NOT_FOUND')
    // 목업 에이전트는 몇 초마다 접속하는 것처럼 보인다.
    return { ...agent, cluster_uid: agent.cluster_uid ?? 'mock-' + id, last_seen_at: nowSec() - 4 }
  }
  return {
    mock: true,
    async issueEnrollment({ ownerId, agentId }) {
      await wait(300)
      if (state().agents.has(agentId)) throw new PlatformError(409, 'conflict', 'AGENT_ID_RESERVED')
      state().agents.set(agentId, { agent: { agent_id: agentId, owner_id: ownerId, cluster_uid: null, last_seen_at: null, revoked: false }, enrolledAt: now() })
      return { enrollment_token: 'mock-enroll-' + randomHex(16), expires_in_seconds: 0 }
    },
    async getAgent(agentId) {
      await wait(150)
      return view(agentId)
    },
    async revokeAgent(agentId) {
      await wait(300)
      const found = state().agents.get(agentId)
      if (!found || (found.agent.last_seen_at === null && now() - found.enrolledAt < 15_000)) throw new PlatformError(404, 'not_found', 'AGENT_NOT_FOUND')
      const current = view(agentId)
      found.agent = { ...current, revoked: true }
      return found.agent
    },
  }
}

/** 웹이 등록한 agent_id 기억(프로세스 메모리). PLATFORM_KNOWN_AGENT_IDS(쉼표 구분)로 재시작 뒤에도 보일 값을 미리 넣을 수 있다. */
export function memoryAgentIds(seedIds: string[] = []): AgentIdStore {
  const store = () => mockState().agentIds
  const state = mockState()
  if (!state.seededIds) { state.seededIds = true; for (const id of seedIds) state.agentIds.add(id) }
  return {
    list: () => [...store()],
    add: id => { store().add(id) },
    remove: id => { store().delete(id) },
  }
}
