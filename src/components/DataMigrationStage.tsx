'use client'

import StageShell from './StageShell'
import ReplicationDiagram from './ReplicationDiagram'
import { useI18n, type MsgKey } from '../lib/i18n'
import type { Target } from '../lib/stages'
import type { DataStep } from '../lib/migration/events'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'
import { DATA_TOTAL_ROWS } from '../lib/migration/script'

type Phase = DataStep

const STEPS: Array<{ id: Phase }> = [{ id: 'connect' }, { id: 'dump' }, { id: 'cdc' }, { id: 'ready' }]

const POINTS = 48

export default function DataMigrationStage({ target, onNext }: { target: Target; onNext: () => void }) {
  const { t } = useI18n()
  return <StageShell kicker="DATA REPLICATION" title={t('data.title')}
    subtitle={t('data.subtitle')}>
    {ready => <DataBody ready={ready} target={target} onNext={onNext} />}
  </StageShell>
}

function DataBody({ ready, target, onNext }: { ready: boolean; target: Target; onNext: () => void }) {
  const { t, lang } = useI18n()
  const locale = lang === 'ko' ? 'ko-KR' : lang === 'ja' ? 'ja-JP' : 'en-US'
  // 복제 진행 값은 data.progress 이벤트로 받는다(시작 전에는 연결 단계의 0 값).
  const { state } = useMigration()
  useStageFeed('data_copy', ready, target)
  const progress = state.data.current
  const history = state.data.lagHistory
  const phase: Phase = progress?.step ?? 'connect'
  const ready2 = phase === 'ready'
  const phaseIndex = STEPS.findIndex(step => step.id === phase)
  const totalRows = progress?.total_rows ?? DATA_TOTAL_ROWS
  const rows = progress?.rows ?? 0
  const lag = progress?.lag_ms ?? null
  const dump = (progress?.dump_percent ?? 0) / 100
  const writesPerSec = progress?.writes_per_sec ?? 118

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
        <div><small>{t('data.rows')}</small><strong>{rows.toLocaleString(locale)}</strong><em>/ {totalRows.toLocaleString(locale)}+</em></div>
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
