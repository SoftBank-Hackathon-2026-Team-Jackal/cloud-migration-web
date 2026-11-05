import { handleScopeAnalyze } from '../../../../lib/connections/handlers'
import { connectionsDeps, crossOrigin } from '../../../../lib/connections/server'

export const dynamic = 'force-dynamic'

/** [가정] 고른 워크로드에서 출발해 이전 범위 후보를 찾는다 */
export function POST(request: Request) {
  return crossOrigin(request) ?? handleScopeAnalyze(request, connectionsDeps())
}
