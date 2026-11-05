'use client'

import { useState } from 'react'
import { useI18n, type MsgKey } from '../../lib/i18n'
import { api } from '../../lib/connections/client'
import { isRoleArn, type ApiErrorCode, type Connection, type CreatedConnection } from '../../lib/connections/types'
import { Ago, CardMenu, Chip, ConfirmDialog, CopyButton, ErrorNote, isoSeconds, MockBadge, Modal, type ChipTone } from './parts'

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
    const result = await api<{ connection: Connection }>('/api/connections/' + encodeURIComponent(connection.connection_id) + '/verify', { method: 'POST', body: {} })
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
        <span className="cx-faint">{t('cx.lastChecked')} <Ago at={isoSeconds(connection.last_verified_at)} now={now} /></span>
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
    {connection.status === 'FAILED' && connection.error_code && <ErrorNote error="conflict" title={t('cx.aws.failed')} detail={connection.error_code} />}
    {connection.status === 'PENDING' && !connection.role_arn && <div className="cx-card-foot">
      <span className="cx-faint">{t('cx.aws.pendingHint')}</span>
      <button type="button" className="cx-btn" onClick={() => onContinue(connection)}>{t('cx.aws.continue')}</button>
    </div>}
    {failure && <ErrorNote error={failure.error} detail={failure.detail} />}
    <ConfirmDialog open={confirmDelete} title={t('cx.aws.deleteTitle', { name: connection.display_name })} body={t('cx.aws.deleteBody')}
      confirm={t('cx.delete')} danger busy={busy === 'delete'} onCancel={() => setConfirmDelete(false)} onConfirm={() => void remove()} />
  </article>
}

/** AWS 계정 연결: 용도 → CloudFormation Launch Stack → RoleArn 붙여 넣기 → 연결 확인 */
function ConnectDialog({ open, resume, onClose, onChanged }: { open: boolean; resume: Connection | null; onClose: () => void; onChanged: () => void }) {
  const { t } = useI18n()
  const [purpose, setPurpose] = useState<Purpose>('AWS_SOURCE')
  const [created, setCreated] = useState<{ connection: Connection; launch_stack_url: string | null } | null>(null)
  const [roleArn, setRoleArn] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [verified, setVerified] = useState<Connection | null>(null)
  const current = created?.connection ?? resume

  const reset = () => { setPurpose('AWS_SOURCE'); setCreated(null); setRoleArn(''); setTouched(false); setBusy(false); setFailure(null); setVerified(null) }
  const close = () => { reset(); onClose() }

  const create = async () => {
    setBusy(true); setFailure(null)
    const result = await api<CreatedConnection>('/api/connections', { method: 'POST', body: { kind: purpose } })
    setBusy(false)
    if (!result.ok) { setFailure(result); return }
    setCreated({ connection: result.data.connection, launch_stack_url: result.data.launch_stack_url })
    onChanged()
  }
  const valid = isRoleArn(roleArn)
  const verify = async () => {
    setTouched(true)
    if (!current || !valid) return
    setBusy(true); setFailure(null); setVerified(null)
    const result = await api<{ connection: Connection }>('/api/connections/' + encodeURIComponent(current.connection_id) + '/verify', { method: 'POST', body: { role_arn: roleArn.trim() } })
    setBusy(false)
    onChanged()
    if (!result.ok) { setFailure(result); return }
    if (result.data.connection.status === 'FAILED') setFailure({ error: 'conflict', detail: result.data.connection.error_code ?? null })
    else setVerified(result.data.connection)
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
          {created?.launch_stack_url
            ? <a className="cx-primary" href={created.launch_stack_url} target="_blank" rel="noopener noreferrer" data-launch-stack>{t('cx.aws.launch')} ↗</a>
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
      {failure && <ErrorNote error={failure.error} title={failure.detail === 'ASSUME_ROLE_DENIED' ? t('cx.aws.failed') : undefined} detail={failure.detail} />}
      {verified && <div className="cx-pass" role="status">
        <strong>{t('cx.aws.verified')}</strong>
        <span>{t('cx.aws.verifiedDetail', { account: verified.account_id ?? '—', region: verified.region ?? '—' })}</span>
        {verified.eks_clusters && <span className="cx-tags">{verified.eks_clusters.map(name => <code key={name}>{name}</code>)}</span>}
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
