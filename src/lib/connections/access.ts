/**
 * 연결·Agent 관리 API(/api/connections, /api/agents)를 누가 쓸 수 있는지.
 * 웹 서버가 플랫폼 운영자 키를 갖고 있으면 이 API는 곧 운영자 권한이라, 로그인한 허용 GitHub 계정만 통과시킨다.
 * 목업 모드이고 운영자 키가 없으면(가짜 데이터만 답한다) 로그인 없이도 연다.
 */
export type AccessDecision = 'allow' | 'login_required' | 'not_allowed'

export function parseAllowedLogins(value: string | undefined): string[] {
  return (value ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean)
}

export function decideAccess(input: { mock: boolean; hasAdminKey: boolean; login: string | null; allowed: string[] }): AccessDecision {
  if (input.mock && !input.hasAdminKey) return 'allow'
  if (!input.login) return 'login_required'
  // 허용 목록이 비어 있으면 아무도 통과하지 못한다(설정하기 전에는 닫혀 있다).
  return input.allowed.includes(input.login.toLowerCase()) ? 'allow' : 'not_allowed'
}
