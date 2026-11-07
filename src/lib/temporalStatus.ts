/** Temporal 사이드바(로컬 데모 전용) 아이콘에 쓰는 이전 한 건 전체의 상태. */
export type TemporalStatus = 'idle' | 'running' | 'done' | 'failed' | 'error'

/** 하나라도 실행 중이면 running, 실패·강제 종료·시간 초과가 있으면 failed, 모두 끝났으면 done */
export function temporalStatusOf(workflows: readonly { status: string }[]): TemporalStatus {
  if (!workflows.length) return 'idle'
  if (workflows.some(w => w.status === 'RUNNING')) return 'running'
  if (workflows.some(w => ['FAILED', 'TERMINATED', 'TIMED_OUT'].includes(w.status))) return 'failed'
  return 'done'
}
