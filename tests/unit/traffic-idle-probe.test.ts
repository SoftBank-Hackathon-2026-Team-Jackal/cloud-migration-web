/**
 * 사용자 트래픽이 없을 때의 합성 요청(idleProbe)과 롤백 사유(gateFail의 kind): 계약 스키마, 화면 기록, 음성 보고.
 * 플랫폼은 gateFail 노트에 판정 근거를 싣는다(kind=p99|failed|requests와 수치). 값이 없으면(목업·옛 서버) 예전 문구를 쓴다.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import { initialState, reducer } from '../../src/lib/migration/reducer.ts'
import { logDetailKey } from '../../src/lib/migration/trafficModel.ts'
import { renderReport, ReportEngine } from '../../src/lib/voice/reports.ts'
import { ko } from '../../src/lib/i18n/ko.ts'
import { en } from '../../src/lib/i18n/en.ts'
import { ja } from '../../src/lib/i18n/ja.ts'
import type { MigrationEvent, TrafficNote, TrafficSnapshotData } from '../../src/lib/migration/events.ts'

const read = (path: string) => JSON.parse(readFileSync(new URL('../../' + path, import.meta.url), 'utf8'))
const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true })
ajv.addSchema(read('contract/events.schema.json'))
const validateEvent = ajv.getSchema('events.schema.json')!

let seq = 0
const snapshot = (phase: string, step: number, notes: TrafficNote[], decision?: 'rollback'): MigrationEvent => ({
  type: 'traffic.snapshot', phase: 'traffic', status: 'running', seq: ++seq, at: '2026-11-07T00:00:00.000Z',
  data: {
    phase, weights: { origin: 100 - step, target: step }, step,
    gate: { failed_requests: 0, max_failed_requests: 0, p99_ratio: 0, max_p99_ratio: 1.5, observe_left_seconds: 0, observe_seconds: 20 },
    residual: { requests_per_sec: 0, streams: 0 }, notes, ...(decision ? { decision } : {}),
  } as TrafficSnapshotData,
}) as MigrationEvent

const probeNote: TrafficNote = { key: 'idleProbe', params: { requests: 30, failed: 0, p99_ms: 120 } }
const p99Note: TrafficNote = { key: 'gateFail', params: { kind: 'p99', p99_ms: 1000, limit_ms: 500, baseline_ms: 0 } }

test('계약: idleProbe 노트와 사유가 실린 gateFail 노트가 이벤트 스키마를 통과한다', () => {
  for (const event of [snapshot('gate', 10, [probeNote]), snapshot('rolledback', 0, [p99Note], 'rollback')]) {
    assert.ok(validateEvent(event), ajv.errorsText(validateEvent.errors))
  }
})

test('reducer: 합성 요청·롤백 기록에 단계(%)가 들어가고 서버가 보낸 값은 그대로 남는다', () => {
  let state = reducer(initialState, { type: 'event', event: snapshot('gate', 50, [probeNote]) })
  state = reducer(state, { type: 'event', event: snapshot('rolledback', 100, [p99Note], 'rollback') })
  const [rolled, probed] = state.traffic.logs
  assert.equal(probed.key, 'idleProbe')
  assert.deepEqual(probed.params, { pct: 50, requests: 30, failed: 0, p99_ms: 120 })
  assert.equal(rolled.key, 'gateFail')
  assert.deepEqual(rolled.params, { pct: 100, kind: 'p99', p99_ms: 1000, limit_ms: 500, baseline_ms: 0 })
})

test('화면 문구 키: 롤백은 사유(kind)별로, 사유가 없으면 예전 문구', () => {
  assert.equal(logDetailKey('gateFail', { kind: 'p99' }), 'traffic.log.gateFailDetailP99')
  assert.equal(logDetailKey('gateFail', { kind: 'failed' }), 'traffic.log.gateFailDetailFailed')
  assert.equal(logDetailKey('gateFail', { kind: 'requests' }), 'traffic.log.gateFailDetailRequests')
  assert.equal(logDetailKey('gateFail', {}), 'traffic.log.gateFailDetail')
  assert.equal(logDetailKey('gateFail', undefined), 'traffic.log.gateFailDetail')
  assert.equal(logDetailKey('idleProbe', { requests: 3 }), 'traffic.log.idleProbeDetail')
  assert.equal(logDetailKey('apply', { kind: 'p99' }), 'traffic.log.applyDetail')
})

test('화면 문구: 새 키가 세 언어에 모두 있고 같은 변수를 쓴다', () => {
  const keys = ['traffic.log.idleProbe', 'traffic.log.idleProbeDetail', 'traffic.log.gateFailDetailP99', 'traffic.log.gateFailDetailFailed', 'traffic.log.gateFailDetailRequests'] as const
  const vars = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join()
  for (const key of keys) {
    for (const dict of [ko, en, ja] as Array<Record<string, string>>) assert.ok(dict[key], key)
    assert.equal(vars(en[key]), vars(ko[key]), 'en ' + key)
    assert.equal(vars(ja[key]), vars(ko[key]), 'ja ' + key)
  }
})

const said = (events: MigrationEvent[], lang: 'ko' | 'en' | 'ja' = 'ko') => {
  const engine = new ReportEngine()
  return events.flatMap(event => engine.fromEvent(event, 'traffic', 0).map(report => renderReport(report, lang)))
}

test('음성: 롤백은 사유를 말하고, 사유가 없으면 예전 문구', () => {
  assert.deepEqual(said([snapshot('rolledback', 0, [p99Note], 'rollback')]), ['p99가 1000밀리초로 기준을 넘어 원본으로 되돌렸습니다.'])
  assert.deepEqual(said([snapshot('rolledback', 0, [{ key: 'gateFail', params: { kind: 'failed', failed: 4, allowed: 0 } }], 'rollback')]), ['실패 요청 4건이 나와 원본으로 되돌렸습니다.'])
  assert.deepEqual(said([snapshot('rolledback', 0, [{ key: 'gateFail', params: { kind: 'requests', requests: 2, min_requests: 10 } }], 'rollback')]), ['요청이 2건뿐이라 판단 못 해 원본으로 되돌렸습니다.'])
  assert.deepEqual(said([snapshot('rolledback', 0, [{ key: 'gateFail' }], 'rollback')]), ['기준 초과. 원본으로 되돌렸습니다.'])
  assert.equal(said([snapshot('rolledback', 0, [p99Note], 'rollback')], 'en')[0], 'P99 was 1000 milliseconds, over the limit, so I switched back.')
  assert.equal(said([snapshot('rolledback', 0, [p99Note], 'rollback')], 'ja')[0], 'p99が1000ミリ秒で基準を超えたため、移行元に戻しました。')
})

test('음성: 합성 요청으로 확인했다는 말은 단계 안에서 한 번만 한다', () => {
  const lines = said([snapshot('gate', 10, [probeNote]), snapshot('gate', 50, [probeNote]), snapshot('gate', 100, [probeNote])])
  assert.deepEqual(lines, ['사용자 트래픽이 없어 합성 요청 30건으로 확인했습니다.'])
})
