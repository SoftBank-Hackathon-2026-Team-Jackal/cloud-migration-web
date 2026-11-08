import assert from 'node:assert/strict'
import { test } from 'node:test'
import { latest, parseAppTelemetry, peak } from '../../src/lib/telemetry.ts'

const env = { env: 'aws-eks', rps: [[100, 2], [105, 3]], error_rate: [[105, 0]], p99_ms: [[105, 12.5]], db_p99_ms: [[105, 1.2]], pool_wait_ms: [[100, 0], [105, 40]] }

test('parseAppTelemetry keeps the series and drops odd points', () => {
  const parsed = parseAppTelemetry({ envs: [{ ...env, rps: [[100, 2], ['x', 1], [105, 3], [1, 2, 3]] }], errors: [{ env: 'aws-eks', route: 'POST /api/messages', count: 4 }, { env: 1 }], window_s: 300, step_s: 5, at: 110 })!
  assert.deepEqual(parsed.envs[0].rps, [[100, 2], [105, 3]])
  assert.deepEqual(parsed.errors, [{ env: 'aws-eks', route: 'POST /api/messages', count: 4 }])
  assert.equal(parsed.window_s, 300)
})

test('parseAppTelemetry refuses a body without envs or errors', () => {
  assert.equal(parseAppTelemetry(null), null)
  assert.equal(parseAppTelemetry({ envs: [] }), null)
  assert.equal(parseAppTelemetry({ envs: [{ rps: [] }], errors: [] }), null)
})

test('a missing series is empty, not invented', () => {
  const parsed = parseAppTelemetry({ envs: [{ env: 'onprem-k3s' }], errors: [], at: 1 })!
  assert.deepEqual(parsed.envs[0].p99_ms, [])
})

test('latest is null when the app stopped sending; peak is the window maximum', () => {
  assert.equal(latest(env.rps as [number, number][], 110), 3)
  assert.equal(latest(env.rps as [number, number][], 200), null)
  assert.equal(peak(env.pool_wait_ms as [number, number][]), 40)
  assert.equal(peak([]), null)
})
