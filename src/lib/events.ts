import type { Stage } from './stages'

/**
 * 백엔드 SSE로 받을 공통 이벤트 형식(제안).
 * 지금 화면은 데모 스크립트가 같은 모양의 값을 만들어 쓰고, 실제 연결 시 이 형식으로 바꿔 끼우면 된다.
 */
export type FlowEvent<T = unknown> = {
  type: string
  stage: Stage
  status: 'running' | 'done' | 'failed' | 'waiting'
  progress?: number
  message: string
  data?: T
}

/** 트래픽 이전 단계에서 화면이 받는 값(제안). */
export type TrafficSnapshot = {
  weights: { origin: number; target: number }
  step: number
  gate: {
    failedRequests: number
    maxFailedRequests: number
    p99Ratio: number
    maxP99Ratio: number
    observeLeftSeconds: number
  }
  decision?: 'advance' | 'rollback' | 'done'
}
