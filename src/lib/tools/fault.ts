/**
 * 시연용 Tools 화면의 장애 스위치(`/system/fault`)와 원본·대상 건강 지표(`/system/traffic-health`) 읽기.
 * 웹 서버(`/api/tools/fault`, `/api/traffic-health`)가 플랫폼에서 받아 화면에 넘긴다.
 * 플랫폼이 보낸 값만 보여 준다: 모르는 값은 null이고, 화면은 꾸민 숫자를 만들지 않는다.
 * 런타임 import가 없어 단위 시험이 직접 읽는다.
 */

/** Tools 화면이 플랫폼에 남긴 명령. 중계 서버 리포터가 받아 가서 대상 앱에 적용한다. */
export type FaultCommand = {
  id: string
  action: 'on' | 'off'
  error_rate: number | null
  delay_ms: number | null
  duration_s: number | null
  requested_at: string
}

/** 리포터가 대상 앱에서 읽은 실제 상태. active가 null이면 대상 앱을 읽지 못했다. */
export type FaultObserved = {
  active: boolean | null
  error_rate: number | null
  delay_ms: number | null
  remaining_s: number | null
  applied_id: string | null
  error: string | null
}

export type FaultView = {
  at: string
  desired: FaultCommand | null
  observed: FaultObserved | null // 20초 넘게 보고가 없으면 null(중계 서버 리포터가 끊김)
  observed_age_seconds: number | null
  applied: boolean | null
}

/** 화면에 보일 한 줄 상태. */
export type FaultPhase = 'relay_offline' | 'pending' | 'on' | 'off' | 'unknown' | 'failed'

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const text = (value: unknown): string | null => typeof value === 'string' ? value : null
const rec = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

function parseCommand(value: unknown): FaultCommand | null {
  const raw = rec(value)
  if (!raw || typeof raw.id !== 'string' || (raw.action !== 'on' && raw.action !== 'off')) return null
  return {
    id: raw.id, action: raw.action,
    error_rate: finite(raw.error_rate), delay_ms: finite(raw.delay_ms), duration_s: finite(raw.duration_s),
    requested_at: text(raw.requested_at) ?? '',
  }
}

function parseObserved(value: unknown): FaultObserved | null {
  const raw = rec(value)
  if (!raw) return null
  return {
    active: typeof raw.active === 'boolean' ? raw.active : null,
    error_rate: finite(raw.error_rate), delay_ms: finite(raw.delay_ms), remaining_s: finite(raw.remaining_s),
    applied_id: text(raw.applied_id), error: text(raw.error),
  }
}

export function parseFaultView(value: unknown): FaultView | null {
  const raw = rec(value)
  if (!raw || typeof raw.at !== 'string') return null
  return {
    at: raw.at,
    desired: parseCommand(raw.desired),
    observed: parseObserved(raw.observed),
    observed_age_seconds: finite(raw.observed_age_seconds),
    applied: typeof raw.applied === 'boolean' ? raw.applied : null,
  }
}

/**
 * 지금 상태 한 줄. 명령을 보냈지만 리포터가 아직 적용하지 않았으면 pending,
 * 리포터 보고가 끊겼으면 relay_offline, 대상 앱을 읽지 못하면 unknown, 적용이 실패하면 failed.
 */
export function faultPhase(view: FaultView): FaultPhase {
  const observed = view.observed
  if (!observed) return 'relay_offline'
  if (view.desired && view.applied === false) return observed.error ? 'failed' : 'pending'
  if (observed.active === null) return 'unknown'
  return observed.active ? 'on' : 'off'
}

/** 장애가 실제로 켜져 있는가(배지용). 모르면 false: 켜졌다고 꾸미지 않는다. */
export function faultActive(view: FaultView | null): boolean {
  return Boolean(view?.observed?.active)
}

export type FaultSettings = { error_rate: number; delay_ms: number; duration_s: number }

