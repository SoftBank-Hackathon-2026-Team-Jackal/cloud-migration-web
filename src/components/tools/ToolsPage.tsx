'use client'

import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import LangSwitch from '../LangSwitch'
import { Chip, type ChipTone } from '../settings/parts'
import {
  faultPhase, parseFaultView, parseTrafficHealth,
  type FaultPhase, type FaultSettings, type FaultView, type SideSummary, type TrafficHealth,
} from '../../lib/tools/fault'

// 중계 서버 리포터가 장애 명령을 1초마다 동기화하므로 화면도 1초마다 묻는다.
const FAULT_POLL_MS = 1000
const HEALTH_POLL_MS = 3000

type Preset = 'mixed' | 'errors' | 'slow'
const PRESETS: Record<Preset, Omit<FaultSettings, 'duration_s'>> = {
  mixed: { error_rate: 0.5, delay_ms: 800 },
  errors: { error_rate: 1, delay_ms: 0 },
  slow: { error_rate: 0, delay_ms: 1500 },
}
const DURATIONS = [60, 180, 300, 600]

const PHASE_TONE: Record<FaultPhase, ChipTone> = {
  relay_offline: 'bad', pending: 'wait', on: 'bad', off: 'off', unknown: 'wait', failed: 'bad',
}

type Load<T> = T | 'loading' | 'disabled' | 'unavailable'

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { cache: 'no-store', ...init })
  return { status: response.status, body: await response.json().catch(() => null) }
}

/** /tools: 시연용 장애 주입과 원본·대상 지표 미리보기. 모든 호출은 같은 출처의 웹 서버(/api/*)를 거친다. */
export default function ToolsPage() {
  const { t } = useI18n()
  return <div className="cx-page tools-page">
    <header className="cx-top">
      <a className="cx-back" href="/">← {t('cx.backToDemo')}</a>
      <LangSwitch />
    </header>
    <main className="cx-main" aria-labelledby="tools-title">
      <div className="cx-heading">
        <h1 id="tools-title">{t('tools.title')}</h1>
        <p>{t('tools.lead')}</p>
      </div>
      <FaultCard />
      <HealthCard />
    </main>
  </div>
}

export function FaultCard() {
  const { t } = useI18n()
  const [view, setView] = useState<Load<FaultView>>('loading')
  const [preset, setPreset] = useState<Preset>('mixed')
  const [duration, setDuration] = useState(300)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const take = useCallback((status: number, body: unknown) => {
    if (status === 404) return setView('disabled')
    const parsed = status === 200 ? parseFaultView(body) : null
    setView(current => parsed ?? (current === 'loading' ? 'unavailable' : current))
  }, [])

  useEffect(() => {
    let alive = true
    const load = () => getJson('/api/tools/fault').then(r => { if (alive) take(r.status, r.body) }).catch(() => { if (alive) setView('unavailable') })
    load()
    const timer = window.setInterval(load, FAULT_POLL_MS)
    return () => { alive = false; window.clearInterval(timer) }
  }, [take])

  const send = async (method: 'POST' | 'DELETE') => {
    setBusy(true)
    setNote(null)
    try {
      const body = method === 'POST' ? JSON.stringify({ ...PRESETS[preset], duration_s: duration }) : undefined
      const result = await getJson('/api/tools/fault', { method, body, headers: body ? { 'Content-Type': 'application/json' } : undefined })
      if (result.status === 401 || result.status === 403) setNote(t('tools.fault.denied'))
      else if (result.status !== 200) setNote(t('tools.fault.failed'))
      take(result.status, result.body)
    } catch {
      setNote(t('tools.fault.failed'))
    } finally {
      setBusy(false)
    }
  }

  if (view === 'disabled' || view === 'unavailable') {
    return <section className="cx-card tools-card"><h2 className="tools-h2">{t('tools.fault.title')}</h2>
      <p className="cx-note">{t(view === 'disabled' ? 'tools.disabled' : 'tools.unavailable')}</p></section>
  }
  const data = view === 'loading' ? null : view
  const phase = data ? faultPhase(data) : null
  const observed = data?.observed
  return <section className="cx-card tools-card" aria-busy={busy || view === 'loading'} aria-labelledby="tools-fault">
    <div className="cx-card-head">
      <div className="cx-card-title">
        <strong id="tools-fault">{t('tools.fault.title')}</strong>
        <small>{t('tools.fault.desc')}</small>
      </div>
      {phase && <div className="cx-card-state" role="status">
        <Chip tone={PHASE_TONE[phase]}>{t(('tools.fault.phase.' + phase) as 'tools.fault.phase.on', { error: observed?.error ?? '' })}</Chip>
      </div>}
    </div>
    {phase === 'on' && observed && <p className="tools-current">{t('tools.fault.current', {
      rate: Math.round((observed.error_rate ?? 0) * 100), delay: observed.delay_ms ?? 0, left: observed.remaining_s ?? '—',
    })}</p>}
    <fieldset className="tools-field">
      <legend>{t('tools.fault.preset')}</legend>
      {(Object.keys(PRESETS) as Preset[]).map(id => <label key={id} className={'tools-option' + (preset === id ? ' is-on' : '')}>
        <input type="radio" name="tools-preset" value={id} checked={preset === id} onChange={() => setPreset(id)} />
        {t(('tools.fault.preset.' + id) as 'tools.fault.preset.mixed')}
      </label>)}
    </fieldset>
    <fieldset className="tools-field">
      <legend>{t('tools.fault.duration')}</legend>
      {DURATIONS.map(seconds => <label key={seconds} className={'tools-option' + (duration === seconds ? ' is-on' : '')}>
        <input type="radio" name="tools-duration" value={seconds} checked={duration === seconds} onChange={() => setDuration(seconds)} />
        {t('tools.fault.minutes', { n: seconds / 60 })}
      </label>)}
    </fieldset>
    <div className="cx-card-foot">
      <span className="tools-age">{observed && data?.observed_age_seconds !== null ? t('tools.fault.age', { s: Math.round(data?.observed_age_seconds ?? 0) }) : ''}{note && <b role="alert"> {note}</b>}</span>
      <span className="tools-actions">
        <button type="button" className="cx-btn" disabled={busy || !data} onClick={() => void send('DELETE')}>{t('tools.fault.off')}</button>
        <button type="button" className="cx-primary tools-danger" disabled={busy || !data} onClick={() => void send('POST')}>{t('tools.fault.on')}</button>
      </span>
    </div>
  </section>
}

