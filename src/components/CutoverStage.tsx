'use client'

import { useEffect, useState } from 'react'
import StageShell from './StageShell'
import ProposalTag from './ProposalTag'
import CutoverDiagram, { CutoverQueue, type CutoverTopology, type CutoverView } from './CutoverDiagram'
import CutoverTimeline, { formatMs, useReplay, type TraceStep } from './CutoverTimeline'
import MigrationLanes from './MigrationLanes'
import MigrationReport from './MigrationReport'
import { ArriveMorph } from './ScreenFx'
import { runTransition } from '../lib/particleHandoff'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'
import type { MigrationState } from '../lib/migration/reducer'
import type { CutoverPlanData, CutoverStepData } from '../lib/migration/events'
import type { Target } from '../lib/stages'
import { useT, useTOr, type MsgKey } from '../lib/i18n'

type Phase = 'approve' | 'running' | 'done'
type RunView = 'wait' | 'pause' | 'verify' | 'done' | 'refused'

/** 받은 쓰기 중단 구간(몇 ms)을 화면에서 느리게 다시 보여 주는 시간. 표현용 값이며 데이터가 아니다. */
const REPLAY_MS = 3600
/** 계획이 오기 전 구성도의 빈 자리(이름 없이 그린다). */
const EMPTY_TOPOLOGY: CutoverTopology = { app: '—', pooler: '—', source_db: '—', target_db: '—', source_where: '—', target_where: '—', writes_per_sec: 0 }

export default function CutoverStage({ target, onRestart, onComplete }: { target: Target; onRestart: () => void; onComplete: () => void }) {
  const t = useT()
  const { state } = useMigration()
  const [phase, setPhase] = useState<Phase>('approve')
  // 본문이 알려 주는 지금 상태(쓰기 중단 구간 재생이 끝나야 결과 제목으로 바뀐다).
  const [run, setRun] = useState<RunView>('wait')
  // 다시 시도할 때 승인 순간의 시도 번호. 새 시도(cutover.ready의 attempt)가 오기 전까지 지난 결과는 숨긴다.
  const [stale, setStale] = useState(0)
  const plan = state.cutover.plan
  const kicker = phase === 'approve' ? 'APPROVAL 2/2 · DB CUTOVER' : 'DB CUTOVER · VERIFY'
  const title = phase === 'approve' ? t('cutover.approve.title') : t(('cut.title.' + run) as MsgKey)
  const subtitle = phase === 'approve'
    ? t('cutover.approve.lead', { pooler: plan?.topology.pooler ?? 'PgBouncer', target: plan?.topology.target_db ?? t('cut.d.target', { where: '' }) })
    : t(('cut.sub.' + run) as MsgKey)
  return <StageShell kicker={kicker} title={title} subtitle={subtitle} className="cx-stage" hideHeader={phase === 'done'}>
    {ready => <CutoverBody ready={ready} target={target} phase={phase} setPhase={setPhase} onRestart={onRestart} onComplete={onComplete} stale={stale} onApproved={() => setStale(state.cutover.attempt)} onView={setRun} />}
  </StageShell>
}

/** 지금 화면 상태(제목·문구용). replayDone은 쓰기 중단 구간 재생이 끝났는지(헤더는 결과가 오면 끝난 것으로 본다). */
function runViewOf(cutover: MigrationState['cutover'], replaying: boolean): RunView {
  if (cutover.steps.length === 0) return 'wait'
  if (!cutover.outcome || replaying) return 'pause'
  if (cutover.outcome.result === 'refused') return 'refused'
  const tablesOk = cutover.tables.length > 0 && cutover.tables.every(table => table.checksum === 'match')
  const handoverDone = cutover.handover.length > 0 && cutover.handover.every(item => item.state === 'done')
  return tablesOk && handoverDone ? 'done' : 'verify'
}

type BodyProps = { ready: boolean; target: Target; phase: Phase; setPhase: (phase: Phase) => void; onRestart: () => void; onComplete: () => void; stale: number; onApproved: () => void; onView: (view: RunView) => void }

function CutoverBody({ ready, target, phase, setPhase, onRestart, onComplete, stale, onApproved, onView }: BodyProps) {
  // 두 번째 승인(approveCutover) 전후의 전환 계획·단계·검증 이벤트를 읽는다.
  useStageFeed('verification', ready, target)
  if (phase === 'approve') return <><CutoverApproval onApprove={() => { onApproved(); setPhase('running') }} /><ArriveMorph key="cut-approve" /></>
  if (phase === 'done') return <><MigrationReport target={target} onRestart={onRestart} /><ArriveMorph key="cut-done" /></>
  return <><CutoverRun stale={stale} onView={onView} onRetry={() => setPhase('approve')} onNext={() => runTransition(() => { setPhase('done'); onComplete() })} /><ArriveMorph key="cut-run" /></>
}

