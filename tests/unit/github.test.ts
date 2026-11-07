import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listPublicRepos, pinPublicSource, GithubError } from '../../src/lib/github/repos.ts'
import { handleListRepos, handlePinSource, handleStatus, type HandlerDeps } from '../../src/lib/github/handlers.ts'
import { GITHUB_AUTH_PARAMS, GITHUB_SCOPE, jwtCallback, sessionCallback } from '../../src/lib/github/authCallbacks.ts'
import { startRequestFor } from '../../src/lib/migration/events.ts'
import { SseProvider, BACKEND_PENDING, SOURCE_REQUIRED } from '../../src/lib/migration/sseProvider.ts'
import type { Action } from '../../src/lib/migration/reducer.ts'

// 가짜 GitHub: 실제 네트워크 호출 없이 경로별로 응답을 돌려주고, 받은 요청을 기록한다.
const TOKEN = 'gho_secret_token_value'
const SHA = 'a'.repeat(40)
type Call = { url: URL; headers: Headers }

function repo(id: number, extra: Record<string, unknown> = {}) {
  return {
    id, full_name: 'octo/repo-' + id, name: 'repo-' + id, default_branch: 'main', description: 'desc ' + id,
    html_url: 'https://github.com/octo/repo-' + id, updated_at: '2026-01-0' + ((id % 9) + 1) + 'T00:00:00Z',
    private: false, visibility: 'public', owner: { login: 'octo', id: 1 }, permissions: { admin: true }, clone_url: 'x', ssh_url: 'y', size: 10,
    ...extra,
  }
}

function fakeGithub(routes: (url: URL) => Response): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, headers: new Headers(init?.headers) })
    return routes(url)
  }) as typeof fetch
  return { fetchImpl, calls }
}

const page = (list: unknown[], next = false) => Response.json(list, { headers: next ? { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } : {} })

test('공개 저장소만, 화면에 필요한 필드만 돌려준다', async () => {
  const { fetchImpl, calls } = fakeGithub(() => page([repo(1), repo(2, { private: true, visibility: 'private' }), repo(3, { visibility: 'internal' }), repo(4)], true))
  const result = await listPublicRepos({ token: TOKEN, fetchImpl, apiBase: 'https://gh.test' }, { page: 2, perPage: 10 })
  assert.deepEqual(result.repositories.map(item => item.repository_id), [1, 4])
  assert.deepEqual(Object.keys(result.repositories[0]).sort(), ['default_branch', 'description', 'full_name', 'html_url', 'repository_id', 'updated_at'])
  assert.equal(result.has_next, true)
  assert.equal(result.page, 2)
  // GitHub에도 공개 저장소만, 요청한 페이지로 묻고 토큰은 Authorization 헤더로만 보낸다.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.pathname, '/user/repos')
  assert.equal(calls[0].url.searchParams.get('visibility'), 'public')
  assert.equal(calls[0].url.searchParams.get('page'), '2')
  assert.equal(calls[0].url.searchParams.get('per_page'), '10')
  assert.equal(calls[0].headers.get('authorization'), 'Bearer ' + TOKEN)
  assert.ok(!JSON.stringify(result).includes(TOKEN))
})

test('페이지·개수 값은 안전한 범위로 고친다', async () => {
  const { fetchImpl, calls } = fakeGithub(() => page([]))
  const result = await listPublicRepos({ token: TOKEN, fetchImpl, apiBase: 'https://gh.test' }, { page: '-3', perPage: '9999' })
  assert.equal(result.page, 1)
  assert.equal(calls[0].url.searchParams.get('per_page'), '50')
  assert.equal(result.has_next, false)
})

