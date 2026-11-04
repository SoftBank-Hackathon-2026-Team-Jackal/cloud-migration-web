'use client'

import { useState } from 'react'
import { useT, type MsgKey } from '../lib/i18n'
import type { Target } from '../lib/stages'
import { reportsStorage } from '../lib/migration/planModel'
import ArchitectureDiagram, { type DiagramView } from './ArchitectureDiagram'
import CostCompare from './CostCompare'
import GovernanceMatrix from './GovernanceMatrix'
import { ViewTabs } from './DiagramParts'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'
import { checkDigests } from '../lib/migration/digest'
import { shortDigest } from '../lib/migration/events'

type Props = { target: Target; onApprove: () => void; onCancel: () => void; onRevise: () => void }

export default function ApprovalStage({ target, onApprove, onCancel, onRevise }: Props) {
  const t = useT()
  const { state, provider } = useMigration()
  // 승인 요청(approval.required)을 받는 화면. 승인·취소는 데이터 계층을 거쳐 서버로 간다.
  useStageFeed('awaiting_approval', true, target)
  const [checked, setChecked] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [view, setView] = useState<DiagramView>('after')
  const [side, setSide] = useState<'diagram' | 'governance' | 'cost'>('diagram')
  const [swapped, setSwapped] = useState(false)
  const targetName = t(('target.' + target) as MsgKey)

  const rows: Array<[string, string]> = [
    [t('approval.row.route'), t('approval.val.route', { target: targetName })],
    [t('approval.row.summary'), t('approval.val.summary')],
    [t('approval.row.sandbox'), t('approval.val.sandbox')],
    [t('approval.row.data'), t('approval.val.data')],
    [t('approval.row.traffic'), t(target === 'onprem' ? 'approval.val.trafficOnprem' : 'approval.val.trafficGcp')],
    [t('approval.row.rollback'), t('approval.val.rollback')],
    [t('approval.row.pause'), t('approval.val.pause')],
  ]
  // 서버가 제외 항목을 보내 주면 그대로, 비어 있으면 화면의 기본 문구를 쓴다.
  // 이미지 Digest 대조: 빌드한 이미지 = 검증한 이미지 = 배포할 이미지. 다르면 경고하고 승인을 막는다.
  const plan = state.plan.meta
  const digest = checkDigests({ built: state.build.result?.digest ?? plan?.built_digest, verified: plan?.verified_digest, deploy: plan?.built_digest })
  const digestValue = digest.status === 'mismatch'
    ? t('approval.digest.mismatch', { built: shortDigest(digest.built) || '—', verified: shortDigest(digest.verified) || '—', deploy: shortDigest(digest.deploy) || '—' })
    : t('approval.digest.match', { digest: shortDigest(digest.deploy ?? digest.built), revision: plan?.revision ?? 1, template: plan?.template_version ?? '—' })
  const excluded = state.approval.excluded.length > 0 ? state.approval.excluded : [t('approval.ex1'), t('approval.ex2')]

  if (cancelled) {
    return <section className="flow-stage approval-stage is-ready" aria-label={t('approval.cancelled.step')}>
      <div className="approval-panel">
        <small className="approval-step">{t('approval.cancelled.step')}</small>
        <h2 aria-level={1}>{t('approval.cancelled.title')}</h2>
        <p className="approval-lead">{t('approval.cancelled.lead')}</p>
        <div className="approval-actions">
          <button type="button" className="flow-primary" onClick={onCancel}>{t('approval.cancelled.home')} <span aria-hidden="true">→</span></button>
        </div>
      </div>
    </section>
  }

  return <section className="flow-stage approval-stage is-ready" aria-label={t('approval.aria')}>
    <div className="approval-panel approval-wide">
      <div className="approval-main">
        <small className="approval-step">{t('approval.step')} <span>DEMO</span></small>
        <h2 aria-level={1}>{t('approval.title')}</h2>
        <p className="approval-lead">{t('approval.lead')}</p>
        <dl className="approval-rows">
          {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          {digest.status !== 'unknown' && <div className={digest.status === 'mismatch' ? 'approval-digest is-warn' : 'approval-digest'} role={digest.status === 'mismatch' ? 'alert' : undefined}><dt>{t('approval.row.digest')}</dt><dd>{digestValue}</dd></div>}
        </dl>
        <div className="approval-excluded">
          <strong>{t('approval.excluded')}</strong>
          <ul>{excluded.map(item => <li key={item}>{item}</li>)}</ul>
        </div>
        <label className="approval-check">
          <input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />
          <span>{t('approval.check')}</span>
        </label>
        <div className="approval-actions">
          <button type="button" className="flow-secondary" onClick={() => { provider.cancel(); setCancelled(true) }}>{t('approval.cancel')}</button>
          <button type="button" className="flow-secondary" onClick={() => { provider.revisePlan(); onRevise() }}>{t('approval.revise')}</button>
          <button type="button" className="flow-primary" disabled={!checked || digest.status === 'mismatch'} onClick={() => { provider.approve(plan?.revision); onApprove() }}>{t('approval.go')} <span aria-hidden="true">→</span></button>
        </div>
      </div>
      <aside className="approval-diagram" aria-label={t('approval.diagram.title')}>
        <div className="approval-diagram-head">
          <ViewTabs label={t('tab.aria')} value={side} onChange={next => { setSwapped(true); setSide(next) }}
            items={[{ id: 'diagram', label: t('tab.diagram') }, { id: 'governance', label: t('tab.governance') }, { id: 'cost', label: t('tab.cost') }]} />
          {side === 'diagram' && <div className="migration-segment" role="radiogroup" aria-label={t('approval.diagram.title')}>
            {(['before', 'after'] as const).map(item => <button key={item} type="button" role="radio" aria-checked={view === item}
              className={view === item ? 'is-selected' : ''} onClick={() => setView(item)}>
              {t(item === 'before' ? 'approval.diagram.before' : 'approval.diagram.after')}
            </button>)}
          </div>}
        </div>
        <div className={'approval-diagram-body' + (swapped ? ' is-swapped' : '')}>
          {side === 'diagram' && <>
            <ArchitectureDiagram view={view} target={target} storage={reportsStorage(state)} />
            <small className="approval-diagram-note">{view === 'before' ? 'AWS · ' + t('plan.fromValue') : targetName}</small>
          </>}
          {side === 'governance' && <GovernanceMatrix target={target} />}
          {side === 'cost' && <CostCompare target={target} />}
        </div>
      </aside>
    </div>
  </section>
}
