/**
 * Temporal UI 주소. TEMPORAL_UI_URL이 없으면 배포(compose의 web 컨테이너)는 같은 네트워크의 temporal-ui:8080,
 * 개발 서버는 컨트롤 플레인 8080을 SSM 포트 포워딩한 127.0.0.1:8233.
 */
export function temporalUiUrl(env: Record<string, string | undefined> = process.env): string {
  const fallback = env.NODE_ENV === 'production' ? 'http://temporal-ui:8080' : 'http://127.0.0.1:8233'
  return (env.TEMPORAL_UI_URL || fallback).replace(/\/+$/, '')
}

/**
 * 공개 웹으로 여는 Temporal UI는 읽기 전용이다. Temporal UI의 HTTP API에서 상태를 바꾸는 요청(취소·종료·Signal·
 * Reset·일괄 작업 등)은 GET이 아니므로 막고, 화면이 읽기에 쓰는 워크플로 Query(Call Stack·Queries 탭)만 POST를 허용한다.
 */
export function isTemporalReadOnlyRequest(method: string, pathname: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true
  return method === 'POST' && /^\/api\/v1\/namespaces\/[^/]+\/workflows\/[^/]+\/query\/[^/]+$/.test(pathname)
}
