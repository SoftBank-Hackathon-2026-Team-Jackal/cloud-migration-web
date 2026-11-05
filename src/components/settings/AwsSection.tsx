'use client'

import { useState } from 'react'
import { useI18n, type MsgKey } from '../../lib/i18n'
import { api } from '../../lib/connections/client'
import { AWS_REGIONS, isRoleArn, type ApiErrorCode, type Connection, type CreatedConnection, type VerifyResult } from '../../lib/connections/types'
import { Ago, CardMenu, Chip, ConfirmDialog, CopyButton, ErrorNote, MockBadge, Modal, type ChipTone } from './parts'

type Failure = { error: ApiErrorCode; detail: string | null }
type Purpose = 'AWS_SOURCE' | 'AWS_TARGET'

export const statusTone = (status: Connection['status']): ChipTone => (status === 'CONNECTED' ? 'ok' : status === 'FAILED' ? 'bad' : 'wait')

export function StatusChip({ connection }: { connection: Connection }) {
  const { t } = useI18n()
  return <Chip tone={statusTone(connection.status)}>{t(('cx.status.' + connection.status) as MsgKey)}</Chip>
}

/** 연결 하나(AWS 원본·대상) */
function AwsCard({ connection, now, onChanged, onContinue }: { connection: Connection; now: number; onChanged: () => void; onContinue: (connection: Connection) => void }) {
  const { t, tOr } = useI18n()
  const [busy, setBusy] = useState<'verify' | 'delete' | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const verify = async () => {
    if (!connection.role_arn) { onContinue(connection); return }
    setBusy('verify'); setFailure(null)
    const result = await api<VerifyResult>('/api/connections/' + encodeURIComponent(connection.connection_id) + '/verify', { method: 'POST' })
    setBusy(null)
    if (!result.ok) setFailure(result)
    onChanged()
  }
  const remove = async () => {
    setBusy('delete')
    const result = await api('/api/connections/' + encodeURIComponent(connection.connection_id), { method: 'DELETE' })
    setBusy(null)
    setConfirmDelete(false)
    if (!result.ok) setFailure(result)
    onChanged()
  }

  return <article className="cx-card" data-kind={connection.kind} data-status={connection.status} aria-busy={busy !== null}>
    <div className="cx-card-head">
      <div className="cx-card-title">
        <small>{t(connection.kind === 'AWS_SOURCE' ? 'cx.aws.source' : 'cx.aws.target')}</small>
        <strong>{connection.display_name}</strong>
      </div>
      <div className="cx-card-state">
        {busy === 'verify' ? <Chip tone="wait">{t('cx.verifying')}</Chip> : <StatusChip connection={connection} />}
        <span className="cx-faint">{t('cx.lastChecked')} <Ago at={connection.last_verified_at} now={now} /></span>
        <CardMenu label={t('cx.menu')} items={[
          { id: 'verify', text: t('cx.reverify'), disabled: busy !== null, onSelect: () => void verify() },
          { id: 'delete', text: t('cx.delete'), danger: true, disabled: busy !== null, onSelect: () => setConfirmDelete(true) },
        ]} />
      </div>
    </div>
    <dl className="cx-ledger">
      <div><dt>{t('cx.aws.account')}</dt><dd className="cx-mono">{connection.account_id ?? '—'}</dd></div>
      <div><dt>{t('cx.region')}</dt><dd>{connection.region ? <><span className="cx-mono">{connection.region}</span> {tOr('region.' + connection.region, '')}</> : '—'}</dd></div>
      <div><dt>{t('cx.aws.role')}</dt><dd className="cx-mono cx-wrap">{connection.role_arn ?? <span className="cx-faint">{t('cx.aws.roleMissing')}</span>}</dd></div>
      <div><dt>{t('cx.aws.externalId')}</dt><dd className="cx-mono">{connection.external_id ?? '—'}</dd></div>
      {connection.kind === 'AWS_SOURCE' && <div><dt>{t('cx.aws.eks')}</dt><dd>{connection.eks_clusters?.length
        ? <span className="cx-tags">{connection.eks_clusters.map(name => <code key={name}>{name}</code>)}</span>
        : <span className="cx-faint">{connection.status === 'CONNECTED' ? t('cx.aws.eksNone') : t('cx.aws.eksAfter')}</span>}</dd></div>}
    </dl>
    {connection.status === 'FAILED' && connection.last_code && <ErrorNote error="conflict" title={t('cx.aws.failed')} detail={connection.last_code} />}
    {connection.status === 'PENDING' && !connection.role_arn && <div className="cx-card-foot">
      <span className="cx-faint">{t('cx.aws.pendingHint')}</span>
      <button type="button" className="cx-btn" onClick={() => onContinue(connection)}>{t('cx.aws.continue')}</button>
    </div>}
    {failure && <ErrorNote error={failure.error} detail={failure.detail} />}
    <ConfirmDialog open={confirmDelete} title={t('cx.aws.deleteTitle', { name: connection.display_name })} body={t('cx.aws.deleteBody')}
      confirm={t('cx.delete')} danger busy={busy === 'delete'} onCancel={() => setConfirmDelete(false)} onConfirm={() => void remove()} />
  </article>
}

