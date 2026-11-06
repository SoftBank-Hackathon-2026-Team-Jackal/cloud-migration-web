import { handleCreateConnection, handleList } from '../../../lib/connections/handlers'
import { connectionsDeps } from '../../../lib/connections/server'
import { guard } from '../../../lib/connections/guard'

export const dynamic = 'force-dynamic'

/** 통합 목록: [가정] 연결(목업) + 웹이 등록한 Agent(실제 API) */
export async function GET(request: Request) {
  return (await guard(request)) ?? handleList(request, connectionsDeps())
}

/** [가정] AWS 연결 만들기 → external_id, launch_stack_url */
export async function POST(request: Request) {
  return (await guard(request)) ?? handleCreateConnection(request, connectionsDeps())
}