const pct = (value: number | null) => value === null ? '—' : (Math.round(value * 1000) / 10) + '%'
const ms = (value: number | null) => value === null ? '—' : Math.round(value) + 'ms'
const num = (value: number | null) => value === null ? '—' : String(Math.round(value * 10) / 10)

function SideBox({ label, side, tone }: { label: string; side: SideSummary | null; tone: 'origin' | 'target' }) {
  const { t } = useI18n()
  const bad = side !== null && (side.error_rate ?? 0) >= 0.05
  return <div className={'tools-side is-' + tone + (bad ? ' is-bad' : '')}>
    <small>{label}</small>
    <dl>
      <div><dt>{t('tools.health.errorRate')}</dt><dd>{pct(side?.error_rate ?? null)}</dd></div>
      <div><dt>{t('tools.health.p99')}</dt><dd>{ms(side?.p99_ms ?? null)}</dd></div>
      <div><dt>{t('tools.health.rps')}</dt><dd>{num(side?.rps ?? null)}</dd></div>
    </dl>
  </div>
}

/** 최근 구간별 오류율(원본·대상) 막대. 요청이 없던 구간은 비워 둔다. */
function Trend({ health }: { health: TrafficHealth }) {
  const { t } = useI18n()
  const points = health.series.slice(-36)
  if (!points.length) return null
  const bar = (rate: number | null) => !rate ? 0 : Math.max(3, Math.round(rate * 100))
  return <figure className="tools-trend" aria-label={t('tools.health.trend')}>
    <figcaption>{t('tools.health.trend')}</figcaption>
    <div className="tools-bars">
      {points.map((p, i) => <span key={i} className="tools-bar">
        <i className="is-origin" style={{ height: bar(p.origin.error_rate) + '%' }} />
        <i className="is-target" style={{ height: bar(p.target.error_rate) + '%' }} />
      </span>)}
    </div>
  </figure>
}

export function HealthCard() {
  const { t } = useI18n()
  const [health, setHealth] = useState<Load<TrafficHealth>>('loading')
  useEffect(() => {
    let alive = true
    const load = () => getJson('/api/traffic-health').then(r => {
      if (!alive) return
      const parsed = r.status === 200 ? parseTrafficHealth(r.body) : null
      setHealth(parsed ?? 'unavailable')
    }).catch(() => { if (alive) setHealth('unavailable') })
    load()
    const timer = window.setInterval(load, HEALTH_POLL_MS)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])
  const data = typeof health === 'object' ? health : null
  return <section className="cx-card tools-card" aria-labelledby="tools-health">
    <div className="cx-card-title">
      <strong id="tools-health">{t('tools.health.title')}</strong>
      <small>{t('tools.health.desc')}</small>
    </div>
    {health === 'unavailable' && <p className="cx-note">{t('tools.unavailable')}</p>}
    {data && !data.fresh && <p className="cx-note">{t('tools.health.stale')}</p>}
    <div className="tools-sides">
      <SideBox label={t('tools.health.origin')} side={data?.fresh ? data.summary.origin : null} tone="origin" />
      <SideBox label={t('tools.health.target')} side={data?.fresh ? data.summary.target : null} tone="target" />
    </div>
    {data && <Trend health={data} />}
  </section>
}
