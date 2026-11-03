export type ApiMode = 'mock' | 'sse'

/** NEXT_PUBLIC_API_MODE=mock|sse (기본 mock). Next가 빌드 때 값을 넣으므로 process.env.NEXT_PUBLIC_* 를 그대로 적어야 한다. */
export function apiMode(): ApiMode {
  return process.env.NEXT_PUBLIC_API_MODE === 'sse' ? 'sse' : 'mock'
}

/** NEXT_PUBLIC_API_BASE (기본 http://127.0.0.1:8000) */
export function apiBase(): string {
  return (process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000').replace(/\/+$/, '')
}
