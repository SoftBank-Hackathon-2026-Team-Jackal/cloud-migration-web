'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'
import { fx, registerLayer, samplePoints, type HandoffPoint, type Layer } from '../lib/particleHandoff'

/** 떠나는 화면이 입자로 풀어지는 동안 기다리는 시간(ms). 이 동안 옛 화면은 흐려지며 사라지고, 입자는 멈추지 않고 계속 떠다닌다. */
export const DISSOLVE_MS = 800
/** 도착지(새 화면)를 끝내 못 받으면 입자를 이 시간 뒤에 서서히 거둔다. */
const WAIT_LIMIT_MS = 2600
const RELEASE_MS = 700

const clamp = (value: number) => Math.max(0, Math.min(1, value))
// 출발은 부드럽게 가속하고 도착은 길게 감속한다("슈욱" 하고 부딪히지 않고 "슈우욱…" 내려앉는다).
const ease = (u: number) => (u * u * (3 - 2 * u) + (1 - (1 - u) ** 3)) / 2

type Part = {
  x: number; y: number; vx: number; vy: number
  delayOut: number; bright: boolean
  armed: boolean; p0x: number; p0y: number; p1x: number; p1y: number; p2x: number; p2y: number; p3x: number; p3y: number
  delayIn: number; duration: number; settle: number; dead: boolean
}

type Phase = 'idle' | 'out' | 'arrive' | 'release'

/**
 * 화면 전환 내내 하나의 입자 층이 이어진다.
 * 떠나는 화면에서 풀려난 입자가 → 속도를 유지한 채 → 새 화면의 글자·테두리 자리로 곡선을 그리며 흘러 들어가고 → 하나씩 가라앉는다.
 * (옛 화면용·새 화면용 입자를 따로 두지 않으므로 중간에 끊기지 않는다.)
 */
export function TransitionLayer() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    let width = window.innerWidth
    let height = window.innerHeight
    let parts: Part[] = []
    let phase: Phase = 'idle'
    let startedAt = 0
    let arrivedAt = 0
    let releaseAt = 0
    let last = 0
    let frame = 0
    let running = false

    const fit = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
    }
    fit()
    window.addEventListener('resize', fit)

    const finish = () => {
      phase = 'idle'
      parts = []
      running = false
      context.clearRect(0, 0, width, height)
    }

    const loop = (now: number) => {
      const dt = Math.min(48, now - last || 16)
      last = now
      if (phase === 'out' && now - startedAt > WAIT_LIMIT_MS) { phase = 'release'; releaseAt = now }
      context.clearRect(0, 0, width, height)
      let alive = 0
      for (const part of parts) {
        if (part.dead) continue
        alive++
        let alpha = .8
        let moving = true
        if (phase === 'arrive' && part.armed) {
          const k = now - arrivedAt - part.delayIn
          if (k > 0) {
            moving = false
            const u = clamp(k / part.duration)
            const s = ease(u)
            const v = 1 - s
            part.x = v ** 3 * part.p0x + 3 * v * v * s * part.p1x + 3 * v * s * s * part.p2x + s ** 3 * part.p3x
            part.y = v ** 3 * part.p0y + 3 * v * v * s * part.p1y + 3 * v * s * s * part.p2y + s ** 3 * part.p3y
            if (u >= 1) {
              const age = k - part.duration - part.settle
              if (age >= 350) { part.dead = true; continue }
              alpha = .8 * (1 - clamp(age / 350))
            }
          }
        }
        if (moving) {
          // 아직 출발 전이거나 도착지를 기다리는 동안에도 멈추지 않고 천천히 떠다닌다.
          part.x += part.vx * dt
          part.y += part.vy * dt
          const damping = 1 - dt * .0004
          part.vx *= damping
          part.vy *= damping
          alpha = clamp((now - startedAt - part.delayOut) / 320) * .8
          if (phase === 'release') {
            const fade = clamp((now - releaseAt) / RELEASE_MS)
            alpha *= 1 - fade
            if (fade >= 1) { part.dead = true; continue }
          }
        }
        if (alpha <= 0) continue
        context.globalAlpha = alpha
        context.fillStyle = part.bright ? '#aaa' : '#2b2b2b'
        context.fillRect(part.x, part.y, part.bright ? 2 : 1.5, part.bright ? 2 : 1.5)
      }
      context.globalAlpha = 1
      if (alive === 0) { finish(); return }
      frame = requestAnimationFrame(loop)
    }

    const layer: Layer = {
      active: () => phase === 'out' || phase === 'arrive',
      start: (points: HandoffPoint[]) => {
        if (!points.length || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
        fit()
        const count = Math.min(11000, Math.max(3500, points.length))
        parts = Array.from({ length: count }, () => {
          const origin = points[Math.floor(Math.random() * points.length)]
          return {
            x: origin.x, y: origin.y,
            // 위쪽으로 살짝 떠오르며 흩어진다(px/ms).
            vx: (Math.random() - .5) * .05, vy: -Math.random() * .045 - .005,
            delayOut: (origin.x / width) * 260 + Math.random() * 140, bright: Math.random() < .2,
            armed: false, p0x: 0, p0y: 0, p1x: 0, p1y: 0, p2x: 0, p2y: 0, p3x: 0, p3y: 0,
            delayIn: 0, duration: 1, settle: 0, dead: false,
          }
        })
        phase = 'out'
        startedAt = performance.now()
        last = startedAt
        if (!running) { running = true; frame = requestAnimationFrame(loop) }
      },
      accept: (targets: HandoffPoint[]) => {
        const now = performance.now()
        const recent = phase === 'arrive' && now - arrivedAt < 300
        if (phase === 'arrive' && !recent) return true
        if (phase !== 'out' && !recent) return false
        if (!targets.length || !parts.length) return false
        phase = 'arrive'
        arrivedAt = now
        for (const part of parts) {
          if (part.dead) continue
          const target = targets[Math.floor(Math.random() * targets.length)]
          const dx = target.x - part.x
          const dy = target.y - part.y
          const distance = Math.max(1, Math.hypot(dx, dy))
          const nx = -dy / distance
          const ny = dx / distance
          const swirl = (Math.random() - .5) * 2 * distance * .28
          part.duration = 1100 + Math.random() * 450
          part.delayIn = ((target.x / width) * .5 + (target.y / height) * .2) * 450 + Math.random() * 180
          part.settle = Math.random() * 200
          part.p0x = part.x
          part.p0y = part.y
          // 첫 방향은 지금 떠다니던 속도를 이어받아 방향이 갑자기 꺾이지 않게 한다.
          part.p1x = part.x + part.vx * part.duration * .35 + dx * .3 + nx * swirl
          part.p1y = part.y + part.vy * part.duration * .35 + dy * .3 + ny * swirl
          part.p2x = target.x - dx * .25 + nx * swirl * .5
          part.p2y = target.y - dy * .25 + ny * swirl * .5
          part.p3x = target.x + (Math.random() - .5) * 2
          part.p3y = target.y + (Math.random() - .5) * 2
          part.armed = true
        }
        return true
      },
      release: () => {
        if (phase !== 'out') return
        phase = 'release'
        releaseAt = performance.now()
      },
    }
    registerLayer(layer)
    return () => {
      registerLayer(null)
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', fit)
    }
  }, [])

  return <canvas ref={ref} className="screen-fx" aria-hidden="true" />
}

