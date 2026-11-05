'use client'

import { useT, useTOr, type MsgKey } from '../lib/i18n'
import type { Target } from '../lib/stages'
import type { CostEstimate, CostLine } from '../lib/migration/events'

const usd = (value: number) => '$' + value.toFixed(1)

/** 합계는 양쪽 값이 모두 있는 줄만 더한다(한쪽이 추정 대기면 비교가 맞지 않는다). */
function totals(lines: CostLine[]) {
  const comparable = lines.filter(line => !line.excluded && line.source_usd !== null && line.target_usd !== null)
  return {
    source: comparable.reduce((sum, line) => sum + (line.source_usd ?? 0), 0),
    target: comparable.reduce((sum, line) => sum + (line.target_usd ?? 0), 0),
    pending: lines.filter(line => !line.excluded && (line.source_usd === null || line.target_usd === null)).length,
  }
}

/**
 * 이전 전/후 고정 요금 비교. 값은 계획 미리보기의 요금 추정(plan.preview.cost [가정])에서 읽는다.
 * 추정이 없거나 한쪽 값이 없으면 숫자를 지어내지 않고 '추정 대기'로 보인다.
 */
export default function CostCompare({ target, cost }: { target: Target; cost: CostEstimate | null | undefined }) {
  const t = useT()
  const tOr = useTOr()
  if (!cost || cost.lines.length === 0) return <div className="cost-pending" role="status">
    <strong>{t('cost.pending.title')}</strong>
    <p>{t('cost.pending.lead')}</p>
  </div>

  const sum = totals(cost.lines)
  const credit = cost.credits_usd ?? 0
  const value = (amount: number | null, line: CostLine) => line.excluded ? t('cost.excluded') : amount === null ? t('cost.pendingShort') : usd(amount)
  const noteOf = (line: CostLine) => tOr('cost.note.' + target + '.' + line.id, '')
  return <div className="cost">
    <div className="cost-row cost-head">
      <span>{t('cost.item')}</span><span>AWS</span><span>{t(('target.' + target + '.short') as MsgKey)}</span>
    </div>
    {cost.lines.map(line => {
      const note = noteOf(line)
      return <div key={line.id} className={'cost-row' + (line.excluded ? ' is-excluded' : '') + (!line.excluded && line.target_usd === null ? ' is-pending' : '')}>
        <span>{line.label || tOr('cost.' + line.id, line.id)}</span>
        <span>{value(line.source_usd, line)}</span>
        <span>{value(line.target_usd, line)}{note && <small>{note}</small>}</span>
      </div>
    })}
    <div className="cost-row cost-total">
      <span>{t('cost.total')}</span>
      <span>{usd(sum.source)}{t('cost.perMonth')}</span>
      <span>{usd(sum.target)}{t('cost.perMonth')}{credit > 0 && <small>{t('cost.withCredit', { total: usd(Math.max(0, sum.target - credit)), credit: usd(credit) })}</small>}</span>
    </div>
    <p className="flow-note">{sum.pending > 0 ? t('cost.notePending', { n: sum.pending }) + ' ' : ''}{t('cost.note', { date: cost.basis ?? '—' })}</p>
  </div>
}