/** 화면 입력 → 플랫폼 본문. 범위를 벗어나면 null(플랫폼과 같은 기준: 오류율 0~1, 지연 0~10000ms, 1~900초, 둘 중 하나는 0보다 크다). */
export function faultSettings(value: unknown): FaultSettings | null {
  const raw = rec(value)
  if (!raw) return null
  const errorRate = finite(raw.error_rate), delay = finite(raw.delay_ms), duration = finite(raw.duration_s)
  if (errorRate === null || delay === null || duration === null) return null
  if (errorRate < 0 || errorRate > 1 || delay < 0 || delay > 10000 || duration < 1 || duration > 900) return null
  if (!Number.isInteger(delay) || !Number.isInteger(duration) || (errorRate === 0 && delay === 0)) return null
  return { error_rate: errorRate, delay_ms: delay, duration_s: duration }
}

// ── 원본·대상 건강 지표 ──

export type SideSummary = { requests: number; failed: number; error_rate: number | null; p99_ms: number | null; rps: number | null }
export type SidePoint = { requests: number; failed: number; error_rate: number | null; p99_ms: number | null }
export type HealthPoint = { at: string; origin: SidePoint; target: SidePoint }
export type TrafficHealth = {
  at: string
  fresh: boolean // 마지막 보고가 20초 안에 왔는가. 아니면 summary 값은 모두 null
  age_seconds: number | null
  summary: { origin: SideSummary; target: SideSummary }
  series: HealthPoint[]
}

const count = (value: unknown) => Math.max(0, Math.round(finite(value) ?? 0))

function parseSummary(value: unknown): SideSummary {
  const raw = rec(value) ?? {}
  return { requests: count(raw.requests), failed: count(raw.failed), error_rate: finite(raw.error_rate), p99_ms: finite(raw.p99_ms), rps: finite(raw.rps) }
}

function parsePoint(value: unknown): SidePoint {
  const raw = rec(value) ?? {}
  return { requests: count(raw.requests), failed: count(raw.failed), error_rate: finite(raw.error_rate), p99_ms: finite(raw.p99_ms) }
}

export function parseTrafficHealth(value: unknown): TrafficHealth | null {
  const raw = rec(value)
  const summary = rec(raw?.summary)
  if (!raw || typeof raw.at !== 'string' || !summary) return null
  const series = Array.isArray(raw.series) ? raw.series : []
  return {
    at: raw.at,
    fresh: raw.fresh === true,
    age_seconds: finite(raw.age_seconds),
    summary: { origin: parseSummary(summary.origin), target: parseSummary(summary.target) },
    series: series.map(rec).filter((p): p is Record<string, unknown> => p !== null)
      .map(p => ({ at: text(p.at) ?? '', origin: parsePoint(p.origin), target: parsePoint(p.target) })),
  }
}

// ── 웹 서버에서 플랫폼으로 ──

const TIMEOUT_MS = 4000

export type Forwarded = { status: number; body: unknown }

/**
 * 플랫폼 `path`에 한 번 보낸다. 닿지 못하면 503. 플랫폼이 Tools를 꺼 두었으면(404) 그대로 404.
 * 응답 본문은 parse 함수가 다시 검사하므로 그대로 넘긴다.
 */
export async function forward(
  base: string, path: string, init: { method?: string; body?: unknown } = {}, fetchImpl: typeof fetch = fetch,
): Promise<Forwarded> {
  if (!base) return { status: 503, body: { error: 'unavailable' } }
  try {
    const response = await fetchImpl(base.replace(/\/+$/, '') + path, {
      method: init.method ?? 'GET',
      headers: { Accept: 'application/json', ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (response.status === 404) return { status: 404, body: { error: 'tools_disabled' } }
    const body = await response.json().catch(() => null)
    return response.ok ? { status: 200, body } : { status: response.status, body: { error: 'platform_error' } }
  } catch {
    return { status: 503, body: { error: 'unavailable' } }
  }
}
