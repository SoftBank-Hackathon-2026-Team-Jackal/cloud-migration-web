import type { BackendPhase, StartRequest, Target } from './events'
import type { Action } from './reducer'

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
  /** 두 번째 승인(DB 전환) */
  approveCutover(): void
  cancel(): void
  rollbackTraffic(): void
  /** 롤백된 트래픽 이전을 처음부터 다시 시도한다. */
  retryTraffic(): void
  /** 데모 전용 장애 주입. 목업에서만 동작한다. */
  injectFailure(): void
  loadReport(): void
  dispose(): void
}
