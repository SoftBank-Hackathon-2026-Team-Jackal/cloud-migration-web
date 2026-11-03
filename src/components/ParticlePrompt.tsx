'use client'

import { useEffect, useRef, useState } from 'react'
import { useT } from '../lib/i18n'

type Particle = {
  x: number
  y: number
  startX: number
  startY: number
  phase: number
  bright: boolean
}

export default function ParticlePrompt({ onComplete }: { onComplete: () => void }) {
  const t = useT()
  const greeting = t('prompt.greeting')
  const question = t('prompt.question')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const labelRef = useRef<HTMLParagraphElement>(null)
  const completeRef = useRef(onComplete)
  const [settled, setSettled] = useState(false)
  useEffect(() => { completeRef.current = onComplete }, [onComplete])

  useEffect(() => {
    const canvas = canvasRef.current
    const label = labelRef.current
    if (!canvas || !label) return
    const context = canvas.getContext('2d')
    if (!context) return
    let frame = 0
    let completed = false
    let finishTimer = 0

    const prepare = () => {
      if (completed) return
      cancelAnimationFrame(frame)
      const width = Math.max(1, Math.round(canvas.clientWidth))
      const height = Math.max(1, Math.round(canvas.clientHeight))
      const canvasRect = canvas.getBoundingClientRect()
      const labelRect = label.getBoundingClientRect()
      const narrow = width < 620
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)

      const maskWidth = Math.max(1, Math.round(labelRect.width))
      const maskHeight = Math.max(1, Math.round(labelRect.height))
      const mask = document.createElement('canvas')
      mask.width = maskWidth
      mask.height = maskHeight
      const maskContext = mask.getContext('2d')
      if (!maskContext) return
      const lines = narrow
        ? [greeting, question]
        : [greeting + ' ' + question]
      let fontSize = narrow ? Math.min(24, Math.max(18, width * .045)) : 36
      maskContext.textAlign = 'center'
      maskContext.textBaseline = 'middle'
      while (fontSize > 16) {
        maskContext.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "Noto Sans KR", "Noto Sans JP", sans-serif`
        if (lines.every(line => maskContext.measureText(line).width <= maskWidth - 12)) break
        fontSize -= 1
      }
      label.style.fontSize = `${fontSize}px`
      maskContext.fillStyle = '#000'
      lines.forEach((line, index) => {
        const y = narrow ? maskHeight * (index === 0 ? .29 : .71) : maskHeight * .5
        maskContext.fillText(line, maskWidth / 2, y)
      })

      const pixels = maskContext.getImageData(0, 0, maskWidth, maskHeight).data
      const particles: Particle[] = []
      const step = narrow ? 2 : 3
      const offsetX = labelRect.left - canvasRect.left
      const offsetY = labelRect.top - canvasRect.top
      for (let y = 0; y < maskHeight; y += step) {
        for (let x = 0; x < maskWidth; x += step) {
          if (pixels[(y * maskWidth + x) * 4 + 3] < 120) continue
          const edge = particles.length % 4
          const startX = edge === 0 || edge === 2 ? Math.random() * width : edge === 1 ? width - 1 : 1
          const startY = edge === 1 || edge === 3 ? Math.random() * height : edge === 0 ? 1 : height - 1
          particles.push({
            x: offsetX + x,
            y: offsetY + y,
            startX,
            startY,
            phase: Math.random(),
            bright: Math.random() < .15,
          })
        }
      }

      const began = performance.now()
      const draw = (now: number) => {
        const elapsed = now - began
        context.clearRect(0, 0, width, height)
        const blend = Math.max(0, Math.min(1, (elapsed - 1750) / 700))
        label.style.opacity = `${blend}`
        for (const particle of particles) {
          const progress = Math.max(0, Math.min(1, (elapsed - particle.phase * 300) / 1900))
          const eased = progress * (1.15 - .15 * progress)
          const sway = (1 - eased) * 13
          const px = particle.startX + (particle.x - particle.startX) * eased + Math.sin(elapsed * .004 + particle.phase * 25) * sway
          const py = particle.startY + (particle.y - particle.startY) * eased + Math.cos(elapsed * .003 + particle.phase * 20) * sway
          context.globalAlpha = (.2 + eased * .8) * (1 - blend)
          context.fillStyle = particle.bright ? '#777777' : '#202020'
          context.beginPath()
          context.arc(px, py, particle.bright ? 1.25 : 1.05, 0, Math.PI * 2)
          context.fill()
        }
        context.globalAlpha = 1
        if (elapsed < 2450) {
          frame = requestAnimationFrame(draw)
        } else if (!completed) {
          completed = true
          label.style.opacity = '1'
          setSettled(true)
          finishTimer = window.setTimeout(() => completeRef.current(), 180)
        }
      }
      frame = requestAnimationFrame(draw)
    }

    const observer = new ResizeObserver(prepare)
    observer.observe(canvas)
    window.addEventListener('resize', prepare)
    prepare()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', prepare)
      cancelAnimationFrame(frame)
      window.clearTimeout(finishTimer)
    }
  }, [greeting, question])

  return <div className={`particle-prompt${settled ? ' is-settled' : ''}`}>
    <canvas ref={canvasRef} className="particle-prompt-text" aria-hidden="true" />
    <p ref={labelRef} className="particle-prompt-label" aria-hidden={!settled}>
      {greeting} <span>{question}</span>
    </p>
  </div>
}
