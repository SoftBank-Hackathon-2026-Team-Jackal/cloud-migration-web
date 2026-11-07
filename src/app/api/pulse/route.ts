import { fetchPulse, type Pulse } from '../../../lib/pulse/pulse'

export const dynamic = 'force-dynamic'

/**
 * 화면 상단 위젯용 서버 맥박. 플랫폼 API(`PLATFORM_API_BASE`)의 `GET /system/pulse`를 그대로 넘긴다.
 * 설정이 없거나 플랫폼에 닿지 못하면 503이고, 위젯은 숨는다(목업 모드에서 꾸민 숫자를 보이지 않는다).
 * 퍼센트와 개수뿐이라 비밀값은 없다. 여러 화면이 동시에 물어도 플랫폼에는 2초에 한 번만 묻는다.
 */
const CACHE_MS = 2000
let cached: { at: number; value: Pulse } | null = null
let inflight: Promise<Pulse | null> | null = null

export async function GET() {
  const base = (process.env.PLATFORM_API_BASE ?? '').trim()
  if (!base) return Response.json({ error: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  if (cached && Date.now() - cached.at < CACHE_MS) return Response.json(cached.value, { headers: { 'Cache-Control': 'no-store' } })
  inflight ??= fetchPulse(base).finally(() => { inflight = null })
  const value = await inflight
  if (!value) return Response.json({ error: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  cached = { at: Date.now(), value }
  return Response.json(value, { headers: { 'Cache-Control': 'no-store' } })
}
