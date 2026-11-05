'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import ParticleReveal from './ParticleReveal'
import { useT, useTOr, type MsgKey, type TranslateOr } from '../lib/i18n'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'
import { useVoiceActions } from '../lib/voice/actions'
import type { AnalysisFindingData, ScanMethod, Target } from '../lib/migration/events'

/** 11/2 회의에서 정한 스캔 근거 4가지: 코드 호출 확인 · IAM 역할 추적 · CloudTrail 실제 호출 기록 · 리소스 설정 확인 */
const SCAN_METHODS: ScanMethod[] = ['config', 'code', 'iam', 'trail']

/** 발견 항목. message·detail이 비어 있으면 화면에서 key로 사전을 찾아 현재 언어로 보여 준다. 백엔드 값은 그대로 쓴다. */
export type AnalysisUpdate = AnalysisFindingData

/** 분석 흐름이 끝났다는 표시만 하는 항목(예: code-done)은 열에 줄로 넣지 않는다. */
const isMarker = (key: string) => /(^|-)done$/.test(key)
/** 열에 놓을 항목: 받은 발견 항목을 key별로 하나씩, 도착한 순서대로. 고정된 key 목록을 쓰지 않는다. */
function nodesOf(updates: AnalysisUpdate[], stream: AnalysisUpdate['stream']) {
  const seen = new Map<string, AnalysisUpdate>()
  for (const update of updates) if (update.stream === stream && !isMarker(update.key)) seen.set(update.key, update)
  return [...seen.values()]
}

function textOf(tOr: TranslateOr, update: AnalysisUpdate) {
  return {
    message: update.message || tOr('analysis.u.' + update.key + '.msg', update.key),
    detail: update.detail || tOr('analysis.u.' + update.key + '.detail'),
  }
}

/** 새 항목은 빈 줄로 붙은 뒤 다음 프레임에 펼쳐진다(펼침 전환이 보이게). */
function AnalysisRow({ index, update }: { index: number; update: AnalysisUpdate }) {
  const tOr = useTOr()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  const category = tOr('analysis.node.' + update.key + '.detail')
  return <div className={'analysis-result' + (open ? ' is-discovered' : '')}>
    <span className="analysis-result-point" aria-hidden="true" />
    <div className="analysis-result-content">
      <small>{String(index + 1).padStart(2, '0')}{category ? ' / ' + category : ''}</small>
      <strong>{tOr('analysis.node.' + update.key + '.name', update.message || update.key)}</strong>
      <p>{textOf(tOr, update).detail}</p>
    </div>
  </div>
}

function progressFor(updates: AnalysisUpdate[], stream: AnalysisUpdate['stream']) {
  let progress = 0
  for (const update of updates) {
    if (update.stream === stream) progress = update.progress
  }
  return progress
}

function AnalysisCluster({ title, subtitle, root, stream, progress, nodes }: {
  title: string
  subtitle: string
  root: string
  stream: AnalysisUpdate['stream']
  progress: number
  nodes: AnalysisUpdate[]
}) {
  const t = useT()
  const foundCount = nodes.length
  const listRef = useRef<HTMLDivElement>(null)
  // 끝나면 목록을 작은 줄로 접어 스크롤 없이 전부 보여 준다(위로 사라졌던 01~03번도 다시 보이게).
  const compact = progress === 100
  useEffect(() => {
    if (compact) listRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    else listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [foundCount, compact])
  return <section className={'analysis-cluster analysis-' + stream + (compact ? ' is-compact' : '')} style={{ '--rows': Math.max(nodes.length, 6) } as CSSProperties}>
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
        {nodes.map((node, index) => <AnalysisRow key={node.key} index={index} update={node} />)}
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
  const tOr = useTOr()
  const finished = infrastructure === 100 && code === 100
  useEffect(() => { if (finished) onComplete?.() }, [finished, onComplete])
  useVoiceActions({ next: finished && ready && !proceed && (() => setProceed(true)) })
  const usedMethods = new Set(activeUpdates.flatMap(update => update.via ?? []))
  const latest = activeUpdates[activeUpdates.length - 1]

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
        root={t('analysis.infra.root')} stream="infrastructure" progress={infrastructure} nodes={nodesOf(activeUpdates, 'infrastructure')} />
      <AnalysisCluster title={t('analysis.code.title')} subtitle={t('analysis.code.sub')}
        root={t('analysis.code.root')} stream="code" progress={code} nodes={nodesOf(activeUpdates, 'code')} />
      <aside className="analysis-discovery">
        <div className="analysis-discovery-title">
          <span className="analysis-live-dot" data-particle-target="circle" />
          <strong data-particle-target="text">{t('analysis.live')}</strong>
          {mode === 'mock' && !replayed && <small data-particle-target="text">DEMO</small>}
        </div>
        <div className="scan-methods" role="group" aria-label={t('scan.title')}>
          {SCAN_METHODS.map(method => {
            // 새 발견 항목이 이 방법으로 찾은 것이면 칩이 한 번 깜빡인다(key가 바뀌어 애니메이션이 다시 돈다).
            const flashing = latest?.via?.includes(method)
            return <span key={method + (flashing ? '-' + latest?.id : '')} data-particle-target="text"
              className={(usedMethods.has(method) ? 'is-used' : '') + (flashing && !replayed ? ' is-flash' : '')}>{t(('scan.' + method) as MsgKey)}</span>
          })}
        </div>
        <div className="analysis-discovery-items" tabIndex={0} aria-live="polite">
          {activeUpdates.length === 0
            ? <p data-particle-target="text">{t('analysis.liveEmpty')}</p>
            : [...activeUpdates].reverse().map(update => <div className={'analysis-discovery-item is-' + update.stream} key={update.id} title={textOf(tOr, update).detail}>
                <small>{update.stream === 'infrastructure' ? t('analysis.streamInfra') : t('analysis.streamCode')}</small>
                <strong>{textOf(tOr, update).message}</strong>
                {/* 멀리서도 읽히도록 피드는 한 줄 제목과 근거 칩만 보인다. 세부 문구는 낭독기·마우스 올림으로 */}
                <em className="sr-only">{textOf(tOr, update).detail}</em>
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
