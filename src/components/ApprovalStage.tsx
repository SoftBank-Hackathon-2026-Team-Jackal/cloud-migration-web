'use client'

import { useEffect, useRef, useState } from 'react'
import { useT, useTOr, type MsgKey } from '../lib/i18n'
import type { Target } from '../lib/stages'
import { SOURCE_FALLBACK, approvalFacts, costViewOf, planWarnings, targetEnvOf } from '../lib/migration/planModel'
import CostCompare from './CostCompare'
import GovernanceMatrix from './GovernanceMatrix'
import PlanTopology from './PlanTopology'
import { ViewTabs } from './DiagramParts'
import { issueText, placeText, stepText } from './planText'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'
import { useVoiceActions } from '../lib/voice/actions'
import { checkDigests } from '../lib/migration/digest'
import { shortDigest, type ApprovalDecisionData } from '../lib/migration/events'

type Props = { target: Target; onApprove: () => void; onCancel: () => void; onRevise: () => void }

/** 승인 버튼을 누른 뒤의 상태: 보내는 중 → 기록됨(전달 대기) → 전달됨(실행 시작) / 전달 실패 */
type Delivery = 'idle' | 'sending' | 'pending' | 'delivered' | 'failed'

/** 전달 완료를 보여 준 뒤 다음 단계로 넘어가기까지(사람이 '전달됨'을 읽을 시간) */
const ADVANCE_AFTER_MS = 900

function deliveryOf(submitted: boolean, decision: ApprovalDecisionData | null, provisioningStarted: boolean, requestFailed: boolean): Delivery {
  if (!submitted) return 'idle'
  if (decision) {
    if (decision.delivery_status === 'FAILED' || decision.execution_status === 'FAILED') return 'failed'
    if (decision.delivery_status === 'DELIVERED') return 'delivered'
  }
  // 옛 승인 경로(전달 상태를 주지 않는 서버)는 구축 이벤트가 오면 전달된 것으로 본다.
  if (provisioningStarted) return 'delivered'
  if (requestFailed) return 'failed'
  return decision ? 'pending' : 'sending'
}

