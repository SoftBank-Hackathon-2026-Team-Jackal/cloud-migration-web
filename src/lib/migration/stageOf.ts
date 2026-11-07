/**
 * 받은 이벤트로 "지금 열어야 할 화면"을 고른다. 순수 함수만 둔다(React 없음, 단위 시험 대상).
 *
 * 화면은 이벤트 phase가 아니라 이벤트 type으로 정한다. 백엔드(cloud-migration-platform)는
 * DB 전환 이벤트(cutover.*·approval.required gate=cutover)를 phase verification으로 보내고,
 * 전환 뒤에도 data.phase(streaming)를 phase data_copy로 계속 보낸다. phase로 고르면 화면이 데이터로 되돌아간다.
 *
 * 백엔드 Workflow 순서: … → 구축 → 데이터 복제(data.*) → DB 전환(cutover.*) → 트래픽(traffic.*) → 완료.
 * 데이터 복제부터는 앞으로만 간다. 다만 DB 전환 승인 요청(롤백 뒤 다시 전환할 수 있게 됨)은 언제 와도 DB 전환 화면이다.
 */
import type { BackendPhase, MigrationEvent } from './events.ts'
import type { Stage } from '../stages.ts'

/** 데이터 복제부터의 화면(이 안에서는 뒤로 가지 않는다) */
const TAIL: readonly Stage[] = ['data', 'cutover', 'traffic']

/** type으로 알 수 없는 이벤트(error 등)가 데이터 복제 전 phase에서 오면 그 phase의 화면 */
const EARLY_STAGE_OF_PHASE: Partial<Record<BackendPhase, Stage>> = {
  analysis: 'analysis', build: 'rehearsal', planning: 'planning', awaiting_approval: 'approval', provisioning: 'provisioning',
}

/** 이 이벤트가 속한 화면. 화면을 바꾸지 않는 이벤트(snapshot·error 등 데이터 복제 뒤 phase)면 null. */
export function stageOfEvent(event: Pick<MigrationEvent, 'type' | 'phase' | 'data'>): Stage | null {
  const type = event.type
  if (type === 'approval.required') return (event.data as { gate?: string } | null)?.gate === 'cutover' ? 'cutover' : 'approval'
  if (type === 'approval.decision') return 'approval'
  if (type.startsWith('data.')) return 'data'
  if (type.startsWith('cutover.')) return 'cutover'
  if (type.startsWith('traffic.')) return 'traffic'
  if (type.startsWith('analysis.')) return 'analysis'
  if (type.startsWith('build.') || type.startsWith('sandbox.')) return 'rehearsal'
  if (type.startsWith('plan.')) return 'planning'
  if (type.startsWith('provision.')) return 'provisioning'
  if (type === 'snapshot') return null
  return EARLY_STAGE_OF_PHASE[event.phase] ?? null
}

/** 지금 화면(current)에서 이벤트 하나를 받은 뒤의 화면. */
export function nextFlowStage(current: Stage | null, event: Pick<MigrationEvent, 'type' | 'phase' | 'data'>): Stage | null {
  const stage = stageOfEvent(event)
  if (!stage) return current
  if (!current) return stage
  // DB 전환 승인 요청은 언제 와도 DB 전환 화면(사람이 눌러야 다음으로 간다).
  if (stage === 'cutover' && event.type === 'approval.required') return stage
  const from = TAIL.indexOf(current)
  if (from < 0) return stage
  const to = TAIL.indexOf(stage)
  // 데이터 복제 뒤에는 앞 단계 이벤트(늦게 온 확인 등)로 돌아가지 않고, 복제 안에서는 앞으로만 간다.
  return to > from ? stage : current
}
