'use client'

import { useEffect, useState } from 'react'
import { useT } from '../lib/i18n'
import type { PlanNodeKind, PlanPreviewData, PlanStepData } from '../lib/migration/events'
import { diagramSteps } from '../lib/migration/planModel'

/*
 * 계획 구성도: 원본(AWS)과 대상 구성을 나란히 그리고, 같은 역할의 노드를 가로선(매핑)으로 잇는다.
 * 노드는 받은 매핑 항목(plan.step)에서 만든다. 앱마다 리소스가 달라도 같은 규칙(진입 → 실행 → 프록시 → 데이터)으로 줄을 세운다.
 * 원본 유지 항목은 대상 쪽을 점선·흐리게, 검증한 이미지(Digest 고정)는 자물쇠 표시로 보인다.
 */

const W = 880
const PANEL = 340
const RIGHT_X = W - PANEL
const NODE_W = 228
const NODE_H = 56
const PITCH = 98
const FRAME_TOP = 52
const FIRST_ROW = FRAME_TOP + 84
const CX = { source: PANEL / 2, target: RIGHT_X + PANEL / 2 }
const GUTTER_X = W / 2

type Side = 'source' | 'target'
type Node = { step: PlanStepData; kind: PlanNodeKind; row: number; y: number; source: Text2; target: Text2 }
type Text2 = { name: string; sub: string }