/* ===================== 승인 2/2 ===================== */

function stepLabel(tOr: ReturnType<typeof useTOr>, id: string) {
  return tOr('cut.step.' + id, id)
}

function CutoverApproval({ onApprove }: { onApprove: () => void }) {
  const t = useT()
  const tOr = useTOr()
  const { state, provider } = useMigration()
  const [checked, setChecked] = useState(false)
  const plan = state.cutover.plan
  const allPass = !plan || plan.preconditions.every(item => item.state === 'pass')
  const preview: TraceStep[] = (plan?.steps ?? []).map(step => ({ key: step.id, label: stepLabel(tOr, step.id), ms: step.ms }))
  const topology = plan?.topology ?? EMPTY_TOPOLOGY
  const maxRehearsal = Math.max(1, ...(plan?.rehearsal.methods.map(item => item.pause_ms) ?? [1]))
  return <div className="cx-approve">
    <div className="cx-col">
      <section className="cx-card" aria-label={t('cut.pre.head')}>
        <h3>{t('cut.pre.head')}<small>{t('cut.pre.note')}</small></h3>
        {plan ? <div className="cx-ledger">
          {plan.preconditions.map(item => <div key={item.id} className={'cx-lrow is-' + item.state}>
            <span className="cx-ck" aria-hidden="true">{item.state === 'pass' ? '✓' : item.state === 'fail' ? '✕' : ''}</span>
            <strong>{tOr('cut.pre.' + item.id, item.id)}<em>{tOr('cut.pre.' + item.id + 'Sub')}</em></strong>
            <span className="cx-lval">{item.value && <b className="cx-mono">{item.value}</b>}<i className={'cx-pill is-' + item.state}>{t(('cut.state.' + item.state) as MsgKey)}</i></span>
            {item.evidence && <span className="cx-ev cx-mono">{item.evidence}</span>}
          </div>)}
        </div> : <p className="cx-quiet">{t('cut.plan.wait')}</p>}
      </section>

      {plan && <section className="cx-card" aria-label={t('cut.method.head')}>
        <h3>{t('cut.method.head')}<small>{t('cut.method.src', { source: plan.rehearsal.source, runs: plan.rehearsal.runs })}</small></h3>
        <div className="cx-method">
          <div><strong>{t(('cut.method.' + plan.method) as MsgKey)}</strong><p>{t(('cut.method.' + plan.method + 'Detail') as MsgKey)}</p></div>
          <div className="cx-expect"><small>{t('cut.method.expect')}</small><b className="cx-mono">{plan.expected_pause_ms.min}–{plan.expected_pause_ms.max}<span>ms</span></b></div>
          <div className="cx-compare">
            {plan.rehearsal.methods.map(item => <div key={item.method} className={'cx-cmp' + (item.method === plan.method ? ' is-chosen' : '')}>
              <span>{tOr('cut.method.cmp.' + item.method, item.method)}</span>
              <span className="cx-cmp-bar"><i style={{ width: Math.max(0.8, (item.pause_ms / maxRehearsal) * 100) + '%' }} /></span>
              <b className="cx-mono">{item.pause_ms} ms</b>
            </div>)}
          </div>
        </div>
      </section>}

      {plan && <section className="cx-card cx-grow" aria-label={t('cut.rb.head')}>
        <h3>{t('cut.rb.head')}<ProposalTag /></h3>
        <div className="cx-rb">
          <div><b>{t('cut.rb.fail')}</b>{t('cut.rb.failVal')}</div>
          <div><b>{t('cut.rb.after')}</b>{t('cut.rb.afterVal', { target: topology.target_db, source: topology.source_db })}</div>
          <div><b>{t('cut.rb.standby')}</b>{t('cut.rb.standbyVal', { hours: plan.rollback.standby_hours, source: topology.source_db })}</div>
          <div><b>{t('cut.rb.access')}</b>{t('cut.rb.accessVal')}</div>
          <p className="cx-warn">{t('cut.rb.warn')}</p>
        </div>
      </section>}

      <div className="cx-decide">
        <label className="approval-check">
          <input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />
          <span>{t('cutover.approve.check')}</span>
        </label>
        <div className="approval-actions">
          <button type="button" className="flow-primary" disabled={!checked || !allPass} onClick={() => runTransition(() => { provider.approveCutover(); onApprove() })}>{t('cutover.approve.go')} <span aria-hidden="true">→</span></button>
        </div>
      </div>
    </div>

    <div className="cx-col cx-right">
      <section className="cx-card cx-grow" aria-label={t('cut.how')}>
        <h3>{t('cut.how')}<small>{topology.app} → {topology.pooler} → {topology.source_db} / {topology.target_db}</small></h3>
        <CutoverDiagram topology={topology} ariaLabel={t('cut.how')} view={{ active: 'source', paused: false, forward: true, reverse: false, lag: null, failedTarget: false, settled: false }} />
      </section>
      <section className="cx-card cx-preview" aria-label={t('cut.preview')}>
        <h3>{t('cut.preview')}<small>{t('cut.previewNote')}</small></h3>
        {preview.length > 0 ? <CutoverTimeline steps={preview} ariaLabel={t('cut.preview')} /> : <p className="cx-quiet">{t('cut.plan.wait')}</p>}
      </section>
    </div>
  </div>
}

