'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import ParticleReveal from './ParticleReveal'
import { useT, type MsgKey } from '../lib/i18n'

/** 11/2 회의에서 정한 스캔 근거 4가지: 코드 호출 확인 · IAM 역할 추적 · CloudTrail 실제 호출 기록 · 리소스 설정 확인 */
export type ScanMethod = 'code' | 'iam' | 'trail' | 'config'
const SCAN_METHODS: ScanMethod[] = ['config', 'code', 'iam', 'trail']

export type AnalysisUpdate = {
  id: string
  stream: 'infrastructure' | 'code'
  progress: number
  key: string
  /** 이 발견의 근거가 된 스캔 방식(여러 방식이 겹칠수록 확실하다) */
  via?: ScanMethod[]
  /** 비어 있으면 화면에서 key로 사전을 찾아 현재 언어로 보여 준다(데모 데이터). 백엔드 값은 그대로 쓴다. */
  message: string
  detail: string
}

const DEMO_UPDATES: Array<AnalysisUpdate & { after: number }> = [
  { after: 3200, id: 'infra-vpc', stream: 'infrastructure', progress: 14, key: 'vpc', via: ['config'], message: '', detail: '' },
  { after: 3700, id: 'code-compose', stream: 'code', progress: 15, key: 'compose', via: ['code'], message: '', detail: '' },
  { after: 4300, id: 'infra-alb', stream: 'infrastructure', progress: 28, key: 'alb', via: ['config'], message: '', detail: '' },
  { after: 5000, id: 'code-app', stream: 'code', progress: 31, key: 'app', via: ['code'], message: '', detail: '' },
  { after: 5800, id: 'infra-ec2', stream: 'infrastructure', progress: 43, key: 'ec2', via: ['config'], message: '', detail: '' },
  { after: 6400, id: 'code-db', stream: 'code', progress: 47, key: 'database', via: ['code'], message: '', detail: '' },
  { after: 7200, id: 'infra-postgres', stream: 'infrastructure', progress: 61, key: 'postgres', via: ['config'], message: '', detail: '' },
  { after: 7900, id: 'code-s3', stream: 'code', progress: 63, key: 'sdk', via: ['code', 'trail'], message: '', detail: '' },
  { after: 8600, id: 'infra-s3', stream: 'infrastructure', progress: 74, key: 's3', via: ['config', 'trail'], message: '', detail: '' },
  { after: 9400, id: 'code-env', stream: 'code', progress: 78, key: 'env', via: ['code'], message: '', detail: '' },
  { after: 10200, id: 'infra-network', stream: 'infrastructure', progress: 88, key: 'network', via: ['config'], message: '', detail: '' },
  { after: 10900, id: 'code-auth', stream: 'code', progress: 92, key: 'auth', via: ['iam', 'code'], message: '', detail: '' },
  { after: 11700, id: 'infra-iam', stream: 'infrastructure', progress: 100, key: 'iam', via: ['iam', 'config'], message: '', detail: '' },
  { after: 12400, id: 'code-done', stream: 'code', progress: 100, key: 'code-done', via: ['code'], message: '', detail: '' },
]

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
      <div ref={listRef} className={'analysis-result-list' + (foundCount > 0 ? ' has-results' : '')}>
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

export default function AnalysisStage({ updates, onAdvance, onComplete, orbHandoff = false }: {
  updates?: AnalysisUpdate[]
  onAdvance: (results: AnalysisUpdate[]) => void
  onComplete?: () => void
  /** 분석 직후에 계획 화면이 올 때만 쓰는 오브 이동 연출. 단계 순서가 바뀌어(분석 → 샌드박스) 지금은 끄고, 화면 전환 입자 층이 대신한다. */
  orbHandoff?: boolean
}) {
  const t = useT()
  const stageRef = useRef<HTMLElement>(null)
  const advanceRef = useRef(onAdvance)
  const advancedRef = useRef(false)
  const [demoUpdates, setDemoUpdates] = useState<AnalysisUpdate[]>([])
  const [ready, setReady] = useState(false)
  const [handoff, setHandoff] = useState<Handoff | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [proceed, setProceed] = useState(false)

  useEffect(() => { advanceRef.current = onAdvance }, [onAdvance])

  useEffect(() => {
    if (updates) return
    const timers = DEMO_UPDATES.map(({ after, ...update }) =>
      window.setTimeout(() => setDemoUpdates(current => [...current, update]), after))
    return () => timers.forEach(timer => window.clearTimeout(timer))
  }, [updates])

  const activeUpdates = updates ?? demoUpdates
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
        advanceRef.current(activeUpdates)
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
      advanceRef.current(activeUpdates)
    }, 2050)
    return () => window.clearTimeout(timer)
  }, [leaving, activeUpdates])

  return <section ref={stageRef} className={'analysis-stage' + (ready ? ' is-ready' : '') + (leaving ? ' is-handoff' : '')}
    aria-label={t('analysis.aria')}>
    <div className="analysis-flow">
      <AnalysisCluster title={t('analysis.infra.title')} subtitle={t('analysis.infra.sub')}
        root={t('analysis.infra.root')} stream="infrastructure" progress={infrastructure} nodes={INFRA_NODES} discovered={discovered} findings={findings} />
      <AnalysisCluster title={t('analysis.code.title')} subtitle={t('analysis.code.sub')}
        root={t('analysis.code.root')} stream="code" progress={code} nodes={CODE_NODES} discovered={discovered} findings={findings} />
      <aside className="analysis-discovery">
        <div className="analysis-discovery-title">
          <span className="analysis-live-dot" data-particle-target="circle" />
          <strong data-particle-target="text">{t('analysis.live')}</strong>
          {!updates && <small data-particle-target="text">DEMO</small>}
        </div>
        <div className="scan-methods" role="group" aria-label={t('scan.title')}>
          {SCAN_METHODS.map(method => <span key={method} data-particle-target="text" className={usedMethods.has(method) ? 'is-used' : ''}>{t(('scan.' + method) as MsgKey)}</span>)}
        </div>
        <div className="analysis-discovery-items" aria-live="polite">
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
