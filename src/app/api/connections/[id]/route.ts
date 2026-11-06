import { handleDeleteConnection } from '../../../../lib/connections/handlers'
import { connectionsDeps } from '../../../../lib/connections/server'
import { guard } from '../../../../lib/connections/guard'

export const dynamic = 'force-dynamic'

/** [가정] 플랫폼의 연결 정보만 지운다 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  return (await guard(request)) ?? handleDeleteConnection(request, connectionsDeps(), id)
}
