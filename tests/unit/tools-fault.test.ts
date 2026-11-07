import assert from 'node:assert/strict'
import { test } from 'node:test'
import { faultActive, faultPhase, faultSettings, forward, parseFaultView, parseTrafficHealth } from '../../src/lib/tools/fault.ts'

const on = { id: 'a1', action: 'on', error_rate: 0.5, delay_ms: 800, duration_s: 300, requested_at: '2026-11-07T06:00:00Z' }
const observed = (extra: object = {}) => ({ active: true, error_rate: 0.5, delay_ms: 800, remaining_s: 280, applied_id: 'a1', error: null, ...extra })
const view = (extra: object) => parseFaultView({ at: '2026-11-07T06:00:05Z', desired: on, observed: observed(), observed_age_seconds: 1, applied: true, ...extra })!

test('parseFaultView keeps the platform values and drops odd shapes', () => {
  const parsed = view({})
  assert.equal(parsed.desired?.action, 'on')
  assert.equal(parsed.observed?.remaining_s, 280)
  assert.equal(parseFaultView({}), null)
  assert.equal(parseFaultView({ at: 'x', desired: { id: 'a', action: 'boom' } })!.desired, null)
})

test('faultPhase separates requested, applied, unknown and offline', () => {
  assert.equal(faultPhase(view({})), 'on')
  assert.equal(faultPhase(view({ applied: false, observed: observed({ active: false, applied_id: null }) })), 'pending')
  assert.equal(faultPhase(view({ applied: false, observed: observed({ error: 'status 403' }) })), 'failed')
  assert.equal(faultPhase(view({ observed: null })), 'relay_offline')
  assert.equal(faultPhase(view({ desired: null, applied: null, observed: observed({ active: null }) })), 'unknown')
  assert.equal(faultPhase(view({ desired: null, applied: null, observed: observed({ active: false }) })), 'off')
})

test('faultActive is true only when the target says so', () => {
  assert.equal(faultActive(view({})), true)
  assert.equal(faultActive(view({ observed: observed({ active: null }) })), false)
  assert.equal(faultActive(view({ observed: null })), false)
  assert.equal(faultActive(null), false)
})

test('faultSettings follows the platform limits', () => {
  assert.deepEqual(faultSettings({ error_rate: 0.5, delay_ms: 800, duration_s: 300 }), { error_rate: 0.5, delay_ms: 800, duration_s: 300 })
  for (const bad of [{ error_rate: 2, delay_ms: 0, duration_s: 60 }, { error_rate: 0, delay_ms: 0, duration_s: 60 },
    { error_rate: 0.5, delay_ms: 20000, duration_s: 60 }, { error_rate: 0.5, delay_ms: 0, duration_s: 901 }, { error_rate: '1' }, null]) {
    assert.equal(faultSettings(bad), null)
  }
})

test('parseTrafficHealth keeps unknown values as null', () => {
  const health = parseTrafficHealth({
    at: 'now', fresh: true, age_seconds: 2,
    summary: { origin: { requests: 10, failed: 0, error_rate: 0, p99_ms: 20, rps: 2 }, target: { requests: 0, failed: 0, error_rate: null, p99_ms: null, rps: 0 } },
    series: [{ at: 't', origin: { requests: 5, failed: 0, error_rate: 0, p99_ms: 20 }, target: { requests: 5, failed: 2, error_rate: 0.4, p99_ms: 1000 } }, 'junk'],
  })!
  assert.equal(health.summary.target.error_rate, null)
  assert.equal(health.series.length, 1)
  assert.equal(health.series[0].target.error_rate, 0.4)
  assert.equal(parseTrafficHealth({ at: 'now' }), null)
})

test('forward maps a closed switch to 404 and an unreachable platform to 503', async () => {
  const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch
  assert.deepEqual(await forward('', '/system/fault'), { status: 503, body: { error: 'unavailable' } })
  assert.deepEqual(await forward('http://p', '/system/fault', {}, reply(404, {})), { status: 404, body: { error: 'tools_disabled' } })
  assert.equal((await forward('http://p', '/system/fault', {}, reply(500, {}))).status, 500)
  const failing = (async () => { throw new Error('down') }) as typeof fetch
  assert.equal((await forward('http://p', '/system/fault', {}, failing)).status, 503)
  let seen: RequestInit | undefined
  const capture = (async (_url: string, init?: RequestInit) => { seen = init; return new Response('{"at":"x"}') }) as typeof fetch
  const ok = await forward('http://p/', '/system/fault', { method: 'POST', body: { error_rate: 1 } }, capture)
  assert.equal(ok.status, 200)
  assert.equal(seen?.method, 'POST')
  assert.equal(seen?.body, '{"error_rate":1}')
})
