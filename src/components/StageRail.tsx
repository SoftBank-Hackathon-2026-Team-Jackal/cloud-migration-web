'use client'

import { useT, type MsgKey } from '../lib/i18n'
import { RAIL, STAGE_ORDER, type Stage } from '../lib/stages'

/** 분석 이후 단계의 위치를 작게 보여 주는 진행 표시. 완료 리포트(report)에서는 모든 단계가 끝난 것으로 보인다. */
export default function StageRail({ stage }: { stage: Stage }) {
  const t = useT()
  const current = STAGE_ORDER.indexOf(stage)
  return <nav className="stage-rail" aria-label={t('rail.aria')}>
    <ol>
      {RAIL.map(item => {
        const index = STAGE_ORDER.indexOf(item.stage)
        const state = index < current ? 'is-done' : index === current ? 'is-current' : ''
        return <li key={item.stage} className={state} aria-current={state === 'is-current' ? 'step' : undefined}>
          <span aria-hidden="true" />
          {t(('rail.' + item.stage) as MsgKey)}
        </li>
      })}
    </ol>
  </nav>
}
