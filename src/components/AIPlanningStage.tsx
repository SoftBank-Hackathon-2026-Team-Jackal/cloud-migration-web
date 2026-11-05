'use client'

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { Target } from '../lib/stages'
import { shortDigest, type PlanIssue, type PlanPreviewData, type PlanResource, type PlanStepData, type SecurityRule } from '../lib/migration/events'
import { PLAN_FIRST_REVEAL_MS, PLAN_REVEAL_GAP_MS, PLAN_REVEAL_MS } from '../lib/migration/script'
import { useT, useTOr, type MsgKey, type TranslateOr } from '../lib/i18n'
import { ViewTabs } from './DiagramParts'
import PlanTopology from './PlanTopology'
import { issueText, placeText, stepText } from './planText'
import { LEDGER_GROUPS, SOURCE_FALLBACK, costViewOf, ledgerGroupOf, planSummary, planWarnings, targetEnvOf } from '../lib/migration/planModel'
import CostCompare from './CostCompare'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'

type PlanStep = PlanStepData

/** 리소스 이름·설명: 이벤트 값 → 대상별 사전 문구 → 공통 사전 문구 → id */
function resourceText(tOr: TranslateOr, resource: PlanResource, path: Target, field: 'name' | 'detail') {
  if (resource[field]) return resource[field]
  return tOr('plan.res.' + path + '.' + resource.id + '.' + field, tOr('plan.res.' + resource.id + '.' + field, field === 'name' ? resource.id : ''))
}
const roleText = (tOr: TranslateOr, role: string) => tOr('plan.role.' + role, role)

/** 경고 표시는 이 점 하나로만(찾은 내용 줄 · 리소스 줄 · 검증 칸이 같은 경고를 같은 모양으로) */
function WarnDot({ label }: { label?: string }) {
  return <i className="plan-warn-dot" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />
}

