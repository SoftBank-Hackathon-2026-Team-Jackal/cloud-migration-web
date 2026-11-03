'use client'

import { useT } from '../lib/i18n'
import { Cylinder } from './DiagramParts'

/**
 * DB 전환 6단계를 그림으로 보여 준다. steps는 끝난 단계 수(0~6).
 * 1 쓰기 일시 중단 → 2 마지막 동기화 → 3 원본 쓰기 차단 → 4 대상 승격 → 5 연결 재개 → 6 역방향 복제(제안안)
 */
export default function CutoverDiagram({ steps }: { steps: number }) {
  const t = useT()
  const paused = steps >= 1 && steps < 5
  const toTarget = steps >= 5
  return <svg className="arch arch-wide" viewBox="0 0 330 170" role="img" aria-label={t('cut.aria')}>
    <g className="arch-node is-done">
      <rect className="arch-box" x="120" y="4" width="90" height="24" rx="8" />
      <text className="arch-text" x="165" y="20" textAnchor="middle">{t('cut.app')}</text>
    </g>
    <line className={'arch-edge' + (paused ? ' is-dashed' : '')} x1="165" y1="28" x2="165" y2="52" />
    <g className="arch-node is-done">
      <rect className="arch-box is-entry" x="105" y="52" width="120" height="26" rx="8" />
      <text className="arch-text arch-on-dark" x="165" y="69" textAnchor="middle">PgBouncer{paused ? ' · PAUSE' : ''}</text>
    </g>

    <line className={'arch-edge' + (toTarget ? ' is-off-line' : '')} x1="140" y1="78" x2="66" y2="104" />
    <line className={'arch-edge' + (toTarget ? '' : ' is-off-line')} x1="190" y1="78" x2="264" y2="104" />

    <Cylinder x={28} y={104} w={76} h={46} className={steps >= 3 ? 'is-blocked' : 'is-done'} />
    <Cylinder x={226} y={104} w={76} h={46} className={steps >= 4 ? 'is-done' : 'is-on'} />
    <text className="arch-text" x="66" y="166" textAnchor="middle">{t('repl.source')}{steps >= 3 ? ' · ✕' : ''}</text>
    <text className="arch-text" x="264" y="166" textAnchor="middle">{t('repl.target')}{steps >= 4 ? ' · ' + t('cut.primary') : ''}</text>

    {steps === 2 && <>
      <line className="repl-flow is-bulk" x1="108" y1="128" x2="222" y2="128" />
      <text className="arch-edge-label" x="165" y="120" textAnchor="middle">{t('cut.sync')}</text>
    </>}
    {steps >= 3 && steps < 6 && <text className="arch-edge-label" x="66" y="98" textAnchor="middle">{t('cut.blocked')}</text>}
    {steps >= 6 && <>
      <line className="repl-flow is-stream is-reverse" x1="222" y1="140" x2="108" y2="140" />
      <text className="arch-edge-label" x="165" y="154" textAnchor="middle">{t('cut.reverse')}</text>
    </>}
  </svg>
}
