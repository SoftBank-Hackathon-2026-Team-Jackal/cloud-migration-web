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
  /** 이 기준을 무엇으로 증명하는지: SANDBOX(다음 샌드박스) · POST_DEPLOY(배포 뒤 다시 잼) · null(표시 안 함) */
  proof: ReviewProof | null
  approvable: boolean
  decision: string | null
}

export type ReviewProof = 'SANDBOX' | 'POST_DEPLOY'

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
        proof: item.proof === 'SANDBOX' || item.proof === 'POST_DEPLOY' ? item.proof : null,
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

/**
 * 실제 모드에서 분석을 '끝났다'고 볼 수 있는지(다음 화면으로 갈 수 있는지).
 * 서버는 analysis.done을 매핑 전에 보내고, 매핑 뒤 검토 게이트에서 사람의 결정을 기다린다(GET이 그동안 ANALYZING).
 * 그래서 검토 상태를 analysis.done 뒤에 한 번이라도 읽기 전에는 끝나지 않은 것으로 본다. 검토가 없으면(404) 끝난 것이다.
 * 서버가 이미 다음 단계(build 등)의 이벤트를 보냈으면 게이트는 지나갔다.
 * - known: analysis.done 뒤에 검토 상태를 한 번 이상 읽었는지(404도 읽은 것)
 * - pastAnalysis: 분석 다음 단계의 이벤트가 왔는지
 */
export function reviewSettled({ view, known, pastAnalysis }: { view: ReviewView | null; known: boolean; pastAnalysis: boolean }): boolean {
  if (reviewWaiting(view) || reviewBlocked(view)) return false
  if (pastAnalysis) return true
  if (!known) return false
  if (!view) return true
  return view.phase !== 'ANALYZING'
}

/** 분석 화면의 '다음'을 열 수 있는지. 목업은 예전 그대로(검토 게이트가 없다). */
export function analysisFinished({ mode, done, streamsFull, view, known, pastAnalysis }: {
  mode: 'mock' | 'sse'
  done: boolean
  streamsFull: boolean
  view: ReviewView | null
  known: boolean
  pastAnalysis: boolean
}): boolean {
  if (!(done || streamsFull)) return false
  if (mode !== 'sse') return true
  return reviewSettled({ view, known, pastAnalysis })
}

/** 검토 패널을 띄울지: 실제 모드에서 검토가 사람을 기다리거나 막혔으면 어느 화면에서든(첫 화면 제외) 띄운다. */
export function showReviewPanel({ mode, stage, view }: { mode: 'mock' | 'sse'; stage: string; view: ReviewView | null }): boolean {
  return mode === 'sse' && stage !== 'intro' && (reviewWaiting(view) || reviewBlocked(view))
}

// ---- 등급 × 필수 → 결과(플랫폼 cmp_agents.mapping.compute_treatment와 같은 표) ----

export type Treatment = 'PROCEED' | 'APPROVAL' | 'BLOCK'
/** 화면이 보여 주는 결과: 그대로 진행 · 2단계에서 승인 · 이전 중단 */
export type ReviewOutcome = 'proceed' | 'approval' | 'block'

/** DIRECT·API_DIFF는 필수 여부와 관계없이 진행. 그 밖(PARTIAL·NONE·모르는 등급)은 필수면 차단, 아니면 승인 필요. */
export function treatmentOf(grade: string, required: boolean): Treatment {
  if (grade === 'DIRECT' || grade === 'API_DIFF') return 'PROCEED'
  return required ? 'BLOCK' : 'APPROVAL'
}

const OUTCOME: Record<Treatment, ReviewOutcome> = { PROCEED: 'proceed', APPROVAL: 'approval', BLOCK: 'block' }
/** 1단계(필수 확정)에서 이 선택의 결과 */
export const confirmOutcome = (grade: string, required: boolean): ReviewOutcome => OUTCOME[treatmentOf(grade, required)]
/** 2단계(승인)에서 이 답의 결과: 승인하면 잃고(낮아진 채) 진행, 거절하면 기능은 필수가 되어 차단되고 보안은 그대로 차단된다. 답이 없으면 null. */
export const decisionOutcome = (choice: ReviewDecision | undefined): ReviewOutcome | null =>
  choice === 'APPROVED' ? 'proceed' : choice === 'REJECTED' ? 'block' : null

