export type Stage =
  | 'intro'
  | 'setup'
  | 'analysis'
  | 'planning'
  | 'rehearsal'
  | 'approval'
  | 'provisioning'
  | 'data'
  | 'cutover'
  | 'traffic'
  /** 완료 리포트(트래픽 전환 뒤) */
  | 'report'

export type Target = 'gcp' | 'onprem'

/**
 * 화면 순서. 백엔드 Workflow 순서와 같다(실제·목업 모두):
 * 분석 → 빌드(샌드박스) → 계획 → 승인 → 구축 → 데이터 복제 → DB 전환 → 트래픽 전환 → 완료 리포트.
 * DB 전환(cutover.*)은 데이터 복제 안에서 일어나고, 트래픽은 DB 전환이 끝나야 시작한다.
 */
export const STAGE_ORDER: Stage[] = [
  'intro', 'setup', 'analysis', 'rehearsal', 'planning', 'approval', 'provisioning', 'data', 'cutover', 'traffic', 'report',
]

/**
 * 상단 진행 표시줄에 보일 단계(intro·setup·report 제외). 완료 리포트(report)에서는 모두 끝난 것으로 보인다.
 * backendPhase는 그 단계 이벤트가 오는 백엔드 phase다(DB 전환 이벤트는 verification phase로 온다).
 */
export const RAIL: Array<{ stage: Stage; backendPhase: string }> = [
  { stage: 'analysis', backendPhase: 'analysis' },
  { stage: 'rehearsal', backendPhase: 'build' },
  { stage: 'planning', backendPhase: 'planning' },
  { stage: 'approval', backendPhase: 'awaiting_approval' },
  { stage: 'provisioning', backendPhase: 'provisioning' },
  { stage: 'data', backendPhase: 'data_copy' },
  { stage: 'cutover', backendPhase: 'verification' },
  { stage: 'traffic', backendPhase: 'traffic' },
]

export function isStage(value: string | null): value is Stage {
  return value !== null && (STAGE_ORDER as string[]).includes(value)
}
