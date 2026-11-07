'use client'

import { useEffect, useState } from 'react'
import StageShell from './StageShell'
import ReplicationDiagram from './ReplicationDiagram'
import PhaseStrip, { STRIP_GATE, type GateState } from './PhaseStrip'
import { orderKey, useI18n, type MsgKey } from '../lib/i18n'
import type { Target } from '../lib/stages'
import type { DataPhase, PreflightCheck, PreflightCheckName } from '../lib/migration/events'
import type { MigrationState } from '../lib/migration/reducer'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'
import { useVoiceActions } from '../lib/voice/actions'

/**
 * 데이터 이전: 이전 경로 사전 검사(장부) · 경로와 WAL 테이프(구성도) · 지연 오실로스코프 · 테이블별 복사 · 전환 가능 시점 · 단계 띠.
 * 모든 값은 data.preflight · data.phase · data.lsn · data.table · data.readiness 이벤트에서 온다 [가정].
 * 그 이벤트가 없는 서버(data.progress만 보내는 경우)도 단계와 지연을 예전 값으로 읽는다.
 */
type View = 'tunnel' | 'preflight' | 'blocked' | 'schema' | 'copy' | 'catchup' | 'synced' | 'ready'

const CHECK_ORDER: PreflightCheckName[] = ['cidr_overlap', 'route', 'db_path', 'large_transfer']
const LEGACY_PHASE: Record<string, DataPhase> = { connect: 'preflight', dump: 'copy', cdc: 'catchup', ready: 'streaming' }
const SCOPE_MAX_MS = 3600

type Data = MigrationState['data']

function phaseOf(data: Data): DataPhase | null {
  return data.phase ?? (data.current ? LEGACY_PHASE[data.current.step] : null)
}

/** 게이트 1: 전환 가능(지연≈0 · 긴 트랜잭션·잠금 없음). readiness가 없으면 예전 진행 값의 ready를 쓴다. */
function isReady(data: Data) {
  return data.readiness ? data.readiness.ready : data.current?.step === 'ready'
}

function viewOf(data: Data): View {
  const verdict = data.preflight?.status
  if (verdict === 'FAIL' || verdict === 'UNKNOWN' || data.phase === 'blocked') return 'blocked'
  const phase = phaseOf(data)
  if (phase === 'streaming') return isReady(data) ? 'ready' : 'synced'
  if (phase === 'schema' || phase === 'copy' || phase === 'catchup') return phase
  // 원본 쪽 복제 통로(WireGuard·NLB)를 여는 중: 사전 검사 결과(data.preflight)가 오면 사전 검사 뷰로 이어진다. 화면 배치는 사전 검사 뷰와 같다.
  if (phase === 'tunnel' && !data.preflight) return 'tunnel'
  return 'preflight'
}

export default function DataMigrationStage({ target, onNext }: { target: Target; onNext: () => void }) {
  const { t } = useI18n()
  const { state } = useMigration()
  const view = viewOf(state.data)
  const dbFirst = state.cutover.dbFirst
  return <StageShell kicker="DATA MIGRATION · POSTGRESQL" title={t(orderKey(('dmig.title.' + view) as MsgKey, dbFirst))}
    subtitle={t(orderKey(('dmig.sub.' + view) as MsgKey, dbFirst))} className="dm-stage">
    {ready => <DataBody ready={ready} target={target} onNext={onNext} />}
  </StageShell>
}

function useElapsed(running: boolean) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!running) return
    const began = Date.now()
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - began) / 1000)), 500)
    return () => window.clearInterval(timer)
  }, [running])
  return seconds
}

