import { handleVerifyConnection } from '../../../../../lib/connections/handlers'
import { connectionsDeps, crossOrigin } from '../../../../../lib/connections/server'

export const dynamic = 'force-dynamic'

/** [가정] 연결 확인(AssumeRole 시도 등) */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  return crossOrigin(request) ?? handleVerifyConnection(request, connectionsDeps(), id)
}