/** 제목 글자가 차지한 자리에 점을 빽빽하게 뿌린다. 입자가 제목 쪽으로 더 많이 모이게 해서, 내용 전체에 고르게 흩어지는 것보다 제목이 먼저 읽히게 한다. */
function headlinePoints(element: Element) {
  const range = document.createRange()
  range.selectNodeContents(element)
  const rect = range.getBoundingClientRect()
  const points: Array<{ x: number; y: number }> = []
  if (rect.width < 2 || rect.height < 2) return points
  const count = Math.min(1400, Math.round(rect.width * rect.height / 9))
  for (let i = 0; i < count; i++) points.push({ x: rect.left + Math.random() * rect.width, y: rect.top + Math.random() * rect.height })
  return points
}

/**
 * 새 화면이 자기 모양(글자·테두리)을 입자 층에 알려 주고, 입자가 거의 도착할 즈음 화면이 서서히 나타나게 한다. 바로 앞 형제 요소가 그 화면이다.
 * 같은 단계 틀(StageShell)의 큰 제목이 보이는 상태면 제목도 도착지에 넣어 함께 나타나게 하고, 제목(h1·h2)에는 입자를 더 모은다.
 */
export function ArriveMorph() {
  const marker = useRef<HTMLElement>(null)

  useLayoutEffect(() => {
    const target = marker.current?.previousElementSibling as HTMLElement | null
    if (!target || !fx.active()) return
    const header = headerOf(target)
    const shown = [target, ...(header ? [header] : [])]
    shown.forEach(element => { element.classList.add('is-arriving'); element.style.opacity = '0' })
    return () => {
      shown.forEach(element => {
        element.classList.remove('is-arriving')
        element.style.opacity = ''
        element.style.transition = ''
      })
    }
  }, [])

  useEffect(() => {
    const target = marker.current?.previousElementSibling as HTMLElement | null
    if (!target || !fx.active()) return
    const header = headerOf(target)
    const shown = [target, ...(header ? [header] : [])]
    let showTimer = 0
    const timer = window.setTimeout(() => {
      // 입자 자리 계산은 화면의 자체 입장 애니메이션(확대 등)이 멈춘 뒤에 한다.
      const points = [...samplePoints(target), ...(header ? samplePoints(header) : [])]
      shown.forEach(element => element.querySelectorAll('h1,h2').forEach(heading => points.push(...headlinePoints(heading))))
      if (!fx.accept(points)) { shown.forEach(element => { element.style.opacity = '1' }); return }
      showTimer = window.setTimeout(() => {
        shown.forEach(element => { element.style.transition = 'opacity .8s ease'; element.style.opacity = '1' })
      }, 1200)
    }, 120)
    return () => { window.clearTimeout(timer); window.clearTimeout(showTimer) }
  }, [])

  return <i ref={marker} hidden />
}

/** 같은 단계 틀 안에서 보이는 큰 제목 머리글(숨겨져 있으면 없음). */
function headerOf(target: HTMLElement) {
  const header = target.closest('.flow-stage')?.querySelector<HTMLElement>('.flow-head') ?? null
  return header && !header.hidden ? header : null
}
