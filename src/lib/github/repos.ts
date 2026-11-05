/**
 * GitHub REST 호출(서버 전용). 액세스 토큰은 인자로만 받고 돌려주는 값에는 절대 넣지 않는다.
 * fetch와 API 주소를 바꿔 끼울 수 있어서 단위 테스트에서 가짜 GitHub로 시험한다(실제 네트워크 호출 없음).
 * 이 파일은 단위 테스트(node --test)가 직접 읽으므로 '@/' 별칭이나 Next 전용 모듈을 쓰지 않는다.
 */

/** 화면에 내보내는 저장소 정보. 화면이 쓰는 필드만 담는다. */
export type RepoSummary = {
  repository_id: number
  full_name: string
  default_branch: string
  description: string | null
  html_url: string
  updated_at: string | null
}

export type RepoPage = {
  repositories: RepoSummary[]
  page: number
  per_page: number
  has_next: boolean
  /** 검색어가 있을 때 훑어본 GitHub 페이지 수가 상한에 닿아 결과가 일부만일 수 있다. */
  truncated: boolean
}

/** 실행 시작 요청에 넣는 고정된 소스(기본 브랜치의 커밋 SHA를 박아 둔다). */
export type PinnedSource = {
  kind: 'GITHUB_PUBLIC'
  repository_id: number
  full_name: string
  default_branch: string
  commit_sha: string
}

export type GithubDeps = {
  token: string
  fetchImpl?: typeof fetch
  /** 기본 https://api.github.com (시험용으로 바꾼다) */
  apiBase?: string
}