export default function ApprovalStage({ target, onApprove, onCancel, onRevise }: Props) {
  const t = useT()
  const tOr = useTOr()
  const { state, provider, mode } = useMigration()
  // 승인 요청(approval.required)을 받는 화면. 승인·취소는 데이터 계층을 거쳐 서버로 간다.
  useStageFeed('awaiting_approval', true, target)
  const [checked, setChecked] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [side, setSide] = useState<'diagram' | 'governance' | 'cost'>('diagram')
  const [swapped, setSwapped] = useState(false)
  const errorAtSubmit = useRef(state.error)
  const targetName = t(('target.' + target) as MsgKey)

  const plan = state.plan.meta
  const preview = state.plan.preview
  const facts = approvalFacts(state)
  const source = placeText(tOr, preview?.source ?? SOURCE_FALLBACK)
  const destination = preview?.target ? placeText(tOr, preview.target) : { provider: targetName, place: preview ? placeText(tOr, targetEnvOf(preview, target)).place : '' }
  const route = (side: { provider: string; place: string }) => [side.provider, side.place].filter(Boolean).join(' · ')

  // ---- 요약(모두 받은 데이터에서) ----
  const none = t('approval.val.none')
  const changes = facts.hasPlan
    ? [t('approval.val.changes', { infra: facts.changes.infrastructure, code: facts.changes.code }),
      facts.changes.keep > 0 ? t('plan.summary.keep', { n: facts.changes.keep }) : '',
      facts.changes.approval > 0 ? t('plan.summary.approval', { n: facts.changes.approval }) : '',
      facts.changes.block > 0 ? t('plan.summary.block', { n: facts.changes.block }) : ''].filter(Boolean).join(' · ')
    : none
  const sandbox = !facts.sandbox ? none
    : facts.sandbox.kind === 'tests' ? t('approval.val.sandboxTests', { passed: facts.sandbox.passed, total: facts.sandbox.total, attempt: facts.sandbox.attempt ?? 1 })
      : t('approval.val.sandboxMapping', { passed: facts.sandbox.passed, total: facts.sandbox.total })
  // '이름 · 보조 설명' 중 이름만(요약 한 줄이 길어지지 않게)
  const dbName = facts.database ? stepText(tOr, facts.database, target, 'before').split(' · ')[0] : ''
  const data = !facts.database ? (facts.hasPlan ? t('approval.val.noData') : none)
    : facts.dataMethod.value === 'DUMP_CDC' ? t('approval.val.dataCdc', { db: dbName })
      : facts.dataMethod.value ? dbName + ' · ' + facts.dataMethod.value : t('approval.val.dataUnknown', { db: dbName })
  const method = facts.traffic.method ? tOr('approval.method.' + facts.traffic.method, facts.traffic.method) : ''
  const traffic = t('approval.val.traffic', { steps: facts.traffic.steps.join(' → ') }) + (method ? ' · ' + method : '')
  const pauseMs = facts.writePause.ms
  const pause = t('approval.val.pauseMs', { s: pauseMs < 1000 ? (pauseMs / 1000).toFixed(1) : Math.round(pauseMs / 1000) })
  // 롤백: 승인 요청의 정책 문구 → 정해야 할 값(pending_decisions code의 사전 문구) → 정책 기본값
  const decisionText = (code: string) => tOr('approval.pending.' + code, code)
  const rollback = state.approval.rollbackPolicy || (facts.pending.rollback.length > 0 ? facts.pending.rollback.map(decisionText).join(' · ') : t('approval.val.rollback'))
  const rollbackDefaulted = !state.approval.rollbackPolicy && facts.pending.rollback.length === 0

  // [이름, 값, 정책 기본값인가(계획이 보내지 않아 policy.ts 값을 썼다)]
  const rows: Array<[string, string, boolean?]> = [
    [t('approval.row.route'), preview ? route(source) + ' → ' + route(destination) : t('approval.val.route', { target: targetName })],
    [t('approval.row.summary'), changes],
    [t('approval.row.sandbox'), sandbox],
    [t('approval.row.data'), data, !!facts.database && facts.dataMethod.defaulted],
    [t('approval.row.traffic'), traffic, facts.traffic.defaulted],
    [t('approval.row.rollback'), rollback, rollbackDefaulted],
    [t('approval.row.pause'), pause, facts.writePause.defaulted],
  ]
  // 이미지 Digest 대조: 빌드한 이미지 = 검증한 이미지 = 배포할 이미지. 다르면 경고하고 승인을 막는다.
  const digest = checkDigests({ built: state.build.result?.digest ?? plan?.built_digest, verified: plan?.verified_digest, deploy: plan?.built_digest })
  const digestValue = digest.status === 'mismatch'
    ? t('approval.digest.mismatch', { built: shortDigest(digest.built) || '—', verified: shortDigest(digest.verified) || '—', deploy: shortDigest(digest.deploy) || '—' })
    : t('approval.digest.match', { digest: shortDigest(digest.deploy ?? digest.built), revision: plan?.revision ?? 1, template: plan?.template_version ?? '—' })
  // 제외 항목: 서버가 보내 주면 그대로, 아니면 계획의 원본 유지 항목과 검증 경고에서 만든다. 계획 자체가 없을 때만 화면의 기본 문구를 쓴다.
  const derivedExcluded = [
    ...facts.keepSteps.filter(step => step.group === 'infrastructure').map(step => t('approval.ex.keep', { name: stepText(tOr, step, target, 'before') })),
    ...planWarnings(preview).map(issue => issueText(tOr, issue)),
    ...facts.pending.excluded.map(decisionText),
  ]
  const excluded = state.approval.excluded.length > 0 ? state.approval.excluded
    : facts.hasPlan || preview ? derivedExcluded : [t('approval.ex1'), t('approval.ex2')]

  // ---- 승인 전달 ----
  // 지금 계획 버전의 승인 결정만 본다(계획 수정 전의 옛 결정은 무시).
  const raw = state.approval.decision
  const decision = raw && raw.decision === 'APPROVE' && (plan?.revision === undefined || raw.revision === plan.revision) ? raw : null
  const requestFailed = submitted && state.error !== errorAtSubmit.current && state.error?.code === 'request_failed'
  const delivery = deliveryOf(submitted, decision, state.provision.resources.length > 0, requestFailed)
  const busy = delivery === 'sending' || delivery === 'pending' || delivery === 'delivered'
  const onApproveRef = useRef(onApprove)
  onApproveRef.current = onApprove
  useEffect(() => {
    if (delivery !== 'delivered') return
    const timer = window.setTimeout(() => onApproveRef.current(), ADVANCE_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [delivery])
  const submit = () => {
    errorAtSubmit.current = state.error
    setSubmitted(true)
    provider.approve(plan?.revision)
  }
  // 음성 승인: 자칼이 사실을 읽은 뒤 "승인해"를 들었을 때만 온다(확인 체크도 함께 한다). 취소·수정은 버튼과 같다.
  useVoiceActions({ approve: !busy && digest.status !== 'mismatch' && (() => { setChecked(true); submit() }), revise: !busy && (() => { provider.revisePlan(); onRevise() }), cancel: !busy && (() => { provider.cancel(); setCancelled(true) }) })

  if (cancelled) {
    return <section className="flow-stage approval-stage is-ready" aria-label={t('approval.cancelled.step')}>
      <div className="approval-panel">
        <small className="approval-step">{t('approval.cancelled.step')}</small>
        <h2 aria-level={1}>{t('approval.cancelled.title')}</h2>
        <p className="approval-lead">{t('approval.cancelled.lead')}</p>
        <div className="approval-actions">
          <button type="button" className="flow-primary" onClick={onCancel}>{t('approval.cancelled.home')} <span aria-hidden="true">→</span></button>
        </div>
      </div>
    </section>
  }

  // 전달 단계 표시: 기록 → 전달 → 실행
  const track: Array<{ id: 'record' | 'deliver' | 'execute'; state: 'done' | 'active' | 'wait' | 'failed' }> = [
    { id: 'record', state: delivery === 'sending' ? 'active' : delivery === 'failed' && !decision ? 'failed' : 'done' },
    { id: 'deliver', state: delivery === 'delivered' ? 'done' : delivery === 'failed' && decision ? 'failed' : delivery === 'pending' ? 'active' : 'wait' },
    { id: 'execute', state: delivery === 'delivered' ? 'active' : 'wait' },
  ]
  const primaryLabel = delivery === 'sending' ? t('approval.sending')
    : delivery === 'pending' ? t('approval.delivering')
      : delivery === 'delivered' ? t('approval.delivered')
        : delivery === 'failed' ? t('approval.redeliver') : t('approval.go')
  const configCount = state.plan.steps.filter(step => step.group === 'code' && !step.keep_source).length
  const digestShort = shortDigest(plan?.verified_digest ?? plan?.built_digest ?? state.build.result?.digest)

  return <section className="flow-stage approval-stage is-ready" aria-label={t('approval.aria')}>
    <div className="approval-panel approval-wide">
      <div className="approval-main">
        <small className="approval-step">{t('approval.step')} {mode === 'mock' && <span>DEMO</span>}</small>
        <h2 aria-level={1}>{t('approval.title')}</h2>
        <p className="approval-lead">{t('approval.lead')}</p>
        <dl className="approval-rows">
          {rows.map(([label, value, defaulted]) => <div key={label}><dt>{label}</dt><dd>{value}{defaulted && <small className="flow-pill policy-tag" title={t('approval.policyNote')}>{t('approval.policyDefault')}</small>}</dd></div>)}
          {digest.status !== 'unknown' && <div className={digest.status === 'mismatch' ? 'approval-digest is-warn' : 'approval-digest'} role={digest.status === 'mismatch' ? 'alert' : undefined}><dt>{t('approval.row.digest')}</dt><dd>{digestValue}</dd></div>}
        </dl>
        {excluded.length > 0 && <div className="approval-excluded">
          <strong>{t('approval.excluded')}</strong>
          <ul>{excluded.map(item => <li key={item}>{item}</li>)}</ul>
        </div>}
        {delivery === 'idle'
          ? <label className="approval-check">
            <input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />
            <span>{t('approval.check')}</span>
          </label>
          : <div className={'approval-delivery is-' + delivery} role="status" aria-live="polite">
            <ol>
              {track.map(item => <li key={item.id} className={'is-' + item.state}>
                <i aria-hidden="true" />
                <span>{t(('approval.track.' + item.id) as MsgKey)}</span>
              </li>)}
            </ol>
            <p>{t(('approval.delivery.' + delivery) as MsgKey, { attempts: decision?.delivery_attempts ?? 1 })}</p>
          </div>}
        <div className="approval-actions">
          <button type="button" className="flow-secondary" disabled={busy} onClick={() => { provider.cancel(); setCancelled(true) }}>{t('approval.cancel')}</button>
          <button type="button" className="flow-secondary" disabled={busy} onClick={() => { provider.revisePlan(); onRevise() }}>{t('approval.revise')}</button>
          <button type="button" className={'flow-primary' + (busy ? ' is-busy' : '')} aria-busy={busy}
            disabled={busy || !checked || digest.status === 'mismatch'} onClick={submit}>
            {primaryLabel} {!busy && <span aria-hidden="true">→</span>}
          </button>
        </div>
      </div>
      <aside className="approval-diagram" aria-label={t('approval.diagram.title')}>
        <div className="approval-diagram-head">
          <ViewTabs variant="segmented" label={t('tab.aria')} value={side} onChange={next => { setSwapped(true); setSide(next) }}
            items={[{ id: 'diagram', label: t('tab.diagram') }, { id: 'governance', label: t('tab.governance') }, { id: 'cost', label: t('tab.cost') }]} />
        </div>
        <div className={'approval-diagram-body is-' + side + (swapped ? ' is-swapped' : '')}>
          {side === 'diagram' && <div className="approval-topo">
            <PlanTopology compact steps={state.plan.steps} preview={preview} digest={digestShort} revealed={Number.MAX_SAFE_INTEGER}
              textOf={(step, field) => stepText(tOr, step, target, field)} sourceLabel={source} targetLabel={destination} />
            {state.plan.steps.length > 0 && <ul className="plan-topo-legend">
              <li><i />{t('plan.diagram.legendFlow')}</li>
              <li><i className="is-planned" />{t('plan.diagram.legendPlanned')}</li>
              {facts.keepSteps.length > 0 && <li><i className="is-keep" />{t('plan.diagram.legendKeep')}</li>}
              {digestShort && <li><i className="is-lock" />{t('plan.diagram.legendLock')}</li>}
              {configCount > 0 && <li>{t('plan.diagram.config', { n: configCount })}</li>}
            </ul>}
          </div>}
          {side === 'governance' && <GovernanceMatrix target={target} steps={state.plan.steps} preview={preview} />}
          {side === 'cost' && <CostCompare target={target} cost={costViewOf(state, target)} />}
        </div>
      </aside>
    </div>
  </section>
}
