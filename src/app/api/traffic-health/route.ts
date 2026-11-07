import { forward, parseTrafficHealth, type TrafficHealth } from '../../../lib/tools/fault'

export const dynamic = 'force-dynamic'

/**
 * 원본·대상 서비스의 5xx 비율과 p99(중계 서버 Envoy에서 잰 값). 플랫폼 `GET /system/traffic-health`를 그대로 넘긴다.
 * 닿지 못하면 503이고, 플랫폼 주소가 설정되지 않은 서버(목업·로컬)는 오류가 아니므로 204(내용 없음)다.
 * 어느 쪽이든 화면은 값을 꾸미지 않고 "모름"으로 보인다. 여러 화면이 동시에 물어도 2초에 한 번만 묻는다.
 */
const CACHE_MS = 2000
let cached: { at: number; value: TrafficHealth } | null = null
let inflight: Promise<TrafficHealth | null> | null = null

const unavailable = () => Response.json({ error: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })

export async function GET() {
  const base = (process.env.PLATFORM_API_BASE ?? '').trim()
  if (!base) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
  if (cached && Date.now() - cached.at < CACHE_MS) return Response.json(cached.value, { headers: { 'Cache-Control': 'no-store' } })
  inflight ??= forward(base, '/system/traffic-health').then(r => r.status === 200 ? parseTrafficHealth(r.body) : null).finally(() => { inflight = null })
  const value = await inflight
  if (!value) return unavailable()
  cached = { at: Date.now(), value }
  return Response.json(value, { headers: { 'Cache-Control': 'no-store' } })
}
