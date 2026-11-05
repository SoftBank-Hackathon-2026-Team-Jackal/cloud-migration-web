import { handlePinSource } from '../../../../lib/github/handlers'
import { githubSessionFrom } from '../../../../lib/github/token'

export const dynamic = 'force-dynamic'

export function POST(request: Request) {
  return handlePinSource(request, { getSession: githubSessionFrom })
}
