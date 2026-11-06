'use client'

import { useT, useTOr } from '../lib/i18n'
import { useMigration } from '../lib/migration/MigrationProvider'
import { PHASE_OF_STAGE } from '../lib/migration/events'
import { BACKEND_PENDING, SOURCE_REQUIRED } from '../lib/migration/sseProvider'
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
export function StatusPanel({ stage, onHome, onSetup }: { stage: Stage; onHome: () => void; onSetup?: () => void }) {
  const t = useT()
  const tOr = useTOr()
  const { state, provider, can } = useMigration()
  const phase = stage in PHASE_OF_STAGE ? PHASE_OF_STAGE[stage as keyof typeof PHASE_OF_STAGE] : null
  if (!phase) return null

  // 샌드박스 루프가 최대 시도를 넘으면 사람 검토를 기다린다: 수정 후 재시도 또는 취소만 있다.
  if (stage === 'rehearsal' && state.build.review && state.status !== 'cancelled') {
    return <section className="flow-stage approval-stage is-ready" role="alert" aria-label={t('review.step')}>
      <div className="approval-panel">
        <small className="approval-step">{t('review.step')}</small>
        <h2>{t('review.title')}</h2>
        <p className="approval-lead">{t('review.lead', { n: state.build.review.attempts })}</p>
        <p className="approval-lead">{t('review.hint')}</p>
        <div className="approval-actions">
          <button type="button" className="flow-secondary" onClick={() => provider.cancel()}>{t('review.cancel')}</button>
          {/* 실제 모드: 재시도 API(sandbox.retry)가 아직 없으면 버튼을 숨긴다(capabilities.ts). */}
          {can('sandbox.retry') && <button type="button" className="flow-primary" onClick={() => provider.retrySandbox()}>{t('review.retry')} <span aria-hidden="true">→</span></button>}
        </div>
      </div>
    </section>
  }

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
  // 시작하지 않고 멈춘 경우(SSE): 실패가 아니라 대기 안내. 분석이 시작된 것처럼 보이지 않게 단계 화면을 덮는다.
  if (failure.code === BACKEND_PENDING || failure.code === SOURCE_REQUIRED) {
    return <section className="flow-stage approval-stage is-ready" role="alert" aria-label={t('pending.step')}>
      <div className="approval-panel">
        <small className="approval-step">{t('pending.step')}</small>
        <h2>{t('pending.title')}</h2>
        <p className="approval-lead">{t(failure.code === BACKEND_PENDING ? 'pending.lead' : 'pending.sourceLead')}</p>
        <div className="approval-actions">
          <button type="button" className="flow-secondary" onClick={onHome}>{t('pending.home')}</button>
          {onSetup && <button type="button" className="flow-primary" onClick={onSetup}>{t('pending.setup')} <span aria-hidden="true">→</span></button>}
        </div>
      </div>
    </section>
  }
  // 웹 서버가 돌려준 오류 코드(예: APPROVER_TOKEN_NOT_CONFIGURED)가 있으면 그 원인 문구를 보여 준다.
  const detail = 'detail' in failure && typeof failure.detail === 'string' ? failure.detail : ''
  return <section className="flow-stage approval-stage is-ready" role="alert" aria-label={t('fail.step')}>
    <div className="approval-panel">
      <small className="approval-step">{t('fail.step')}</small>
      <h2>{t('fail.title')}</h2>
      <p className="approval-lead">{(detail && tOr('cx.code.' + detail, '')) || failure.message || t('fail.lead')}</p>
      <p className="approval-lead">{t('fail.noRetry')}{failure.code ? ' (' + t('fail.code', { code: detail || failure.code }) + ')' : ''}</p>
      <div className="approval-actions">
        <button type="button" className="flow-primary" onClick={onHome}>{t('fail.home')} <span aria-hidden="true">→</span></button>
      </div>
    </div>
  </section>
}
