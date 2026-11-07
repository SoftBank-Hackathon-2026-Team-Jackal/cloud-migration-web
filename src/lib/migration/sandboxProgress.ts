import type { SandboxStep } from './events.ts'

/**
 * 샌드박스 화면의 진행 표시(실제 모드): 단계별 시작·끝 시각(이벤트 at)과 지금 단계, 경과 시간.
 * 가짜 진행률은 만들지 않는다. 시간은 서버가 보낸 at만 쓰고, 진행 중이면 지금 시각까지 센다.
 */

/** 단계 하나의 시작·끝 시각(ISO). 진행 중이면 end가 null이다. */
export type StepTime = { start: string | null; end: string | null }

/** running이면 새로 시작(끝 지움), done·failed면 끝을 찍는다(시작을 못 받았으면 끝 시각을 시작으로도 쓴다). */
export function markTime(prev: StepTime | undefined, state: string, at: string): StepTime {
  if (state === 'running') return { start: at, end: null }
  if (state === 'done' || state === 'failed') return { start: prev?.start ?? at, end: at }
  return prev ?? { start: at, end: null }
}

/** 경과 초(정수). 시각을 모르거나 거꾸로면 null. */
export function elapsedSeconds(time: StepTime | undefined, now: number): number | null {
  if (!time?.start) return null
  const start = Date.parse(time.start)
  const end = time.end ? Date.parse(time.end) : now
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return Math.max(0, Math.floor((end - start) / 1000))
}

/** 화면 단계 순서: 이미지 빌드 → 렌더 → 적용 → 준비 검사 → 테스트 → 판정 */
export const SANDBOX_STEPS: SandboxStep[] = ['render', 'apply', 'ready', 'test', 'judge']

/** 트랙에서 지금 진행 중인 단계(마지막으로 running인 것). 없으면 null. */
export function currentStep(steps: Partial<Record<SandboxStep, string>>): SandboxStep | null {
  let found: SandboxStep | null = null
  for (const step of SANDBOX_STEPS) if (steps[step] === 'running') found = step
  return found
}

/** 서버가 가린 값인지([MASKED], ***, <redacted> 등). 가린 값은 화면에 그대로 내지 않는다. */
export const isMasked = (value: string | null | undefined) =>
  !value || /^\s*(\[?\s*masked\s*\]?|\*{3,}|<\s*redacted\s*>|\[\s*redacted\s*\])\s*$/i.test(value)

/** 실제 호출 ⊆ 매핑 칸: 호출이 0건이면 확인할 것이 없다는 문구로, 아니면 n / m. */
export function mappingCell(callsInMapping: number, callsTotal: number): { kind: 'none' } | { kind: 'ratio'; text: string } {
  return callsTotal === 0 ? { kind: 'none' } : { kind: 'ratio', text: callsInMapping + ' / ' + callsTotal }
}

/** 분석 검토 게이트를 지나기 전이라 샌드박스가 아직 시작하지 않았는지(실제 모드, 이전 시작됨, 마지막 phase가 분석, 샌드박스·빌드 이벤트 없음). */
export function waitingForAnalysisReview({ mode, migrationId, lastPhase, hasSandboxEvents }: { mode: 'mock' | 'sse'; migrationId: string | null; lastPhase: string | null; hasSandboxEvents: boolean }): boolean {
  return mode === 'sse' && !!migrationId && lastPhase === 'analysis' && !hasSandboxEvents
}

/** 초 → { m, s } (화면 문구는 사전에서 고른다) */
export const splitSeconds = (seconds: number) => ({ m: Math.floor(seconds / 60), s: seconds % 60 })
