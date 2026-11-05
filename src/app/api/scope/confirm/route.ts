import { handleScopeConfirm } from '../../../../lib/connections/handlers'
import { connectionsDeps, crossOrigin } from '../../../../lib/connections/server'

export const dynamic = 'force-dynamic'

/** [가정] 포함할 후보를 확정한다 */
export function POST(request: Request) {
  return crossOrigin(request) ?? handleScopeConfirm(request, connectionsDeps())
}
