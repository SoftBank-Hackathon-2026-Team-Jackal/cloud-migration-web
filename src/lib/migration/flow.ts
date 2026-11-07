/**
 * 데이터 복제 → DB 전환 → 트래픽 전환 → 완료 사이의 화면 이동 규칙. 순수 함수만 둔다(React 없음, 단위 시험 대상).
 *
 * 백엔드 Workflow 순서(cloud-migration-platform, 실제 리허설 migration-b0d3f658):
 *   data_copy(복제 · streaming) → cutover.plan + approval.required(gate=cutover) → POST /approve?gate=cutover(202, 아직이면 409 CUTOVER_NOT_READY)
 *   → cutover.ready·step·outcome·verify → traffic.prepare·ready·snapshot → 완료.
 * DB 전환 이벤트의 phase는 verification이고, 전환 뒤에도 data.phase가 phase data_copy로 온다(화면은 stageOf.ts가 type으로 고른다).
 * 목업 대본도 같은 순서로 흐른다.
 */
import type { MigrationState } from './reducer'
import type { Stage } from '../stages'

export type CutoverRunView = 'wait' | 'pause' | 'verify' | 'done' | 'refused' | 'mismatch'

/** 트래픽 이벤트를 하나라도 받았는지(백엔드는 DB 전환이 끝나야 트래픽을 시작한다) */
export function trafficStarted(state: MigrationState): boolean {
  return !!(state.traffic.snapshot || state.traffic.prepare || state.traffic.ready)
}

/**
 * DB가 대상으로 전환됐는지: cutover.outcome switched, 또는 트래픽이 이미 시작됨.
 * 롤백 뒤 다시 전환할 수 있게 되어 승인 요청이 새로 오면(cutoverRequired) 아직 전환하지 않은 것으로 본다.
 */
export function dbSwitched(state: MigrationState): boolean {
  if (state.approval.cutoverRequired) return false
  return state.cutover.outcome?.result === 'switched' || trafficStarted(state)
}

/**
 * 트래픽 단계가 끝났는지: 완료(complete·정리 끝)·롤백 스냅샷, 트래픽 실패(예: TRAFFIC_ROLLED_BACK), 또는 이전 전체 완료.
 * 전환 직후(0.3초 뒤) traffic.prepare가 오므로 "트래픽이 시작됐는지"로는 판단하지 않는다.
 */
export function trafficDone(state: MigrationState): boolean {
  const phase = state.traffic.snapshot?.phase
  return phase === 'complete' || phase === 'rolledback' || !!state.failures.traffic || state.status === 'done'
}

/** 데이터 화면 "다음": 언제나 DB 전환 화면. 이미 전환했으면(전환 뒤 데이터 화면에 돌아온 경우) 트래픽. */
export function dataNextStage(state: MigrationState): 'cutover' | 'traffic' {
  return dbSwitched(state) ? 'traffic' : 'cutover'
}

/**
 * DB 전환 승인 버튼의 상태.
 *  waiting  승인 요청(approval.required gate=cutover)이 아직 오지 않았다: "전환 준비 중(승인 요청 대기)"
 *  ready    승인할 수 있다
 *  sending  승인을 보내는 중(중복 클릭 막음)
 *  rejected 지난 승인이 거절됐다(409 CUTOVER_NOT_READY 등): 안내를 보이고 다시 누를 수 있다
 */
export type CutoverGate = 'waiting' | 'ready' | 'sending' | 'rejected'
export function cutoverGate(state: MigrationState, sending: boolean): CutoverGate {
  if (sending) return 'sending'
  if (!state.approval.cutoverRequired) return 'waiting'
  return state.requestErrors.cutover ? 'rejected' : 'ready'
}
export const canApproveCutover = (gate: CutoverGate) => gate === 'ready' || gate === 'rejected'

/**
 * DB 전환 화면에 들어올 때의 첫 모습: 승인 요청이 와 있거나 아직 전환을 시작하지 않았으면 승인 화면,
 * 전환이 시작됐거나 끝났으면 전환 결과(통과면 "트래픽 전환으로").
 */
export function cutoverEntry(state: MigrationState): 'approve' | 'run' {
  if (state.approval.cutoverRequired) return 'approve'
  const begun = !!state.cutover.ready || state.cutover.steps.length > 0 || !!state.cutover.outcome
  return begun || dbSwitched(state) ? 'run' : 'approve'
}

/**
 * 트래픽 화면이 기다리는 것. 트래픽 이벤트를 받았으면 null.
 *  cutover  DB 전환이 아직이다(승인할 DB 전환이 남았으면 DB 전환 화면으로 가는 버튼을 보인다)
 *  starting DB 전환은 끝났고 트래픽 시작을 기다린다
 */
export function trafficWait(state: MigrationState): 'cutover' | 'starting' | null {
  if (trafficStarted(state)) return null
  return dbSwitched(state) ? 'starting' : 'cutover'
}

/** 다시 접속(새로 고침·새 탭)했을 때 열 화면: 트래픽까지 끝났으면 완료 리포트, 아니면 마지막 이벤트 type의 화면. */
export function resumeStage(state: MigrationState): Stage {
  if (state.flowStage === 'traffic' && trafficDone(state)) return 'report'
  if (state.status === 'done') return 'report'
  return state.flowStage ?? 'analysis'
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
