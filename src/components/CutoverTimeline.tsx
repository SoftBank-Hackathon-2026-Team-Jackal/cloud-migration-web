'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * 쓰기 중단 구간 한 칸: 이름(label)과 걸린 시간(ms). start는 구간 시작부터의 시각(같으면 동시 실행, 없으면 앞 칸 뒤).
 * ms가 null이면 시간을 모르는 상태 줄이다(실행 중이거나 중단돼 단계별 시간이 없을 때): note만 적는다.
 * result가 fail이면 빨강, revert면 회색, skip이면 실행하지 않은 단계.
 */
export type TraceStep = { key: string; label: string; ms: number | null; start?: number; result?: 'ok' | 'fail' | 'revert' | 'skip'; note?: string }

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
/** 칸마다 시작·끝 시각(ms). start가 없으면 앞 칸이 끝난 뒤에 이어진다. */
export function placeSteps(steps: TraceStep[]) {
  let cursor = 0
  return steps.map(step => {
    const from = step.start ?? cursor
    const to = from + (step.ms ?? 0)
    cursor = to
    return { from, to }
  })
}

export default function CutoverTimeline({ steps, progress = null, className = '', ariaLabel }: { steps: TraceStep[]; progress?: number | null; className?: string; ariaLabel: string }) {
  const [ref, { width, height }] = useBoxSize<HTMLDivElement>()
  const timed = steps.length > 0 && steps.every(step => step.ms !== null)
  const spans = placeSteps(steps)
  const total = timed ? Math.max(0, ...spans.map(span => span.to)) : 0
  const now = progress === null ? total : progress
  const ready = width > 0 && height > 0 && steps.length > 0
  // 시간 눈금은 시간을 알 때만 그린다.
  const top = timed ? 22 : 4
  const labelW = Math.min(240, Math.max(130, width * 0.24))
  const track = Math.max(10, width - labelW - 14)
  const rowH = steps.length ? Math.min(46, (height - top - 4) / steps.length) : 0
  const x = (ms: number) => labelW + (ms / (total || 1)) * track
  const tick = NICE.find(value => total / value <= 7) ?? 1000
  const ticks: number[] = []
  for (let value = 0; value <= total + 1e-9 && ready && timed; value += tick) ticks.push(value)
  const font = Math.max(11, Math.min(16, rowH * 0.42))
  return <div ref={ref} className={'cx-trace ' + className}>
    {ready && <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
      {ticks.map(value => <g key={value}>
        <line className="cx-trace-grid" x1={x(value)} x2={x(value)} y1={top - 6} y2={height} />
        <text className="cx-trace-tick" x={x(value)} y={11} textAnchor="middle">{+value.toFixed(1)} ms</text>
      </g>)}
      {steps.map((step, index) => {
        const { from, to } = spans[index]
        const y = top + index * rowH
        const barY = y + rowH * 0.24
        const barH = rowH * 0.52
        const tone = step.result === 'fail' ? ' is-fail' : step.result === 'revert' ? ' is-revert' : step.result === 'skip' ? ' is-skip' : ''
        // 앞 칸과 같은 시각에 시작하면 동시에 실행된 단계다.
        const parallel = index > 0 && step.start !== undefined && step.start === steps[index - 1].start
        const label = <text className="cx-trace-label" x={0} y={y + rowH * 0.62} style={{ fontSize: font }}>{step.label}</text>
        if (!timed) {
          // 시간을 모르는 상태 줄: 칸 전체를 옅게 두고 상태 글만 적는다.
          const on = step.result !== 'skip' && !!step.note
          return <g key={step.key} className={'cx-trace-row is-state' + tone + (on ? ' is-on' : '')}>
            {label}
            <rect className="cx-trace-slot" x={labelW} y={barY} width={track} height={barH} rx={2} />
            {step.note && <text className="cx-trace-ms" x={labelW + 8} y={y + rowH * 0.64} style={{ fontSize: Math.max(10, font - 2) }}>{step.note}</text>}
          </g>
        }
        const ms = step.ms ?? 0
        const fill = Math.max(0, Math.min(1, (now - from) / (ms || 1)))
        const active = progress !== null && now >= from && now < to
        const flip = x(to) + 130 > width
        const reached = now >= to - 1e-9
        return <g key={step.key} className={'cx-trace-row' + tone + (active ? ' is-active' : '') + (fill > 0 ? ' is-on' : '')}>
          {label}
          {parallel && <line className="cx-trace-par" x1={x(from) - 4} x2={x(from) - 4} y1={y - rowH * 0.7} y2={y + rowH * 0.76} />}
          <rect className="cx-trace-slot" x={x(from)} y={barY} width={Math.max(2, x(to) - x(from))} height={barH} rx={2} />
          {fill > 0 && <rect className="cx-trace-bar" x={x(from)} y={barY} width={Math.max(2, (x(to) - x(from)) * fill)} height={barH} rx={2} />}
          {reached && <text className="cx-trace-ms" x={flip ? x(from) - 8 : x(to) + 6} y={y + rowH * 0.64} textAnchor={flip ? 'end' : 'start'} style={{ fontSize: Math.max(10, font - 2) }}>{fmt(ms)} ms{step.note ? ' ' + step.note : ''}</text>}
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
  // 단계별 시간이 없으면(중단·생략) 다시 보여 줄 것이 없으니 바로 끝난 것으로 본다.
  return { progress, finished: !!key && (totalMs <= 0 || elapsed >= durationMs), speed: totalMs > 0 ? Math.max(1, Math.round(durationMs / totalMs)) : 1 }
}

export const formatMs = fmt
