'use client'

import { useT, useTOr, type MsgKey } from '../lib/i18n'
import type { Target } from '../lib/stages'
import type { Grade, PlanPreviewData, PlanStepData } from '../lib/migration/events'
import { planSummary, planWarnings } from '../lib/migration/planModel'
import { issueText, stepText } from './planText'

/** pass: 통과 · warn: 승인 때 확인할 것 · block: 승인 불가 · keep: 이번 범위 밖(원본 유지) */
type Verdict = 'pass' | 'warn' | 'block' | 'keep'
type Row = { id: string; verdict: Verdict; note: string }

const MARK: Record<Verdict, string> = { pass: '✓', warn: '!', block: '✕', keep: '—' }
const GRADES: Grade[] = ['DIRECT', 'API_DIFF', 'PARTIAL', 'NONE']

/**
 * 정책 판정을 받은 계획 데이터에서 계산한다(순수 함수).
 * 매핑 처리·등급·검증 근거·원본 유지는 매핑 항목(plan.step)에서, 노출·기본 차단·시크릿·검증 문제는 미리보기(plan.preview)에서 읽는다.
 * 받은 값이 없는 정책 줄은 만들지 않는다(근거 없는 판정을 보이지 않는다).
 */
function governanceRows(steps: PlanStepData[], preview: PlanPreviewData | null, text: {
  join: (parts: Array<[MsgKey, number]>) => string
  keepNote: (names: string[]) => string
  issue: (preview: PlanPreviewData) => string
  role: (role: string) => string
  t: (key: MsgKey, params?: Record<string, string | number>) => string
}): Row[] {
  const rows: Row[] = []
  const { t, join } = text
  if (steps.length > 0) {
    const summary = planSummary(steps)
    const moved = steps.filter(step => !step.keep_source)
    rows.push({
      id: 'mapping',
      verdict: summary.block > 0 ? 'block' : summary.approval > 0 ? 'warn' : 'pass',
      note: join([['plan.summary.proceed', summary.proceed], ['plan.summary.approval', summary.approval], ['plan.summary.block', summary.block]]),
    })
    const count = (grade: Grade) => moved.filter(step => step.grade === grade).length
    rows.push({
      id: 'grades',
      verdict: count('NONE') > 0 ? 'block' : count('PARTIAL') > 0 ? 'warn' : 'pass',
      note: GRADES.filter(grade => count(grade) > 0).map(grade => t(('plan.grade.' + grade) as MsgKey) + ' ' + count(grade)).join(' · '),
    })
    const unverified = moved.filter(step => step.verification === 'UNVERIFIED').length
    rows.push({
      id: 'verification',
      verdict: unverified > 0 ? 'warn' : 'pass',
      note: join([['gov.n.sandbox', moved.filter(step => step.verification === 'SANDBOX_VERIFIED').length], ['gov.n.evidence', moved.filter(step => step.verification === 'EVIDENCE_CHECKED').length], ['gov.n.unverified', unverified]]),
    })
    const kept = steps.filter(step => step.keep_source && step.group === 'infrastructure')
    if (kept.length > 0) rows.push({ id: 'keep', verdict: 'keep', note: text.keepNote(kept.map(step => step.id)) })
  }
  if (preview) {
    const rules = preview.security_rules
    const allowed = rules.filter(rule => rule.action === 'ALLOW')
    const fromInternet = allowed.filter(rule => rule.from === 'internet')
    const dataExposed = fromInternet.some(rule => rule.to === 'db' || rule.to === '*')
    if (rules.length > 0) {
      rows.push({
        id: 'exposure',
        verdict: dataExposed || fromInternet.length > 1 ? 'warn' : 'pass',
        note: fromInternet.length === 0 ? t('gov.exposure.none') : fromInternet.map(rule => t('gov.exposure.rule', { to: text.role(rule.to), port: rule.port ?? '*' })).join(' · '),
      })
      const deny = rules.some(rule => rule.action === 'DENY' && rule.from === '*' && rule.to === '*')
      rows.push({ id: 'deny', verdict: deny ? 'pass' : 'warn', note: t(deny ? 'gov.deny.on' : 'gov.deny.off', { n: allowed.length }) })
    }
    const secrets = preview.env_remap.filter(item => item.secret)
    if (secrets.length > 0) {
      const byRef = secrets.every(item => item.to && /^[a-z0-9]+:\/\//i.test(item.to))
      rows.push({ id: 'secrets', verdict: byRef ? 'pass' : 'warn', note: t(byRef ? 'gov.secrets.ref' : 'gov.secrets.raw', { n: secrets.length }) })
    }
    const { errors } = preview.validation
    const warnings = planWarnings(preview)
    rows.push({ id: 'validation', verdict: errors.length > 0 ? 'block' : warnings.length > 0 ? 'warn' : 'pass', note: text.issue(preview) })
  }
  return rows
}

/**
 * 정책 × 대상 판정표(킥오프의 "보안·거버넌스 통합 시각화"). 판정은 계획이 보낸 매핑 결과와 미리보기에서 계산한다.
 */
export default function GovernanceMatrix({ target, steps, preview }: { target: Target; steps: PlanStepData[]; preview: PlanPreviewData | null }) {
  const t = useT()
  const tOr = useTOr()
  const rows = governanceRows(steps, preview, {
    t,
    role: role => tOr('plan.role.' + role, role),
    join: parts => parts.filter(([, n]) => n > 0).map(([key, n]) => t(key, { n })).join(' · ') || t('gov.none'),
    keepNote: ids => {
      const names = ids.map(id => stepText(tOr, steps.find(step => step.id === id)!, target, 'before'))
      return t('gov.keep.note', { names: names.join(', ') })
    },
    issue: data => {
      const first = data.validation.errors[0] ?? planWarnings(data)[0]
      return first ? issueText(tOr, first) : t('gov.validation.clean')
    },
  })
  if (rows.length === 0) return <p className="gov-empty">{t('gov.empty')}</p>
  const warn = rows.filter(row => row.verdict === 'warn').length
  const block = rows.filter(row => row.verdict === 'block').length
  return <div className="gov" role="table" aria-label={t('gov.aria')}>
    <div className="gov-row gov-head" role="row">
      <span role="columnheader">{t('gov.policy')}</span>
      <span role="columnheader">{t(('target.' + target + '.short') as MsgKey)}</span>
    </div>
    {rows.map(row => <div key={row.id} className={'gov-row is-' + row.verdict} role="row">
      <span role="cell"><strong>{t(('gov.' + row.id) as MsgKey)}</strong><small>{row.note}</small></span>
      <span role="cell" className="gov-verdict">
        <span className={'gov-mark is-' + row.verdict} aria-hidden="true">{MARK[row.verdict]}</span>
        <em>{t(('gov.verdict.' + row.verdict) as MsgKey)}</em>
      </span>
    </div>)}
    <p className="flow-note">{t('gov.summary', { warn, block })}</p>
  </div>
}
