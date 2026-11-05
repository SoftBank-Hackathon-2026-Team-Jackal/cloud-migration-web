/**
 * 백엔드 Preview(cmp_contracts.plan.Preview) → 화면의 계획 미리보기(PlanPreviewData) 어댑터. 순수 함수만 둔다(런타임 import 없음).
 * - changes[{resource_type, action, name, quantity, size}] → 만들 리소스 줄(이름·설명은 화면 사전, name은 backend_name)
 * - applied_defaults → changes의 같은 줄(유형·이름)에 defaulted 표시, 없으면 기본값 줄로 붙인다
 * - action READ·NO_CHANGE → 기존 사용(EXISTING: 대상에 이미 있는 것을 읽어 쓴다)
 * - warnings·errors·pending_decisions(ValidationIssue{code, path, message}) → PlanIssue(id = code, resource = path에서 찾은 리소스)
 * - Preview에 없는 PINNED·KEEP_SOURCE는 매핑에서 만든다: APP은 검증한 Digest가 있으면 Digest 고정,
 *   원본 유지(keep_source) 인프라 매핑 중 Preview에 같은 종류가 없는 것은 원본 유지 줄로 붙인다.
 * - env_remap·security_rules·source·target은 Preview에 없다(앱 Values·계획 입력). 감싸기에 없으면 비운다.
 */
import type { BackendPreviewData, PlanIssue, PlanNodeKind, PlanPreviewData, PlanReadyData, PlanResource, PlanResourceGroup, PlanStepData, PreviewChange, ValidationIssue } from './events'

const ID_OF_TYPE: Record<string, string> = { NETWORK: 'vpc', INGRESS: 'lb', CLUSTER: 'cluster', NODE: 'nodes', APP: 'app', DATABASE: 'db', STORAGE: 'storage' }
const GROUP_OF_TYPE: Record<string, PlanResourceGroup> = { NETWORK: 'network', INGRESS: 'network', CLUSTER: 'compute', NODE: 'compute', APP: 'compute', DATABASE: 'data', STORAGE: 'other' }
const KIND_OF_TYPE: Record<string, PlanNodeKind> = { NETWORK: 'network', INGRESS: 'ingress', CLUSTER: 'compute', NODE: 'compute', APP: 'compute', DATABASE: 'database', STORAGE: 'storage' }
const GROUP_OF_KIND: Partial<Record<PlanNodeKind, PlanResourceGroup>> = { network: 'network', ingress: 'network', compute: 'compute', proxy: 'compute', database: 'data', cache: 'data', config: 'data' }

function changeOf(action: string, type: string, pinned: boolean): PlanResource['change'] {
  if (action === 'DELETE') return 'DELETE'
  if (action === 'UPDATE') return 'UPDATE'
  if (action === 'NO_CHANGE' || action === 'READ') return 'EXISTING'
  return type === 'APP' && pinned ? 'PINNED' : 'CREATE'
}

function resourceOf(change: PreviewChange, id: string, pinned: boolean, defaulted: boolean): PlanResource {
  const type = String(change.resource_type)
  const quantity = change.quantity ?? undefined
  const size = change.size ?? ''
  return {
    id,
    group: GROUP_OF_TYPE[type] ?? 'other',
    kind: KIND_OF_TYPE[type] ?? 'other',
    // 이름·설명은 화면이 id로 자기 문구를 쓰고, 백엔드 name은 사전 설명이 없을 때 보조 설명으로 그대로 보인다.
    name: '',
    detail: '',
    backend_name: change.name,
    size: quantity && quantity > 1 && size ? size + ' × ' + quantity : size || (quantity ? String(quantity) : ''),
    change: changeOf(String(change.action), type, pinned),
    resource_type: type,
    ...(quantity !== undefined ? { quantity } : {}),
    ...(defaulted ? { defaulted: true } : {}),
  }
}

/** path(예: resources.db.backup)에서 리소스 id·이름을 찾아 경고를 그 줄에 단다. */
function issueOf(issue: ValidationIssue, resources: PlanResource[]): PlanIssue {
  const parts = issue.path.split(/[.[\]/]+/).filter(Boolean)
  const hit = resources.find(resource => parts.includes(resource.id) || (!!resource.backend_name && parts.includes(resource.backend_name)) || (resource.resource_type && parts.includes(resource.resource_type.toLowerCase())))
  return { id: issue.code, message: issue.message, ...(hit ? { resource: hit.id } : {}) }
}

export type AdaptContext = { steps: PlanStepData[]; meta: PlanReadyData | null; digest?: string | null }

export function adaptBackendPreview(raw: BackendPreviewData, context: AdaptContext): PlanPreviewData {
  const pinned = !!(context.meta?.verified_digest ?? context.meta?.built_digest ?? context.digest)
  const used = new Map<string, number>()
  const idFor = (type: string) => {
    const base = ID_OF_TYPE[type] ?? type.toLowerCase()
    const count = used.get(base) ?? 0
    used.set(base, count + 1)
    return count === 0 ? base : base + '-' + (count + 1)
  }
  const resources: PlanResource[] = (raw.changes ?? []).map(change => resourceOf(change, idFor(String(change.resource_type)), pinned, false))
  // applied_defaults: changes에 같은 리소스(유형·이름)가 있으면 그 줄을 '기본값'으로 표시하고, 없으면 기본값 줄로 붙인다.
  for (const change of raw.applied_defaults ?? []) {
    const index = resources.findIndex(resource => resource.resource_type === String(change.resource_type) && resource.backend_name === change.name)
    if (index >= 0) resources[index] = { ...resources[index], defaulted: true }
    else resources.push(resourceOf(change, idFor(String(change.resource_type)), pinned, true))
  }
  // 매핑의 원본 유지 항목 중 Preview가 다루지 않은 것(만들지 않으니 Preview에 없다)을 원본 유지 줄로 붙인다.
  for (const step of context.steps) {
    if (!step.keep_source || step.group !== 'infrastructure') continue
    const kind = step.kind ?? 'other'
    if (resources.some(resource => resource.id === step.id || (resource.kind === kind && resource.change === 'KEEP_SOURCE'))) continue
    resources.push({ id: step.id, group: GROUP_OF_KIND[kind] ?? 'other', kind, name: '', detail: '', size: '—', change: 'KEEP_SOURCE' })
  }
  return {
    plan_id: raw.plan_id ?? context.meta?.plan_id ?? '',
    revision: raw.revision ?? context.meta?.revision ?? 1,
    ...(raw.source ? { source: raw.source } : {}),
    ...(raw.target ? { target: raw.target } : {}),
    resources,
    env_remap: raw.env_remap ?? [],
    security_rules: raw.security_rules ?? [],
    validation: { errors: (raw.errors ?? []).map(issue => issueOf(issue, resources)), warnings: (raw.warnings ?? []).map(issue => issueOf(issue, resources)) },
    pending_decisions: (raw.pending_decisions ?? []).map(issue => issueOf(issue, resources)),
    manifest_digest: raw.manifest_digest,
  }
}
