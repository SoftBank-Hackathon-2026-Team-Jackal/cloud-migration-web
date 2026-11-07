import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import Ajv from 'ajv/dist/2020.js'
import { initialState, reducer } from '../../src/lib/migration/reducer.ts'
import type { MigrationEvent } from '../../src/lib/migration/events.ts'
import { REDTEAM_MAX_ROUNDS, redteamRun, type RedTeamScenario } from '../../src/lib/migration/redteamScript.ts'
import { CAPABILITIES } from '../../src/lib/migration/capabilities.ts'

const SCENARIOS: RedTeamScenario[] = ['fix', 'clean', 'open', 'skip']
let seq = 0
type Step = ReturnType<typeof redteamRun>[number]
const apply = (state: typeof initialState, step: Step) => {
  seq += 1
  return reducer(state, { type: 'event', event: { ...step.event, seq, at: '2026-11-07T00:00:00.000Z' } as MigrationEvent })
}
const dataOf = (step: Step) => (step.event as { data: { phase: string; consent: object | null; findings: Array<{ state: string }>; round: number; status: string | null; code: string | null } }).data

test('the sandbox state starts without a red team and keeps the latest red team event', () => {
  assert.equal(initialState.sandbox.redteam, null)
  const [first, second] = redteamRun('fix')
  const running = apply(initialState, first)
  assert.equal(running.sandbox.redteam?.phase, 'RUNNING')
  assert.equal(running.sandbox.redteam?.consent?.intensity, 'ACTIVE')
  const found = apply(running, second)
  assert.equal(found.sandbox.redteam?.findings.length, 1)
})

test('there is no approval step: nothing waits for a person, and the first event is already running', () => {
  for (const scenario of SCENARIOS.filter(item => item !== 'skip')) {
    const phases = redteamRun(scenario).map(step => dataOf(step).phase)
    assert.equal(phases[0], 'RUNNING', scenario)
    assert.ok(!phases.some(phase => phase === 'WAITING_FOR_APPROVAL'), scenario)
  }
})

test('every scenario runs forward in time and ends in one DONE event', () => {
  for (const scenario of SCENARIOS) {
    const steps = redteamRun(scenario)
    assert.ok(steps.every((step, i) => i === 0 || step.after > steps[i - 1].after), scenario)
    const phases = steps.map(step => dataOf(step).phase)
    assert.equal(phases.at(-1), 'DONE', scenario)
    assert.equal(phases.filter(p => p === 'DONE').length, 1, scenario)
    assert.ok(steps.every(step => dataOf(step).round <= REDTEAM_MAX_ROUNDS), scenario)
  }
})

test('fix scenario: three weaknesses found, all fixed by security round 2', () => {
  const last = dataOf(redteamRun('fix').at(-1)!)
  assert.equal(last.status, 'FIXED')
  assert.equal(last.round, 2)
  assert.equal(last.findings.length, 3)
  assert.ok(last.findings.every(f => f.state === 'FIXED'))
})

test('open scenario: a weakness can stay open after the third round without blocking', () => {
  const last = dataOf(redteamRun('open').at(-1)!)
  assert.equal(last.status, 'STILL_OPEN')
  assert.equal(last.round, REDTEAM_MAX_ROUNDS)
  assert.equal(last.findings.filter(f => f.state === 'STILL_OPEN').length, 1)
})

test('clean scenario finds nothing', () => {
  const last = dataOf(redteamRun('clean').at(-1)!)
  assert.equal(last.status, 'CLEAN')
  assert.equal(last.findings.length, 0)
})

test('skip scenario: no attack, no consent, and the reason is a code', () => {
  const [only, ...rest] = redteamRun('skip')
  assert.equal(rest.length, 0)
  const data = dataOf(only)
  assert.equal(data.status, 'SKIPPED')
  assert.equal(data.code, 'REDTEAM_NOT_CONFIGURED')
  assert.equal(data.consent, null)
  assert.equal(data.findings.length, 0)
})

test('there is no approval API, so no red team capability exists', () => {
  assert.ok(!(CAPABILITIES as readonly string[]).includes('redteam'))
})

test('레드팀 목업 이벤트가 모두 스키마(contract/events.schema.json)를 통과한다 [가정: 이벤트 계약 없음]', () => {
  const schema = JSON.parse(readFileSync(new URL('../../contract/events.schema.json', import.meta.url), 'utf8'))
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true })
  ajv.addSchema(schema)
  const validate = ajv.getSchema('events.schema.json')!
  const drafts = SCENARIOS.flatMap(redteamRun)
  for (const { event } of drafts) {
    const stamped = { ...event, seq: 1, at: '2026-11-07T00:00:00.000Z' }
    assert.ok(validate(stamped), ajv.errorsText(validate.errors) + ' ' + JSON.stringify(stamped).slice(0, 200))
  }
  assert.ok(drafts.length >= 12)
})
