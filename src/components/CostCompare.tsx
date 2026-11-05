'use client'

import { useT, useTOr, type MsgKey } from '../lib/i18n'
import type { Target } from '../lib/stages'
import type { CostLine } from '../lib/migration/events'
import type { CostItem, CostView, CostViewLine } from '../lib/migration/pricing'

const usd = (value: number) => '$' + value.toFixed(1)

function totals(lines: CostLine[]) {
  const counted = lines.filter(line => !line.excluded)
  return {
    source: counted.reduce((sum, line) => sum + (line.source_usd ?? 0), 0),
    target: counted.reduce((sum, line) => sum + (line.target_usd ?? 0), 0),
  }
}

/**
 * 이전 전/후 월 요금 추정. 값은 계획에서 계산한다(planModel.costViewOf → pricing.ts의 공개 요금표 [가정]).
 * 숫자는 모두 추정이고, 근거(요금표)와 기준일을 함께 보인다. 대상이 온프레미스면 숫자 대신 '추가 클라우드 비용 없음'이다.
 */
export default function CostCompare({ target, cost }: { target: Target; cost: CostView | null }) {
  const t = useT()
  const tOr = useTOr()
  if (!cost || cost.lines.length === 0) return <div className="cost-pending" role="status">
    <strong>{t('cost.pending.title')}</strong>
    <p>{t('cost.pending.lead')}</p>
  </div>

  const sum = totals(cost.lines)
  const credit = cost.credits_usd ?? 0
  const value = (amount: number | null, line: CostLine, side: 'source' | 'target') => line.excluded ? t('cost.excluded')
    : amount === null ? (side === 'target' && cost.noCloudTarget ? t('cost.onprem.cell') : '—') : usd(amount)
  // 계산 근거: 'SKU × 수량 · $단가/단위'(가격표에서). 대상 가격표가 없는 줄(온프레미스)은 사전의 설명을 쓴다.
  const itemText = (item: CostItem) => item.sku + (item.qty !== 1 ? ' × ' + item.qty : '') + ' · $' + item.usd + t(item.unit === 'hour' ? 'cost.unit.hour' : 'cost.unit.gbMonth')
  const basisOf = (line: CostViewLine, side: 'source' | 'target') => (line.items?.[side] ?? []).map(itemText).join(' + ')
  const noteOf = (line: CostViewLine) => basisOf(line, 'target') || tOr('cost.note.' + target + '.' + line.id, '')
  return <div className="cost">
    <p className="cost-estimate"><small className="flow-pill cost-tag">{t('cost.estimateTag')}</small>{t('cost.estimateLead')}</p>
    <div className="cost-row cost-head">
      <span>{t('cost.item')}</span><span>AWS</span><span>{t(('target.' + target + '.short') as MsgKey)}</span>
    </div>
    {cost.lines.map((line: CostViewLine) => {
      const note = noteOf(line)
      return <div key={line.id} className={'cost-row' + (line.excluded ? ' is-excluded' : '')}>
        <span>{line.label || tOr('cost.' + line.id, line.id)}</span>
        <span>{value(line.source_usd, line, 'source')}{!line.excluded && basisOf(line, 'source') && <small>{basisOf(line, 'source')}</small>}</span>
        <span>{value(line.target_usd, line, 'target')}{note && !line.excluded && <small>{note}</small>}</span>
      </div>
    })}
    <div className="cost-row cost-total">
      <span>{t('cost.total')}</span>
      <span>{cost.lines.some(line => !line.excluded && line.source_usd !== null) ? usd(sum.source) + t('cost.perMonth') : '—'}</span>
      {cost.noCloudTarget
        ? <span>{t('cost.onprem.total')}<small>{t('cost.onprem.scope')}</small></span>
        : <span>{usd(sum.target)}{t('cost.perMonth')}{credit > 0 && <small>{t('cost.withCredit', { total: usd(Math.max(0, sum.target - credit)), credit: usd(credit) })}</small>}</span>}
    </div>
    <dl className="cost-basis">
      {cost.bases.map(basis => <div key={basis.provider + basis.region + basis.date}>
        <dt>{[basis.provider, tOr('region.' + basis.region, basis.region)].filter(Boolean).join(' · ') || t('cost.basisLabel')}</dt>
        <dd>{basis.basis && <span>{basis.basis}</span>}<span>{t('cost.basisDate', { date: basis.date })}</span></dd>
      </div>)}
    </dl>
    <p className="flow-note">{t('cost.note', { date: cost.basis ?? '—' })}</p>
  </div>
}
