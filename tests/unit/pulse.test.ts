import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchPulse, parsePulse, pulseLevel, runSeconds } from '../../src/lib/pulse/pulse.ts'

const body = { at: '2026-11-07T03:00:00.000Z', cpu_percent: 42.5, mem_percent: 61, mem_used_mb: 4900, mem_total_mb: 8000, load1: 0.8, cores: 2, errors_5m: 0, window_seconds: 300 }
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

test('runSeconds: faster with more CPU, paused when unknown', () => {
  assert.equal(runSeconds(null), 0)
  assert.equal(runSeconds(0), 1.4)
  assert.equal(runSeconds(100), 0.25)
  assert.ok(runSeconds(80) < runSeconds(20))
  assert.equal(runSeconds(500), 0.25)
})

test('pulseLevel: ok, warn on any error, bad on many errors or a hot server', () => {
  assert.equal(pulseLevel(pulse({})), 'ok')
  assert.equal(pulseLevel(pulse({ errors_5m: 1 })), 'warn')
  assert.equal(pulseLevel(pulse({ errors_5m: 5 })), 'bad')
  assert.equal(pulseLevel(pulse({ cpu_percent: 95 })), 'bad')
  assert.equal(pulseLevel(pulse({ mem_percent: 91 })), 'bad')
  assert.equal(pulseLevel(pulse({ cpu_percent: null, mem_percent: null, errors_5m: null })), 'ok')
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
