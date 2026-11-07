/**
 * 플랫폼 서버의 맥박(`GET /system/pulse`) 읽기. 웹 서버(`/api/pulse`)가 플랫폼에서 받아 화면에 넘긴다.
 * 플랫폼이 읽은 값만 그대로 보여 준다: 읽지 못한 값은 null이고, 화면은 꾸민 숫자를 만들지 않는다.
 * 런타임 import가 없어 단위 시험이 직접 읽는다.
 */
/** 원본 서버 또는 이전 서버가 보낸 값을 플랫폼이 합친 것(CPU 평균, 메모리 합계). 15초 넘게 안 오면 플랫폼이 null로 준다. */
export type Side = {
  cpu_percent: number
  mem_percent: number | null
  mem_used_mb: number
  mem_total_mb: number
  nodes: number
  age_seconds: number
}

export type Pulse = {
  at: string
  cpu_percent: number | null
  mem_percent: number | null
  mem_used_mb: number | null
  mem_total_mb: number | null
  load1: number | null
  cores: number | null
  errors_5m: number | null
  window_seconds: number
  source: Side | null // 원본 서버
  target: Side | null // 이전 서버
}

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const percent = (value: unknown): number | null => { const n = finite(value); return n === null ? null : Math.min(100, Math.max(0, n)) }
const count = (value: unknown): number | null => { const n = finite(value); return n === null ? null : Math.max(0, Math.round(n)) }

function parseSide(value: unknown): Side | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const cpu = percent(raw.cpu_percent)
  if (cpu === null) return null
  return {
    cpu_percent: cpu,
    mem_percent: percent(raw.mem_percent),
    mem_used_mb: count(raw.mem_used_mb) ?? 0,
    mem_total_mb: count(raw.mem_total_mb) ?? 0,
    nodes: count(raw.nodes) ?? 1,
    age_seconds: finite(raw.age_seconds) ?? 0,
  }
}

/** 응답이 맥박 모양이 아니면 null. 숫자가 아닌 값은 null로 바꾸고 퍼센트는 0~100으로 자른다. */
export function parsePulse(value: unknown): Pulse | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (typeof raw.at !== 'string') return null
  return {
    at: raw.at,
    cpu_percent: percent(raw.cpu_percent),
    mem_percent: percent(raw.mem_percent),
    mem_used_mb: count(raw.mem_used_mb),
    mem_total_mb: count(raw.mem_total_mb),
    load1: finite(raw.load1),
    cores: count(raw.cores),
    errors_5m: count(raw.errors_5m),
    window_seconds: count(raw.window_seconds) ?? 300,
    source: parseSide(raw.source),
    target: parseSide(raw.target),
  }
}

/** 달리는 자칼이 한 바퀴 도는 시간(초). CPU가 높을수록 빠르다(1.4초 → 0.25초). 모르면 0(멈춤). */
export function runSeconds(cpu: number | null): number {
  if (cpu === null) return 0
  return Math.round((1.4 - 1.15 * Math.min(100, Math.max(0, cpu)) / 100) * 100) / 100
}

export type PulseLevel = 'ok' | 'warn' | 'bad'

/** 자칼이 달리는 속도에 쓰는 CPU: 원본·이전 서버 중 더 바쁜 쪽. 둘 다 모르면 null(멈춤). 플랫폼 서버 값은 쓰지 않는다. */
export function busiestCpu(pulse: Pulse): number | null {
  const values = [pulse.source?.cpu_percent, pulse.target?.cpu_percent].filter((v): v is number => typeof v === 'number')
  return values.length ? Math.max(...values) : null
}

/** 위젯 색을 정하는 단계. 오류가 있으면 warn, 오류가 많거나 원본·이전 서버의 CPU·메모리가 90% 이상이면 bad. */
export function pulseLevel(pulse: Pulse): PulseLevel {
  const errors = pulse.errors_5m ?? 0
  const hot = [pulse.source, pulse.target].some(side => side && (side.cpu_percent >= 90 || (side.mem_percent ?? 0) >= 90))
  if (errors >= 5 || hot) return 'bad'
  return errors > 0 ? 'warn' : 'ok'
}

const TIMEOUT_MS = 3000

/** 플랫폼에서 맥박을 한 번 읽는다. 연결 실패·오류 응답·모양이 다른 응답은 null. */
export async function fetchPulse(base: string, fetchImpl: typeof fetch = fetch): Promise<Pulse | null> {
  if (!base) return null
  try {
    const response = await fetchImpl(base.replace(/\/+$/, '') + '/system/pulse', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return null
    return parsePulse(await response.json())
  } catch {
    return null
  }
}
