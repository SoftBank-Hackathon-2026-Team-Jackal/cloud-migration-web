/**
 * 계획 화면이 받은 데이터에서 계산하는 값(요약 수, 경고, 구성도 노드 분류). 순수 함수만 둔다(런타임 import 없음).
 * 서버가 무엇을 보내든(앱마다 리소스가 다르다) 같은 규칙으로 화면을 그리려는 것이다.
 */
import type { PlanIssue, PlanNodeKind, PlanPreviewData, PlanResource, PlanStepData } from './events'
import type { MigrationState } from './reducer'

/** 매핑 요약: 원본 유지는 따로 세고, 나머지는 처리(진행·승인 필요·차단)별로 센다. 합은 항상 전체 매핑 수다. */
export function planSummary(steps: PlanStepData[]) {
  const moved = steps.filter(step => !step.keep_source)
  return {
    total: steps.length,
    proceed: moved.filter(step => step.action === 'PROCEED').length,
    approval: moved.filter(step => step.action === 'APPROVAL').length,
    block: moved.filter(step => step.action === 'BLOCK').length,
    keep: steps.length - moved.length,
  }
}

/** 경고는 한 목록에서만 센다: 검증 경고 + 리소스에만 달려 온 경고(같은 리소스의 경고는 하나로). */
export function planWarnings(preview: PlanPreviewData | null): PlanIssue[] {
  if (!preview) return []
  const list = [...preview.validation.warnings]
  for (const resource of preview.resources) {
    if (resource.warning && !list.some(issue => issue.resource === resource.id)) list.push({ id: 'res-' + resource.id, resource: resource.id, message: resource.warning })
  }
  return list
}

/** 원본·대상 리소스 분류. 서버가 kind를 주지 않으면 id·문구로 짐작한다. */
export function kindOf(item: { id: string; kind?: PlanNodeKind; before?: string; after?: string; name?: string }): PlanNodeKind {
  if (item.kind) return item.kind
  const text = (item.id + ' ' + (item.before ?? '') + ' ' + (item.name ?? '')).toLowerCase()
  if (/pgbouncer|proxy|pooler/.test(text)) return 'proxy'
  if (/redis|memcache|cache/.test(text)) return 'cache'
  if (/sqs|kafka|queue|pubsub|rabbit/.test(text)) return 'queue'
  if (/s3|bucket|storage|blob|gcs/.test(text)) return 'storage'
  if (/postgres|mysql|database|rds|\bdb\b|sql/.test(text)) return 'database'
  if (/alb|nlb|elb|ingress|lb\b|load ?balancer|gateway/.test(text)) return 'ingress'
  if (/vpc|subnet|network|nat/.test(text)) return 'network'
  if (/env|config|secret|code/.test(text)) return 'config'
  if (/eks|ec2|compute|deploy|app|pod|node|cluster|service/.test(text)) return 'compute'
  return 'other'
}

/** 구성도 줄 순서: 진입 → 실행 → 중간(프록시) → 데이터 */
const TIER: Record<PlanNodeKind, number> = { ingress: 0, network: 0, compute: 1, proxy: 2, database: 3, cache: 4, queue: 5, storage: 6, other: 7, config: 9 }
export function tierOf(kind: PlanNodeKind) { return TIER[kind] }

/** 구성도에 노드로 놓을 매핑: 인프라 항목 중 설정(config)이 아닌 것, 줄 순서대로 */
export function diagramSteps(steps: PlanStepData[]) {
  return steps
    .filter(step => step.group === 'infrastructure' && kindOf(step) !== 'config')
    .map((step, index) => ({ step, kind: kindOf(step), index }))
    .sort((a, b) => tierOf(a.kind) - tierOf(b.kind) || a.index - b.index)
}

/** 대상 구성 표의 묶음 순서. 원본 유지(KEEP_SOURCE)는 원래 묶음과 관계없이 마지막 '원본 유지' 묶음으로 간다. */
export const LEDGER_GROUPS = ['network', 'compute', 'data', 'other', 'keep'] as const
export type LedgerGroup = (typeof LEDGER_GROUPS)[number]
export function ledgerGroupOf(resource: PlanResource): LedgerGroup {
  return resource.change === 'KEEP_SOURCE' ? 'keep' : resource.group
}

/** 분석·계획이 오브젝트 저장소를 보고했는가. 아무 결과도 없으면(시연용 단계 이동) 예전처럼 보여 준다. */
export function reportsStorage(state: Pick<MigrationState, 'analysis' | 'plan'>): boolean {
  const findings = state.analysis.findings
  const steps = state.plan.steps
  const resources = state.plan.preview?.resources ?? []
  if (findings.length === 0 && steps.length === 0 && resources.length === 0) return true
  return findings.some(finding => kindOf({ id: finding.key, name: finding.message }) === 'storage')
    || steps.some(step => kindOf(step) === 'storage')
    || resources.some(resource => kindOf(resource) === 'storage')
}
