'use client'

/**
 * 구축 장면: 받은 provision.resource 하나마다 등각(isometric) 블록 하나.
 * 블록은 선(생성 요청) → 점(생성 중) → 면(생성됨)으로 조립되고, 검사를 통과하면 번호표가 금색이 된다.
 * 종류는 점 밀도·무늬로 구분하고(범례), 모든 블록에 이름표가 붙는다.
 */
import { memo, useEffect, useState, type ReactNode } from 'react'
import type { ResourceKind } from '../lib/migration/provisionModel'
import { KIND_ORDER } from '../lib/migration/provisionModel'

const U = 34
const OX = 411
const OY = 46
export const VIEW_W = 1020
const VIEW_H = 430

type Pt = [number, number]
const P = (x: number, y: number, z = 0): Pt => [OX + (x - y) * U * 0.866, OY + (x + y) * U * 0.5 - z * U]
const pts = (list: [number, number, number][]) => list.map(([x, y, z]) => P(x, y, z).map(n => n.toFixed(1)).join(',')).join(' ')

type BoxShape = { type: 'box'; box: [number, number, number, number, number, number]; tone?: 'light' }
type CylShape = { type: 'cyl'; cx: number; cy: number; r: number; z0: number; z1: number }
type Shape = BoxShape | CylShape

export type SceneResource = {
  id: string
  num: number
  kind: ResourceKind
  state: 'running' | 'done' | 'failed'
  title: string
  spec: string
  ready: boolean
}

type Placed = { shapes: Shape[]; anchor: [number, number, number]; port?: [number, number, number]; layer: number; depth: number }

/** 종류별 기본 자리와, 같은 종류가 또 오거나 모르는 종류일 때 쓰는 빈 자리 */
function place(resources: SceneResource[]): Map<string, Placed> {
  const kinds = new Set(resources.map(r => r.kind))
  const g = kinds.has('network') ? 0.45 : 0
  const top = kinds.has('cluster') ? g + 0.25 : g
  const primary: Partial<Record<ResourceKind, Placed>> = {
    network: { layer: 0, depth: 0, anchor: [0.5, 7.5, 0.15], shapes: [
      { type: 'box', box: [0.5, 13.5, 0.5, 7.5, 0, 0.3] },
      { type: 'box', box: [1, 4.4, 1, 7, 0.3, 0.45], tone: 'light' },
      { type: 'box', box: [4.9, 13, 1, 7, 0.3, 0.45], tone: 'light' },
    ] },
    cluster: { layer: 1, depth: 0, anchor: [12.5, 4, g + 0.25], shapes: [{ type: 'box', box: [5.5, 12.5, 1.5, 6.5, g, g + 0.25] }] },
    compute: { layer: 2, depth: 11, anchor: [8.4, 2.4, top + 1.7], port: [7.4, 3.6, top + 0.8], shapes: [{ type: 'box', box: [6.4, 8.4, 2.4, 4.8, top, top + 1.7] }] },
    database: { layer: 2, depth: 14, anchor: [10.4, 3.6, top + 1.8], port: [9.3, 3.6, top + 0.9], shapes: [{ type: 'cyl', cx: 10.4, cy: 3.6, r: 1.15, z0: top, z1: top + 1.8 }] },
    edge: { layer: 2, depth: 6, anchor: [1.7, 2.4, g + 1.05], port: [2.65, 3.6, g + 0.6], shapes: [{ type: 'box', box: [1.7, 3.6, 2.4, 4.8, g, g + 1.05] }] },
    security: { layer: 2, depth: 8, anchor: [1.7, 5.8, g + 0.3], shapes: [{ type: 'box', box: [1.7, 3.6, 5.2, 6.4, g, g + 0.3] }] },
    agent: { layer: 2, depth: 18, anchor: [12.2, 7.2, g + 0.55], shapes: [{ type: 'box', box: [9.4, 12.2, 6.8, 7.7, g, g + 0.55] }] },
  }
  const spare: [number, number, number, number, number][] = [
    [1.3, 2.6, 1.1, 2.1, g], [2.9, 4.2, 1.1, 2.1, g], [6.4, 7.9, 5.2, 6.3, top], [8.3, 9.8, 5.2, 6.3, top], [10.2, 11.7, 5.2, 6.3, top],
  ]
  const used = new Set<ResourceKind>()
  const out = new Map<string, Placed>()
  let extra = 0
  for (const resource of resources) {
    const main = primary[resource.kind]
    if (main && !used.has(resource.kind)) {
      used.add(resource.kind)
      out.set(resource.id, main)
      continue
    }
    const [x0, x1, y0, y1, base] = spare[extra % spare.length]
    const z0 = base + Math.floor(extra / spare.length) * 0.9
    extra++
    const shape: Shape = resource.kind === 'database'
      ? { type: 'cyl', cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, r: 0.5, z0, z1: z0 + 0.8 }
      : { type: 'box', box: [x0, x1, y0, y1, z0, z0 + 0.8] }
    out.set(resource.id, { layer: 3, depth: x0 + y0, anchor: [x0, y0, z0 + 0.8], shapes: [shape] })
  }
  return out
}

