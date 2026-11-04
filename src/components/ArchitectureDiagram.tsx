'use client'

import { useEffect, useRef, useState } from 'react'
import { useT, type MsgKey } from '../lib/i18n'
import type { Target } from '../lib/stages'

export type DiagramView = 'before' | 'after'
/** off: 아직 없거나 대상이 아님(흐리게) · on: 지금 만드는/검증하는 중 · done: 완료 */
export type NodeState = 'off' | 'on' | 'done'

type Box = { id: string; x: number; y: number; w: number; h: number; label: MsgKey; sub?: MsgKey; dashed?: boolean }
type Edge = { from: string; to: string; dashed?: boolean; label?: MsgKey; tunnel?: boolean }
type Group = { x: number; y: number; w: number; h: number; label: string }

type Layout = { boxes: Box[]; edges: Edge[]; group: Group }

/** 세로로 긴 칸(승인 화면 등)에 맞는 배치: 위에서 아래로 사용자 → DNS → 진입 → 클러스터 → S3 */
const VERTICAL = { w: 330, h: 340 }
/** 가로로 넓고 낮은 칸(샌드박스 오른쪽 패널 등)에 맞는 배치: 왼쪽에서 오른쪽으로 같은 흐름 */
const HORIZONTAL = { w: 640, h: 210 }

const CX = 165
const WIDE = { w: 200, h: 30 }

function entryOf(view: DiagramView, target: Target): { label: MsgKey; group: string; tunnel: boolean; s3Dashed: boolean } {
  if (view === 'before') return { label: 'diagram.alb', group: 'EKS', tunnel: false, s3Dashed: false }
  if (target === 'gcp') return { label: 'diagram.gcplb', group: 'Kubernetes', tunnel: false, s3Dashed: true }
  return { label: 'diagram.relay', group: 'K3s', tunnel: true, s3Dashed: true }
}

function edgesOf(entry: { tunnel: boolean; s3Dashed: boolean }): Edge[] {
  return [
    { from: 'user', to: 'dns' }, { from: 'dns', to: 'entry' },
    { from: 'entry', to: 'app', ...(entry.tunnel ? { tunnel: true, label: 'diagram.tunnel' as MsgKey } : {}) },
    { from: 'app', to: 'db' }, { from: 'app', to: 's3', dashed: entry.s3Dashed },
  ]
}

function verticalLayout(view: DiagramView, target: Target): Layout {
  const entry = entryOf(view, target)
  const s3: Box = entry.s3Dashed
    ? { id: 's3', x: CX - WIDE.w / 2, y: 296, ...WIDE, h: 38, label: 'diagram.s3', sub: 'diagram.s3note', dashed: true }
    : { id: 's3', x: CX - WIDE.w / 2, y: 296, ...WIDE, label: 'diagram.s3' }
  return {
    boxes: [
      { id: 'user', x: CX - WIDE.w / 2, y: 8, ...WIDE, label: 'diagram.user' },
      { id: 'dns', x: CX - WIDE.w / 2, y: 62, ...WIDE, label: 'diagram.dns' },
      { id: 'entry', x: CX - WIDE.w / 2, y: 116, ...WIDE, label: entry.label },
      { id: 'app', x: 20, y: 204, w: 130, h: 44, label: 'diagram.app' },
      { id: 'db', x: 180, y: 204, w: 130, h: 44, label: 'diagram.db' },
      s3,
    ],
    edges: edgesOf(entry),
    group: { x: 8, y: 168, w: 314, h: 94, label: entry.group },
  }
}

function horizontalLayout(view: DiagramView, target: Target): Layout {
  const entry = entryOf(view, target)
  const s3: Box = entry.s3Dashed
    ? { id: 's3', x: 372, y: 152, w: 264, h: 48, label: 'diagram.s3', sub: 'diagram.s3note', dashed: true }
    : { id: 's3', x: 372, y: 152, w: 264, h: 40, label: 'diagram.s3' }
  return {
    boxes: [
      { id: 'user', x: 4, y: 52, w: 76, h: 34, label: 'diagram.user' },
      { id: 'dns', x: 96, y: 52, w: 84, h: 34, label: 'diagram.dns' },
      { id: 'entry', x: 196, y: 52, w: 148, h: 34, label: entry.label },
      { id: 'app', x: 384, y: 44, w: 108, h: 48, label: 'diagram.app' },
      { id: 'db', x: 512, y: 44, w: 116, h: 48, label: 'diagram.db' },
      s3,
    ],
    edges: edgesOf(entry),
    group: { x: 372, y: 8, w: 264, h: 124, label: entry.group },
  }
}

/**
 * 이전 전(AWS)과 이전 후(대상 환경)의 구성을 같은 모양으로 그려 비교하게 해 주는 구성도.
 * adaptive를 켜면 놓인 칸의 크기를 재서, 세로형과 가로형 중 글자가 더 크게 보이는 쪽으로 그린다.
 */