/* ===================== 전환 실행 ===================== */

function traceOf(steps: CutoverStepData[], tOr: ReturnType<typeof useTOr>, t: ReturnType<typeof useT>): TraceStep[] {
  return steps.map(step => ({
    key: step.n + '-' + (step.id ?? ''),
    label: step.id ? stepLabel(tOr, step.id) : String(step.n),
    ms: step.ms ?? 0,
    result: step.result,
    note: step.result === 'fail' ? '✕ ' + t('cut.step.fail') : undefined,
  }))
}

function CutoverRun({ stale, onView, onRetry, onNext }: { stale: number; onView: (view: RunView) => void; onRetry: () => void; onNext: () => void }) {
  const t = useT()
  const tOr = useTOr()
  const { state } = useMigration()
  // 다시 시도 직후: 새 시도가 시작될 때까지 지난 시도의 결과를 비운 채로 보인다.
  const cutover: MigrationState['cutover'] = stale > 0 && state.cutover.attempt === stale
    ? { ...state.cutover, ready: null, steps: [], outcome: null, tables: [], results: [], handover: [] }
    : state.cutover
  const plan: CutoverPlanData | null = cutover.plan
  const topology = plan?.topology ?? EMPTY_TOPOLOGY
  const outcome = cutover.outcome
  const trace = traceOf(cutover.steps, tOr, t)
  const traceMs = trace.reduce((sum, step) => sum + step.ms, 0)
  // 결과(outcome)가 오면 받은 단계들을 느리게 다시 보여 준다. 그 전에는 PAUSE 중으로 둔다.
  const { progress, finished, speed } = useReplay(traceMs, outcome ? cutover.attempt + '-' + outcome.result : null, REPLAY_MS)
  const view = runViewOf(cutover, !!outcome && !finished)
  const stage: 'wait' | 'pause' | 'after' = view === 'wait' ? 'wait' : view === 'pause' ? 'pause' : 'after'
  const refused = view === 'refused'
  const method = cutover.steps.find(step => step.method)?.method ?? plan?.method

  // 재생이 실패 단계에 닿으면 대상 DB를 빨갛게.
  let reached = 0
  const failSeen = trace.some(step => { const from = reached; reached += step.ms; return step.result === 'fail' && progress >= from })
  const lag = outcome?.replication.lag_ms ?? null
  const diagram: CutoverView = stage === 'after'
    ? refused
      ? { active: 'source', paused: false, forward: true, reverse: false, lag: null, failedTarget: true, settled: false }
      : { active: 'target', paused: false, forward: false, reverse: true, lag: lag === null ? null : lag + ' ms', failedTarget: false, settled: view === 'done' }
    : { active: 'source', paused: stage === 'pause', forward: true, reverse: false, lag: null, failedTarget: failSeen, settled: false }
  const shownMs = stage === 'after' ? outcome?.pause_ms ?? traceMs : stage === 'pause' ? progress : null
  const dest = refused || stage !== 'after' ? topology.source_db : topology.target_db

  const finishedOk = view === 'done' && state.status === 'done'
  useEffect(() => { onView(view) }, [view, onView])
  return <div className="cx-run">
    <ReadyGauge cutover={cutover} passed={stage !== 'wait'} />

    <div className="cx-mid">
      <section className="cx-card cx-hero" aria-label={t('cut.pause.head')}>
        <div className="cx-hero-top">
          <div>
            <h3>{t('cut.pause.head')}{method && <small className="cx-inline">{t(('cut.method.' + method) as MsgKey)}</small>}</h3>
            {outcome && <p className="cx-slow cx-mono">{t('cut.pause.slow', { x: speed })}</p>}
          </div>
          <div className={'cx-big' + (stage === 'after' ? (refused ? ' is-neg' : ' is-pass') : '')} role="status">
            <small>{stage === 'after' ? t(refused ? 'cut.pause.refused' : 'cut.pause.pass') : stage === 'pause' ? t('cut.pause.holding') : t('cut.pause.idle')}</small>
            <b className="cx-mono">{shownMs === null ? '—' : formatMs(shownMs)}<span>ms</span></b>
          </div>
        </div>
        {trace.length > 0
          ? <CutoverTimeline steps={trace} progress={outcome ? progress : 0} ariaLabel={t('cut.pause.head')} />
          : plan ? <CutoverTimeline className="is-ghost" steps={plan.steps.map(step => ({ key: step.id, label: stepLabel(tOr, step.id), ms: step.ms }))} progress={0} ariaLabel={t('cut.preview')} /> : <div className="cx-trace" />}
        <CutoverQueue mode={stage === 'pause' ? 'hold' : stage === 'after' ? 'flush' : 'flow'} held={outcome && stage !== 'wait' ? Math.round(outcome.held_requests * (stage === 'pause' ? Math.min(1, progress / (traceMs || 1)) : 1)) : 0}
          failed={outcome?.failed_requests ?? 0} pooler={topology.pooler} dest={dest} ariaLabel={t('cut.q.app')} />
      </section>
      <section className="cx-card" aria-label={t('cut.d.head')}>
        <h3>{t('cut.d.head')}<small>{refused ? t('cut.d.kept', { pooler: topology.pooler, db: topology.source_db }) : topology.pooler + ' → ' + (diagram.active === 'source' ? topology.source_db : topology.target_db)}</small></h3>
        <CutoverDiagram topology={topology} view={diagram} ariaLabel={t('cut.d.head')} />
      </section>
    </div>

    <div className="cx-bottom">
      <VerifyLedger cutover={cutover} show={stage === 'after'} refused={refused} />
      <Handover cutover={cutover} refused={refused} />
    </div>

    <div className="cx-foot">
      <MigrationLanes stage="cutover" />
      <div className="flow-footer cx-go">
        <small>{refused ? t('cut.foot.refused') : finishedOk ? t('cut.foot.done') : stage === 'after' ? t('cutover.foot.verify') : t('cutover.foot.running')}</small>
        {refused
          ? <button type="button" className="flow-primary" onClick={onRetry}>{t('cut.retry')} <span aria-hidden="true">→</span></button>
          : <button type="button" className="flow-primary" disabled={!finishedOk} onClick={onNext}>{t('cutover.next')} <span aria-hidden="true">→</span></button>}
      </div>
    </div>
  </div>
}

