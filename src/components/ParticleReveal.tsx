'use client'

import { useEffect, useRef, type RefObject } from 'react'
import { fx, samplePoints } from '../lib/particleHandoff'

type TransitionParticle = {
  x: number
  y: number
  startX: number
  startY: number
  delay: number
  group: number
  bright: boolean
}

export default function ParticleReveal({ stage, onComplete }: { stage: RefObject<HTMLElement | null>; onComplete: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const completeRef = useRef(onComplete)
  useEffect(() => { completeRef.current = onComplete }, [onComplete])

  useEffect(() => {
    const canvas = canvasRef.current
    const host = stage.current
    if (!canvas || !host) return
    const context = canvas.getContext('2d')
    if (!context) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      completeRef.current()
      return
    }
    let frame = 0
    let finished = false

    const prepare = () => {
      if (finished) return
      cancelAnimationFrame(frame)
      const width = Math.max(1, canvas.clientWidth)
      const height = Math.max(1, canvas.clientHeight)
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)

      const elements = Array.from(host.querySelectorAll<HTMLElement>('[data-particle-target]'))
      const particles: TransitionParticle[] = []
      const addParticle = (x: number, y: number, group: number) => {
        const angle = Math.random() * Math.PI * 2
        const radius = Math.min(width, height) * (.04 + Math.random() * .25)
        particles.push({
          x, y,
          startX: width / 2 + Math.cos(angle) * radius,
          startY: height / 2 + Math.sin(angle) * radius,
          delay: Math.random() * 280 + Math.min(group, 12) * 70,
          group,
          bright: Math.random() < .22,
        })
      }

      elements.forEach((element, group) => {
        const rect = element.getBoundingClientRect()
        const kind = element.dataset.particleTarget
        if (rect.width < 2 || rect.height < 2) return
        if (kind === 'text') {
          const mask = document.createElement('canvas')
          mask.width = Math.ceil(rect.width)
          mask.height = Math.ceil(rect.height)
          const maskContext = mask.getContext('2d')
          if (!maskContext) return
          const computed = window.getComputedStyle(element)
          maskContext.font = computed.font
          maskContext.textBaseline = 'middle'
          maskContext.fillText(element.textContent || '', 0, rect.height / 2)
          const pixels = maskContext.getImageData(0, 0, mask.width, mask.height).data
          for (let y = 0; y < mask.height; y += 2) {
            for (let x = 0; x < mask.width; x += 2) {
              if (pixels[(y * mask.width + x) * 4 + 3] > 120) addParticle(rect.left + x, rect.top + y, group)
            }
          }
        } else if (kind === 'line') {
          for (let x = 0; x < rect.width; x += 2) {
            addParticle(rect.left + x, rect.top + rect.height / 2 + (Math.random() - .5) * 5, group)
          }
        } else if (kind === 'circle') {
          const centerX = rect.left + rect.width / 2
          const centerY = rect.top + rect.height / 2
          for (let angle = 0; angle < Math.PI * 2; angle += .045) {
            addParticle(centerX + Math.cos(angle) * rect.width * .48, centerY + Math.sin(angle) * rect.height * .48, group)
          }
          for (let i = 0; i < 130; i++) {
            const angle = Math.random() * Math.PI * 2
            const radius = Math.sqrt(Math.random()) * .45
            addParticle(centerX + Math.cos(angle) * rect.width * radius, centerY + Math.sin(angle) * rect.height * radius, group)
          }
        } else {
          for (let x = 0; x < rect.width; x += 3) {
            addParticle(rect.left + x, rect.top, group)
            addParticle(rect.left + x, rect.bottom, group)
          }
          for (let y = 0; y < rect.height; y += 3) {
            addParticle(rect.left, rect.top + y, group)
            addParticle(rect.right, rect.top + y, group)
          }
          const interior = Math.min(1500, Math.round(rect.width * rect.height / 110))
          for (let i = 0; i < interior; i++) {
            addParticle(rect.left + Math.random() * rect.width, rect.top + Math.random() * rect.height, group)
          }
        }
      })
      const sampled = particles.length
      for (let i = sampled; i < 18000 && sampled > 0; i++) {
        const target = particles[Math.floor(Math.random() * sampled)]
        addParticle(target.x + (Math.random() - .5) * 5, target.y + (Math.random() - .5) * 5, target.group)
      }

      // 앞 화면에서 이어지는 전환이면, 입자는 화면 전환 층이 그려 준다(끊김 없이 이어지도록).
      // 여기서는 새 화면의 글자·테두리 자리를 알려 주고, 글자가 나타나는 타이밍만 맡는다.
      if (fx.active() && fx.accept([...particles, ...samplePoints(host)])) {
        const handedAt = performance.now()
        elements.forEach(element => { element.style.opacity = '0' })
        const tick = (now: number) => {
          const elapsed = now - handedAt
          elements.forEach((element, group) => {
            element.style.opacity = String(Math.max(0, Math.min(1, (elapsed - 1200 - Math.min(group, 12) * 60) / 700)))
          })
          if (elapsed < 1800) {
            frame = requestAnimationFrame(tick)
          } else {
            finished = true
            elements.forEach(element => { element.style.opacity = '' })
            completeRef.current()
          }
        }
        frame = requestAnimationFrame(tick)
        return
      }

      const startAlpha = .4
      const speed = 1
      const began = performance.now()
      const draw = (now: number) => {
        const elapsed = (now - began) * speed
        context.clearRect(0, 0, width, height)
        elements.forEach((element, group) => {
          const reveal = Math.max(0, Math.min(1, (elapsed - 1580 - Math.min(group, 12) * 70) / 700))
          element.style.opacity = String(reveal)
        })
        for (const particle of particles) {
          const progress = Math.max(0, Math.min(1, (elapsed - particle.delay) / 2050))
          const eased = progress * progress * (3 - 2 * progress)
          const reveal = Math.max(0, Math.min(1, (elapsed - 1580 - Math.min(particle.group, 12) * 70) / 700))
          const sway = (1 - eased) * 12
          const x = particle.startX + (particle.x - particle.startX) * eased + Math.sin(elapsed * .004 + particle.delay) * sway
          const y = particle.startY + (particle.y - particle.startY) * eased + Math.cos(elapsed * .003 + particle.delay) * sway
          context.globalAlpha = (startAlpha + eased * (.95 - startAlpha)) * (1 - reveal)
          context.fillStyle = particle.bright ? '#aaa' : '#2b2b2b'
          context.fillRect(x, y, particle.bright ? 2 : 1.5, particle.bright ? 2 : 1.5)
        }
        context.globalAlpha = 1
        if (elapsed < 3200) {
          frame = requestAnimationFrame(draw)
        } else {
          finished = true
          elements.forEach(element => { element.style.opacity = '' })
          completeRef.current()
        }
      }
      frame = requestAnimationFrame(draw)
    }

    window.addEventListener('resize', prepare)
    prepare()
    return () => {
      window.removeEventListener('resize', prepare)
      cancelAnimationFrame(frame)
    }
  }, [stage])

  return <canvas ref={canvasRef} className="analysis-particle-reveal" aria-hidden="true" />
}
