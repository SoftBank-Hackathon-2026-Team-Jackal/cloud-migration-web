'use client'

import { useEffect, useRef } from 'react'

type Dot = { t: number; speed: number; toNew: boolean; sway: number; bright: boolean }

// 노드 위치(캔버스 가로·세로 비율). 처음엔 대략값이고, 실제 화면의 원(.traffic-orb) 위치를 읽어 맞춘다.
const USER = { x: 0.09, y: 0.5 }
const RELAY = { x: 0.4, y: 0.5 }
const OLD = { x: 0.86, y: 0.21 }
const NEW = { x: 0.86, y: 0.79 }
const ANCHORS = { user: USER, relay: RELAY, old: OLD, new: NEW } as const
const SPLIT = 0.42

function bezier(p0: number, p1: number, p2: number, p3: number, t: number) {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

/** 중계 서버에서 두 환경으로 갈라지는 요청을 입자로 보여 준다. 비율은 weightNew(새 환경 %)를 따른다. */
export default function TrafficCanvas({ weightNew }: { weightNew: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const weightRef = useRef(weightNew)
  useEffect(() => { weightRef.current = weightNew }, [weightNew])

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let width = 1
    let height = 1
    let frame = 0
    let last = performance.now()
    let spawnCarry = 0
    const dots: Dot[] = []

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      width = Math.max(1, canvas.clientWidth)
      height = Math.max(1, canvas.clientHeight)
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      readAnchors()
    }
    // 선과 입자가 글자가 아니라 원의 한가운데에서 시작하고 끝나도록, 화면에 그려진 원의 위치를 읽는다.
    const readAnchors = () => {
      const bounds = canvas.getBoundingClientRect()
      const scope = canvas.parentElement
      if (!scope || bounds.width < 2 || bounds.height < 2) return
      for (const [name, anchor] of Object.entries(ANCHORS)) {
        const orb = scope.querySelector('[data-node="' + name + '"] .traffic-orb')?.getBoundingClientRect()
        if (!orb) continue
        anchor.x = (orb.left + orb.width / 2 - bounds.left) / bounds.width
        anchor.y = (orb.top + orb.height / 2 - bounds.top) / bounds.height
      }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()
    // 노드는 이 캔버스 다음에 그려지므로, 첫 프레임 직후에도 한 번 더 읽는다.
    const settle = window.setTimeout(resize, 60)

    const point = (dot: Dot) => {
      if (dot.t < SPLIT) {
        const k = dot.t / SPLIT
        return { x: (USER.x + (RELAY.x - USER.x) * k) * width, y: (USER.y + (RELAY.y - USER.y) * k) * height + Math.sin(dot.t * 40 + dot.sway) * 2 }
      }
      const k = (dot.t - SPLIT) / (1 - SPLIT)
      const end = dot.toNew ? NEW : OLD
      const bend = dot.toNew ? 0.16 : -0.16
      const x = bezier(RELAY.x, RELAY.x + 0.2, end.x - 0.2, end.x, k) * width
      const y = bezier(RELAY.y, RELAY.y + bend, end.y - bend, end.y, k) * height + Math.sin(dot.t * 36 + dot.sway) * 2
      return { x, y }
    }

    let ticks = 0
    const draw = (now: number) => {
      if (++ticks % 20 === 0) readAnchors()
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      spawnCarry += dt * (reduced ? 8 : 52)
      while (spawnCarry >= 1) {
        spawnCarry -= 1
        dots.push({ t: 0, speed: 0.34 + Math.random() * 0.16, toNew: Math.random() * 100 < weightRef.current, sway: Math.random() * 6, bright: Math.random() < 0.2 })
      }
      context.clearRect(0, 0, width, height)

      context.lineWidth = 1
      context.strokeStyle = 'rgba(170,170,170,.6)'
      context.setLineDash([3, 7])
      context.beginPath()
      context.moveTo(USER.x * width, USER.y * height)
      context.lineTo(RELAY.x * width, RELAY.y * height)
      for (const [end, bend] of [[OLD, -0.16], [NEW, 0.16]] as const) {
        context.moveTo(RELAY.x * width, RELAY.y * height)
        context.bezierCurveTo((RELAY.x + 0.2) * width, (RELAY.y + bend) * height, (end.x - 0.2) * width, (end.y - bend) * height, end.x * width, end.y * height)
      }
      context.stroke()
      context.setLineDash([])

      for (let index = dots.length - 1; index >= 0; index--) {
        const dot = dots[index]
        dot.t += dt * dot.speed
        if (dot.t >= 1) { dots.splice(index, 1); continue }
        const { x, y } = point(dot)
        const fade = Math.min(1, dot.t * 8, (1 - dot.t) * 8)
        context.globalAlpha = 0.85 * fade
        context.fillStyle = dot.t >= SPLIT && dot.toNew ? '#1d1d1d' : dot.bright ? '#b0b0b0' : '#7b7b7b'
        context.beginPath()
        context.arc(x, y, dot.t >= SPLIT && dot.toNew ? 2.3 : 2, 0, Math.PI * 2)
        context.fill()
      }
      context.globalAlpha = 1
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(frame); window.clearTimeout(settle); observer.disconnect() }
  }, [])

  return <canvas ref={canvasRef} className="traffic-canvas" aria-hidden="true" />
}
