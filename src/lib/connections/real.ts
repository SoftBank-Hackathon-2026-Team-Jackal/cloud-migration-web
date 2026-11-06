import type { ConnectionsApi } from './adapter.ts'
import { call, PlatformError, type PlatformDeps } from './platform.ts'
import { AWS_REGIONS, type ClusterList, type Connection, type ConnectionKind, type ConnectionStatus, type CreatedConnection, type DeletedConnection, type ScopeAnalysis, type ScopeConfirmation, type ScopeSelection, type TunnelStatus, type VerifyResult } from './types.ts'

/**
 * 연결 관리의 실제 어댑터: 플랫폼 API(백엔드 Ticket 23, ADR-005)의 /connections를 웹 서버 안에서 부른다.
 * 운영자 키(X-Enrollment-Admin-Key)는 platform.ts의 call이 붙이고, 응답·오류에는 넣지 않는다.
 * - Launch Stack 링크(launch_stack_url)는 백엔드가 만든다. 백엔드에 템플릿 주소·플랫폼 주체 ARN이 설정되지 않았으면 null이다.
 * - 목록 응답(요약)에는 역할 ARN·External ID·마지막 코드가 없어서 연결마다 상세를 한 번 더 읽는다.
 * - EKS 클러스터 목록은 확인(verify) 결과를 웹 서버 메모리에 기억해 두고 쓴다. 목록을 새로 고칠 때마다 AWS를 부르지 않는다.
 * - 이전 범위 선택(Ticket 56): 리전은 연결 리전 + 지원 리전 목록, 그 아래(클러스터 → Namespace → 워크로드 → 후보 → 확정)는 플랫폼이 실제로 읽는다.
 */

type Detail = {
  connection_id: string
  kind: ConnectionKind
  display_name: string
  region: string
  status: ConnectionStatus
  account_id?: string | null
  project_id?: string | null
  role_arn?: string | null
  external_id?: string | null
  last_code?: string | null
  last_verified_at?: number | null
}
type Summary = Pick<Detail, 'connection_id' | 'kind' | 'display_name' | 'region' | 'status' | 'account_id' | 'project_id' | 'last_verified_at'>
type TunnelSummary = { tunnel_ip: string; last_handshake_at: number | null; app_health_ok: boolean; db_connect_ok: boolean; stale?: boolean }
type AgentSummary = { agent_id: string; tunnel: TunnelSummary | null }

const KEY = Symbol.for('jackal.connections.eks')
type Global = typeof globalThis & { [KEY]?: Map<string, string[]> }
/** connection_id → 확인 때 읽은 EKS 클러스터 이름(프로세스 메모리). Next가 라우트마다 모듈을 따로 묶어도 같은 값을 보게 globalThis에 둔다. */
const eksMemory = () => ((globalThis as Global)[KEY] ??= new Map())

const id = (value: string) => encodeURIComponent(value)

function toConnection(data: Detail, eks?: string[]): Connection {
  if (!data || typeof data.connection_id !== 'string') throw new PlatformError(502, 'platform_error')
  const aws = data.kind !== 'GCP_TARGET'
  return {
    connection_id: data.connection_id,
    kind: data.kind,
    display_name: data.display_name,
    status: data.status,
    region: data.region,
    last_verified_at: data.last_verified_at ?? null,
    last_code: data.last_code ?? null,
    ...(aws
      ? { account_id: data.account_id ?? null, ...(data.role_arn ? { role_arn: data.role_arn } : {}), ...(data.external_id ? { external_id: data.external_id } : {}), ...(eks ? { eks_clusters: eks } : {}) }
      : { project_id: data.project_id ?? null }),
  }
}

