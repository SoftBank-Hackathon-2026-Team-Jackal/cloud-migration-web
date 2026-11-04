'use client'

import { useEffect, useRef, useState } from 'react'
import { signIn, signOut } from 'next-auth/react'
import { useT, type MsgKey } from '../lib/i18n'
import type { PinnedSource, RepoPage, RepoSummary } from '../lib/github/repos'
import type { ApiErrorCode } from '../lib/github/handlers'

type Props = {
  value: PinnedSource | null
  onChange: (source: PinnedSource | null) => void
  /** 로그인 뒤 이 설정 화면으로 돌아오기 위한 주소 */
  returnTo: string
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'not_configured' }
  | { kind: 'signed_out' }
  | { kind: 'expired' }
  | { kind: 'error'; code: ApiErrorCode }
  | { kind: 'ready'; data: RepoPage & { viewer: string | null } }

const PER_PAGE = 8
const LOOPBACK = /^(127(?:\.\d{1,3}){3}|\[::1\])$/
const LOGIN_PARAM = 'github_login'
const SEARCH_DELAY_MS = 300

const ERROR_TEXT: Partial<Record<ApiErrorCode, MsgKey>> = {
  rate_limited: 'setup.repoRateLimited',
  not_public: 'setup.repoNotPublic',
}

/** 서버 API의 오류 응답을 화면 상태로 바꾼다. 토큰 만료(401 auth_expired)는 다시 로그인하게 한다. */
async function errorState(response: Response): Promise<ListState> {
  const body = await response.json().catch(() => ({})) as { error?: ApiErrorCode }
  if (body.error === 'auth_not_configured') return { kind: 'not_configured' }
  if (body.error === 'not_signed_in') return { kind: 'signed_out' }
  if (response.status === 401) return { kind: 'expired' }
  return { kind: 'error', code: body.error ?? 'github_error' }
}

/**
 * GitHub 로그인 → 공개 저장소 검색·페이지 이동 → 저장소 선택.
 * 고르면 서버(/api/github/source)가 기본 브랜치의 커밋 SHA를 고정해 돌려준다. 토큰은 브라우저로 오지 않는다.
 */