test('검색어는 여러 GitHub 페이지를 훑어 이름·설명으로 거르고 다시 나눈다', async () => {
  const pages: Record<string, unknown[]> = {
    1: [repo(1, { full_name: 'octo/alpha' }), repo(2, { full_name: 'octo/Alpha-two', private: true, visibility: 'private' }), repo(3, { full_name: 'octo/beta' })],
    2: [repo(4, { full_name: 'octo/gamma', description: 'ALPHA inside' }), repo(5, { full_name: 'octo/alpha-3' })],
  }
  const { fetchImpl, calls } = fakeGithub(url => page(pages[url.searchParams.get('page') ?? '1'] ?? [], url.searchParams.get('page') === '1'))
  const first = await listPublicRepos({ token: TOKEN, fetchImpl, apiBase: 'https://gh.test' }, { q: ' Alpha ', perPage: 2 })
  assert.deepEqual(first.repositories.map(item => item.full_name), ['octo/alpha', 'octo/gamma'])
  assert.equal(first.has_next, true)
  assert.equal(first.truncated, false)
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.url.searchParams.get('per_page') === '100'))
  const second = await listPublicRepos({ token: TOKEN, fetchImpl, apiBase: 'https://gh.test' }, { q: 'alpha', perPage: 2, page: 2 })
  assert.deepEqual(second.repositories.map(item => item.full_name), ['octo/alpha-3'])
  assert.equal(second.has_next, false)
})

test('GitHub 401은 auth_expired, 한도 초과는 rate_limited, 그 밖은 github_error', async () => {
  const deps = (response: Response) => ({ token: TOKEN, fetchImpl: fakeGithub(() => response).fetchImpl, apiBase: 'https://gh.test' })
  await assert.rejects(listPublicRepos(deps(new Response('', { status: 401 }))), (error: GithubError) => error.code === 'auth_expired' && error.status === 401)
  await assert.rejects(listPublicRepos(deps(new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }))), (error: GithubError) => error.code === 'rate_limited')
  await assert.rejects(listPublicRepos(deps(new Response('', { status: 500 }))), (error: GithubError) => error.code === 'github_error' && error.status === 502)
})

test('고른 저장소를 id로 다시 확인하고 기본 브랜치 커밋 SHA를 고정한다', async () => {
  const { fetchImpl, calls } = fakeGithub(url => {
    if (url.pathname === '/repositories/42') return Response.json(repo(42, { full_name: 'octo/real', default_branch: 'trunk' }))
    if (url.pathname === '/repos/octo/real/commits/trunk') return new Response(SHA + '\n')
    return new Response('', { status: 404 })
  })
  const pinned = await pinPublicSource({ token: TOKEN, fetchImpl, apiBase: 'https://gh.test' }, 42)
  assert.deepEqual(pinned, { kind: 'GITHUB_PUBLIC', repository_id: 42, full_name: 'octo/real', default_branch: 'trunk', commit_sha: SHA })
  assert.equal(calls[1].headers.get('accept'), 'application/vnd.github.sha')
})

test('비공개 저장소나 이상한 SHA는 고정하지 않는다', async () => {
  const privateRepo = fakeGithub(() => Response.json(repo(7, { private: true, visibility: 'private' })))
  await assert.rejects(pinPublicSource({ token: TOKEN, fetchImpl: privateRepo.fetchImpl, apiBase: 'https://gh.test' }, 7), (error: GithubError) => error.code === 'not_public')
  assert.equal(privateRepo.calls.length, 1, '비공개면 커밋을 조회하지 않는다')
  const badSha = fakeGithub(url => url.pathname.startsWith('/repositories') ? Response.json(repo(8)) : new Response('not-a-sha'))
  await assert.rejects(pinPublicSource({ token: TOKEN, fetchImpl: badSha.fetchImpl, apiBase: 'https://gh.test' }, 8), (error: GithubError) => error.code === 'github_error')
  await assert.rejects(pinPublicSource({ token: TOKEN, fetchImpl: badSha.fetchImpl, apiBase: 'https://gh.test' }, 'x'), (error: GithubError) => error.status === 400)
})

const ENV = { AUTH_GITHUB_ID: 'id', AUTH_GITHUB_SECRET: 'secret', AUTH_SECRET: 'auth-secret' }
const signedIn = async () => ({ token: TOKEN, login: 'octo' })

