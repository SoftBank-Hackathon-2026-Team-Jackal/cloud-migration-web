import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import Ajv from 'ajv/dist/2020.js'
import { initialState, reducer } from '../../src/lib/migration/reducer.ts'
import type { MigrationEvent } from '../../src/lib/migration/events.ts'
import { REDTEAM_MAX_ROUNDS, redteamDeclined, redteamRun, redteamWaiting, type RedTeamScenario } from '../../src/lib/migration/redteamScript.ts'
import { CAPABILITIES, SSE_CAPABILITIES, capabilitiesFor } from '../../src/lib/migration/capabilities.ts'

let seq = 0
const apply = (state: typeof initialState, draft: ReturnType<typeof redteamWaiting>) => {
  seq += 1
  return reducer(state, { type: 'event', event: { ...draft, seq, at: '2026-11-07T00:00:00.000Z' } as MigrationEvent })
}
const dataOf = (draft: ReturnType<typeof redteamWaiting>) => (draft as { data: { phase: string; findings: Array<{ state: string; severity: string }>; round: number; status: string | null; code: string | null } }).data

test('the sandbox state starts without a red team and keeps the latest red team event', () => {
  assert.equal(initialState.sandbox.redteam, null)
  const waiting = apply(initialState, redteamWaiting())
  assert.equal(waiting.sandbox.redteam?.phase, 'WAITING_FOR_APPROVAL')
  assert.equal(waiting.sandbox.redteam?.request?.intensity, 'ACTIVE')
  assert.equal(waiting.sandbox.redteam?.request?.wait_seconds, 600)
})

test('declining ends without an attack and says why', () => {
  const [only, ...rest] = redteamDeclined()
  assert.equal(rest.length, 0)
  const data = dataOf(only.event as never)
  assert.equal(data.phase, 'DONE')
  assert.equal(data.status, 'SKIPPED')
  assert.equal(data.code, 'REDTEAM_DECLINED')
  assert.equal(data.findings.length, 0)
})

test('every scenario runs forward in time and ends in one DONE event', () => {
  for (const scenario of ['fix', 'clean', 'open'] as RedTeamScenario[]) {
    const steps = redteamRun(scenario)
    assert.ok(steps.every((step, i) => i === 0 || step.after > steps[i - 1].after), scenario)
    const phases = steps.map(step => dataOf(step.event as never).phase)
    assert.equal(phases.at(-1), 'DONE', scenario)
    assert.equal(phases.filter(p => p === 'DONE').length, 1, scenario)
    assert.ok(steps.every(step => dataOf(step.event as never).round <= REDTEAM_MAX_ROUNDS), scenario)
  }
})

test('fix scenario: three weaknesses found, all fixed by security round 2', () => {
  const last = dataOf(redteamRun('fix').at(-1)!.event as never)
  assert.equal(last.status, 'FIXED')
  assert.equal(last.round, 2)
  assert.equal(last.findings.length, 3)
  assert.ok(last.findings.every(f => f.state === 'FIXED'))
})

test('open scenario: a weakness can stay open after the third round without blocking', () => {
  const last = dataOf(redteamRun('open').at(-1)!.event as never)
  assert.equal(last.status, 'STILL_OPEN')
  assert.equal(last.round, REDTEAM_MAX_ROUNDS)
  assert.equal(last.findings.filter(f => f.state === 'STILL_OPEN').length, 1)
})

test('clean scenario finds nothing', () => {
  const last = dataOf(redteamRun('clean').at(-1)!.event as never)
  assert.equal(last.status, 'CLEAN')
  assert.equal(last.findings.length, 0)
})

test('the red team approval is a mock-only capability until the backend has the API', () => {
  assert.ok(CAPABILITIES.includes('redteam'))
  assert.ok(capabilitiesFor('mock').has('redteam'))
  assert.ok(!SSE_CAPABILITIES.includes('redteam'))
  assert.ok(!capabilitiesFor('sse', undefined).has('redteam'))
  assert.ok(capabilitiesFor('sse', 'redteam').has('redteam'))
})

test('레드팀 목업 이벤트가 모두 스키마(contract/events.schema.json)를 통과한다 [가정: 이벤트 계약 없음]', () => {
  const schema = JSON.parse(readFileSync(new URL('../../contract/events.schema.json', import.meta.url), 'utf8'))
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true })
  ajv.addSchema(schema)
  const validate = ajv.getSchema('events.schema.json')!
  const drafts = [{ after: 0, event: redteamWaiting() }, ...redteamDeclined(), ...(['fix', 'clean', 'open'] as RedTeamScenario[]).flatMap(redteamRun)]
  for (const { event } of drafts) {
    const stamped = { ...event, seq: 1, at: '2026-11-07T00:00:00.000Z' }
    assert.ok(validate(stamped), ajv.errorsText(validate.errors) + ' ' + JSON.stringify(stamped).slice(0, 200))
  }
  assert.ok(drafts.length >= 12)
})
