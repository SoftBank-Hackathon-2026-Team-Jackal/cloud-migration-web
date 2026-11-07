import type { BackendPhase, StartRequest, Target } from './events'
import type { Action } from './reducer'
import type { ReviewDecision, ReviewResult, ReviewView } from './review'

/** 공급자가 상태를 바꾸는 유일한 통로. 이벤트도 연결 상태도 모두 reducer 액션으로 보낸다. */
export type ProviderHost = { dispatch: (action: Action) => void }

export type EnterContext = { target: Target }

/**
 * 화면이 쓰는 데이터 공급자. 목업(타이머 대본)과 SSE(서버 이벤트)가 같은 인터페이스를 구현한다.
 * 화면은 어느 쪽인지 모르고 useMigration()의 상태만 읽는다.
 */
export interface MigrationProvider {
  readonly mode: 'mock' | 'sse'
  /** 이전을 시작한다(설정 화면의 "시작"). 이전 값은 모두 지운다. */
  start(request: StartRequest): void
  /** 이미 돌고 있는 이전에 다시 붙는다(새로 고침·새 탭). 목업은 아무것도 하지 않는다. */
  attach(migrationId: string): void
  /**
   * 단계 화면이 준비됐음을 알린다. 목업은 이때부터 그 단계의 대본을 흘리고, SSE는 연결이 없으면 연결한다.
   * 반환한 함수는 화면을 떠날 때 부른다(목업은 타이머를 멈추고 그 단계 값을 비운다).
   */
  enter(phase: BackendPhase, context: EnterContext): () => void
  /** 계획 승인. revision은 승인하는 계획의 버전(서버가 다른 버전이면 거절한다). */
  approve(revision?: number): void
  /** 계획 수정 요청: 계획 단계를 revision + 1로 다시 받는다. */
  revisePlan(): void
  /** 사람 검토 뒤 샌드박스 재시도 */
  retrySandbox(): void
  /**
   * 두 번째 승인(DB 전환). 받아들여지면(202) true, 거절되면(409 CUTOVER_NOT_READY·404·503·네트워크) false.
   * 거절은 이전 전체 실패가 아니라 전환 화면의 요청 오류(requestErrors.cutover)로 남는다.
   */
  approveCutover(): Promise<boolean>
  cancel(): void
  rollbackTraffic(): void
  /** 롤백된 트래픽 이전을 처음부터 다시 시도한다. */
  retryTraffic(): void
  /**
   * 수동 단계 대기 중(awaitNext)에 다음 단계로 넘긴다(POST /traffic/advance). 응답이 올 때까지 기다린다.
   * 409 TRAFFIC_ACTION_NOT_ALLOWED(이미 넘어감)는 조용히 넘기고, 다른 오류는 롤백·재시도와 같이 처리한다.
   */
  advanceTraffic(): Promise<void>
  /** 안정화 구간을 끝내고 이전을 확정한다(POST /traffic/finalize). */
  finalizeTraffic(): void
  /** 데모 전용 장애 주입. 목업에서만 동작한다. */
  injectFailure(): void
  loadReport(): void
  /**
   * 분석 검토 게이트(필수 기능 확정 → 손실·보안 승인)의 지금 상태. 이 이전에 검토가 없거나 서버에 그 API가 없으면 null.
   * 지금 읽지 못했으면(네트워크·서버 오류) undefined: 화면은 아직 모르는 것으로 보고 다시 읽는다.
   * 목업은 검토 단계가 없어 늘 null이다.
   */
  loadReview(): Promise<ReviewView | null | undefined>
  /** 필수 기능 확정: 모든 행의 필수 여부(행 ID → true/false). 서버 거절은 코드로 돌려준다(화면에 문구를 보인다). */
  confirmReview(required: Record<string, boolean>): Promise<ReviewResult>
  /** 손실·보안 승인: 승인이 필요한 모든 항목의 승인·거절. */
  approveReview(approvals: Record<string, ReviewDecision>): Promise<ReviewResult>
  dispose(): void
}