function DataBody({ ready, target, onNext }: { ready: boolean; target: Target; onNext: () => void }) {
  const { t, lang } = useI18n()
  const locale = lang === 'ko' ? 'ko-KR' : lang === 'ja' ? 'ja-JP' : 'en-US'
  const num = (value: number) => value.toLocaleString(locale)
  const { state } = useMigration()
  useStageFeed('data_copy', ready, target)
  const data = state.data
  const view = viewOf(data)
  const phase = phaseOf(data)
  const preflight = data.preflight
  const verdict = preflight?.status ?? null
  const blocked = view === 'blocked'
  const gate1 = view === 'ready'
  useVoiceActions({ next: gate1 && onNext })
  const elapsed = useElapsed(ready)

  // 초기 복사 진행: 테이블별 행 수 합(없으면 예전 dump_percent)
  const rowsTotal = data.tables.reduce((sum, table) => sum + table.rows_total, 0)
  const rowsCopied = data.tables.reduce((sum, table) => sum + table.rows_copied, 0)
  const copy = phase === 'catchup' || phase === 'streaming' ? 1 : rowsTotal > 0 ? rowsCopied / rowsTotal : (data.current?.dump_percent ?? 0) / 100
  const tablesDone = data.tables.filter(table => table.state !== 'waiting' && table.state !== 'copying').length
  const lsn = data.lsn ?? (data.current && data.current.lag_ms !== null ? { source_lsn: '—', target_lsn: '—', lag_bytes: 0, lag_ms: data.current.lag_ms } : null)
  const synced = (phase === 'streaming') && !!lsn && (data.lsn ? data.lsn.lag_bytes === 0 : (lsn.lag_ms ?? 1) <= 40)
  const route = preflight?.checks.find(check => check.name === 'route') ?? null
  const tapeLabel = phase === 'schema' ? 'pg_dump --schema-only · mig.marker'
    : phase === 'copy' ? t('dmig.d.tapeCopy', { done: tablesDone, total: data.tables.length || '—', pct: Math.round(copy * 100) })
    : !verdict || verdict === 'RUNNING' ? (route && route.status !== 'PENDING' ? t('dmig.d.tapeProbe') : '') : ''

  // 지연 기록: data.lsn이 쌓은 궤적(없으면 예전 lagHistory)
  const trace = data.lagTrace.length > 0 ? data.lagTrace : data.lagHistory
  const lag = lsn?.lag_ms ?? null
  const recent = trace.slice(-80).slice().sort((a, b) => a - b)
  const p99 = recent.length ? recent[Math.min(recent.length - 1, Math.floor(recent.length * 0.99))] : null

  // 단계 띠의 지금 위치
  const checksDone = preflight ? preflight.checks.filter(check => check.status !== 'PENDING' && check.status !== 'RUNNING').length : 0
  const position = blocked ? STRIP_GATE.preflight
    : view === 'tunnel' ? 0
    : view === 'preflight' ? (checksDone / 4) * STRIP_GATE.preflight
    : view === 'schema' ? STRIP_GATE.preflight + 1.5
    : view === 'copy' ? 15 + copy * 13
    : view === 'catchup' ? 28 + Math.max(0, Math.min(1, 1 - (lag ?? SCOPE_MAX_MS) / 3400)) * 15
    : view === 'synced' ? 45 : STRIP_GATE.synced
  const gates: [GateState, GateState, GateState] = [blocked ? 'fail' : verdict === 'PASS' || phase === 'copy' || phase === 'catchup' || phase === 'streaming' ? 'pass' : 'wait', gate1 ? 'pass' : 'wait', 'wait']
  const stripNote = blocked ? t('dmig.strip.blocked') : gate1 ? t(orderKey('dmig.strip.ready', state.cutover.dbFirst)) : view === 'tunnel' ? t('dmig.strip.tunnel') : view === 'preflight' ? t('dmig.strip.preflight') : t(orderKey('dmig.strip.wait', state.cutover.dbFirst))

  return <div className={'dm' + (blocked ? ' is-blocked' : '')}>
    <div className="dm-main">
      <Preflight target={target} data={data} />
      <section className="dm-card dm-viz" aria-label={t('dmig.d.title')}>
        <div className="dm-viz-head">
          <h2>{t('dmig.d.title')}</h2>
          <span className="dm-clock"><b className="dm-mono">T+ {String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}</b><small>{t(('dmig.phase.' + view) as 'dmig.phase.preflight')}</small></span>
        </div>
        <ReplicationDiagram target={target} network={preflight?.network ?? null} verdict={verdict} route={route} phase={phase}
          copy={copy} tapeLabel={tapeLabel} lsn={lsn} synced={synced} />
      </section>
    </div>

    <div className="dm-lower">
      <section className="dm-card dm-pane" aria-label={t('dmig.lag.title')}>
        <div className="dm-pane-head"><h2>{t('dmig.lag.title')}</h2><small className="dm-mono">{lag === null ? '— · p99 —' : `${num(lag)} ms · p99 ${num(p99 ?? lag)} ms`}</small></div>
        <LagScope trace={trace} synced={synced} empty={blocked ? t('dmig.lag.blocked') : t('dmig.lag.empty')} />
      </section>
      <section className="dm-card dm-pane" aria-label={t('dmig.tables.title')}>
        <div className="dm-pane-head"><h2>{t('dmig.tables.title')}</h2><small>{tableSummary()}</small></div>
        {data.tables.length > 0 ? <table className="dm-tables">
          <tbody>{data.tables.map(table => <tr key={table.name} className={'is-' + table.state}>
            <td className="dm-mono">{table.name}</td>
            <td><span className="dm-bar"><i style={{ width: (table.rows_total ? (table.rows_copied / table.rows_total) * 100 : 0) + '%' }} /></span></td>
            <td className="dm-num">{table.state === 'matched' ? t('dmig.tables.matched') : table.state === 'waiting' ? '—' : num(table.rows_copied)}</td>
          </tr>)}</tbody>
        </table> : <p className="dm-empty">{blocked ? t('dmig.tables.blocked') : t('dmig.tables.empty')}</p>}
      </section>
      <section className="dm-card dm-pane" aria-label={t('dmig.ready.title')}>
        <div className="dm-pane-head"><h2>{t('dmig.ready.title')}</h2><small>{t('dmig.ready.every')}</small></div>
        <dl className="dm-ready">
          <dt>{t('dmig.ready.tx')}</dt><dd className="dm-mono">{data.readiness ? (data.readiness.longest_tx_ms / 1000).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' s' : '—'}</dd>
          <dt>{t('dmig.ready.locks')}</dt><dd className="dm-mono">{data.readiness ? num(data.readiness.lock_waits) : '—'}</dd>
          <dt>{t('dmig.ready.commits')}</dt><dd className="dm-mono">{data.readiness ? num(Math.round(data.readiness.commits_per_sec)) + ' /s' : '—'}</dd>
        </dl>
        <p className={'dm-ready-verdict' + (gate1 ? ' is-ok' : '')} role="status">{gate1 ? t('dmig.ready.ok') : data.readiness ? t('dmig.ready.running') : blocked ? t('dmig.ready.blocked') : t('dmig.ready.wait')}</p>
      </section>
    </div>

    <div className="dm-strip">
      <PhaseStrip position={position} gates={gates} blocked={blocked} dbFirst={state.cutover.dbFirst} note={stripNote}
        action={<div className="flow-footer dm-go"><button type="button" className="flow-primary" disabled={!gate1} onClick={onNext}>{t(orderKey('data.go', state.cutover.dbFirst))} <span aria-hidden="true">→</span></button></div>} />
    </div>
  </div>

  function tableSummary() {
    if (blocked) return t('dmig.tables.sumBlocked')
    if (phase === 'schema') return t('dmig.tables.sumSchema')
    if (phase === 'copy') return Math.round(copy * 100) + '%'
    if (gate1 && data.tables.every(table => table.state === 'matched')) return t('dmig.tables.sumMatched')
    if (phase === 'catchup' || phase === 'streaming') return t('dmig.tables.sumCdc')
    return t('dmig.tables.sumWait')
  }
}