type Draft = { connection_id: string; kind: Purpose; external_id: string | null; launch_stack_url: string | null }

/** AWS 계정 연결: 용도·이름·리전 → CloudFormation Launch Stack → RoleArn 등록 → 연결 확인 (#23: POST /connections → PUT role → POST verify) */
function ConnectDialog({ open, resume, onClose, onChanged }: { open: boolean; resume: Connection | null; onClose: () => void; onChanged: () => void }) {
  const { t, tOr } = useI18n()
  const [purpose, setPurpose] = useState<Purpose>('AWS_SOURCE')
  const [name, setName] = useState('')
  const [region, setRegion] = useState<string>(AWS_REGIONS[0])
  const [created, setCreated] = useState<Draft | null>(null)
  const [roleArn, setRoleArn] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [verified, setVerified] = useState<VerifyResult | null>(null)
  const current: Draft | null = created ?? (resume && resume.kind !== 'GCP_TARGET'
    ? { connection_id: resume.connection_id, kind: resume.kind, external_id: resume.external_id ?? null, launch_stack_url: null } : null)

  const reset = () => { setPurpose('AWS_SOURCE'); setName(''); setRegion(AWS_REGIONS[0]); setCreated(null); setRoleArn(''); setTouched(false); setBusy(false); setFailure(null); setVerified(null) }
  const close = () => { reset(); onClose() }

  const displayName = name.trim() || t(purpose === 'AWS_SOURCE' ? 'cx.aws.namePhSource' : 'cx.aws.namePhTarget')
  const create = async () => {
    setBusy(true); setFailure(null)
    const result = await api<CreatedConnection>('/api/connections', { method: 'POST', body: { kind: purpose, display_name: displayName, region } })
    setBusy(false)
    if (!result.ok) { setFailure(result); return }
    const data = result.data
    setCreated({ connection_id: data.connection_id, kind: data.kind === 'AWS_TARGET' ? 'AWS_TARGET' : 'AWS_SOURCE', external_id: data.external_id, launch_stack_url: data.launch_stack_url })
    onChanged()
  }
  const valid = isRoleArn(roleArn)
  const verify = async () => {
    setTouched(true)
    if (!current || !valid) return
    setBusy(true); setFailure(null); setVerified(null)
    const path = '/api/connections/' + encodeURIComponent(current.connection_id)
    const role = await api<{ connection: Connection }>(path + '/role', { method: 'PUT', body: { role_arn: roleArn.trim() } })
    if (!role.ok) { setBusy(false); setFailure(role); onChanged(); return }
    const result = await api<VerifyResult>(path + '/verify', { method: 'POST' })
    setBusy(false)
    onChanged()
    if (!result.ok) { setFailure(result); return }
    if (result.data.status === 'FAILED') setFailure({ error: 'conflict', detail: result.data.code })
    else setVerified(result.data)
  }

  const kind = current?.kind ?? purpose
  return <Modal open={open} onOpenChange={value => { if (!value && !busy) close() }} wide
    title={t('cx.aws.connectTitle')} description={t('cx.aws.connectLead')}>
    {!current && <div className="cx-steps">
      <fieldset className="cx-purpose" disabled={busy}>
        <legend>{t('cx.aws.purpose')}</legend>
        {(['AWS_SOURCE', 'AWS_TARGET'] as const).map(value => <label key={value} className={'cx-option' + (purpose === value ? ' is-selected' : '')}>
          <input type="radio" name="purpose" value={value} checked={purpose === value} onChange={() => setPurpose(value)} />
          <span><strong>{t(value === 'AWS_SOURCE' ? 'cx.aws.source' : 'cx.aws.target')}</strong>
            <small>{t(value === 'AWS_SOURCE' ? 'cx.aws.sourceHint' : 'cx.aws.targetHint')}</small></span>
          <code>{value}</code>
        </label>)}
      </fieldset>
      <div className="cx-form-row is-even">
        <label className="cx-field">
          <span>{t('cx.aws.name')}</span>
          <input name="displayName" className="cx-input" value={name} maxLength={120} autoComplete="off" disabled={busy}
            placeholder={t(purpose === 'AWS_SOURCE' ? 'cx.aws.namePhSource' : 'cx.aws.namePhTarget')} onChange={event => setName(event.target.value)} />
        </label>
        <label className="cx-field">
          <span>{t('cx.region')}</span>
          <select name="region" className="cx-input" value={region} disabled={busy} onChange={event => setRegion(event.target.value)}>
            {AWS_REGIONS.map(value => <option key={value} value={value}>{value} · {tOr('region.' + value, value)}</option>)}
          </select>
        </label>
      </div>
      <p className="cx-note">{t('cx.aws.noKeys')}</p>
      {failure && <ErrorNote error={failure.error} detail={failure.detail} onRetry={() => void create()} />}
      <div className="cx-dialog-actions">
        <button type="button" className="cx-btn" onClick={close} disabled={busy}>{t('cx.cancel')}</button>
        <button type="button" className="cx-primary" data-step="create" onClick={() => void create()} disabled={busy}>{busy ? t('cx.working') : t('cx.next')}</button>
      </div>
    </div>}
    {current && <div className="cx-steps">
      <ol className="cx-howto">
        <li>
          <div><strong>{t('cx.aws.step1')}</strong><span>{t(kind === 'AWS_SOURCE' ? 'cx.aws.step1Source' : 'cx.aws.step1Target')}</span></div>
          {current.launch_stack_url
            ? <a className="cx-primary" href={current.launch_stack_url} target="_blank" rel="noopener noreferrer" data-launch-stack>{t('cx.aws.launch')} ↗</a>
            : <span className="cx-faint">{t('cx.aws.launchDone')}</span>}
        </li>
        <li>
          <div><strong>{t('cx.aws.step2')}</strong><span>{t('cx.aws.step2Hint')}</span></div>
          <label className="cx-field">
            <span className="cx-sr">{t('cx.aws.roleArn')}</span>
            <input name="roleArn" className={'cx-input cx-mono' + (touched && !valid ? ' is-invalid' : '')} value={roleArn} spellCheck={false} autoComplete="off"
              placeholder="arn:aws:iam::123456789012:role/cmp-source-readonly" aria-invalid={touched && !valid}
              onChange={event => setRoleArn(event.target.value)} onBlur={() => setTouched(roleArn.length > 0)} />
            {touched && !valid && <small className="cx-invalid" role="alert">{t('cx.aws.roleArnInvalid')}</small>}
          </label>
        </li>
        <li>
          <div><strong>{t('cx.aws.step3')}</strong><span>{t('cx.aws.step3Hint')}</span></div>
          <div className="cx-readonly"><code data-external-id>{current.external_id ?? '—'}</code>{current.external_id && <CopyButton value={current.external_id} label={t('cx.aws.copyExternal')} />}</div>
        </li>
      </ol>
      {failure && <ErrorNote error={failure.error} title={failure.detail?.startsWith('ASSUME_ROLE') ? t('cx.aws.failed') : undefined} detail={failure.detail} />}
      {verified && <div className="cx-pass" role="status">
        <strong>{t('cx.aws.verified')}</strong>
        <span>{t('cx.aws.verifiedDetail', { account: verified.account_id ?? '—', region })}</span>
        {verified.eks_clusters && <span className="cx-tags">{verified.eks_clusters.map(cluster => <code key={cluster}>{cluster}</code>)}</span>}
      </div>}
      <div className="cx-dialog-actions">
        <button type="button" className="cx-btn" data-step="close" onClick={close} disabled={busy}>{verified ? t('cx.close') : t('cx.later')}</button>
        {!verified && <button type="button" className="cx-primary" data-step="verify" onClick={() => void verify()} disabled={busy}>{busy ? t('cx.verifying') : t('cx.verify')}</button>}
      </div>
    </div>}
  </Modal>
}

