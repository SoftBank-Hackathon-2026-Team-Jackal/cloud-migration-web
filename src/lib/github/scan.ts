/**
 * 고른 공개 저장소의 "구성"만 읽는다(서버 전용, 이 앱의 Next 서버에서만 돈다).
 * 파일 목록과 몇몇 구성 파일(package.json·requirements.txt·go.mod·.env.example 등)을 읽어 탐지 결과만 화면에 돌려준다.
 * 소스 코드 원문은 화면으로도, 플랫폼 API로도 보내지 않는다. .env.example에서는 키 이름만 꺼낸다.
 * 이 파일은 단위 테스트(node --test)가 직접 읽으므로 '@/' 별칭이나 Next 전용 모듈을 쓰지 않는다.
 */
import { GithubError, type GithubDeps } from './repos.ts'

export type Detection =
  | { kind: 'runtime'; name: string; evidence: string }
  | { kind: 'dockerfile'; evidence: string; stages: number }
  | { kind: 'k8s'; count: number; evidence: string }
  | { kind: 'postgres'; evidence: string }
  | { kind: 'env'; count: number; evidence: string }

export type RepoScan = {
  /** 화면에 흘려 보여 줄 파일 목록(경로, 디렉터리는 '/'로 끝난다). 상한 TREE_LIMIT */
  tree: string[]
  detections: Detection[]
  /** 코드가 읽는 환경 변수 키 이름(값 없음) */
  env_keys: string[]
  /** 파일 목록이 상한에 닿았는지 */
  truncated: boolean
}

export const TREE_LIMIT = 40
const MANIFEST = /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|Gemfile|\.env\.example|\.env\.sample|\.env\.template|Dockerfile[^/]*)$/
const K8S = /(^|\/)(k8s|kubernetes|manifests|deploy|charts?|helm)\/.*\.ya?ml$/i
const ENV_KEY = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/

