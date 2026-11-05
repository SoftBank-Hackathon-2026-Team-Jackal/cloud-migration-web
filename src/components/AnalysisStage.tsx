'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import ParticleReveal from './ParticleReveal'
import { useT, useTOr, type MsgKey, type TranslateOr } from '../lib/i18n'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'
import { ALWAYS_UNVERIFIED, EVIDENCE_KINDS, KIND_OF_METHOD, type AnalysisFindingData, type AnalysisScanData, type Evidence, type EvidenceKind, type Target } from '../lib/migration/events'

/** 발견 항목. message·detail이 비어 있으면 화면에서 key로 사전을 찾아 현재 언어로 보여 준다. 백엔드 값은 그대로 쓴다. */
export type AnalysisUpdate = AnalysisFindingData

/*
 * 두 가지 입력을 받는다.
 * - analysis.scan(백엔드 방식): 스캔 Activity가 끝날 때마다 개수 묶음 하나. 열의 줄은 스캔이 찾은 것(items), 피드는 스캔 요약, 진행률은 n/m.
 * - analysis.finding(예전 방식, ?analysis=items): 항목마다 한 건. 진행률은 받은 %.
 * 둘 다 같은 모양(Row·FeedRow)으로 바꿔 그린다.
 */
type Row = { key: string; name: string; detail: string; category: string }
type FeedRow = { id: string; stream: AnalysisUpdate['stream']; title: string; detail: string; evidence: Evidence[] }
type StreamProgress = { percent: number; completed: number | null; total: number | null }

/** 예전 항목의 근거 칩 → Evidence(백엔드 규칙대로 클라우드 조회 근거는 미확인) */
const evidenceOfFinding = (update: AnalysisUpdate): Evidence[] => (update.via ?? []).map(method => {
  const kind = KIND_OF_METHOD[method]
  return { kind, locator: '', verified: !ALWAYS_UNVERIFIED.includes(kind) }
})
/** 근거 종류별 하나씩(같은 종류가 여럿이면 하나라도 확인됐으면 확인) */
function kindsOf(evidence: Evidence[]) {
  const seen = new Map<EvidenceKind, boolean>()
  for (const item of evidence) seen.set(item.kind, (seen.get(item.kind) ?? false) || item.verified)
  return [...seen.entries()].map(([kind, verified]) => ({ kind, verified }))
}

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

function rowsOfFindings(tOr: TranslateOr, updates: AnalysisUpdate[], stream: AnalysisUpdate['stream']): Row[] {
  return nodesOf(updates, stream).map(update => ({
    key: update.key,
    name: tOr('analysis.node.' + update.key + '.name', update.message || update.key),
    detail: textOf(tOr, update).detail,
    category: tOr('analysis.node.' + update.key + '.detail'),
  }))
}

const activityName = (tOr: TranslateOr, activity: string) => tOr('analysis.scan.' + activity, activity)
/** 스캔이 찾은 것 한 줄의 문구: '이름 n개'(사전에 {n}이 있는 문구) · sku가 있으면 덧붙인다 */
const itemText = (tOr: TranslateOr, item: AnalysisScanData['items'][number]) =>
  tOr('analysis.item.' + item.key, item.key + ' {n}', { n: item.n }) + (item.sku ? ' · ' + item.sku : '')

/** 합계 줄(예: 리소스 9개)은 피드 제목에만 쓰고 열에는 넣지 않는다(같은 것을 두 번 세지 않게). */
const TOTAL_KEYS = new Set(['resources'])
/** 열의 줄: 스캔이 찾은 것(items)을 key별로 하나씩, 도착한 순서대로. 보조 설명은 찾은 스캔 이름, 분류는 그 스캔의 근거 종류. */
function rowsOfScans(t: ReturnType<typeof useT>, tOr: TranslateOr, scans: AnalysisScanData[], stream: AnalysisUpdate['stream']): Row[] {
  const rows = new Map<string, Row>()
  for (const scan of scans) {
    if (scan.stream !== stream) continue
    const kinds = kindsOf(scan.evidence).map(item => t(('evidence.' + item.kind) as MsgKey)).join(' · ')
    for (const item of scan.items) if (!TOTAL_KEYS.has(item.key)) rows.set(item.key, {
      key: item.key,
      name: itemText(tOr, item),
      detail: activityName(tOr, scan.activity),
      category: kinds,
    })
  }
  return [...rows.values()]
}

