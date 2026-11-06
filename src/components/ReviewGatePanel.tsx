'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useT, useTOr, type MsgKey } from '../lib/i18n'
import { useMigration } from '../lib/migration/MigrationProvider'
import { approvalIds, approvalsOf, defaultRequired, reviewBlocked, reviewErrorKey, reviewWaiting, type ReviewDecision, type ReviewResult, type ReviewView } from '../lib/migration/review'

const POLL_MS = 2000

/**
 * 실제 서버의 분석 검토 게이트를 읽는다(2초마다). 서버에 검토 API가 없거나 이전이 아직 시작되지 않았으면 view는 null.
 * 목업은 검토 단계가 없어 아무것도 읽지 않는다.
 */
export function useReviewGate(active: boolean) {
  const { provider, mode } = useMigration()
  const [view, setView] = useState<ReviewView | null>(null)
  useEffect(() => {
    if (!active || mode !== 'sse') return
    let alive = true
    const read = async () => { const next = await provider.loadReview(); if (alive) setView(next) }
    void read()
    const timer = window.setInterval(read, POLL_MS)
    return () => { alive = false; window.clearInterval(timer) }
  }, [provider, mode, active])
  return { view, setView }
}

const GRADE_TONE: Record<string, string> = { DIRECT: 'is-direct', PARTIAL: 'is-partial', NONE: 'is-none' }

/**
 * 분석 검토 게이트 화면. 분석 매핑이 끝나면 서버가 사람의 결정을 기다린다(자동 승인은 없다):
 * ① 필수 기능 확정 ② 이전하면 잃는 것·보안이 낮아지는 항목의 승인·거절. 서버가 준 항목을 그대로 보여 주고,
 * 서버가 요구하는 모양(모든 행에 답하기)으로 보낸다.
 */
