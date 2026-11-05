/**
 * 구축 화면의 순수 도우미: 받은 provision.resource를 종류(무늬)·자리·주소로 바꾼다.
 * 리소스 key는 서버가 정하므로, 이름에 든 단어로 종류를 고르고 모르는 것은 'generic'으로 둔다.
 */
import type { ProvisionCheckData, ProvisionResourceData } from './events'
import type { Target } from '../stages'

export type ResourceKind = 'network' | 'cluster' | 'compute' | 'database' | 'edge' | 'security' | 'agent' | 'generic'
export const KIND_ORDER: ResourceKind[] = ['network', 'cluster', 'compute', 'database', 'edge', 'security', 'agent', 'generic']

const KIND_RULES: [ResourceKind, RegExp][] = [
  ['agent', /agent/],
  ['network', /net|vpc|subnet/],
  ['database', /(^|[^a-z])db|sql|postgres|mysql|redis|database|storage|volume/],
  ['cluster', /cluster|gke|eks|k3s|k8s|node/],
  ['edge', /(^|[^a-z])lb|load|ingress|relay|gateway|proxy|tunnel/],
  ['security', /cert|tls|ssl|dns|domain|secret|iam/],
  ['compute', /app|deploy|service|run|vm|compute|pod|instance/],
]

export function kindOf(resource: Pick<ProvisionResourceData, 'key' | 'name'>): ResourceKind {
  // key가 먼저다(이름의 'Kubernetes'가 'net'에 걸리지 않게). key로 모르면 이름으로 한 번 더 본다.
  for (const text of [resource.key, resource.name ?? '']) {
    const lower = text.toLowerCase()
    for (const [kind, rule] of KIND_RULES) if (rule.test(lower)) return kind
  }
  return 'generic'
}

/** 엔지니어가 알아보는 리소스 주소(테라폼 표기). 모르는 key는 resource.<key> */
const ADDRESS: Record<Target, Record<string, string>> = {
  gcp: {
    network: 'google_compute_network.vpc', cluster: 'google_container_cluster.main', db: 'kubernetes_stateful_set.postgres',
    app: 'kubernetes_deployment.app', lb: 'google_compute_global_forwarding_rule.https', cert: 'google_compute_managed_ssl_certificate.app',
  },
  onprem: {
    agent: 'agent.register', cluster: 'k3s_cluster.colima', db: 'kubernetes_stateful_set.postgres',
    app: 'kubernetes_deployment.app', relay: 'wireguard_peer.relay', cert: 'kubernetes_secret.tls',
  },
}
export const addressOf = (target: Target, key: string) => ADDRESS[target][key] ?? 'resource.' + key.replace(/[^a-zA-Z0-9_]/g, '_')

/** 블록 이름표 둘째 줄(짧은 사양). 받은 detail이 있으면 그것이 먼저다. */
const SPEC: Record<Target, Record<string, string>> = {
  gcp: { network: 'vpc · 10.20.0.0/16', cluster: 'node-pool ×1 · e2-standard-4', db: 'StatefulSet · PV 20GiB', app: 'app@sha256 · :8080', lb: 'HTTPS 443 → 8080', cert: 'app.example.com · TLS' },
  onprem: { agent: 'agent-001 · outbound', cluster: 'K3s · local-path', db: 'StatefulSet · PV 20GiB', app: 'app@sha256 · :8080', relay: 'WireGuard · public IP', cert: 'app.example.com · TLS' },
}
export const specOf = (target: Target, key: string) => SPEC[target][key]

/** 바닥(대상 영역)과 서브넷 이름 */
export const REGION: Record<Target, { floor: string; command: string; subnets: [string, string] }> = {
  gcp: { floor: 'GCP · project demo-prod · region asia-northeast3', command: 'gcp/asia-northeast3', subnets: ['public 10.20.0.0/24', 'private 10.20.1.0/24'] },
  onprem: { floor: 'ON-PREM · laptop · K3s (Colima)', command: 'onprem/k3s', subnets: ['relay · public', 'laptop · private'] },
}

/** 검사 이름 → 통과하면 금색이 되는 리소스 종류. retest는 전부. */
const CHECK_KINDS: Record<string, ResourceKind[] | 'all'> = {
  pods_ready: ['cluster', 'compute'], db_connect: ['database'], app_health: ['compute', 'edge', 'security'], retest: 'all',
}
export function readyKinds(checks: ProvisionCheckData[]): Set<ResourceKind> | 'all' {
  const kinds = new Set<ResourceKind>()
  for (const check of checks) {
    if (check.state !== 'done') continue
    const mapped = CHECK_KINDS[check.name]
    if (mapped === 'all') return 'all'
    mapped?.forEach(kind => kinds.add(kind))
  }
  return kinds
}
