/**
 * Auth.js 콜백(순수 함수로 떼어 단위 테스트한다).
 * - GitHub 액세스 토큰은 암호화된 서버 쪽 JWT(쿠키)에만 둔다.
 * - 브라우저가 받는 세션(/api/auth/session)에는 토큰을 절대 넣지 않는다: 이름·아바타·로그인 이름·만료 시각만.
 */

/**
 * Auth.js가 GitHub OAuth App에 요청하는 권한. repo 권한은 요청하지 않는다(공개 저장소만 읽는다).
 * read:org는 조직 멤버십을 읽는 읽기 전용 권한이다. 없으면 /user/repos가 조직 멤버로서 접근하는 저장소를 빼서
 * 팀 조직의 공개 저장소가 목록에 나오지 않는다.
 */
export const GITHUB_SCOPE = 'read:user read:org'

/**
 * GitHub 로그인 화면에 넘기는 값. prompt=select_account는 GitHub 계정 선택 화면을 매번 띄운다.
 * 없으면 github.com에 로그인된 계정으로 확인 없이 바로 돌아와서, Sign out 뒤에도 다른 계정을 고를 수 없다.
 */
export const GITHUB_AUTH_PARAMS = { scope: GITHUB_SCOPE, prompt: 'select_account' } as const

export type GithubJwt = {
  accessToken?: string
  login?: string
  name?: string | null
  picture?: string | null
  [key: string]: unknown
}

export type ClientSession = {
  user: { name: string | null; image: string | null; login: string | null }
  expires: string
}

/** 로그인 직후(account가 있을 때) 토큰과 GitHub 로그인 이름을 JWT에 담는다. 그 밖에는 그대로 둔다. */
export function jwtCallback({ token, account, profile }: {
  token: GithubJwt
  account?: { provider?: string; access_token?: string } | null
  profile?: { login?: unknown } | null
}): GithubJwt {
  if (account?.provider === 'github' && typeof account.access_token === 'string') {
    return { ...token, accessToken: account.access_token, login: typeof profile?.login === 'string' ? profile.login : token.login }
  }
  return token
}

/** 브라우저로 나가는 세션: 허용한 필드만 새로 만들어 돌려준다(토큰·이메일 제외). */
export function sessionCallback({ session, token }: { session: { expires: string | Date }; token: GithubJwt }): ClientSession {
  const expires = session.expires instanceof Date ? session.expires.toISOString() : session.expires
  return {
    user: {
      name: typeof token.name === 'string' ? token.name : null,
      image: typeof token.picture === 'string' ? token.picture : null,
      login: typeof token.login === 'string' ? token.login : null,
    },
    expires,
  }
}

/** 서버 환경변수가 모두 있어야 GitHub 로그인을 쓸 수 있다. */
export function githubAuthConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.AUTH_GITHUB_ID && env.AUTH_GITHUB_SECRET && env.AUTH_SECRET)
}
