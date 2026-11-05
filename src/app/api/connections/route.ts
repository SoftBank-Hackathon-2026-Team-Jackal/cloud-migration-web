import { handleCreateConnection, handleList } from '../../../lib/connections/handlers'
import { connectionsDeps, crossOrigin } from '../../../lib/connections/server'

export const dynamic = 'force-dynamic'

/** 통합 목록: [가정] 연결(목업) + 웹이 등록한 Agent(실제 API) */
export function GET(request: Request) {
  return handleList(request, connectionsDeps())
}

/** [가정] AWS 연결 만들기 → external_id, launch_stack_url */
export function POST(request: Request) {
  return crossOrigin(request) ?? handleCreateConnection(request, connectionsDeps())
}
