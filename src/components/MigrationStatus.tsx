'use client'

import { useT } from '../lib/i18n'
import { useMigration } from '../lib/migration/MigrationProvider'
import { PHASE_OF_STAGE } from '../lib/migration/events'
import type { Stage } from '../lib/stages'

/** 연결이 끊겨 다시 연결하는 동안 화면 아래에 뜨는 안내. 복구되면 사라진다(기존 토스트 스타일 재사용). */
export function ConnectionToast() {
  const t = useT()
  const { state } = useMigration()
  const on = state.connection === 'reconnecting'
  return <div className={'flow-toast' + (on ? ' is-on' : '')} role="status" aria-hidden={!on}>{t('conn.reconnecting')}</div>
}

/**
 * 이전이 실패했거나 취소됐을 때 지금 단계 화면 위에 보여 주는 안내.
 * 실패는 그 단계(또는 어느 단계에도 속하지 않는 오류)일 때만, 취소는 모든 단계에서 보인다.
 * 승인 화면의 "승인하지 않고 취소"는 그 화면 자체의 안내를 쓰므로 여기서는 보이지 않는다.
 */
export function StatusPanel({ stage, onHome }: { stage: Stage; onHome: () => void }) {
  const t = useT()
  const { state } = useMigration()
  const phase = stage in PHASE_OF_STAGE ? PHASE_OF_STAGE[stage as keyof typeof PHASE_OF_STAGE] : null
  if (!phase) return null

  if (state.status === 'cancelled' && stage !== 'approval') {
    return <section className="flow-stage approval-stage is-ready" role="alert" aria-label={t('cancel.step')}>
      <div className="approval-panel">
        <small className="approval-step">{t('cancel.step')}</small>
        <h2>{t('cancel.title')}</h2>
        <p className="approval-lead">{t('cancel.lead')}</p>
        <div className="approval-actions">
          <button type="button" className="flow-primary" onClick={onHome}>{t('cancel.home')} <span aria-hidden="true">→</span></button>
        </div>
      </div>
    </section>
  }

  const failure = state.status === 'failed' ? (state.failures[phase] ?? (state.error && state.error.phase === null ? state.error : undefined)) : undefined
  if (!failure) return null
  return <section className="flow-stage approval-stage is-ready" role="alert" aria-label={t('fail.step')}>
    <div className="approval-panel">
      <small className="approval-step">{t('fail.step')}</small>
      <h2>{t('fail.title')}</h2>
      <p className="approval-lead">{failure.message || t('fail.lead')}</p>
      <p className="approval-lead">{t('fail.noRetry')}{failure.code ? ' (' + t('fail.code', { code: failure.code }) + ')' : ''}</p>
      <div className="approval-actions">
        <button type="button" className="flow-primary" onClick={onHome}>{t('fail.home')} <span aria-hidden="true">→</span></button>
      </div>
    </div>
  </section>
}
