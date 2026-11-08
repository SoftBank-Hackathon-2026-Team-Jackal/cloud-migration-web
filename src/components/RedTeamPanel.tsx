'use client'

import { useMigration } from '../lib/migration/MigrationProvider'
import type { RedTeamData, RedTeamFinding } from '../lib/migration/events'
import { useT, type MsgKey } from '../lib/i18n'
import { redteamProgress } from '../lib/migration/redteamView'

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']
const bySeverity = (a: RedTeamFinding, b: RedTeamFinding) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)

/** 건너뜀 사유 코드(워커 `redteam_stage` 코드)를 화면 문구 키로. 모르는 코드는 일반 문구. */
const SKIP_KEYS: Record<string, MsgKey> = {
  REDTEAM_NOT_CONFIGURED: 'rt.skip.notConfigured',
  REDTEAM_TIME_INSUFFICIENT: 'rt.skip.time',
} as unknown as Record<string, MsgKey>

/** 이전을 시작할 때 동의한 범위. 중간에 다시 묻지 않으므로 어디까지 동의했는지를 접어서 보여 준다. */
function Consent({ data }: { data: RedTeamData }) {
  const t = useT()
  const consent = data.consent
  if (!consent) return null
  const rows: Array<[MsgKey, string]> = [
    ['rt.req.target', consent.target],
    ['rt.req.scope', t('rt.req.scopeValue')],
    ['rt.req.intensity', t(('rt.intensity.' + consent.intensity) as MsgKey)],
    ['rt.req.budget', t('rt.req.budgetValue', { min: Math.round(consent.time_budget_seconds / 60) })],
    ['rt.req.reset', t(consent.test_data_is_reset_afterwards ? 'rt.req.resetYes' : 'rt.req.resetNo')],
    ['rt.req.egress', t(consent.outside_calls_are_cut_meanwhile ? 'rt.req.egressCut' : 'rt.req.egressOpen')],
  ]
  return <details className="rt-consent">
    <summary>{t('rt.consent.title')}</summary>
    <dl className="rt-facts">{rows.map(([key, value]) => <div key={key}><dt>{t(key)}</dt><dd>{value}</dd></div>)}</dl>
    <p className="rt-note">{t('rt.consent.note')}</p>
  </details>
}

function Findings({ data }: { data: RedTeamData }) {
  const t = useT()
  if (data.findings.length === 0) return null
  return <ul className="rt-findings" aria-label={t('rt.findings.aria')}>
    {[...data.findings].sort(bySeverity).map(item => <li key={item.id} className={'rt-find is-' + item.state.toLowerCase()}>
      <div className="rt-find-top">
        <span className={'rt-sev is-' + item.severity.toLowerCase()}>{t(('rt.sev.' + item.severity) as MsgKey)}</span>
        <code>{item.endpoint}</code>
        <b className="rt-state">{t(('rt.state.' + item.state) as MsgKey)}</b>
      </div>
      <p>{item.summary}</p>
      <details><summary>{t('rt.repro')}</summary><p>{item.repro_summary}</p></details>
    </li>)}
  </ul>
}

function Outcome({ data }: { data: RedTeamData }) {
  const t = useT()
  const n = data.findings.length
  const open = data.findings.filter(item => item.state !== 'FIXED').length
  if (data.status === 'SKIPPED') return <p className="rt-result is-skipped">{t(SKIP_KEYS[data.code ?? ''] ?? 'rt.skip.other')}</p>
  if (data.status === 'ERROR') return <p className="rt-result is-error" role="alert">{t('rt.result.error')}</p>
  if (data.status === 'CLEAN') return <p className="rt-result is-clean">{t('rt.result.clean')}</p>
  if (data.status === 'FIXED') return <p className="rt-result is-fixed">{t('rt.result.fixed', { n, rounds: data.round })}</p>
  return <p className="rt-result is-open" role="status">{t('rt.result.open', { n: open })} {t('rt.result.openNote')}</p>
}

/**
 * 샌드박스 화면의 레드팀 점검: 점검 중 → 보안 수정 → 결과.
 * 동의는 이전을 시작할 때 한 번만 받고 중간에 다시 묻지 않는다(승철님 결정). 약점이 남아도 이전은 막지 않고 표시·기록만 한다(ADR-008 R3).
 */
export default function RedTeamPanel() {
  const t = useT()
  const { state } = useMigration()
  const data = state.sandbox.redteam
  if (!data) return null
  const progress = redteamProgress(data)
  return <section className={'rt is-' + data.phase.toLowerCase()} aria-label={t('rt.aria')}>
    <header className="rt-head">
      <small>RED TEAM · SANDBOX</small>
      <strong>{t('rt.title')}</strong>
      <span className="rt-phase">{t(('rt.phase.' + data.phase) as MsgKey, progress)}</span>
    </header>
    {data.phase !== 'DONE' && <p className="rt-lead">{t('rt.lead')}</p>}
    <Consent data={data} />
    {(data.phase === 'RUNNING' || data.phase === 'FIXING') && <p className="rt-doing"><span aria-hidden="true" />{t(data.phase === 'RUNNING' ? 'rt.doing.running' : 'rt.doing.fixing', progress)}</p>}
    <Findings data={data} />
    {data.phase === 'DONE' && <Outcome data={data} />}
    {data.withheld > 0 && <p className="rt-note">{t('rt.withheld', { n: data.withheld })}</p>}
  </section>
}