/** GitHub 호출 실패. status 401은 토큰 만료·폐기(다시 로그인), 그 밖은 GitHub 오류다. */
export class GithubError extends Error {
  readonly status: number
  readonly code: 'auth_expired' | 'not_found' | 'not_public' | 'rate_limited' | 'github_error'
  constructor(status: number, code: GithubError['code'], message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const DEFAULT_PER_PAGE = 20
export const MAX_PER_PAGE = 50
/** 검색할 때 서버가 훑는 GitHub 페이지 상한(100개씩) */
export const SEARCH_MAX_PAGES = 5
const SHA = /^[0-9a-f]{40}$/

type RawRepo = {
  id?: unknown
  full_name?: unknown
  default_branch?: unknown
  description?: unknown
  html_url?: unknown
  updated_at?: unknown
  private?: unknown
  visibility?: unknown
}

function base(deps: GithubDeps) {
  return (deps.apiBase || process.env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/, '')
}

async function call(deps: GithubDeps, path: string, accept = 'application/vnd.github+json'): Promise<Response> {
  const response = await (deps.fetchImpl ?? fetch)(base(deps) + path, {
    headers: {
      Accept: accept,
      Authorization: 'Bearer ' + deps.token,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cloud-migration-web',
    },
    cache: 'no-store',
  })
  if (response.ok) return response
  if (response.status === 401) throw new GithubError(401, 'auth_expired', 'GitHub authorization expired')
  if (response.status === 404) throw new GithubError(404, 'not_found', 'GitHub resource not found')
  if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
    throw new GithubError(429, 'rate_limited', 'GitHub API rate limit exceeded')
  }
  throw new GithubError(502, 'github_error', 'GitHub API responded ' + response.status)
}

/** 공개 저장소인지: private가 정확히 false이고 visibility가 있으면 public이어야 한다. */
export function isPublicRepo(raw: RawRepo): boolean {
  return raw.private === false && (raw.visibility === undefined || raw.visibility === 'public')
}

/** GitHub 응답의 저장소 하나를 화면용 필드로 줄인다. 형식이 맞지 않으면 null. */
export function toSummary(raw: RawRepo): RepoSummary | null {
  if (typeof raw.id !== 'number' || typeof raw.full_name !== 'string' || typeof raw.default_branch !== 'string') return null
  return {
    repository_id: raw.id,
    full_name: raw.full_name,
    default_branch: raw.default_branch,
    description: typeof raw.description === 'string' ? raw.description : null,
    html_url: typeof raw.html_url === 'string' ? raw.html_url : 'https://github.com/' + raw.full_name,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : null,
  }
}

function publicSummaries(list: unknown): RepoSummary[] {
  if (!Array.isArray(list)) throw new GithubError(502, 'github_error', 'unexpected GitHub response')
  return (list as RawRepo[]).filter(isPublicRepo).map(toSummary).filter((item): item is RepoSummary => item !== null)
}

const hasNextLink = (response: Response) => /<[^>]+>;\s*rel="next"/.test(response.headers.get('link') ?? '')

function reposPath(page: number, perPage: number) {
  // visibility=public: GitHub에 공개 저장소만 달라고 하고, 받은 뒤에도 한 번 더 거른다.
  return '/user/repos?visibility=public&affiliation=owner,collaborator,organization_member&sort=updated&per_page=' + perPage + '&page=' + page
}

export function clampPage(value: unknown): number {
  const page = Math.floor(Number(value))
  return Number.isFinite(page) && page >= 1 ? Math.min(page, 1000) : 1
}

export function clampPerPage(value: unknown): number {
  const perPage = Math.floor(Number(value))
  return Number.isFinite(perPage) && perPage >= 1 ? Math.min(perPage, MAX_PER_PAGE) : DEFAULT_PER_PAGE
}

/**
 * 로그인한 계정이 접근할 수 있는 공개 저장소 목록(GET /user/repos)을 페이지 단위로 돌려준다.
 * 검색어(q)가 없으면 GitHub의 페이지를 그대로 넘긴다. 검색어가 있으면 GitHub가 이름 검색을 지원하지 않으므로
 * 최근 갱신 순으로 SEARCH_MAX_PAGES 페이지까지 훑어 이름·설명으로 거른 뒤 그 결과를 나눠 준다.
 */
export async function listPublicRepos(deps: GithubDeps, options: { page?: unknown; perPage?: unknown; q?: unknown } = {}): Promise<RepoPage> {
  const page = clampPage(options.page)
  const perPage = clampPerPage(options.perPage)
  const q = typeof options.q === 'string' ? options.q.trim().toLowerCase().slice(0, 100) : ''

  if (!q) {
    const response = await call(deps, reposPath(page, perPage))
    return { repositories: publicSummaries(await response.json()), page, per_page: perPage, has_next: hasNextLink(response), truncated: false }
  }

  const matches: RepoSummary[] = []
  let truncated = false
  for (let githubPage = 1; githubPage <= SEARCH_MAX_PAGES; githubPage += 1) {
    const response = await call(deps, reposPath(githubPage, 100))
    for (const repo of publicSummaries(await response.json())) {
      if (repo.full_name.toLowerCase().includes(q) || (repo.description ?? '').toLowerCase().includes(q)) matches.push(repo)
    }
    if (!hasNextLink(response)) break
    if (githubPage === SEARCH_MAX_PAGES) truncated = true
  }
  const start = (page - 1) * perPage
  return { repositories: matches.slice(start, start + perPage), page, per_page: perPage, has_next: start + perPage < matches.length, truncated }
}

/**
 * 고른 저장소를 id로 다시 조회해 공개 저장소인지 확인하고, 기본 브랜치의 지금 커밋 SHA를 고정해 돌려준다.
 * 화면이 보낸 이름·브랜치는 믿지 않고 GitHub가 준 값만 쓴다.
 */
export async function pinPublicSource(deps: GithubDeps, repositoryId: unknown): Promise<PinnedSource> {
  const id = Number(repositoryId)
  if (!Number.isSafeInteger(id) || id <= 0) throw new GithubError(400, 'not_found', 'invalid repository_id')
  const raw = await (await call(deps, '/repositories/' + id)).json() as RawRepo
  if (!isPublicRepo(raw)) throw new GithubError(403, 'not_public', 'repository is not public')
  const repo = toSummary(raw)
  if (!repo) throw new GithubError(502, 'github_error', 'unexpected GitHub response')
  const [owner, name] = repo.full_name.split('/')
  const response = await call(deps,
    '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) + '/commits/' + encodeURIComponent(repo.default_branch),
    'application/vnd.github.sha')
  const sha = (await response.text()).trim()
  if (!SHA.test(sha)) throw new GithubError(502, 'github_error', 'unexpected commit SHA')
  return { kind: 'GITHUB_PUBLIC', repository_id: repo.repository_id, full_name: repo.full_name, default_branch: repo.default_branch, commit_sha: sha }
}
