import { handleDeleteConnection } from '../../../../lib/connections/handlers'
import { connectionsDeps, crossOrigin } from '../../../../lib/connections/server'

export const dynamic = 'force-dynamic'

/** [가정] 플랫폼의 연결 정보만 지운다 */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  return crossOrigin(request) ?? handleDeleteConnection(request, connectionsDeps(), id)
}