export default function ReviewGatePanel({ view, onView }: { view: ReviewView; onView: (view: ReviewView | null) => void }) {
  const t = useT()
  const tOr = useTOr()
  const { provider } = useMigration()
  const [required, setRequired] = useState<Record<string, boolean>>(() => defaultRequired(view))
  const [choices, setChoices] = useState<Record<string, ReviewDecision | undefined>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const blocked = reviewBlocked(view)
  const pending = view.pending

  // 새 분석 버전이 오면(재분석) 서버 제안으로 다시 시작한다.
  const version = view.analysis_ref?.version
  useEffect(() => { setRequired(defaultRequired(view)); setChoices({}); setError(null) }, [version]) // eslint-disable-line react-hooks/exhaustive-deps

  const answers = useMemo(() => approvalsOf(view, choices), [view, choices])
  const needed = approvalIds(view)

  const send = useCallback(async (run: () => Promise<ReviewResult>) => {
    setBusy(true)
    setError(null)
    const result = await run()
    setBusy(false)
    if (result.ok) onView(result.view)
    else setError(result.code)
  }, [onView])

  const gradeText = (grade: string) => tOr('reviewGate.grade.' + grade, grade)
  const stepNo = pending === 'approve_losses' ? 2 : 1

  if (blocked) return <div className="review-overlay" role="dialog" aria-modal="true" aria-label={t('reviewGate.blocked.title')}>
    <section className="review-card is-blocked">
      <header><small>{t('reviewGate.step.blocked')}</small><h2>{t('reviewGate.blocked.title')}</h2><p>{t('reviewGate.blocked.lead')}</p></header>
      <ul className="review-list">
        {view.blocked.map(item => <li key={item.id}>
          <div><strong>{item.capability === 'security' ? tOr('reviewGate.criterion.' + item.usage, item.usage) : item.capability}</strong>
            <span className={'review-grade ' + (GRADE_TONE[item.grade] ?? '')}>{gradeText(item.grade)}</span></div>
          <p>{item.reason}</p>
          {item.alternative && <p className="review-sub">{item.alternative}</p>}
        </li>)}
      </ul>
    </section>
  </div>

  if (!reviewWaiting(view)) return null

  return <div className="review-overlay" role="dialog" aria-modal="true" aria-label={t('reviewGate.title')}>
    <section className="review-card">
      <header>
        <small>{t('reviewGate.step', { n: stepNo })} · {pending === 'confirm_requirements' ? t('reviewGate.step.confirm') : t('reviewGate.step.approve')}</small>
        <h2>{t('reviewGate.title')}</h2>
        <p>{pending === 'confirm_requirements' ? t('reviewGate.confirm.lead') : t('reviewGate.approve.lead')}</p>
      </header>

      {pending === 'confirm_requirements' && <>
        {view.items.length === 0
          ? <p className="review-empty">{t('reviewGate.confirm.none')}</p>
          : <ul className="review-list" aria-label={t('reviewGate.confirm.list')}>
              {view.items.map(item => <li key={item.id} className={required[item.id] ? 'is-required' : ''}>
                <div>
                  <strong>{item.capability}</strong>
                  <span className={'review-grade ' + (GRADE_TONE[item.grade] ?? '')} title={t('reviewGate.grade.hint')}>{gradeText(item.grade)}</span>
                </div>
                {item.usage && <p>{item.usage}</p>}
                {item.loses.length > 0 && <p className="review-sub">{t('reviewGate.loses')}: {item.loses.join(' · ')}</p>}
                <label className="review-toggle">
                  <input type="checkbox" checked={!!required[item.id]} disabled={busy}
                    onChange={event => setRequired(current => ({ ...current, [item.id]: event.target.checked }))} />
                  <span>{t('reviewGate.required')}</span>
                  {item.required_reason && <em>{t('reviewGate.proposed', { why: item.required_reason })}</em>}
                </label>
              </li>)}
            </ul>}
        <footer>
          <small>{t('reviewGate.confirm.note')}</small>
          <button type="button" className="flow-primary" disabled={busy} onClick={() => send(() => provider.confirmReview(required))}>
            {busy ? t('reviewGate.sending') : t('reviewGate.confirm.send')}
          </button>
        </footer>
      </>}

      {pending === 'approve_losses' && <>
        <ul className="review-list" aria-label={t('reviewGate.approve.list')}>
          {view.items.filter(item => item.treatment === 'APPROVAL').map(item => <li key={item.id}>
            <div><strong>{item.capability}</strong><span className={'review-grade ' + (GRADE_TONE[item.grade] ?? '')}>{gradeText(item.grade)}</span></div>
            {item.usage && <p>{item.usage}</p>}
            {item.loses.length > 0 && <p className="review-sub">{t('reviewGate.loses')}: {item.loses.join(' · ')}</p>}
            <Decision id={item.id} choice={choices[item.id]} busy={busy} onChoice={value => setChoices(current => ({ ...current, [item.id]: value }))} />
          </li>)}
          {view.security.filter(item => item.approvable).map(item => <li key={item.id} className="is-security">
            <div>
              <strong>{tOr('reviewGate.criterion.' + item.criterion, item.criterion)}</strong>
              <span className="review-grade is-lower">{t('reviewGate.security.lower')}</span>
            </div>
            <p>{tOr('reviewGate.state.' + item.source_state, item.source_state)} → {tOr('reviewGate.state.' + item.target_state, item.target_state)}</p>
            {item.reasons.length > 0 && <p className="review-sub">{item.reasons.map(code => tOr('reviewGate.reason.' + code, code)).join(' · ')}</p>}
            {item.suggestion && <p className="review-sub">{t('reviewGate.security.suggest')}: {tOr('reviewGate.suggest.' + item.suggestion, item.suggestion)}</p>}
            <Decision id={item.id} choice={choices[item.id]} busy={busy} onChoice={value => setChoices(current => ({ ...current, [item.id]: value }))} />
          </li>)}
        </ul>
        <footer>
          <small>{t('reviewGate.approve.note')}</small>
          <button type="button" className="flow-primary" disabled={busy || !answers}
            onClick={() => answers && send(() => provider.approveReview(answers))}>
            {busy ? t('reviewGate.sending') : t('reviewGate.approve.send', { n: needed.length })}
          </button>
        </footer>
      </>}

      {error && <p className="review-error" role="alert">{t(reviewErrorKey(error) as MsgKey)}<small> ({error})</small></p>}
    </section>
  </div>
}

function Decision({ id, choice, busy, onChoice }: { id: string; choice: ReviewDecision | undefined; busy: boolean; onChoice: (value: ReviewDecision) => void }) {
  const t = useT()
  return <div className="review-decision" role="radiogroup" aria-label={id}>
    <button type="button" role="radio" aria-checked={choice === 'APPROVED'} disabled={busy}
      className={'flow-secondary' + (choice === 'APPROVED' ? ' is-picked' : '')} onClick={() => onChoice('APPROVED')}>{t('reviewGate.decision.approve')}</button>
    <button type="button" role="radio" aria-checked={choice === 'REJECTED'} disabled={busy}
      className={'flow-secondary' + (choice === 'REJECTED' ? ' is-picked is-reject' : '')} onClick={() => onChoice('REJECTED')}>{t('reviewGate.decision.reject')}</button>
  </div>
}
