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

export function isStage(value: string | null): value is Stage {
  return value !== null && (STAGE_ORDER as string[]).includes(value)
}
