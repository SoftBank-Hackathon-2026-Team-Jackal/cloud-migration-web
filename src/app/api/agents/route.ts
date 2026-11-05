import { handleEnroll } from '../../../lib/connections/handlers'
import { connectionsDeps, crossOrigin } from '../../../lib/connections/server'

export const dynamic = 'force-dynamic'

/** 실제 API: POST /agent-enrollments → 등록 토큰·설치 명령(한 번만) */
export function POST(request: Request) {
  return crossOrigin(request) ?? handleEnroll(request, connectionsDeps())
}
