'use client'

import { useT } from '../lib/i18n'
import { Cylinder } from './DiagramParts'

export type ReplicationPhase = 'connect' | 'dump' | 'cdc' | 'ready'

/** 원본 DB와 대상 DB 사이에서 데이터가 어떻게 흐르는지 단계별로 보여 준다(연결 → 덤프 → 변경분 → 준비 완료). */
export default function ReplicationDiagram({ phase, done }: { phase: ReplicationPhase; done: boolean }) {
  const t = useT()
  const flow = done ? 'is-solid' : phase === 'dump' ? 'is-bulk' : phase === 'cdc' ? 'is-stream' : 'is-idle'
  return <svg className="arch arch-wide" viewBox="0 0 330 130" role="img" aria-label={t('repl.aria')}>
    <text className="arch-sub" x="60" y="10" textAnchor="middle">{t('repl.app')}</text>
    <line className="arch-edge is-solid-line" x1="60" y1="14" x2="60" y2="40" />
    <path className="arch-arrow" d="M56 36 L60 42 L64 36" />
    <Cylinder x={22} y={44} w={76} h={54} className="is-done" />
    <Cylinder x={232} y={44} w={76} h={54} className={phase === 'connect' ? 'is-off' : 'is-done'} />
    <text className="arch-text" x="60" y="118" textAnchor="middle">{t('repl.source')}</text>
    <text className="arch-text" x="270" y="118" textAnchor="middle">{t('repl.target')}</text>
    <text className="arch-edge-label" x="165" y="62" textAnchor="middle">WireGuard</text>
    <line className={'repl-flow ' + flow} x1="102" y1="74" x2="228" y2="74" />
    {done && <text className="arch-text" x="165" y="96" textAnchor="middle">✓</text>}
  </svg>
}
