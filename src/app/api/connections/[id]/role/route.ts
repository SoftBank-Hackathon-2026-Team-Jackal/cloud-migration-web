import { handleSetRole } from '../../../../../lib/connections/handlers'
import { connectionsDeps } from '../../../../../lib/connections/server'
import { guard } from '../../../../../lib/connections/guard'

export const dynamic = 'force-dynamic'

/** [가정 · #23] 스택 출력 RoleArn 등록 */
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  return (await guard(request)) ?? handleSetRole(request, connectionsDeps(), id)
}
