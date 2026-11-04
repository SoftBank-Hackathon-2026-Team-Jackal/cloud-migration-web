import { getToken } from 'next-auth/jwt'
import type { GithubJwt } from './authCallbacks'

/**
 * 요청 쿠키의 암호화된 세션 JWT를 서버에서 풀어 GitHub 토큰과 로그인 이름을 꺼낸다.
 * 이 값은 서버 안에서 GitHub 호출에만 쓰고 응답으로 내보내지 않는다.
 */
export async function githubSessionFrom(request: Request): Promise<{ token: string; login: string | null } | null> {
  const secret = process.env.AUTH_SECRET
  if (!secret) return null
  // Auth.js는 https 주소에서 __Secure- 접두사가 붙은 쿠키를 쓴다(로컬 http는 접두사 없음).
  const secureCookie = new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https'
  const jwt = await getToken({ req: request, secret, secureCookie }) as GithubJwt | null
  if (!jwt || typeof jwt.accessToken !== 'string') return null
  return { token: jwt.accessToken, login: typeof jwt.login === 'string' ? jwt.login : null }
}
