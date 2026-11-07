import NextAuth from 'next-auth'
import GitHub from 'next-auth/providers/github'
import { GITHUB_SCOPE, jwtCallback, sessionCallback, type GithubJwt } from './lib/github/authCallbacks'

/**
 * GitHub 로그인(Auth.js, GitHub OAuth App). 사용자 테이블·DB 없이 암호화된 JWT 쿠키 세션만 쓴다.
 * 서버 환경변수: AUTH_GITHUB_ID, AUTH_GITHUB_SECRET, AUTH_SECRET (README 참고). 모두 NEXT_PUBLIC_가 아니다.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub({ authorization: { params: { scope: GITHUB_SCOPE } } })],
  session: { strategy: 'jwt' },
  // Vercel·로컬 모두 요청 Host를 믿는다(AUTH_URL을 따로 두지 않아도 콜백 주소가 맞게 만들어진다).
  trustHost: true,
  callbacks: {
    jwt: ({ token, account, profile }) => jwtCallback({ token: token as GithubJwt, account, profile: profile as { login?: unknown } | undefined }),
    session: ({ session, token }) => sessionCallback({ session, token: token as GithubJwt }) as unknown as typeof session,
  },
})
