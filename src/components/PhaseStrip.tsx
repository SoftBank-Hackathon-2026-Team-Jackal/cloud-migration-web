'use client'

import type { ReactNode } from 'react'
import { orderKey, useT } from '../lib/i18n'

/**
 * 데이터 → 트래픽 → DB 전환을 한 줄로 잇는 두 줄 띠(앱 트래픽 / DB).
 * 게이트 0 사전 검사 PASS → 복제 시작 · 게이트 1 지연≈0 → 트래픽 이전 · 게이트 2 트래픽 0:100 → PgBouncer 전환.
 * 복제는 트래픽을 옮기는 내내 계속 흐르고(쓰기는 PgBouncer를 거쳐 원본 DB로), 원본 앱을 멈춘 뒤 DB를 전환한다.
 * position은 띠 위의 지금 위치(0~100). 화면마다 자기 자리를 넘긴다.
 * dbFirst(플랫폼 실제 순서): 게이트 1 뒤에 PgBouncer 전환이 먼저 오고 트래픽을 옮긴다. 자리·요소는 같고 DB 줄 문구만 바꾼다.
 */
export const STRIP_GATE = { preflight: 13, synced: 48, switchover: 86 } as const

export type GateState = 'wait' | 'pass' | 'fail'

type Props = {
  position: number
  gates: [GateState, GateState, GateState]
  /** 시작 차단: DB 줄의 진행을 빨간 실패 코드 색으로 */
  blocked?: boolean
  /** 실제 순서(데이터 → DB 전환 → 트래픽): DB 줄 문구를 그 순서로 */
  dbFirst?: boolean
  /** 트래픽 화면처럼 이미 다른 단계 화면이면 한 줄 높이로 줄인다 */
  compact?: boolean
  note?: string
  action?: ReactNode
}

const clamp = (value: number) => Math.max(0, Math.min(100, value))

export default function PhaseStrip({ position, gates, blocked = false, compact = false, dbFirst = false, note, action }: Props) {
  const t = useT()
  const now = clamp(position)
  const gateAt = [STRIP_GATE.preflight, STRIP_GATE.synced, STRIP_GATE.switchover]
  // 앱 트래픽은 게이트 1부터 옮겨지기 시작한다.
  const appFill = now > STRIP_GATE.synced ? now - STRIP_GATE.synced : 0
  return <section className={'ps' + (compact ? ' is-compact' : '')} aria-label={t('strip.aria')}>
    <div className="ps-lanes" role="img" aria-label={t('strip.now', { gate: gates.filter(gate => gate === 'pass').length })}>
      <span className="ps-lane-name ps-app">{t('strip.app')}</span>
      <span className="ps-lane-name ps-db">{t('strip.db')}</span>
      <div className="ps-track">
        <div className="ps-lane is-app"><i style={{ left: STRIP_GATE.synced + '%', width: appFill + '%' }} /></div>
        <div className={'ps-lane is-db' + (blocked ? ' is-blocked' : '')}><i style={{ width: now + '%' }} /></div>
        <span className="ps-seg ps-app" style={{ left: '1%' }}>{t('strip.app.source')}</span>
        <span className="ps-seg ps-app" style={{ left: STRIP_GATE.synced + 1.5 + '%' }}>{t('strip.app.shift')}</span>
        <span className="ps-seg ps-app is-tail" style={{ left: STRIP_GATE.switchover + 1.5 + '%' }}>{t('strip.app.stop')}</span>
        <span className="ps-seg ps-db" style={{ left: '1%' }}>{t('strip.db.preflight')}</span>
        <span className="ps-seg ps-db is-minor" style={{ left: STRIP_GATE.preflight + 2 + '%' }}>{t('strip.db.copy')}</span>
        <span className="ps-seg ps-db is-minor" style={{ left: '29%' }}>{t('strip.db.cdc')}</span>
        <span className="ps-seg ps-db" style={{ left: STRIP_GATE.synced + 1.5 + '%' }}>{t(orderKey('strip.db.synced', dbFirst))}</span>
        <span className="ps-seg ps-db is-tail" style={{ left: STRIP_GATE.switchover + 1.5 + '%' }}>{t(orderKey('strip.db.switch', dbFirst))}</span>
        {gateAt.map((at, index) => <span key={index} className={'ps-gate is-' + gates[index] + (index > 0 ? ' is-sync' : '')} style={{ left: at + '%' }}>
          <b>{index}</b>
        </span>)}
        <span className="ps-now" style={{ left: now + '%' }} aria-hidden="true" />
      </div>
    </div>
    {(note || action) && <div className="ps-side">
      {note && <small role="status">{note}</small>}
      {action}
    </div>}
  </section>
}
