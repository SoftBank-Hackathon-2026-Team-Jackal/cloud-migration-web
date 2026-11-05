'use client'

import { useEffect, useState } from 'react'
import StageShell from './StageShell'
import ProposalTag from './ProposalTag'
import CutoverDiagram from './CutoverDiagram'
import LiveRequests from './LiveRequests'
import PhaseStrip, { STRIP_GATE } from './PhaseStrip'
import MigrationReport from './MigrationReport'
import { ArriveMorph } from './ScreenFx'
import { runTransition } from '../lib/particleHandoff'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'
import type { Target } from '../lib/stages'
import { useT, useTOr, type MsgKey } from '../lib/i18n'

type Phase = 'approve' | 'running' | 'verify' | 'done'

const STEPS = [1, 2, 3, 4, 5, 6]
// 측정 결과(실패·지연·유실)는 3개가 모두 와야 측정이 끝난 것이다.

export default function CutoverStage({ target, onRestart, onComplete }: { target: Target; onRestart: () => void; onComplete: () => void }) {
  const t = useT()
  const [phase, setPhase] = useState<Phase>('approve')
  return <StageShell kicker="DB CUTOVER · VERIFY" title={t('cutover.title')} subtitle={t(('cutover.sub.' + phase) as MsgKey)} hideHeader={phase === 'approve' || phase === 'done'}>
    {ready => <CutoverBody ready={ready} target={target} phase={phase} setPhase={setPhase} onRestart={onRestart} onComplete={onComplete} />}
  </StageShell>
}

type BodyProps = { ready: boolean; target: Target; phase: Phase; setPhase: (phase: Phase) => void; onRestart: () => void; onComplete: () => void }