function Ledger({ preview, path, revealed, warnings }: { preview: PlanPreviewData; path: Target; revealed: number; warnings: PlanIssue[] }) {
  const t = useT()
  const tOr = useTOr()
  const groups = LEDGER_GROUPS.map(group => ({ group, rows: preview.resources.filter(resource => ledgerGroupOf(resource) === group) })).filter(item => item.rows.length > 0)
  let index = 0
  const warnOf = (id: string) => warnings.find(issue => issue.resource === id)
  return <div className="plan-ledger-wrap" style={{ '--rows': preview.resources.length, '--groups': groups.length } as CSSProperties}>
    <table className="plan-ledger">
      <thead><tr><th scope="col">{t('plan.col.resource')}</th><th scope="col" className="is-num">{t('plan.col.size')}</th><th scope="col" className="is-change">{t('plan.col.change')}</th></tr></thead>
      {groups.map(({ group, rows }) => <tbody key={group}>
        <tr className="plan-ledger-group"><th scope="rowgroup" colSpan={3}>{t(('plan.group.' + group) as MsgKey)}</th></tr>
        {rows.map(resource => {
          const order = index++
          const warn = warnOf(resource.id)
          return <tr key={resource.id} className={'plan-ledger-row plan-reveal' + (revealed > order ? ' is-visible' : '') + (resource.change === 'KEEP_SOURCE' ? ' is-keep' : '')}>
            <th scope="row">
              <span className="plan-cell-main">{resourceText(tOr, resource, path, 'name')}{warn && <WarnDot label={t('plan.warnAria', { text: issueText(tOr, warn) })} />}</span>
              <span className="plan-cell-sub">{resourceText(tOr, resource, path, 'detail') || resource.backend_name}{resource.defaulted && <em className="plan-default">{t('plan.defaulted')}</em>}</span>
            </th>
            <td className="is-num">
              <span className="plan-cell-main">{resource.size || '—'}</span>
              {resource.size_detail && <span className="plan-cell-sub">{resource.size_detail}</span>}
            </td>
            <td className="is-change"><span className={'plan-chip is-' + resource.change}>{t(('plan.change.' + resource.change) as MsgKey)}</span></td>
          </tr>
        })}
      </tbody>)}
    </table>
    <aside className="plan-wells">
      {/* 재매핑·보안 규칙은 백엔드 Preview에 없다(앱 Values·계획 입력에서 온다). 받지 못했으면 칸을 숨긴다. */}
      {preview.env_remap.length > 0 && <section className="plan-well" aria-labelledby="plan-well-env">
        <h3 id="plan-well-env">{t('plan.well.env')}</h3>
        <dl>{preview.env_remap.map(item => <div key={item.key}>
          <dt><code>{item.key}</code></dt>
          <dd>{item.keep ? <span className="plan-muted">{t('plan.env.keep')}</span>
            : item.secret ? <><svg className="plan-lock" viewBox="0 0 10 11" role="img" aria-label={t('plan.env.secretAria')}><rect x="1" y="4.5" width="8" height="6" rx="1" /><path d="M3 4.5V3a2 2 0 0 1 4 0v1.5" /></svg><code>{item.to}</code></>
            : <code>{item.to}</code>}</dd>
        </div>)}</dl>
        <p>{t('plan.well.envNote')}</p>
      </section>}
      {preview.security_rules.length > 0 && <section className="plan-well" aria-labelledby="plan-well-sec">
        <h3 id="plan-well-sec">{t('plan.well.security')}</h3>
        <dl>{preview.security_rules.map((rule: SecurityRule, ruleIndex) => <div key={ruleIndex}>
          <dt>{rule.from === '*' && rule.to === '*' ? roleText(tOr, '*') : roleText(tOr, rule.from) + ' → ' + roleText(tOr, rule.to)}</dt>
          <dd>{rule.action === 'DENY' ? t('plan.rule.deny') : rule.port === null ? <span aria-label={t('plan.rule.allAria')}>*</span> : rule.port}</dd>
        </div>)}</dl>
      </section>}
      <section className="plan-well" aria-labelledby="plan-well-val">
        <h3 id="plan-well-val">{t('plan.well.validation')}</h3>
        <dl>
          <div><dt>{t('plan.val.errors')}</dt><dd>{preview.validation.errors.length}</dd></div>
          <div><dt>{t('plan.val.warnings')}</dt><dd>{warnings.length > 0 && <WarnDot />}{warnings.length}</dd></div>
        </dl>
        {preview.validation.errors.map(issue => <p key={issue.id} className="plan-issue is-error">{issueText(tOr, issue)}</p>)}
        {warnings.map(issue => <p key={issue.id} className="plan-issue">{issueText(tOr, issue)}</p>)}
        {(preview.pending_decisions ?? []).map(issue => <p key={'pd-' + issue.id} className="plan-issue is-pending">{tOr('approval.pending.' + issue.id, issueText(tOr, issue))}</p>)}
        {preview.validation.errors.length === 0 && warnings.length === 0 && <p>{t('plan.val.clean')}</p>}
      </section>
    </aside>
  </div>
}

function MappingTable({ steps, target, revealed }: { steps: PlanStep[]; target: Target; revealed: number }) {
  const t = useT()
  const tOr = useTOr()
  const groups = (['infrastructure', 'code'] as const).map(group => ({ group, rows: steps.filter(step => step.group === group) })).filter(item => item.rows.length > 0)
  return <div className="plan-ledger-wrap is-single" style={{ '--rows': steps.length, '--groups': groups.length } as CSSProperties}>
    <table className="plan-ledger plan-mapping">
      <thead><tr>
        <th scope="col">{t('plan.col.mapping')}</th><th scope="col">{t('plan.col.grade')}</th><th scope="col">{t('plan.col.action')}</th><th scope="col" className="is-verify">{t('plan.col.verify')}</th>
      </tr></thead>
      {groups.map(({ group, rows }) => <tbody key={group}>
        <tr className="plan-ledger-group"><th scope="rowgroup" colSpan={4}>{t(('plan.group.' + group) as MsgKey)}</th></tr>
        {rows.map(step => {
          const order = steps.indexOf(step)
          return <tr key={step.id} className={'plan-ledger-row plan-reveal' + (revealed > order ? ' is-visible' : '') + (step.keep_source ? ' is-keep' : '')}>
            <th scope="row">
              <span className="plan-cell-main"><span className="plan-before">{stepText(tOr, step, target, 'before')}</span><b aria-hidden="true">→</b><span>{step.keep_source ? t('plan.keep') : stepText(tOr, step, target, 'after')}</span></span>
              <span className="plan-cell-sub">{stepText(tOr, step, target, 'evidence')}</span>
            </th>
            {/* 원본 유지 항목은 옮기지 않으므로 등급 대신 원본 유지로만 보인다 */}
            <td>{step.keep_source
              ? <span className="plan-chip is-KEEP_SOURCE">{t('plan.keep')}</span>
              : <span className={'plan-chip is-grade-' + step.grade}>{t(('plan.grade.' + step.grade) as MsgKey)}</span>}</td>
            <td>{step.keep_source ? <span className="plan-muted">—</span> : <span className={'plan-action is-' + step.action}>{t(('plan.action.' + step.action) as MsgKey)}</span>}</td>
            <td className="is-verify"><span className={'plan-verify is-' + step.verification}>{t(('plan.verify.' + step.verification) as MsgKey)}</span></td>
          </tr>
        })}
      </tbody>)}
    </table>
  </div>
}

