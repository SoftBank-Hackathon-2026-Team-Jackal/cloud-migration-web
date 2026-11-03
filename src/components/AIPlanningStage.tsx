'use client'

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { AnalysisUpdate } from './AnalysisStage'
import type { Target } from '../lib/stages'
import { useT, type MsgKey, type Translate } from '../lib/i18n'
import { ViewTabs } from './DiagramParts'

type PlanStep = { id: string; group: 'infrastructure' | 'code' }

const PLAN_STEPS: PlanStep[] = [
  { id: 'network', group: 'infrastructure' },
  { id: 'compute', group: 'infrastructure' },
  { id: 'database', group: 'infrastructure' },
  { id: 'storage', group: 'infrastructure' },
  { id: 'db-code', group: 'code' },
  { id: 's3-code', group: 'code' },
]

// GCP 대상일 때만 문구가 다른 항목(사전에 gcpAfter / gcpChange 키가 있는 것)
const GCP_AFTER = new Set(['network', 'compute'])
const GCP_CHANGE = new Set(['network'])

type Grade = 'direct' | 'convert' | 'none'

// 매핑 등급(11/2 회의): 대상에 그대로 쓸 수 있으면 직접 대응, 대응물이 없으면 MVP에서 제외. 가운데 등급은 화면용 제안.
function gradeOf(step: PlanStep, target: Target): Grade {
  switch (step.id) {
    case 'network': case 'db-code': return 'convert'
    case 'storage': case 's3-code': return target === 'gcp' ? 'direct' : 'none'
    default: return 'direct'
  }
}

function stepsFor(_target: Target): PlanStep[] {
  return PLAN_STEPS
}

function stepText(t: Translate, step: PlanStep, target: Target, field: 'before' | 'after' | 'evidence' | 'change') {
  const gcp = target === 'gcp'
  if (field === 'after' && gcp && GCP_AFTER.has(step.id)) return t(('plan.step.' + step.id + '.gcpAfter') as MsgKey)
  if (field === 'change' && gcp && GCP_CHANGE.has(step.id)) return t(('plan.step.' + step.id + '.gcpChange') as MsgKey)
  return t(('plan.step.' + step.id + '.' + field) as MsgKey)
}

const FIRST_REVEAL = 2550
const REVEAL_GAP = 720
const FLOW_END = FIRST_REVEAL + PLAN_STEPS.length * REVEAL_GAP + 850

// 입자는 "어느 기준점에서 얼마나 떨어져 있는가"만 기억하고, 기준점(원·구체·문서)의 실제 위치는 매 프레임 읽는다.
// 구체가 커지거나 원이 둥둥 떠다니거나 창 크기가 바뀌어도 입자가 항상 제자리로 들어간다.
type Particle = { kind: 0 | 1 | 2; sox: number; soy: number; eox: number; eoy: number; c1y: number; c2y: number; phase: number; delay: number; duration: number; size: number; shade: string }

