'use client'

import { useEffect, useState } from 'react'
import StageShell from './StageShell'
import ReplicationDiagram from './ReplicationDiagram'
import { useI18n, type MsgKey } from '../lib/i18n'

type Phase = 'connect' | 'dump' | 'cdc' | 'ready'

const STEPS: Array<{ id: Phase }> = [{ id: 'connect' }, { id: 'dump' }, { id: 'cdc' }, { id: 'ready' }]

const TOTAL_ROWS = 128400
const POINTS = 48

function lagAt(seconds: number): number | null {
  if (seconds < 5) return null
  const base = 2200 * Math.exp(-(seconds - 5) * 0.62)
  const wobble = Math.sin(seconds * 3.1) * 24 + Math.cos(seconds * 1.7) * 14
  return Math.max(0, Math.round(base + wobble * Math.min(1, base / 200)))
}

export default function DataMigrationStage({ onNext }: { onNext: () => void }) {
  const { t } = useI18n()
  return <StageShell kicker="DATA REPLICATION" title={t('data.title')}
    subtitle={t('data.subtitle')}>
    {ready => <DataBody ready={ready} onNext={onNext} />}
  </StageShell>
}

function DataBody({ ready, onNext }: { ready: boolean; onNext: () => void }) {
  const { t, lang } = useI18n()
  const locale = lang === 'ko' ? 'ko-KR' : lang === 'ja' ? 'ja-JP' : 'en-US'
  const [seconds, setSeconds] = useState(0)
  const [history, setHistory] = useState<number[]>([])

  useEffect(() => {
    if (!ready) return
    const began = performance.now()
    const timer = window.setInterval(() => {
      const elapsed = (performance.now() - began) / 1000
      setSeconds(elapsed)
      const lag = lagAt(elapsed)
      if (lag !== null) setHistory(current => [...current.slice(-(POINTS - 1)), lag])
    }, 250)
    return () => window.clearInterval(timer)
  }, [ready])

  const dump = Math.max(0, Math.min(1, (seconds - 1.6) / 3.2))
  const changes = seconds < 5 ? 0 : Math.round((seconds - 5) * 340)
  const rows = Math.round(dump * TOTAL_ROWS) + changes
  const lag = lagAt(seconds)
  const phase: Phase = seconds < 1.6 ? 'connect' : seconds < 5 ? 'dump' : lag !== null && lag > 40 ? 'cdc' : 'ready'
  const ready2 = phase === 'ready' && seconds > 9.5
  const phaseIndex = STEPS.findIndex(step => step.id === phase)
  const writesPerSec = 118 + Math.round(Math.sin(seconds * 1.3) * 14)

  const max = Math.max(2400, ...history)
  const path = history.map((value, index) => {
    const x = (index / (POINTS - 1)) * 100
    const y = 100 - (value / max) * 92 - 4
    return (index === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2)
  }).join(' ')

  return <div className="flow-split flow-split-wide">
    <section className="flow-list" aria-label={t('data.stepsAria')}>
      {STEPS.map((step, index) => {
        const state = index < phaseIndex || (step.id === 'ready' && ready2) ? 'done' : index === phaseIndex ? 'running' : ''
        return <article key={step.id} className={'flow-check' + (state ? ' is-' + state : '')}>
          <span className="flow-check-mark" aria-hidden="true">{state === 'done' ? '✓' : state === 'running' ? '' : String(index + 1).padStart(2, '0')}</span>
          <div>
            <strong>{t(('data.step.' + step.id + '.title') as MsgKey)}</strong>
            <p>{t(('data.step.' + step.id + '.detail') as MsgKey)}</p>
          </div>
          <small>{state === 'done' ? t('data.state.done') : state === 'running' ? t('data.state.running') : t('data.state.wait')}</small>
        </article>
      })}
      <p className="flow-note">{t('data.note')}</p>
    </section>

    <aside className="flow-panel" aria-label={t('data.statusAria')}>
      <ReplicationDiagram phase={phase} done={ready2} />
      <div className="flow-metrics">
        <div><small>{t('data.rows')}</small><strong>{rows.toLocaleString(locale)}</strong><em>/ {TOTAL_ROWS.toLocaleString(locale)}+</em></div>
        <div><small>{t('data.lag')}</small><strong>{lag === null ? '—' : lag.toLocaleString(locale) + ' ms'}</strong><em>{lag === null ? t('data.lagWait') : lag <= 40 ? t('data.lagZero') : t('data.lagDown')}</em></div>
        <div><small>{t('data.writes')}</small><strong>{writesPerSec}/s</strong><em>{t('data.writesOk')}</em></div>
      </div>
      <div className="flow-chart" role="img" aria-label={t('data.chartAria')}>
        <span className="flow-chart-label">{t('data.chartLabel')}</span>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none">
          <line x1="0" y1="96" x2="100" y2="96" className="flow-chart-axis" />
          {path && <path d={path} className="flow-chart-line" vectorEffect="non-scaling-stroke" />}
        </svg>
        <span className="flow-chart-empty">{history.length === 0 ? t('data.chartEmpty') : ''}</span>
      </div>
      <div className="flow-progress-row">
        <span>{t('data.dump')}</span>
        <div className="analysis-progress"><span style={{ width: Math.round(dump * 100) + '%' }} /></div>
        <b>{Math.round(dump * 100)}%</b>
      </div>
    </aside>

    <div className="flow-footer">
      <span>{ready2 ? t('data.footDone') : t('data.footRun')}</span>
      <button type="button" className="flow-primary" disabled={!ready2} onClick={onNext}>{t('data.go')} <span aria-hidden="true">→</span></button>
    </div>
  </div>
}
