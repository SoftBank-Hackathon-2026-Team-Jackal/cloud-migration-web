'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useT, useTOr, type MsgKey } from '../lib/i18n'
import { useMigration } from '../lib/migration/MigrationProvider'
import {
  approvalIds, approvalsOf, approvePreview, blockedText, confirmOutcome, confirmPreview, decisionOutcome, defaultRequired, proofKey,
  reviewBlocked, reviewErrorKey, reviewPollMs, reviewWaiting, securityRows,
  type ReviewBlocked, type ReviewDecision, type ReviewItem, type ReviewOutcome, type ReviewResult, type ReviewSecurity, type ReviewView,
} from '../lib/migration/review'

/**
 * 실제 서버의 분석 검토 게이트를 읽는다. 서버에 검토 API가 없거나 이전이 아직 시작되지 않았으면 view는 null.
 * 목업은 검토 단계가 없어 아무것도 읽지 않는다.
 * 읽는 주기는 reviewPollMs: 분석이 끝났는데 게이트가 아직 서지 않았으면 0.3초, 그 밖에는 2초.
 * known: analysisDone이 된 뒤에 검토 상태를 한 번 이상 읽었는지(404도 읽은 것). 분석이 끝나면 바로 한 번 더 읽는다:
 * 서버는 analysis.done 뒤에 매핑하고 게이트에서 멈추므로, 그 전에 읽은 값으로 '끝났다'고 보면 게이트를 건너뛴다.
 * active가 꺼져도 마지막 view는 남는다(막힘 안내가 계속 보이게). 막힘 화면에서 나가면(dismiss) 이 이전의 검토는 더 띄우지 않는다.
 */
