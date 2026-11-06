/**
 * 계획 승인 중계(BFF). 플랫폼 승인 API는 승인자 토큰(Authorization: Bearer)을 요구하는데,
 * 그 토큰은 브라우저가 들고 있으면 안 된다. 브라우저는 우리 웹 서버(/api/approvals/…)로만 보내고,
 * 웹 서버가 PLATFORM_APPROVER_TOKEN을 붙여 플랫폼에 넘긴다.
 *   POST /api/approvals/{plan_id}/{revision}                          → POST /provisioning/plans/{plan_id}/revisions/{revision}/approvals
 *   POST /api/approvals/{plan_id}/{revision}/{approval_id}/delivery   → POST …/approvals/{approval_id}/delivery
 * 성공 응답 본문(ApprovalDecisionData)은 그대로 넘기고, 오류는 코드만 넘긴다. 토큰은 응답·오류·로그에 넣지 않는다.
 */
export type RelayDeps = {
  base: string
  approverToken: string
  fetchImpl?: typeof fetch
}

export type RelayTarget =
  | { kind: 'decision'; planId: string; revision: string }
  | { kind: 'delivery'; planId: string; revision: string; approvalId: string }

const TIMEOUT_MS = 8000
const ID = /^[A-Za-z0-9._:-]{1,128}$/
const REVISION = /^\d{1,9}$/
const DECISIONS = ['APPROVE', 'REJECT']
const SCOPES = ['INFRASTRUCTURE', 'WORKLOADS', 'FULL']
const DIGEST = /^[A-Za-z0-9:._-]{1,128}$/

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const failure = (status: number, error: string, detail?: string | null) => json(status, detail ? { error, detail } : { error })

/** 코드 형태(대문자·숫자·밑줄)일 때만 쓴다. 자유 문장은 버린다(토큰이 섞여 있어도 넘어가지 않는다). */
function codeOnly(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z0-9_]{1,64}$/.test(value) ? value : null
}

/** 플랫폼 오류 본문에서 코드를 꺼낸다: FastAPI {detail: CODE} · {detail: {code}} · 목업 서버 {error: CODE} */
function codeOf(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const { detail, error } = data as { detail?: unknown; error?: unknown }
  if (detail && typeof detail === 'object') return codeOnly((detail as { code?: unknown }).code)
  return codeOnly(detail) ?? codeOnly(error)
}

/**
 * 플랫폼 오류 상태 → 중계 응답.
 * 401·403은 사용자의 로그인 문제가 아니라 웹 서버의 승인자 토큰이 거절된 것이라 502(approver_auth)로 바꾼다
 * (브라우저 쪽 401 LOGIN_REQUIRED와 구분된다).
 */
export function relayError(status: number, code: string | null): Response {
  if (status === 401 || status === 403) return failure(502, 'approver_auth', code ?? 'APPROVER_AUTH_REQUIRED')
  if (status === 404) return failure(404, 'not_found', code)
  if (status === 409) return failure(409, 'conflict', code)
  if (status === 400 || status === 422) return failure(400, 'bad_request', code)
  if (status === 503) return failure(503, 'unavailable', code)
  return failure(502, 'platform_error', code)
}

/** 결정 본문에서 플랫폼이 읽는 값만 골라 검사한다. 맞지 않으면 null. */
function decisionBody(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object') return null
  const { decision, scope, manifest_digest, preview_digest } = value as Record<string, unknown>
  if (typeof decision !== 'string' || !DECISIONS.includes(decision)) return null
  if (typeof scope !== 'string' || !SCOPES.includes(scope)) return null
  if (typeof manifest_digest !== 'string' || !DIGEST.test(manifest_digest)) return null
  if (typeof preview_digest !== 'string' || !DIGEST.test(preview_digest)) return null
  return { decision, scope, manifest_digest, preview_digest }
}

export async function handleApprovalRelay(request: Request, deps: RelayDeps, target: RelayTarget): Promise<Response> {
  if (!ID.test(target.planId) || !REVISION.test(target.revision) || (target.kind === 'delivery' && !ID.test(target.approvalId))) {
    return failure(400, 'bad_request', 'INVALID_TARGET')
  }
  // 설정 누락은 그대로 알린다(화면에 어느 값이 빠졌는지 보인다).
  if (!deps.base) return failure(503, 'unavailable', 'PLATFORM_API_BASE_NOT_CONFIGURED')
  if (!deps.approverToken) return failure(503, 'unavailable', 'APPROVER_TOKEN_NOT_CONFIGURED')

  let body: Record<string, string> | undefined
  if (target.kind === 'decision') {
    const parsed = decisionBody(await request.json().catch(() => null))
    if (!parsed) return failure(400, 'bad_request', 'INVALID_DECISION')
    body = parsed
  }

  const path = '/provisioning/plans/' + encodeURIComponent(target.planId) + '/revisions/' + target.revision + '/approvals'
    + (target.kind === 'delivery' ? '/' + encodeURIComponent(target.approvalId) + '/delivery' : '')
  let response: Response
  try {
    response = await (deps.fetchImpl ?? fetch)(deps.base.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + deps.approverToken, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return failure(503, 'unavailable', 'UNREACHABLE')
  }
  const data = await response.json().catch(() => null)
  if (!response.ok) return relayError(response.status, codeOf(data))
  return json(response.status, data)
}

/** 라우트 입구: 입구 검사(같은 출처·허용 GitHub 계정)를 먼저 하고, 통과했을 때만 플랫폼에 중계한다. */
export async function guardedRelay(request: Request, target: RelayTarget, wiring: { guard: (request: Request) => Promise<Response | null>; deps: () => RelayDeps }): Promise<Response> {
  return (await wiring.guard(request)) ?? handleApprovalRelay(request, wiring.deps(), target)
}
