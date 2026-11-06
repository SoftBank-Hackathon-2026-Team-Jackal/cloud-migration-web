import { githubSessionFrom } from '../github/token.ts'
import { decideAccess, parseAllowedLogins } from './access.ts'
import { crossOrigin, platformMode } from './server.ts'

const body = (status: number, detail: string) =>
  Response.json({ error: 'operator_key', detail }, { status, headers: { 'Cache-Control': 'no-store' } })

/**
 * 연결·Agent 관리 라우트의 입구. 다른 출처 요청을 막고(GET은 제외), 실제 API를 쓰는 서버에서는
 * 로그인한 GitHub 계정이 ADMIN_GITHUB_LOGINS(쉼표 구분)에 있을 때만 통과시킨다. 통과하면 null.
 * secretConfigured: 이 라우트가 운영자 키 말고도 다른 서버 비밀(승인자 토큰 등)을 쓰면 true. 그때는 목업 모드여도 로그인을 요구한다.
 */
export async function guard(request: Request, options: { secretConfigured?: boolean } = {}): Promise<Response | null> {
  if (request.method !== 'GET') {
    const cross = crossOrigin(request)
    if (cross) return cross
  }
  const session = await githubSessionFrom(request)
  const decision = decideAccess({
    mock: platformMode() === 'mock',
    hasAdminKey: Boolean((process.env.PLATFORM_ENROLLMENT_ADMIN_KEY ?? '').trim()) || options.secretConfigured === true,
    login: session?.login ?? null,
    allowed: parseAllowedLogins(process.env.ADMIN_GITHUB_LOGINS),
  })
  if (decision === 'login_required') return body(401, 'LOGIN_REQUIRED')
  if (decision === 'not_allowed') return body(403, 'NOT_ALLOWED')
  return null
}
