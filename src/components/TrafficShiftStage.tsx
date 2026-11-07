'use client'

import { useEffect, useRef, useState } from 'react'
import StageShell from './StageShell'
import ProposalTag from './ProposalTag'
import TrafficCanvas from './TrafficCanvas'
import MigrationLanes from './MigrationLanes'
import TrafficHealthPanel from './TrafficHealthPanel'
import type { Target } from '../lib/stages'
import { orderKey, useI18n, useT, type MsgKey } from '../lib/i18n'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'
import { useVoiceActions } from '../lib/voice/actions'
import { DEFAULT_ACTIVITY, breachOf, policyOf, stageOf, stepCards, verdictOf, type CardState, type Stage } from '../lib/migration/trafficModel'

type Tone = 'ok' | 'warn' | 'fail' | 'pass'
// 실행 기록의 종류별 색. 문구는 traffic.log.<key> / traffic.log.<key>Detail
// pass(금색)는 통과 순간(100% 도달·원본 정리 가능)에만 쓴다.
const LOG_TONE: Record<string, Tone> = { gateFail: 'fail', rollback: 'fail', prepareFail: 'fail', manual: 'warn', inject: 'warn', reached: 'pass', drained: 'pass', alert: 'fail', dbRollback: 'warn', finalized: 'pass' }
// 화면 국면별 제목 키 꼬리(traffic.heading.<key>)
const HEADING: Record<Stage, string> = { prepare: 'prepare', blocked: 'blocked', applying: 'shifting', observing: 'shifting', gate: 'shifting', stabilizing: 'stabilizing', complete: 'done', drained: 'done', rolledback: 'rolledback' }

export default function TrafficShiftStage({ target, onNext }: { target: Target; onNext: () => void }) {
  const t = useT()
  const { state } = useMigration()
  const { snapshot, prepare } = state.traffic
  const stage = stageOf(snapshot, prepare)
  const policy = policyOf(snapshot, prepare)
  return <StageShell kicker={t('traffic.kicker', { relay: prepare?.relay?.name ?? '' })} title={t(('traffic.heading.' + HEADING[stage]) as MsgKey)}
    subtitle={t('traffic.subtitle', { relay: prepare?.relay?.name ?? t('traffic.path.relay'), steps: policy.steps.join(' → ') })} className="traffic-stage">
    {ready => <TrafficBody ready={ready} target={target} onNext={onNext} />}
  </StageShell>
}

const sec = (value: number) => (Math.round(value * 10) / 10).toFixed(1)

