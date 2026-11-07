'use client'

import { useEffect, useRef, useState } from 'react'
import { useT, useI18n } from '../lib/i18n'
import type { MsgKey } from '../lib/i18n'
import type { Target } from '../lib/stages'
import type { TrafficPrepareData, TrafficSnapshotData } from '../lib/migration/events'
import type { Stage } from '../lib/migration/trafficModel'

/**
 * 트래픽 경로: 사용자 → 중계 서버 → (가중치만큼 굵은 띠) → 원본·대상, 그 아래 데이터 경로(두 앱 → 풀러 → 원본 DB, 논리 복제 → 대상 DB).
 * 이름·주소·지표는 모두 이벤트 값(prepare·snapshot)이고, 문구는 i18n 키다. 값이 없으면 그 줄을 비운다.
 * 세로 공간이 넉넉하면 viewBox 높이를 늘려 빈 칸 없이 채운다.
 */
type Props = {
  target: Target
  stage: Stage
  snapshot: TrafficSnapshotData | null
  prepare: TrafficPrepareData | null
  /** 복제 지연(ms). 없으면 — */
  lagMs: number | null
}

const W = 1000
const MIN_H = 440
const MAX_H = 1000
const DOTS = 64
const NEG = '#c4242a'
/** 실패 중인 대상 띠: 빨간 점이 보이도록 옅은 빨강 */
const NEG_SOFT = '#f1c4c1'
const GOLD = '#b08a2e'

type Geo = ReturnType<typeof geometry>

/** 높이 H에 맞춘 좌표. 위(트래픽)와 아래(데이터 경로)로 나눈다. */
function geometry(H: number) {
  const dataH = Math.round(Math.min(230, Math.max(122, H * 0.27)))
  const topH = H - dataH
  const extra = Math.max(0, topH - (MIN_H - 122))
  const boxH = 112 + Math.min(40, extra * 0.18)
  const tBoxH = boxH + 26
  const origin = { x: 688, y: 14, w: 280, h: boxH }
  const tgt = { x: 688, y: topH - 18 - tBoxH, w: 280, h: tBoxH }
  const originApp = { x: origin.x + 16, y: origin.y + 32, w: origin.w - 32, h: origin.h - 46 }
  const targetApp = { x: tgt.x + 16, y: tgt.y + 56, w: tgt.w - 32, h: tgt.h - 70 }
  const mid = (origin.y + origin.h + tgt.y) / 2 + 4
  const relay = { x: 172, y: mid - 50, w: 206, h: 100 }
  const user = { x: 62, y: mid, r: 28 }
  const ribbon = Math.min(118, 86 + extra * 0.12)
  const dataTop = topH + 6
  const rowY = dataTop + Math.max(66, (dataH - 4) * 0.58)
  return {
    H, topH, dataTop, origin, tgt, originApp, targetApp, relay, user, ribbon,
    ribX0: relay.x + relay.w, ribX1: originApp.x,
    yOrigin: originApp.y + originApp.h / 2, yTarget: targetApp.y + targetApp.h / 2,
    // 데이터 경로는 오른쪽에서 왼쪽으로: 풀러(대상 앱 바로 아래) → 원본 DB → 논리 복제 → 대상 DB
    pooler: { x: 600, y: rowY - 19, w: 156, h: 38 },
    srcDb: { x: 376, y: rowY - 28, w: 166, h: 56 },
    tgtDb: { x: 36, y: rowY - 28, w: 200, h: 56 },
    rail: 984,
    rowY,
  }
}

function ribbonPath(g: Geo, y0: number, y1: number, th: number) {
  const x0 = g.ribX0, x1 = g.ribX1, c = (x0 + x1) / 2
  return `M${x0} ${y0 - th / 2} C${c} ${y0 - th / 2},${c} ${y1 - th / 2},${x1} ${y1 - th / 2} L${x1} ${y1 + th / 2} C${c} ${y1 + th / 2},${c} ${y0 + th / 2},${x0} ${y0 + th / 2}Z`
}
function bez(g: Geo, t: number, y0: number, y1: number): [number, number] {
  const x0 = g.ribX0, x1 = g.ribX1, c = (x0 + x1) / 2, u = 1 - t
  return [u * u * u * x0 + 3 * u * u * t * c + 3 * u * t * t * c + t * t * t * x1, u * u * u * y0 + 3 * u * u * t * y0 + 3 * u * t * t * y1 + t * t * t * y1]
}
/** 가중치(대상 %)에 따른 두 띠의 굵기와 중계 서버 쪽 시작 위치 */
function split(g: Geo, wTarget: number) {
  const wo = 100 - wTarget
  const ta = Math.max(1.5, g.ribbon * wo / 100)
  const tb = Math.max(1.5, g.ribbon * wTarget / 100)
  const cy = g.relay.y + g.relay.h / 2
  return { ta, tb, ra: cy - g.ribbon / 2 + ta / 2, rb: cy + g.ribbon / 2 - tb / 2 }
}

