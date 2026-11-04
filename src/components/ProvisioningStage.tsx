'use client'

import { useEffect, useRef, useState } from 'react'
import StageShell from './StageShell'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'
import type { Target } from '../lib/stages'
import { useT, useTOr, type MsgKey } from '../lib/i18n'
import { reportsStorage } from '../lib/migration/planModel'
import ArchitectureDiagram, { type NodeState } from './ArchitectureDiagram'
import ZoomableDiagram from './ZoomableDiagram'
import { ViewTabs } from './DiagramParts'

/** 새 줄은 빈 줄로 붙은 뒤 다음 프레임에 펼쳐진다(펼침 전환이 보이게). */
function RevealRow({ index, category, name, info }: { index: number; category: string; name: string; info: string }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  return <div className={'analysis-result' + (open ? ' is-discovered' : '')}>
    <span className="analysis-result-point" aria-hidden="true" />
    <div className="analysis-result-content">
      <small>{String(index + 1).padStart(2, '0')}{category ? ' / ' + category : ''}</small>
      <strong>{name}</strong>
      <p>{info}</p>
    </div>
  </div>
}

// 만들어지는 리소스가 구성도의 어느 요소에 해당하는지
const NODE_MAP: Record<Target, Record<string, string[]>> = {
  gcp: { network: ['group'], cluster: ['group'], db: ['db'], app: ['app'], lb: ['entry'], cert: ['dns', 'user'] },
  onprem: { agent: ['group'], cluster: ['group'], db: ['db'], app: ['app'], relay: ['entry'], cert: ['dns', 'user'] },
}

export default function ProvisioningStage({ target, onNext, onComplete }: { target: Target; onNext: () => void; onComplete?: () => void }) {
  const t = useT()
  return <StageShell kicker="PROVISIONING" title={t('prov.title')}
    subtitle={t('prov.subtitle', { target: t(('target.' + target) as MsgKey) })}>
    {ready => <ProvisioningBody ready={ready} target={target} onNext={onNext} onComplete={onComplete} />}
  </StageShell>
}

function ProvisioningBody({ ready, target, onNext, onComplete }: { ready: boolean; target: Target; onNext: () => void; onComplete?: () => void }) {
  const t = useT()
  // 만들어진 리소스는 provision.resource 이벤트로 받는다.
  const { state: migration } = useMigration()
  const events = migration.provision.resources
  // 리소스가 만들어진 뒤의 준비 상태 검사 3개와, 승인 뒤 같은 테스트 묶음 재실행(retest)
  const checks = migration.provision.checks
  // 받은 검사가 모두 끝나야 다음으로 간다(검사 이름은 서버가 정한다).
  const checksDone = checks.length > 0 && checks.every(check => check.state === 'done')
  useStageFeed('provisioning', ready, target)
  const tOr = useTOr()
  // 이벤트에 이름·설명이 있으면 그대로, 없으면 알려진 key의 문구, 그것도 없으면 key 자체
  const text = (key: string, field: 'name' | 'detail' | 'log' | 'info') => tOr('prov.' + target + '.' + key + '.' + field, field === 'name' || field === 'log' ? key : '')
  const nameOf = (event: (typeof events)[number]) => event.name || text(event.key, 'name')
  const infoOf = (event: (typeof events)[number]) => event.detail || text(event.key, 'info')
  const targetName = t(('target.' + target) as MsgKey)
  const listRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<'diagram' | 'log'>('diagram')
  const [swapped, setSwapped] = useState(false)
  const progress = events.length ? events[events.length - 1].progress : 0
  const finished = progress === 100
  useEffect(() => { if (finished) onComplete?.() }, [finished, onComplete])
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
        <div ref={listRef} tabIndex={0} className={'analysis-result-list' + (events.length > 0 ? ' has-results' : '')}>
          {events.map((event, index) => <RevealRow key={event.id} index={index} category={text(event.key, 'detail')} name={nameOf(event)} info={infoOf(event)} />)}
          {checks.map((check, index) => {
            const known = 'prov.check.' + check.name
            const info = check.state !== 'done' ? t('prov.check.running')
              : check.name === 'retest' ? t('prov.check.retest.info', { passed: check.passed ?? 0, total: check.total ?? 0 })
              : tOr(known + '.info', check.total !== undefined ? (check.passed ?? 0) + ' / ' + check.total : '')
            return <RevealRow key={'check-' + check.name} index={events.length + index} category={tOr(known + '.detail')} name={tOr(known + '.name', check.name)} info={info} />
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
        <ZoomableDiagram><ArchitectureDiagram view="after" target={target} states={nodeStates} adaptive storage={reportsStorage(migration)} /></ZoomableDiagram>
        <p className="flow-note">{t('prov.diagramNote')}</p>
      </div>}
      {view === 'log' && <div className="analysis-discovery-items" tabIndex={0} aria-live="polite">
        {events.length === 0
          ? <p>{t('prov.logEmpty')}</p>
          : [...events].reverse().map(event => <div className="analysis-discovery-item" key={event.id}>
              <small>{String(events.indexOf(event) + 1).padStart(2, '0')}</small>
              <strong>{event.name || text(event.key, 'log')}</strong>
              <em>{infoOf(event)}</em>
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
