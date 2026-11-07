/**
 * 그림자 리허설 표시 판정과 DB 전환 사전 조건 판정. 순수 함수만 둔다(React 없음, 단위 시험 대상).
 * 그림자 리허설은 경고·표시 전용이다: warn·skip이어도 다음 버튼과 DB 전환 승인을 막지 않는다.
 */
import type { CutoverPrecondition, ShadowProgressData, ShadowResultData } from './events'

export type ShadowState = { progress: ShadowProgressData | null; result: ShadowResultData | null }

export type ShadowView =
  | { mode: 'running'; compared: number; elapsed_s: number; window_s: number }
  | { mode: 'result'; result: ShadowResultData }

/** 이벤트가 하나도 없으면 null(화면에 아무것도 그리지 않는다). 결과가 있으면 결과, 아니면 진행 중. */
export function shadowView(shadow: ShadowState): ShadowView | null {
  if (shadow.result) return { mode: 'result', result: shadow.result }
  if (shadow.progress) return { mode: 'running', compared: shadow.progress.compared, elapsed_s: shadow.progress.elapsed_s, window_s: shadow.progress.window_s }
  return null
}

type PreconditionState = CutoverPrecondition['state']

/** DB 전환 승인 가능: 모든 조건이 pass이거나 경고 전용(warn·skip)이다. wait·fail이 하나라도 있으면 막는다. */
export function preconditionsAllowCutover(list: readonly CutoverPrecondition[]): boolean {
  return list.every(item => item.state === 'pass' || item.state === 'warn' || item.state === 'skip')
}

/** 줄 표시 클래스: 기존 스타일(pass·wait·fail)만 쓴다. warn·skip은 회색(wait) 줄에 문구만 다르다. */
export function preconditionTone(state: PreconditionState): 'pass' | 'wait' | 'fail' {
  return state === 'pass' || state === 'fail' ? state : 'wait'
}

export function preconditionMark(state: PreconditionState): string {
  return state === 'pass' ? '✓' : state === 'fail' ? '✕' : state === 'warn' ? '!' : state === 'skip' ? '–' : ''
}