export function useReviewGate(active: boolean, analysisDone: boolean) {
  const { provider, mode, state } = useMigration()
  const [view, setView] = useState<ReviewView | null>(null)
  const [known, setKnown] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const migrationId = state.migrationId
  const latest = useRef<ReviewView | null>(null)
  latest.current = view
  // 다른 이전을 시작하면 지난 검토 값은 버린다.
  useEffect(() => { setView(null); setKnown(false); setDismissed(false) }, [migrationId])
  useEffect(() => {
    if (!active || mode !== 'sse' || dismissed) return
    let alive = true
    let timer = 0
    if (analysisDone) setKnown(false)
    const read = async () => {
      const next = await provider.loadReview()
      if (!alive) return
      if (next !== undefined) {
        latest.current = next
        setView(next)
        if (analysisDone) setKnown(true)
      }
      timer = window.setTimeout(read, reviewPollMs({ analysisDone, view: latest.current }))
    }
    void read()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [provider, mode, active, analysisDone, migrationId, dismissed])
  const dismiss = useCallback(() => { setDismissed(true); setView(null) }, [])
  return { view: dismissed ? null : view, known, setView, dismiss }
}

const GRADE_TONE: Record<string, string> = { DIRECT: 'is-direct', API_DIFF: 'is-direct', PARTIAL: 'is-partial', NONE: 'is-none' }

type Props = {
  view: ReviewView
  onView: (view: ReviewView | null) => void
  /** 분석 화면 위에서는 분석을 옅게 남긴 시트로, 다른 화면에서는 같은 모양으로 더 짙게 띄운다. */
  inline?: boolean
  onHome: () => void
  onSetup: () => void
}

/**
 * 분석 검토 게이트 화면. 분석 매핑이 끝나면 서버가 사람의 결정을 기다린다(자동 승인은 없다):
 * ① 필수 기능 확정 ② 이전하면 잃는 것·보안이 낮아지는 항목의 승인·거절. 서버가 준 항목을 그대로 보여 주고,
 * 서버가 요구하는 모양(모든 행에 답하기)으로 보낸다. 행마다 지금 선택의 결과(등급 × 필수)를 미리 보여 준다.
 */
export default function ReviewGatePanel({ view, onView, inline = false, onHome, onSetup }: Props) {
  const t = useT()
  const tOr = useTOr()
  const titleId = useId()
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
  const preview = useMemo(() => confirmPreview(view, required), [view, required])
  const stops = useMemo(() => approvePreview(view, choices), [view, choices])

  const send = useCallback(async (run: () => Promise<ReviewResult>) => {
    setBusy(true)
    setError(null)
    const result = await run()
    setBusy(false)
    if (result.ok) onView(result.view)
    else setError(result.code)
  }, [onView])

  const capName = (capability: string) => tOr('reviewGate.cap.' + capability, capability)
  const criterionName = (criterion: string) => tOr('reviewGate.criterion.' + criterion, criterion)
  const gradeText = (grade: string) => tOr('reviewGate.grade.' + grade, grade)
  const nameOf = (id: string) => {
    const item = view.items.find(entry => entry.id === id)
    if (item) return capName(item.capability)
    const security = view.security.find(entry => entry.id === id)
    return security ? criterionName(security.criterion) : id
  }
  const sheet = (body: ReactNode, aside: boolean) =>
    <div className={'review-sheet' + (inline ? ' is-inline' : ' is-float')} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <section className={'approval-panel review-panel' + (aside ? ' has-aside' : '') + (blocked ? ' is-blocked' : '')}>
        {body}
        {aside && <SecurityTable rows={securityRows(view)} step={blocked ? 'blocked' : pending === 'approve_losses' ? 'approve' : 'confirm'} />}
      </section>
    </div>

  if (blocked) return sheet(<div className="review-main">
    <small className="approval-step review-step is-stop">{t('reviewGate.step.blocked')}</small>
    <h2 id={titleId} aria-level={1}>{t('reviewGate.blocked.title')}</h2>
    <p className="approval-lead">{t('reviewGate.blocked.lead')}</p>
    <ul className="review-ledger is-blocked" aria-label={t('reviewGate.step.blocked')}>
      {view.blocked.map(item => <BlockedRow key={item.id} item={item} capName={capName} criterionName={criterionName} gradeText={gradeText} />)}
    </ul>
    <div className="approval-actions review-actions">
      <button type="button" className="flow-secondary" onClick={onSetup}>{t('reviewGate.blocked.setup')}</button>
      <button type="button" className="flow-primary" onClick={onHome}>{t('reviewGate.blocked.home')} <span aria-hidden="true">→</span></button>
    </div>
  </div>, view.security.length > 0)

  if (!reviewWaiting(view)) return null
  const stepNo = pending === 'approve_losses' ? 2 : 1
  const stepHead = <>
    <small className="approval-step review-step">
      <span className="review-dots" aria-hidden="true"><i className="is-on" /><i className={stepNo === 2 ? 'is-on' : ''} /></span>
      {t('reviewGate.step', { n: stepNo })} · {pending === 'confirm_requirements' ? t('reviewGate.step.confirm') : t('reviewGate.step.approve')}
    </small>
    <h2 id={titleId} aria-level={1}>{t('reviewGate.title')}</h2>
  </>
  const errorLine = error && <p className="review-error" role="alert">{t(reviewErrorKey(error) as MsgKey)}<small> ({error})</small></p>

  if (pending === 'confirm_requirements') {
    const stopping = preview.blocks.length > 0
    return sheet(<div className="review-main">
      {stepHead}
      <p className="approval-lead">{t('reviewGate.confirm.lead')}</p>
      {view.items.length === 0
        ? <p className="review-empty">{t('reviewGate.confirm.none')}</p>
        : <ul className="review-ledger" aria-label={t('reviewGate.confirm.list')}>
            <li className="review-head" aria-hidden="true">
              <span>{t('reviewGate.col.feature')}</span><span>{t('reviewGate.col.grade')}</span><span>{t('reviewGate.col.choice')}</span><span>{t('reviewGate.col.outcome')}</span>
            </li>
            {view.items.map(item => <ConfirmRow key={item.id} item={item} name={capName(item.capability)} gradeText={gradeText}
              required={!!required[item.id]} busy={busy} onPick={value => setRequired(current => ({ ...current, [item.id]: value }))} />)}
          </ul>}
      {view.items.length > 0 && <p className="review-summary">{t('reviewGate.summary', { p: preview.proceeds.length, a: preview.approvals.length, b: preview.blocks.length })}</p>}
      {stopping && <p className="review-warn" role="alert">{t('reviewGate.warn.confirm', { names: preview.blocks.map(nameOf).join(', ') })}</p>}
      {errorLine}
      <div className="approval-actions review-actions">
        <small>{t('reviewGate.confirm.note')}</small>
        <button type="button" className="flow-primary" disabled={busy} onClick={() => send(() => provider.confirmReview(required))}>
          {busy ? t('reviewGate.sending') : stopping ? t('reviewGate.confirm.sendStop') : t('reviewGate.confirm.send')} {!busy && <span aria-hidden="true">→</span>}
        </button>
      </div>
    </div>, true)
  }

  const pick = (id: string) => (value: ReviewDecision) => setChoices(current => ({ ...current, [id]: value }))
  const stopping = stops.length > 0
  return sheet(<div className="review-main">
    {stepHead}
    <p className="approval-lead">{t('reviewGate.approve.lead')}</p>
    <ul className="review-ledger" aria-label={t('reviewGate.approve.list')}>
      <li className="review-head" aria-hidden="true">
        <span>{t('reviewGate.col.item')}</span><span>{t('reviewGate.col.grade')}</span><span>{t('reviewGate.col.decision')}</span><span>{t('reviewGate.col.outcome')}</span>
      </li>
      {view.items.filter(item => item.treatment === 'APPROVAL').map(item => <DecisionRow key={item.id} name={capName(item.capability)} sub={item.usage}
        badge={<span className={'review-grade ' + (GRADE_TONE[item.grade] ?? '')}>{gradeText(item.grade)}</span>}
        meta={item.loses.length > 0 ? [t('reviewGate.loses') + ': ' + item.loses.join(' · ')] : []}
        approveLabel={t('reviewGate.decision.lose')} choice={choices[item.id]} busy={busy} onChoice={pick(item.id)} />)}
      {view.security.filter(item => item.approvable).map(item => <DecisionRow key={item.id} name={criterionName(item.criterion)} security
        badge={<span className="review-compare">{tOr('reviewGate.state.' + item.source_state, item.source_state)} → {tOr('reviewGate.state.' + item.target_state, item.target_state)}</span>}
        meta={securityMeta(item, tOr, t)}
        approveLabel={t('reviewGate.decision.lower')} choice={choices[item.id]} busy={busy} onChoice={pick(item.id)} />)}
    </ul>
    {stopping && <p className="review-warn" role="alert">{t('reviewGate.warn.approve', { names: stops.map(nameOf).join(', ') })}</p>}
    {errorLine}
    <div className="approval-actions review-actions">
      <small>{t('reviewGate.approve.note')}</small>
      <button type="button" className="flow-primary" disabled={busy || !answers}
        onClick={() => answers && send(() => provider.approveReview(answers))}>
        {busy ? t('reviewGate.sending') : stopping ? t('reviewGate.approve.sendStop') : t('reviewGate.approve.send', { n: needed.length })} {!busy && <span aria-hidden="true">→</span>}
      </button>
    </div>
  </div>, true)
}

type TOr = ReturnType<typeof useTOr>
type T = ReturnType<typeof useT>

/** 보안 행 아래 줄: 사유 · 제안 · 증명 방식 */
function securityMeta(item: ReviewSecurity, tOr: TOr, t: T): string[] {
  const proof = proofKey(item.proof)
  return [
    item.reasons.length > 0 ? item.reasons.map(code => tOr('reviewGate.reason.' + code, code)).join(' · ') : '',
    item.suggestion && (item.verdict === 'LOWER' || item.weak_source) ? t('reviewGate.security.suggest') + ': ' + tOr('reviewGate.suggest.' + item.suggestion, item.suggestion) : '',
    proof ? t(proof as MsgKey) : '',
  ].filter(Boolean)
}

const OUTCOME_KEY: Record<ReviewOutcome, MsgKey> = { proceed: 'reviewGate.outcome.proceed', approval: 'reviewGate.outcome.approval', block: 'reviewGate.outcome.block' }

function Outcome({ outcome, label }: { outcome: ReviewOutcome | null; label?: string }) {
  const t = useT()
  return <span className={'review-outcome is-' + (outcome ?? 'pending')} aria-live="polite">
    <i aria-hidden="true" />{outcome ? label ?? t(OUTCOME_KEY[outcome]) : t('reviewGate.outcome.pending')}
  </span>
}

/** 두 칸짜리 알약 선택(라디오). 좌우 화살표로도 고른다. */
function Segmented<V extends string | boolean>({ label, value, options, busy, onPick }: {
  label: string
  value: V | undefined
  options: Array<{ value: V; label: string; stop?: boolean }>
  busy: boolean
  onPick: (value: V) => void
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const at = Math.max(0, options.findIndex(option => option.value === value))
    const next = (at + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? options.length - 1 : 1)) % options.length
    onPick(options[next].value)
    refs.current[next]?.focus()
  }
  const focusable = Math.max(0, options.findIndex(option => option.value === value))
  return <div className="review-seg" role="radiogroup" aria-label={label} onKeyDown={onKey}>
    {options.map((option, index) => <button key={String(option.value)} ref={element => { refs.current[index] = element }} type="button" role="radio"
      aria-checked={option.value === value} tabIndex={index === focusable ? 0 : -1} disabled={busy}
      className={(option.value === value ? 'is-on' : '') + (option.stop ? ' is-stop' : '')} onClick={() => onPick(option.value)}>{option.label}</button>)}
  </div>
}

