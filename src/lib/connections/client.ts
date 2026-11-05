import type { ApiErrorCode } from './types.ts'

/**
 * 브라우저 → 웹 서버(BFF) 호출. 브라우저는 플랫폼 API·운영자 키를 모른다: 같은 출처의 /api/* 만 부른다.
 * 응답 본문을 console·분석 도구로 보내지 않는다(등록 토큰이 들어 있을 수 있다).
 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: ApiErrorCode; detail: string | null }

const CODES: ApiErrorCode[] = ['operator_key', 'not_found', 'conflict', 'unavailable', 'bad_request', 'platform_error']

export async function api<T>(path: string, init: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: object; signal?: AbortSignal } = {}): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetch(path, {
      method: init.method ?? 'GET',
      headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
      body: init.body ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
      signal: init.signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    return { ok: false, status: 0, error: 'unavailable', detail: null }
  }
  const body = await response.json().catch(() => null) as ({ error?: unknown; detail?: unknown } & T) | null
  if (response.ok && body) return { ok: true, data: body }
  const error = CODES.includes(body?.error as ApiErrorCode) ? body!.error as ApiErrorCode
    : response.status === 403 ? 'operator_key' : response.status === 404 ? 'not_found' : response.status === 409 ? 'conflict' : response.status === 503 ? 'unavailable' : 'platform_error'
  return { ok: false, status: response.status, error, detail: typeof body?.detail === 'string' ? body.detail : null }
}

/** 개발 모드에서만 목업 데이터라는 표시를 띄운다 */
export const SHOW_MOCK_BADGE = process.env.NODE_ENV !== 'production'
