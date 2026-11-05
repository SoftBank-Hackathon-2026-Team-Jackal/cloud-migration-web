'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n, type Translate } from '../lib/i18n'
import { startRequestFor, type StartRequest, type Target } from '../lib/migration/events'
import { requiresSource, sseStartMode } from '../lib/migration/config'
import { useMigration } from '../lib/migration/MigrationProvider'
import type { PinnedSource } from '../lib/github/repos'
import type { Detection, RepoScan } from '../lib/github/scan'
import { api } from '../lib/connections/client'
import { agentState, type AgentView, type Connection, type ConnectionsList, type ScopeConfirmation } from '../lib/connections/types'
import { crossCheck } from '../lib/setup/envFile'
import { DEMO_REPO, DEMO_SCAN } from '../lib/setup/demoRepo'
import RepoPicker from './RepoPicker'
import RepoImport from './RepoImport'
import EnvDrop, { type EnvResult } from './EnvDrop'
import ScopeSelect from './ScopeSelect'

type Props = {
  target: Target
  onTarget: (target: Target) => void
  onNext: (request: StartRequest) => void
  /** 자칼이 말할 문구(가져오기 완료·.env 확인) */
  onSay?: (text: string) => void
  /** 음성("좋아, 시작하자")·단축키로 시작할 수 있게 부모에게 시작 함수를 넘긴다 */
  startRef?: { current: (() => void) | null }
}

/** 자칼이 읽어 줄 "찾았어요: …" 목록 */
export function foundList(t: Translate, detections: Detection[]): string {
  const parts = detections.flatMap(detection => {
    if (detection.kind === 'runtime') return [t('open.found.runtime', { name: detection.name })]
    if (detection.kind === 'dockerfile') return [t('open.found.dockerfile')]
    if (detection.kind === 'k8s') return [t('open.found.k8s', { count: detection.count })]
    if (detection.kind === 'postgres') return [t('open.found.postgres')]
    return []
  })
  return parts.length ? parts.join(t('open.found.sep')) : t('open.found.none')
}

/** 설정 화면이 쓰는 등록 정보: 통합 목록(GET /api/connections)에서 원본 1개·대상(GKE·K3s)만 고른다 */
export type Registered = { source: Connection | null; gcp: Connection | null; agent: AgentView | null; sources: Connection[]; agentsError: boolean }

export function pickRegistered(list: ConnectionsList, nowSeconds: number): Registered {
  const sources = list.connections.filter(item => item.kind === 'AWS_SOURCE' && item.status === 'CONNECTED')
  const live = list.agents.filter(agent => !agent.revoked)
  const rank = (agent: AgentView) => ({ online: 0, offline: 1, pending: 2, revoked: 3 })[agentState(agent, nowSeconds)]
  return {
    source: sources[0] ?? list.connections.find(item => item.kind === 'AWS_SOURCE') ?? null,
    gcp: list.connections.find(item => item.kind === 'GCP_TARGET' && item.status === 'CONNECTED') ?? list.connections.find(item => item.kind === 'GCP_TARGET') ?? null,
    agent: [...live].sort((a, b) => rank(a) - rank(b))[0] ?? null,
    sources,
    agentsError: Boolean(list.meta.agents.error),
  }
}

function useNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/** 플랫폼에 등록된 원본·대상(읽기 전용, /settings에서 관리). 대상 카드만 고를 수 있다. */
function Environments({ env, target, onTarget }: { env: Registered; target: Target; onTarget: (target: Target) => void }) {
  const { t, tOr } = useI18n()
  const now = useNow()
  const regionName = (id: string) => tOr('region.' + id, id)
  const { source, gcp, agent } = env
  const state = agent ? agentState(agent, now) : null
  const seconds = agent?.last_seen_at != null ? Math.max(0, now - agent.last_seen_at) : 0
  const chip = (connection: Connection | null) => connection?.status === 'CONNECTED'
    ? <span className="senv-chip"><i />{t('setup2.connected')}</span>
    : <span className="senv-chip is-off"><i />{t(connection ? 'setup3.notReady' : 'setup3.missing')}</span>
  return <div className="senv" aria-label={t('setup2.registryAria')} role="group">
    <div className="senv-card">
      <div className="senv-k">{t('setup2.source')}{chip(source)}</div>
      {source ? <>
        <strong>{t('setup2.srcTitle', { account: source.account_id ?? '—' })}</strong>
        <span>{t('setup3.srcDetail', { region: source.region ?? '—', regionName: regionName(source.region ?? ''), clusters: source.eks_clusters?.join(', ') || '—' })}</span>
      </> : <><strong>{t('setup3.noSource')}</strong><span><a className="setup3-manage" href="/settings#aws">{t('setup3.manage')}</a></span></>}
    </div>
    <span className="senv-arrow" aria-hidden="true">→</span>
    <div className="senv-card is-selected" data-target={target}>
      <div className="senv-k">{t('setup2.dest')}
        {target === 'onprem'
          ? agent && state
            ? <span className={'senv-chip' + (state === 'online' ? ' is-live' : ' is-off')}><i />{state === 'pending' ? t('setup3.agentPending') : t(state === 'online' ? 'setup2.online' : 'setup2.offline', { s: seconds })}</span>
            : <span className="senv-chip is-off"><i />{t('setup3.missing')}</span>
          : chip(gcp)}
      </div>
      <strong>{t(target === 'onprem' ? 'setup2.onpremTitle' : 'setup2.gcpTitle')}</strong>
      <span className="senv-detail">{target === 'onprem'
        ? agent ? t('setup3.onpremDetail', { agent: agent.agent_id }) : t(env.agentsError ? 'setup3.agentsError' : 'setup3.noAgent')
        : gcp ? t('setup3.gcpDetail', { project: gcp.project_id ?? '—', region: gcp.region ?? '—', regionName: regionName(gcp.region ?? '') }) : t('setup3.noGcp')}</span>
      <div className="migration-segment senv-switch" role="radiogroup" aria-label={t('setup.targetAria')}>
        {(['gcp', 'onprem'] as const).map(value => <button key={value} type="button"
          role="radio" aria-checked={target === value} className={target === value ? 'is-selected' : ''}
          onClick={() => onTarget(value)}>{t(value === 'gcp' ? 'target.gcp' : 'target.onprem.short')}</button>)}
      </div>
    </div>
  </div>
}

