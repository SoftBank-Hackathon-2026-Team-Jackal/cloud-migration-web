'use client'

import { useEffect, useState } from 'react'
import StageShell from './StageShell'
import ProposalTag from './ProposalTag'
import CutoverDiagram, { CutoverQueue, type CutoverTopology, type CutoverView } from './CutoverDiagram'
import CutoverTimeline, { formatMs, placeSteps, useReplay, type TraceStep } from './CutoverTimeline'
import MigrationLanes from './MigrationLanes'
import { CutoverAppTelemetry } from './AppTelemetryPanel'
import { ArriveMorph } from './ScreenFx'
import { runTransition } from '../lib/particleHandoff'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'
import type { MigrationState } from '../lib/migration/reducer'
import type { CutoverPlanData, CutoverStepData, CutoverStepPlan } from '../lib/migration/events'
import { canApproveCutover, cutoverEntry, cutoverGate, cutoverRunView, type CutoverRunView } from '../lib/migration/flow'
import { preconditionMark, preconditionTone, preconditionsAllowCutover } from '../lib/migration/shadow'
import { useVoiceActions } from '../lib/voice/actions'
import type { Target } from '../lib/stages'
import { useT, useTOr, type MsgKey } from '../lib/i18n'

type Phase = 'approve' | 'running'
type RunView = CutoverRunView

/** 받은 쓰기 중단 구간(몇 ms)을 화면에서 느리게 다시 보여 주는 시간. 표현용 값이며 데이터가 아니다. */
const REPLAY_MS = 3600
/** 계획이 오기 전 구성도의 빈 자리(이름 없이 그린다). */
const EMPTY_TOPOLOGY: CutoverTopology = { app: '—', pooler: '—', source_db: '—', target_db: '—', source_where: '—', target_where: '—', writes_per_sec: 0 }

/**
 * DB 전환(승인 2/2 → 쓰기 중단 구간 → 검증). 백엔드 순서대로 데이터 복제 뒤, 트래픽 전환 앞에 온다.
 * 승인 버튼은 승인 요청(approval.required gate=cutover)이 와야 열린다. 전환이 통과하면 "트래픽 전환으로"(onTraffic).
 * 다시 들어오면 전환이 시작됐거나 끝났을 때 전환 결과를, 아니면 승인 화면을 보인다(flow.ts cutoverEntry).
 */
export default function CutoverStage({ target, onTraffic }: { target: Target; onTraffic: () => void }) {
  const t = useT()
  const { state } = useMigration()
  const [phase, setPhase] = useState<Phase>(() => cutoverEntry(state) === 'approve' ? 'approve' : 'running')
  // 본문이 알려 주는 지금 상태(쓰기 중단 구간 재생이 끝나야 결과 제목으로 바뀐다).
  const [run, setRun] = useState<RunView>('wait')
  // 다시 시도할 때 승인 순간의 시도 번호. 새 시도(cutover.ready의 attempt)가 오기 전까지 지난 결과는 숨긴다.
  const [stale, setStale] = useState(0)
  // 전환을 마친 뒤 롤백돼 승인 요청이 다시 오면 승인 화면으로 돌아간다(버튼이 다시 열린다).
  const required = state.approval.cutoverRequired
  const switchedBefore = state.cutover.outcome?.result === 'switched'
  useEffect(() => { if (required && switchedBefore) setPhase('approve') }, [required, switchedBefore])
  const plan = state.cutover.plan
  const gate = cutoverGate(state, false)
  const kicker = phase === 'approve' ? 'APPROVAL 2/2 · DB CUTOVER' : 'DB CUTOVER · VERIFY'
  const title = phase === 'approve' ? t(gate === 'waiting' ? 'cut.gate.waitTitle' : 'cutover.approve.title') : t(('cut.title.' + run) as MsgKey)
  const subtitle = phase === 'approve'
    ? gate === 'waiting' ? t('cut.gate.waitLead') : t('cutover.approve.lead', { pooler: plan?.topology.pooler ?? 'PgBouncer', target: plan?.topology.target_db ?? t('cut.d.target', { where: '' }) })
    : t(('cut.sub.' + run) as MsgKey)
  return <StageShell kicker={kicker} title={title} subtitle={subtitle} className="cx-stage">
    {ready => <CutoverBody ready={ready} target={target} phase={phase} setPhase={setPhase} onTraffic={onTraffic} stale={stale} onApproved={() => setStale(state.cutover.attempt)} onView={setRun} />}
  </StageShell>
}

