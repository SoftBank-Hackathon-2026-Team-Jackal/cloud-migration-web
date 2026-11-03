'use client'

import { useI18n, type MsgKey, type Translate } from '../lib/i18n'
import type { Target } from '../lib/stages'
import { useState } from 'react'
import ProposalTag from './ProposalTag'
import { aiFixCount } from '../lib/demoConfig'
import StabilityMonitor from './StabilityMonitor'
import { ViewTabs } from './DiagramParts'

/** 단계별 소요 시간(데모 값). 실제 연결 시 백엔드 이벤트의 시작·종료 시각으로 바꾼다. */
const STAGES: Array<{ id: string; seconds: number }> = [
  { id: 'analysis', seconds: 42 },
  { id: 'rehearsal', seconds: 18 },
  { id: 'planning', seconds: 9 },
  { id: 'approval', seconds: 30 },
  { id: 'provisioning', seconds: 130 },
  { id: 'data', seconds: 275 },
  { id: 'traffic', seconds: 80 },
  { id: 'cutover', seconds: 12 },
]

const RESULTS = ['pause', 'fail', 'delay', 'loss', 'gate', 'ai'] as const

function clock(seconds: number) {
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
}

type Report = {
  generatedAt: string
  language: string
  demo: true
  title: string
  summary: string
  stages: Array<{ id: string; label: string; note: string; duration: string }>
  total: string
  results: Array<{ label: string; value: string }>
  notes: Array<{ label: string; value: string }>
  demoNote: string
}

function buildReport(t: Translate, target: Target, language: string): Report {
  const targetName = t(('target.' + target) as MsgKey)
  const stages = STAGES.map(stage => ({
    id: stage.id,
    label: t(('rail.' + stage.id) as MsgKey),
    note: t(('report.stage.' + stage.id) as MsgKey, { target: targetName, n: aiFixCount() }),
    duration: clock(stage.seconds),
  }))
  return {
    generatedAt: new Date().toISOString(),
    language,
    demo: true,
    title: t('report.title'),
    summary: t('cutover.done.lead', { target: targetName }),
    stages,
    total: clock(STAGES.reduce((sum, stage) => sum + stage.seconds, 0)),
    results: RESULTS.map(id => ({ label: t(('report.res.' + id) as MsgKey), value: t(('report.res.' + id + 'Val') as MsgKey, { n: aiFixCount() }) })),
    notes: [
      { label: t('cutover.done.traffic'), value: t(target === 'onprem' ? 'cutover.done.trafficOnprem' : 'cutover.done.trafficGcp') },
      { label: t('cutover.done.rollback'), value: t('cutover.done.rollbackVal') + ' (' + t('tag.proposal') + ')' },
      { label: t('cutover.done.old'), value: t('cutover.done.oldVal') },
      { label: t('approval.excluded'), value: t('approval.ex1') + ' · ' + t('approval.ex2') },
    ],
    demoNote: t('report.demoNote'),
  }
}

function toMarkdown(report: Report) {
  const lines = [
    '# ' + report.title,
    '',
    report.summary,
    '',
    '> ' + report.demoNote,
    '',
    '## ' + report.stages.length + ' / ' + report.total,
    '',
    '| | | |',
    '|---|---|---|',
    ...report.stages.map(stage => '| ' + stage.label + ' | ' + stage.note + ' | ' + stage.duration + ' |'),
    '',
    '## Results',
    '',
    ...report.results.map(item => '- **' + item.label + '**: ' + item.value),
    '',
    '## Notes',
    '',
    ...report.notes.map(item => '- **' + item.label + '**: ' + item.value),
    '',
    '_' + report.generatedAt + '_',
    '',
  ]
  return lines.join('\n')
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 전환이 끝난 뒤 한눈에 보는 이전 리포트. 타임라인·측정 결과·남은 것을 보여 주고 JSON·Markdown으로 내보낼 수 있다. */
export default function MigrationReport({ target, onRestart }: { target: Target; onRestart: () => void }) {
  const { t, lang } = useI18n()
  const report = buildReport(t, target, lang)
  const [tab, setTab] = useState<'report' | 'monitor'>('report')
  const stamp = 'migration-report-' + target
  return <div className="flow-center">
    <section className="report-panel" aria-label={t('report.title')}>
      <header className="report-head">
        <span className="cutover-done-mark" aria-hidden="true">✓</span>
        <div>
          <h2>{t('cutover.done.title')}</h2>
          <p className="approval-lead">{report.summary}</p>
        </div>
        <small className="flow-pill">DEMO</small>
      </header>

      <div className="report-tabs">
        <ViewTabs label={t('tab.aria')} value={tab} onChange={setTab}
          items={[{ id: 'report', label: t('tab.report') }, { id: 'monitor', label: t('tab.monitor') }]} />
      </div>

      {/* 두 탭을 같은 칸에 겹쳐 두고 안 보이는 쪽은 숨긴다: 탭을 바꿔도 패널 높이가 변하지 않는다. */}
      <div className="report-body">
      <div className={'report-pane' + (tab === 'monitor' ? ' is-inactive' : '')} aria-hidden={tab === 'monitor'}><div className="report-grid">
        <div>
          <h3>{t('report.timeline')}</h3>
          <ol className="report-timeline">
            {report.stages.map(stage => <li key={stage.id}>
              <span className="report-dot" aria-hidden="true" />
              <div><strong>{stage.label}</strong><p>{stage.note}</p></div>
              <time>{stage.duration}</time>
            </li>)}
          </ol>
          <p className="report-total"><span>{t('report.total')}</span><b>{report.total}</b></p>
        </div>

        <div>
          <h3>{t('report.results')}</h3>
          <div className="report-results">
            {report.results.map(item => <div key={item.label}><small>{item.label}</small><strong>{item.value}</strong></div>)}
          </div>
          <h3>{t('report.notes')}</h3>
          <dl className="approval-rows report-notes">
            {report.notes.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}{item.label === t('cutover.done.rollback') && <> <ProposalTag /></>}</dd></div>)}
          </dl>
        </div>
      </div></div>
      <div className={'report-pane' + (tab === 'report' ? ' is-inactive' : '')} aria-hidden={tab === 'report'}><StabilityMonitor /></div>
      </div>

      <footer className="report-actions">
        <span>{t('report.exportHint')}</span>
        <button type="button" className="flow-secondary" onClick={() => download(stamp + '.json', JSON.stringify(report, null, 2), 'application/json')}>{t('report.exportJson')}</button>
        <button type="button" className="flow-secondary" onClick={() => download(stamp + '.md', toMarkdown(report), 'text/markdown')}>{t('report.exportMd')}</button>
        <button type="button" className="flow-secondary" onClick={onRestart}>{t('cutover.done.restart')}</button>
      </footer>
    </section>
  </div>
}
