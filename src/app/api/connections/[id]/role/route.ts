import { handleSetRole } from '../../../../../lib/connections/handlers'
import { connectionsDeps, crossOrigin } from '../../../../../lib/connections/server'

export const dynamic = 'force-dynamic'

/** [가정 · #23] 스택 출력 RoleArn 등록 */
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  return crossOrigin(request) ?? handleSetRole(request, connectionsDeps(), id)
}
