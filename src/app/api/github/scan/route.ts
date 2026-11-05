import { handleScan } from '../../../../lib/github/handlers'
import { githubSessionFrom } from '../../../../lib/github/token'

export const dynamic = 'force-dynamic'

export function POST(request: Request) {
  return handleScan(request, { getSession: githubSessionFrom })
}