/** "ALB (Ingress) · VPC" → 이름 "ALB (Ingress)", 보조 "VPC". 너무 긴 글자는 줄인다(구성도 칸이 좁다). */
function split(text: string): Text2 {
  const [name, ...rest] = text.split(' · ')
  return { name: clip(name, 26), sub: clip(rest.join(' · '), 32) }
}
function clip(text: string, max: number) {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/** 칩 너비: 한글·영문 폭 차이를 대충 반영한다(SVG라 글자 폭을 미리 잴 수 없다). */
function chipWidth(label: string) {
  let width = 0
  for (const char of label) width += /[ㄱ-힝぀-ヿ一-鿿]/.test(char) ? 12 : 7
  return width + 22
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(true)
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

/** 선을 따라 흐르는 작은 입자(사이트의 입자 감성). 동작 줄이기 설정이면 그리지 않는다. */
function Flow({ path, count = 3, duration = 2.6, className = '' }: { path: string; count?: number; duration?: number; className?: string }) {
  return <>{Array.from({ length: count }, (_, index) => <circle key={index} r="2.1" className={'topo-dot ' + className}>
    <animateMotion dur={duration + 's'} repeatCount="indefinite" path={path} begin={-(duration / count) * index + 's'} />
  </circle>)}</>
}

function NodeShape({ kind, x, y, side, keep, entry }: { kind: PlanNodeKind; x: number; y: number; side: Side; keep: boolean; entry: boolean }) {
  const cls = 'topo-box' + (side === 'target' ? ' is-target' : '') + (keep ? ' is-keep' : '') + (entry ? ' is-entry' : '')
  if (kind === 'database' || kind === 'cache') {
    const ry = 7
    return <g className={cls}>
      <path d={`M${x} ${y + ry} V${y + NODE_H - ry} A${NODE_W / 2} ${ry} 0 0 0 ${x + NODE_W} ${y + NODE_H - ry} V${y + ry}`} />
      <ellipse cx={x + NODE_W / 2} cy={y + ry} rx={NODE_W / 2} ry={ry} />
    </g>
  }
  if (kind === 'storage') {
    // 버킷: 아래가 살짝 좁은 사다리꼴
    return <g className={cls}><path d={`M${x} ${y + 4} Q${x} ${y} ${x + 4} ${y} H${x + NODE_W - 4} Q${x + NODE_W} ${y} ${x + NODE_W} ${y + 4} L${x + NODE_W - 10} ${y + NODE_H - 4} Q${x + NODE_W - 11} ${y + NODE_H} ${x + NODE_W - 15} ${y + NODE_H} H${x + 15} Q${x + 11} ${y + NODE_H} ${x + 10} ${y + NODE_H - 4} Z`} /></g>
  }
  return <g className={cls}><rect x={x} y={y} width={NODE_W} height={NODE_H} rx="10" /></g>
}

export default function PlanTopology({ steps, preview, digest, revealed, sourceLabel, targetLabel, textOf }: {
  steps: PlanStepData[]
  /** 매핑 항목의 원본·대상 문구(계획 화면과 같은 규칙: 이벤트 값 → 대상별 사전 → id) */
  textOf: (step: PlanStepData, field: 'before' | 'after') => string
  preview: PlanPreviewData | null
  /** 검증한 이미지 Digest(앞 12자리) */
  digest: string
  /** 드러난 줄 수(계획 화면의 연출) */
  revealed: number
  sourceLabel: { provider: string; place: string }
  targetLabel: { provider: string; place: string }
}) {
  const t = useT()
  const reduced = useReducedMotion()

  const ordered = diagramSteps(steps).filter(item => item.kind !== 'network')
  const nodes: Node[] = ordered.map((item, row) => ({
    step: item.step, kind: item.kind, row, y: FIRST_ROW + row * PITCH,
    source: split(textOf(item.step, 'before')), target: split(textOf(item.step, 'after')),
  }))
  const configCount = steps.filter(step => step.group === 'code' && !step.keep_source).length
  const pinned = preview?.resources.some(resource => resource.change === 'PINNED') ?? false
  const frameBottom = (nodes.length ? nodes[nodes.length - 1].y + NODE_H : FIRST_ROW) + 30
  const H = frameBottom + 6

  // 노드 사이 경로: 진입 → 실행 → 프록시 → 첫 데이터베이스는 세로로 잇고, 나머지 데이터 노드는 실행 노드에서 바깥쪽으로 꺾어 잇는다.
  const chainOrder: PlanNodeKind[] = ['ingress', 'compute', 'proxy', 'database']
  const chain: Node[] = []
  for (const kind of chainOrder) {
    const node = nodes.find(item => item.kind === kind)
    if (node) chain.push(node)
  }
  const compute = nodes.find(item => item.kind === 'compute') ?? chain[0]
  const branches = nodes.filter(node => !chain.includes(node))
  const edgesFor = (side: Side) => {
    const cx = CX[side]
    const outer = side === 'source' ? cx - NODE_W / 2 - 22 : cx + NODE_W / 2 + 22
    const edge = side === 'source' ? cx - NODE_W / 2 : cx + NODE_W / 2
    const list: Array<{ id: string; d: string; row: number; keep: boolean }> = []
    if (nodes[0]) list.push({ id: 'user', d: `M${cx} 32 V${nodes[0].y}`, row: 0, keep: false })
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1]
      const b = chain[i]
      list.push({ id: a.step.id + '-' + b.step.id, d: `M${cx} ${a.y + NODE_H} V${b.y}`, row: b.row, keep: b.step.keep_source })
    }
    for (const node of branches) {
      if (!compute || node === compute) continue
      const y1 = compute.y + NODE_H / 2
      const y2 = node.y + NODE_H / 2
      list.push({ id: compute.step.id + '-' + node.step.id, d: `M${edge} ${y1} H${outer} V${y2} H${edge}`, row: node.row, keep: node.step.keep_source })
    }
    return list
  }

  const visible = (row: number) => revealed > row
  const ready = nodes.length > 0 && revealed >= nodes.length

  if (nodes.length === 0) return <p className="plan-empty">{t('plan.diagram.empty')}</p>

  const frame = (side: Side, label: { provider: string; place: string }) => {
    const x = side === 'source' ? 0 : RIGHT_X
    return <g className={'topo-frame' + (side === 'target' ? ' is-target' : '')}>
      <rect x={x + 0.5} y={FRAME_TOP} width={PANEL - 1} height={frameBottom - FRAME_TOP} rx="18" />
      <text className="topo-frame-title" x={x + 20} y={FRAME_TOP + 30}>{label.provider}</text>
      <text className="topo-frame-sub" x={x + 20} y={FRAME_TOP + 49}>{label.place}</text>
    </g>
  }

  const users = (side: Side) => {
    const cx = CX[side]
    return <g className={'topo-users' + (side === 'target' ? ' is-target' : '')}>
      <rect x={cx - 46} y={4} width={92} height={28} rx="14" />
      <text x={cx} y={22.5} textAnchor="middle">{t('plan.diagram.users')}</text>
    </g>
  }

  return <svg className="plan-topo-svg" viewBox={`0 0 ${W} ${H}`} role="img"
    aria-label={t('plan.diagram.aria', { source: sourceLabel.provider + ' ' + sourceLabel.place, target: targetLabel.provider + ' ' + targetLabel.place })}>
    {frame('source', sourceLabel)}
    {frame('target', targetLabel)}
    <text className="topo-gutter-label" x={GUTTER_X} y={FRAME_TOP + 30} textAnchor="middle">{t('plan.diagram.mapping')}</text>
    {users('source')}
    {users('target')}

    {(['source', 'target'] as Side[]).map(side => <g key={side} className={'topo-edges is-' + side}>
      {edgesFor(side).map(edge => <g key={edge.id} className={'topo-reveal' + (visible(edge.row) ? ' is-visible' : '')}>
        <path className={'topo-edge' + (side === 'target' ? ' is-target' : '') + (edge.keep && side === 'target' ? ' is-keep' : '')} d={edge.d} />
        {/* 지금 트래픽은 원본에서만 흐른다. 대상 쪽은 만들 경로(정지선)다. */}
        {side === 'source' && !reduced && visible(edge.row) && <Flow path={edge.d} count={2} duration={2.4} />}
      </g>)}
    </g>)}

    {nodes.map(node => {
      const keep = node.step.keep_source
      const y = node.y
      const mid = y + NODE_H / 2
      const chipLabel = keep ? t('plan.keep') : t(('plan.grade.' + node.step.grade) as 'plan.grade.DIRECT') + (node.step.action !== 'PROCEED' ? ' · ' + t(('plan.action.' + node.step.action) as 'plan.action.PROCEED') : '')
      const chipW = chipWidth(chipLabel)
      const x1 = CX.source + NODE_W / 2
      const x2 = CX.target - NODE_W / 2
      const link = `M${x1} ${mid} H${x2}`
      const lock = pinned && node.kind === 'compute' && !!digest && !keep
      const entry = node.kind === 'ingress'
      return <g key={node.step.id} className={'topo-reveal topo-row' + (visible(node.row) ? ' is-visible' : '')}>
        {/* 매핑선: 원본 노드 → 대상 노드. 등급 칩은 가운데 */}
        <path className={'topo-link' + (keep ? ' is-keep' : '') + (node.step.action === 'BLOCK' ? ' is-block' : '')} d={link} />
        {!keep && !reduced && visible(node.row) && <Flow path={link} count={2} duration={3.2} className="is-map" />}
        <g className={'topo-chip is-' + (keep ? 'keep' : node.step.grade)}>
          <rect x={GUTTER_X - chipW / 2} y={mid - 12} width={chipW} height={24} rx="12" />
          <text x={GUTTER_X} y={mid + 4.5} textAnchor="middle">{chipLabel}</text>
        </g>

        {(['source', 'target'] as Side[]).map(side => {
          const x = CX[side] - NODE_W / 2
          const label = side === 'source' ? node.source : keep ? { name: node.source.name, sub: t('plan.diagram.keepNode') } : node.target
          const dim = side === 'target' && keep
          return <g key={side} className={'topo-node' + (dim ? ' is-keep' : '')}>
            <NodeShape kind={node.kind} x={x} y={y} side={side} keep={dim} entry={entry && !dim} />
            <text className={'topo-name' + (entry && !dim ? ' is-inv' : '')} x={CX[side]} y={mid + (label.sub ? -2 : 5)} textAnchor="middle">{label.name}</text>
            {label.sub && <text className={'topo-sub' + (entry && !dim ? ' is-inv' : '')} x={CX[side]} y={mid + 15} textAnchor="middle">{label.sub}</text>}
          </g>
        })}

        {lock && <g className="topo-lock">
          <rect x={CX.target - 66} y={y + NODE_H - 5} width={132} height={21} rx="10.5" />
          <path d={`M${CX.target - 52} ${y + NODE_H + 6} h8 v6 h-8 z M${CX.target - 50.5} ${y + NODE_H + 6} v-2.2 a2.5 2.5 0 0 1 5 0 v2.2`} />
          <text x={CX.target - 39} y={y + NODE_H + 9.5}>{digest}</text>
        </g>}
      </g>
    })}
    {ready && configCount > 0 && compute && <text className="topo-note" x={CX.target} y={frameBottom - 10} textAnchor="middle">{t('plan.diagram.config', { n: configCount })}</text>}
  </svg>
}