export default function ArchitectureDiagram({ view, target, states, adaptive = false, storage = true }: {
  view: DiagramView
  target: Target
  states?: Partial<Record<string, NodeState>>
  adaptive?: boolean
  /** 분석·계획이 오브젝트 저장소를 보고했을 때만 S3 상자를 그린다(planModel.reportsStorage). */
  storage?: boolean
}) {
  const t = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!adaptive || !host) return
    const measure = () => setSize({ w: host.clientWidth, h: host.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [adaptive])

  const horizontal = adaptive && !!size && size.w > 0 && size.h > 0
    && Math.min(size.w / HORIZONTAL.w, size.h / HORIZONTAL.h) > Math.min(size.w / VERTICAL.w, size.h / VERTICAL.h)

  // states를 안 주면 모든 노드를 완료 상태로 그린다.
  const stateOf = (id: string): NodeState => (states ? states[id] ?? 'off' : 'done')
  const layout = horizontal ? horizontalLayout(view, target) : verticalLayout(view, target)
  const boxes = storage ? layout.boxes : layout.boxes.filter(box => box.id !== 's3')
  const edges = storage ? layout.edges : layout.edges.filter(edge => edge.to !== 's3')
  const group = layout.group
  const byId = new Map(boxes.map(box => [box.id, box]))
  const groupTitle = view === 'after' && target === 'onprem' ? t('diagram.k3s') : view === 'after' ? t('diagram.k8s') : t('diagram.eks')
  // 저장소가 없으면 그 줄만큼 그림을 줄인다(세로형 아래쪽, 가로형 아래쪽).
  const viewBox = horizontal ? (storage ? HORIZONTAL : { ...HORIZONTAL, h: 140 }) : (storage ? VERTICAL : { ...VERTICAL, h: 272 })

  const svg = <svg className={'arch' + (adaptive ? ' is-fit' : '')} viewBox={`0 0 ${viewBox.w} ${viewBox.h}`} role="img" aria-label={t('diagram.aria')}>
    <g className={'arch-node is-' + stateOf('group')}>
      <rect className="arch-group" x={group.x} y={group.y} width={group.w} height={group.h} rx="14" />
      <text className="arch-group-label" x={group.x + 12} y={group.y + 15}>{groupTitle}</text>
    </g>
    {edges.map(edge => {
      const a = byId.get(edge.from)!
      const b = byId.get(edge.to)!
      const toS3 = edge.to === 's3'
      const appToDb = edge.from === 'app' && edge.to === 'db'
      let x1: number, y1: number, x2: number, y2: number
      if (horizontal) {
        // 가로형: 오른쪽 가운데 → 왼쪽 가운데, S3로 가는 선만 아래로 내려간다.
        x1 = toS3 ? a.x + a.w / 2 : a.x + a.w
        y1 = toS3 ? a.y + a.h : a.y + a.h / 2
        x2 = toS3 ? x1 : b.x
        y2 = toS3 ? b.y : b.y + b.h / 2
      } else {
        x1 = appToDb ? a.x + a.w : a.x + a.w / 2
        y1 = appToDb ? a.y + a.h / 2 : a.y + a.h
        x2 = appToDb ? b.x : b.x + b.w / 2
        y2 = appToDb ? b.y + b.h / 2 : b.y
      }
      const cls = 'arch-edge' + (edge.dashed ? ' is-dashed' : '') + (edge.tunnel ? ' is-tunnel' : '')
      const live = stateOf(edge.from) !== 'off' && stateOf(edge.to) !== 'off'
      return <g key={edge.from + edge.to} className={'arch-node is-' + (live ? 'done' : 'off')}>
        <line className={cls} x1={x1} y1={y1} x2={x2} y2={y2} />
        {edge.label && (horizontal
          ? <text className="arch-edge-label" x={x1 - 2} y={y1 + 30} textAnchor="end">{t(edge.label)}</text>
          : <text className="arch-edge-label" x={(x1 + x2) / 2 + 10} y={(y1 + y2) / 2 + 4}>{t(edge.label)}</text>)}
      </g>
    })}
    {boxes.map(box => <g key={box.id} className={'arch-node is-' + (box.dashed && states ? 'off' : stateOf(box.id))}>
      <rect className={'arch-box' + (box.dashed ? ' is-dashed' : '') + (box.id === 'entry' ? ' is-entry' : '')} x={box.x} y={box.y} width={box.w} height={box.h} rx="9" />
      <text className="arch-text" x={box.x + box.w / 2} y={box.y + box.h / 2 + (box.sub ? -2 : 4)} textAnchor="middle">{t(box.label)}</text>
      {box.sub && <text className="arch-sub" x={box.x + box.w / 2} y={box.y + box.h / 2 + 10} textAnchor="middle">{t(box.sub)}</text>}
    </g>)}
  </svg>

  return adaptive ? <div ref={hostRef} className="arch-fit">{svg}</div> : svg
}