function feedOfScans(tOr: TranslateOr, scans: AnalysisScanData[]): FeedRow[] {
  return scans.map(scan => ({
    id: scan.id,
    stream: scan.stream,
    // 제목: '스캔 이름 완료 · 첫 번째로 찾은 것'(예: AWS 인프라 스캔 완료 · 리소스 9개). 나머지는 세부 문구로.
    title: scan.items.length > 0
      ? tOr('analysis.scanDone', '{name}', { name: activityName(tOr, scan.activity), headline: itemText(tOr, scan.items[0]) })
      : tOr('analysis.scanDoneEmpty', '{name}', { name: activityName(tOr, scan.activity) }),
    detail: scan.items.map(item => itemText(tOr, item)).join(' · '),
    evidence: scan.evidence,
  }))
}

/** 새 항목은 빈 줄로 붙은 뒤 다음 프레임에 펼쳐진다(펼침 전환이 보이게). 한 스캔에서 한꺼번에 온 줄은 조금씩 엇갈려 펼친다. */
function AnalysisRow({ index, row, delay }: { index: number; row: Row; delay: number }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  return <div className={'analysis-result' + (open ? ' is-discovered' : '')} style={delay > 0 ? { transitionDelay: delay + 'ms' } : undefined}>
    <span className="analysis-result-point" aria-hidden="true" />
    <div className="analysis-result-content">
      <small>{String(index + 1).padStart(2, '0')}{row.category ? ' / ' + row.category : ''}</small>
      <strong>{row.name}</strong>
      <p>{row.detail}</p>
    </div>
  </div>
}

/** 진행률: 스캔이 있으면 n/m(마지막으로 끝난 스캔의 completed/total), 아니면 예전 항목의 % */
function progressFor(updates: AnalysisUpdate[], scans: AnalysisScanData[], stream: AnalysisUpdate['stream']): StreamProgress {
  const mine = scans.filter(scan => scan.stream === stream)
  if (mine.length > 0) {
    const completed = Math.max(...mine.map(scan => scan.completed))
    const total = Math.max(...mine.map(scan => scan.total))
    return { percent: total > 0 ? Math.round(Math.min(completed, total) / total * 100) : 0, completed, total }
  }
  let progress = 0
  for (const update of updates) {
    if (update.stream === stream) progress = update.progress
  }
  return { percent: progress, completed: null, total: null }
}

