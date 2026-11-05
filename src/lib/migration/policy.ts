/**
 * 정책 기본값 [가정]. 전환 단계·예상 쓰기 중단 같은 rollout 값은 계획 시점에 백엔드가 알지 못한다(실행 정책 스냅샷에서 정해진다).
 * 계획이 rollout을 보내지 않으면 화면은 이 값을 '정책 기본값'으로 표시해 보인다. 값은 컴포넌트가 아니라 여기 한 곳에 둔다.
 * 순수 데이터만 둔다(런타임 import 없음).
 */
import type { PlanRollout } from './events'

export const ROLLOUT_POLICY_DEFAULTS: Required<Pick<PlanRollout, 'traffic_steps' | 'expected_write_pause_ms' | 'data_method'>> = {
  /** trafficSim의 TRAFFIC_STEPS와 같다 */
  traffic_steps: [10, 50, 100],
  /** DB 전환 순간 쓰기 중단 목표(정책 상한) */
  expected_write_pause_ms: 1000,
  data_method: 'DUMP_CDC',
}

/**
 * Preview pending_decisions의 code가 승인 요약의 어느 줄에 들어가는지.
 * rollback: 롤백·정리 정책 줄 · excluded: '이번 범위에서 제외 · 한계' 목록. 모르는 code는 제외 목록에 code 그대로 보인다.
 */
export const PENDING_DECISION_ROW: Record<string, 'rollback' | 'excluded'> = {
  CLEANUP_POLICY_REQUIRED: 'rollback',
  INSPECTION_REQUIRED: 'excluded',
  USER_SECRET_REQUIRED: 'excluded',
  EXPLICIT_TARGET_REQUIRED: 'excluded',
}