type BodyProps = { ready: boolean; target: Target; phase: Phase; setPhase: (phase: Phase) => void; onTraffic: () => void; stale: number; onApproved: () => void; onView: (view: RunView) => void }

function CutoverBody({ ready, target, phase, setPhase, onTraffic, stale, onApproved, onView }: BodyProps) {
  // 두 번째 승인(approveCutover) 전후의 전환 계획·단계·검증 이벤트를 읽는다.
  useStageFeed('verification', ready, target)
  if (phase === 'approve') return <><CutoverApproval onApprove={() => { onApproved(); setPhase('running') }} /><ArriveMorph key="cut-approve" /></>
  return <><CutoverRun stale={stale} onView={onView} onRetry={() => setPhase('approve')} onNext={onTraffic} /><ArriveMorph key="cut-run" /></>
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
  // 승인을 보내는 중(중복 클릭 막음). 202면 진행 화면으로, 거절(409 CUTOVER_NOT_READY 등)이면 안내와 함께 다시 누를 수 있다.
  const [sending, setSending] = useState(false)
  const plan = state.cutover.plan
  // 경고 전용 조건(그림자 리허설 warn·skip)은 승인을 막지 않는다.
  const allPass = !plan || preconditionsAllowCutover(plan.preconditions)
  const gate = cutoverGate(state, sending)
  const approveError = gate === 'rejected' ? state.requestErrors.cutover : undefined
  const approveErrorText = useApproveErrorText()
  const send = () => {
    if (sending || !canApproveCutover(gate)) return
    setSending(true)
    void provider.approveCutover().then(accepted => {
      setSending(false)
      if (accepted) runTransition(onApprove)
    })
  }
  const canSend = canApproveCutover(gate) && allPass
  // 음성: "승인해"는 승인 요청이 왔고 전제 조건이 모두 통과했을 때만 받는다(체크도 함께 켠다).
  useVoiceActions({ approve: canSend && (() => { setChecked(true); send() }) })
  const preview = timedTrace(plan?.steps ?? [], [], tOr)
  const topology = plan?.topology ?? EMPTY_TOPOLOGY
  const maxRehearsal = Math.max(1, ...(plan?.rehearsal.methods.map(item => item.pause_ms) ?? [1]))
  return <div className="cx-approve">
    <div className="cx-col">
      <section className="cx-card" aria-label={t('cut.pre.head')}>
        <h3>{t('cut.pre.head')}<small>{t('cut.pre.note')}</small></h3>
        {plan ? <div className="cx-ledger">
          {plan.preconditions.map(item => <div key={item.id} className={'cx-lrow is-' + preconditionTone(item.state)}>
            <span className="cx-ck" aria-hidden="true">{preconditionMark(item.state)}</span>
            <strong>{tOr('cut.pre.' + item.id, item.id)}{item.proposal && <> <ProposalTag /></>}<em>{tOr('cut.pre.' + item.id + 'Sub')}</em></strong>
            <span className="cx-lval">{item.value && <b className="cx-mono">{item.id === 'lag' ? item.value.replace(/^0 ?B/, t('cut.pre.lagNone')) : item.value}</b>}<i className={'cx-pill is-' + preconditionTone(item.state)}>{t(('cut.state.' + item.state) as MsgKey)}</i></span>
            {item.evidence && <span className="cx-ev cx-mono">{item.evidence}</span>}
          </div>)}
        </div> : <p className="cx-quiet">{t('cut.plan.wait')}</p>}
      </section>

      {plan && <section className="cx-card" aria-label={t('cut.method.head')}>
        <h3>{t('cut.method.head')}</h3>
        <div className="cx-method">
          <div><strong>{t(('cut.method.' + plan.method) as MsgKey)}</strong><p>{t(('cut.method.' + plan.method + 'Detail') as MsgKey)}</p></div>
          <div className="cx-expect"><small>{t('cut.method.expect')}</small><b className="cx-mono">{plan.expected_pause_ms.min}–{plan.expected_pause_ms.max}<span>ms</span></b></div>
          {/* 방식별 리허설 비교는 접어 둔다(승인에는 고른 방식과 예상 중단 시간이면 충분하다) */}
          <details className="cx-more">
            <summary>{t('cut.method.src', { source: plan.rehearsal.source, runs: plan.rehearsal.runs })}</summary>
            <div className="cx-compare">
              {plan.rehearsal.methods.map(item => <div key={item.method} className={'cx-cmp' + (item.method === plan.method ? ' is-chosen' : '')}>
                <span>{tOr('cut.method.cmp.' + item.method, item.method)}</span>
                <span className="cx-cmp-bar"><i style={{ width: Math.max(0.8, (item.pause_ms / maxRehearsal) * 100) + '%' }} /></span>
                <b className="cx-mono">{item.pause_ms} ms</b>
              </div>)}
            </div>
          </details>
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

      <div className="cx-decide" data-gate={gate}>
        <label className="approval-check">
          <input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />
          <span>{t('cutover.approve.check')}</span>
        </label>
        <p className="cx-gate-note" role={approveError ? 'alert' : 'status'}>
          {approveError ? approveErrorText(approveError.detail) : t(('cut.gate.' + gate) as MsgKey)}
        </p>
        <div className="approval-actions">
          <button type="button" className="flow-primary" disabled={!checked || !canSend} aria-busy={sending} onClick={send}>{t(gate === 'sending' ? 'cut.gate.sendingBtn' : 'cutover.approve.go')} <span aria-hidden="true">→</span></button>
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
        <PreSteps steps={preview.pre} />
        {preview.pause.length > 0 ? <CutoverTimeline steps={preview.pause} ariaLabel={t('cut.preview')} /> : <p className="cx-quiet">{t('cut.plan.wait')}</p>}
      </section>
    </div>
  </div>
}

/* ===================== 전환 실행 ===================== */

type Trace = { pre: TraceStep[]; pause: TraceStep[] }

const toTrace = (step: CutoverStepPlan, events: CutoverStepData[], tOr: ReturnType<typeof useTOr>, index: number): TraceStep => ({
  key: index + '-' + step.id, label: stepLabel(tOr, step.id), ms: step.ms, start: step.start_ms,
  result: events.find(event => event.id === step.id)?.result,
})

/** 시간이 있는 단계들(계획의 미리보기 또는 통과 결과의 steps_ms)을 PAUSE 전·안으로 나눈다. */
function timedTrace(steps: CutoverStepPlan[], events: CutoverStepData[], tOr: ReturnType<typeof useTOr>): Trace {
  const all = steps.map((step, index) => ({ step, row: toTrace(step, events, tOr, index) }))
  return { pre: all.filter(item => item.step.window === 'pre').map(item => item.row), pause: all.filter(item => item.step.window !== 'pre').map(item => item.row) }
}

/**
 * 시간을 모를 때(실행 중 · 중단돼 단계별 시간이 없음)의 상태 줄. 계획의 단계를 뼈대로 두고, 받은 상태를 채우며,
 * 계획에 없는 단계(예: 원본으로 되돌림)는 받은 순서대로 붙인다. 끝났는데 오지 않은 단계는 '실행 안 함'.
 */
function stateTrace(plan: CutoverPlanData | null, events: CutoverStepData[], finished: boolean, tOr: ReturnType<typeof useTOr>, t: ReturnType<typeof useT>): Trace {
  const planned = plan?.steps ?? []
  const ids = planned.map(step => ({ id: step.id, window: step.window }))
  for (const event of events) if (event.id && !ids.some(item => item.id === event.id)) ids.push({ id: event.id, window: event.window })
  const rows = ids.map((item, index) => {
    const event = events.find(entry => entry.id === item.id)
    const note = event
      ? event.result === 'fail' ? '✕ ' + tOr('cut.step.' + item.id + 'Fail', t('cut.step.fail')) : event.result === 'revert' ? '↩ ' + t('cut.trace.revert') : '✓ ' + t('cut.trace.done')
      : finished ? t('cut.trace.skip') : ''
    return { window: item.window, row: { key: index + '-' + item.id, label: stepLabel(tOr, item.id), ms: null, result: event ? event.result : 'skip' as const, note } satisfies TraceStep }
  })
  return { pre: rows.filter(item => item.window === 'pre').map(item => item.row), pause: rows.filter(item => item.window !== 'pre').map(item => item.row) }
}

/** PAUSE 전에 미리 하는 단계(예: 시퀀스 미리 올림) 한 줄. */
function PreSteps({ steps }: { steps: TraceStep[] }) {
  const t = useT()
  if (steps.length === 0) return null
  return <p className="cx-pre"><b>{t('cut.pre.window')}</b>{steps.map(step => <span key={step.key}>{step.label} <span className="cx-mono">{step.ms === null ? step.note : formatMs(step.ms) + ' ms'}</span></span>)}</p>
}

function CutoverRun({ stale, onView, onRetry, onNext }: { stale: number; onView: (view: RunView) => void; onRetry: () => void; onNext: () => void }) {
  const t = useT()
  const tOr = useTOr()
  const { state, mode } = useMigration()
  // 다시 시도 직후: 새 시도가 시작될 때까지 지난 시도의 결과를 비운 채로 보인다.
  const cutover: MigrationState['cutover'] = stale > 0 && state.cutover.attempt === stale
    ? { ...state.cutover, ready: null, steps: [], outcome: null, tables: [], results: [], handover: [] }
    : state.cutover
  const plan: CutoverPlanData | null = cutover.plan
  const topology = plan?.topology ?? EMPTY_TOPOLOGY
  const outcome = cutover.outcome
  // 단계별 시간은 통과했을 때 결과(outcome.steps)로 한 번에 온다. 그 전·중단이면 단계 상태만 보인다.
  const timed = !!outcome?.steps?.length
  const trace: Trace = timed ? timedTrace(outcome!.steps!, cutover.steps, tOr) : stateTrace(plan, cutover.steps, !!outcome, tOr, t)
  const spans = placeSteps(trace.pause)
  const traceMs = timed ? Math.max(0, ...spans.map(span => span.to)) : 0
  // 결과가 오면 받은 단계 시간을 느리게 다시 보여 준다(시간이 없으면 바로 끝).
  const { progress, finished, speed } = useReplay(traceMs, outcome ? cutover.attempt + '-' + outcome.result : null, REPLAY_MS)
  const view = cutoverRunView(cutover, !!outcome && !finished)
  const stage: 'wait' | 'pause' | 'after' = view === 'wait' ? 'wait' : view === 'pause' ? 'pause' : 'after'
  const refused = view === 'refused'
  const method = cutover.steps.find(step => step.method)?.method ?? plan?.method

  // 대상 확인이 실패한 단계가 오면 대상 DB를 빨갛게.
  const failSeen = cutover.steps.some(step => step.result === 'fail')
  const lag = outcome?.replication.lag_ms ?? null
  const diagram: CutoverView = stage === 'after'
    ? refused
      ? { active: 'source', paused: false, forward: true, reverse: false, lag: null, failedTarget: true, settled: false }
      : { active: 'target', paused: false, forward: false, reverse: true, lag: lag === null ? null : lag + ' ms', failedTarget: false, settled: view === 'done' }
    : { active: 'source', paused: stage === 'pause', forward: true, reverse: false, lag: null, failedTarget: failSeen, settled: false }
  const shownMs = stage === 'after' ? outcome?.pause_ms ?? null : stage === 'pause' && timed ? progress : null
  const dest = refused || stage !== 'after' ? topology.source_db : topology.target_db

  // 전환·검증이 통과하면 "트래픽 전환으로"를 연다(트래픽은 DB 전환이 끝나야 시작한다).
  const finishedOk = view === 'done'
  // 2차 승인 요청이 거절됐다(409 CUTOVER_NOT_READY·404·503): 이전은 계속 돈다. 전환이 시작되기 전이면 이 화면 안에서 알리고 다시 승인하게 한다.
  const approveError = view === 'wait' ? state.requestErrors.cutover : undefined
  const approveErrorText = useApproveErrorText()
  useVoiceActions({ next: finishedOk && onNext, retry: (refused || !!approveError) && onRetry })
  useEffect(() => { onView(view) }, [view, onView])
  return <div className="cx-run">
    <ReadyGauge cutover={cutover} passed={stage !== 'wait'} />

    <div className="cx-mid">
      <section className="cx-card cx-hero" aria-label={t('cut.pause.head')}>
        <div className="cx-hero-top">
          <div>
            <h3>{t('cut.pause.head')}{method && <small className="cx-inline">{t(('cut.method.' + method) as MsgKey)}</small>}</h3>
            {timed ? <p className="cx-slow cx-mono">{t('cut.pause.slow', { x: speed })}</p> : <p className="cx-slow">{outcome ? t('cut.trace.noTiming') : t('cut.trace.later')}</p>}
          </div>
          <div className={'cx-big' + (stage === 'after' ? (refused ? ' is-neg' : ' is-pass') : '')} role="status">
            <small>{stage === 'after' ? t(refused ? 'cut.pause.refused' : 'cut.pause.pass') : stage === 'pause' ? t('cut.pause.holding') : t('cut.pause.idle')}</small>
            <b className="cx-mono">{shownMs === null ? '—' : <>{formatMs(shownMs)}<span>ms</span></>}</b>
          </div>
        </div>
        <PreSteps steps={trace.pre} />
        {trace.pause.length > 0
          ? <CutoverTimeline className={stage === 'wait' ? 'is-ghost' : ''} steps={trace.pause} progress={timed ? progress : null} ariaLabel={t('cut.pause.head')} />
          : <div className="cx-trace" />}
        <CutoverQueue mode={stage === 'pause' ? 'hold' : stage === 'after' ? 'flush' : 'flow'} held={outcome && stage !== 'wait' ? Math.round((outcome.held_requests ?? 0) * (stage === 'pause' && timed ? Math.min(1, progress / (traceMs || 1)) : 1)) : 0}
          failed={outcome?.failed_requests ?? 0} pooler={topology.pooler} dest={dest} ariaLabel={t('cut.q.app')} />
      </section>
      <section className="cx-card" aria-label={t('cut.d.head')}>
        <h3>{t('cut.d.head')}<small>{refused ? t('cut.d.kept', { pooler: topology.pooler, db: topology.source_db }) : topology.pooler + ' → ' + (diagram.active === 'source' ? topology.source_db : topology.target_db)}</small></h3>
        <CutoverDiagram topology={topology} view={diagram} ariaLabel={t('cut.d.head')} />
        {mode !== 'mock' && <CutoverAppTelemetry />}
      </section>
    </div>

    <div className="cx-bottom">
      <VerifyLedger cutover={cutover} show={stage === 'after'} refused={refused} />
      <Handover cutover={cutover} held={refused ? 'refused' : view === 'mismatch' ? 'mismatch' : null} />
    </div>

    <div className="cx-foot">
      <MigrationLanes stage="cutover" />
      <div className="flow-footer cx-go">
        <small role={approveError ? 'alert' : undefined}>{approveError ? approveErrorText(approveError.detail) : refused ? t('cut.foot.refused') : view === 'mismatch' ? t('cut.foot.mismatch') : finishedOk ? t('cut.foot.toTraffic') : stage === 'after' ? t('cutover.foot.verify') : t('cutover.foot.running')}</small>
        {refused || approveError
          ? <button type="button" className="flow-primary" onClick={onRetry}>{t('cut.retry')} <span aria-hidden="true">→</span></button>
          : <button type="button" className="flow-primary" disabled={!finishedOk} onClick={onNext}>{t('cut.toTraffic')} <span aria-hidden="true">→</span></button>}
      </div>
    </div>
  </div>
}

/** 2차 승인 요청 오류 문구: 아는 코드(CUTOVER_NOT_READY · HTTP_404 · HTTP_503 · NETWORK)는 그 문구, 모르면 코드와 함께 일반 문구. */
function useApproveErrorText() {
  const t = useT()
  const tOr = useTOr()
  return (detail?: string) => tOr('cut.err.' + (detail ?? 'unknown'), t('cut.err.generic', { code: detail ?? '—' }))
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
    // 사유 코드가 오면 그 문구, 없으면 일반 거부 문구
    ? { cls: 'is-neg', text: reason ? t('cut.v.refused', { reason: tOr('cut.reason.' + reason, reason) }) : t('cut.v.refusedGeneric') }
    : mismatch ? { cls: 'is-neg', text: t('cut.v.bad', { n: tables.filter(table => table.checksum === 'mismatch').length }) }
    // 플랫폼은 합계(cutover.result) 없이 표만 보낸다: 전환이 통과했고 표가 모두 일치하면 통과.
    : matched && (results.length > 0 || cutover.outcome?.result === 'switched') ? { cls: 'is-pass', text: t('cut.v.pass', { n: tables.length }) }
    : { cls: '', text: t('cut.v.wait') }
  const fmt = (value: number | null) => (value === null ? '' : value.toLocaleString())
  return <section className="cx-card cx-verify" aria-label={t('cut.v.head')}>
    <h3>{t('cut.v.head')}<small>{t('cut.v.note')}</small></h3>
    <div className="cx-vgrid">
      {/* 표가 카드보다 길어도 아래가 잘리지 않도록 스크롤 영역으로 감싼다 */}
      <div className="cx-table-wrap"><table className="cx-table">
        <thead><tr><th>{t('cut.v.table')}</th><th>{t('cut.v.src')}</th><th>{t('cut.v.dst')}</th><th>{t('cut.v.sum')}</th></tr></thead>
        <tbody>{tables.map(table => <tr key={table.table} className={'is-' + table.checksum}>
          <td className="cx-mono">{table.table}</td>
          <td className="cx-mono">{fmt(table.source_rows)}</td>
          <td className="cx-mono">{table.target_rows === null ? <span className="cx-faint">{t('cut.v.replicating')}</span> : fmt(table.target_rows)}</td>
          <td className="cx-sum">{t(('cut.v.' + table.checksum) as MsgKey)}</td>
        </tr>)}</tbody>
      </table></div>
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
        <p className={'cx-verdict ' + verdict.cls} role="status">{verdict.text}{refused && cutover.outcome?.message && <span className="cx-abort cx-mono" title={cutover.outcome.message}>{cutover.outcome.message}</span>}</p>
      </div>
    </div>
  </section>
}

function Handover({ cutover, held }: { cutover: MigrationState['cutover']; held: 'refused' | 'mismatch' | null }) {
  const t = useT()
  // 항목·순서는 전환 계획이 정하고, 상태는 cutover.handover 이벤트가 알려 준다(계획이 없으면 받은 순서).
  const items = cutover.plan?.handover ?? cutover.handover.map(item => ({ item: item.item, detail: item.detail }))
  return <section className="cx-card cx-hand" aria-label={t('cutover.handover.title')}>
    <h3>{t('cutover.handover.title')} <ProposalTag /><small>{held === 'refused' ? t('cut.h.heldNote') : held === 'mismatch' ? t('cut.h.heldMismatch') : t('cut.h.after')}</small></h3>
    <div className="cx-ledger">
      {items.map(entry => {
        const event = cutover.handover.find(item => item.item === entry.item)
        const state = event?.state ?? 'wait'
        const label = state === 'done' ? t('cutover.state.done') : state === 'running' ? t('cutover.state.running') : state === 'held' ? t('cut.h.held') : t('cutover.state.wait')
        return <div key={entry.item} className={'cx-lrow is-' + state}>
          <span className="cx-ck" aria-hidden="true">{state === 'done' ? '✓' : state === 'held' ? '–' : ''}</span>
          <strong>{t(('cutover.handover.' + entry.item) as MsgKey)}</strong>
          <span className="cx-lval"><i className="cx-state">{label}</i></span>
          {(event?.detail ?? entry.detail) && <span className="cx-ev cx-mono" title={event?.detail ?? entry.detail}>{event?.detail ?? entry.detail}</span>}
        </div>
      })}
    </div>
  </section>
}
