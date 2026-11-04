import { githubAuthConfigured } from './authCallbacks.ts'
import { GithubError, listPublicRepos, pinPublicSource } from './repos.ts'

/**
 * /api/github/* 라우트의 본체. 세션 읽기와 fetch를 주입받아 단위 테스트에서 가짜 GitHub로 시험한다.
 * 응답에는 화면에 필요한 필드만 담고 GitHub 토큰은 절대 넣지 않는다.
 */
export type GithubSession = { token: string; login: string | null }
export type HandlerDeps = {
  getSession: (request: Request) => Promise<GithubSession | null>
  fetchImpl?: typeof fetch
  apiBase?: string
  env?: Record<string, string | undefined>
}

export type ApiErrorCode = 'auth_not_configured' | 'not_signed_in' | 'auth_expired' | 'not_found' | 'not_public' | 'rate_limited' | 'github_error' | 'bad_request'

const json = (status: number, body: object) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const fail = (status: number, error: ApiErrorCode) => json(status, { error })

async function session(request: Request, deps: HandlerDeps): Promise<GithubSession | Response> {
  if (!githubAuthConfigured(deps.env)) return fail(503, 'auth_not_configured')
  const found = await deps.getSession(request).catch(() => null)
  return found ?? fail(401, 'not_signed_in')
}

function fromError(error: unknown): Response {
  if (error instanceof GithubError) return fail(error.status, error.code)
  return fail(502, 'github_error')
}

/**
 * GET /api/github/status → {configured, signed_in, viewer}. 화면이 목록을 부르기 전에 확인한다.
 * 로그인 전·설정 없음은 오류가 아니라 정상 상태라 200으로 답한다(브라우저 콘솔에 오류가 남지 않게).
 */
export async function handleStatus(request: Request, deps: HandlerDeps): Promise<Response> {
  if (!githubAuthConfigured(deps.env)) return json(200, { configured: false, signed_in: false, viewer: null })
  const found = await deps.getSession(request).catch(() => null)
  return json(200, { configured: true, signed_in: Boolean(found), viewer: found?.login ?? null })
}

/** GET /api/github/repos?page=&per_page=&q= */
export async function handleListRepos(request: Request, deps: HandlerDeps): Promise<Response> {
  const current = await session(request, deps)
  if (current instanceof Response) return current
  const params = new URL(request.url).searchParams
  try {
    const page = await listPublicRepos({ token: current.token, fetchImpl: deps.fetchImpl, apiBase: deps.apiBase },
      { page: params.get('page'), perPage: params.get('per_page'), q: params.get('q') ?? '' })
    return json(200, { viewer: current.login, ...page })
  } catch (error) {
    return fromError(error)
  }
}

/** POST /api/github/source {repository_id} → 기본 브랜치 커밋 SHA를 고정한 소스 */
export async function handlePinSource(request: Request, deps: HandlerDeps): Promise<Response> {
  const current = await session(request, deps)
  if (current instanceof Response) return current
  let body: { repository_id?: unknown }
  try { body = await request.json() as { repository_id?: unknown } } catch { return fail(400, 'bad_request') }
  if (typeof body?.repository_id !== 'number') return fail(400, 'bad_request')
  try {
    return json(200, await pinPublicSource({ token: current.token, fetchImpl: deps.fetchImpl, apiBase: deps.apiBase }, body.repository_id))
  } catch (error) {
    return fromError(error)
  }
}
