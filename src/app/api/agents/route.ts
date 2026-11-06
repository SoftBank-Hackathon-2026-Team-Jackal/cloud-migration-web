import { handleEnroll } from '../../../lib/connections/handlers'
import { connectionsDeps } from '../../../lib/connections/server'
import { guard } from '../../../lib/connections/guard'

export const dynamic = 'force-dynamic'

/** 실제 API: POST /agent-enrollments → 등록 토큰·설치 명령(한 번만) */
export async function POST(request: Request) {
  return (await guard(request)) ?? handleEnroll(request, connectionsDeps())
}
