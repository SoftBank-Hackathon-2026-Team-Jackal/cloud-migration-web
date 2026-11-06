import { handleRevoke } from '../../../../../lib/connections/handlers'
import { connectionsDeps } from '../../../../../lib/connections/server'
import { guard } from '../../../../../lib/connections/guard'

export const dynamic = 'force-dynamic'

/** 실제 API: POST /agent-admin/agents/{agent_id}/revoke (되돌릴 수 없다) */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  return (await guard(request)) ?? handleRevoke(request, connectionsDeps(), id)
}