// ---- 이전 경로 사전 검사(장부) ----

const pad = (value: number) => String(value).padStart(2, '0')
const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`

/** 경로 검사 실패 코드: 플랫폼(cmp_providers network_preflight) NO_ROUTE·UNEXPECTED_PATH·ROUTE_UNVERIFIED, 목업 ROUTE_NOT_TUNNEL */
const ROUTE_CODES: ReadonlySet<string> = new Set(['NO_ROUTE', 'UNEXPECTED_PATH', 'ROUTE_UNVERIFIED', 'ROUTE_NOT_TUNNEL'])
/** 앞 검사가 실패해 실행하지 않은 검사(플랫폼은 SKIPPED 대신 UNKNOWN + 이 코드로 보낸다): 건너뜀으로 보인다. */
const NOT_RUN_CODES: ReadonlySet<string> = new Set(['NOT_RUN_AFTER_STATIC_FAILURE', 'NOT_RUN'])

const STATUS_CLASS: Record<string, string> = { PASS: 'pass', FAIL: 'fail', UNKNOWN: 'unk', RUNNING: 'run', SKIPPED: 'skip', PENDING: '' }

function Preflight({ target, data }: { target: Target; data: Data }) {
  const { t, lang } = useI18n()
  const locale = lang === 'ko' ? 'ko-KR' : lang === 'ja' ? 'ja-JP' : 'en-US'
  const preflight = data.preflight
  const network = preflight?.network ?? null
  const verdict = preflight?.status ?? null
  const done = verdict && verdict !== 'RUNNING'
  const checks = CHECK_ORDER.map(name => preflight?.checks.find(check => check.name === name) ?? { name, status: 'PENDING', code: null, evidence: '' } as PreflightCheck)
    .map(check => check.status === 'UNKNOWN' && check.code && NOT_RUN_CODES.has(check.code) ? { ...check, status: 'SKIPPED' as const } : check)
  const time = preflight?.checked_at ? clock(new Date(preflight.checked_at)) : ''
  const fingerprint = preflight?.input_fingerprint ? preflight.input_fingerprint.replace(/^sha256:/, '').slice(0, 8) : null
  const failed = preflight?.checks.find(check => check.status === 'FAIL' || (check.status === 'UNKNOWN' && !(check.code && NOT_RUN_CODES.has(check.code))))
  const gateText = !done ? t('dmig.pf.gate.wait')
    : verdict === 'PASS' ? t('dmig.pf.gate.open')
    : (failed && ROUTE_CODES.has(failed.code ?? '') ? t('dmig.pf.gate.route') : verdict === 'UNKNOWN' ? t('dmig.pf.gate.unknown') : t('dmig.pf.gate.fail')) + ' ' + t('dmig.pf.gate.noReuse')

  const statusLabel = (check: PreflightCheck) => check.status === 'PENDING' ? t('dmig.pf.st.wait')
    : check.status === 'RUNNING' ? (check.name === 'large_transfer' ? t('dmig.pf.st.sending') : t('dmig.pf.st.run'))
    : check.status === 'SKIPPED' ? t('dmig.pf.st.skip') : check.status

  /** 증거 한 줄: [앞 문구(sans), 값(mono), 뒤 문구(sans)]. 한글 문구는 mono에 넣지 않는다. */
  const evidence = (check: PreflightCheck): [string, string, string] => {
    if (check.status === 'SKIPPED') return [t('dmig.pf.ev.skipped'), '', '']
    const coded = check.code && check.status !== 'PASS' ? check.code + ' · ' : ''
    switch (check.name) {
      case 'cidr_overlap':
        if (check.status === 'PASS') return [t('dmig.pf.ev.noOverlap') + ' · ', check.evidence, '']
        if (check.evidence) return ['', coded + check.evidence, '']
        return ['', network ? [network.source_cidr, network.target_cidr, network.path.cidr].filter(Boolean).join(' · ') : '—', '']
      case 'route': {
        const expected = !network ? '' : network.path.kind === 'wireguard' ? 'dev ' + network.path.name : 'next hop ' + network.path.name
        if (check.status === 'PASS') return ['', check.evidence, ' · ' + t('dmig.pf.ev.routeMatch')]
        if (check.evidence) return ['', coded + check.evidence, '']
        return network ? [t('dmig.pf.ev.routeExpect', { addr: network.source_addr, path: expected }), '', ''] : ['', '—', '']
      }
      case 'db_path':
        return ['', coded + (check.evidence || network?.source_db || '—'), '']
      case 'large_transfer': {
        const total = check.bytes_total ?? 4 * 1024 * 1024
        const base = `${Math.round((check.bytes_done ?? 0) / 1024).toLocaleString(locale)} / ${Math.round(total / 1024).toLocaleString(locale)} KiB`
        if (check.status === 'PASS') return ['', base + (check.elapsed_ms ? ` · ${(check.elapsed_ms / 1000).toLocaleString(locale, { maximumFractionDigits: 2 })} s` : ''), check.mtu === 'NOT_ATTEMPTED' ? ' · ' + t('dmig.pf.ev.mtu') : '']
        return ['', coded + base, '']
      }
    }
  }

  return <section className="dm-card dm-pf" aria-label={t('dmig.pf.title')}>
    <h2>{t('dmig.pf.title')}</h2>
    <p className="dm-pf-note">{t('dmig.pf.note', { where: preflight?.probe_location ?? '—' })}</p>
    <ol className="dm-checks">
      {checks.map(check => {
        const cls = STATUS_CLASS[check.status] ?? ''
        const total = check.bytes_total ?? 4 * 1024 * 1024
        return <li key={check.name} className={'dm-ck' + (cls ? ' is-' + cls : '')}>
          <span className="dm-dot" aria-hidden="true" />
          <div className="dm-ck-body">
            <strong>{t(('dmig.pf.' + check.name) as 'dmig.pf.route')}<span className="dm-kind">{check.name === 'route' && target !== 'onprem' ? t('dmig.pf.kind.vpcRoute') : t(('dmig.pf.kind.' + check.name) as 'dmig.pf.kind.route')}</span></strong>
            {check.name === 'db_path' && <span className="dm-chain" aria-label={t('dmig.pf.chainAria')}>
              {(check.steps ?? (['DNS', 'TCP', 'TLS', 'AUTH', 'QUERY'] as const).map(name => ({ name, status: 'PENDING' as const }))).map(step =>
                <i key={step.name} className={step.status === 'PASS' ? 'is-ok' : step.status === 'FAIL' || step.status === 'UNKNOWN' ? 'is-bad' : ''}>{step.name === 'AUTH' ? t('dmig.pf.auth') : step.name === 'QUERY' ? 'SELECT 1' : step.name}</i>)}
            </span>}
            {check.name === 'large_transfer' && <span className="dm-xfer"><i style={{ width: Math.min(100, ((check.bytes_done ?? 0) / total) * 100) + '%' }} /></span>}
            {(() => { const [pre, value, post] = evidence(check); return <span className="dm-ev" title={pre + value + post}>{pre}<span className="dm-mono">{value}</span>{post}</span> })()}
          </div>
          <span className={'dm-st' + (cls ? ' is-' + cls : '')}>{statusLabel(check)}</span>
        </li>
      })}
    </ol>
    <div className={'dm-verdict' + (done ? ' is-' + STATUS_CLASS[verdict!] : '')}>
      <span className="dm-verdict-big">{done ? t('dmig.pf.verdict', { v: verdict! }) : t('dmig.pf.verdictWait')}</span>
      <span className={'dm-st' + (done ? ' is-' + STATUS_CLASS[verdict!] : '')}>{done ? verdict : '—'}</span>
      <span className="dm-fp">{fingerprint ? t('dmig.pf.fp', { fp: fingerprint, time: time || '—', where: preflight?.probe_location ?? '' }) : t('dmig.pf.fpNone')}</span>
      <p className={'dm-gate' + (done ? verdict === 'PASS' ? ' is-open' : ' is-block' : '')} role="status">{gateText}</p>
    </div>
  </section>
}

// ---- 복제 지연 오실로스코프: 오래된 구간일수록 옅어지는 궤적 ----

function LagScope({ trace, synced, empty }: { trace: number[]; synced: boolean; empty: string }) {
  const points = 160
  const max = Math.max(SCOPE_MAX_MS, ...trace)
  const xy = (value: number, index: number) => [(index / (points - 1)) * 100, 96 - (value / max) * 90] as const
  const last = trace.length ? xy(trace[trace.length - 1], trace.length - 1) : null
  return <div className="dm-scope" role="img" aria-label={empty}>
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      {[25, 50, 75].map(y => <line key={y} x1="0" x2="100" y1={y} y2={y} className="dm-scope-grid" vectorEffect="non-scaling-stroke" />)}
      {trace.slice(1).map((value, index) => {
        const [x1, y1] = xy(trace[index], index)
        const [x2, y2] = xy(value, index + 1)
        return <line key={index} x1={x1} y1={y1} x2={x2} y2={y2} className="dm-scope-line" style={{ opacity: 0.12 + 0.88 * ((index + 1) / trace.length) }} vectorEffect="non-scaling-stroke" />
      })}
    </svg>
    <span className="dm-scope-scale">{max.toLocaleString()} ms</span>
    <span className="dm-scope-scale is-zero">0</span>
    {last && <span className={'dm-scope-dot' + (synced ? ' is-gold' : '')} style={{ left: last[0] + '%', top: last[1] + '%' }} />}
    {!trace.length && <span className="dm-empty dm-scope-empty">{empty}</span>}
  </div>
}
