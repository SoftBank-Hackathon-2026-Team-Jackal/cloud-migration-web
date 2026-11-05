'use client'

import { useEffect, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import { api } from '../../lib/connections/client'
import {
  agentState, isAgentId, TTL_DEFAULT_MINUTES, TTL_MAX_MINUTES, type AgentState, type AgentView, type ApiErrorCode,
} from '../../lib/connections/types'
import { Ago, CardMenu, Chip, ConfirmDialog, CopyButton, ErrorNote, MockBadge, Modal, type ChipTone } from './parts'

type Failure = { error: ApiErrorCode; detail: string | null }
const TONE: Record<AgentState, ChipTone> = { online: 'live', offline: 'off', pending: 'wait', revoked: 'bad' }

export function AgentChip({ agent, now }: { agent: AgentView; now: number }) {
  const { t } = useI18n()
  const state = agentState(agent, now)
  return <Chip tone={TONE[state]}>{t(('cx.agent.state.' + state) as 'cx.agent.state.online')}</Chip>
}

const ok = (value: boolean | null, t: (key: 'cx.agent.ok' | 'cx.agent.fail' | 'cx.agent.unknown') => string) =>
  value === null ? <span className="cx-faint">{t('cx.agent.unknown')}</span> : value ? t('cx.agent.ok') : <span className="cx-bad">{t('cx.agent.fail')}</span>

function AgentCard({ agent: initial, now, onChanged }: { agent: AgentView; now: number; onChanged: () => void }) {
  const { t } = useI18n()
  const [agent, setAgent] = useState(initial)
  const [busy, setBusy] = useState<'check' | 'revoke' | 'forget' | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  useEffect(() => setAgent(initial), [initial])
  const path = '/api/agents/' + encodeURIComponent(agent.agent_id)

  const check = async () => {
    setBusy('check'); setFailure(null)
    const result = await api<{ agent: AgentView }>(path)
    setBusy(null)
    if (result.ok) setAgent(result.data.agent)
    else setFailure(result)
  }
  const revoke = async () => {
    setBusy('revoke'); setFailure(null)
    const result = await api<{ agent: AgentView }>(path + '/revoke', { method: 'POST' })
    setBusy(null); setConfirmRevoke(false)
    if (result.ok) setAgent(result.data.agent)
    else setFailure(result)
    onChanged()
  }
  const forget = async () => {
    setBusy('forget')
    await api(path, { method: 'DELETE' })
    setBusy(null)
    onChanged()
  }
  const state = agentState(agent, now)
  return <article className="cx-card" data-kind="AGENT" data-agent={agent.agent_id} data-state={state} aria-busy={busy !== null}>
    <div className="cx-card-head">
      <div className="cx-card-title"><small>{t('cx.agent.kind')}</small><strong className="cx-mono">{agent.agent_id}</strong></div>
      <div className="cx-card-state">
        {busy === 'check' ? <Chip tone="wait">{t('cx.verifying')}</Chip> : <AgentChip agent={agent} now={now} />}
        <span className="cx-faint">{t('cx.agent.lastSeen')} <Ago at={agent.last_seen_at} now={now} /></span>
        <CardMenu label={t('cx.menu')} items={[
          { id: 'check', text: t('cx.reverify'), disabled: busy !== null, onSelect: () => void check() },
          agent.revoked
            ? { id: 'forget', text: t('cx.agent.forget'), disabled: busy !== null, onSelect: () => void forget() }
            : { id: 'revoke', text: t('cx.agent.revoke'), danger: true, disabled: busy !== null || Boolean(agent.enrolled_only), onSelect: () => setConfirmRevoke(true) },
        ]} />
      </div>
    </div>
    <dl className="cx-ledger">
      <div><dt>{t('cx.agent.cluster')}</dt><dd className="cx-mono cx-wrap">{agent.cluster_uid ?? <span className="cx-faint">{t('cx.agent.clusterAfter')}</span>}</dd></div>
      <div><dt>{t('cx.agent.version')}</dt><dd className="cx-faint" title={t('cx.agent.versionHint')}>—</dd></div>
    </dl>
    {state === 'pending' && <p className="cx-note">{t('cx.agent.pendingHint')}</p>}
    {!agent.revoked && agent.last_seen_at !== null && <div className="cx-tunnel" aria-label={t('cx.agent.tunnel')}>
      <h3>{t('cx.agent.tunnel')} <MockBadge show /></h3>
      {agent.tunnel ? <dl className="cx-ledger is-compact">
        <div><dt>{t('cx.agent.tunnelIp')}</dt><dd className="cx-mono">{agent.tunnel.tunnel_ip ?? '—'}</dd></div>
        <div><dt>{t('cx.agent.handshake')}</dt><dd><Ago at={agent.tunnel.last_handshake_at} now={now} /></dd></div>
        <div><dt>{t('cx.agent.appHealth')}</dt><dd>{ok(agent.tunnel.app_health_ok, t)}</dd></div>
        <div><dt>{t('cx.agent.dbCheck')}</dt><dd>{ok(agent.tunnel.db_connect_ok, t)}</dd></div>
      </dl> : <p className="cx-faint">{t('cx.agent.tunnelNone')}</p>}
    </div>}
    {failure && <ErrorNote error={failure.error} detail={failure.detail} onRetry={() => void check()} />}
    <ConfirmDialog open={confirmRevoke} title={t('cx.agent.revokeTitle', { id: agent.agent_id })} body={t('cx.agent.revokeBody')}
      confirm={t('cx.agent.revoke')} danger busy={busy === 'revoke'} onCancel={() => setConfirmRevoke(false)} onConfirm={() => void revoke()} />
  </article>
}

type Issued = { agent_id: string; enrollment_token: string; install_command: string; expires_in_seconds: number; issuedAt: number }

/** 등록 토큰 발급. 토큰·설치 명령은 이 대화상자의 메모리에만 있고 닫으면 지운다. */
function EnrollDialog({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const { t } = useI18n()
  const [agentId, setAgentId] = useState('')
  const [minutes, setMinutes] = useState(String(TTL_DEFAULT_MINUTES))
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [issued, setIssued] = useState<Issued | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!issued) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [issued])

  const ttl = Number(minutes)
  const idValid = isAgentId(agentId)
  const ttlValid = Number.isInteger(ttl) && ttl >= 1 && ttl <= TTL_MAX_MINUTES
  const close = () => { setIssued(null); setAgentId(''); setMinutes(String(TTL_DEFAULT_MINUTES)); setTouched(false); setFailure(null); setBusy(false); onClose() }

  const submit = async () => {
    setTouched(true)
    if (!idValid || !ttlValid) return
    setBusy(true); setFailure(null)
    const result = await api<Omit<Issued, 'issuedAt'>>('/api/agents', { method: 'POST', body: { agent_id: agentId, ttl_minutes: ttl } })
    setBusy(false)
    if (!result.ok) { setFailure(result); return }
    setIssued({ ...result.data, issuedAt: Date.now() })
    setNow(Date.now())
    onChanged()
  }

  const left = issued ? Math.max(0, issued.expires_in_seconds - Math.floor((now - issued.issuedAt) / 1000)) : 0
  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
  return <Modal open={open} onOpenChange={value => { if (!value && !busy) close() }} wide
    title={issued ? t('cx.agent.issuedTitle', { id: issued.agent_id }) : t('cx.agent.addTitle')}
    description={issued ? t('cx.agent.onceWarning') : t('cx.agent.addLead')}>
    {!issued && <form className="cx-steps" onSubmit={event => { event.preventDefault(); void submit() }}>
      <div className="cx-form-row">
        <label className="cx-field">
          <span>{t('cx.agent.idLabel')}</span>
          <input name="agentId" className={'cx-input cx-mono' + (touched && !idValid ? ' is-invalid' : '')} value={agentId} maxLength={63} autoComplete="off" spellCheck={false}
            placeholder="laptop-k3s" aria-invalid={touched && !idValid} onChange={event => setAgentId(event.target.value.trim())} />
          <small className={touched && !idValid ? 'cx-invalid' : 'cx-faint'}>{t('cx.agent.idRule')}</small>
        </label>
        <label className="cx-field is-narrow">
          <span>{t('cx.agent.ttlLabel')}</span>
          <input name="ttlMinutes" type="number" min={1} max={TTL_MAX_MINUTES} className={'cx-input' + (touched && !ttlValid ? ' is-invalid' : '')}
            value={minutes} aria-invalid={touched && !ttlValid} onChange={event => setMinutes(event.target.value)} />
          <small className={touched && !ttlValid ? 'cx-invalid' : 'cx-faint'}>{t('cx.agent.ttlRule', { max: TTL_MAX_MINUTES })}</small>
        </label>
      </div>
      {failure && <ErrorNote error={failure.error} detail={failure.detail} />}
      <div className="cx-dialog-actions">
        <button type="button" className="cx-btn" data-step="cancel" onClick={close} disabled={busy}>{t('cx.cancel')}</button>
        <button type="submit" className="cx-primary" data-step="issue" disabled={busy}>{busy ? t('cx.working') : t('cx.agent.issue')}</button>
      </div>
    </form>}
    {issued && <div className="cx-steps">
      <div className="cx-once">
        <span>{left > 0 ? t('cx.agent.expiresIn') : t('cx.agent.expired')}</span>
        <strong className={'cx-count' + (left === 0 ? ' is-bad' : '')} data-countdown aria-live="off">{mmss}</strong>
      </div>
      <div className="cx-secret">
        <div className="cx-secret-head"><span>{t('cx.agent.command')}</span><CopyButton value={issued.install_command} label={t('cx.agent.copyCommand')} /></div>
        <pre className="cx-code" data-install-command>{issued.install_command}</pre>
      </div>
      <div className="cx-secret">
        <div className="cx-secret-head"><span>{t('cx.agent.token')}</span><CopyButton value={issued.enrollment_token} label={t('cx.agent.copyToken')} /></div>
        <code className="cx-code is-token" data-enrollment-token>{issued.enrollment_token}</code>
      </div>
      <p className="cx-note">{t('cx.agent.afterInstall')}</p>
      <div className="cx-dialog-actions">
        <button type="button" className="cx-primary" data-step="done" onClick={close}>{t('cx.agent.done')}</button>
      </div>
    </div>}
  </Modal>
}

export default function AgentSection({ agents, error, mock, now, onChanged }: {
  agents: AgentView[]; error: ApiErrorCode | null; mock: boolean; now: number; onChanged: () => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  return <section className="cx-section" aria-labelledby="cx-agent-title">
    <header className="cx-section-head">
      <div>
        <h2 id="cx-agent-title">{t('cx.agent.title')} <MockBadge show={mock} /></h2>
        <p>{t('cx.agent.lead')}</p>
      </div>
      <button type="button" className="cx-primary" data-action="agent-add" onClick={() => setOpen(true)}>{t('cx.agent.add')}</button>
    </header>
    {error && <ErrorNote error={error} onRetry={onChanged} />}
    {!error && agents.length === 0 && <div className="cx-empty"><strong>{t('cx.agent.empty')}</strong><span>{t('cx.agent.emptyHint')}</span></div>}
    <div className="cx-list">{agents.map(agent => <AgentCard key={agent.agent_id} agent={agent} now={now} onChanged={onChanged} />)}</div>
    <EnrollDialog open={open} onClose={() => setOpen(false)} onChanged={onChanged} />
  </section>
}
