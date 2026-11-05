'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n, type Translate } from '../lib/i18n'
import { startRequestFor, type StartRequest, type Target } from '../lib/migration/events'
import { apiBase, requiresSource, sseStartMode } from '../lib/migration/config'
import { useMigration } from '../lib/migration/MigrationProvider'
import type { PinnedSource } from '../lib/github/repos'
import type { Detection, RepoScan } from '../lib/github/scan'
import { loadEnvironments, secondsSince, type RegisteredEnvironments } from '../lib/setup/registry'
import { crossCheck } from '../lib/setup/envFile'
import { DEMO_REPO, DEMO_SCAN } from '../lib/setup/demoRepo'
import RepoPicker from './RepoPicker'
import RepoImport from './RepoImport'
import EnvDrop, { type EnvResult } from './EnvDrop'

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

function useHeartbeat(iso: string | undefined) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return iso ? secondsSince(iso, now) : 0
}

/** 플랫폼에 등록된 원본·대상(읽기 전용). 대상 카드만 고를 수 있다. */
function Environments({ env, target, onTarget }: { env: RegisteredEnvironments; target: Target; onTarget: (target: Target) => void }) {
  const { t, tOr } = useI18n()
  const seconds = useHeartbeat(env.targets.onprem.last_heartbeat_at)
  const regionName = (id: string) => tOr('region.' + id, id)
  const onprem = env.targets.onprem
  const gcp = env.targets.gcp
  return <div className="senv" aria-label={t('setup2.registryAria')} role="group">
    <div className="senv-card">
      <div className="senv-k">{t('setup2.source')}<span className="senv-chip"><i />{t('setup2.connected')}</span></div>
      <strong>{t('setup2.srcTitle', { account: env.source.account_id })}</strong>
      <span>{t('setup2.srcDetail', { region: env.source.region, regionName: regionName(env.source.region), cluster: env.source.cluster.name })}</span>
    </div>
    <span className="senv-arrow" aria-hidden="true">→</span>
    <div className="senv-card is-selected" data-target={target}>
      <div className="senv-k">{t('setup2.dest')}
        {target === 'onprem'
          ? <span className={'senv-chip is-live' + (onprem.status === 'online' ? '' : ' is-off')}><i />{t(onprem.status === 'online' ? 'setup2.online' : 'setup2.offline', { s: seconds })}</span>
          : <span className="senv-chip"><i />{t('setup2.connected')}</span>}
      </div>
      <strong>{t(target === 'onprem' ? 'setup2.onpremTitle' : 'setup2.gcpTitle')}</strong>
      <span className="senv-detail">{target === 'onprem'
        ? t('setup2.onpremDetail', { agent: onprem.agent_id, profile: onprem.profile })
        : t('setup2.gcpDetail', { project: gcp.project_id, region: gcp.region, regionName: regionName(gcp.region), profile: gcp.profile })}</span>
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
  const [env, setEnv] = useState<RegisteredEnvironments | null | 'loading'>('loading')
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

  // 등록 정보(에이전트 하트비트 포함)는 10초마다 다시 읽는다.
  useEffect(() => {
    const controller = new AbortController()
    const load = () => void loadEnvironments(mode, apiBase(), controller.signal).then(found => {
      if (!controller.signal.aborted) setEnv(current => found ?? (current === 'loading' ? null : current))
    })
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

  const submit = () => {
    if (blocked) return
    if (backendWaiting) { setPending(true); return }
    const registered = env && env !== 'loading' ? env : null
    onNext(startRequestFor(target, {
      region: registered?.targets.gcp.region, agentId: registered?.targets.onprem.agent_id,
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

  // 발표자 단축키(설정 화면): E 예시 .env, R 데모 저장소, S 시작
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.metaKey || event.ctrlKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'e') exampleRef.current?.()
      if (key === 'r') useDemo()
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
        <span className="senv-chip is-quiet"><i />{t('setup2.registry')}</span>
      </div>
      {env === 'loading' && <p className="setup2-note" role="status">{t('setup2.loading')}</p>}
      {env === null && <p className="setup2-note is-alert" role="alert">{t('setup2.unavailable')}</p>}
      {env && env !== 'loading' && <Environments env={env} target={target} onTarget={onTarget} />}
      <div className="setup2-main">
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
          <EnvDrop expected={expected} value={envFile} onChange={onEnvFile} exampleRef={exampleRef} />
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
      </div>
    </div>
  </section>
}
