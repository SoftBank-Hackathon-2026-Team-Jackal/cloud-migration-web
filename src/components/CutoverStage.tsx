'use client'

import { useEffect, useMemo, useState } from 'react'
import StageShell from './StageShell'
import ProposalTag from './ProposalTag'
import CutoverDiagram from './CutoverDiagram'
import LiveRequests from './LiveRequests'
import MigrationReport from './MigrationReport'
import { ArriveMorph } from './ScreenFx'
import { runTransition } from '../lib/particleHandoff'
import { useScript, type TimedItem } from '../lib/useScript'
import type { Target } from '../lib/stages'
import { useT, type MsgKey } from '../lib/i18n'

type Phase = 'approve' | 'running' | 'verify' | 'done'

const STEPS = [1, 2, 3, 4, 5, 6]
const ENTER_MS = 2400

type Tile = { id: 'fail' | 'delay' | 'loss' }
const TILES: Array<TimedItem<Tile>> = [
  { after: 600, item: { id: 'fail' } },
  { after: 1500, item: { id: 'delay' } },
  { after: 2400, item: { id: 'loss' } },
]

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
  const targetName = t(('target.' + target) as MsgKey)
  const [doneSteps, setDoneSteps] = useState(0)
  const [checked, setChecked] = useState(false)
  const tiles = useScript(useMemo(() => TILES, []), ready && phase === 'verify')
  const measured = phase === 'verify' && tiles.length === TILES.length

  useEffect(() => {
    if (phase !== 'running') return
    setDoneSteps(0)
    // 화면이 입자로 만들어지는 동안(ENTER_MS)은 내용이 아직 안 보이므로, 그만큼 기다렸다가 단계를 시작한다.
    const timers = STEPS.map((_, index) => window.setTimeout(() => setDoneSteps(index + 1), ENTER_MS + (index + 1) * 1100))
    timers.push(window.setTimeout(() => setPhase('verify'), ENTER_MS + STEPS.length * 1100 + 900))
    return () => timers.forEach(timer => window.clearTimeout(timer))
  }, [phase, setPhase])

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
          <button type="button" className="flow-primary" disabled={!checked} onClick={() => runTransition(() => setPhase('running'))}>{t('cutover.approve.go')} <span aria-hidden="true">→</span></button>
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
              <strong>{t(('cutover.tile.' + tile.id + 'Value') as MsgKey)}</strong>
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
