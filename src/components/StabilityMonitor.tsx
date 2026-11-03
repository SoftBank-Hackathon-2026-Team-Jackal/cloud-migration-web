'use client'

import { useState } from 'react'
import { useT } from '../lib/i18n'

const POINTS = 48 // 24시간을 30분 간격으로 압축해 보여 준다(데모 값)

const residual = (i: number) => Math.round(38 * Math.exp(-i / 5))
const errorRate = (i: number) => Number((0.03 + Math.abs(Math.sin(i * 1.7)) * 0.04).toFixed(2))
const latency = (i: number) => Number((1.12 - Math.min(i, 12) * 0.006 + Math.sin(i / 2.5) * 0.03).toFixed(2))

function Spark({ values, max, className = '' }: { values: number[]; max: number; className?: string }) {
  const path = values.map((value, index) => (index === 0 ? 'M' : 'L') + ((index / (values.length - 1)) * 100).toFixed(1) + ' ' + (36 - (value / max) * 32).toFixed(1)).join(' ')
  return <svg className={'spark ' + className} viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" y1="38" x2="100" y2="38" className="flow-chart-axis" />
    <path d={path} className="flow-chart-line" vectorEffect="non-scaling-stroke" />
  </svg>
}

/** 전환 뒤 안정화 기간(24시간, 데모는 압축)의 모니터링. 기준을 모두 충족하면 옛 환경을 정리할 수 있다. */
export default function StabilityMonitor() {
  const t = useT()
  const [cleaned, setCleaned] = useState(false)
  const indices = Array.from({ length: POINTS }, (_, i) => i)
  const residualValues = indices.map(residual)
  const errorValues = indices.map(errorRate)
  const latencyValues = indices.map(latency)
  const lastResidual = residualValues[POINTS - 1]
  const lastError = errorValues[POINTS - 1]
  const lastLatency = latencyValues[POINTS - 1]
  const criteria = [
    { label: t('mon.crit.residual'), value: lastResidual + ' req/s', ok: lastResidual === 0 },
    { label: t('mon.crit.error'), value: lastError + '%', ok: lastError < 0.1 },
    { label: t('mon.crit.latency'), value: lastLatency + t('mon.times'), ok: lastLatency <= 1.5 },
  ]
  const ready = criteria.every(item => item.ok)
  return <div className="mon">
    <div className="mon-charts">
      <div><small>{t('mon.residual')}</small><strong>{lastResidual} req/s</strong><Spark values={residualValues} max={40} /></div>
      <div><small>{t('mon.error')}</small><strong>{lastError}%</strong><Spark values={errorValues} max={0.5} /></div>
      <div><small>{t('mon.latency')}</small><strong>{lastLatency}{t('mon.times')}</strong><Spark values={latencyValues} max={1.6} /></div>
    </div>
    <p className="mon-axis"><span>0h</span><span>{t('mon.axis')}</span><span>24h</span></p>
    <ul className="mon-criteria">
      {criteria.map(item => <li key={item.label} className={item.ok ? 'is-ok' : ''}><span aria-hidden="true">{item.ok ? '✓' : '·'}</span>{item.label}<b>{item.value}</b></li>)}
    </ul>
    <div className="mon-action">
      <span className={'flow-pill' + (ready ? ' is-ready' : '')}>{ready ? t('mon.ready') : t('mon.waiting')}</span>
      <button type="button" className="flow-secondary" disabled={!ready || cleaned} onClick={() => setCleaned(true)}>{cleaned ? t('mon.cleaned') : t('mon.cleanup')}</button>
    </div>
    <p className="flow-note">{t('mon.note')}</p>
  </div>
}
