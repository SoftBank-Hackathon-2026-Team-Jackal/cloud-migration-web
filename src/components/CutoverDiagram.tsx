'use client'

import { useT } from '../lib/i18n'
import type { CutoverPlanData } from '../lib/migration/events'
import { useBoxSize } from './CutoverTimeline'

export type CutoverTopology = CutoverPlanData['topology']
/** 그림의 지금 모습. 값은 화면이 이벤트(단계 재생·결과)에서 정한다. */
export type CutoverView = {
  active: 'source' | 'target'
  paused: boolean
  forward: boolean
  reverse: boolean
  lag: string | null
  failedTarget: boolean
  /** 전환이 통과해 대상이 주 DB로 자리 잡았다(금색) */
  settled: boolean
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

/**
 * app → PgBouncer → 원본 DB / 대상 DB. PgBouncer 화살표가 원본에서 대상으로 옮겨 가고,
 * 정방향 복제(원본 → 대상)가 꺼지면 역방향 복제(대상 → 원본)가 지연값과 함께 켜진다. 상자 크기는 실제 칸 크기에 맞춘다.
 */
export default function CutoverDiagram({ topology, view, ariaLabel }: { topology: CutoverTopology; view: CutoverView; ariaLabel: string }) {
  const t = useT()
  const [ref, { width: W, height: H }] = useBoxSize<HTMLDivElement>()
  const ready = W > 0 && H > 0
  const font = clamp(Math.min(W / 34, H / 20), 11, 19)
  const rowH = clamp(H * 0.15, 44, 76)
  const appW = clamp(W * 0.34, 150, 300)
  const poolW = clamp(W * 0.4, 170, 340)
  const dbW = clamp((W - 170) / 2, 150, 340)
  const dbH = clamp(H * 0.34, 96, 190)
  const cx = W / 2
  const poolY = clamp(H * 0.3, rowH + 26, H - dbH - rowH - 40)
  const dbY = H - dbH - 2
  const sourceX = 2
  const targetX = W - dbW - 2
  const activeX = view.active === 'source' ? sourceX + dbW / 2 : targetX + dbW / 2
  const fromX = view.active === 'source' ? cx - poolW * 0.18 : cx + poolW * 0.18
  const lineA = dbY + dbH * 0.34
  const lineB = dbY + dbH * 0.7
  const db = (side: 'source' | 'target') => {
    const x = side === 'source' ? sourceX : targetX
    const on = view.active === side
    const failed = side === 'target' && view.failedTarget
    const role = failed ? t('cut.d.failed') : on ? t('cut.d.primary') : side === 'source' ? (view.reverse ? t('cut.d.standbyRev') : t('cut.d.standby')) : (view.forward ? t('cut.d.standbyFwd') : t('cut.d.standby'))
    const cls = 'cx-d-db' + (on ? ' is-on' : '') + (failed ? ' is-fail' : '') + (on && side === 'target' && view.settled ? ' is-settled' : '')
    const pad = font * 1.1
    return <g className={cls}>
      <rect className="cx-d-box" x={x} y={dbY} width={dbW} height={dbH} rx={12} />
      <text className="cx-d-small" x={x + pad} y={dbY + pad * 1.3} style={{ fontSize: font * 0.75 }}>{t(side === 'source' ? 'cut.d.source' : 'cut.d.target', { where: side === 'source' ? topology.source_where : topology.target_where })}</text>
      <text className="cx-d-name" x={x + pad} y={dbY + dbH * 0.52 + font * 0.5} style={{ fontSize: font * 1.7 }}>{side === 'source' ? topology.source_db : topology.target_db}</text>
      <text className="cx-d-role" x={x + pad} y={dbY + dbH - pad * 0.9} style={{ fontSize: font * 0.75 }}>{role}</text>
    </g>
  }
  return <div ref={ref} className="cx-diagram">
    {ready && <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
      <defs>
        <marker id="cx-ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" className="cx-d-head" /></marker>
        <marker id="cx-ah-gold" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" className="cx-d-head is-gold" /></marker>
        <marker id="cx-ah-faint" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" className="cx-d-head is-faint" /></marker>
      </defs>
      <g className="cx-d-app">
        <rect className="cx-d-box" x={cx - appW / 2} y={2} width={appW} height={rowH} rx={10} />
        <text className="cx-d-name" x={cx} y={2 + rowH * 0.46} textAnchor="middle" style={{ fontSize: font }}>{topology.app}</text>
        <text className="cx-d-small" x={cx} y={2 + rowH * 0.8} textAnchor="middle" style={{ fontSize: font * 0.72 }}>{t('cut.d.writes', { n: topology.writes_per_sec })}</text>
      </g>
      <line className={'cx-d-edge' + (view.paused ? ' is-paused' : '')} x1={cx} y1={rowH + 2} x2={cx} y2={poolY} />
      <g className={'cx-d-pool' + (view.paused ? ' is-paused' : '')}>
        <rect className="cx-d-box" x={cx - poolW / 2} y={poolY} width={poolW} height={rowH} rx={10} />
        <text className="cx-d-name" x={cx} y={poolY + rowH * 0.46} textAnchor="middle" style={{ fontSize: font * 1.05 }}>{topology.pooler}</text>
        <text className="cx-d-small" x={cx} y={poolY + rowH * 0.8} textAnchor="middle" style={{ fontSize: font * 0.72 }}>{view.paused ? t('cut.d.pause') : '→ ' + (view.active === 'source' ? topology.source_db : topology.target_db)}</text>
      </g>
      <path className={'cx-d-route' + (view.paused ? ' is-paused' : '')} markerEnd="url(#cx-ah)"
        d={`M${fromX} ${poolY + rowH} C ${fromX} ${poolY + rowH + (dbY - poolY - rowH) * 0.6}, ${activeX} ${poolY + rowH + (dbY - poolY - rowH) * 0.3}, ${activeX} ${dbY - 4}`} />
      {db('source')}
      {db('target')}
      {view.forward && <g className="cx-d-repl">
        <line className="cx-d-flow" x1={sourceX + dbW + 6} y1={lineA} x2={targetX - 6} y2={lineA} markerEnd="url(#cx-ah-faint)" />
        <text className="cx-d-small" x={cx} y={lineA - 8} textAnchor="middle" style={{ fontSize: font * 0.72 }}>{t('cut.d.fwd')}</text>
      </g>}
      {view.reverse && <g className="cx-d-repl is-reverse">
        <line className="cx-d-flow" x1={targetX - 6} y1={lineB} x2={sourceX + dbW + 6} y2={lineB} markerEnd="url(#cx-ah-gold)" />
        <text className="cx-d-label" x={cx} y={lineB - 8} textAnchor="middle" style={{ fontSize: font * 0.76 }}>{t('cut.d.rev')}</text>
        {view.lag && <text className="cx-d-lag" x={cx} y={lineB + font * 1.3} textAnchor="middle" style={{ fontSize: font * 0.72 }}>{t('cut.d.lag', { ms: view.lag })}</text>}
      </g>}
    </svg>}
  </div>
}

/**
 * PAUSE 동안 PgBouncer 앞에 요청이 줄을 서고(held), RESUME이면 전환된 DB로 한꺼번에 보내진다.
 * 흐르는 점은 장식이고, 줄 선 점의 수는 서버가 알려 준 held_requests다.
 */
export function CutoverQueue({ mode, held, failed, pooler, dest, ariaLabel }: { mode: 'flow' | 'hold' | 'flush'; held: number; failed: number; pooler: string; dest: string; ariaLabel: string }) {
  const t = useT()
  const shown = Math.min(held, 72)
  const flowing = Array.from({ length: 9 }, (_, index) => index)
  return <div className={'cx-queue is-' + mode} role="img" aria-label={ariaLabel}>
    <span className="cx-q-from">{t('cut.q.app')}</span>
    <span className="cx-q-to">→ {dest}</span>
    <div className="cx-q-rail is-in">{flowing.map(index => <i key={index} style={{ animationDelay: -index * 0.27 + 's', top: 30 + ((index * 37) % 40) + '%' }} />)}</div>
    <div className="cx-q-held">{Array.from({ length: shown }, (_, index) => <i key={index} style={{ animationDelay: index * 0.012 + 's' }} />)}</div>
    <b className="cx-q-pool">{pooler}</b>
    <div className="cx-q-rail is-out">{flowing.map(index => <i key={index} style={{ animationDelay: -index * 0.27 + 's', top: 30 + ((index * 53) % 40) + '%' }} />)}</div>
    <small className="cx-q-count">{mode === 'hold' ? t('cut.q.held', { n: held, f: failed }) : mode === 'flush' && held > 0 ? t('cut.q.sent', { n: held, db: dest }) : t('cut.q.idle')}</small>
  </div>
}
