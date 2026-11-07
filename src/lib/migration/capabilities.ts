/**
 * 실제(SSE) 모드에서 백엔드에 아직 없는 API에 기대는 화면 동작 목록.
 * 목업 모드는 모두 된다. SSE 모드는 SSE_CAPABILITIES에 있는 것만 보이고, 없는 것은 버튼·영역을 숨긴다.
 * 백엔드가 API를 만들면 여기 기본값에 넣거나, 빌드 때 NEXT_PUBLIC_SSE_CAPABILITIES(쉼표 구분)로 켠다.
 *   sandbox.retry      POST /migrations/{id}/sandbox/retry   (사람 검토 뒤 샌드박스 재시도)
 *   traffic.rollback   POST /migrations/{id}/traffic/rollback
 *   traffic.retry      POST /migrations/{id}/traffic/retry
 *   traffic.finalize   POST /migrations/{id}/traffic/finalize   (안정화 구간을 끝내고 이전 확정)
 *   (traffic/advance는 목록에 없다: 수동 단계 대기 알림 awaitNext가 올 때만 버튼이 보이므로 capability로 막지 않는다)
 *   report             GET  /migrations/{id}/report          (리포트 타임라인)
 */
export const CAPABILITIES = ['sandbox.retry', 'traffic.rollback', 'traffic.retry', 'traffic.finalize', 'report'] as const
export type Capability = typeof CAPABILITIES[number]

/** SSE 모드 기본값: 위 API는 아직 플랫폼에 없다. */
export const SSE_CAPABILITIES: readonly Capability[] = []

const isCapability = (value: string): value is Capability => (CAPABILITIES as readonly string[]).includes(value)

/** NEXT_PUBLIC_SSE_CAPABILITIES 값을 읽는다. 비어 있으면 기본값, 값이 있으면 그 목록이 기본값을 대신한다(none = 모두 끔). */
export function parseCapabilities(value: string | undefined, fallback: readonly Capability[] = SSE_CAPABILITIES): ReadonlySet<Capability> {
  const text = (value ?? '').trim()
  if (!text) return new Set(fallback)
  return new Set(text.split(',').map(item => item.trim()).filter(isCapability))
}

/** 이 모드에서 되는 동작. Next가 빌드 때 값을 넣으므로 process.env.NEXT_PUBLIC_* 를 그대로 적는다. */
export function capabilitiesFor(mode: 'mock' | 'sse', value: string | undefined = process.env.NEXT_PUBLIC_SSE_CAPABILITIES): ReadonlySet<Capability> {
  return mode === 'mock' ? new Set(CAPABILITIES) : parseCapabilities(value)
}