function TrafficBody({ ready, target, onNext }: { ready: boolean; target: Target; onNext: () => void }) {
  const t = useT()
  const { tOr } = useI18n()
  const { state, mode, provider, can } = useMigration()
  // 사전 확인·가중치·관찰 지표·게이트 판정은 traffic.prepare · traffic.snapshot 이벤트로 받는다.
  useStageFeed('traffic', ready, target)
  const { snapshot, prepare, trace, startedAt } = state.traffic
  const stage = stageOf(snapshot, prepare)
  const policy = policyOf(snapshot, prepare)
  const cards = stepCards(snapshot, policy)
  const manual = state.traffic.logs.find(entry => entry.key === 'manual' || entry.key === 'rollback' || entry.key === 'gateFail')?.key === 'manual'
  const alerting = breachOf(snapshot, state.traffic.alert)
  const verdict = verdictOf(stage, cards, manual, alerting)
  const judgement = stage === 'stabilizing' ? snapshot?.health ?? state.traffic.alert ?? null : null
  const stabilizeLeft = stage === 'stabilizing' ? snapshot?.stabilize_left_seconds ?? null : null
  // 목업 시뮬레이터는 백엔드별 지표를 보낸다(플랫폼은 보내지 않는다: 실제 모드는 중계 서버 실측값을 쓴다).
  const originBackend = snapshot?.backends?.origin
  const originMetrics = originBackend ? {
    requests: originBackend.requests_per_sec, failed: originBackend.failed_requests, rps: originBackend.requests_per_sec, p99_ms: originBackend.p99_ms,
    error_rate: originBackend.requests_per_sec > 0 ? originBackend.failed_requests / originBackend.requests_per_sec : null,
  } : null
  const failed = snapshot?.gate.failed_requests ?? 0
  const p99Ratio = snapshot?.gate.p99_ratio ?? 1
  const observeLeft = snapshot?.gate.observe_left_seconds ?? 0
  const weights = snapshot?.weights ?? { origin: 100, target: 0 }
  const residual = { requests: snapshot?.residual.requests_per_sec ?? 0, streams: snapshot?.residual.streams ?? 0 }
  const lagMs = snapshot?.replication?.lag_ms ?? state.traffic.ready?.lag_ms ?? state.data.current?.lag_ms ?? null
  const drained = stage === 'drained'
  // 실제 순서(DB 전환을 먼저 함)면 트래픽 다음은 완료 리포트(FlowApp: cutover 화면이 cutoverEntry로 리포트를 연다).
  const dbFirst = state.cutover.dbFirst
  useVoiceActions({ next: drained && onNext, rollback: can('traffic.rollback') && stage !== 'rolledback' && stage !== 'prepare' && stage !== 'blocked' && (() => provider.rollbackTraffic()), inject: mode === 'mock' && (stage === 'observing' || stage === 'applying' || stage === 'stabilizing') && (() => provider.injectFailure()), retry: can('traffic.retry') && stage === 'rolledback' && (() => provider.retryTraffic()) })
  const failedBad = failed > policy.maxFailed
  const p99Bad = p99Ratio > policy.maxP99Ratio
  const origin = prepare?.origin?.name ?? t('traffic.card.originFallback')
  const targetApp = prepare?.target?.name ?? t('traffic.card.targetFallback')
  const t0 = startedAt ? Date.parse(startedAt) : 0
  const logs = state.traffic.logs.map(entry => ({
    ...entry,
    since: t0 ? sec(Math.max(0, (Date.parse(entry.at) - t0) / 1000)) : '',
    tone: LOG_TONE[entry.key] ?? 'ok',
    activity: entry.activity ?? DEFAULT_ACTIVITY[entry.key],
  }))
  const lastLog = logs[logs.length - 1]
  const [logOpen, setLogOpen] = useState(false)
  const activeCard = cards.find(card => card.state === 'applying' || card.state === 'observing' || card.state === 'gate')
  const verdictParams = {
    step: verdict.step ?? '', failed, ratio: p99Ratio.toFixed(2), maxFailed: policy.maxFailed, maxRatio: policy.maxP99Ratio,
    origin: weights.origin, target: weights.target, reason: prepare?.reason ?? '', sec: policy.observeSeconds,
    endpoint: prepare?.target?.external_endpoint ?? '', requests: residual.requests, streams: residual.streams,
    left: stabilizeLeft === null ? '' : Math.ceil(stabilizeLeft),
  }
  const decisionCode = verdict.key === 'advance' ? 'advance' : verdict.key === 'rollback' || verdict.key === 'manual' ? 'rollback' : verdict.key === 'done' || verdict.key === 'drained' ? 'done' : verdict.key === 'stabilizingAlert' ? 'alert' : null
  const gateScope = stage === 'prepare' || stage === 'blocked' ? t('traffic.gate.scopePrepare')
    : stage === 'complete' || stage === 'drained' ? t('traffic.gate.scopeDone')
    : stage === 'stabilizing' ? t('traffic.gate.scopeStabilizing')
    : stage === 'rolledback' ? t('traffic.gate.scopeRolledback', { step: verdict.step ?? '' })
    : t('traffic.gate.scopeStep', { step: activeCard?.step ?? '', sec: policy.observeSeconds })

  return <div className="traffic-layout">
    <ol className="traffic-cards" aria-label={t('traffic.stepsAria')}>
      {cards.map(card => <li key={card.step} className={'traffic-card is-' + card.state} data-state={card.state}>
        <span className="traffic-card-w">{card.step}%</span>
        <span className="traffic-card-ratio">{t('traffic.card.ratio', { origin, target: targetApp, o: 100 - card.step, t: card.step })}</span>
        <span className="traffic-chip">{t(('traffic.chip.' + card.state) as MsgKey)}</span>
        <span className="traffic-card-m">{cardMetrics(t, card.state, card.failed, card.p99Ratio, policy.maxFailed, policy.maxP99Ratio)}</span>
        <span className="traffic-card-obs" style={{ transform: `scaleX(${card.observe})` }} aria-hidden="true" />
      </li>)}
    </ol>

    <div className="traffic-main">
      <section className="traffic-path" aria-label={t('traffic.visualAria')}>
        <TrafficCanvas target={target} stage={stage} snapshot={snapshot} prepare={prepare} lagMs={lagMs} />
      </section>

      <aside className="traffic-side" aria-label={t('traffic.gates.aria')}>
        <TrafficHealthPanel judgement={judgement} leftSeconds={stabilizeLeft} alerting={alerting} live={mode !== 'mock'} origin={originMetrics} />
        <section className="traffic-panel traffic-gatepanel">
          <h2>{t('traffic.gates.title')} <ProposalTag /> <small>{gateScope}</small></h2>
          <div className={'traffic-row' + (failedBad ? ' is-bad' : '')}>
            <span>{t('traffic.gate.failed')}</span><b>{t('traffic.unit.count', { n: failed })}</b><i>{t('traffic.gate.failedAllow', { n: policy.maxFailed })}</i>
          </div>
          <div className={'traffic-row' + (p99Bad ? ' is-bad' : '')}>
            <span>{t('traffic.gate.p99')}</span><b>{t('traffic.unit.times', { n: p99Ratio.toFixed(2) })}</b><i>{t('traffic.gate.p99Allow', { n: policy.maxP99Ratio })}</i>
          </div>
          <GateTrace trace={trace} max={policy.maxP99Ratio} maxLabel={t('traffic.trace.max', { n: policy.maxP99Ratio })} baseLabel={t('traffic.trace.base')} />
          <div className="traffic-row">
            <span>{t('traffic.gate.left')}</span><b>{stage === 'observing' ? t('traffic.unit.sec', { n: sec(observeLeft) }) : '—'}</b><i>{t('traffic.gate.windowNote', { n: policy.observeSeconds })}</i>
          </div>
          <div className={'traffic-verdict is-' + verdict.tone} aria-live="polite">
            {decisionCode && <code>{decisionCode}</code>}
            <span>{t(orderKey(('traffic.verdict.' + verdict.key) as MsgKey, dbFirst), verdictParams)}</span>
            {(stage === 'prepare' || stage === 'blocked') && prepare && <ul className="traffic-checks">
              {prepare.checks.map(check => <li key={check.id} className={'is-' + check.state}>
                <span>{tOr('traffic.prepare.check.' + check.id, check.id)}</span>
                {check.value && <code>{check.value}</code>}
              </li>)}
            </ul>}
          </div>
        </section>

        {/* 실행 기록은 접어 두고, 접힌 상태에서는 가장 최근 항목 한 줄만 보여 준다(한 화면에 정보가 많아서). */}
        <details className="traffic-panel traffic-log" open={logOpen} onToggle={event => setLogOpen(event.currentTarget.open)}>
          <summary>
            <h2>{t('traffic.feed.title')} <small>{lastLog ? t(('traffic.log.' + lastLog.key) as MsgKey, lastLog.params) : t('traffic.feed.sub')}</small></h2>
          </summary>
          <div className="traffic-log-items" tabIndex={0} aria-live="polite">
            {logs.length === 0
              ? <p>{t('traffic.feed.empty')}</p>
              : logs.map(entry => <div className={'traffic-log-item is-' + entry.tone} key={entry.id}>
                  <span className="traffic-log-t">{entry.since ? t('traffic.feed.since', { n: entry.since }) : ''}</span>
                  <span>
                    {entry.activity && <code>{entry.activity}</code>}
                    <strong>{t(('traffic.log.' + entry.key) as MsgKey, entry.params)}</strong>
                    <em>{t(('traffic.log.' + entry.key + 'Detail') as MsgKey, entry.params)}</em>
                  </span>
                </div>)}
          </div>
        </details>
      </aside>
    </div>

    <div className="flow-footer flow-footer-wide traffic-foot">
      <div className="traffic-lane-slot">
        {/* 두 갈래 진행 띠(앱 트래픽 · DB, 게이트 0/1/2) */}
        <MigrationLanes stage="traffic" />
        <span className="traffic-foot-note">{stage === 'stabilizing' ? t(alerting ? 'traffic.foot.stabilizingAlert' : 'traffic.foot.stabilizing') : stage === 'rolledback' ? t('traffic.foot.rolledback') : drained ? t(orderKey('traffic.foot.done', dbFirst)) : stage === 'complete' ? t(orderKey('traffic.foot.draining', dbFirst), verdictParams) : t('traffic.foot.default')}</span>
      </div>
      <div className="traffic-actions">
        {/* 실제 모드: 롤백·재시도 API가 아직 없으면 버튼을 숨긴다(capabilities.ts). */}
        {can('traffic.rollback') && <button type="button" className={'flow-secondary' + (alerting ? ' traffic-urgent' : '')} onClick={() => provider.rollbackTraffic()} disabled={stage === 'rolledback' || stage === 'prepare' || stage === 'blocked'}>{t('traffic.btn.rollback')}</button>}
        {mode === 'mock' && <button type="button" className="flow-secondary" onClick={() => provider.injectFailure()} disabled={stage !== 'observing' && stage !== 'applying' && stage !== 'stabilizing'}>{t('traffic.btn.inject')}</button>}
        {stage === 'stabilizing' && can('traffic.finalize') && <button type="button" className="flow-secondary" onClick={() => provider.finalizeTraffic()} disabled={alerting}>{t('traffic.btn.finalize')}</button>}
        {stage === 'rolledback' && can('traffic.retry') && <button type="button" className="flow-secondary" onClick={() => provider.retryTraffic()}>{t('traffic.btn.retry')}</button>}
        <button type="button" className="flow-primary" disabled={!drained} onClick={onNext}>{t(orderKey('traffic.btn.go', dbFirst))} <span aria-hidden="true">→</span></button>
      </div>
    </div>
  </div>
}