function AnalysisCluster({ title, subtitle, root, stream, status, nodes }: {
  title: string
  subtitle: string
  root: string
  stream: AnalysisUpdate['stream']
  status: StreamProgress
  nodes: Row[]
}) {
  const t = useT()
  const progress = status.percent
  const foundCount = nodes.length
  // 한 번에 여러 줄이 오면(스캔 배치) 이번에 새로 온 줄만 엇갈려 펼친다.
  const shownRef = useRef(0)
  const firstNew = shownRef.current
  useEffect(() => { shownRef.current = foundCount }, [foundCount])
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
      <strong data-particle-target="text">{status.total !== null ? status.completed + ' / ' + status.total : progress + '%'}</strong>
    </div>
    <div className="analysis-progress" data-particle-target="line" role="progressbar" aria-label={t('analysis.progressAria', { title })} aria-valuenow={status.total !== null ? status.completed ?? 0 : progress} aria-valuemin={0} aria-valuemax={status.total ?? 100}
      aria-valuetext={status.total !== null ? t('analysis.scanProgress', { n: status.completed ?? 0, m: status.total }) : progress + '%'}>
      <span style={{ width: progress + '%' }} />
    </div>
    <div className="analysis-stream">
      <div className="analysis-root">
        <span className="analysis-root-orb" data-particle-target="circle" aria-hidden="true" />
        <div><strong data-particle-target="text">{root}</strong><small data-particle-target="text">{progress === 100 ? t('analysis.explored') : t('analysis.exploring')}</small></div>
      </div>
      <div ref={listRef} tabIndex={0} className={'analysis-result-list' + (foundCount > 0 ? ' has-results' : '')}>
        {nodes.map((node, index) => <AnalysisRow key={node.key} index={index} row={node} delay={index >= firstNew ? (index - firstNew) * 140 : 0} />)}
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
  const scans = state.analysis.scans
  const infraStatus = progressFor(activeUpdates, scans, 'infrastructure')
  const codeStatus = progressFor(activeUpdates, scans, 'code')
  const tOr = useTOr()
  const finished = infraStatus.percent === 100 && codeStatus.percent === 100
  useEffect(() => { if (finished) onComplete?.() }, [finished, onComplete])
  // 피드: 스캔이 오면 스캔 요약, 아니면 예전 항목. 근거는 Evidence.kind로 같은 칩을 쓴다.
  const feed: FeedRow[] = scans.length > 0 ? feedOfScans(tOr, scans)
    : activeUpdates.map(update => ({ id: update.id, stream: update.stream, title: textOf(tOr, update).message, detail: textOf(tOr, update).detail, evidence: evidenceOfFinding(update) }))
  const rowsOf = (stream: AnalysisUpdate['stream']) => scans.length > 0 ? rowsOfScans(t, tOr, scans, stream) : rowsOfFindings(tOr, activeUpdates, stream)
  const used = new Map(kindsOf(feed.flatMap(row => row.evidence)).map(item => [item.kind, item.verified]))
  const latest = feed[feed.length - 1]
  const latestKinds = new Set(latest?.evidence.map(item => item.kind))

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
        root={t('analysis.infra.root')} stream="infrastructure" status={infraStatus} nodes={rowsOf('infrastructure')} />
      <AnalysisCluster title={t('analysis.code.title')} subtitle={t('analysis.code.sub')}
        root={t('analysis.code.root')} stream="code" status={codeStatus} nodes={rowsOf('code')} />
      <aside className="analysis-discovery">
        <div className="analysis-discovery-title">
          <span className="analysis-live-dot" data-particle-target="circle" />
          <strong data-particle-target="text">{t('analysis.live')}</strong>
          {mode === 'mock' && !replayed && <small data-particle-target="text">DEMO</small>}
        </div>
        {/* 근거 종류(Evidence.kind). 클라우드 조회 근거(리소스·IAM·CloudTrail)는 백엔드가 늘 미확인(verified=false)으로 둔다. */}
        <div className="scan-methods" role="group" aria-label={t('scan.title')}>
          {EVIDENCE_KINDS.map(kind => {
            // 새 피드 줄이 이 근거로 찾은 것이면 칩이 한 번 깜빡인다(key가 바뀌어 애니메이션이 다시 돈다).
            const flashing = latestKinds.has(kind)
            const unverified = used.has(kind) && !used.get(kind)
            return <span key={kind + (flashing ? '-' + latest?.id : '')} data-particle-target="text"
              title={unverified ? t('evidence.unverifiedNote') : undefined}
              className={(used.has(kind) ? 'is-used' : '') + (unverified ? ' is-unverified' : '') + (flashing && !replayed ? ' is-flash' : '')}>{t(('evidence.' + kind) as MsgKey)}</span>
          })}
        </div>
        <div className="analysis-discovery-items" tabIndex={0} aria-live="polite">
          {feed.length === 0
            ? <p data-particle-target="text">{t('analysis.liveEmpty')}</p>
            : [...feed].reverse().map(row => <div className={'analysis-discovery-item is-' + row.stream} key={row.id} title={row.detail}>
                <small>{row.stream === 'infrastructure' ? t('analysis.streamInfra') : t('analysis.streamCode')}</small>
                <strong>{row.title}</strong>
                {/* 멀리서도 읽히도록 피드는 한 줄 제목과 근거 칩만 보인다. 세부 문구는 낭독기·마우스 올림으로 */}
                <em className="sr-only">{row.detail}</em>
                {row.evidence.length > 0 && <span className="scan-via">{kindsOf(row.evidence).map(item => <i key={item.kind} className={item.verified ? undefined : 'is-unverified'}>
                  {t(('evidence.' + item.kind) as MsgKey)}{!item.verified && <b>{t('evidence.unverified')}</b>}
                </i>)}</span>}
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
