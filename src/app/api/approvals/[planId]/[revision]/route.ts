import { guardedRelay } from '../../../../../lib/approvals/relay'
import { approvalDeps, approvalGuard } from '../../../../../lib/approvals/server'

export const dynamic = 'force-dynamic'

/** 계획 승인·거절 → 플랫폼 POST /provisioning/plans/{plan_id}/revisions/{revision}/approvals (승인자 토큰은 서버가 붙인다) */
export async function POST(request: Request, ctx: { params: Promise<{ planId: string; revision: string }> }) {
  const { planId, revision } = await ctx.params
  return guardedRelay(request, { kind: 'decision', planId, revision }, { guard: approvalGuard, deps: approvalDeps })
}
