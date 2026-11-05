'use client'

import StageShell from './StageShell'
import ProposalTag from './ProposalTag'
import LiveRequests from './LiveRequests'
import TrafficCanvas from './TrafficCanvas'
import PhaseStrip, { STRIP_GATE } from './PhaseStrip'
import type { Target } from '../lib/stages'
import { useT, type MsgKey } from '../lib/i18n'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'
import { OBSERVE_SECONDS, TRAFFIC_STEPS, stepIndexOf } from '../lib/migration/trafficSim'
import type { TrafficPhase } from '../lib/migration/events'

// 기준값의 기본값(서버가 snapshot의 gate에 실어 보내면 그 값을 쓴다)
const MAX_FAILED = 0
const MAX_P99_RATIO = 1.5

type Phase = TrafficPhase
type Tone = 'ok' | 'warn' | 'fail'

// 트래픽 피드 기록의 종류별 색. 문구는 traffic.log.<key> / traffic.log.<key>Detail
const LOG_TONE: Record<string, Tone> = { apply: 'ok', gatePass: 'ok', gateFail: 'fail', reached: 'warn', manual: 'warn', inject: 'warn', drained: 'ok' }

export default function TrafficShiftStage({ target, onNext }: { target: Target; onNext: () => void }) {
  const t = useT()
  return <StageShell kicker="TRAFFIC SHIFT" title={t('traffic.title')}
    subtitle={t('traffic.subtitle')}>
    {ready => <TrafficBody ready={ready} target={target} onNext={onNext} />}
  </StageShell>
}

function clock(at: string) {
  return new Date(at).toLocaleTimeString('en-GB')
}

function TrafficBody({ ready, target, onNext }: { ready: boolean; target: Target; onNext: () => void }) {
  const t = useT()
  const { state, mode, provider } = useMigration()
  // 가중치·관찰 지표·게이트 판정은 traffic.snapshot 이벤트로 받는다(시작 전에는 10% 적용 대기 상태).
  useStageFeed('traffic', ready, target)
  const snapshot = state.traffic.snapshot
  const phase: Phase = snapshot?.phase ?? 'applying'
  // 단계는 서버가 보낸 값(예: 50 → 100)을 쓰고, 없으면 기본 단계(10 · 50 · 100)다.
  const STEPS: readonly number[] = snapshot?.steps?.length ? snapshot.steps : TRAFFIC_STEPS
  const stepIndex = stepIndexOf(STEPS, snapshot?.step)
  const weightNew = snapshot?.weights.target ?? 0
  const observeLeft = snapshot?.gate.observe_left_seconds ?? 0
  const metrics = { failed: snapshot?.gate.failed_requests ?? 0, p99Ratio: snapshot?.gate.p99_ratio ?? 1 }
  const maxFailed = snapshot?.gate.max_failed_requests ?? MAX_FAILED
  const maxP99Ratio = snapshot?.gate.max_p99_ratio ?? MAX_P99_RATIO
  const residual = { requests: snapshot?.residual.requests_per_sec ?? 0, streams: snapshot?.residual.streams ?? 0 }
  const logs = state.traffic.logs.map(entry => ({
    id: entry.id, time: clock(entry.at), tone: LOG_TONE[entry.key] ?? 'ok', params: entry.params,
    title: ('traffic.log.' + entry.key) as MsgKey, detail: ('traffic.log.' + entry.key + 'Detail') as MsgKey,
  }))
  const targetName = t(('target.' + target) as MsgKey)

  const drained = phase === 'complete' && residual.requests === 0 && residual.streams === 0

  const rollback = () => provider.rollbackTraffic()
  const restart = () => provider.retryTraffic()
  const injectFailure = () => provider.injectFailure()

  const statusText = {
    applying: t('traffic.status.applying'),
    observing: t('traffic.status.observing', { n: observeLeft }),
    gate: t('traffic.status.gate'),
    complete: drained ? t('traffic.status.drained') : t('traffic.status.complete'),
    rolledback: t('traffic.status.rolledback'),
  }[phase]

  const failedBad = metrics.failed > maxFailed
  const p99Bad = metrics.p99Ratio > maxP99Ratio

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
        {state.traffic.ready && <div className="traffic-gate">
          <span>{t('traffic.ready.title')}</span>
          <b>{state.traffic.ready.state === 'done' ? t('traffic.ready.done') : t('traffic.ready.running')}</b>
          <small>{t('traffic.ready.detail', { lag: state.traffic.ready.lag_ms, tx: state.traffic.ready.longest_tx_ms, commits: state.traffic.ready.commits_per_sec })}</small>
        </div>}
        <div className={'traffic-gate' + (failedBad ? ' is-bad' : '')}>
          <span>{t('traffic.gate.failed')}</span><b>{t('traffic.unit.count', { n: metrics.failed })}</b><small>{t('traffic.gate.failedAllow', { n: maxFailed })}</small>
        </div>
        <div className={'traffic-gate' + (p99Bad ? ' is-bad' : '')}>
          <span>{t('traffic.gate.p99')}</span><b>{t('traffic.unit.times', { n: metrics.p99Ratio.toFixed(2) })}</b><small>{t('traffic.gate.p99Allow', { n: maxP99Ratio })}</small>
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
        <div className="analysis-discovery-items" tabIndex={0} aria-live="polite">
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

    {/* 데이터 → 트래픽 → DB 전환 띠: 지금은 게이트 1과 2 사이(대상 비율만큼) */}
    <div className="flow-strip"><PhaseStrip compact position={STRIP_GATE.synced + (weightNew / 100) * (STRIP_GATE.switchover - STRIP_GATE.synced)} gates={['pass', 'pass', drained ? 'pass' : 'wait']} /></div>

    <div className="flow-footer flow-footer-wide traffic-actions">
      <div className="traffic-actions-left">
        <button type="button" className="flow-secondary" onClick={rollback} disabled={phase === 'rolledback'}>{t('traffic.btn.rollback')}</button>
        {mode === 'mock' && <button type="button" className="flow-secondary" onClick={injectFailure} disabled={phase !== 'observing' && phase !== 'applying'}>{t('traffic.btn.inject')}</button>}
        {phase === 'rolledback' && <button type="button" className="flow-secondary" onClick={restart}>{t('traffic.btn.retry')}</button>}
      </div>
      <span>{phase === 'rolledback' ? t('traffic.foot.rolledback') : drained ? t('traffic.foot.done') : t('traffic.foot.default')}</span>
      <button type="button" className="flow-primary" disabled={!drained} onClick={onNext}>{t('traffic.btn.go')} <span aria-hidden="true">→</span></button>
    </div>
  </div>
}
