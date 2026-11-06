'use client'

import { useT, type MsgKey } from '../lib/i18n'
import { DB_FIRST_ORDER, DB_FIRST_RAIL, RAIL, STAGE_ORDER, type Stage } from '../lib/stages'

/**
 * 분석 이후 단계의 위치를 작게 보여 주는 진행 표시.
 * dbFirst: 플랫폼 실제 순서(데이터 → DB 전환 → 트래픽). complete: 모든 단계를 끝난 것으로(완료 리포트).
 */
export default function StageRail({ stage, dbFirst = false, complete = false }: { stage: Stage; dbFirst?: boolean; complete?: boolean }) {
  const t = useT()
  const order = dbFirst ? DB_FIRST_ORDER : STAGE_ORDER
  const current = complete ? order.length : order.indexOf(stage)
  return <nav className="stage-rail" aria-label={t('rail.aria')}>
    <ol>
      {(dbFirst ? DB_FIRST_RAIL : RAIL).map(item => {
        const index = order.indexOf(item.stage)
        const state = index < current ? 'is-done' : index === current ? 'is-current' : ''
        return <li key={item.stage} className={state} aria-current={state === 'is-current' ? 'step' : undefined}>
          <span aria-hidden="true" />
          {t(('rail.' + item.stage) as MsgKey)}
        </li>
      })}
    </ol>
  </nav>
}
