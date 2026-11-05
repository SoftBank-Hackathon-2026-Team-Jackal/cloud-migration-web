/**
 * 시연용 설정. 주소에 ?aifix=4 를 붙이면 샌드박스에서 AI가 고치는 항목을 1~4개로 바꿔 볼 수 있다(기본 1개). 3개째부터는 한 검증 항목(기능 테스트·상태 확인) 안에 수정이 여러 개 들어간다.
 * 여러 개일 때의 화면(변경 내용은 수정마다 칩 하나, 검증 항목은 칩 하나에 개수, 요약·리포트는 총 개수)을 확인하려는 용도이며,
 * 실제 연결 후에는 백엔드가 알려 준 수정 목록으로 바뀐다.
 */
export function aiFixCount(): number {
  if (typeof window === 'undefined') return 1
  const value = Number(new URLSearchParams(window.location.search).get('aifix'))
  return Number.isInteger(value) && value >= 1 && value <= 4 ? value : 1
}

function flag(name: string, value: string) {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get(name) === value
}

export type SandboxScenario = 'pass' | 'spec' | 'code' | 'infra' | 'render'
/**
 * 시연용 ?sandbox=…: 샌드박스 루프의 결과를 고른다(기본 spec).
 *  pass 한 번에 통과 · spec 매핑(환경변수) 수정 후 재렌더로 통과 · code 코드 수정·재빌드 후 통과
 *  infra 환경 오류를 같은 입력으로 재시도해 통과 · render 변환기 오류로 중단(보고)
 */
export function sandboxScenario(): SandboxScenario {
  if (typeof window === 'undefined') return 'spec'
  const value = new URLSearchParams(window.location.search).get('sandbox')
  return value === 'pass' || value === 'code' || value === 'infra' || value === 'render' ? value : 'spec'
}

/** 시연용 ?review=1: 샌드박스 루프가 3회 실패해 사람 검토 대기 화면이 나온다. */
export function reviewDemo(): boolean {
  return flag('review', '1')
}

/** 시연용 ?digest=mismatch: 검증한 이미지가 빌드한 이미지와 달라 승인이 막힌다. */
export function digestMismatchDemo(): boolean {
  return flag('digest', 'mismatch')
}

export type PreflightDemo = 'pass' | 'route' | 'unknown'
/**
 * 시연용 ?preflight=…: 데이터 이전 전 네트워크 사전 검사 결과를 고른다(기본 pass).
 *  pass 통과 → 초기 복사·CDC 시작 · route 복제 경로가 터널 밖(ROUTE_NOT_TUNNEL)이라 시작 차단
 *  unknown DB 연결 사슬의 TLS를 확인할 수 없어(UNKNOWN) 시작 차단
 */
export function preflightScenario(): PreflightDemo {
  if (typeof window === 'undefined') return 'pass'
  const value = new URLSearchParams(window.location.search).get('preflight')
  return value === 'route' || value === 'unknown' ? value : 'pass'
}

/** 시연용 ?delivery=fail: 승인은 기록되지만 첫 전달이 실패한다(다시 전달하면 성공). */
export function deliveryFailDemo(): boolean {
  return flag('delivery', 'fail')
}

/** 시연용 ?analysis=items: 분석 결과를 예전 방식(발견 항목마다 한 건)으로 받는다. 기본은 백엔드 방식(스캔 Activity마다 개수 묶음). */
export function analysisItemsDemo(): boolean {
  return flag('analysis', 'items')
}
