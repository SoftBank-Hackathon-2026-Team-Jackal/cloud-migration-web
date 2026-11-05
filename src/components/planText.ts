/**
 * 계획 데이터의 문구 규칙(계획 화면과 승인 화면이 함께 쓴다): 이벤트 값이 있으면 그대로, 비어 있으면 id로 사전에서 찾는다.
 */
import type { Target } from '../lib/stages'
import type { PlanEnvironment, PlanIssue, PlanStepData } from '../lib/migration/events'
import type { TranslateOr } from '../lib/i18n'

// GCP 대상일 때만 문구가 다른 항목(사전에 gcpAfter / gcpChange 키가 있는 것)
const GCP_AFTER = new Set(['network', 'compute'])
const GCP_CHANGE = new Set(['network'])

/** 매핑 항목 문구: 이벤트 값 → 대상별 사전 문구(GCP) → 공통 사전 문구 → id */
export function stepText(tOr: TranslateOr, step: PlanStepData, target: Target, field: 'before' | 'after' | 'evidence' | 'change') {
  if (step[field]) return step[field]
  const gcp = target === 'gcp'
  if (field === 'after' && gcp && GCP_AFTER.has(step.id)) return tOr('plan.step.' + step.id + '.gcpAfter', step.id)
  if (field === 'change' && gcp && GCP_CHANGE.has(step.id)) return tOr('plan.step.' + step.id + '.gcpChange')
  return tOr('plan.step.' + step.id + '.' + field, field === 'before' || field === 'after' ? step.id : '')
}

export const issueText = (tOr: TranslateOr, issue: PlanIssue) => issue.message || tOr('plan.warn.' + issue.id, issue.id)

/** 환경 이름: 제공자(사전) + "플랫폼 · 지역(사전)" */
export function placeText(tOr: TranslateOr, env: PlanEnvironment) {
  return { provider: tOr('plan.provider.' + env.provider, env.provider), place: [env.platform, tOr('region.' + env.location, env.location)].filter(Boolean).join(' · ') }
}