export function createRealConnections(deps: PlatformDeps): ConnectionsApi {
  const detail = (connectionId: string) => call<Detail>(deps, 'GET', '/connections/' + id(connectionId))

  /** 확인된 원본 연결의 EKS 목록: 기억한 값, 없으면(웹 서버 재시작) 한 번만 읽어 기억한다. 실패해도 목록은 보여 준다. */
  async function eksFor(connection: Detail): Promise<string[] | undefined> {
    if (connection.kind !== 'AWS_SOURCE' || connection.status !== 'CONNECTED') return undefined
    const known = eksMemory().get(connection.connection_id)
    if (known) return known
    try {
      const list = await call<ClusterList>(deps, 'GET', '/connections/' + id(connection.connection_id) + '/eks-clusters')
      eksMemory().set(connection.connection_id, list.eks_clusters)
      return list.eks_clusters
    } catch { return undefined }
  }

  async function full(connectionId: string): Promise<Connection> {
    const data = await detail(connectionId)
    return toConnection(data, await eksFor(data))
  }

  return {
    mock: false,
    async listConnections() {
      const list = await call<{ connections: Summary[] }>(deps, 'GET', '/connections')
      return Promise.all((list.connections ?? []).map(async summary => {
        // 상세를 못 읽으면 요약만이라도 보여 준다.
        try { return await full(summary.connection_id) } catch { return toConnection(summary) }
      }))
    },
    async createConnection(input) {
      return await call<CreatedConnection>(deps, 'POST', '/connections', { kind: input.kind, display_name: input.display_name, region: input.region })
    },
    async setRole(connectionId, roleArn) {
      const data = await call<Detail>(deps, 'PUT', '/connections/' + id(connectionId) + '/role', { role_arn: roleArn })
      return toConnection(data, await eksFor(data))
    },
    async verifyConnection(connectionId) {
      const result = await call<VerifyResult>(deps, 'POST', '/connections/' + id(connectionId) + '/verify')
      if (result.status === 'CONNECTED' && result.eks_clusters) eksMemory().set(connectionId, result.eks_clusters)
      if (result.status === 'FAILED') eksMemory().delete(connectionId)
      return result
    },
    async deleteConnection(connectionId) {
      const result = await call<DeletedConnection>(deps, 'DELETE', '/connections/' + id(connectionId))
      eksMemory().delete(connectionId)
      return result
    },
    async listEksClusters(connectionId, region) {
      return await call<ClusterList>(deps, 'GET', '/connections/' + id(connectionId) + '/eks-clusters' + (region ? '?region=' + id(region) : ''))
    },
    async tunnelStatus(agentId) {
      // GET /agent-admin/agents: Agent마다 마지막 터널 보고(Ticket 25). 오래된 보고(stale)의 앱·DB 결과는 모름(null)으로 둔다.
      const list = await call<{ agents: AgentSummary[] }>(deps, 'GET', '/agent-admin/agents')
      const tunnel = list.agents?.find(agent => agent.agent_id === agentId)?.tunnel
      if (!tunnel) return null
      const fresh = tunnel.stale !== true
      return {
        tunnel_ip: tunnel.tunnel_ip,
        last_handshake_at: tunnel.last_handshake_at,
        app_health_ok: fresh ? tunnel.app_health_ok : null,
        db_connect_ok: fresh ? tunnel.db_connect_ok : null,
      } satisfies TunnelStatus
    },
    async listScopeOptions(level, selection) {
      const connectionId = selection.connection_id ?? ''
      const base = '/connections/' + id(connectionId)
      const region = selection.region ? '?region=' + id(selection.region) : ''
      if (level === 'regions') {
        // 리전 목록 API는 없다: 연결의 리전을 맨 앞에 두고 지원 리전을 잇는다(연결이 없으면 404).
        const connection = await detail(connectionId)
        return [...new Set([connection.region, ...AWS_REGIONS])]
      }
      if (level === 'clusters') return (await call<ClusterList>(deps, 'GET', base + '/eks-clusters' + region)).eks_clusters
      const cluster = base + '/eks-clusters/' + id(selection.cluster ?? '')
      if (level === 'namespaces') return (await call<{ namespaces: string[] }>(deps, 'GET', cluster + '/namespaces' + region)).namespaces
      const list = await call<{ workloads: { kind: string; name: string }[] }>(deps, 'GET', cluster + '/namespaces/' + id(selection.namespace ?? '') + '/workloads' + region)
      // 화면은 이름만 고른다. 같은 이름의 Deployment·StatefulSet이 있으면 백엔드가 Deployment를 먼저 고른다.
      return [...new Set(list.workloads.map(workload => workload.name))]
    },
    async analyzeScope(selection) {
      const result = await call<ScopeAnalysis & { selection: ScopeSelection & { workload_kind?: string } }>(deps, 'POST', '/connections/' + id(selection.connection_id) + '/scope-analyses',
        { region: selection.region, cluster: selection.cluster, namespace: selection.namespace, workload: selection.workload })
      // 웹 형태에 없는 workload_kind는 빼고 돌려준다.
      const { connection_id, region, cluster, namespace, workload } = result.selection
      return { analysis_id: result.analysis_id, selection: { connection_id, region, cluster, namespace, workload }, candidates: result.candidates }
    },
    async confirmScope(analysisId, included) {
      return await call<ScopeConfirmation>(deps, 'POST', '/scope-analyses/' + id(analysisId) + '/confirm', { included })
    },
  }
}
