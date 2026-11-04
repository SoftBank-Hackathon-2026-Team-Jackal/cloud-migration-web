import { handleStatus } from '../../../../lib/github/handlers'
import { githubSessionFrom } from '../../../../lib/github/token'

export const dynamic = 'force-dynamic'

export function GET(request: Request) {
  return handleStatus(request, { getSession: githubSessionFrom })
}
