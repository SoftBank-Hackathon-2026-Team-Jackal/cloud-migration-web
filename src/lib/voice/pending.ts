/**
 * 되묻는 확인(pending)을 언제 세우고 언제 거두는지. 런타임 import 없음(단위 테스트가 직접 읽는다).
 * 안정화 구간 알림("롤백할까요?")이 세운 롤백 확인은 그 알림이 유효한 동안만 산다:
 * 대상이 회복했거나, 트래픽이 확정·완료돼 안정화 구간을 벗어났거나, 자칼이 다른 것을 물으면 거둔다.
 * 그러지 않으면 뒤의 "응"(예: "리포트로 갈까요?"에 대한 대답)이 끝난 이전을 롤백한다.
 */
import type { CommandId } from './commands.ts'
import type { MigrationEvent } from '../migration/events.ts'

export type Pending = { command: CommandId; until: number; alert?: boolean } | null

/** 안정화 구간 알림 뒤에 "응"만으로 롤백을 승인할 수 있는 시간 */
export const ALERT_CONFIRM_MS = 30000
/** 자칼이 먼저 롤백할지 묻는 보고 */
export const ROLLBACK_ASKS = new Set(['r.traffic.alertError', 'r.traffic.alertP99'])
/** 롤백 확인을 거두는 보고: 회복, 완료, 이미 되돌림 */
const ROLLBACK_SETTLED = new Set([
  'r.traffic.recovered', 'r.traffic.done', 'r.traffic.rollback', 'r.traffic.rollbackP99', 'r.traffic.rollbackFailed',
  'r.traffic.rollbackRequests', 'r.traffic.rollbackManual', 'r.traffic.dbRollback', 'r.migration.done',
])

/**
 * 보고 하나를 말할 때의 확인 대기.
 * - 롤백을 묻는 알림이면(아직 안정화 구간일 때만) 롤백 확인을 세운다.
 * - 회복·완료·되돌림 보고면 롤백 확인을 거둔다.
 * - 다른 질문(asks)을 하면 알림이 세운 확인을 거둔다: 그다음 대답은 새 질문에 대한 것이다.
 */
export function pendingOnReport(pending: Pending, report: { key: string; asks: boolean }, now: number, trafficPhase: string | null): Pending {
  if (ROLLBACK_ASKS.has(report.key)) {
    return trafficPhase === null || trafficPhase === 'stabilizing' ? { command: 'rollback', until: now + ALERT_CONFIRM_MS, alert: true } : pending
  }
  if (pending?.command === 'rollback' && ROLLBACK_SETTLED.has(report.key)) return null
  if (pending?.alert && report.asks) return null
  return pending
}

/** 이벤트가 오면: 대상이 회복했거나 트래픽이 안정화 구간을 벗어났으면 알림이 세운 롤백 확인을 거둔다. */
export function pendingOnEvent(pending: Pending, event: MigrationEvent): Pending {
  if (!pending?.alert) return pending
  if (event.type === 'traffic.alert' && event.data.state === 'recovered') return null
  if (event.type === 'traffic.snapshot' && event.data.phase !== 'stabilizing') return null
  return pending
}
