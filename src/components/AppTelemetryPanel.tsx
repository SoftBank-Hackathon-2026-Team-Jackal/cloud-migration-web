'use client'

import { useEffect, useState } from 'react'
import { useT } from '../lib/i18n'
import { latest, parseAppTelemetry, peak, type AppTelemetry, type EnvTelemetry, type Point } from '../lib/telemetry'
import '../app/telemetry.css'

const POLL_MS = 5000

/**
 * 앱 관측 값(/api/app-telemetry)을 5초마다 읽는다. 읽지 못하면 null(값을 꾸미지 않는다).
 * 설정이 없는 서버(204, 목업·로컬)나 연속 실패는 30초 간격으로 줄인다.
 */
export function useAppTelemetry(enabled = true): AppTelemetry | null {
  const [value, setValue] = useState<AppTelemetry | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    let misses = 0
    let timer = 0
    const load = async () => {
      const response = await fetch('/api/app-telemetry', { cache: 'no-store' }).catch(() => null)
      const parsed = response?.status === 200 ? parseAppTelemetry(await response.json().catch(() => null)) : null
      if (!alive) return
      misses = parsed ? 0 : misses + 1
      setValue(parsed)
      timer = window.setTimeout(load, misses >= 3 ? 30000 : POLL_MS)
    }
    void load()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [enabled])
  return value
}

const round = (n: number) => n >= 100 ? Math.round(n) : Math.round(n * 10) / 10

/** 시간축 스파크라인: 창 전체(window_s)를 가로로 쓴다. 점이 없으면 축만 그린다. */
function Spark({ points, at, windowS, tone }: { points: Point[]; at: number; windowS: number; tone?: 'bad' }) {
  const max = Math.max(1e-9, ...points.map(p => p[1]))
  const x = (t: number) => (100 * (t - (at - windowS)) / windowS).toFixed(1)
  const y = (v: number) => (22 - (v / max) * 19).toFixed(1)
  const path = points.map((p, i) => (i === 0 ? 'M' : 'L') + x(p[0]) + ' ' + y(p[1])).join(' ')
  return <svg className={'otel-spark' + (tone ? ' is-' + tone : '')} viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" y1="23" x2="100" y2="23" className="otel-axis" />
    {path && <path d={path} vectorEffect="non-scaling-stroke" />}
  </svg>
}

function Row({ label, value, points, data, tone }: { label: string; value: string; points: Point[]; data: AppTelemetry; tone?: 'bad' }) {
  return <div className={'otel-row' + (tone ? ' is-' + tone : '')}>
    <span>{label}</span>
    <Spark points={points} at={data.at} windowS={data.window_s} tone={tone} />
    <b>{value}</b>
  </div>
}

function EnvBlock({ env, data }: { env: EnvTelemetry; data: AppTelemetry }) {
  const t = useT()
  const now = (points: Point[]) => latest(points, data.at)
  const ms = (n: number | null) => n === null ? '—' : t('otel.unit.ms', { n: round(n) })
  const errorRate = now(env.error_rate)
  return <div className="otel-env">
    <small className="otel-env-name">{env.env}</small>
    <Row label={t('otel.rps')} value={now(env.rps) === null ? '—' : t('otel.unit.rps', { n: round(now(env.rps)!) })} points={env.rps} data={data} />
    <Row label={t('otel.errorRate')} value={errorRate === null ? '—' : round(errorRate * 100) + '%'} points={env.error_rate} data={data} tone={errorRate !== null && errorRate > 0.01 ? 'bad' : undefined} />
    <Row label={t('otel.p99')} value={ms(now(env.p99_ms))} points={env.p99_ms} data={data} />
    <Row label={t('otel.dbP99')} value={ms(now(env.db_p99_ms))} points={env.db_p99_ms} data={data} />
    <Row label={t('otel.poolWait')} value={now(env.pool_wait_ms) === null ? '—' : t('otel.unit.msps', { n: round(now(env.pool_wait_ms)!) })} points={env.pool_wait_ms} data={data} />
  </div>
}

/**
 * 앱 관측(OpenTelemetry) 카드: 환경(ENV_NAME)마다 요청·오류율·API p99·DB p99·커넥션 풀 대기를 최근 5분 그래프로 보인다.
 * `compact`는 트래픽 화면 옆자리용(설명 문구와 5xx 목록을 줄인다). 값이 하나도 없으면 그리지 않는다(목업·설정 없음).
 */
export default function AppTelemetryPanel({ enabled = true, compact = false, className = '' }: { enabled?: boolean; compact?: boolean; className?: string }) {
  const t = useT()
  const data = useAppTelemetry(enabled)
  if (!data) return null
  if (data.envs.length === 0 && compact) return null
  return <section className={'otel' + (compact ? ' is-compact' : '') + (className ? ' ' + className : '')} aria-label={t('otel.title')} data-testid="app-telemetry">
    <h2>{t('otel.title')} <small>{t('otel.tag')}</small></h2>
    {!compact && <p className="otel-desc">{t('otel.desc')}</p>}
    {data.envs.length === 0
      ? <p className="otel-empty">{t('otel.empty')}</p>
      : <div className="otel-envs">{data.envs.map(env => <EnvBlock key={env.env} env={env} data={data} />)}</div>}
    {(!compact || data.errors.length > 0) && <div className="otel-errors">
      <small>{t('otel.errors')}</small>
      {data.errors.length === 0
        ? <p>{t('otel.errors.none')}</p>
        : <ul>{data.errors.slice(0, compact ? 2 : 5).map(e => <li key={e.env + e.route}><code>{e.route}</code><span>{e.env}</span><b>{e.count}</b></li>)}</ul>}
    </div>}
  </section>
}

/**
 * DB 전환 화면용 한 줄: 앱이 겪은 커넥션 풀 대기와 DB p99(최근 5분 최댓값과 그래프).
 * 전환 중 PgBouncer PAUSE 동안 앱 쪽에서 기다린 모습이 그대로 보인다. 값이 없으면 그리지 않는다.
 */
export function CutoverAppTelemetry({ enabled = true }: { enabled?: boolean }) {
  const t = useT()
  const data = useAppTelemetry(enabled)
  const envs = data?.envs.filter(env => env.pool_wait_ms.length > 0 || env.db_p99_ms.length > 0) ?? []
  if (!data || envs.length === 0) return null
  const ms = (n: number | null) => n === null ? '—' : round(n) + 'ms'
  return <div className="otel-cut" data-testid="app-telemetry-cutover">
    <h4>{t('otel.cutover.title')} <small>{t('otel.tag')}</small></h4>
    {envs.map(env => <div key={env.env} className="otel-cut-env">
      <small className="otel-env-name">{env.env}</small>
      <Row label={t('otel.poolWait')} value={t('otel.unit.msps', { n: round(peak(env.pool_wait_ms) ?? 0) })} points={env.pool_wait_ms} data={data} />
      <Row label={t('otel.dbP99')} value={ms(peak(env.db_p99_ms))} points={env.db_p99_ms} data={data} />
    </div>)}
  </div>
}
