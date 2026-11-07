import { guard } from '../../../../lib/connections/guard'
import { faultSettings, forward, parseFaultView } from '../../../../lib/tools/fault'

export const dynamic = 'force-dynamic'

/**
 * 시연용 Tools 화면의 장애 스위치. 플랫폼 API(`PLATFORM_API_BASE`)의 `/system/fault`를 내부망으로 부른다.
 * 플랫폼이 `DEMO_TOOLS_ENABLED`를 꺼 두면 404(tools_disabled), 설정이 없거나 닿지 못하면 503.
 * 켜기·끄기는 연결 관리와 같은 입구 검사(같은 출처, 실제 모드에서는 허용된 GitHub 계정)를 거친다.
 */
const base = () => (process.env.PLATFORM_API_BASE ?? '').trim()
const reply = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

async function relay(method: string, body?: unknown) {
  const result = await forward(base(), '/system/fault', { method, body })
  if (result.status !== 200) return reply(result.status, result.body)
  const view = parseFaultView(result.body)
  return view ? reply(200, view) : reply(502, { error: 'platform_error' })
}

export async function GET() {
  return relay('GET')
}

export async function POST(request: Request) {
  const blocked = await guard(request)
  if (blocked) return blocked
  const settings = faultSettings(await request.json().catch(() => null))
  if (!settings) return reply(422, { error: 'invalid_settings' })
  return relay('POST', settings)
}

export async function DELETE(request: Request) {
  return (await guard(request)) ?? relay('DELETE')
}