/* ── 종류별 무늬 ─────────────────────────────────────────────── */
type PatternSpec = { cell: number; h?: number; draw: (cell: number) => ReactNode }
const PATTERNS: Record<ResourceKind, PatternSpec> = {
  network: { cell: 0.55, draw: c => <circle cx={c / 2} cy={c / 2} r={0.045} /> },
  cluster: { cell: 0.5, draw: c => <><rect x={0} y={0} width={c} height={0.022} /><rect x={0} y={0} width={0.022} height={c} /></> },
  compute: { cell: 0.19, draw: c => <circle cx={c / 2} cy={c / 2} r={0.042} /> },
  database: { cell: 0.16, h: 0.34, draw: c => <circle cx={c / 2} cy={0.08} r={0.04} /> },
  edge: { cell: 0.3, draw: c => <path d={`M0 ${c} L${c} 0`} stroke="#1d1d1d" strokeWidth={0.035} /> },
  security: { cell: 0.34, draw: c => <path d={`M${c / 2 - 0.07} ${c / 2}h.14M${c / 2} ${c / 2 - 0.07}v.14`} stroke="#1d1d1d" strokeWidth={0.03} /> },
  agent: { cell: 0.36, draw: c => <circle cx={c / 2} cy={c / 2} r={0.09} fill="none" stroke="#1d1d1d" strokeWidth={0.025} /> },
  generic: { cell: 0.3, draw: c => <><rect x={0} y={0} width={c / 2} height={c / 2} opacity={0.35} /><rect x={c / 2} y={c / 2} width={c / 2} height={c / 2} opacity={0.35} /></> },
}
const FACE = { top: [0.866, 0.5, -0.866, 0.5], x: [-0.866, 0.5, 0, -1], y: [0.866, 0.5, 0, -1] } as const
type Face = keyof typeof FACE

const pid = (kind: ResourceKind, face: Face | 's') => `pv-${kind}-${face}`

/** 장면과 범례가 함께 쓰는 무늬 정의(문서에 한 번만) */
const PatternDefs = memo(function PatternDefs() {
  return <defs>
    {KIND_ORDER.map(kind => {
      const spec = PATTERNS[kind]
      const body = <g fill="#1d1d1d" stroke="none">{spec.draw(spec.cell)}</g>
      return <g key={kind}>
        {(Object.keys(FACE) as Face[]).map(face => <pattern key={face} id={pid(kind, face)} patternUnits="userSpaceOnUse" width={spec.cell} height={spec.h ?? spec.cell}
          patternTransform={`matrix(${FACE[face].map(n => n * U).join(',')},${OX},${OY})`}>{body}</pattern>)}
        <pattern id={pid(kind, 's')} patternUnits="userSpaceOnUse" width={spec.cell} height={spec.h ?? spec.cell} patternTransform={`scale(${U * 0.9})`}>{body}</pattern>
      </g>
    })}
  </defs>
})

const TONES = { normal: ['#f6f6f6', '#e4e4e4', '#d0d0d0'], light: ['#fdfdfd', '#ededed', '#dedede'] }