export default function TrafficCanvas({ target, stage, snapshot, prepare, lagMs }: Props) {
  const t = useT()
  const { tOr } = useI18n()
  const boxRef = useRef<HTMLDivElement>(null)
  const [H, setH] = useState(520)
  const ribA = useRef<SVGPathElement>(null)
  const ribB = useRef<SVGPathElement>(null)
  const dotsA = useRef<SVGGElement>(null)
  const dotsB = useRef<SVGGElement>(null)
  const pctA = useRef<SVGTextElement>(null)
  const pctB = useRef<SVGTextElement>(null)

  const wTarget = snapshot?.weights.target ?? 0
  const backends = snapshot?.backends
  const failing = (stage === 'observing' || stage === 'gate') && (backends?.target.failed_requests ?? snapshot?.gate.failed_requests ?? 0) > 0
  const passed = stage === 'complete' || stage === 'drained'
  const live = useRef({ w: wTarget, failing, H })
  live.current.w = wTarget
  live.current.failing = failing

  // 세로 공간에 맞춰 viewBox 높이를 정한다.
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const measure = () => {
      const { width, height } = box.getBoundingClientRect()
      if (width < 2 || height < 2) return
      setH(Math.round(Math.min(MAX_H, Math.max(MIN_H, W * height / width))))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    measure()
    return () => observer.disconnect()
  }, [])
  live.current.H = H

  const pctLabel = (side: 'old' | 'new', n: number) => t(side === 'old' ? 'traffic.bar.old' : 'traffic.bar.new', { n: Math.round(n) })

  // 띠 굵기를 부드럽게 바꾸고 요청 점을 흘려 보낸다. 움직임 줄이기 설정이면 점 없이 바로 바꾼다.
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const NS = 'http://www.w3.org/2000/svg'
    // 고정된 씨앗의 난수(매번 같은 배치): 점이 줄지어 뭉치지 않게 서로 독립적으로 고른다.
    let seed = 0x2f6b
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
    const dots = Array.from({ length: reduced ? 0 : DOTS }, () => ({ p: rand(), r: rand(), lane: rand(), v: 0.12 + rand() * 0.1, el: document.createElementNS(NS, 'circle') }))
    for (const dot of dots) { dot.el.setAttribute('r', '2.6'); (dotsA.current)?.appendChild(dot.el) }
    let shown = live.current.w
    let last = performance.now()
    let frame = 0
    const paint = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const { w, failing: bad, H: h } = live.current
      shown = reduced ? w : shown + (w - shown) * Math.min(1, dt * 4)
      const g = geometry(h)
      const s = split(g, shown)
      ribA.current?.setAttribute('d', ribbonPath(g, s.ra, g.yOrigin, s.ta))
      ribB.current?.setAttribute('d', ribbonPath(g, s.rb, g.yTarget, s.tb))
      ribB.current?.setAttribute('fill', bad ? NEG_SOFT : '#0a0a0a')
      if (pctA.current) { pctA.current.textContent = pctLabel('old', 100 - shown); pctA.current.setAttribute('y', String(Math.min(g.yOrigin - s.ta / 2 - 10, g.relay.y - 8))) }
      if (pctB.current) { pctB.current.textContent = pctLabel('new', shown); pctB.current.setAttribute('y', String(Math.max(g.yTarget + s.tb / 2 + 22, g.relay.y + g.relay.h + 22))) }
      for (const dot of dots) {
        dot.p = (dot.p + dot.v * dt) % 1
        const toB = dot.r * 100 < shown
        const [x, y] = bez(g, dot.p, toB ? s.rb : s.ra, toB ? g.yTarget : g.yOrigin)
        const th = toB ? s.tb : s.ta
        const off = (dot.lane - 0.5) * th * 0.7
        const parent = toB ? dotsB.current : dotsA.current
        if (parent && dot.el.parentNode !== parent) parent.appendChild(dot.el)
        dot.el.setAttribute('cx', x.toFixed(1))
        dot.el.setAttribute('cy', (y + off).toFixed(1))
        // 실패가 나는 동안 대상 쪽 점의 일부는 빨간 점(실패 요청)이다.
        dot.el.setAttribute('fill', toB ? (bad ? (dot.lane > 0.55 ? NEG : '#0a0a0a') : '#fff') : '#6b6b6b')
        dot.el.setAttribute('opacity', th < 4 ? '0' : '1')
      }
      if (!reduced || Math.abs(w - shown) > 0.01) frame = requestAnimationFrame(paint)
    }
    frame = requestAnimationFrame(paint)
    // 움직임 줄이기: 값이 바뀔 때마다 한 번 그린다.
    const repaint = reduced ? window.setInterval(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(paint) }, 400) : 0
    return () => { cancelAnimationFrame(frame); window.clearInterval(repaint); dots.forEach(dot => dot.el.remove()) }
    // 언어가 바뀌면(pctLabel) 다시 시작한다.
  }, [t])

  const g = geometry(H)
  const relay = prepare?.relay
  const origin = prepare?.origin
  const tgt = prepare?.target
  const dataPath = prepare?.data_path
  const health = prepare?.checks.find(check => check.id === 'health')?.value
  const totalRps = backends ? backends.origin.requests_per_sec + backends.target.requests_per_sec : null
  const metric = (m: { requests_per_sec: number; p99_ms: number } | undefined) => !m ? t('traffic.path.metricsNone')
    : m.p99_ms > 0 ? t('traffic.path.metrics', { rps: m.requests_per_sec, p99: m.p99_ms }) : t('traffic.path.metricsIdle', { rps: m.requests_per_sec })
  const targetName = t(('target.' + target) as MsgKey)
  const appStroke = failing ? NEG : passed ? GOLD : '#0a0a0a'
  const writesLive = wTarget > 0 && stage !== 'rolledback'
  const writeLabel = tgt?.tunnel
    ? t('traffic.path.writeVia', { app: tgt.name, via: tgt.tunnel.interface, pooler: dataPath?.pooler ?? '', db: dataPath?.source_db ?? '' })
    : t('traffic.path.write', { app: tgt?.name ?? '', pooler: dataPath?.pooler ?? '', db: dataPath?.source_db ?? '' })
  const poolerX = g.pooler.x + g.pooler.w / 2

  return <div ref={boxRef} className="traffic-path-box">
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="traffic-path-svg" role="img" aria-label={t('traffic.path.aria', { origin: 100 - wTarget, target: wTarget })}>
      <defs>
        <marker id="tp-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" fill="#0a0a0a" /></marker>
        <marker id="tp-arrow-grey" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" fill="#9a9a9a" /></marker>
        <pattern id="tp-dots" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r=".9" fill="#d4d4d4" /></pattern>
      </defs>

      {/* 사용자 → 중계 서버 */}
      <g data-node="user">
        <circle cx={g.user.x} cy={g.user.y} r={g.user.r} fill="#fff" stroke="#0a0a0a" />
        <text x={g.user.x} y={g.user.y + 5} textAnchor="middle" className="tp-t13">{t('traffic.node.user')}</text>
        {prepare?.entry_host && <text x={g.user.x} y={g.user.y + g.user.r + 20} textAnchor="middle" className="tp-mono tp-t12 tp-muted">{prepare.entry_host}</text>}
      </g>
      <line x1={g.user.x + g.user.r} y1={g.user.y} x2={g.relay.x - 2} y2={g.user.y} stroke="#0a0a0a" strokeWidth="1.5" markerEnd="url(#tp-arrow)" />
      {totalRps !== null && <text x={(g.user.x + g.user.r + g.relay.x) / 2} y={g.user.y - 10} textAnchor="middle" className="tp-mono tp-t12">{t('traffic.path.rps', { n: totalRps })}</text>}

      <g data-node="relay">
        <rect x={g.relay.x} y={g.relay.y} width={g.relay.w} height={g.relay.h} rx="10" fill="#0a0a0a" />
        <text x={g.relay.x + 16} y={g.relay.y + 24} className="tp-t11" fill="#bdbdbd">{relay?.location ? t('traffic.path.relayAt', { at: relay.location }) : t('traffic.path.relay')}</text>
        <text x={g.relay.x + 16} y={g.relay.y + 48} className="tp-t18" fill="#fff" fontWeight="700">{relay?.name ?? t('traffic.path.relay')}</text>
        {relay?.mode && <text x={g.relay.x + 16} y={g.relay.y + 68} className="tp-mono tp-t11" fill="#bdbdbd">{relay.mode}</text>}
        <text x={g.relay.x + 16} y={g.relay.y + 87} className="tp-mono tp-t12" fill="#fff">{t('traffic.path.weights', { origin: 100 - wTarget, target: wTarget })}</text>
      </g>

      {/* 가중치만큼 굵은 두 띠와 요청 점 */}
      {/* 띠·비율 글자는 그리기 루프가 직접 갱신한다(React가 덮어쓰지 않게 값은 넣지 않는다). */}
      <path ref={ribA} fill="#c4c4c4" />
      <path ref={ribB} fill="#0a0a0a" />
      <g ref={dotsA} /><g ref={dotsB} />
      <text ref={pctA} x={(g.ribX0 + g.ribX1) / 2} textAnchor="middle" className="tp-mono tp-t15" fontWeight="700" />
      <text ref={pctB} x={(g.ribX0 + g.ribX1) / 2} textAnchor="middle" className="tp-mono tp-t15" fontWeight="700" />

      {/* 원본 */}
      <g data-node="old">
        <rect x={g.origin.x} y={g.origin.y} width={g.origin.w} height={g.origin.h} rx="12" fill="url(#tp-dots)" stroke="#d6d6d6" />
        <text x={g.origin.x + 16} y={g.origin.y + 21} className="tp-t12 tp-muted">{t('traffic.path.origin', { at: origin?.location ?? '' })}</text>
        {origin?.platform && <text x={g.origin.x + g.origin.w - 16} y={g.origin.y + 21} textAnchor="end" className="tp-mono tp-t11 tp-muted">{origin.platform}</text>}
        <rect x={g.originApp.x} y={g.originApp.y} width={g.originApp.w} height={g.originApp.h} rx="8" fill="#fff" stroke="#0a0a0a" />
        <text x={g.originApp.x + 14} y={g.originApp.y + 24} className="tp-t15" fontWeight="700">{origin?.name ?? t('traffic.node.old')}</text>
        <text x={g.originApp.x + 14} y={g.originApp.y + g.originApp.h - 28} className="tp-mono tp-t12 tp-muted">{metric(backends?.origin)}</text>
        <text x={g.originApp.x + 14} y={g.originApp.y + g.originApp.h - 11} className="tp-mono tp-t12 tp-muted">{t('traffic.path.failed', { n: backends?.origin.failed_requests ?? 0 })}</text>
      </g>

      {/* 대상: 연결 정보(터널·external_endpoint)는 사전 확인 값 */}
      <g data-node="new">
        <rect x={g.tgt.x} y={g.tgt.y} width={g.tgt.w} height={g.tgt.h} rx="12" fill="url(#tp-dots)" stroke={passed ? GOLD : '#d6d6d6'} />
        <text x={g.tgt.x + 16} y={g.tgt.y + 21} className="tp-t12 tp-muted">{t('traffic.path.target', { target: targetName })}</text>
        <text x={g.tgt.x + g.tgt.w - 16} y={g.tgt.y + 21} textAnchor="end" className="tp-mono tp-t11 tp-muted">{tgt?.tunnel ? t('traffic.path.tunnel', { iface: tgt.tunnel.interface, mtu: tgt.tunnel.mtu }) : tgt?.platform ?? ''}</text>
        {tgt?.external_endpoint && <text x={g.tgt.x + 16} y={g.tgt.y + 40} className="tp-mono tp-t11 tp-faint">{t('traffic.path.endpoint', { endpoint: tgt.external_endpoint })}</text>}
        <rect x={g.targetApp.x} y={g.targetApp.y} width={g.targetApp.w} height={g.targetApp.h} rx="8" fill="#fff" stroke={appStroke} strokeWidth={passed ? 2.5 : failing ? 2 : 1} />
        <text x={g.targetApp.x + 14} y={g.targetApp.y + 24} className="tp-t15" fontWeight="700">{tgt?.name ?? t('traffic.node.new', { target: targetName })}</text>
        <text x={g.targetApp.x + 14} y={g.targetApp.y + g.targetApp.h - 28} className="tp-mono tp-t12 tp-muted">
          {wTarget === 0 && stage !== 'rolledback' ? t('traffic.path.standby', { health: health ?? '—' }) : metric(backends?.target)}
        </text>
        <text x={g.targetApp.x + 14} y={g.targetApp.y + g.targetApp.h - 11} className="tp-mono tp-t12" fill={failing ? NEG : '#6b6b6b'} fontWeight={failing ? 700 : 400}>{t('traffic.path.failed', { n: backends?.target.failed_requests ?? 0 })}</text>
      </g>

      {/* 데이터 경로: 도식(data_path)이 있는 목업은 이 단계의 쓰기가 원본 DB로 간다. 실제 모드는 DB를 먼저 전환하므로 단정하지 않는다. */}
      <line x1="16" y1={g.topH} x2={W - 16} y2={g.topH} stroke="#ececec" />
      <text x="16" y={g.dataTop + 20} className="tp-t12 tp-muted">{t(dataPath ? 'traffic.path.dataTitle' : 'traffic.path.dataTitleOnly')}</text>
      {dataPath && <g data-node="data">
        {/* 원본 앱의 쓰기: 오른쪽 가장자리를 따라 내려와 풀러로(띠와 겹치지 않게) */}
        <path d={`M${g.originApp.x + g.originApp.w} ${g.yOrigin} H${g.rail - 8} Q${g.rail} ${g.yOrigin} ${g.rail} ${g.yOrigin + 8} V${g.rowY - 8} Q${g.rail} ${g.rowY} ${g.rail - 8} ${g.rowY} H${g.pooler.x + g.pooler.w + 2}`} fill="none" stroke="#a8a8a8" strokeWidth="1.3" markerEnd="url(#tp-arrow-grey)" />
        <text x={g.rail - 10} y={g.rowY - 8} textAnchor="end" className="tp-t11 tp-muted">{t('traffic.path.writeOrigin', { app: origin?.name ?? '' })}</text>
        {/* 대상 앱의 쓰기: 터널을 지나 같은 풀러 → 원본 DB로 */}
        <path d={`M${g.targetApp.x + 28} ${g.targetApp.y + g.targetApp.h} C ${g.targetApp.x + 28} ${g.pooler.y - 24}, ${poolerX} ${g.pooler.y - 30}, ${poolerX} ${g.pooler.y - 2}`} fill="none" stroke="#0a0a0a" strokeWidth="1.7" strokeDasharray="5 3" markerEnd="url(#tp-arrow)" opacity={writesLive ? 1 : 0.22} className={writesLive ? 'tp-flow' : ''} />
        <text x={g.rail - 14} y={g.dataTop + 20} textAnchor="end" className="tp-t12" opacity={writesLive ? 1 : 0.35}>{writeLabel}</text>

        <rect x={g.pooler.x} y={g.pooler.y} width={g.pooler.w} height={g.pooler.h} rx="6" fill="#0a0a0a" />
        <text x={poolerX} y={g.pooler.y + 24} textAnchor="middle" className="tp-t13" fill="#fff" fontWeight="600">{dataPath.pooler}</text>
        <line x1={g.pooler.x} y1={g.rowY} x2={g.srcDb.x + g.srcDb.w + 2} y2={g.rowY} stroke="#0a0a0a" strokeWidth="1.5" markerEnd="url(#tp-arrow)" />

        <rect x={g.srcDb.x} y={g.srcDb.y} width={g.srcDb.w} height={g.srcDb.h} rx="8" fill="#fff" stroke="#0a0a0a" strokeWidth="1.5" />
        <text x={g.srcDb.x + 14} y={g.srcDb.y + 21} className="tp-t11 tp-muted">{t('traffic.path.sourceDb')}</text>
        <text x={g.srcDb.x + 14} y={g.srcDb.y + 43} className="tp-t16" fontWeight="700">{dataPath.source_db}</text>

        <line x1={g.srcDb.x} y1={g.rowY} x2={g.tgtDb.x + g.tgtDb.w + 2} y2={g.rowY} stroke="#0a0a0a" strokeWidth="1.5" strokeDasharray="6 4" markerEnd="url(#tp-arrow)" className="tp-flow" />
        <text x={(g.srcDb.x + g.tgtDb.x + g.tgtDb.w) / 2} y={g.rowY - 9} textAnchor="middle" className="tp-t12">{t('traffic.path.replication')}</text>
        <text x={(g.srcDb.x + g.tgtDb.x + g.tgtDb.w) / 2} y={g.rowY + 20} textAnchor="middle" className="tp-mono tp-t12">{lagMs === null ? t('traffic.path.lagNone') : t('traffic.path.lag', { n: lagMs })}</text>

        <rect x={g.tgtDb.x} y={g.tgtDb.y} width={g.tgtDb.w} height={g.tgtDb.h} rx="8" fill="#fff" stroke="#bdbdbd" />
        <text x={g.tgtDb.x + 14} y={g.tgtDb.y + 21} className="tp-t11 tp-muted">{t('traffic.path.targetDb')}</text>
        <text x={g.tgtDb.x + 14} y={g.tgtDb.y + 43} className="tp-t16 tp-muted" fontWeight="700">{dataPath.target_db}</text>
      </g>}
      {!dataPath && <text x={W / 2} y={g.rowY} textAnchor="middle" className="tp-t12 tp-faint">{tOr('traffic.path.dataWaiting', '')}</text>}
    </svg>
  </div>
}
