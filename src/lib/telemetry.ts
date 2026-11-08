/**
 * 앱 관측(OpenTelemetry): 이전 대상 데모 앱이 OTLP로 보낸 메트릭을 플랫폼 Prometheus에서 읽은 값.
 * 트래픽 전환 판정(중계 서버 Envoy)과는 별개다. 앱 안쪽(API별 지연, DB 쿼리, 커넥션 풀)을 보여 주는 용도다.
 * 환경은 앱의 ENV_NAME(app_env 라벨, 예: aws-eks · onprem-k3s)으로 나뉜다.
 */

/** [unix 초, 값] */
export type Point = [number, number]

export type EnvTelemetry = {
  env: string
  /** 초당 요청 수 */
  rps: Point[]
  /** 5xx 비율(0~1). 요청이 없던 구간은 빠진다 */
  error_rate: Point[]
  /** API 응답 p99(ms) */
  p99_ms: Point[]
  /** DB 쿼리 p99(ms) */
  db_p99_ms: Point[]
  /** 커넥션 풀에서 연결을 기다린 시간(초당 ms). DB 전환 중 PgBouncer PAUSE 동안 튄다 */
  pool_wait_ms: Point[]
}

export type RouteErrors = { env: string; route: string; count: number }

export type AppTelemetry = {
  envs: EnvTelemetry[]
  /** 최근 1분 동안 5xx를 낸 API */
  errors: RouteErrors[]
  window_s: number
  step_s: number
  /** 서버가 값을 만든 시각(unix 초) */
  at: number
}

const SERIES_KEYS = ['rps', 'error_rate', 'p99_ms', 'db_p99_ms', 'pool_wait_ms'] as const

const isPoint = (value: unknown): value is Point =>
  Array.isArray(value) && value.length === 2 && value.every(n => typeof n === 'number' && Number.isFinite(n))

/** 응답 모양을 검사한다. 맞지 않으면 null(화면은 값을 꾸미지 않는다). */
export function parseAppTelemetry(raw: unknown): AppTelemetry | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (!Array.isArray(value.envs) || !Array.isArray(value.errors)) return null
  const envs: EnvTelemetry[] = []
  for (const item of value.envs) {
    if (!item || typeof item !== 'object' || typeof (item as { env?: unknown }).env !== 'string') return null
    const env = item as Record<string, unknown>
    const series = Object.fromEntries(SERIES_KEYS.map(key => [key, Array.isArray(env[key]) ? (env[key] as unknown[]).filter(isPoint) : []]))
    envs.push({ env: env.env as string, ...series } as EnvTelemetry)
  }
  const errors = value.errors.filter((e): e is RouteErrors => !!e && typeof e === 'object'
    && typeof (e as RouteErrors).env === 'string' && typeof (e as RouteErrors).route === 'string' && typeof (e as RouteErrors).count === 'number')
  const num = (key: string) => typeof value[key] === 'number' ? value[key] as number : 0
  return { envs, errors, window_s: num('window_s'), step_s: num('step_s'), at: num('at') }
}

/** 마지막 값. 마지막 점이 `staleS`초보다 오래됐으면 null(앱이 더 이상 보내지 않는다) */
export function latest(points: Point[], at: number, staleS = 30): number | null {
  const last = points[points.length - 1]
  return last && at - last[0] <= staleS ? last[1] : null
}

/** 구간 최댓값(없으면 null) */
export function peak(points: Point[]): number | null {
  return points.length ? Math.max(...points.map(p => p[1])) : null
}
