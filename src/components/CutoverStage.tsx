'use client'

import { useEffect, useState } from 'react'
import StageShell from './StageShell'
import ProposalTag from './ProposalTag'
import CutoverDiagram from './CutoverDiagram'
import LiveRequests from './LiveRequests'
import MigrationReport from './MigrationReport'
import { ArriveMorph } from './ScreenFx'
import { runTransition } from '../lib/particleHandoff'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'
import type { Target } from '../lib/stages'
import { useT, type MsgKey } from '../lib/i18n'

type Phase = 'approve' | 'running' | 'verify' | 'done'

const STEPS = [1, 2, 3, 4, 5, 6]
// 측정 결과(실패·지연·유실)는 3개가 모두 와야 측정이 끝난 것이다.
const RESULT_COUNT = 3

export default function CutoverStage({ target, onRestart }: { target: Target; onRestart: () => void }) {
  const t = useT()
  const [phase, setPhase] = useState<Phase>('approve')
  return <StageShell kicker="DB CUTOVER · VERIFY" title={t('cutover.title')} subtitle={t(('cutover.sub.' + phase) as MsgKey)} hideHeader={phase === 'approve' || phase === 'done'}>
    {ready => <CutoverBody ready={ready} target={target} phase={phase} setPhase={setPhase} onRestart={onRestart} />}
  </StageShell>
}

type BodyProps = { ready: boolean; target: Target; phase: Phase; setPhase: (phase: Phase) => void; onRestart: () => void }

function CutoverBody({ ready, target, phase, setPhase, onRestart }: BodyProps) {
  const t = useT()
  const { state, provider } = useMigration()
  // 두 번째 승인(approveCutover) 뒤에 오는 전환 단계·측정 결과 이벤트를 읽는다.
  useStageFeed('verification', ready, target)
  const targetName = t(('target.' + target) as MsgKey)
  const [checked, setChecked] = useState(false)
  const doneSteps = phase === 'approve' ? 0 : state.cutover.doneSteps
  const tiles = state.cutover.results
  const measured = phase === 'verify' && tiles.length === RESULT_COUNT

  // 6단계가 끝나고 측정 구간에 들어갔다는 이벤트가 오면 화면도 측정 단계로 넘어간다.
  useEffect(() => {
    if (phase === 'running' && state.cutover.verifying) setPhase('verify')
  }, [phase, state.cutover.verifying, setPhase])

  if (phase === 'approve') {
    return <><div className="flow-center">
      <div className="approval-panel approval-inline">
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
            {tiles.map(tile => <div key={tile.id} className="cutover-tile">
              <small>{t(('cutover.tile.' + tile.id) as MsgKey)}</small>
              <strong>{tile.value || t(('cutover.tile.' + tile.id + 'Value') as MsgKey)}</strong>
              <em>✓ {t(('cutover.tile.' + tile.id + 'Rule') as MsgKey)}</em>
            </div>)}
          </div>
        : <p className="flow-note">{t('cutover.measureNote')}</p>}
    </aside>

    <div className="flow-footer">
      <span>{measured ? t('cutover.foot.done') : phase === 'verify' ? t('cutover.foot.verify') : t('cutover.foot.running')}</span>
      <button type="button" className="flow-primary" disabled={!measured} onClick={() => runTransition(() => setPhase('done'))}>{t('cutover.next')} <span aria-hidden="true">→</span></button>
    </div>
  </div><ArriveMorph key="cut-run" /></>
}
