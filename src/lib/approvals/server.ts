import { guard } from '../connections/guard.ts'
import { platformDeps } from '../connections/server.ts'
import type { RelayDeps } from './relay.ts'

/**
 * 승인 중계의 서버 전용 설정(NEXT_PUBLIC_ 없이 서버에만 있다).
 *   PLATFORM_API_BASE         플랫폼 API(연결 관리와 같은 값)
 *   PLATFORM_APPROVER_TOKEN   승인자 토큰. 플랫폼 승인 API의 Authorization: Bearer 값. 비어 있으면 503 APPROVER_TOKEN_NOT_CONFIGURED.
 */
export function approvalDeps(): RelayDeps {
  return { base: platformDeps().base, approverToken: (process.env.PLATFORM_APPROVER_TOKEN ?? '').trim() }
}

/** 승인 토큰이 있는 서버에서는 목업 연결 모드여도 로그인한 허용 계정만 통과시킨다. */
export function approvalGuard(request: Request): Promise<Response | null> {
  return guard(request, { secretConfigured: Boolean(approvalDeps().approverToken) })
}
