/**
 * 플랫폼 서버의 맥박(`GET /system/pulse`) 읽기. 웹 서버(`/api/pulse`)가 플랫폼에서 받아 화면에 넘긴다.
 * 플랫폼이 읽은 값만 그대로 보여 준다: 읽지 못한 값은 null이고, 화면은 꾸민 숫자를 만들지 않는다.
 * 런타임 import가 없어 단위 시험이 직접 읽는다.
 */
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
}

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const percent = (value: unknown): number | null => { const n = finite(value); return n === null ? null : Math.min(100, Math.max(0, n)) }
const count = (value: unknown): number | null => { const n = finite(value); return n === null ? null : Math.max(0, Math.round(n)) }

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
  }
}

/** 달리는 자칼이 한 바퀴 도는 시간(초). CPU가 높을수록 빠르다(1.4초 → 0.25초). 모르면 0(멈춤). */
export function runSeconds(cpu: number | null): number {
  if (cpu === null) return 0
  return Math.round((1.4 - 1.15 * Math.min(100, Math.max(0, cpu)) / 100) * 100) / 100
}

export type PulseLevel = 'ok' | 'warn' | 'bad'

/** 위젯 색을 정하는 단계. 오류가 있으면 warn, 오류가 많거나 CPU·메모리가 90% 이상이면 bad. */
export function pulseLevel(pulse: Pulse): PulseLevel {
  const errors = pulse.errors_5m ?? 0
  if (errors >= 5 || (pulse.cpu_percent ?? 0) >= 90 || (pulse.mem_percent ?? 0) >= 90) return 'bad'
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
