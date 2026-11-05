'use client'

import { useState } from 'react'
import { useI18n } from '../../lib/i18n'
import { api } from '../../lib/connections/client'
import type { ApiErrorCode, Connection } from '../../lib/connections/types'
import { Ago, Chip, ErrorNote, isoSeconds, MockBadge } from './parts'
import { StatusChip } from './AwsSection'

/** GCP: 데모는 우리 프로젝트 하나로 고정(읽기 전용 카드 + 연결 확인). WIF 등록 폼은 "곧 지원" 자리만. */
function GcpCard({ connection, now, onChanged }: { connection: Connection; now: number; onChanged: () => void }) {
  const { t, tOr } = useI18n()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ error: ApiErrorCode; detail: string | null } | null>(null)
  const verify = async () => {
    setBusy(true); setFailure(null)
    const result = await api('/api/connections/' + encodeURIComponent(connection.connection_id) + '/verify', { method: 'POST', body: {} })
    setBusy(false)
    if (!result.ok) setFailure(result)
    onChanged()
  }
  return <article className="cx-card" data-kind="GCP_TARGET" data-status={connection.status} aria-busy={busy}>
    <div className="cx-card-head">
      <div className="cx-card-title"><small>{t('cx.gcp.kind')}</small><strong>{connection.display_name}</strong></div>
      <div className="cx-card-state">
        {busy ? <Chip tone="wait">{t('cx.verifying')}</Chip> : <StatusChip connection={connection} />}
        <span className="cx-faint">{t('cx.lastChecked')} <Ago at={isoSeconds(connection.last_verified_at)} now={now} /></span>
        <button type="button" className="cx-btn" data-action="verify" onClick={() => void verify()} disabled={busy}>{t('cx.verify')}</button>
      </div>
    </div>
    <dl className="cx-ledger">
      <div><dt>{t('cx.gcp.project')}</dt><dd className="cx-mono">{connection.project_id ?? '—'}</dd></div>
      <div><dt>{t('cx.region')}</dt><dd>{connection.region ? <><span className="cx-mono">{connection.region}</span> {tOr('region.' + connection.region, '')}</> : '—'}</dd></div>
    </dl>
    {failure && <ErrorNote error={failure.error} detail={failure.detail} />}
  </article>
}

export default function GcpSection({ connections, error, mock, now, onChanged }: {
  connections: Connection[]; error: ApiErrorCode | null; mock: boolean; now: number; onChanged: () => void
}) {
  const { t } = useI18n()
  const list = connections.filter(item => item.kind === 'GCP_TARGET')
  return <section className="cx-section" aria-labelledby="cx-gcp-title">
    <header className="cx-section-head">
      <div>
        <h2 id="cx-gcp-title">{t('cx.gcp.title')} <MockBadge show={mock} /></h2>
        <p>{t('cx.gcp.lead')}</p>
      </div>
    </header>
    {error && <ErrorNote error={error} onRetry={onChanged} />}
    {!error && list.length === 0 && <div className="cx-empty"><strong>{t('cx.gcp.empty')}</strong><span>{t('cx.gcp.emptyHint')}</span></div>}
    <div className="cx-list">{list.map(connection => <GcpCard key={connection.connection_id} connection={connection} now={now} onChanged={onChanged} />)}</div>
    <form className="cx-soon" aria-labelledby="cx-wif-title" onSubmit={event => event.preventDefault()}>
      <div className="cx-soon-head"><h3 id="cx-wif-title">{t('cx.gcp.wifTitle')}</h3><span className="cx-chip is-off"><i />{t('cx.soon')}</span></div>
      <p>{t('cx.gcp.wifLead')}</p>
      <fieldset disabled>
        {(['project', 'pool', 'provider', 'serviceAccount'] as const).map(name => <label key={name} className="cx-field">
          <span>{t(('cx.gcp.wif.' + name) as 'cx.gcp.wif.project')}</span>
          <input className="cx-input" name={'wif-' + name} placeholder={t(('cx.gcp.wifPh.' + name) as 'cx.gcp.wifPh.project')} />
        </label>)}
      </fieldset>
    </form>
  </section>
}
