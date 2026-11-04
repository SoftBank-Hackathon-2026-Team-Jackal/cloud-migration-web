'use client'

import { useEffect, useRef, useState } from 'react'
import StageShell from './StageShell'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'
import { PROVISION_NODES as NODES } from '../lib/migration/script'
import type { Target } from '../lib/stages'
import { useT, type MsgKey } from '../lib/i18n'
import ArchitectureDiagram, { type NodeState } from './ArchitectureDiagram'
import ZoomableDiagram from './ZoomableDiagram'
import { ViewTabs } from './DiagramParts'

const CHECK_NAMES = ['pods_ready', 'db_connect', 'app_health', 'retest'] as const

// 만들어지는 리소스가 구성도의 어느 요소에 해당하는지
const NODE_MAP: Record<Target, Record<string, string[]>> = {
  gcp: { network: ['group'], cluster: ['group'], db: ['db'], app: ['app'], lb: ['entry'], cert: ['dns', 'user'] },
  onprem: { agent: ['group'], cluster: ['group'], db: ['db'], app: ['app'], relay: ['entry'], cert: ['dns', 'user'] },
}

export default function ProvisioningStage({ target, onNext }: { target: Target; onNext: () => void }) {
  const t = useT()
  return <StageShell kicker="PROVISIONING" title={t('prov.title')}
    subtitle={t('prov.subtitle', { target: t(('target.' + target) as MsgKey) })}>
    {ready => <ProvisioningBody ready={ready} target={target} onNext={onNext} />}
  </StageShell>
}

function ProvisioningBody({ ready, target, onNext }: { ready: boolean; target: Target; onNext: () => void }) {
  const t = useT()
  // 만들어진 리소스는 provision.resource 이벤트로 받는다.
  const { state: migration } = useMigration()
  const events = migration.provision.resources
  // 리소스가 만들어진 뒤의 준비 상태 검사 3개와, 승인 뒤 같은 테스트 묶음 재실행(retest)
  const checks = migration.provision.checks
  const checkOf = (name: string) => checks.find(item => item.name === name)
  const checksDone = CHECK_NAMES.every(name => checkOf(name)?.state === 'done')
  useStageFeed('provisioning', ready, target)
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
  }, [events.length, checks.length])

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
          {CHECK_NAMES.map((name, index) => {
            const check = checkOf(name)
            return <div key={name} className={'analysis-result' + (check ? ' is-discovered' : '')} aria-hidden={!check}>
              <span className="analysis-result-point" aria-hidden="true" />
              <div className="analysis-result-content">
                <small>{String(nodes.length + index + 1).padStart(2, '0')} / {t(('prov.check.' + name + '.detail') as MsgKey)}</small>
                <strong>{t(('prov.check.' + name + '.name') as MsgKey)}</strong>
                <p>{check?.state === 'done'
                  ? (name === 'retest' ? t('prov.check.retest.info', { passed: check.passed ?? 0, total: check.total ?? 0 }) : t(('prov.check.' + name + '.info') as MsgKey))
                  : t('prov.check.running')}</p>
              </div>
            </div>
          })}
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
      <span>{finished && checksDone ? t('prov.footDone') : t('prov.footRun')}</span>
      <button type="button" className="flow-primary" disabled={!finished || !checksDone} onClick={onNext}>{t('prov.go')} <span aria-hidden="true">→</span></button>
    </div>
  </div>
}
