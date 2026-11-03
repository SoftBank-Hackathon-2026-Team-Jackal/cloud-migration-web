'use client'

import { useState } from 'react'
import { useT, type MsgKey } from '../lib/i18n'
import type { Target } from '../lib/stages'
import ArchitectureDiagram, { type DiagramView } from './ArchitectureDiagram'
import CostCompare from './CostCompare'
import GovernanceMatrix from './GovernanceMatrix'
import { ViewTabs } from './DiagramParts'

type Props = { target: Target; onApprove: () => void; onCancel: () => void }

export default function ApprovalStage({ target, onApprove, onCancel }: Props) {
  const t = useT()
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
  const excluded = [t('approval.ex1'), t('approval.ex2')]

  if (cancelled) {
    return <section className="flow-stage approval-stage is-ready" aria-label={t('approval.cancelled.step')}>
      <div className="approval-panel">
        <small className="approval-step">{t('approval.cancelled.step')}</small>
        <h2>{t('approval.cancelled.title')}</h2>
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
        <h2>{t('approval.title')}</h2>
        <p className="approval-lead">{t('approval.lead')}</p>
        <dl className="approval-rows">
          {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
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
          <button type="button" className="flow-secondary" onClick={() => setCancelled(true)}>{t('approval.cancel')}</button>
          <button type="button" className="flow-primary" disabled={!checked} onClick={onApprove}>{t('approval.go')} <span aria-hidden="true">→</span></button>
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
            <ArchitectureDiagram view={view} target={target} />
            <small className="approval-diagram-note">{view === 'before' ? 'AWS · ' + t('plan.fromValue') : targetName}</small>
          </>}
          {side === 'governance' && <GovernanceMatrix target={target} />}
          {side === 'cost' && <CostCompare target={target} />}
        </div>
      </aside>
    </div>
  </section>
}
