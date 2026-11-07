import type { ReviewView } from './review'

/**
 * 실제 모드에서 analysis.done 뒤 검토 게이트가 열리기 전까지의 구간.
 * 서버는 analysis.done을 기능 매핑 전에 보내고, 사전 점검·LLM 매핑(map_usage)을 마친 뒤에야 검토 게이트를 연다.
 * - 'mapping': 매핑 중(검토 상태를 아직 못 읽었거나 phase가 ANALYZING)
 * - 'review': 검토가 사람의 결정을 기다린다(pending이 있다)
 * - null: 해당 없음(목업, 분석 진행 중, 게이트를 지남, 막힘 등)
 */
export type AnalysisWait = 'mapping' | 'review' | null

export function analysisWait({ mode, done, view, known, past }: {
  mode: 'mock' | 'sse'
  done: boolean
  view: ReviewView | null
  /** analysis.done 뒤에 검토 상태를 한 번 이상 읽었는지(404도 읽은 것) */
  known: boolean
  /** 서버가 분석 다음 단계로 넘어갔는지 */
  past: boolean
}): AnalysisWait {
  if (mode !== 'sse' || !done || past) return null
  if (view?.pending != null) return 'review'
  if (!view) return known ? null : 'mapping'
  return view.phase === 'ANALYZING' ? 'mapping' : null
}

/**
 * 매핑 중 뼈대 검토 화면을 띄울지. 분석 화면은 '기능 매핑 중' 한 줄로 보이고, 첫 화면에는 띄우지 않는다.
 * 그 밖의 화면(샌드박스 등)에서 매핑 구간이면 검토 화면 자리에 뼈대를 띄운다. 막힘 화면에서 나갔으면(dismissed) 띄우지 않는다.
 */
export function showMappingSheet({ active, dismissed, stage, wait }: { active: boolean; dismissed: boolean; stage: string; wait: AnalysisWait }): boolean {
  return active && !dismissed && stage !== 'intro' && stage !== 'analysis' && wait === 'mapping'
}