function CutoverBody({ ready, target, phase, setPhase, onRestart, onComplete }: BodyProps) {
  const t = useT()
  const tOr = useTOr()
  const { state, provider, mode } = useMigration()
  // 두 번째 승인(approveCutover) 뒤에 오는 전환 단계·측정 결과 이벤트를 읽는다.
  useStageFeed('verification', ready, target)
  const targetName = t(('target.' + target) as MsgKey)
  const [checked, setChecked] = useState(false)
  const doneSteps = phase === 'approve' ? 0 : state.cutover.doneSteps
  const tiles = state.cutover.results
  // 측정이 끝났다: 서버가 마지막 결과를 보내 이전 상태가 done이 됐다(결과 id·개수는 서버가 정한다).
  const measured = phase === 'verify' && tiles.length > 0 && state.status === 'done'

  // 6단계가 끝나고 측정 구간에 들어갔다는 이벤트가 오면 화면도 측정 단계로 넘어간다.
  useEffect(() => {
    if (phase === 'running' && state.cutover.verifying) setPhase('verify')
  }, [phase, state.cutover.verifying, setPhase])

  if (phase === 'approve') {
    return <><div className="flow-center">
      <div className="approval-panel approval-wide cutover-approval">
        <div className="approval-main">
        <small className="approval-step">{t('cutover.approve.step')} <span>DEMO</span></small>
        <h2>{t('cutover.approve.title')}</h2>
        <p className="approval-lead">{t('cutover.approve.lead', { target: targetName })}</p>
        <dl className="approval-rows">
          <div><dt>{t('cutover.approve.pause')}</dt><dd>{t('cutover.approve.pauseVal')}</dd></div>
          <div><dt>{t('cutover.approve.after')}</dt><dd>{t('cutover.approve.afterVal')} <ProposalTag /></dd></div>
          <div><dt>{t('cutover.approve.old')}</dt><dd>{t('cutover.approve.oldVal')}</dd></div>
        </dl>
        <label className="approval-check">
          <input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />
          <span>{t('cutover.approve.check')}</span>
        </label>
        <div className="approval-actions">
          <button type="button" className="flow-primary" disabled={!checked} onClick={() => runTransition(() => { provider.approveCutover(); setPhase('running') })}>{t('cutover.approve.go')} <span aria-hidden="true">→</span></button>
        </div>
        </div>
        {/* 첫 번째 승인과 같은 구성: 왼쪽 결정, 오른쪽 구성도. 전환 전(0단계) 모습을 보여 준다. */}
        <aside className="approval-diagram" aria-label={t('cut.aria')}>
          <div className="approval-diagram-head"><strong>{t('cut.aria')}</strong></div>
          <div className="approval-diagram-body">
            <CutoverDiagram steps={0} />
            <small className="approval-diagram-note">AWS → {targetName}</small>
          </div>
        </aside>
      </div>
    </div><ArriveMorph key="cut-approve" /></>
  }

  if (phase === 'done') return <><MigrationReport target={target} onRestart={onRestart} /><ArriveMorph key="cut-done" /></>

  return <><div className="flow-split flow-split-wide">
    <section className="flow-list" aria-label={t('cutover.stepsAria')}>
      {STEPS.map((step, index) => {
        const state = phase === 'verify' || index < doneSteps ? 'done' : index === doneSteps ? 'running' : ''
        return <article key={step} className={'flow-check' + (state ? ' is-' + state : '')}>
          <span className="flow-check-mark" aria-hidden="true">{state === 'done' ? '✓' : state === 'running' ? '' : String(index + 1).padStart(2, '0')}</span>
          <div><strong>{t(('cutover.step.' + step + '.title') as MsgKey)}{step === 6 && <> <ProposalTag /></>}</strong><p>{t(('cutover.step.' + step + '.detail') as MsgKey)}</p></div>
          <small>{state === 'done' ? t('cutover.state.done') : state === 'running' ? t('cutover.state.running') : t('cutover.state.wait')}</small>
        </article>
      })}
      {(mode === 'mock' || state.cutover.handover.length > 0) && (() => {
        // 최종 검증 뒤 운영권 인계: DNS 전환 → 원본 대기 → 권한 이전 (cutover.handover 이벤트, 프론트 [가정])
        const items = state.cutover.handover
        const finished = items.length === 3 && items.every(item => item.state === 'done')
        const handoverState = phase !== 'verify' ? '' : finished ? 'done' : items.length > 0 ? 'running' : ''
        const detail = items.length === 0 ? t('cutover.handover.wait') : (['dns', 'origin', 'access'] as const).map(name => {
          const item = items.find(entry => entry.item === name)
          return t(('cutover.handover.' + name) as MsgKey) + (item?.state === 'done' ? ' ✓' : '')
        }).join(' · ')
        return <article className={'flow-check' + (handoverState ? ' is-' + handoverState : '')}>
          <span className="flow-check-mark" aria-hidden="true">{handoverState === 'done' ? '✓' : handoverState === 'running' ? '' : '07'}</span>
          <div><strong>{t('cutover.handover.title')} <ProposalTag /></strong><p>{detail}</p></div>
          <small>{handoverState === 'done' ? t('cutover.state.done') : handoverState === 'running' ? t('cutover.state.running') : t('cutover.state.wait')}</small>
        </article>
      })()}
    </section>
    <aside className="flow-panel" aria-label={t('cutover.panelAria')}>
      <CutoverDiagram steps={phase === 'verify' ? 6 : doneSteps} />
      <LiveRequests weightNew={100} queued={phase === 'running' && doneSteps >= 1 && doneSteps < 5} />
      <div className="flow-panel-head"><strong>{t('cutover.panel')}</strong><small className="flow-pill">DEMO</small></div>
      <div className="cutover-pause">
        <span>{t('cutover.pause')}</span>
        <b>{doneSteps >= 5 ? t('cutover.pauseValue') : doneSteps >= 1 ? t('cutover.pauseRunning') : '—'}</b>
      </div>
      {phase === 'verify'
        ? <div className="cutover-tiles">
            {tiles.map(tile => {
              // 알려진 id(fail·delay·loss)는 화면 문구, 그 밖의 id(duplicate, checksum 등)는 받은 label·value를 그대로
              const key = 'cutover.tile.' + tile.id
              const rule = tOr(key + 'Rule')
              return <div key={tile.id} className={'cutover-tile' + (tile.ok === false ? ' is-bad' : '')}>
                <small>{tile.label || tOr(key, tile.id)}</small>
                <strong>{tile.value || tOr(key + 'Value', '—')}</strong>
                {(rule || tile.ok !== undefined) && <em>{tile.ok === false ? '✕' : '✓'} {rule}</em>}
              </div>
            })}
          </div>
        : <p className="flow-note">{t('cutover.measureNote')}</p>}
    </aside>

    {/* 데이터 → 트래픽 → DB 전환 띠: 지금은 게이트 2 뒤(PgBouncer 전환 단계만큼) */}
    <div className="flow-strip"><PhaseStrip compact position={STRIP_GATE.switchover + (Math.min(6, doneSteps) / 6) * (100 - STRIP_GATE.switchover)} gates={['pass', 'pass', 'pass']} /></div>

    <div className="flow-footer">
      <span>{measured ? t('cutover.foot.done') : phase === 'verify' ? t('cutover.foot.verify') : t('cutover.foot.running')}</span>
      <button type="button" className="flow-primary" disabled={!measured} onClick={() => runTransition(() => { setPhase('done'); onComplete() })}>{t('cutover.next')} <span aria-hidden="true">→</span></button>
    </div>
  </div><ArriveMorph key="cut-run" /></>
}
