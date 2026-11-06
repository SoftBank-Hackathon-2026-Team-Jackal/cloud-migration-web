/**
 * 분석 검토 게이트(플랫폼 `GET|POST /migrations/{id}/analysis/review`)의 값과 판단.
 * 게이트는 분석 매핑 뒤 사람의 결정이 올 때까지 멈춘다: ① 필수 기능 확정 ② 잃는 것·보안 낮아짐 승인.
 * 화면은 서버가 준 항목을 그대로 보여 주고, 서버가 요구하는 모양(모든 행에 답하기)으로만 보낸다.
 */

export type ReviewPending = 'confirm_requirements' | 'approve_losses'

export type ReviewItem = {
  id: string
  capability: string
  usage: string
  /** DIRECT | PARTIAL | NONE 등: 대상에서 얼마나 대응되는지 */
  grade: string
  /** 이전하면 잃는 것 */
  loses: string[]
  required_proposed: boolean
  required_reason: string
  /** 확정된 값(확정 전에는 null) */
  required: boolean | null
  /** APPROVAL이면 승인이 필요하다. BLOCK이면 이전할 수 없다. */
  treatment: string | null
}

export type ReviewSecurity = {
  /** security:<기준> */
  id: string
  criterion: string
  source_state: string
  target_state: string
  /** LOWER면 승인 대상 */
  verdict: string
  weak_source: boolean
  reasons: string[]
  suggestion: string | null
  approvable: boolean
  decision: string | null
}

export type ReviewBlocked = { id: string; capability: string; usage: string; grade: string; reason: string; alternative: string }

export type ReviewView = {
  phase: string
  analysis_ref: { id: string; version: string } | null
  pending: ReviewPending | null
  items: ReviewItem[]
  security: ReviewSecurity[]
  blocked: ReviewBlocked[]
}

export type ReviewDecision = 'APPROVED' | 'REJECTED'

/** 서버 응답 코드(화면이 문구를 고르는 키). 모르는 코드는 그대로 둔다. */
export type ReviewResult = { ok: true; view: ReviewView | null } | { ok: false; code: string }

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const text = (value: unknown) => typeof value === 'string' ? value : ''
const list = (value: unknown) => Array.isArray(value) ? value : []
const strings = (value: unknown) => list(value).filter((item): item is string => typeof item === 'string')

/** 서버 응답을 화면 모양으로 바꾼다. 모양이 맞지 않으면 null(서버가 옛 버전이거나 응답이 아니다). */
export function parseReview(value: unknown): ReviewView | null {
  const data = record(value)
  if (!data || typeof data.phase !== 'string') return null
  const pending = data.pending === 'confirm_requirements' || data.pending === 'approve_losses' ? data.pending : null
  const ref = record(data.analysis_ref)
  return {
    phase: data.phase,
    analysis_ref: ref && typeof ref.id === 'string' && ref.version !== undefined ? { id: ref.id, version: String(ref.version) } : null,
    pending,
    items: list(data.items).flatMap(raw => {
      const item = record(raw)
      if (!item || typeof item.id !== 'string') return []
      return [{
        id: item.id,
        capability: text(item.capability),
        usage: text(item.usage),
        grade: text(item.grade),
        loses: strings(item.loses),
        required_proposed: item.required_proposed === true,
        required_reason: text(item.required_reason),
        required: typeof item.required === 'boolean' ? item.required : null,
        treatment: typeof item.treatment === 'string' ? item.treatment : null,
      }]
    }),
    security: list(data.security).flatMap(raw => {
      const item = record(raw)
      if (!item || typeof item.id !== 'string') return []
      return [{
        id: item.id,
        criterion: text(item.criterion),
        source_state: text(item.source_state),
        target_state: text(item.target_state),
        verdict: text(item.verdict),
        weak_source: item.weak_source === true,
        reasons: strings(item.reasons),
        suggestion: typeof item.suggestion === 'string' ? item.suggestion : null,
        approvable: item.approvable === true,
        decision: typeof item.decision === 'string' ? item.decision : null,
      }]
    }),
    blocked: list(data.blocked).flatMap(raw => {
      const item = record(raw)
      if (!item || typeof item.id !== 'string') return []
      return [{ id: item.id, capability: text(item.capability), usage: text(item.usage), grade: text(item.grade), reason: text(item.reason), alternative: text(item.alternative) }]
    }),
  }
}

/** 필수 기능 확정의 처음 값: 이미 확정된 값이 있으면 그것, 없으면 서버 제안. */
export function defaultRequired(view: ReviewView): Record<string, boolean> {
  return Object.fromEntries(view.items.map(item => [item.id, item.required ?? item.required_proposed]))
}

/** 승인 단계에서 답해야 하는 항목의 ID: 처리가 APPROVAL인 기능 행 + 승인 대상 보안 항목. 서버는 이 전부에 답하기를 요구한다. */
export function approvalIds(view: ReviewView): string[] {
  return [
    ...view.items.filter(item => item.treatment === 'APPROVAL').map(item => item.id),
    ...view.security.filter(item => item.approvable).map(item => item.id),
  ]
}

/** 모든 승인 항목에 답했으면 서버로 보낼 값, 아니면 null. */
export function approvalsOf(view: ReviewView, choices: Record<string, ReviewDecision | undefined>): Record<string, ReviewDecision> | null {
  const ids = approvalIds(view)
  if (ids.length === 0) return null
  const answers: Record<string, ReviewDecision> = {}
  for (const id of ids) {
    const choice = choices[id]
    if (!choice) return null
    answers[id] = choice
  }
  return answers
}

/** 검토가 사람을 기다리는 중이거나(멈춘 상태) 막혀서 끝났는지 */
export const reviewWaiting = (view: ReviewView | null) => view?.pending != null
export const reviewBlocked = (view: ReviewView | null) => view?.phase === 'BLOCKED'

/** 서버 거절 코드 → 화면 문구 키(없으면 일반 문구) */
export const REVIEW_ERROR_KEYS: Record<string, string> = {
  MISSING_ROW: 'reviewGate.err.missing',
  UNKNOWN_ROW: 'reviewGate.err.unknown',
  NOT_APPROVABLE: 'reviewGate.err.notApprovable',
  ANALYSIS_REF_MISMATCH: 'reviewGate.err.stale',
  REVIEW_NOT_PENDING: 'reviewGate.err.notPending',
  REVIEW_UNAVAILABLE: 'reviewGate.err.unavailable',
}
export const reviewErrorKey = (code: string) => REVIEW_ERROR_KEYS[code] ?? 'reviewGate.err.generic'