test('API 라우트: 설정 없음 503, 로그인 안 함 401, 토큰 만료 401 auth_expired', async () => {
  const request = new Request('http://localhost/api/github/repos')
  const notConfigured = await handleListRepos(request, { getSession: signedIn, env: {} })
  assert.equal(notConfigured.status, 503)
  assert.deepEqual(await notConfigured.json(), { error: 'auth_not_configured' })
  const anonymous = await handleListRepos(request, { getSession: async () => null, env: ENV })
  assert.equal(anonymous.status, 401)
  assert.deepEqual(await anonymous.json(), { error: 'not_signed_in' })
  const expired = await handleListRepos(request, { getSession: signedIn, env: ENV, fetchImpl: fakeGithub(() => new Response('', { status: 401 })).fetchImpl, apiBase: 'https://gh.test' })
  assert.equal(expired.status, 401)
  assert.deepEqual(await expired.json(), { error: 'auth_expired' })
})

test('API 라우트: 상태 확인은 로그인 전·설정 없음도 200으로 답하고 토큰을 싣지 않는다', async () => {
  const request = new Request('http://localhost/api/github/status')
  assert.deepEqual(await (await handleStatus(request, { getSession: signedIn, env: {} })).json(), { configured: false, signed_in: false, viewer: null })
  assert.deepEqual(await (await handleStatus(request, { getSession: async () => null, env: ENV })).json(), { configured: true, signed_in: false, viewer: null })
  const ok = await handleStatus(request, { getSession: signedIn, env: ENV })
  assert.equal(ok.status, 200)
  const text = await ok.text()
  assert.ok(!text.includes(TOKEN))
  assert.deepEqual(JSON.parse(text), { configured: true, signed_in: true, viewer: 'octo' })
})

test('API 라우트: 응답에 토큰이 없고 쿼리를 GitHub 호출로 넘긴다', async () => {
  const { fetchImpl, calls } = fakeGithub(() => page([repo(1), repo(2, { private: true })]))
  const deps: HandlerDeps = { getSession: signedIn, env: ENV, fetchImpl, apiBase: 'https://gh.test' }
  const response = await handleListRepos(new Request('http://localhost/api/github/repos?page=3&per_page=5'), deps)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const text = await response.text()
  assert.ok(!text.includes(TOKEN))
  const body = JSON.parse(text)
  assert.equal(body.viewer, 'octo')
  assert.deepEqual(body.repositories.map((item: { repository_id: number }) => item.repository_id), [1])
  assert.equal(calls[0].url.searchParams.get('page'), '3')
  assert.equal(calls[0].url.searchParams.get('per_page'), '5')
})

test('API 라우트: 소스 고정은 숫자 repository_id만 받는다', async () => {
  const { fetchImpl } = fakeGithub(url => url.pathname === '/repositories/9' ? Response.json(repo(9)) : new Response(SHA))
  const deps: HandlerDeps = { getSession: signedIn, env: ENV, fetchImpl, apiBase: 'https://gh.test' }
  const post = (body: string) => handlePinSource(new Request('http://localhost/api/github/source', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } }), deps)
  assert.equal((await post('{"repository_id":"9"}')).status, 400)
  assert.equal((await post('nope')).status, 400)
  const ok = await post('{"repository_id":9,"full_name":"evil/override"}')
  assert.equal(ok.status, 200)
  const text = await ok.text()
  assert.ok(!text.includes(TOKEN))
  assert.deepEqual(JSON.parse(text), { kind: 'GITHUB_PUBLIC', repository_id: 9, full_name: 'octo/repo-9', default_branch: 'main', commit_sha: SHA })
})

