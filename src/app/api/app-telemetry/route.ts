import type { AppTelemetry, EnvTelemetry, Point, RouteErrors } from '../../../lib/telemetry'

export const dynamic = 'force-dynamic'

/**
 * 앱 관측(OpenTelemetry) 값: 플랫폼 Prometheus에 고정된 PromQL만 실행한다(브라우저가 쿼리를 보내지 않는다).
 * PROMETHEUS_URL이 없는 서버(목업·로컬)는 오류가 아니므로 204, 닿지 못하면 503이다.
 * 여러 화면이 동시에 물어도 2초에 한 번만 묻는다.
 */
const CACHE_MS = 2000
const WINDOW_S = 300
const STEP_S = 5
const RATE = '30s'
const TIMEOUT_MS = 4000

const DURATION = 'http_server_request_duration_seconds'
const QUERIES: Record<Exclude<keyof EnvTelemetry, 'env'>, string> = {
  rps: `sum by (app_env) (rate(${DURATION}_count[${RATE}]))`,
  // 5xx가 없던 구간도 0으로 나오게: 분자가 비면 같은 라벨의 0을 쓴다.
  error_rate: `(sum by (app_env) (rate(${DURATION}_count{http_response_status_code=~"5.."}[${RATE}])) or 0 * sum by (app_env) (rate(${DURATION}_count[${RATE}]))) / sum by (app_env) (rate(${DURATION}_count[${RATE}]))`,
  p99_ms: `histogram_quantile(0.99, sum by (app_env, le) (rate(${DURATION}_bucket[${RATE}]))) * 1000`,
  // 앱이 이름과 단위를 바로잡아 보낸 DB 쿼리 시간(ms). 풀에서 연결을 얻는 시간(acquire)은 빼고 쿼리만 본다.
  db_p99_ms: `histogram_quantile(0.99, sum by (app_env, le) (rate(app_db_operation_duration_milliseconds_bucket{pgx_operation_type="query"}[${RATE}])))`,
  pool_wait_ms: `sum by (app_env) (rate(db_client_pool_acquire_wait_seconds_total[${RATE}])) * 1000`,
}
const ERRORS = `sum by (app_env, http_route) (increase(${DURATION}_count{http_response_status_code=~"5.."}[1m])) > 0`

type PromSeries = { metric: Record<string, string>; values?: [number, string][]; value?: [number, string] }

let cached: { at: number; value: AppTelemetry } | null = null
let inflight: Promise<AppTelemetry | null> | null = null

async function prom(base: string, path: string, params: Record<string, string>): Promise<PromSeries[] | null> {
  const url = new URL(path, base)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null)
  if (!response?.ok) return null
  const body = await response.json().catch(() => null) as { status?: string; data?: { result?: PromSeries[] } } | null
  return body?.status === 'success' ? body.data?.result ?? [] : null
}

const toPoints = (values: [number, string][] = []): Point[] =>
  values.map(([t, v]) => [t, Number(v)] as Point).filter(([, v]) => Number.isFinite(v))

async function load(base: string): Promise<AppTelemetry | null> {
  const end = Math.floor(Date.now() / 1000)
  const range = { start: String(end - WINDOW_S), end: String(end), step: String(STEP_S) }
  const keys = Object.keys(QUERIES) as (keyof typeof QUERIES)[]
  const [errors, ...results] = await Promise.all([
    prom(base, '/api/v1/query', { query: ERRORS, time: String(end) }),
    ...keys.map(key => prom(base, '/api/v1/query_range', { query: QUERIES[key], ...range })),
  ])
  if (!errors || results.some(r => r === null)) return null
  const envs = new Map<string, EnvTelemetry>()
  const envOf = (name: string) => {
    let found = envs.get(name)
    if (!found) envs.set(name, found = { env: name, rps: [], error_rate: [], p99_ms: [], db_p99_ms: [], pool_wait_ms: [] })
    return found
  }
  keys.forEach((key, index) => {
    for (const series of results[index] ?? []) {
      const name = series.metric.app_env
      if (name) envOf(name)[key] = toPoints(series.values)
    }
  })
  const routeErrors: RouteErrors[] = errors
    .filter(s => s.metric.app_env && s.metric.http_route && s.value)
    .map(s => ({ env: s.metric.app_env, route: s.metric.http_route, count: Math.round(Number(s.value![1])) }))
    .filter(e => e.count > 0)
    .sort((a, b) => b.count - a.count)
  return {
    envs: [...envs.values()].filter(e => e.rps.length > 0 || e.db_p99_ms.length > 0).sort((a, b) => a.env.localeCompare(b.env)),
    errors: routeErrors,
    window_s: WINDOW_S,
    step_s: STEP_S,
    at: end,
  }
}

export async function GET() {
  const base = (process.env.PROMETHEUS_URL ?? '').trim()
  if (!base) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
  if (cached && Date.now() - cached.at < CACHE_MS) return Response.json(cached.value, { headers: { 'Cache-Control': 'no-store' } })
  inflight ??= load(base).finally(() => { inflight = null })
  const value = await inflight
  if (!value) return Response.json({ error: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  cached = { at: Date.now(), value }
  return Response.json(value, { headers: { 'Cache-Control': 'no-store' } })
}
