'use client'

import { useEffect, useState } from 'react'
import { useT } from '../lib/i18n'
import { parseTrafficHealth, type SideSummary, type TrafficHealth } from '../lib/tools/fault'
import type { TrafficHealthJudgement } from '../lib/migration/events'

const POLL_MS = 3000

/** 중계 서버 Envoy에서 잰 원본·대상 지표(/api/traffic-health)를 3초마다 읽는다. 읽지 못하면 null(값을 꾸미지 않는다). */
export function useTrafficHealth(enabled = true): TrafficHealth | null {
  const [health, setHealth] = useState<TrafficHealth | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    let misses = 0
    let timer = 0
    const load = async () => {
      const response = await fetch('/api/traffic-health', { cache: 'no-store' }).catch(() => null)
      const parsed = response?.ok ? parseTrafficHealth(await response.json().catch(() => null)) : null
      if (!alive) return
      misses = parsed ? 0 : misses + 1
      setHealth(parsed)
      // 설정이 없는 서버(목업)는 계속 묻지 않는다: 세 번 연속 실패하면 30초 간격으로 줄인다.
      timer = window.setTimeout(load, misses >= 3 ? 30000 : POLL_MS)
    }
    void load()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [enabled])
  return health
}

const pct = (value: number | null | undefined) => value === null || value === undefined ? '—' : (Math.round(value * 1000) / 10) + '%'
const ms = (value: number | null | undefined) => value === null || value === undefined ? '—' : Math.round(value) + 'ms'

type Limits = { errorRate: number; p99Ms: number } | null

function Side({ label, side, limits, tone }: { label: string; side: SideSummary | null; limits: Limits; tone: 'origin' | 'target' }) {
  const t = useT()
  const errorBad = Boolean(limits && side?.error_rate != null && side.error_rate > limits.errorRate)
  const p99Bad = Boolean(limits && side?.p99_ms != null && side.p99_ms > limits.p99Ms)
  return <div className={'thp-side is-' + tone + (errorBad || p99Bad ? ' is-bad' : '')}>
    <small>{label}</small>
    <div className={'thp-metric' + (errorBad ? ' is-bad' : '')}><span>{t('thp.errorRate')}</span><b>{pct(side?.error_rate)}</b></div>
    <div className={'thp-metric' + (p99Bad ? ' is-bad' : '')}><span>p99</span><b>{ms(side?.p99_ms)}</b></div>
  </div>
}

/**
 * Run Jackal 트래픽 화면의 원본·대상 지표: 500 오류율과 p99를 나란히 보인다.
 * 기준선은 안정화 구간 판정(snapshot.health)의 값이 있을 때만 그린다(대상만 판정한다).
 * 실시간 값이 없고 판정도 없으면 그리지 않는다.
 */
export default function TrafficHealthPanel({ judgement, leftSeconds, alerting, live: useLive, origin }: {
  judgement: TrafficHealthJudgement | null
  leftSeconds: number | null
  alerting: boolean
  /** 실제 모드에서만 중계 서버 실측값을 읽는다(목업은 대본 값만 쓴다: 다른 환경의 값을 섞지 않는다). */
  live: boolean
  /** 실측값이 없을 때 원본 쪽에 보일 값(목업 시뮬레이터의 백엔드별 지표) */
  origin?: SideSummary | null
}) {
  const t = useT()
  const live = useTrafficHealth(useLive)
  const fresh = useLive && live?.fresh ? live : null
  if (!fresh && !judgement) return null
  const limits: Limits = judgement ? { errorRate: judgement.alert_error_rate, p99Ms: judgement.p99_limit_ms } : null
  // 실시간 값이 없으면 대상 쪽은 판정 창의 값으로 보인다.
  const target: SideSummary | null = fresh?.summary.target ?? (judgement ? { requests: judgement.requests, failed: judgement.failed, error_rate: judgement.error_rate, p99_ms: judgement.p99_ms, rps: null } : null)
  return <section className={'traffic-panel thp' + (alerting ? ' is-alert' : '')} aria-label={t('thp.title')}>
    <h2>{t('thp.title')} <small>{fresh ? t('thp.live') : t('thp.window')}</small></h2>
    <div className="thp-sides">
      <Side label={t('thp.origin')} side={fresh?.summary.origin ?? origin ?? null} limits={null} tone="origin" />
      <span className="thp-arrow" aria-hidden="true">→</span>
      <Side label={t('thp.target')} side={target} limits={limits} tone="target" />
    </div>
    {limits && <p className="thp-limits">{t('thp.limits', { rate: Math.round(limits.errorRate * 1000) / 10, p99: Math.round(limits.p99Ms) })}
      {leftSeconds !== null && <> · {t('thp.left', { s: Math.ceil(leftSeconds) })}</>}</p>}
  </section>
}
