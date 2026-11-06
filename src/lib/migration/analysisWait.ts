import type { ReviewView } from './review'

/**
 * 실제 모드에서 analysis.done 뒤 검토 게이트가 열리기 전까지의 구간.
 * 서버는 analysis.done을 기능 매핑 전에 보내고, 사전 점검·LLM 매핑(map_usage)을 마친 뒤에야 검토 게이트를 연다.
 * - 'mapping': 매핑 중(검토 상태를 아직 못 읽었거나 phase가 ANALYZING)
 * - 'review': 검토가 사람의 결정을 기다린다(pending이 있다)
 * - null: 해당 없음(목업, 분석 진행 중, 게이트를 지남, 막힘 등)
 */
export type AnalysisWait = 'mapping' | 'review' | null

export function analysisWait({ mode, done, finished, view }: {
  mode: 'mock' | 'sse'
  done: boolean
  finished: boolean
  view: ReviewView | null
}): AnalysisWait {
  if (mode !== 'sse' || !done || finished) return null
  if (view?.pending != null) return 'review'
  if (!view || view.phase === 'ANALYZING') return 'mapping'
  return null
}