function cardMetrics(t: ReturnType<typeof useT>, state: CardState, failed: number | null, ratio: number | null, maxFailed: number, maxRatio: number) {
  if (failed === null || ratio === null) return t(state === 'wait' ? 'traffic.card.notYet' : state === 'pass' ? 'traffic.card.passed' : 'traffic.card.applying')
  return t('traffic.card.metrics', { failed, maxFailed, ratio: ratio.toFixed(2), maxRatio })
}

/** 관찰 중 p99 비율의 추이. 점선은 한도, 옅은 선은 원본(1.0×). 한도를 넘은 구간은 빨간색. */
function GateTrace({ trace, max, maxLabel, baseLabel }: { trace: number[]; max: number; maxLabel: string; baseLabel: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const cx = canvas?.getContext('2d')
    if (!canvas || !cx) return
    const draw = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.max(1, canvas.clientWidth)
      const h = Math.max(1, canvas.clientHeight)
      canvas.width = Math.round(w * ratio)
      canvas.height = Math.round(h * ratio)
      cx.setTransform(ratio, 0, 0, ratio, 0, 0)
      cx.clearRect(0, 0, w, h)
      const top = Math.max(max * 1.15, ...trace.map(v => v * 1.05), 1.2)
      const lo = 0.8
      const Y = (v: number) => h - 6 - (v - lo) / (top - lo) * (h - 14)
      const font = getComputedStyle(canvas).fontFamily
      cx.font = '11px ' + font
      cx.textAlign = 'right'
      cx.strokeStyle = '#e6e6e6'; cx.lineWidth = 1; cx.setLineDash([])
      cx.beginPath(); cx.moveTo(0, Y(1)); cx.lineTo(w, Y(1)); cx.stroke()
      cx.fillStyle = '#9a9a9a'; cx.fillText(baseLabel, w - 2, Y(1) - 4)
      cx.strokeStyle = '#c4242a'; cx.setLineDash([5, 5]); cx.lineWidth = 1.3
      cx.beginPath(); cx.moveTo(0, Y(max)); cx.lineTo(w, Y(max)); cx.stroke(); cx.setLineDash([])
      cx.fillStyle = '#a8443f'; cx.fillText(maxLabel, w - 2, Y(max) - 4)
      const n = Math.max(trace.length, 40)
      for (let i = 1; i < trace.length; i++) {
        cx.strokeStyle = trace[i] > max ? '#c4242a' : `rgba(10,10,10,${0.2 + 0.8 * i / trace.length})`
        cx.lineWidth = 2
        cx.beginPath(); cx.moveTo((i - 1) / (n - 1) * w, Y(trace[i - 1])); cx.lineTo(i / (n - 1) * w, Y(trace[i])); cx.stroke()
      }
      const lastValue = trace[trace.length - 1]
      if (lastValue !== undefined) {
        cx.fillStyle = lastValue > max ? '#c4242a' : '#0a0a0a'
        cx.beginPath(); cx.arc((trace.length - 1) / (n - 1) * w, Y(lastValue), 3, 0, Math.PI * 2); cx.fill()
      }
    }
    draw()
    const observer = new ResizeObserver(draw)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [trace, max, maxLabel, baseLabel])
  return <canvas ref={ref} className="traffic-trace" aria-hidden="true" />
}