/** 화면에 보일 순서: 얕은 경로·구성 파일 먼저, 나머지는 사전순 */
export function displayTree(paths: string[], limit = TREE_LIMIT): { tree: string[]; truncated: boolean } {
  const score = (path: string) => (MANIFEST.test(path) || K8S.test(path) ? 0 : 1) * 10 + Math.min(path.split('/').length, 9)
  const sorted = [...paths].filter(path => !/(^|\/)(node_modules|\.git|vendor|dist|build)\//.test(path))
    .sort((a, b) => score(a) - score(b) || a.localeCompare(b))
  const picked = sorted.slice(0, limit).sort((a, b) => a.localeCompare(b))
  return { tree: picked, truncated: sorted.length > limit }
}

/** 파일 목록과 구성 파일 내용에서 탐지한다. 내용은 이 함수 안에서만 쓰고 돌려주지 않는다. */
export function detectStack(paths: string[], files: Record<string, string>): Omit<RepoScan, 'tree' | 'truncated'> {
  const detections: Detection[] = []
  const has = (name: string) => paths.find(path => path === name || path.endsWith('/' + name))
  const read = (name: string) => { const path = has(name); return path ? files[path] ?? '' : '' }

  const pkg = read('package.json')
  let deps: Record<string, string> = {}
  let engine = ''
  if (pkg) {
    try {
      const json = JSON.parse(pkg) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; engines?: { node?: string } }
      deps = { ...json.dependencies, ...json.devDependencies }
      engine = (json.engines?.node ?? '').match(/\d+/)?.[0] ?? ''
    } catch { /* 깨진 package.json은 이름만으로 판단 */ }
    const ts = Boolean(deps.typescript || has('tsconfig.json'))
    detections.push({ kind: 'runtime', name: 'Node.js' + (engine ? ' ' + engine : '') + (ts ? ' · TypeScript' : ''), evidence: has('package.json')! })
  } else if (has('go.mod')) {
    const version = read('go.mod').match(/^go\s+(\d+\.\d+)/m)?.[1]
    detections.push({ kind: 'runtime', name: 'Go' + (version ? ' ' + version : ''), evidence: has('go.mod')! })
  }
  else if (has('requirements.txt') || has('pyproject.toml')) detections.push({ kind: 'runtime', name: 'Python', evidence: (has('pyproject.toml') || has('requirements.txt'))! })
  else if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) detections.push({ kind: 'runtime', name: 'Java', evidence: (has('pom.xml') || has('build.gradle') || has('build.gradle.kts'))! })

  const dockerfile = paths.find(path => /(^|\/)Dockerfile$/.test(path))
  if (dockerfile) detections.push({ kind: 'dockerfile', evidence: dockerfile, stages: Math.max(1, (files[dockerfile]?.match(/^\s*FROM\s/gim) ?? []).length) })

  const manifests = paths.filter(path => K8S.test(path))
  if (manifests.length) detections.push({ kind: 'k8s', count: manifests.length, evidence: manifests[0].split('/').slice(0, -1).join('/') + '/' })

  const deps_text = Object.keys(deps).join(' ') + ' ' + read('requirements.txt') + ' ' + read('pyproject.toml') + ' ' + read('go.mod') + ' ' + read('pom.xml')
  const pg = /(^|[\s"'/])(pg|postgres|pg-promise|psycopg2?(-binary)?|asyncpg|jackc\/pgx|lib\/pq|postgresql|typeorm|@prisma\/client)(\s|$|["'@=<>~^/])/i.exec(deps_text)
  const sqlMigration = paths.find(path => /(^|\/)(migrations?|db)\/.*\.sql$/.test(path))
  if (pg) detections.push({ kind: 'postgres', evidence: pg[2] })
  else if (sqlMigration) detections.push({ kind: 'postgres', evidence: sqlMigration })

  const envFile = paths.find(path => /(^|\/)\.env\.(example|sample|template)$/.test(path))
  const env_keys = envFile ? [...new Set((files[envFile] ?? '').split(/\r?\n/).map(line => ENV_KEY.exec(line)?.[1]).filter((key): key is string => Boolean(key)))] : []
  if (env_keys.length) detections.push({ kind: 'env', count: env_keys.length, evidence: envFile! })
  return { detections, env_keys }
}

type TreeEntry = { path?: unknown; type?: unknown; size?: unknown }

/** 커밋 SHA로 고정한 공개 저장소의 트리와 구성 파일을 읽어 탐지한다. */
export async function scanPublicSource(deps: GithubDeps, fullName: unknown, commitSha: unknown): Promise<RepoScan> {
  if (typeof fullName !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw new GithubError(400, 'not_found', 'invalid full_name')
  if (typeof commitSha !== 'string' || !/^[0-9a-f]{40}$/.test(commitSha)) throw new GithubError(400, 'not_found', 'invalid commit_sha')
  const base = (deps.apiBase || process.env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/, '')
  const get = async (path: string, accept = 'application/vnd.github+json') => {
    const response = await (deps.fetchImpl ?? fetch)(base + path, {
      headers: { Accept: accept, Authorization: 'Bearer ' + deps.token, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'cloud-migration-web' },
      cache: 'no-store',
    })
    if (response.ok) return response
    if (response.status === 401) throw new GithubError(401, 'auth_expired', 'GitHub authorization expired')
    if (response.status === 404) throw new GithubError(404, 'not_found', 'GitHub resource not found')
    if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') throw new GithubError(429, 'rate_limited', 'rate limited')
    throw new GithubError(502, 'github_error', 'GitHub API responded ' + response.status)
  }
  const repoPath = '/repos/' + fullName.split('/').map(encodeURIComponent).join('/')
  const body = await (await get(repoPath + '/git/trees/' + commitSha + '?recursive=1')).json() as { tree?: TreeEntry[]; truncated?: boolean }
  const entries = (body.tree ?? []).filter(entry => typeof entry.path === 'string')
  const paths = entries.map(entry => (entry.path as string) + (entry.type === 'tree' ? '/' : ''))
  const filePaths = paths.filter(path => !path.endsWith('/'))
  // 구성 파일만, 작은 것만(64KB), 최대 8개 읽는다.
  const wanted = entries.filter(entry => entry.type === 'blob' && MANIFEST.test(entry.path as string) && (typeof entry.size !== 'number' || entry.size < 65536)).slice(0, 8)
  const files: Record<string, string> = {}
  await Promise.all(wanted.map(async entry => {
    const path = entry.path as string
    try { files[path] = await (await get(repoPath + '/contents/' + path.split('/').map(encodeURIComponent).join('/') + '?ref=' + commitSha, 'application/vnd.github.raw')).text() }
    catch (error) { if (error instanceof GithubError && error.status === 401) throw error }
  }))
  const shown = displayTree(paths)
  return { ...shown, truncated: shown.truncated || Boolean(body.truncated), ...detectStack(filePaths, files) }
}
