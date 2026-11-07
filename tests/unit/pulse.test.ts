import assert from 'node:assert/strict'
import { test } from 'node:test'
import { busiestCpu, fetchPulse, parsePulse, pulseLevel, runSeconds } from '../../src/lib/pulse/pulse.ts'

const side = (cpu: number, mem: number) => ({ cpu_percent: cpu, mem_percent: mem, mem_used_mb: 1000, mem_total_mb: 4000, nodes: 2, age_seconds: 1.2 })
const body = {
  at: '2026-11-07T03:00:00.000Z', cpu_percent: 42.5, mem_percent: 61, mem_used_mb: 4900, mem_total_mb: 8000, load1: 0.8, cores: 2,
  errors_5m: 0, window_seconds: 300, source: side(20, 40), target: side(10, 30),
}
const pulse = (extra: object) => parsePulse({ ...body, ...extra })!

test('parsePulse keeps real values and turns non-numbers into null', () => {
  assert.deepEqual(parsePulse(body), body)
  const odd = parsePulse({ ...body, cpu_percent: 'x', mem_percent: null, errors_5m: NaN })!
  assert.equal(odd.cpu_percent, null)
  assert.equal(odd.mem_percent, null)
  assert.equal(odd.errors_5m, null)
})

test('parsePulse clamps percents to 0..100 and counts to whole non-negative numbers', () => {
  const clamped = pulse({ cpu_percent: 180, mem_percent: -5, errors_5m: 2.6 })
  assert.equal(clamped.cpu_percent, 100)
  assert.equal(clamped.mem_percent, 0)
  assert.equal(clamped.errors_5m, 3)
})

test('parsePulse refuses a body that is not a pulse', () => {
  for (const bad of [null, undefined, 'x', 5, {}, { cpu_percent: 1 }]) assert.equal(parsePulse(bad), null)
})

test('a missing, null or malformed source/target side becomes null (shown as a dash)', () => {
  const { source: _s, target: _t, ...old } = body
  void _s; void _t
  const without = parsePulse(old)!
  assert.equal(without.source, null)
  assert.equal(without.target, null)
  assert.equal(pulse({ source: null }).source, null)
  assert.equal(pulse({ target: 'x' }).target, null)
  assert.equal(pulse({ source: { cpu_percent: 'x' } }).source, null)
  assert.equal(pulse({ source: { cpu_percent: 250, mem_percent: 400 } }).source?.cpu_percent, 100)
})

test('runSeconds: faster with more CPU, paused when unknown', () => {
  assert.equal(runSeconds(null), 0)
  assert.equal(runSeconds(0), 1.4)
  assert.equal(runSeconds(100), 0.25)
  assert.ok(runSeconds(80) < runSeconds(20))
  assert.equal(runSeconds(500), 0.25)
})

test('busiestCpu is the busier of source and target, and ignores the platform server', () => {
  assert.equal(busiestCpu(pulse({ source: side(20, 1), target: side(70, 1), cpu_percent: 99 })), 70)
  assert.equal(busiestCpu(pulse({ source: side(35, 1), target: null })), 35)
  assert.equal(busiestCpu(pulse({ source: null, target: null, cpu_percent: 99 })), null)
})

test('pulseLevel: ok, warn on any error, bad on many errors or a hot source/target server', () => {
  assert.equal(pulseLevel(pulse({})), 'ok')
  assert.equal(pulseLevel(pulse({ errors_5m: 1 })), 'warn')
  assert.equal(pulseLevel(pulse({ errors_5m: 5 })), 'bad')
  assert.equal(pulseLevel(pulse({ source: side(95, 10) })), 'bad')
  assert.equal(pulseLevel(pulse({ target: side(10, 91) })), 'bad')
  assert.equal(pulseLevel(pulse({ cpu_percent: 99, mem_percent: 99 })), 'ok') // 플랫폼 서버 값은 색을 정하지 않는다
  assert.equal(pulseLevel(pulse({ source: null, target: null, errors_5m: null })), 'ok')
})

test('fetchPulse reads the platform path and returns null on failure', async () => {
  let url = ''
  const ok = (async (u: string) => { url = u; return Response.json(body) }) as unknown as typeof fetch
  assert.deepEqual(await fetchPulse('http://api:8000/', ok), body)
  assert.equal(url, 'http://api:8000/system/pulse')
  assert.equal(await fetchPulse('', ok), null)
  assert.equal(await fetchPulse('http://api', (async () => new Response('x', { status: 500 })) as unknown as typeof fetch), null)
  assert.equal(await fetchPulse('http://api', (async () => { throw new Error('down') }) as unknown as typeof fetch), null)
  assert.equal(await fetchPulse('http://api', (async () => Response.json({ nope: 1 })) as unknown as typeof fetch), null)
})
