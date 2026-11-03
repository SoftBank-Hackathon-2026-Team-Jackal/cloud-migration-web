'use client'

import { useT, type MsgKey } from '../lib/i18n'
import type { Target } from '../lib/stages'

/**
 * 이전 전/후 고정 요금 비교. 공개 가격표에서 확인한 항목만 계산한다(2026-11-03 조회).
 * - EKS 컨트롤 플레인 $0.10/시간, GKE 클러스터 관리 $0.10/시간(영구 무료 크레딧 월 $74.40은 한 청구 계정당 1개 클러스터)
 * - ALB 고정 요금 $0.0225/시간(us-east-1 기준 · 서울은 다를 수 있음, LCU 사용료 별도)
 * 노드·스토리지·데이터 전송은 사양과 사용량에 따라 달라 포함하지 않는다.
 */
const HOURS_PER_MONTH = 730
const CONTROL_PLANE = 0.1 * HOURS_PER_MONTH // $73.0
const ALB_FIXED = 0.0225 * HOURS_PER_MONTH // $16.4
const GKE_CREDIT = 74.4

const usd = (value: number) => '$' + value.toFixed(1)

export default function CostCompare({ target }: { target: Target }) {
  const t = useT()
  const afterControl = target === 'gcp' ? t('cost.gcpControl', { fee: usd(CONTROL_PLANE), credit: usd(GKE_CREDIT) }) : t('cost.onpremControl')
  const afterLb = target === 'gcp' ? t('cost.unknown') : t('cost.onpremLb')
  const afterTotal = target === 'gcp' ? '$0 ~ ' + usd(CONTROL_PLANE) : '$0'
  const rows: Array<{ label: string; before: string; after: string }> = [
    { label: t('cost.control'), before: usd(CONTROL_PLANE) + t('cost.perMonth'), after: afterControl },
    { label: t('cost.lb'), before: usd(ALB_FIXED) + t('cost.perMonth'), after: afterLb },
    { label: t('cost.nodes'), before: t('cost.excluded'), after: t('cost.excluded') },
  ]
  return <div className="cost">
    <div className="cost-row cost-head">
      <span>{t('cost.item')}</span><span>AWS</span><span>{t(('target.' + target + '.short') as MsgKey)}</span>
    </div>
    {rows.map(row => <div key={row.label} className="cost-row">
      <span>{row.label}</span><span>{row.before}</span><span>{row.after}</span>
    </div>)}
    <div className="cost-row cost-total">
      <span>{t('cost.total')}</span><span>{usd(CONTROL_PLANE + ALB_FIXED)}{t('cost.perMonth')}</span><span>{afterTotal}{t('cost.perMonth')}</span>
    </div>
    <p className="flow-note">{t('cost.note')}</p>
  </div>
}