test('세션: 토큰은 JWT에만 있고 브라우저로 가는 세션에는 없다', () => {
  assert.equal(GITHUB_SCOPE.includes('repo'), false, 'repo 권한을 요청하지 않는다')
  const jwt = jwtCallback({ token: { name: 'Octo', picture: 'https://avatars/x', email: 'o@example.com' }, account: { provider: 'github', access_token: TOKEN }, profile: { login: 'octo' } })
  assert.equal(jwt.accessToken, TOKEN)
  assert.equal(jwt.login, 'octo')
  // 뒤이은 요청(account 없음)에서도 그대로 남는다.
  assert.equal(jwtCallback({ token: jwt }).accessToken, TOKEN)
  const session = sessionCallback({ session: { expires: '2026-12-01T00:00:00.000Z' }, token: jwt })
  assert.deepEqual(session, { user: { name: 'Octo', image: 'https://avatars/x', login: 'octo' }, expires: '2026-12-01T00:00:00.000Z' })
  assert.ok(!JSON.stringify(session).includes(TOKEN))
})

test('시작 요청: 고른 저장소를 source로 싣고 화면용 필드는 뺀다', () => {
  const source = { kind: 'GITHUB_PUBLIC' as const, repository_id: 42, full_name: 'octo/real', commit_sha: SHA }
  const request = startRequestFor('gcp', { source: { ...source, default_branch: 'main' } as typeof source })
  assert.deepEqual(request.source, source)
  assert.equal(startRequestFor('gcp').source, undefined)
})

// SSE 공급자: fetch를 가로채 POST /migrations가 나가는지 본다.
function sseHarness(startMode: 'wait' | 'source' | 'legacy') {
  const actions: Action[] = []
  const posts: Array<{ url: string; body: unknown }> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    posts.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return Response.json({ id: 'm-1' })
  }) as typeof fetch
  const provider = new SseProvider({ dispatch: action => actions.push(action) }, { baseUrl: 'http://backend.test', startMode })
  return { provider, actions, posts, restore: () => { provider.dispose(); globalThis.fetch = original } }
}
const failCode = (actions: Action[]) => actions.flatMap(action => action.type === 'fail' ? [action.error.code] : [])
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

test('SSE wait(#60 전): 설정에서 시작해도, 주소로 단계를 열어도 POST /migrations를 부르지 않는다', async () => {
  const { provider, actions, posts, restore } = sseHarness('wait')
  try {
    provider.start(startRequestFor('gcp', { source: { kind: 'GITHUB_PUBLIC', repository_id: 1, full_name: 'o/r', commit_sha: SHA } }))
    provider.enter('analysis', { target: 'gcp' })
    await settle()
    assert.equal(posts.length, 0)
    assert.deepEqual(failCode(actions), [BACKEND_PENDING, BACKEND_PENDING])
  } finally { restore() }
})

test('SSE source(#60 후): source 없으면 시작하지 않고, 있으면 그대로 보낸다', async () => {
  const { provider, actions, posts, restore } = sseHarness('source')
  try {
    provider.enter('analysis', { target: 'gcp' })
    provider.start(startRequestFor('gcp'))
    await settle()
    assert.equal(posts.length, 0)
    assert.deepEqual(failCode(actions), [SOURCE_REQUIRED, SOURCE_REQUIRED])
    const source = { kind: 'GITHUB_PUBLIC' as const, repository_id: 1, full_name: 'o/r', commit_sha: SHA }
    provider.start(startRequestFor('gcp', { source }))
    await settle()
    const created = posts.find(post => post.url === 'http://backend.test/migrations')
    assert.ok(created)
    assert.deepEqual((created.body as { source: unknown }).source, source)
    assert.ok(!JSON.stringify(created.body).includes('env_file_ref'))
  } finally { restore() }
})

test('SSE legacy(목업 서버 시험): 예전처럼 주소로 연 단계에서 시작한다', async () => {
  const { provider, posts, restore } = sseHarness('legacy')
  try {
    provider.enter('analysis', { target: 'gcp' })
    await settle()
    assert.equal(posts[0]?.url, 'http://backend.test/migrations')
  } finally { restore() }
})

test('GitHub 로그인은 매번 계정 선택 화면을 띄운다', () => {
  assert.equal(GITHUB_AUTH_PARAMS.prompt, 'select_account')
  assert.equal(GITHUB_AUTH_PARAMS.scope, GITHUB_SCOPE)
})
