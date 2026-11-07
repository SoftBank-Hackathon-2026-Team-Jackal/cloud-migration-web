'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import StageShell from './StageShell'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'
import { useVoiceActions } from '../lib/voice/actions'
import type { Target } from '../lib/stages'
import { useT, useTOr, type MsgKey } from '../lib/i18n'
import { KIND_ORDER, REGION, addressOf, kindOf, readyKinds, specOf } from '../lib/migration/provisionModel'
import ProvisioningScene, { KindSwatch, type SceneResource } from './ProvisioningScene'
import { CHECK_GAP_MS, nextRevealDelay, stagedProgress, stagedResources } from '../lib/migration/provisionPacing'

export default function ProvisioningStage({ target, onNext, onComplete }: { target: Target; onNext: () => void; onComplete?: () => void }) {
  const t = useT()
  return <StageShell kicker="PROVISIONING" title={t('prov.title')}
    subtitle={t('prov.subtitle', { target: t(('target.' + target) as MsgKey) })}>
    {ready => <ProvisioningBody ready={ready} target={target} onNext={onNext} onComplete={onComplete} />}
  </StageShell>
}

type Line = { mark: string; text: string; note?: string; gold?: boolean }

function ProvisioningBody({ ready, target, onNext, onComplete }: { ready: boolean; target: Target; onNext: () => void; onComplete?: () => void }) {
  const t = useT()
  const tOr = useTOr()
  // 만들어진 리소스는 provision.resource 이벤트로, 준비 상태 검사는 provision.check로 받는다(이름은 서버가 정한다).
  const { state: migration, mode } = useMigration()
  // 실제 모드는 서버가 리소스를 한꺼번에 보내므로(온프렘 Agent는 결과가 하나) 화면이 순서를 매겨 하나씩 그린다(provisionPacing).
  const paced = mode === 'sse'
  const allEvents = migration.provision.resources
  const allChecks = migration.provision.checks
  useStageFeed('provisioning', ready, target)

  // 장면에서 면(생성됨)까지 조립이 끝난 블록. 명령줄·상태표가 이것을 따라 created로 바뀐다.
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set())
  const onSettled = useCallback((id: string) => setSettled(prev => prev.has(id) ? prev : new Set(prev).add(id)), [])

  // 등장 순서: 화면이 뜬 뒤(ready) 받은 순서대로 하나씩
  const [revealed, setRevealed] = useState(0)
  useEffect(() => {
    if (!paced || !ready) return
    const delay = nextRevealDelay(revealed, allEvents.length)
    if (delay === null) return
    const timer = window.setTimeout(() => setRevealed(count => count + 1), delay)
    return () => window.clearTimeout(timer)
  }, [paced, ready, revealed, allEvents.length])
  const events = paced ? stagedResources(allEvents, revealed, settled) : allEvents
  const blocksSettled = allEvents.length > 0 && allEvents.every(event => event.state === 'failed' || settled.has(event.id))

  // 검사: 모든 블록이 완성된 뒤 하나씩
  const [checksShown, setChecksShown] = useState(0)
  useEffect(() => {
    if (!paced || !blocksSettled || checksShown >= allChecks.length) return
    const timer = window.setTimeout(() => setChecksShown(count => count + 1), CHECK_GAP_MS)
    return () => window.clearTimeout(timer)
  }, [paced, blocksSettled, checksShown, allChecks.length])
  const checks = paced ? allChecks.slice(0, checksShown) : allChecks
  const checksDone = checks.length > 0 && checks.length === allChecks.length && checks.every(check => check.state === 'done')
  // 이벤트에 이름·설명이 있으면 그대로, 없으면 알려진 key의 문구, 그것도 없으면 key 자체
  const text = (key: string, field: 'name' | 'detail' | 'log' | 'info') => tOr('prov.' + target + '.' + key + '.' + field, field === 'name' || field === 'log' ? key : '')
  const targetName = t(('target.' + target) as MsgKey)
  const region = REGION[target]
  // 실제 모드의 진행률은 화면에서 완성된 블록 수로 센다(서버 값은 한꺼번에 100이 된다).
  const progress = paced ? stagedProgress(allEvents, settled) : events.length ? events[events.length - 1].progress : 0
  const finished = progress === 100
  useEffect(() => { if (finished) onComplete?.() }, [finished, onComplete])

  const goldKinds = readyKinds(checks)
  const allReady = finished && checksDone
  useVoiceActions({ next: allReady && onNext })
  const resources: SceneResource[] = events.map((event, index) => {
    const kind = kindOf({ key: event.key, name: event.name })
    return {
      id: event.id, num: index + 1, kind, state: event.state,
      title: event.name || text(event.key, 'name'),
      spec: event.detail || specOf(target, event.key) || text(event.key, 'detail'),
      ready: event.state === 'done' && settled.has(event.id) && (allReady || goldKinds === 'all' || goldKinds.has(kind)),
    }
  })
  const presentKinds = KIND_ORDER.filter(kind => resources.some(r => r.kind === kind))
  const builtAll = finished && resources.every(r => settled.has(r.id))

  // 명령줄: 받은 이벤트를 테라폼 적용 기록처럼 보인다(마지막 세 줄)
  const plan = migration.plan.meta
  const lines: Line[] = [{ mark: '$', text: `agent apply ${plan?.plan_id ?? 'plan'}${plan ? ' · rev ' + plan.revision : ''} --target ${region.command}` }]
  for (const event of events) {
    const address = addressOf(target, event.key)
    lines.push({ mark: '+', text: address, note: 'creating…' })
    if (event.state === 'failed') lines.push({ mark: '✗', text: address, note: 'failed' })
    else if (settled.has(event.id)) lines.push({ mark: '✓', text: address, note: 'created · ' + (event.detail || specOf(target, event.key) || text(event.key, 'detail')) })
  }
  if (builtAll) for (const check of checks) {
    lines.push({ mark: '›', text: 'check ' + check.name, note: 'running…' })
    if (check.state === 'done') lines.push({ mark: '✓', gold: true, text: 'check ' + check.name, note: 'passed' + (check.total !== undefined ? ' · ' + (check.passed ?? 0) + ' / ' + check.total : '') })
    if (check.state === 'failed') lines.push({ mark: '✗', text: 'check ' + check.name, note: 'failed' })
  }
  if (allReady && builtAll) lines.push({ mark: '●', gold: true, text: 'environment ready', note: t(target === 'onprem' ? 'prov.handoffOnprem' : 'prov.handoffGcp') })
  const shown = lines.slice(-3)

  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [events.length, checks.length, builtAll])

  const pill = (resource: SceneResource) => resource.state === 'failed' ? 'failed' : resource.ready ? 'ready' : settled.has(resource.id) ? 'created' : 'creating'

  return <div className="flow-split prov-split">
    <section className="analysis-cluster analysis-infrastructure flow-cluster prov-build" aria-label={t('prov.clusterTitle', { target: targetName })}>
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
      <div className="prov-term" role="log" aria-label={t('prov.terminalAria')} aria-live="off">
        {shown.map((line, index) => <div key={lines.length - shown.length + index} className={index === shown.length - 1 ? 'is-current' : ''}>
          <span className={'prov-term-mark' + (line.gold ? ' is-gold' : '')}>{line.mark}</span> {line.text}{line.note && <span className="prov-term-note"> {line.note}</span>}
          {index === shown.length - 1 && !(allReady && builtAll) && <span className="prov-term-caret" aria-hidden="true" />}
        </div>)}
      </div>
      <div className="prov-scene-wrap">
        <ProvisioningScene resources={resources} floorLabel={region.floor} subnets={region.subnets} userLabel={t('prov.user')}
          ariaLabel={t('prov.sceneAria', { target: targetName, count: resources.length })}
          traffic={allReady && builtAll ? 'ready' : builtAll ? 'on' : 'off'} onSettled={onSettled} />
        <div className="prov-legend">
          {presentKinds.map(kind => <span key={kind}><KindSwatch kind={kind} />{t(('prov.kind.' + kind) as MsgKey)}</span>)}
          <span className="prov-legend-phase">{t('prov.legendPhase')}</span>
        </div>
      </div>
    </section>

    <aside className="analysis-discovery flow-cluster prov-status" aria-label={t('prov.statusTitle')}>
      <div className="analysis-discovery-title">
        <span className="analysis-live-dot" />
        <h2>{t('prov.statusTitle')}</h2>
        {mode === 'mock' && <small>DEMO</small>}
      </div>
      <div ref={listRef} className="prov-status-list" tabIndex={0}>
        {resources.length === 0 && <p className="prov-empty">{t('prov.logEmpty')}</p>}
        {resources.map(resource => {
          const state = pill(resource)
          return <div key={resource.id} className={'prov-svc is-' + state}>
            <span className="prov-svc-num" aria-hidden="true">{resource.num}</span>
            <KindSwatch kind={resource.kind} />
            <div className="prov-svc-body">
              <strong>{resource.title}</strong>
              <code>{addressOf(target, events[resource.num - 1].key)}</code>
            </div>
            <span className={'prov-pill is-' + state}>{state}</span>
          </div>
        })}
        {checks.length > 0 && <div className="prov-checks">
          <h3>{t('prov.checksTitle')}</h3>
          {checks.map(check => {
            const known = 'prov.check.' + check.name
            const info = check.state !== 'done' ? t('prov.check.running')
              : check.total !== undefined ? (check.passed ?? 0) + ' / ' + check.total
              : tOr(known + '.detail', '')
            return <div key={check.name} className={'prov-check is-' + check.state}>
              <span aria-hidden="true">{check.state === 'done' ? '✓' : check.state === 'failed' ? '✗' : '◌'}</span>
              <strong>{tOr(known + '.name', check.name)}</strong>
              <em>{info}</em>
            </div>
          })}
        </div>}
        {finished && <div className="flow-handoff">
          <strong>{t('prov.handoffTitle')}</strong>
          <p>{t(target === 'onprem' ? 'prov.handoffOnprem' : 'prov.handoffGcp')}</p>
        </div>}
      </div>
    </aside>

    <div className="flow-footer flow-footer-wide">
      <span>{finished && checksDone ? t('prov.footDone') : t('prov.footRun')}</span>
      <button type="button" className="flow-primary" disabled={!finished || !checksDone} onClick={onNext}>{t('prov.go')} <span aria-hidden="true">→</span></button>
    </div>
  </div>
}
