import { handleScopeOptions } from '../../../../lib/connections/handlers'
import { connectionsDeps } from '../../../../lib/connections/server'

export const dynamic = 'force-dynamic'

/** [가정] 리전 → EKS 클러스터 → Namespace → Deployment 목록 */
export function GET(request: Request) {
  return handleScopeOptions(request, connectionsDeps())
}
