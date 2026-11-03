'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import StageShell from './StageShell'
import ProposalTag from './ProposalTag'
import LiveRequests from './LiveRequests'
import TrafficCanvas from './TrafficCanvas'
import type { Target } from '../lib/stages'
import { useT, type MsgKey, type Params } from '../lib/i18n'

const STEPS = [10, 50, 100] as const
const OBSERVE_SECONDS = 4
const MAX_FAILED = 0
const MAX_P99_RATIO = 1.5

type Phase = 'applying' | 'observing' | 'gate' | 'complete' | 'rolledback'
type Tone = 'ok' | 'warn' | 'fail'
type TrafficLog = { id: number; time: string; title: MsgKey; detail: MsgKey; params: Params; tone: Tone }
type Metrics = { failed: number; p99Ratio: number }

export default function TrafficShiftStage({ target, onNext }: { target: Target; onNext: () => void }) {
  const t = useT()
  return <StageShell kicker="TRAFFIC SHIFT" title={t('traffic.title')}
    subtitle={t('traffic.subtitle')}>
    {ready => <TrafficBody ready={ready} target={target} onNext={onNext} />}
  </StageShell>
}

function clock() {
  return new Date().toLocaleTimeString('en-GB')
}

function TrafficBody({ ready, target, onNext }: { ready: boolean; target: Target; onNext: () => void }) {
  const t = useT()
  const [stepIndex, setStepIndex] = useState(0)
  const [phase, setPhase] = useState<Phase>('applying')
  const [weightNew, setWeightNew] = useState(0)
  const [observeLeft, setObserveLeft] = useState(0)
  const [metrics, setMetrics] = useState<Metrics>({ failed: 0, p99Ratio: 1 })
  const [logs, setLogs] = useState<TrafficLog[]>([])
  const [residual, setResidual] = useState({ requests: 0, streams: 0 })
  const metricsRef = useRef<Metrics>(metrics)
  const injectRef = useRef(false)
  const counter = useRef(0)
  const targetName = t(('target.' + target) as MsgKey)

  const log = useCallback((title: MsgKey, detail: MsgKey, params: Params, tone: Tone) => {
    counter.current += 1
    const entry: TrafficLog = { id: counter.current, time: clock(), title, detail, params, tone }
    setLogs(current => [entry, ...current].slice(0, 30))
  }, [])

  const updateMetrics = useCallback((next: Metrics) => {
    metricsRef.current = next
    setMetrics(next)
  }, [])

  // 1. 가중치 적용
  useEffect(() => {
    if (!ready || phase !== 'applying') return
    const percent = STEPS[stepIndex]
    const apply = window.setTimeout(() => {
      setWeightNew(percent)
      log('traffic.log.apply', 'traffic.log.applyDetail', { pct: percent, old: 100 - percent, new: percent }, 'ok')
    }, 250)
    const observe = window.setTimeout(() => {
      updateMetrics({ failed: 0, p99Ratio: 1 })
      setObserveLeft(OBSERVE_SECONDS)
      setPhase('observing')
    }, 1300)
    return () => { window.clearTimeout(apply); window.clearTimeout(observe) }
  }, [ready, phase, stepIndex, log, updateMetrics])

  // 2. 관찰 창: 1초마다 지표 갱신, 실패 요청이 생기면 곧바로 게이트로
  useEffect(() => {
    if (phase !== 'observing') return
    const timer = window.setInterval(() => {
      const injected = injectRef.current
      const previous = metricsRef.current
      const next: Metrics = injected
        ? { failed: previous.failed + 3, p99Ratio: Math.min(2.4, previous.p99Ratio + 0.45) }
        : { failed: 0, p99Ratio: Number((1.03 + Math.abs(Math.sin(performance.now() / 700)) * 0.12).toFixed(2)) }
      updateMetrics(next)
      setObserveLeft(left => Math.max(0, left - 1))
      if (next.failed > MAX_FAILED) setPhase('gate')
    }, 1000)
    return () => window.clearInterval(timer)
  }, [phase, updateMetrics])

  useEffect(() => {
    if (phase === 'observing' && observeLeft <= 0) setPhase('gate')
  }, [phase, observeLeft])

  // 3. 게이트 판정
  useEffect(() => {
    if (phase !== 'gate') return
    const timer = window.setTimeout(() => {
      const current = metricsRef.current
      const percent = STEPS[stepIndex]
      if (current.failed > MAX_FAILED || current.p99Ratio > MAX_P99_RATIO) {
        injectRef.current = false
        setWeightNew(0)
        setPhase('rolledback')
        log('traffic.log.gateFail', 'traffic.log.gateFailDetail', { failed: current.failed, ratio: current.p99Ratio.toFixed(2), maxFailed: MAX_FAILED, maxRatio: MAX_P99_RATIO }, 'fail')
        return
      }
      log('traffic.log.gatePass', 'traffic.log.gatePassDetail', { pct: percent, ratio: current.p99Ratio.toFixed(2) }, 'ok')
      if (stepIndex === STEPS.length - 1) {
        setResidual({ requests: 38, streams: 14 })
        setPhase('complete')
        log('traffic.log.reached', 'traffic.log.reachedDetail', {}, 'warn')
      } else {
        setStepIndex(index => index + 1)
        setPhase('applying')
      }
    }, 700)
    return () => window.clearTimeout(timer)
  }, [phase, stepIndex, log])

  // 4. 100% 이후: 옛 환경에 남은 요청·열린 연결이 줄어드는지 확인
  useEffect(() => {
    if (phase !== 'complete') return
    const timer = window.setInterval(() => {
      setResidual(current => ({
        requests: Math.max(0, Math.floor(current.requests * 0.62) - (current.requests < 4 ? 1 : 0)),
        streams: current.requests < 12 ? Math.max(0, current.streams - 2) : current.streams,
      }))
    }, 500)
    return () => window.clearInterval(timer)
  }, [phase])

  const drained = phase === 'complete' && residual.requests === 0 && residual.streams === 0

  useEffect(() => {
    if (drained) log('traffic.log.drained', 'traffic.log.drainedDetail', {}, 'ok')
  }, [drained, log])

  const rollback = () => {
    injectRef.current = false
    setWeightNew(0)
    setPhase('rolledback')
    log('traffic.log.manual', 'traffic.log.manualDetail', {}, 'warn')
  }

  const restart = () => {
    injectRef.current = false
    setLogs([])
    setStepIndex(0)
    setWeightNew(0)
    updateMetrics({ failed: 0, p99Ratio: 1 })
    setPhase('applying')
  }

  const injectFailure = () => {
    injectRef.current = true
    log('traffic.log.inject', 'traffic.log.injectDetail', {}, 'warn')
  }

  const statusText = {
    applying: t('traffic.status.applying'),
    observing: t('traffic.status.observing', { n: observeLeft }),
    gate: t('traffic.status.gate'),
    complete: drained ? t('traffic.status.drained') : t('traffic.status.complete'),
    rolledback: t('traffic.status.rolledback'),
  }[phase]

  const failedBad = metrics.failed > MAX_FAILED
  const p99Bad = metrics.p99Ratio > MAX_P99_RATIO

  return <div className="flow-split traffic-split">
    <section className="traffic-visual" aria-label={t('traffic.visualAria')}>
      <ol className="traffic-steps" aria-label={t('traffic.stepsAria')}>
        {STEPS.map((percent, index) => {
          const done = phase === 'complete' || (phase !== 'rolledback' && index < stepIndex)
          const active = phase !== 'complete' && phase !== 'rolledback' && index === stepIndex
          return <li key={percent} className={done ? 'is-done' : active ? 'is-active' : ''}>
            <span>{done ? '✓' : percent + '%'}</span>
            <small>{done ? t('traffic.step.done') : active ? t('traffic.step.active') : t('traffic.step.wait')}</small>
          </li>
        })}
      </ol>

      <div className="traffic-stage-canvas">
        <TrafficCanvas weightNew={weightNew} />
        <div className="traffic-node" data-node="user" style={{ left: '9%', top: '50%' }}>
          <span className="traffic-orb">◎</span>
          <strong>{t('traffic.node.user')}</strong>
          <small>app.example.com</small>
        </div>
        <div className="traffic-node" data-node="relay" style={{ left: '40%', top: '50%' }}>
          <span className="traffic-orb">⇄</span>
          <strong>{t('traffic.node.relay')}</strong>
          <small>{t('traffic.node.relaySub')}</small>
        </div>
        <div className="traffic-node" data-node="old" style={{ left: '84%', top: '21%' }}>
          <span className="traffic-orb">◫</span>
          <strong>{t('traffic.node.old')}</strong>
          <small>ALB → EKS</small>
        </div>
        <div className="traffic-node" data-node="new" style={{ left: '84%', top: '79%' }}>
          <span className="traffic-orb">◫</span>
          <strong>{t('traffic.node.new', { target: targetName })}</strong>
          <small>{t(target === 'onprem' ? 'traffic.node.newOnprem' : 'traffic.node.newGcp')}</small>
        </div>
      </div>

      <div className="traffic-bar" role="img" aria-label={t('traffic.bar.aria', { old: 100 - weightNew, new: weightNew })}>
        <span className="traffic-bar-old" style={{ width: (100 - weightNew) + '%' }}>{100 - weightNew > 12 ? t('traffic.bar.old', { n: 100 - weightNew }) : ''}</span>
        <span className="traffic-bar-new" style={{ width: weightNew + '%' }}>{weightNew > 12 ? t('traffic.bar.new', { n: weightNew }) : ''}</span>
      </div>
      <LiveRequests weightNew={weightNew} failing={(phase === 'observing' || phase === 'gate') && metrics.failed > 0} />
      <p className="flow-note">
        {phase === 'complete'
          ? t(target === 'onprem' ? 'traffic.note.completeOnprem' : 'traffic.note.completeGcp')
          : t('traffic.note.default')}
      </p>
    </section>

    <aside className="traffic-side" aria-label={t('traffic.gates.aria')}>
      <div className="flow-panel traffic-gates">
        <div className="flow-panel-head">
          <strong>{t('traffic.gates.title')} <ProposalTag /></strong>
          <span className={'traffic-state is-' + phase}>{statusText}</span>
        </div>
        <div className={'traffic-gate' + (failedBad ? ' is-bad' : '')}>
          <span>{t('traffic.gate.failed')}</span><b>{t('traffic.unit.count', { n: metrics.failed })}</b><small>{t('traffic.gate.failedAllow', { n: MAX_FAILED })}</small>
        </div>
        <div className={'traffic-gate' + (p99Bad ? ' is-bad' : '')}>
          <span>{t('traffic.gate.p99')}</span><b>{t('traffic.unit.times', { n: metrics.p99Ratio.toFixed(2) })}</b><small>{t('traffic.gate.p99Allow', { n: MAX_P99_RATIO })}</small>
        </div>
        <div className="traffic-gate">
          <span>{t('traffic.gate.window')}</span><b>{phase === 'observing' ? t('traffic.unit.sec', { n: observeLeft }) : '—'}</b><small>{t('traffic.gate.windowNote', { n: OBSERVE_SECONDS })}</small>
        </div>
        {phase === 'complete' && <div className="traffic-residual">
          <span>{t('traffic.residual.requests')} <b>{residual.requests}/s</b></span>
          <span>{t('traffic.residual.streams')} <b>{residual.streams}</b></span>
        </div>}
      </div>

      <div className="analysis-discovery traffic-feed">
        <div className="analysis-discovery-title">
          <span className="analysis-live-dot" />
          <strong>{t('traffic.feed.title')}</strong>
          <small>DEMO</small>
        </div>
        <div className="analysis-discovery-items" aria-live="polite">
          {logs.length === 0
            ? <p>{t('traffic.feed.empty')}</p>
            : logs.map(entry => <div className={'analysis-discovery-item traffic-log is-' + entry.tone} key={entry.id}>
                <small>{entry.time}</small>
                <strong>{t(entry.title, { ...entry.params, target: targetName })}</strong>
                <em>{t(entry.detail, { ...entry.params, target: targetName })}</em>
              </div>)}
        </div>
      </div>
    </aside>

    <div className="flow-footer flow-footer-wide traffic-actions">
      <div className="traffic-actions-left">
        <button type="button" className="flow-secondary" onClick={rollback} disabled={phase === 'rolledback'}>{t('traffic.btn.rollback')}</button>
        <button type="button" className="flow-secondary" onClick={injectFailure} disabled={phase !== 'observing' && phase !== 'applying'}>{t('traffic.btn.inject')}</button>
        {phase === 'rolledback' && <button type="button" className="flow-secondary" onClick={restart}>{t('traffic.btn.retry')}</button>}
      </div>
      <span>{phase === 'rolledback' ? t('traffic.foot.rolledback') : drained ? t('traffic.foot.done') : t('traffic.foot.default')}</span>
      <button type="button" className="flow-primary" disabled={!drained} onClick={onNext}>{t('traffic.btn.go')} <span aria-hidden="true">→</span></button>
    </div>
  </div>
}
