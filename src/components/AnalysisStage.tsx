'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import ParticleReveal from './ParticleReveal'
import { useT, type MsgKey } from '../lib/i18n'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'
import type { AnalysisFindingData, ScanMethod, Target } from '../lib/migration/events'

/** 11/2 회의에서 정한 스캔 근거 4가지: 코드 호출 확인 · IAM 역할 추적 · CloudTrail 실제 호출 기록 · 리소스 설정 확인 */
const SCAN_METHODS: ScanMethod[] = ['config', 'code', 'iam', 'trail']

/** 발견 항목. message·detail이 비어 있으면 화면에서 key로 사전을 찾아 현재 언어로 보여 준다. 백엔드 값은 그대로 쓴다. */
export type AnalysisUpdate = AnalysisFindingData

const INFRA_NODES = [
  { key: 'vpc' },
  { key: 'alb' },
  { key: 'ec2' },
  { key: 'postgres' },
  { key: 's3' },
  { key: 'network' },
  { key: 'iam' },
]

const CODE_NODES = [
  { key: 'compose' },
  { key: 'app' },
  { key: 'database' },
  { key: 'sdk' },
  { key: 'env' },
  { key: 'auth' },
]

function textOf(t: ReturnType<typeof useT>, update: AnalysisUpdate) {
  return {
    message: update.message || t(('analysis.u.' + update.key + '.msg') as MsgKey),
    detail: update.detail || t(('analysis.u.' + update.key + '.detail') as MsgKey),
  }
}

function progressFor(updates: AnalysisUpdate[], stream: AnalysisUpdate['stream']) {
  let progress = 0
  for (const update of updates) {
    if (update.stream === stream) progress = update.progress
  }
  return progress
}

function AnalysisCluster({ title, subtitle, root, stream, progress, nodes, discovered, findings }: {
  title: string
  subtitle: string
  root: string
  stream: AnalysisUpdate['stream']
  progress: number
  nodes: typeof INFRA_NODES
  discovered: Set<string>
  findings: Map<string, string>
}) {
  const t = useT()
  const foundCount = nodes.filter(node => discovered.has(node.key)).length
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [foundCount])
  return <section className={'analysis-cluster analysis-' + stream}>
    <div className="analysis-cluster-heading">
      <span className="analysis-cluster-icon" data-particle-target="circle" aria-hidden="true">{stream === 'infrastructure' ? '◫' : '⌘'}</span>
      <div>
        <h2 data-particle-target="text">{title}</h2>
        <p data-particle-target="text">{subtitle}</p>
      </div>
      <strong data-particle-target="text">{progress}%</strong>
    </div>
    <div className="analysis-progress" data-particle-target="line" role="progressbar" aria-label={t('analysis.progressAria', { title })} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: progress + '%' }} />
    </div>
    <div className="analysis-stream">
      <div className="analysis-root">
        <span className="analysis-root-orb" data-particle-target="circle" aria-hidden="true" />
        <div><strong data-particle-target="text">{root}</strong><small data-particle-target="text">{progress === 100 ? t('analysis.explored') : t('analysis.exploring')}</small></div>
      </div>
      <div ref={listRef} tabIndex={0} className={'analysis-result-list' + (foundCount > 0 ? ' has-results' : '')}>
        {nodes.map((node, index) => <div key={node.key}
          className={'analysis-result' + (discovered.has(node.key) ? ' is-discovered' : '')}
          aria-hidden={!discovered.has(node.key)}>
          <span className="analysis-result-point" aria-hidden="true" />
          <div className="analysis-result-content">
            <small>{String(index + 1).padStart(2, '0')} / {t(('analysis.node.' + node.key + '.detail') as MsgKey)}</small>
            <strong>{t(('analysis.node.' + node.key + '.name') as MsgKey)}</strong>
            <p>{findings.get(node.key)}</p>
          </div>
        </div>)}
      </div>
      {progress < 100
        ? <div className="analysis-scanning" aria-hidden="true"><span />{t('analysis.nextItem')}</div>
        : <div className="analysis-complete" aria-hidden="true"><span>✓</span>{t('analysis.complete')}</div>}
    </div>
  </section>
}

type Handoff = {
  sources: Array<{ x: number; y: number; dx: number; dy: number }>
}

