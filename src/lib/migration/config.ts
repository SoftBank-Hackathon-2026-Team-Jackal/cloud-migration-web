export type ApiMode = 'mock' | 'sse'

/** NEXT_PUBLIC_API_MODE=mock|sse (기본 mock). Next가 빌드 때 값을 넣으므로 process.env.NEXT_PUBLIC_* 를 그대로 적어야 한다. */
export function apiMode(): ApiMode {
  return process.env.NEXT_PUBLIC_API_MODE === 'sse' ? 'sse' : 'mock'
}

/** NEXT_PUBLIC_API_BASE (기본 http://127.0.0.1:8000) */
export function apiBase(): string {
  return (process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000').replace(/\/+$/, '')
}

/**
 * SSE 모드에서 이전을 어떻게 시작할지(NEXT_PUBLIC_SSE_START, 기본 wait).
 * - wait: 백엔드가 소스(source)를 아직 받지 못한다(cloud-migration-platform#60 전). POST /migrations를 부르지 않고 "백엔드 연결 대기"를 보여 준다.
 * - source: #60 이후. 고른 공개 저장소(source)가 있을 때만 POST /migrations를 부른다.
 * - legacy: 목업 SSE 서버(npm run mock:server) 시험 전용. 예전처럼 source 없이도 시작한다.
 */
export type SseStartMode = 'wait' | 'source' | 'legacy'
export function sseStartMode(): SseStartMode {
  const value = process.env.NEXT_PUBLIC_SSE_START
  return value === 'source' || value === 'legacy' ? value : 'wait'
}

/** 이 모드에서 이전을 시작하려면 고른 저장소(source)가 꼭 있어야 하는지 */
export function requiresSource(mode: ApiMode, start: SseStartMode = sseStartMode()): boolean {
  return mode === 'sse' && start !== 'legacy'
}