export default function RepoPicker({ value, onChange, returnTo }: Props) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [list, setList] = useState<ListState>({ kind: 'loading' })
  const [reload, setReload] = useState(0)
  const [pinning, setPinning] = useState<number | null>(null)
  const [pinError, setPinError] = useState<ApiErrorCode | null>(null)
  const pinRequest = useRef<AbortController | null>(null)

  // 입력이 멈추면 검색어를 적용하고 첫 쪽으로 돌아간다.
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(query.trim()); setPage(1) }, SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  // 먼저 로그인 상태를 본다(로그인 전·설정 없음은 목록을 부르지 않는다).
  const [status, setStatus] = useState<'checking' | 'ready'>('checking')
  useEffect(() => {
    if (status === 'ready') return
    const controller = new AbortController()
    fetch('/api/github/status', { signal: controller.signal, cache: 'no-store' })
      .then(response => response.ok ? response.json() as Promise<{ configured: boolean; signed_in: boolean }> : Promise.reject(new Error('status')))
      .then(body => {
        if (!body.configured) setList({ kind: 'not_configured' })
        else if (!body.signed_in) setList({ kind: 'signed_out' })
        else setStatus('ready')
      })
      .catch(() => { if (!controller.signal.aborted) setList({ kind: 'error', code: 'github_error' }) })
    return () => controller.abort()
  }, [status, reload])

  useEffect(() => {
    if (status !== 'ready') return
    const controller = new AbortController()
    setList(current => current.kind === 'ready' ? current : { kind: 'loading' })
    const params = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) })
    if (search) params.set('q', search)
    fetch('/api/github/repos?' + params, { signal: controller.signal, cache: 'no-store' })
      .then(async response => setList(response.ok ? { kind: 'ready', data: await response.json() } : await errorState(response)))
      .catch(() => { if (!controller.signal.aborted) setList({ kind: 'error', code: 'github_error' }) })
    return () => controller.abort()
  }, [status, page, search, reload])

  useEffect(() => () => pinRequest.current?.abort(), [])

  // 127.0.0.1 → localhost로 옮겨 온 직후라면 로그인을 이어 간다(주소의 표시는 지운다).
  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.get(LOGIN_PARAM) !== '1') return
    url.searchParams.delete(LOGIN_PARAM)
    window.history.replaceState(window.history.state, '', url)
    void signIn('github', { redirectTo: url.pathname + url.search })
  }, [])

  const choose = async (repo: RepoSummary) => {
    pinRequest.current?.abort()
    const controller = new AbortController()
    pinRequest.current = controller
    setPinning(repo.repository_id)
    setPinError(null)
    onChange(null)
    try {
      const response = await fetch('/api/github/source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repository_id: repo.repository_id }),
        signal: controller.signal,
      })
      if (response.ok) onChange(await response.json() as PinnedSource)
      else {
        const next = await errorState(response)
        if (next.kind === 'error') setPinError(next.code)
        else setList(next)
      }
    } catch {
      if (!controller.signal.aborted) setPinError('github_error')
    } finally {
      if (pinRequest.current === controller) setPinning(null)
    }
  }

  const login = () => {
    // Next는 127.0.0.1을 localhost로 바꿔 OAuth 콜백 주소를 만든다. 127.0.0.1에서 로그인을 시작하면 상태 쿠키가
    // 다른 호스트에 남아 콜백이 실패하므로, 먼저 같은 주소의 localhost로 옮긴 뒤 거기서 로그인을 이어 간다.
    if (LOOPBACK.test(window.location.hostname)) {
      const url = new URL(returnTo, window.location.href)
      url.hostname = 'localhost'
      url.searchParams.set(LOGIN_PARAM, '1')
      window.location.assign(url)
      return
    }
    void signIn('github', { redirectTo: returnTo })
  }
  const logout = async () => {
    await signOut({ redirect: false })
    onChange(null)
    setList({ kind: 'signed_out' })
  }

  if (list.kind === 'not_configured') return <p className="migration-hint repo-note">{t('setup.repoNotConfigured')}</p>
  if (list.kind === 'signed_out' || list.kind === 'expired') {
    return <div className="repo-auth">
      {list.kind === 'expired' && <p className="repo-note is-alert" role="alert">{t('setup.repoExpired')}</p>}
      <button type="button" className="repo-login" onClick={login}>
        <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
        {t(list.kind === 'expired' ? 'setup.repoRelogin' : 'setup.repoLogin')}
      </button>
      <p className="migration-hint">{t('setup.repoLoginHint')}</p>
    </div>
  }

  if (status === 'checking' && list.kind === 'loading') return <p className="repo-note" role="status">{t('setup.repoLoading')}</p>

  if (value) {
    return <div className="repo-pinned" role="status">
      <div className="repo-pinned-text">
        <strong>{value.full_name}</strong>
        <span>{t('setup.repoPinned', { branch: value.default_branch, sha: value.commit_sha.slice(0, 7) })}</span>
      </div>
      <button type="button" className="repo-link" onClick={() => onChange(null)}>{t('setup.repoChange')}</button>
    </div>
  }

  const data = list.kind === 'ready' ? list.data : null
  return <div className="repo-picker">
    <div className="repo-bar">
      <span className="repo-viewer">{data?.viewer ? t('setup.repoSignedIn', { login: data.viewer }) : ' '}</span>
      <button type="button" className="repo-link" onClick={() => void logout()}>{t('setup.repoSignOut')}</button>
    </div>
    <input className="migration-input" type="search" name="repositorySearch" autoComplete="off"
      aria-label={t('setup.repoSearch')} placeholder={t('setup.repoSearchPh')}
      value={query} onChange={event => setQuery(event.target.value)} />
    {list.kind === 'loading' && <p className="repo-note" role="status">{t('setup.repoLoading')}</p>}
    {list.kind === 'error' && <div className="repo-note is-alert" role="alert">
      {t(ERROR_TEXT[list.code] ?? 'setup.repoError')}
      <button type="button" className="repo-link" onClick={() => { setStatus(current => current === 'ready' ? current : 'checking'); setReload(count => count + 1) }}>{t('setup.repoRetry')}</button>
    </div>}
    {data && data.repositories.length === 0 && <p className="repo-note">{search ? t('setup.repoNoMatch', { q: search }) : t('setup.repoEmpty')}</p>}
    {data && data.repositories.length > 0 && <ul className="repo-list" aria-label={t('setup.repoListAria')}>
      {data.repositories.map(repo => <li key={repo.repository_id}>
        <button type="button" aria-busy={pinning === repo.repository_id}
          className={'repo-item' + (pinning === repo.repository_id ? ' is-pinning' : '')}
          disabled={pinning !== null} onClick={() => void choose(repo)}>
          <strong>{repo.full_name}</strong>
          {repo.description && <span>{repo.description}</span>}
        </button>
      </li>)}
    </ul>}
    {pinning !== null && <p className="repo-note" role="status">{t('setup.repoPinning')}</p>}
    {pinError && <p className="repo-note is-alert" role="alert">{t(ERROR_TEXT[pinError] ?? 'setup.repoError')}</p>}
    {data?.truncated && <p className="migration-hint">{t('setup.repoTruncated')}</p>}
    {data && (data.page > 1 || data.has_next) && <div className="repo-pager">
      <button type="button" className="repo-link" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}>← {t('setup.repoPrev')}</button>
      <span>{t('setup.repoPage', { page: data.page })}</span>
      <button type="button" className="repo-link" disabled={!data.has_next} onClick={() => setPage(data.page + 1)}>{t('setup.repoNext')} →</button>
    </div>}
  </div>
}
