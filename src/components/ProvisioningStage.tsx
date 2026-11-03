'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import StageShell from './StageShell'
import { useScript, type TimedItem } from '../lib/useScript'
import type { Target } from '../lib/stages'
import { useT, type MsgKey } from '../lib/i18n'
import ArchitectureDiagram, { type NodeState } from './ArchitectureDiagram'
import ZoomableDiagram from './ZoomableDiagram'
import { ViewTabs } from './DiagramParts'

const NODES: Record<Target, string[]> = {
  gcp: ['network', 'cluster', 'db', 'app', 'lb', 'cert'],
  onprem: ['agent', 'cluster', 'db', 'app', 'relay', 'cert'],
}

// 만들어지는 리소스가 구성도의 어느 요소에 해당하는지
const NODE_MAP: Record<Target, Record<string, string[]>> = {
  gcp: { network: ['group'], cluster: ['group'], db: ['db'], app: ['app'], lb: ['entry'], cert: ['dns', 'user'] },
  onprem: { agent: ['group'], cluster: ['group'], db: ['db'], app: ['app'], relay: ['entry'], cert: ['dns', 'user'] },
}

type LogEvent = { id: string; key: string; progress: number }

function buildScript(target: Target): Array<TimedItem<LogEvent>> {
  return NODES[target].map((key, index) => ({
    after: 600 + index * 1250,
    item: { id: target + '-' + key, key, progress: Math.round(((index + 1) / NODES[target].length) * 100) },
  }))
}

export default function ProvisioningStage({ target, onNext }: { target: Target; onNext: () => void }) {
  const t = useT()
  const script = useMemo(() => buildScript(target), [target])
  return <StageShell kicker="PROVISIONING" title={t('prov.title')}
    subtitle={t('prov.subtitle', { target: t(('target.' + target) as MsgKey) })}>
    {ready => <ProvisioningBody ready={ready} target={target} script={script} onNext={onNext} />}
  </StageShell>
}

function ProvisioningBody({ ready, target, script, onNext }: { ready: boolean; target: Target; script: Array<TimedItem<LogEvent>>; onNext: () => void }) {
  const t = useT()
  const events = useScript(script, ready)
  const nodes = NODES[target]
  const text = (key: string, field: 'name' | 'detail' | 'log' | 'info') => t(('prov.' + target + '.' + key + '.' + field) as MsgKey)
  const targetName = t(('target.' + target) as MsgKey)
  const listRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<'diagram' | 'log'>('diagram')
  const [swapped, setSwapped] = useState(false)
  const discovered = new Set(events.map(event => event.key))
  const findings = new Map(events.map(event => [event.key, text(event.key, 'info')]))
  const progress = events.length ? events[events.length - 1].progress : 0
  const finished = progress === 100
  const nodeStates: Record<string, NodeState> = {}
  events.forEach((event, index) => {
    const latest = index === events.length - 1 && !finished
    for (const node of NODE_MAP[target][event.key] ?? []) nodeStates[node] = latest ? 'on' : 'done'
  })

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [events.length])

  return <div className="flow-split">
    <section className="analysis-cluster analysis-infrastructure flow-cluster" aria-label={t('prov.clusterTitle', { target: targetName })}>
      <div className="analysis-cluster-heading">
        <span className="analysis-cluster-icon" aria-hidden="true">◫</span>
        <div>
          <h2>{t('prov.clusterTitle', { target: targetName })}</h2>
          <p>{t('prov.clusterSub')}</p>
        </div>
        <strong>{progress}%</strong>
      </div>
      <div className="analysis-progress" role="progressbar" aria-label={t('prov.progressAria')} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: progress + '%' }} />
      </div>
      <div className="analysis-stream">
        <div ref={listRef} className={'analysis-result-list' + (events.length > 0 ? ' has-results' : '')}>
          {nodes.map((key, index) => <div key={key} className={'analysis-result' + (discovered.has(key) ? ' is-discovered' : '')} aria-hidden={!discovered.has(key)}>
            <span className="analysis-result-point" aria-hidden="true" />
            <div className="analysis-result-content">
              <small>{String(index + 1).padStart(2, '0')} / {text(key, 'detail')}</small>
              <strong>{text(key, 'name')}</strong>
              <p>{findings.get(key)}</p>
            </div>
          </div>)}
        </div>
        {!finished
          ? <div className="analysis-scanning" aria-hidden="true"><span />{t('prov.nextResource')}</div>
          : <div className="analysis-complete" aria-hidden="true"><span>✓</span>{t('prov.ready')}</div>}
      </div>
    </section>

    <aside className={'analysis-discovery flow-cluster' + (swapped ? ' is-swapped' : '')} aria-label={t('prov.logAria')}>
      <div className="analysis-discovery-title">
        <span className="analysis-live-dot" />
        <ViewTabs label={t('tab.aria')} value={view} onChange={next => { setSwapped(true); setView(next) }}
          items={[{ id: 'diagram', label: t('tab.diagram') }, { id: 'log', label: t('tab.log') }]} />
        <small>DEMO</small>
      </div>
      {view === 'diagram' && <div className="prov-diagram">
        <ZoomableDiagram><ArchitectureDiagram view="after" target={target} states={nodeStates} adaptive /></ZoomableDiagram>
        <p className="flow-note">{t('prov.diagramNote')}</p>
      </div>}
      {view === 'log' && <div className="analysis-discovery-items" aria-live="polite">
        {events.length === 0
          ? <p>{t('prov.logEmpty')}</p>
          : [...events].reverse().map(event => <div className="analysis-discovery-item" key={event.id}>
              <small>{String(events.indexOf(event) + 1).padStart(2, '0')}</small>
              <strong>{text(event.key, 'log')}</strong>
              <em>{text(event.key, 'info')}</em>
            </div>)}
      </div>}
      {finished && <div className="flow-handoff">
        <strong>{t('prov.handoffTitle')}</strong>
        <p>{t(target === 'onprem' ? 'prov.handoffOnprem' : 'prov.handoffGcp')}</p>
      </div>}
    </aside>

    <div className="flow-footer flow-footer-wide">
      <span>{finished ? t('prov.footDone') : t('prov.footRun')}</span>
      <button type="button" className="flow-primary" disabled={!finished} onClick={onNext}>{t('prov.go')} <span aria-hidden="true">→</span></button>
    </div>
  </div>
}