// 항목을 하나씩 드러내는 연출 시간. 데이터는 이벤트로 먼저 와 있어도 화면은 이 간격으로 천천히 보여 준다.
const FIRST_REVEAL = PLAN_FIRST_REVEAL_MS
const REVEAL_GAP = PLAN_REVEAL_GAP_MS
const FLOW_END = PLAN_REVEAL_MS
// 서버가 항목을 몇 개 보내든 연출 타이머는 이 개수까지만 건다.
const MAX_REVEAL = 12

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

export default function AIPlanningStage({ target, onNext }: { target: Target; onNext: () => void }) {
  const { state } = useMigration()
  const analysis = state.analysis.findings
  // 계획 항목·미리보기는 데이터 계층에서 받는다. 화면이 열리면 바로 시작한다.
  useStageFeed('planning', true, target)
  const steps = state.plan.steps
  const preview = state.plan.preview
  const t = useT()
  const tOr = useTOr()
  const stageRef = useRef<HTMLElement>(null)
  const [revealed, setRevealed] = useState(0)
  const [swapped, setSwapped] = useState(false)
  const [coreReady, setCoreReady] = useState(false)
  const [view, setView] = useState<'ledger' | 'mapping' | 'diagram' | 'cost'>('ledger')
  // 분석 결과 없이 바로 이 화면을 연 경우(시연용 단계 이동)에는 분석이 끝난 것으로 보여 준다.
  const streams = [...analysis.map(update => update.stream), ...state.analysis.scans.map(scan => scan.stream)]
  const hasInfra = streams.length === 0 || streams.includes('infrastructure')
  const hasCode = streams.length === 0 || streams.includes('code')

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setCoreReady(true)
      setRevealed(MAX_REVEAL)
      return
    }
    const timers = [window.setTimeout(() => setCoreReady(true), 1400), ...Array.from({ length: MAX_REVEAL }, (_, index) =>
      window.setTimeout(() => setRevealed(index + 1), FIRST_REVEAL + index * REVEAL_GAP))]
    return () => timers.forEach(timer => window.clearTimeout(timer))
  }, [])
  // 받은 줄 중 연출이 드러낸 만큼만 보인다. 완료는 서버가 "계획 끝"을 알리고 모든 줄(매핑·리소스 중 많은 쪽)이 드러난 뒤다.
  const units = Math.max(steps.length, preview?.resources.length ?? 0)
  const visibleCount = Math.min(revealed, units)
  const complete = state.plan.ready && units > 0 && visibleCount === units

  const path: Target = target === 'onprem' ? 'onprem' : 'gcp'
  const revision = preview?.revision ?? state.plan.meta?.revision ?? 1
  const planId = preview?.plan_id ?? state.plan.meta?.plan_id
  const summary = planSummary(steps)
  const warnings = planWarnings(preview)
  const errors = preview?.validation.errors.length ?? 0
  // 새로 만듦 = 만들거나(CREATE) 검증한 이미지로 배포(PINNED). 기존 사용·바꿈·지움은 세지 않는다.
  const creating = preview?.resources.filter(resource => resource.change === 'CREATE' || resource.change === 'PINNED').length ?? 0
  const keeping = preview ? preview.resources.filter(resource => resource.change === 'KEEP_SOURCE').length : summary.keep
  const source = placeText(tOr, preview?.source ?? SOURCE_FALLBACK)
  const destination = preview?.target ? placeText(tOr, preview.target) : { provider: t(('target.' + target) as MsgKey), place: preview ? placeText(tOr, targetEnvOf(preview, target)).place : '' }
  const digest = shortDigest(state.plan.meta?.verified_digest ?? state.plan.meta?.built_digest ?? state.build.result?.digest)
  const tabs = [
    { id: 'ledger' as const, label: t('plan.tab.ledger') },
    { id: 'mapping' as const, label: t('plan.tab.mapping') },
    { id: 'diagram' as const, label: t('plan.tab.diagram') },
    { id: 'cost' as const, label: t('tab.cost') },
  ]
  const summaryParts = [
    t('plan.summary.total', { n: summary.total }),
    t('plan.summary.proceed', { n: summary.proceed }),
    ...(summary.approval > 0 ? [t('plan.summary.approval', { n: summary.approval })] : []),
    t('plan.summary.keep', { n: summary.keep }),
    t('plan.summary.block', { n: summary.block }),
  ]

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
        {planId && <p className="plan-meta">{t('plan.meta', { id: planId, n: revision })}</p>}
        <h1>{t('plan.title')}</h1>
        <p className="plan-finding">{preview
          ? <>
              <span>{t('plan.finding.create', { n: creating })}</span>
              <span>{t('plan.finding.keep', { n: keeping })}</span>
              <span>{errors > 0 ? t('plan.finding.errors', { n: errors }) : t('plan.finding.noErrors')}{', '}
                {warnings.length > 0 ? <><WarnDot />{t('plan.finding.warnings', { n: warnings.length })}</> : t('plan.finding.noWarnings')}</span>
            </>
          : steps.length > 0
            ? <><span>{t('plan.finding.mappings', { n: steps.length })}</span><span>{t('plan.finding.keep', { n: summary.keep })}</span></>
            : <span>{t('plan.finding.waiting')}</span>}</p>
      </header>
      <div className="plan-bar">
        <ViewTabs label={t('plan.tabs.aria')} value={view} variant="segmented" onChange={next => { setSwapped(true); setView(next) }} items={tabs} />
        <p className="plan-route" aria-label={t('plan.route.aria')}>
          <span>{source.provider} {source.place}</span><b aria-hidden="true">→</b><span>{destination.provider} {destination.place}</span>
        </p>
      </div>
      <div className={'plan-changes plan-body' + (swapped ? ' is-swapped' : '') + ' is-' + view}>
        {view === 'ledger' && (preview
          ? <Ledger key="ledger" preview={preview} path={path} revealed={visibleCount} warnings={warnings} />
          : <p className="plan-empty">{t('plan.preview.empty')}</p>)}
        {view === 'mapping' && <MappingTable key="mapping" steps={steps} target={target} revealed={visibleCount} />}
        {view === 'diagram' && <div key="diagram" className="plan-topo">
          <PlanTopology textOf={(step, field) => stepText(tOr, step, target, field)} steps={steps} preview={preview} digest={digest} revealed={visibleCount} sourceLabel={source} targetLabel={destination} />
          <ul className="plan-topo-legend">
            <li><i className="is-flow" />{t('plan.diagram.legendFlow')}</li>
            <li><i className="is-planned" />{t('plan.diagram.legendPlanned')}</li>
            <li><i className="is-keep" />{t('plan.diagram.legendKeep')}</li>
            {digest && <li><i className="is-lock" />{t('plan.diagram.legendLock')}</li>}
          </ul>
        </div>}
        {view === 'cost' && <div key="cost" className="plan-cost"><CostCompare target={target} cost={costViewOf(state, target)} /></div>}
      </div>
      <footer className="plan-foot">
        <p className="plan-status" aria-live="polite">
          <span className={'plan-status-dot' + (complete ? ' is-complete' : '')} aria-hidden="true" />
          {complete
            ? <span className="plan-summary">{summaryParts.map(part => <span key={part}>{part}</span>)}</span>
            : <>{t('plan.working')}<small>{visibleCount} / {units || '—'}</small></>}
        </p>
        <div className="plan-next">
          <button type="button" className="flow-primary" disabled={!complete} onClick={onNext}>{t('plan.next')} <span aria-hidden="true">→</span></button>
        </div>
      </footer>
    </div>
    <PlanParticleFlow stage={stageRef} />
  </section>
}
