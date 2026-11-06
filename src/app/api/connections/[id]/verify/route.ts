import { handleVerifyConnection } from '../../../../../lib/connections/handlers'
import { connectionsDeps } from '../../../../../lib/connections/server'
import { guard } from '../../../../../lib/connections/guard'

export const dynamic = 'force-dynamic'

/** [가정] 연결 확인(AssumeRole 시도 등) */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  return (await guard(request)) ?? handleVerifyConnection(request, connectionsDeps(), id)
}
