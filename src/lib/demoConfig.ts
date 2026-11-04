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

/** 시연용 ?review=1: 샌드박스 루프가 3회 실패해 사람 검토 대기 화면이 나온다. */
export function reviewDemo(): boolean {
  return flag('review', '1')
}

/** 시연용 ?digest=mismatch: 검증한 이미지가 빌드한 이미지와 달라 승인이 막힌다. */
export function digestMismatchDemo(): boolean {
  return flag('digest', 'mismatch')
}
