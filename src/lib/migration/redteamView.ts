import type { RedTeamData } from './events'

/**
 * 레드팀 화면의 숫자. 약점 수(found)와 고친 수(fixed)는 findings에서 센다: 약점이 1개든 4개든 그만큼 보인다.
 * 보안 수정 회차(n)는 "지금 진행 중인 회차"다. 백엔드의 첫 FIXING 이벤트는 회차를 올리기 전에 보내 round가 0이라,
 * 수정 중인데 0/3으로 보이지 않게 1부터 센다. 상한(max)을 넘기지 않는다.
 */
export function redteamProgress(data: Pick<RedTeamData, 'findings' | 'round' | 'max_rounds'>) {
  const found = data.findings.length
  const fixed = data.findings.filter(item => item.state === 'FIXED').length
  const max = Math.max(1, data.max_rounds)
  const n = Math.min(max, Math.max(1, data.round))
  return { found, fixed, n, max }
}
