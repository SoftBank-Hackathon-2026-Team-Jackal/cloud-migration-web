'use client'

import { useEffect, useRef, useState } from 'react'

/** 쓰기 중단 구간 한 칸: 이름(label)과 걸린 시간(ms). result가 fail이면 빨강, revert면 회색. */
export type TraceStep = { key: string; label: string; ms: number; result?: 'ok' | 'fail' | 'revert'; note?: string }

/** 상자의 실제 크기(px). SVG를 늘이지 않고 그 크기로 그려 글자가 찌그러지지 않게 한다. */
export function useBoxSize<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, size] as const
}

const NICE = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]
const fmt = (ms: number) => (ms < 10 ? ms.toFixed(1) : String(Math.round(ms)))

/**
 * 트레이스 워터폴(DevTools 성능 탭 같은): 단계마다 한 줄, 가로축은 ms.
 * progress(ms)가 있으면 그 시각까지만 채우고 재생 막대를 그린다. 없으면 전부 채운 미리보기다.
 */
export default function CutoverTimeline({ steps, progress = null, className = '', ariaLabel }: { steps: TraceStep[]; progress?: number | null; className?: string; ariaLabel: string }) {
  const [ref, { width, height }] = useBoxSize<HTMLDivElement>()
  const total = steps.reduce((sum, step) => sum + step.ms, 0)
  const now = progress === null ? total : progress
  const ready = width > 0 && height > 0 && total > 0
  const labelW = Math.min(240, Math.max(130, width * 0.24))
  const top = 22
  const track = Math.max(10, width - labelW - 14)
  const rowH = steps.length ? Math.min(46, (height - top - 4) / steps.length) : 0
  const x = (ms: number) => labelW + (ms / (total || 1)) * track
  const tick = NICE.find(value => total / value <= 7) ?? 1000
  const ticks: number[] = []
  for (let value = 0; value <= total + 1e-9 && ready; value += tick) ticks.push(value)
  const font = Math.max(11, Math.min(16, rowH * 0.42))
  let start = 0
  return <div ref={ref} className={'cx-trace ' + className}>
    {ready && <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
      {ticks.map(value => <g key={value}>
        <line className="cx-trace-grid" x1={x(value)} x2={x(value)} y1={top - 6} y2={height} />
        <text className="cx-trace-tick" x={x(value)} y={11} textAnchor="middle">{+value.toFixed(1)} ms</text>
      </g>)}
      {steps.map((step, index) => {
        const from = start
        start += step.ms
        const to = start
        const fill = Math.max(0, Math.min(1, (now - from) / (step.ms || 1)))
        const active = progress !== null && now >= from && now < to
        const y = top + index * rowH
        const barY = y + rowH * 0.24
        const barH = rowH * 0.52
        const flip = x(to) + 130 > width
        const reached = now >= to - 1e-9
        return <g key={step.key} className={'cx-trace-row' + (step.result === 'fail' ? ' is-fail' : step.result === 'revert' ? ' is-revert' : '') + (active ? ' is-active' : '') + (fill > 0 ? ' is-on' : '')}>
          <text className="cx-trace-label" x={0} y={y + rowH * 0.62} style={{ fontSize: font }}>{step.label}</text>
          <rect className="cx-trace-slot" x={x(from)} y={barY} width={Math.max(2, x(to) - x(from))} height={barH} rx={2} />
          {fill > 0 && <rect className="cx-trace-bar" x={x(from)} y={barY} width={Math.max(2, (x(to) - x(from)) * fill)} height={barH} rx={2} />}
          {reached && <text className="cx-trace-ms" x={flip ? x(from) - 6 : x(to) + 6} y={y + rowH * 0.64} textAnchor={flip ? 'end' : 'start'} style={{ fontSize: Math.max(10, font - 2) }}>{fmt(step.ms)} ms{step.note ? ' ' + step.note : ''}</text>}
        </g>
      })}
      {progress !== null && now > 0 && now < total && <line className="cx-trace-head" x1={x(now)} x2={x(now)} y1={top - 8} y2={height} />}
    </svg>}
  </div>
}

/** 받은 쓰기 중단 구간을 정해진 시간(durationMs) 동안 느리게 다시 보여 준다. key가 바뀌면 처음부터. */
export function useReplay(totalMs: number, key: string | null, durationMs: number) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    setElapsed(0)
    if (!key || totalMs <= 0) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setElapsed(durationMs); return }
    const began = performance.now()
    let frame = 0
    const tick = (time: number) => {
      const value = Math.min(durationMs, time - began)
      setElapsed(value)
      if (value < durationMs) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [key, totalMs, durationMs])
  const progress = key && totalMs > 0 ? (elapsed / durationMs) * totalMs : 0
  return { progress, finished: !!key && elapsed >= durationMs, speed: totalMs > 0 ? Math.max(1, Math.round(durationMs / totalMs)) : 1 }
}

export const formatMs = fmt
