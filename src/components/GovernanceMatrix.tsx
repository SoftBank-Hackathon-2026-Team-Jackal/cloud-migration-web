'use client'

import { useT, type MsgKey } from '../lib/i18n'
import type { Target } from '../lib/stages'

type Verdict = 'pass' | 'warn' | 'na'

/**
 * 정책 × 환경 매트릭스(킥오프의 "보안·거버넌스 통합 시각화", 승철님의 거버넌스 매트릭스 구상).
 * 이 화면의 판정은 지금까지 분석·샌드박스·승인 단계에서 나온 내용을 근거로 한 데모 판정이다.
 */
const ROWS: Array<{ id: string; before: Verdict; after: (target: Target) => Verdict }> = [
  { id: 'exposure', before: 'pass', after: () => 'pass' },
  { id: 'transit', before: 'pass', after: () => 'pass' },
  { id: 'secrets', before: 'pass', after: () => 'pass' },
  { id: 'access', before: 'pass', after: () => 'pass' },
  { id: 'residency', before: 'na', after: () => 'pass' },
  { id: 'availability', before: 'pass', after: () => 'warn' },
  { id: 'storage', before: 'pass', after: () => 'warn' },
  { id: 'audit', before: 'na', after: () => 'pass' },
  { id: 'rollback', before: 'na', after: () => 'pass' },
]

const MARK: Record<Verdict, string> = { pass: '✓', warn: '!', na: '—' }

export default function GovernanceMatrix({ target }: { target: Target }) {
  const t = useT()
  const warnings = ROWS.filter(row => row.after(target) === 'warn').length
  return <div className="gov" role="table" aria-label={t('gov.aria')}>
    <div className="gov-row gov-head" role="row">
      <span role="columnheader">{t('gov.policy')}</span>
      <span role="columnheader">AWS</span>
      <span role="columnheader">{t(('target.' + target + '.short') as MsgKey)}</span>
    </div>
    {ROWS.map(row => {
      const after = row.after(target)
      return <div key={row.id} className="gov-row" role="row">
        <span role="cell"><strong>{t(('gov.' + row.id) as MsgKey)}</strong><small>{t(('gov.' + row.id + '.note') as MsgKey)}</small></span>
        <span role="cell" className={'gov-mark is-' + row.before} aria-label={row.before}>{MARK[row.before]}</span>
        <span role="cell" className={'gov-mark is-' + after} aria-label={after}>{MARK[after]}</span>
      </div>
    })}
    <p className="flow-note">{t('gov.summary', { n: warnings })}</p>
  </div>
}