function Faces({ kind, shape }: { kind: ResourceKind; shape: Shape }) {
  if (shape.type === 'cyl') {
    const [a, b] = P(shape.cx, shape.cy, shape.z1)
    const [, b0] = P(shape.cx, shape.cy, shape.z0)
    const [, bm] = P(shape.cx, shape.cy, (shape.z0 + shape.z1) / 2)
    const rx = shape.r * U * 1.2247
    const ry = shape.r * U * 0.7071
    const body = `M${a - rx} ${b} L${a - rx} ${b0} A${rx} ${ry} 0 0 0 ${a + rx} ${b0} L${a + rx} ${b} Z`
    return <>
      <path d={body} className="pv-fill" fill="#dcdcdc" /><path d={body} className="pv-pat" fill={`url(#${pid(kind, 's')})`} /><path d={body} className="pv-edge" pathLength={1} />
      <ellipse cx={a} cy={b} rx={rx} ry={ry} className="pv-fill" fill="#f6f6f6" /><ellipse cx={a} cy={b} rx={rx} ry={ry} className="pv-pat" fill={`url(#${pid(kind, 's')})`} />
      <ellipse cx={a} cy={b} rx={rx} ry={ry} className="pv-edge" pathLength={1} />
      <path d={`M${a - rx} ${bm} A${rx} ${ry} 0 0 0 ${a + rx} ${bm}`} className="pv-edge pv-edge-soft" pathLength={1} />
    </>
  }
  const [x0, x1, y0, y1, z0, z1] = shape.box
  const tones = TONES[shape.tone ?? 'normal']
  const faces: [Face, [number, number, number][], string][] = [
    ['y', [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], tones[1]],
    ['x', [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], tones[2]],
    ['top', [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], tones[0]],
  ]
  return <>{faces.map(([face, list, tone]) => {
    const points = pts(list)
    return <g key={face}>
      <polygon points={points} className="pv-fill" fill={tone} />
      <polygon points={points} className="pv-pat" fill={`url(#${pid(kind, face)})`} />
      <polygon points={points} className="pv-edge" pathLength={1} />
    </g>
  })}</>
}

type Phase = 'wire' | 'dots' | 'solid'

/** 블록 하나: 처음엔 선만, 곧 점으로 채워지고, done이면 면이 된다. running이면 점 단계에서 숨 쉬듯 기다린다. */
function Block({ resource, placed, reduced, onSettled }: { resource: SceneResource; placed: Placed; reduced: boolean; onSettled: (id: string) => void }) {
  const [phase, setPhase] = useState<Phase>(() => reduced ? (resource.state === 'done' ? 'solid' : 'dots') : 'wire')
  useEffect(() => {
    if (phase !== 'wire') return
    const timer = setTimeout(() => setPhase('dots'), 550)
    return () => clearTimeout(timer)
  }, [phase])
  useEffect(() => {
    if (phase === 'wire' || resource.state !== 'done') return
    if (phase === 'solid') { onSettled(resource.id); return }
    const timer = setTimeout(() => setPhase('solid'), reduced ? 0 : 800)
    return () => clearTimeout(timer)
  }, [phase, resource.state, resource.id, reduced, onSettled])
  const className = 'pv-block is-' + phase + (resource.state === 'running' ? ' is-running' : '') + (resource.state === 'failed' ? ' is-failed' : '')
  return <g className={className} data-kind={resource.kind} data-resource={resource.id}>
    <g className="pv-lift">{placed.shapes.map((shape, index) => <Faces key={index} kind={resource.kind} shape={shape} />)}</g>
  </g>
}

/** 이름표 폭(글자 수로 어림: 한중일 글자는 넓게) */
function textWidth(text: string, size: number, mono = false) {
  let width = 0
  for (const ch of text) width += ch.charCodeAt(0) > 0x2e80 ? size : size * (mono ? 0.62 : 0.6)
  return width
}

type Callout = { id: string; num: number; side: 'L' | 'R'; anchor: Pt; y: number; width: number; title: string; spec: string; ready: boolean }

function layoutCallouts(resources: SceneResource[], placed: Map<string, Placed>): Callout[] {
  const all: Callout[] = resources.map(resource => {
    const anchor = P(...placed.get(resource.id)!.anchor)
    const width = Math.max(150, textWidth(resource.title, 13) + 46, textWidth(resource.spec, 11, true) + 22)
    return { id: resource.id, num: resource.num, side: anchor[0] < OX + 70 ? 'L' : 'R', anchor, y: 0, width, title: resource.title, spec: resource.spec, ready: resource.ready }
  })
  for (const side of ['L', 'R'] as const) {
    let last = -Infinity
    all.filter(c => c.side === side).sort((a, b) => a.anchor[1] - b.anchor[1]).forEach(c => {
      c.y = Math.max(c.anchor[1] - 10, last + 46, 26)
      last = c.y
    })
  }
  return all
}

export type SceneProps = {
  resources: SceneResource[]
  floorLabel: string
  subnets: [string, string]
  userLabel: string
  ariaLabel: string
  /** 다 만들어져서 트래픽 경로를 보일 때 / 검사까지 통과해서 금색으로 흐를 때 */
  traffic: 'off' | 'on' | 'ready'
  onSettled: (id: string) => void
}

