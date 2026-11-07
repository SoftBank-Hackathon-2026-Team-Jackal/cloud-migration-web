export type Stage =
  | 'intro'
  | 'setup'
  | 'analysis'
  | 'planning'
  | 'rehearsal'
  | 'approval'
  | 'provisioning'
  | 'data'
  | 'traffic'
  | 'cutover'

export type Target = 'gcp' | 'onprem'

export const STAGE_ORDER: Stage[] = [
  'intro', 'setup', 'analysis', 'rehearsal', 'planning', 'approval', 'provisioning', 'data', 'traffic', 'cutover',
]

/** 상단 진행 표시줄에 보일 단계 (intro·setup은 제외). 순서와 backendPhase는 백엔드 워크플로우(analysis → build → planning → awaiting_approval → …)와 같다. */
export const RAIL: Array<{ stage: Stage; backendPhase: string }> = [
  { stage: 'analysis', backendPhase: 'analysis' },
  { stage: 'rehearsal', backendPhase: 'build' },
  { stage: 'planning', backendPhase: 'planning' },
  { stage: 'approval', backendPhase: 'awaiting_approval' },
  { stage: 'provisioning', backendPhase: 'provisioning' },
  { stage: 'data', backendPhase: 'data_copy' },
  { stage: 'traffic', backendPhase: 'traffic' },
  { stage: 'cutover', backendPhase: 'verification' },
]

/**
 * 플랫폼 실제 순서(데이터 → DB 전환 → 트래픽)의 진행 표시. DB 전환 계획이 트래픽보다 먼저 오면(state.cutover.dbFirst) 쓴다.
 * 완료 리포트는 전환 화면 안에 있으므로, 트래픽 뒤 리포트를 보일 때는 모든 단계를 끝난 것으로 표시한다(StageRail complete).
 */
export const DB_FIRST_ORDER: Stage[] = [
  'intro', 'setup', 'analysis', 'rehearsal', 'planning', 'approval', 'provisioning', 'data', 'cutover', 'traffic',
]
export const DB_FIRST_RAIL: typeof RAIL = DB_FIRST_ORDER.flatMap(stage => RAIL.filter(item => item.stage === stage))

export function isStage(value: string | null): value is Stage {
  return value !== null && (STAGE_ORDER as string[]).includes(value)
}
