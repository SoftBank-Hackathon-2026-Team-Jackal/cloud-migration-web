import { guardedRelay } from '../../../../../../../lib/approvals/relay'
import { approvalDeps, approvalGuard } from '../../../../../../../lib/approvals/server'

export const dynamic = 'force-dynamic'

/** 기록된 승인 다시 전달 → 플랫폼 POST …/approvals/{approval_id}/delivery */
export async function POST(request: Request, ctx: { params: Promise<{ planId: string; revision: string; approvalId: string }> }) {
  const { planId, revision, approvalId } = await ctx.params
  return guardedRelay(request, { kind: 'delivery', planId, revision, approvalId }, { guard: approvalGuard, deps: approvalDeps })
}