export default function ProvisioningScene({ resources, floorLabel, subnets, userLabel, ariaLabel, traffic, onSettled }: SceneProps) {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(query.matches)
    const change = () => setReduced(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])
  const placed = place(resources)
  const callouts = layoutCallouts(resources, placed)
  const order = [...resources].sort((a, b) => {
    const pa = placed.get(a.id)!
    const pb = placed.get(b.id)!
    return pa.layer - pb.layer || pa.depth - pb.depth
  })
  const network = resources.find(r => r.kind === 'network')
  const ports = (['edge', 'compute', 'database'] as const).map(kind => resources.find(r => r.kind === kind)).filter(Boolean).map(r => P(...placed.get(r!.id)!.port!))
  const user = P(-1.4, 3.6)
  const flowPoints = [P(-1, 3.6, 0.9), ...ports]

  return <svg className="pv-scene" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label={ariaLabel} preserveAspectRatio="xMidYMid meet">
    <PatternDefs />
    <g className="pv-floor" aria-hidden="true">
      <polygon points={pts([[0, 0, 0], [14, 0, 0], [14, 8, 0], [0, 8, 0]])} className="pv-floor-plate" />
      {Array.from({ length: 13 }, (_, i) => i + 1).map(i => <line key={'x' + i} x1={P(i, 0)[0]} y1={P(i, 0)[1]} x2={P(i, 8)[0]} y2={P(i, 8)[1]} />)}
      {Array.from({ length: 7 }, (_, i) => i + 1).map(j => <line key={'y' + j} x1={P(0, j)[0]} y1={P(0, j)[1]} x2={P(14, j)[0]} y2={P(14, j)[1]} />)}
      <text x={P(0, 0)[0] + 10} y={P(0, 0)[1] - 10} className="pv-floor-label">{floorLabel}</text>
      <g className="pv-user">
        <circle cx={user[0]} cy={user[1] - 26} r={7} />
        <path d={`M${user[0] - 12} ${user[1]} q12 -18 24 0`} />
        <text x={user[0]} y={user[1] + 16} textAnchor="middle">{userLabel}</text>
      </g>
    </g>
    {ports.length > 0 && <polyline aria-hidden="true" className={'pv-flow is-' + traffic} points={flowPoints.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')} />}
    <g aria-hidden="true">
      {order.map(resource => <Block key={resource.id} resource={resource} placed={placed.get(resource.id)!} reduced={reduced} onSettled={onSettled} />)}
    </g>
    <g className="pv-callouts" aria-hidden="true">
      {network && <g className="pv-subnets">{subnets.map((label, index) => {
        // 서브넷 이름은 각 서브넷 앞 모서리를 따라(블록에 가리지 않게 맨 위 층에) 쓴다
        const [x, y] = P(index ? 5.2 : 1.15, 7, 0.45)
        return <text key={label} className="pv-subnet" transform={`translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(30)`} y={-5}>{label}</text>
      })}</g>}
      {callouts.map(c => {
        const left = c.side === 'L'
        const x = left ? 8 : VIEW_W - 8 - c.width
        const edge = left ? x + c.width : x
        return <g key={c.id} className={'pv-callout' + (c.ready ? ' is-ready' : '')}>
          <polyline className="pv-leader" points={`${c.anchor[0]},${c.anchor[1]} ${edge + (left ? 14 : -14)},${c.y} ${edge},${c.y}`} />
          <g className="pv-card">
            <rect x={x} y={c.y - 19} width={c.width} height={40} rx={7} />
            <text x={x + 10} y={c.y - 3} className="pv-card-title">{c.title}</text>
            <text x={x + 10} y={c.y + 12} className="pv-card-spec">{c.spec}</text>
            <circle cx={x + c.width - 12} cy={c.y - 7} r={3.4} className="pv-card-dot" />
          </g>
        </g>
      })}
      {callouts.map(c => <g key={'n' + c.id} className={'pv-badge' + (c.ready ? ' is-ready' : '')} transform={`translate(${c.anchor[0].toFixed(1)},${c.anchor[1].toFixed(1)})`}>
        <circle r={9} /><text y={3.5} textAnchor="middle">{c.num}</text>
      </g>)}
    </g>
  </svg>
}

/** 범례 견본(장면의 무늬를 그대로 쓴다) */
export function KindSwatch({ kind }: { kind: ResourceKind }) {
  return <svg className="pv-swatch" viewBox="0 0 22 14" aria-hidden="true"><rect width="22" height="14" fill={`url(#${pid(kind, 's')})`} /></svg>
}