export default function AnalysisStage({ target, onAdvance, onComplete, orbHandoff = false }: {
  target: Target
  onAdvance: () => void
  onComplete?: () => void
  /** 분석 직후에 계획 화면이 올 때만 쓰는 오브 이동 연출. 단계 순서가 바뀌어(분석 → 샌드박스) 지금은 끄고, 화면 전환 입자 층이 대신한다. */
  orbHandoff?: boolean
}) {
  const t = useT()
  const stageRef = useRef<HTMLElement>(null)
  const advanceRef = useRef(onAdvance)
  const advancedRef = useRef(false)
  const { state, mode } = useMigration()
  // 이미 끝난 분석을 다시 보러 온 경우(뒤로가기)에는 결과를 그대로 보여 주고 목업 표시(DEMO)도 달지 않는다.
  const replayed = useRef(state.analysis.done).current
  const [ready, setReady] = useState(false)
  const [handoff, setHandoff] = useState<Handoff | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [proceed, setProceed] = useState(false)

  useEffect(() => { advanceRef.current = onAdvance }, [onAdvance])

  // 발견 항목은 데이터 계층에서 받는다(목업은 타이머 대본, SSE는 서버 이벤트). 화면이 열리면 바로 시작한다.
  useStageFeed('analysis', true, target)
  const activeUpdates = state.analysis.findings
  const infrastructure = progressFor(activeUpdates, 'infrastructure')
  const code = progressFor(activeUpdates, 'code')
  const discovered = new Set(activeUpdates.map(update => update.key))
  const findings = new Map(activeUpdates.map(update => [update.key, textOf(t, update).detail]))
  const finished = infrastructure === 100 && code === 100
  useEffect(() => { if (finished) onComplete?.() }, [finished, onComplete])
  const usedMethods = new Set(activeUpdates.flatMap(update => update.via ?? []))

  useEffect(() => {
    if (!proceed || advancedRef.current) return
    const timer = window.setTimeout(() => {
      if (!orbHandoff || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        advancedRef.current = true
        advanceRef.current()
        return
      }
      const host = stageRef.current
      if (host) {
        const bounds = host.getBoundingClientRect()
        const isCompact = bounds.width <= 900
        const isMobile = bounds.width <= 650
        const padX = Math.min(78, Math.max(28, bounds.width * .04))
        const padY = Math.min(52, Math.max(24, bounds.height * .04))
        const orbRadius = isCompact ? 25 : 29
        const visualHeight = isMobile ? 180 : bounds.height - padY * 2
        const visualWidth = (bounds.width - padX * 2) * (isMobile ? 1 : isCompact ? .29 : .31)
        const targets = [
          { x: padX + visualWidth * .14 + orbRadius, y: padY + visualHeight * (isMobile ? .18 : .28) + orbRadius },
          { x: padX + visualWidth * .14 + orbRadius, y: padY + visualHeight * (isMobile ? .6 : .63) + orbRadius },
        ]
        const sources = Array.from(host.querySelectorAll<HTMLElement>('.analysis-root-orb')).map((node, index) => {
          const rect = node.getBoundingClientRect()
          const x = rect.left + rect.width / 2 - bounds.left
          const y = rect.top + rect.height / 2 - bounds.top
          const target = targets[index]
          return { x, y, dx: target.x - x, dy: target.y - y }
        })
        setHandoff({ sources })
      }
      setLeaving(true)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [proceed, activeUpdates, orbHandoff])

  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => {
      if (advancedRef.current) return
      advancedRef.current = true
      advanceRef.current()
    }, 2050)
    return () => window.clearTimeout(timer)
  }, [leaving, activeUpdates])

  return <section ref={stageRef} className={'analysis-stage' + (ready ? ' is-ready' : '') + (leaving ? ' is-handoff' : '')}
    aria-label={t('analysis.aria')}>
    <h1 className="sr-only">{t('analysis.aria')}</h1>
    <div className="analysis-flow">
      <AnalysisCluster title={t('analysis.infra.title')} subtitle={t('analysis.infra.sub')}
        root={t('analysis.infra.root')} stream="infrastructure" progress={infrastructure} nodes={INFRA_NODES} discovered={discovered} findings={findings} />
      <AnalysisCluster title={t('analysis.code.title')} subtitle={t('analysis.code.sub')}
        root={t('analysis.code.root')} stream="code" progress={code} nodes={CODE_NODES} discovered={discovered} findings={findings} />
      <aside className="analysis-discovery">
        <div className="analysis-discovery-title">
          <span className="analysis-live-dot" data-particle-target="circle" />
          <strong data-particle-target="text">{t('analysis.live')}</strong>
          {mode === 'mock' && !replayed && <small data-particle-target="text">DEMO</small>}
        </div>
        <div className="scan-methods" role="group" aria-label={t('scan.title')}>
          {SCAN_METHODS.map(method => <span key={method} data-particle-target="text" className={usedMethods.has(method) ? 'is-used' : ''}>{t(('scan.' + method) as MsgKey)}</span>)}
        </div>
        <div className="analysis-discovery-items" tabIndex={0} aria-live="polite">
          {activeUpdates.length === 0
            ? <p data-particle-target="text">{t('analysis.liveEmpty')}</p>
            : [...activeUpdates].reverse().map(update => <div className="analysis-discovery-item" key={update.id}>
                <small>{update.stream === 'infrastructure' ? t('analysis.streamInfra') : t('analysis.streamCode')}</small>
                <strong>{textOf(t, update).message}</strong>
                <em>{textOf(t, update).detail}</em>
                {update.via && <span className="scan-via">{update.via.map(method => <i key={method}>{t(('scan.' + method) as MsgKey)}</i>)}</span>}
              </div>)}
        </div>
      </aside>
    </div>
    <div className="analysis-next-area">
      <span data-particle-target="text">{finished ? t('analysis.footer.done') : t('analysis.footer.run')}</span>
      <button type="button" disabled={!finished || !ready || proceed} onClick={() => setProceed(true)}>{t('analysis.next')} <span aria-hidden="true">→</span></button>
    </div>
    {leaving && handoff && <div className="analysis-handoff" aria-hidden="true">
      {handoff.sources.map((source, index) => <span key={index} className="analysis-handoff-source" style={{
        left: source.x, top: source.y, '--dx': source.dx + 'px', '--dy': source.dy + 'px',
      } as CSSProperties}><span>{index === 0 ? '◫' : '⌘'}</span></span>)}
    </div>}
    {!ready && <ParticleReveal stage={stageRef} onComplete={() => setReady(true)} />}
  </section>
}