function ConfirmRow({ item, name, gradeText, required, busy, onPick }: {
  item: ReviewItem; name: string; gradeText: (grade: string) => string; required: boolean; busy: boolean; onPick: (value: boolean) => void
}) {
  const t = useT()
  const outcome = confirmOutcome(item.grade, required)
  const proposal = t(item.required_proposed ? 'reviewGate.proposal.required' : 'reviewGate.proposal.optional') + (item.required_reason ? ' · ' + item.required_reason : '')
  return <li className={'review-row is-' + outcome}>
    <div className="review-name"><strong>{name}</strong>{item.usage && <small>{item.usage}</small>}</div>
    <div className="review-badge"><span className={'review-grade ' + (GRADE_TONE[item.grade] ?? '')} title={t('reviewGate.grade.hint')}>{gradeText(item.grade)}</span></div>
    <Segmented label={t('reviewGate.choice.aria', { name })} value={required} busy={busy} onPick={onPick}
      options={[{ value: true, label: t('reviewGate.choice.required') }, { value: false, label: t('reviewGate.choice.optional') }]} />
    <Outcome outcome={outcome} />
    <p className="review-meta">
      <span className={'review-proposal' + (item.required_proposed !== required ? ' is-changed' : '')}>{proposal}</span>
      {item.loses.length > 0 && <span>{t('reviewGate.loses')}: {item.loses.join(' · ')}</span>}
    </p>
  </li>
}

