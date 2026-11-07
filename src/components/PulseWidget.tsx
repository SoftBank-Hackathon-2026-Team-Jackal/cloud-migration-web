'use client'

import { useEffect, useState, type CSSProperties } from 'react'
import { useI18n, type MsgKey } from '../lib/i18n'
import { busiestCpu, parsePulse, pulseLevel, runSeconds, type Pulse, type Side } from '../lib/pulse/pulse'

const POLL_MS = 3000
const GIVE_UP_AFTER = 3 // 연속 실패가 이 횟수를 넘으면 위젯을 숨긴다(꾸민 값을 보이지 않는다)

/** 달리는 자칼. 직접 그린 단순한 실루엣이고, 다리와 몸의 움직임 속도가 `--run`(초)으로 정해진다. */
function RunningJackal() {
  return <svg className="pulse-jackal" viewBox="0 0 44 26" aria-hidden="true" focusable="false">
    <g className="pj-body">
      <path d="M8 11q1-3 6-3h12q3 0 4 2l1 5q-1 3-5 3H14q-5 0-6-4Z" />
      <path d="M30 8 35 6 43 10.5 35 13.5 31 14.5Z" />
      <path d="M32 7.5 33 1 36.5 6.2Z" />
      <path d="M35 6.4 38 1.2 39 8.5Z" />
      <path d="M8.5 10.5Q3 5.5 1 13.5q4-2.5 8-.5Z" />
    </g>
    <line className="pj-leg pj-a" x1="13" y1="18" x2="11" y2="25" />
    <line className="pj-leg pj-b" x1="17" y1="18" x2="19" y2="25" />
    <line className="pj-leg pj-b" x1="26" y1="18" x2="24" y2="25" />
    <line className="pj-leg pj-a" x1="30" y1="17" x2="32" y2="25" />
  </svg>
}

const pct = (value: number | null | undefined) => value === null || value === undefined ? '—' : Math.round(value) + '%'

/** 한 쪽 서버: 이름 · CPU % · 메모리 막대. 값을 못 받았으면 모두 —. */
function ServerBox({ label, side }: { label: string; side: Side | null }) {
  return <span className={'pulse-box' + (side ? '' : ' is-unknown')} aria-hidden="true">
    <small>{label}</small>
    <b>{pct(side?.cpu_percent)}</b>
    <i><em style={{ width: (side?.mem_percent ?? 0) + '%' }} /></i>
  </span>
}

/**
 * 화면 위쪽의 서버 맥박: 달리는 자칼(원본·이전 서버 중 더 바쁜 쪽의 CPU가 높을수록 빠르다) ·
 * 원본 서버 → 이전 서버의 CPU와 메모리 · 최근 5분 오류 수.
 * 각 서버가 보낸 실제 값만 보여 주고, 값을 받지 못한 쪽은 —로 둔다. 맥박을 아예 못 받으면 위젯 전체가 숨는다.
 */
export default function PulseWidget() {
  const { t } = useI18n()
  const [pulse, setPulse] = useState<Pulse | null>(null)

  useEffect(() => {
    let alive = true
    let failures = 0
    const read = async () => {
      if (document.hidden) return
      try {
        const response = await fetch('/api/pulse', { cache: 'no-store', signal: AbortSignal.timeout(5000) })
        const next = response.ok ? parsePulse(await response.json()) : null
        if (!alive) return
        failures = next ? 0 : failures + 1
        if (next) setPulse(next)
        else if (failures >= GIVE_UP_AFTER) setPulse(null)
      } catch {
        if (!alive) return
        failures += 1
        if (failures >= GIVE_UP_AFTER) setPulse(null)
      }
    }
    void read()
    const timer = setInterval(() => void read(), POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  if (!pulse) return null
  const run = runSeconds(busiestCpu(pulse))
  const level = pulseLevel(pulse)
  const errors = pulse.errors_5m === null ? '—' : String(pulse.errors_5m)
  const detail = t('pulse.detail' as MsgKey, {
    sCpu: pct(pulse.source?.cpu_percent), sMem: pct(pulse.source?.mem_percent),
    tCpu: pct(pulse.target?.cpu_percent), tMem: pct(pulse.target?.mem_percent),
    errors, minutes: Math.round(pulse.window_seconds / 60),
  })
  const style = { '--run': run + 's' } as CSSProperties
  return <div className={'pulse is-' + level + (run === 0 ? ' is-idle' : '')} style={style} role="status" aria-label={detail} title={detail}>
    <RunningJackal />
    <ServerBox label={t('pulse.source' as MsgKey)} side={pulse.source} />
    <span className="pulse-arrow" aria-hidden="true">→</span>
    <ServerBox label={t('pulse.target' as MsgKey)} side={pulse.target} />
    <span className="pulse-err" aria-hidden="true"><small>{t('pulse.err' as MsgKey)}</small>{errors}</span>
  </div>
}
