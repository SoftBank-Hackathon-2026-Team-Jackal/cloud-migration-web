import { handleAgentStatus, handleForget } from '../../../../lib/connections/handlers'
import { connectionsDeps, crossOrigin } from '../../../../lib/connections/server'

export const dynamic = 'force-dynamic'

/** 실제 API: GET /agent-admin/agents/{agent_id} */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  return handleAgentStatus(request, connectionsDeps(), id)
}

/** 웹 서버의 기억에서만 지운다(폐기된 Agent 정리용) */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  return crossOrigin(request) ?? handleForget(request, connectionsDeps(), id)
}
