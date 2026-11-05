/**
 * 계획 화면이 받은 데이터에서 계산하는 값(요약 수, 경고, 구성도 노드 분류). 순수 함수만 둔다(런타임 import 없음).
 * 서버가 무엇을 보내든(앱마다 리소스가 다르다) 같은 규칙으로 화면을 그리려는 것이다.
 */
import type { BuildFixData, PlanEnvironment, PlanIssue, PlanNodeKind, PlanPreviewData, PlanResource, PlanStepData, Target } from './events'
import type { MigrationState } from './reducer'
import { PENDING_DECISION_ROW, ROLLOUT_POLICY_DEFAULTS } from './policy.ts'
import { estimateCost, type CostView } from './pricing.ts'

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
  const scanItems = (state.analysis.scans ?? []).flatMap(scan => scan.items)
  const steps = state.plan.steps
  const resources = state.plan.preview?.resources ?? []
  if (findings.length === 0 && scanItems.length === 0 && steps.length === 0 && resources.length === 0) return true
  return findings.some(finding => kindOf({ id: finding.key, name: finding.message }) === 'storage')
    || scanItems.some(item => kindOf({ id: item.key }) === 'storage')
    || steps.some(step => kindOf(step) === 'storage')
    || resources.some(resource => kindOf(resource) === 'storage')
}

/** 계획이 전환 단계를 보내지 않았을 때 쓰는 기본 단계(정책 기본값, policy.ts) */
export const DEFAULT_TRAFFIC_STEPS = ROLLOUT_POLICY_DEFAULTS.traffic_steps

/** 계획이 원본 환경을 보내지 않았을 때(Preview에는 없다) 쓰는 원본. 이 데모의 원본은 서울 리전의 EKS다. */
export const SOURCE_FALLBACK: PlanEnvironment = { provider: 'AWS', platform: 'EKS', location: 'ap-northeast-2' }
/** 계획이 대상 환경을 보내지 않았을 때 설정 화면의 대상으로 만든다(provider·기본 지역). */
const TARGET_FALLBACK: Record<Target, PlanEnvironment> = {
  gcp: { provider: 'GCP', platform: '', location: 'asia-northeast3' },
  onprem: { provider: 'ON_PREM', platform: '', location: '' },
}
export function targetEnvOf(preview: PlanPreviewData | null, target: Target): PlanEnvironment {
  return preview?.target ?? TARGET_FALLBACK[target]
}

/**
 * 비용 탭의 값. 계획이 요금 추정(cost)을 보내면 그대로 쓰고, 아니면 가격표(pricing.ts)로 계산한다:
 * 원본은 분석 스캔의 인벤토리, 대상은 미리보기의 리소스. 대상이 온프레미스면 추가 클라우드 비용이 없다(noCloudTarget).
 */
export function costViewOf(state: Pick<MigrationState, 'analysis' | 'plan'>, target: Target): CostView | null {
  const preview = state.plan.preview
  if (preview?.cost) return { ...preview.cost, bases: preview.cost.basis ? [{ provider: '', region: '', date: preview.cost.basis, basis: '' }] : [], noCloudTarget: target === 'onprem' }
  return estimateCost({ source: preview?.source ?? SOURCE_FALLBACK, target: targetEnvOf(preview, target), scans: state.analysis.scans ?? [], resources: preview?.resources ?? [] })
}

/**
 * 승인 화면 요약의 값. 모두 받은 데이터에서 계산하고, 없는 값은 null로 둔다(화면이 '받지 못함'으로 보인다).
 * - changes: 옮기는 매핑 수(인프라·코드 설정), 원본 유지 수, 처리별 수
 * - sandbox: 판정이 끝난 마지막 시도의 필수 테스트 결과. 없으면 매핑 항목의 검증 상태로 대신 센다.
 * - traffic: 계획의 전환 단계(없으면 기본 단계, defaulted로 표시)
 */
export function approvalFacts(state: Pick<MigrationState, 'plan' | 'sandbox' | 'traffic'> & { approval?: Pick<MigrationState['approval'], 'pendingDecisions'> }) {
  const steps = state.plan.steps
  const moved = steps.filter(step => !step.keep_source)
  const summary = planSummary(steps)
  const last = state.sandbox.attempts[state.sandbox.attempts.length - 1]
  const sandbox = last
    ? { kind: 'tests' as const, passed: last.checks.required_passed, total: last.checks.required_total, attempt: last.attempt, ok: last.verdict.passed }
    : steps.length > 0
      ? { kind: 'mapping' as const, passed: moved.filter(step => step.verification === 'SANDBOX_VERIFIED').length, total: moved.length, attempt: null, ok: moved.every(step => step.verification !== 'UNVERIFIED') }
      : null
  const rollout = state.plan.preview?.rollout
  const planned = rollout?.traffic_steps?.filter(value => value > 0 && value <= 100) ?? []
  const live = state.traffic.snapshot?.steps ?? []
  const trafficSteps = planned.length > 0 ? planned : live.length > 0 ? live : DEFAULT_TRAFFIC_STEPS
  // 승인 전에 정해야 할 값: 미리보기의 pending_decisions + 승인 요청의 pending_decisions(code, 중복 없이)
  const pending = [...new Set([...(state.plan.preview?.pending_decisions ?? []).map(issue => issue.id), ...(state.approval?.pendingDecisions ?? [])])]
  const pause = rollout?.expected_write_pause_ms
  return {
    hasPlan: steps.length > 0,
    changes: {
      infrastructure: moved.filter(step => step.group === 'infrastructure').length,
      code: moved.filter(step => step.group === 'code').length,
      keep: summary.keep,
      approval: summary.approval,
      block: summary.block,
    },
    sandbox,
    database: steps.find(step => kindOf(step) === 'database' && !step.keep_source) ?? null,
    traffic: { steps: trafficSteps, method: rollout?.traffic_method ?? null, defaulted: planned.length === 0 && live.length === 0 },
    /** 계획이 보내지 않으면 정책 기본값(defaulted) */
    writePause: { ms: pause ?? ROLLOUT_POLICY_DEFAULTS.expected_write_pause_ms, defaulted: pause === undefined },
    dataMethod: { value: rollout?.data_method ?? ROLLOUT_POLICY_DEFAULTS.data_method, defaulted: rollout?.data_method === undefined },
    /** pending_decisions code를 요약의 줄로 나눈다: 롤백·정리 정책 줄 · 제외·한계 목록 */
    pending: { rollback: pending.filter(code => PENDING_DECISION_ROW[code] === 'rollback'), excluded: pending.filter(code => PENDING_DECISION_ROW[code] !== 'rollback') },
    keepSteps: steps.filter(step => step.keep_source),
  }
}

/** Fixer 수정이 새로 읽게 된 환경 변수(중복 없이, 받은 순서). build.fix의 new_env_keys [가정]에서 센다. */
export function fixerEnvKeys(fixes: BuildFixData[]): string[] {
  return [...new Set(fixes.flatMap(fix => fix.new_env_keys ?? []))]
}