export default function MigrationSetup({ target, onTarget, onNext, onSay, startRef }: Props) {
  const { t } = useI18n()
  const { mode } = useMigration()
  const needsSource = requiresSource(mode)
  const backendWaiting = mode === 'sse' && sseStartMode() === 'wait'
  const [env, setEnv] = useState<Registered | null | 'loading'>('loading')
  // 1단계: 연결·코드·.env → 2단계: 이전 범위 선택(확정해야 분석으로 넘어간다)
  const [step, setStep] = useState<'inputs' | 'scope'>('inputs')
  const scopeAction = useRef<(() => void) | null>(null)
  // 고른 공개 저장소(서버가 기본 브랜치 커밋 SHA를 고정한 값) 또는 목업 모드의 시연용 저장소
  const [source, setSource] = useState<PinnedSource | null>(null)
  const [demo, setDemo] = useState(false)
  const [scan, setScan] = useState<RepoScan | null>(null)
  const [envFile, setEnvFile] = useState<EnvResult | null>(null)
  // SSE 모드에서 백엔드가 source를 아직 못 받을 때(#60 전) 시작하지 않고 대기 안내를 보여 준다.
  const [pending, setPending] = useState(false)
  const exampleRef = useRef<(() => void) | null>(null)
  const sayRef = useRef(onSay)
  sayRef.current = onSay

  // 등록 정보(에이전트 마지막 접속 포함)는 웹 서버의 통합 목록에서 10초마다 다시 읽는다. 여기서는 등록·수정하지 않는다.
  useEffect(() => {
    const controller = new AbortController()
    const load = () => void api<ConnectionsList>('/api/connections', { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return
      const found = result.ok ? pickRegistered(result.data, Math.floor(Date.now() / 1000)) : null
      setEnv(current => found ?? (current === 'loading' ? null : current))
    }, () => {})
    load()
    const timer = window.setInterval(load, 10000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [mode])

  const blocked = needsSource && !source
  const chooseSource = (next: PinnedSource | null) => { setSource(next); setScan(null); setPending(false) }
  const useDemo = useCallback(() => { if (!needsSource) { setDemo(true); setScan(null) } }, [needsSource])
  const expected = useMemo(() => scan?.env_keys ?? [], [scan])

  const onScanned = useCallback((result: RepoScan | null) => {
    setScan(result)
    if (result) sayRef.current?.(t('open.jackal.imported', { found: foundList(t, result.detections) }))
  }, [t])

  const onEnvFile = (next: EnvResult | null) => {
    setEnvFile(next)
    if (!next) return
    const check = expected.length ? crossCheck(next.keys, expected) : null
    if (!check) sayRef.current?.(t('open.jackal.envKeys', { count: next.keys.length }))
    else if (check.missing.length) sayRef.current?.(t('open.jackal.envMissing', { expected: check.expected, present: check.present.length, missing: check.missing.length }))
    else sayRef.current?.(t('open.jackal.envComplete', { expected: check.expected }))
  }

  // 1단계의 시작: 이전 범위 선택으로 넘어간다(백엔드가 아직 시작을 받지 못하면 대기 안내만 보인다).
  const submit = () => {
    if (step === 'scope') { scopeAction.current?.(); return }
    if (blocked) return
    if (backendWaiting) { setPending(true); return }
    setStep('scope')
    sayRef.current?.(t('scope.jackal.intro'))
  }
  // 범위를 확정해야 이전을 시작한다. [가정] 확정한 범위는 아직 시작 요청 계약에 없어 싣지 않는다(scope_id는 화면에서만 쓴다).
  const onScopeConfirmed = (_confirmation: ScopeConfirmation) => {
    const registered = env && env !== 'loading' ? env : null
    onNext(startRequestFor(target, {
      region: registered?.gcp?.region, agentId: registered?.agent?.agent_id,
      // 시연용 저장소는 싣지 않는다. .env는 키 이름만 알고 있어 백엔드가 쓸 수 있는 업로드 참조가 아니다: 보내지 않는다.
      source: source ?? undefined,
    }))
  }
  const submitRef = useRef(submit)
  submitRef.current = submit
  useEffect(() => {
    if (!startRef) return
    startRef.current = () => submitRef.current()
    return () => { startRef.current = null }
  }, [startRef])

  const stepRef = useRef(step)
  stepRef.current = step
  // 발표자 단축키(설정 화면): E 예시 .env, R 데모 저장소, S 시작
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.metaKey || event.ctrlKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'e' && stepRef.current === 'inputs') exampleRef.current?.()
      if (key === 'r' && stepRef.current === 'inputs') useDemo()
      if (key === 's') submitRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [useDemo])

  const hasRepo = Boolean(source) || demo
  const ready = !blocked && hasRepo && Boolean(envFile)
  return <section className="migration-setup setup2" aria-label={t('setup.aria')}>
    <div className="migration-form-panel setup2-panel">
      <div className="migration-heading setup2-heading">
        <div>
          <h2 className="migration-title" aria-level={1}>{t('setup2.title')}</h2>
          <p>{t('setup2.subtitle')}</p>
        </div>
        <div className="setup3-meta">
          <span className="senv-chip is-quiet"><i />{t('setup2.registry')}</span>
          <a className="setup3-manage" href="/settings">{t('setup3.manage')}</a>
        </div>
      </div>
      {env === 'loading' && <p className="setup2-note" role="status">{t('setup2.loading')}</p>}
      {env === null && <p className="setup2-note is-alert" role="alert">{t('setup2.unavailable')}</p>}
      {env && env !== 'loading' && <Environments env={env} target={target} onTarget={onTarget} />}
      {step === 'scope' && <ScopeSelect sources={env && env !== 'loading' ? env.sources : []} onConfirmed={onScopeConfirmed}
        onBack={() => setStep('inputs')} actionRef={scopeAction} onSay={text => sayRef.current?.(text)} />}
      {step === 'inputs' && <><div className="setup2-main">
        <section className={'setup2-card' + (!scan ? ' is-focus' : '')} aria-label={t('setup2.code')}>
          <h3>{t('setup2.code')}<small>{t('setup2.codeHint')}</small></h3>
          {!demo && <RepoPicker value={source} onChange={chooseSource} returnTo={'/?stage=setup&target=' + target} />}
          {!demo && !source && !needsSource && <button type="button" className="envd-btn setup2-demo" onClick={useDemo}>{t('setup2.demoRepo')} <kbd>R</kbd></button>}
          {demo && <div className="repo-pinned" role="status">
            <div className="repo-pinned-text">
              <strong>{DEMO_REPO.full_name}</strong>
              <span>{t('setup.repoPinned', { branch: DEMO_REPO.default_branch, sha: DEMO_REPO.commit_sha.slice(0, 7) })} · {t('setup2.demoNote')}</span>
            </div>
            <button type="button" className="repo-link" onClick={() => { setDemo(false); setScan(null) }}>{t('setup2.change')}</button>
          </div>}
          {demo && <RepoImport key="demo" scan={DEMO_SCAN} onDone={onScanned} />}
          {source && <RepoImport key={source.commit_sha} scan={{ full_name: source.full_name, commit_sha: source.commit_sha }} onDone={onScanned} />}
        </section>
        <section className={'setup2-card' + (scan && !envFile ? ' is-focus' : '')} aria-label={t('setup2.env')}>
          <h3>{t('setup2.env')}<small>.env</small></h3>
          <EnvDrop expected={expected} exceptions={scan?.env_exceptions} value={envFile} onChange={onEnvFile} exampleRef={exampleRef} />
        </section>
      </div>
      {pending && source && <div className="repo-pending" role="alert">
        <strong>{t('pending.step')}</strong>
        <span>{t('pending.lead')}</span>
        <span>{t('pending.repo', { name: source.full_name, sha: source.commit_sha.slice(0, 7) })}</span>
      </div>}
      <div className="migration-footer setup2-footer">
        <span className={'migration-hint repo-footer-note' + (ready ? ' is-ready' : '')}>
          {blocked ? t('setup.repoRequired') : ready ? t('setup2.ready') : t('setup2.waiting')}
        </span>
        <button className="migration-next" type="button" disabled={blocked} aria-disabled={blocked} onClick={submit}>
          {t('setup2.start')} <kbd>S</kbd>
        </button>
      </div></>}
    </div>
  </section>
}