export default function AwsSection({ connections, error, mock, now, onChanged }: {
  connections: Connection[]; error: ApiErrorCode | null; mock: boolean; now: number; onChanged: () => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [resume, setResume] = useState<Connection | null>(null)
  const list = connections.filter(item => item.kind === 'AWS_SOURCE' || item.kind === 'AWS_TARGET')
  return <section className="cx-section" aria-labelledby="cx-aws-title">
    <header className="cx-section-head">
      <div>
        <h2 id="cx-aws-title">{t('cx.aws.title')} <MockBadge show={mock} /></h2>
        <p>{t('cx.aws.lead')}</p>
      </div>
      <button type="button" className="cx-primary" data-action="aws-connect" onClick={() => { setResume(null); setOpen(true) }}>{t('cx.aws.add')}</button>
    </header>
    {error && <ErrorNote error={error} onRetry={onChanged} />}
    {!error && list.length === 0 && <div className="cx-empty"><strong>{t('cx.aws.empty')}</strong><span>{t('cx.aws.emptyHint')}</span></div>}
    <div className="cx-list">
      {list.map(connection => <AwsCard key={connection.connection_id} connection={connection} now={now} onChanged={onChanged}
        onContinue={value => { setResume(value); setOpen(true) }} />)}
    </div>
    <ConnectDialog open={open} resume={resume} onClose={() => { setOpen(false); setResume(null) }} onChanged={onChanged} />
  </section>
}