function DecisionRow({ name, sub, badge, meta, approveLabel, choice, busy, onChoice, security = false }: {
  name: string; sub?: string; badge: ReactNode; meta: string[]; approveLabel: string
  choice: ReviewDecision | undefined; busy: boolean; onChoice: (value: ReviewDecision) => void; security?: boolean
}) {
  const t = useT()
  const outcome = decisionOutcome(choice)
  return <li className={'review-row is-' + (outcome ?? 'pending') + (security ? ' is-security' : '')}>
    <div className="review-name"><strong>{name}</strong>{sub && <small>{sub}</small>}</div>
    <div className="review-badge">{badge}</div>
    <Segmented label={t('reviewGate.decision.aria', { name })} value={choice} busy={busy} onPick={onChoice}
      options={[{ value: 'APPROVED' as ReviewDecision, label: approveLabel }, { value: 'REJECTED' as ReviewDecision, label: t('reviewGate.decision.stop'), stop: true }]} />
    <Outcome outcome={outcome} label={outcome === 'proceed' ? approveLabel : undefined} />
    {meta.length > 0 && <p className="review-meta">{meta.map(line => <span key={line}>{line}</span>)}</p>}
  </li>
}

function BlockedRow({ item, capName, criterionName, gradeText }: {
  item: ReviewBlocked; capName: (capability: string) => string; criterionName: (criterion: string) => string; gradeText: (grade: string) => string
}) {
  const t = useT()
  const tOr = useTOr()
  const why = blockedText(item)
  const name = why.kind === 'security' ? criterionName(why.criterion) : capName(item.capability)
  const alt = why.altKey ? tOr(why.altKey, '') : ''
  return <li className="review-row is-block is-blocked-row">
    <div className="review-name"><strong>{name}</strong>{why.kind === 'feature' && item.usage && <small>{item.usage}</small>}</div>
    <div className="review-badge">{why.kind === 'security'
      ? <span className="review-grade is-none">{t('reviewGate.verdict.LOWER')}</span>
      : <span className={'review-grade ' + (GRADE_TONE[item.grade] ?? '')}>{gradeText(item.grade)}</span>}</div>
    <p className="review-why">{tOr(why.reasonKey, item.reason)}</p>
    <p className="review-meta">
      {alt && <span>{t('reviewGate.blocked.alt')}: {alt}</span>}
      {item.reason && <span className="review-server">{t('reviewGate.blocked.server')}: {item.reason}</span>}
    </p>
  </li>
}