function ReadyGauge({ cutover, passed }: { cutover: MigrationState['cutover']; passed: boolean }) {
  const t = useT()
  const ready = cutover.ready
  const ok = passed || !!ready?.ready
  const tx = ready ? ready.longest_tx_ms / 1000 : null
  const limitS = ready ? ready.limits.longest_tx_ms / 1000 : null
  // 막대 끝 = 기준의 5배. 기준선은 20% 자리.
  const txWidth = ready ? Math.min(100, (ready.longest_tx_ms / (ready.limits.longest_tx_ms * 5)) * 100) : 0
  return <section className={'cx-card cx-gauge' + (ok ? ' is-ok' : '')} aria-label={t('cut.ready.wait')}>
    <div className="cx-g-state"><span className={'cx-dot' + (ok ? ' is-ok' : ready ? ' is-live' : '')} aria-hidden="true" /><strong role="status">{ok ? t('cut.ready.ok') : t('cut.ready.wait')}</strong></div>
    <div className="cx-met"><small>{t('cut.ready.tx')}</small><b className="cx-mono">{tx === null ? '—' : tx.toFixed(2) + ' s'}</b>{limitS !== null && <em className="cx-mono">≤ {limitS} s</em>}
      <div className="cx-mbar"><i style={{ width: txWidth + '%' }} /><u style={{ left: '20%' }} /></div></div>
    <div className="cx-met"><small>{t('cut.ready.locks')}</small><b className="cx-mono">{ready ? ready.lock_waits : '—'}</b>{ready && <em className="cx-mono">= {ready.limits.lock_waits}</em>}
      <div className="cx-mbar"><i style={{ width: ready && ready.lock_waits > ready.limits.lock_waits ? '100%' : '0%' }} /></div></div>
    <div className="cx-met"><small>{t('cut.ready.commits')}</small><b className="cx-mono">{ready ? ready.commits_per_sec + ' /s' : '—'}</b><em>{t('cut.ready.ref')}</em></div>
    <p className="cx-g-why">{!ready ? t('cut.ready.none') : ok ? t('cut.ready.go') : ready.waiting_on ? t('cut.ready.waiting', { what: ready.waiting_on, s: ((ready.waited_ms ?? 0) / 1000).toFixed(1) }) : t('cut.ready.wait')}</p>
  </section>
}

