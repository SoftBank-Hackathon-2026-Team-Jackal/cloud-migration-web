import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import { initialState, reducer } from '../../src/lib/migration/reducer.ts'
import type { MigrationEvent, TrafficSnapshotData } from '../../src/lib/migration/events.ts'

/**
 * 백엔드(cloud-migration-platform, cmp_traffic.build_snapshot)가 내보내는 traffic.snapshot 형식 시험.
 * 고정 파일은 백엔드 함수가 만든 실제 출력이다. 백엔드 형식이 바뀌면 이 파일을 다시 만들어야 한다.
 */
const read = (path: string) => JSON.parse(readFileSync(new URL('../../' + path, import.meta.url), 'utf8'))
const snapshots: TrafficSnapshotData[] = read('tests/unit/fixtures/backend-traffic-snapshots.json')

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true })
ajv.addSchema(read('contract/events.schema.json'))
const validateEvent = ajv.getSchema('events.schema.json')!

const wrap = (data: TrafficSnapshotData, seq: number): MigrationEvent =>
  ({ type: 'traffic.snapshot', phase: 'traffic', status: 'running', data, seq, at: '2026-01-01T00:00:00.000Z' }) as MigrationEvent

test('백엔드가 만든 traffic.snapshot이 이벤트 스키마를 모두 통과한다', () => {
  snapshots.forEach((data, index) => {
    const event = wrap(data, index + 1)
    assert.ok(validateEvent(event), data.phase + ' 스키마 위반: ' + ajv.errorsText(validateEvent.errors))
  })
})

test('백엔드 snapshot을 순서대로 받으면 화면 상태가 마지막 값으로 따라간다', () => {
  let state = initialState
  snapshots.forEach((data, index) => { state = reducer(state, { type: 'event', event: wrap(data, index + 1) }) })
  assert.equal(state.traffic.snapshot?.phase, 'complete')
  assert.deepEqual(state.traffic.snapshot?.weights, { origin: 0, target: 100 })
})

test('롤백 snapshot은 원본 100%로 돌아간 상태를 보인다', () => {
  const rolled = snapshots.find(item => item.phase === 'rolledback')!
  const state = reducer(initialState, { type: 'event', event: wrap(rolled, 1) })
  assert.deepEqual(state.traffic.snapshot?.weights, { origin: 100, target: 0 })
  assert.equal(state.traffic.snapshot?.decision, 'rollback')
})