/** 보안 판정 전체 표(원본 → 대상). 승인은 LOWER만 받고 나머지는 보여 주기만 한다. */
function SecurityTable({ rows, step }: { rows: ReviewSecurity[]; step: 'confirm' | 'approve' | 'blocked' }) {
  const t = useT()
  const tOr = useTOr()
  return <aside className="review-aside" aria-label={t('reviewGate.security.title')}>
    <strong className="review-aside-title">{t('reviewGate.security.title')}</strong>
    <p className="review-aside-lead">{t(step === 'approve' ? 'reviewGate.security.lead.approve' : step === 'blocked' ? 'reviewGate.security.lead.blocked' : 'reviewGate.security.lead.confirm')}</p>
    {rows.length === 0
      ? <p className="review-empty">{t('reviewGate.security.none')}</p>
      : <ul className="review-sec">
          {rows.map(item => <li key={item.id} className={'is-' + item.verdict.toLowerCase()}>
            <div className="review-sec-line">
              <span className="review-sec-name">{tOr('reviewGate.criterion.' + item.criterion, item.criterion)}</span>
              <span className={'review-verdict is-' + item.verdict.toLowerCase()}>{tOr('reviewGate.verdict.' + item.verdict, item.verdict)}</span>
            </div>
            <div className="review-sec-compare">
              {tOr('reviewGate.state.' + item.source_state, item.source_state)} <span aria-hidden="true">→</span> {tOr('reviewGate.state.' + item.target_state, item.target_state)}
              {item.weak_source && <small className="review-tag">{t('reviewGate.security.weak')}</small>}
              {item.approvable && step !== 'blocked' && <small className="review-tag is-ask">{t('reviewGate.security.needs')}</small>}
            </div>
            {securityMeta(item, tOr, t).map(line => <p key={line}>{line}</p>)}
          </li>)}
        </ul>}
  </aside>
}
