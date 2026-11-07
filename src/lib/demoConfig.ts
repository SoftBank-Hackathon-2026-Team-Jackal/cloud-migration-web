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

export type CutoverDemo = 'fast' | 'classic' | 'kill' | 'tamper' | 'tamper-classic'
export const CUTOVER_DEMOS: readonly CutoverDemo[] = ['fast', 'classic', 'kill', 'tamper', 'tamper-classic']
/**
 * 시연용 ?cutover=…: DB 전환 방식과 장애를 고른다(기본 fast) [가정]. 백엔드 PoC(poc/cdc · poc/demo)의 fault와 같다.
 *  fast 빠른 전환(체크섬은 RESUME 뒤) 통과 · classic PAUSE 안에서 체크섬까지 하는 전환 통과
 *  kill 전환 중 대상 DB가 죽어 거부 → 원본 DB로 RESUME(다시 시도하면 fast로 통과)
 *  tamper fast에서 대상이 변조됨: 전환은 되고, 뒤의 검증이 불일치를 알린다
 *  tamper-classic classic에서 대상이 변조됨: PAUSE 안 체크섬이 막아 거부(다시 시도하면 통과)
 */
export function cutoverScenario(): CutoverDemo {
  if (typeof window === 'undefined') return 'fast'
  const value = new URLSearchParams(window.location.search).get('cutover') as CutoverDemo | null
  return value && CUTOVER_DEMOS.includes(value) ? value : 'fast'
}

/** 시연용 ?delivery=fail: 승인은 기록되지만 첫 전달이 실패한다(다시 전달하면 성공). */
export function deliveryFailDemo(): boolean {
  return flag('delivery', 'fail')
}

/** 시연용 ?analysis=items: 분석 결과를 예전 방식(발견 항목마다 한 건)으로 받는다. 기본은 백엔드 방식(스캔 Activity마다 개수 묶음). */
export function analysisItemsDemo(): boolean {
  return flag('analysis', 'items')
}

/**
 * 시험용 ?speed=N(1–20): 목업 대본·트래픽 모의의 시계를 N배 빠르게 돌린다(화면 애니메이션은 그대로).
 * e2e가 실제 시간만큼 기다리지 않게 하려는 값이다. 발표에서는 쓰지 않는다.
 */
export function mockSpeed(): number {
  if (typeof window === 'undefined') return 1
  const value = Number(new URLSearchParams(window.location.search).get('speed'))
  return Number.isFinite(value) && value >= 1 ? Math.min(value, 20) : 1
}

/**
 * 시연용 ?stabilize=N(초, 1~600): 목업에서 100% 전환 뒤 확정 전 안정화 구간을 N초 둔다(기본 0 = 없음, 바로 완료).
 * 실제 모드는 플랫폼 정책(stabilize_seconds)을 따른다. 안정화 구간에서 "장애 주입"을 누르면 Jackal이 먼저 알리고 롤백할지 묻는다.
 */
export function stabilizeDemoSeconds(): number {
  if (typeof window === 'undefined') return 0
  const value = Number(new URLSearchParams(window.location.search).get('stabilize'))
  return Number.isInteger(value) && value >= 1 && value <= 600 ? value : 0
}