export type ConfirmPreview = {
  /** 확정하면 차단되는 행 ID */
  blocks: string[]
  /** 2단계에서 승인을 받을 행 ID */
  approvals: string[]
  proceeds: string[]
  /** 2단계로 가는지(승인 행이 있거나 보안이 낮아지는 항목이 있다). 차단이 있으면 2단계 없이 멈춘다. */
  asksApproval: boolean
}

/** 지금의 필수 선택으로 확정하면 어떻게 되는지 미리 계산한다(서버의 _recompute와 같은 판단). */
export function confirmPreview(view: ReviewView, required: Record<string, boolean>): ConfirmPreview {
  const by: Record<ReviewOutcome, string[]> = { proceed: [], approval: [], block: [] }
  for (const item of view.items) by[confirmOutcome(item.grade, !!required[item.id])].push(item.id)
  const lower = view.security.some(item => item.approvable)
  return { blocks: by.block, approvals: by.approval, proceeds: by.proceed, asksApproval: by.block.length === 0 && (by.approval.length > 0 || lower) }
}

/** 2단계의 지금 답으로 보내면 차단되는 항목 ID(거절한 것) */
export function approvePreview(view: ReviewView, choices: Record<string, ReviewDecision | undefined>): string[] {
  return approvalIds(view).filter(id => choices[id] === 'REJECTED')
}

/** 보안 판정을 보여 줄 순서: 승인할 것(LOWER) → 사람이 봐야 할 것(UNKNOWN) → 같음·높아짐. 같은 무리 안에서는 서버 순서. */
const VERDICT_ORDER: Record<string, number> = { LOWER: 0, UNKNOWN: 1, SAME: 2, HIGHER: 3 }
export function securityRows(view: ReviewView): ReviewSecurity[] {
  return view.security.map((item, index) => ({ item, index }))
    .sort((a, b) => (VERDICT_ORDER[a.item.verdict] ?? 1) - (VERDICT_ORDER[b.item.verdict] ?? 1) || a.index - b.index)
    .map(entry => entry.item)
}

/** 증명 방식 → 문구 키(없으면 표시하지 않는다) */
export const proofKey = (proof: ReviewProof | null) => proof === 'SANDBOX' ? 'reviewGate.proof.SANDBOX' : proof === 'POST_DEPLOY' ? 'reviewGate.proof.POST_DEPLOY' : null

/**
 * 막힌 이유의 문구 키와 값. 서버 문장(한국어 고정 또는 'SECURITY_LOWER: <기준>')을 그대로 쓰지 않고 등급·기준으로 고른다.
 * 보안 막힘은 capability가 'security'이고 usage가 기준이다.
 */
export function blockedText(item: ReviewBlocked): { kind: 'security' | 'feature'; reasonKey: string; altKey: string | null; criterion: string } {
  if (item.capability === 'security') {
    return { kind: 'security', reasonKey: 'reviewGate.blockedWhy.security', altKey: item.alternative ? 'reviewGate.suggest.' + item.alternative : null, criterion: item.usage }
  }
  const grade = item.grade === 'NONE' || item.grade === 'PARTIAL' ? item.grade : 'other'
  return { kind: 'feature', reasonKey: 'reviewGate.blockedWhy.' + grade, altKey: grade === 'other' ? null : 'reviewGate.alt.' + grade, criterion: '' }
}

/**
 * 검토 상태를 읽는 주기. 분석이 끝났는데 아직 게이트가 서지 않았으면(ANALYZING이거나 아직 못 읽음) 0.3초로 줄여
 * 게이트가 서자마자 화면에 뜨게 한다. 그 밖에는 2초.
 */
export const REVIEW_POLL_FAST_MS = 300
export const REVIEW_POLL_MS = 2000
export function reviewPollMs({ analysisDone, view }: { analysisDone: boolean; view: ReviewView | null }): number {
  return analysisDone && (!view || view.phase === 'ANALYZING') ? REVIEW_POLL_FAST_MS : REVIEW_POLL_MS
}