function VerifyLedger({ cutover, show, refused }: { cutover: MigrationState['cutover']; show: boolean; refused: boolean }) {
  const t = useT()
  const tOr = useTOr()
  const tables = show ? cutover.tables : []
  const results = show ? cutover.results : []
  const matched = tables.length > 0 && tables.every(table => table.checksum === 'match')
  const mismatch = tables.some(table => table.checksum === 'mismatch') || results.some(result => result.ok === false)
  const reason = cutover.outcome?.reason
  const verdict = refused
    ? { cls: 'is-neg', text: t('cut.v.refused', { reason: reason ? tOr('cut.reason.' + reason, reason) : '—' }) }
    : mismatch ? { cls: 'is-neg', text: t('cut.v.bad') }
    : matched && results.length > 0 ? { cls: 'is-pass', text: t('cut.v.pass', { n: tables.length }) }
    : { cls: '', text: t('cut.v.wait') }
  const fmt = (value: number | null) => (value === null ? '' : value.toLocaleString())
  return <section className="cx-card cx-verify" aria-label={t('cut.v.head')}>
    <h3>{t('cut.v.head')}<small>{t('cut.v.note')}</small></h3>
    <div className="cx-vgrid">
      <table className="cx-table">
        <thead><tr><th>{t('cut.v.table')}</th><th>{t('cut.v.src')}</th><th>{t('cut.v.dst')}</th><th>{t('cut.v.sum')}</th></tr></thead>
        <tbody>{tables.map(table => <tr key={table.table} className={'is-' + table.checksum}>
          <td className="cx-mono">{table.table}</td>
          <td className="cx-mono">{fmt(table.source_rows)}</td>
          <td className="cx-mono">{table.target_rows === null ? <span className="cx-faint">{t('cut.v.replicating')}</span> : fmt(table.target_rows)}</td>
          <td className="cx-sum">{t(('cut.v.' + table.checksum) as MsgKey)}</td>
        </tr>)}</tbody>
      </table>
      <div className="cx-totals">
        <div className="cx-ledger">
          {results.map(result => {
            const key = 'cutover.tile.' + result.id
            return <div key={result.id} className={'cutover-tile cx-trow' + (result.ok === false ? ' is-bad' : '')}>
              <span>{result.label || tOr(key, result.id)}<em>{tOr(key + 'Rule')}</em></span>
              <b className="cx-mono">{result.value}</b>
            </div>
          })}
        </div>
        <p className={'cx-verdict ' + verdict.cls} role="status">{verdict.text}</p>
      </div>
    </div>
  </section>
}

function Handover({ cutover, refused }: { cutover: MigrationState['cutover']; refused: boolean }) {
  const t = useT()
  // 항목·순서는 전환 계획이 정하고, 상태는 cutover.handover 이벤트가 알려 준다(계획이 없으면 받은 순서).
  const items = cutover.plan?.handover ?? cutover.handover.map(item => ({ item: item.item, detail: item.detail }))
  return <section className="cx-card cx-hand" aria-label={t('cutover.handover.title')}>
    <h3>{t('cutover.handover.title')} <ProposalTag /><small>{refused ? t('cut.h.heldNote') : t('cut.h.after')}</small></h3>
    <div className="cx-ledger">
      {items.map(entry => {
        const event = cutover.handover.find(item => item.item === entry.item)
        const state = event?.state ?? 'wait'
        const label = state === 'done' ? t('cutover.state.done') : state === 'running' ? t('cutover.state.running') : state === 'held' ? t('cut.h.held') : t('cutover.state.wait')
        return <div key={entry.item} className={'cx-lrow is-' + state}>
          <span className="cx-ck" aria-hidden="true">{state === 'done' ? '✓' : state === 'held' ? '–' : ''}</span>
          <strong>{t(('cutover.handover.' + entry.item) as MsgKey)}</strong>
          <span className="cx-lval"><i className="cx-state">{label}</i></span>
          {(event?.detail ?? entry.detail) && <span className="cx-ev cx-mono">{event?.detail ?? entry.detail}</span>}
        </div>
      })}
    </div>
  </section>
}