function PlanParticleFlow({ stage }: { stage: RefObject<HTMLElement | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const host = stage.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !host || !ctx || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let frame = 0
    let started = performance.now()
    let width = 0
    let height = 0
    const particles: Particle[] = []
    const centerOf = (selector: string, parent: DOMRect) => {
      const rect = host.querySelector(selector)?.getBoundingClientRect()
      return rect ? { x: rect.left + rect.width / 2 - parent.left, y: rect.top + rect.height / 2 - parent.top, w: rect.width, left: rect.left - parent.left } : null
    }
    const unitDisc = () => {
      const angle = Math.random() * Math.PI * 2
      const radius = Math.sqrt(Math.random())
      return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
    }
    const build = () => {
      particles.length = 0
      for (const kind of [0, 1] as const) {
        for (let i = 0; i < 2500; i++) {
          const start = unitDisc()
          const end = unitDisc()
          particles.push({ kind, sox: start.x * 17, soy: start.y * 17, eox: end.x, eoy: end.y, c1y: (Math.random() - .5) * 25, c2y: (Math.random() - .5) * 25, phase: Math.random() * Math.PI * 2, delay: 100 + Math.random() * (FLOW_END - 1700), duration: 950 + Math.random() * 550, size: Math.random() * .9 + .65, shade: Math.random() < .2 ? '#b0b0b0' : '#666' })
        }
      }
      // 나가는 흐름은 문서 앞 여백에서 끝나고, 항목은 따로따로 나타난다.
      for (let i = 0; i < 3000; i++) {
        const start = unitDisc()
        particles.push({ kind: 2, sox: start.x, soy: start.y, eox: -(14 + Math.random() * 30), eoy: (Math.random() - .5) * 90, c1y: (Math.random() - .5) * 24, c2y: (Math.random() - .5) * 24, phase: Math.random() * Math.PI * 2, delay: 1650 + Math.random() * (FLOW_END - 2800), duration: 690 + Math.random() * 500, size: Math.random() * .9 + .65, shade: Math.random() < .2 ? '#b0b0b0' : '#666' })
      }
    }
    const resize = () => {
      const ratio = Math.min(devicePixelRatio || 1, 2)
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    }
    const draw = (now: number) => {
      const elapsed = now - started
      const parent = host.getBoundingClientRect()
      const sources = [centerOf('.plan-source-infra .plan-source-orb', parent), centerOf('.plan-source-code .plan-source-orb', parent)]
      const core = centerOf('.plan-core', parent)
      const documentArea = centerOf('.plan-document', parent)
      ctx.clearRect(0, 0, width, height)
      if (core && documentArea && sources[0] && sources[1]) {
        // 입자는 구체·문서 사이 여백 안에서만 보인다(문서 글자 위로 넘어가지 않게 자른다).
        ctx.save()
        ctx.beginPath()
        ctx.rect(0, 0, Math.max(0, documentArea.left - 6), height)
        ctx.clip()
        // 구체는 처음에 작게 나타나므로, 입자가 모이는 폭은 완성된 크기 기준으로 잡는다.
        const coreWidth = Math.max(core.w, 96)
        for (const p of particles) {
          const progress = (elapsed - p.delay) / p.duration
          if (progress <= 0 || progress >= 1) continue
          const origin = p.kind === 2 ? core : sources[p.kind]!
          const sx = origin.x + (p.kind === 2 ? p.sox * coreWidth * .28 : p.sox)
          const sy = origin.y + (p.kind === 2 ? p.soy * coreWidth * .28 : p.soy)
          const ex = p.kind === 2 ? documentArea.left + p.eox : core.x + p.eox * Math.min(coreWidth, 120) * .27
          const ey = p.kind === 2 ? core.y + p.eoy : core.y + p.eoy * Math.min(coreWidth, 120) * .27
          const distance = ex - sx
          const t = progress * progress * (3 - 2 * progress)
          const inverse = 1 - t
          const c1x = sx + distance * (p.kind === 2 ? .35 : .39)
          const c2x = ex - distance * (p.kind === 2 ? .27 : .32)
          const x = inverse ** 3 * sx + 3 * inverse ** 2 * t * c1x + 3 * inverse * t ** 2 * c2x + t ** 3 * ex
          const y = inverse ** 3 * sy + 3 * inverse ** 2 * t * (sy + p.c1y) + 3 * inverse * t ** 2 * (ey + p.c2y) + t ** 3 * ey
            + Math.sin(progress * Math.PI) * Math.sin(p.phase + progress * 9) * 5
          ctx.globalAlpha = Math.min(1, progress * 5, (1 - progress) * 5) * .47
          ctx.fillStyle = p.shade
          ctx.beginPath()
          ctx.arc(x, y, p.size, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.restore()
      }
      ctx.globalAlpha = 1
      if (elapsed < FLOW_END) frame = requestAnimationFrame(draw)
    }
    build()
    resize()
    started = performance.now()
    frame = requestAnimationFrame(draw)
    window.addEventListener('resize', resize)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', resize) }
  }, [stage])
  return <canvas ref={canvasRef} className="plan-particle-flow" aria-hidden="true" />
}

export default function AIPlanningStage({ analysis, target, onNext }: { analysis: AnalysisUpdate[]; target: Target; onNext: () => void }) {
  const t = useT()
  const stageRef = useRef<HTMLElement>(null)
  const [visibleCount, setVisibleCount] = useState(0)
  const [swapped, setSwapped] = useState(false)
  const [coreReady, setCoreReady] = useState(false)
  const [view, setView] = useState<'list' | 'mapping'>('list')
  // 분석 결과 없이 바로 이 화면을 연 경우(시연용 단계 이동)에는 분석이 끝난 것으로 보여 준다.
  const hasInfra = analysis.length === 0 || analysis.some(update => update.stream === 'infrastructure')
  const hasCode = analysis.length === 0 || analysis.some(update => update.stream === 'code')
  const steps = useMemo(() => stepsFor(target), [target])

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setCoreReady(true)
      setVisibleCount(steps.length)
      return
    }
    const timers = [window.setTimeout(() => setCoreReady(true), 1400), ...steps.map((_, index) =>
      window.setTimeout(() => setVisibleCount(index + 1), FIRST_REVEAL + index * REVEAL_GAP))]
    return () => timers.forEach(timer => window.clearTimeout(timer))
  }, [steps])

  return <section ref={stageRef} className="plan-stage" aria-label={t('plan.aria')}>
    <div className="plan-visual" aria-hidden="true">
      <div className="plan-source plan-source-infra">
        <span className="plan-source-orb"><span>◫</span></span>
        <strong>{t('plan.srcInfra')}</strong>
        <small>{hasInfra ? t('plan.srcInfraDone') : t('plan.srcWait')}</small>
      </div>
      <div className="plan-source plan-source-code">
        <span className="plan-source-orb"><span>⌘</span></span>
        <strong>{t('plan.srcCode')}</strong>
        <small>{hasCode ? t('plan.srcCodeDone') : t('plan.srcWait')}</small>
      </div>
      <div className={'plan-core' + (coreReady ? ' is-ready' : '')}>
        <span className="plan-core-ring plan-core-ring-one" />
        <span className="plan-core-ring plan-core-ring-two" />
        <span className="plan-core-light" />
      </div>
      <p className="plan-core-caption">{t('plan.caption')}</p>
    </div>

    <div className="plan-document">
      <header className="plan-heading">
        <small>AI PLANNER + CODE ADAPTER <span>DEMO</span></small>
        <h1>{t('plan.title')}</h1>
        <p>{t('plan.lead')}</p>
        <div className="plan-target"><span>{t('plan.from')}</span><strong>{t('plan.fromValue')}</strong><i>→</i><span>{t('plan.to')}</span><strong>{t(('target.' + target) as MsgKey)}</strong><small>{t('plan.example')}</small></div>
      </header>
      <div className={'plan-changes' + (swapped ? ' is-swapped' : '')}>
        <div className="plan-view-bar">
          <ViewTabs label={t('tab.aria')} value={view} onChange={next => { setSwapped(true); setView(next) }}
            items={[{ id: 'list', label: t('tab.list') }, { id: 'mapping', label: t('tab.mapping') }]} />
        </div>
        {view === 'mapping' && <div className="map-list" role="list" aria-label={t('map.aria')}>
          <div className="map-head"><span>{t('map.from')}</span><span /><span>{t('map.to', { target: t(('target.' + target) as MsgKey) })}</span></div>
          {steps.map((step, index) => <div key={step.id} role="listitem" className={'map-row' + (visibleCount > index ? ' is-visible' : '')}>
            <div className="map-card">{stepText(t, step, target, 'before')}</div>
            <div className={'map-link is-' + gradeOf(step, target)}><span className={'plan-grade is-' + gradeOf(step, target)}>{t(('plan.grade.' + gradeOf(step, target)) as MsgKey)}</span></div>
            <div className="map-card is-after">{stepText(t, step, target, 'after')}</div>
          </div>)}
        </div>}
        {view === 'list' && (['infrastructure', 'code'] as const).map(group => <section className="plan-change-group" key={group}>
          <h2>{group === 'infrastructure' ? t('plan.groupInfra') : t('plan.groupCode')}</h2>
          {steps.map((step, index) => step.group !== group ? null : <article key={step.id} data-step={index}
            className={'plan-change' + (visibleCount > index ? ' is-visible' : '')}>
            <span className="plan-change-index">{String(index + 1).padStart(2, '0')}</span>
            <div className="plan-change-body">
              <strong><span>{stepText(t, step, target, 'before')}</span><b aria-hidden="true">→</b><span>{stepText(t, step, target, 'after')}</span></strong>
              <p className="plan-evidence">{t('plan.evidence', { text: stepText(t, step, target, 'evidence') })}</p>
              <p>{stepText(t, step, target, 'change')}</p>
              <p className="plan-grade-row"><small>{t('plan.grade.title')}</small><span className={'plan-grade is-' + gradeOf(step, target)}>{t(('plan.grade.' + gradeOf(step, target)) as MsgKey)}</span></p>
            </div>
          </article>)}
        </section>)}
      </div>
      <div className="plan-status" aria-live="polite">
        <span className={visibleCount === steps.length ? 'is-complete' : ''} />
        {visibleCount === steps.length ? t('plan.done') : t('plan.working')}
        <small>{visibleCount} / {steps.length}</small>
      </div>
      <div className="plan-next">
        <button type="button" className="flow-primary" disabled={visibleCount !== steps.length} onClick={onNext}>{t('plan.next')} <span aria-hidden="true">→</span></button>
      </div>
    </div>
    <PlanParticleFlow stage={stageRef} />
  </section>
}
