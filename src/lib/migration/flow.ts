/**
 * 데이터 → DB 전환 → 트래픽 → 완료 사이의 화면 이동 규칙. 순수 함수만 둔다(React 없음, 단위 시험 대상).
 *
 * 플랫폼 실제 순서(cloud-migration-platform apps/worker/src/cmp_worker/workflows/migration.py):
 *   provisioning → data_copy(복제 · streaming이면 2차 승인 요청 → switchover = DB 전환) → traffic → verification → 완료.
 * DB 전환(cutover.*)은 data_copy 안의 DataMigrationWorkflow가 내고, 웹 단계 이름으로는 verification phase로 온다.
 * 목업 대본은 예전 순서(데이터 → 트래픽 → 전환)를 그대로 쓴다: 규칙은 이벤트만 보고 고르므로 목업 동작은 바뀌지 않는다.
 */
import type { MigrationState } from './reducer'

export type CutoverRunView = 'wait' | 'pause' | 'verify' | 'done' | 'refused' | 'mismatch'

const switched = (state: MigrationState) => state.cutover.outcome?.result === 'switched'
/** 트래픽 단계가 시작됐는지(준비·사전 확인·스냅샷 중 하나라도 왔으면). */
const trafficStarted = (state: MigrationState) => !!(state.traffic.snapshot || state.traffic.prepare || state.traffic.ready)

/**
 * 데이터 화면 "다음": 복제 중에 2차 승인(DB 전환) 요청이 왔으면(실제 순서) 전환 화면, 아니면 트래픽.
 * 이미 전환을 마쳤으면(전환 뒤 데이터 화면으로 돌아온 경우) 트래픽.
 */
export function dataNextStage(state: MigrationState): 'cutover' | 'traffic' {
  if (switched(state)) return 'traffic'
  return state.cutover.dbFirst && (state.approval.cutoverRequired || state.cutover.plan !== null) ? 'cutover' : 'traffic'
}

/** 전환 화면 "다음": DB 전환을 먼저 했고 트래픽이 아직이면 트래픽, 아니면 완료 리포트. */
export function cutoverAfter(state: MigrationState): 'traffic' | 'report' {
  return state.cutover.dbFirst && switched(state) && !trafficStarted(state) && state.status !== 'done' ? 'traffic' : 'report'
}

/** 전환 화면에 들어올 때의 첫 모습: DB 전환을 마치고 트래픽까지 지나왔으면 바로 완료 리포트. */
export function cutoverEntry(state: MigrationState): 'approve' | 'report' {
  return state.cutover.dbFirst && switched(state) && trafficStarted(state) ? 'report' : 'approve'
}

/**
 * 전환 실행 화면의 지금 상태(제목·문구·다음 버튼). replaying: 쓰기 중단 구간을 다시 보여 주는 중.
 * - 검증 표(cutover.verify)가 모두 일치하면 통과. 검증을 끈 전환(verify=none)은 표 없이 검증 단계(state=verify)만 온다.
 * - 인계(handover): 계획에도 이벤트에도 항목이 없으면(플랫폼 계획 handover=[]) 기다리지 않는다.
 */
export function cutoverRunView(cutover: MigrationState['cutover'], replaying: boolean): CutoverRunView {
  if (cutover.steps.length === 0) return 'wait'
  if (!cutover.outcome || replaying) return 'pause'
  if (cutover.outcome.result === 'refused') return 'refused'
  // fast는 PAUSE 안에서 체크섬을 보지 않으므로 변조(tamper)는 전환 뒤 검증에서 불일치로 드러난다.
  if (cutover.tables.some(table => table.checksum === 'mismatch') || cutover.results.some(result => result.ok === false)) return 'mismatch'
  const tablesOk = cutover.tables.length > 0
    ? cutover.tables.every(table => table.checksum === 'match')
    : cutover.verifying && cutover.results.length === 0
  const expected = cutover.plan?.handover.length ?? 0
  const handoverDone = expected === 0 && cutover.handover.length === 0
    ? true
    : cutover.handover.length > 0 && cutover.handover.every(item => item.state === 'done')
  return tablesOk && handoverDone ? 'done' : 'verify'
}

/** 완료 리포트의 실제 쓰기 중단 시간(ms): 리포트 API의 cutover_outcome이 먼저, 없으면 받은 cutover.outcome. 전환하지 않았으면 null. */
export function reportPauseMs(state: MigrationState): number | null {
  const outcome = state.report?.cutover_outcome ?? state.cutover.outcome
  return outcome?.result === 'switched' ? outcome.pause_ms : null
}
