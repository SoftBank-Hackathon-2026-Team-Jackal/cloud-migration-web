/**
 * 수동 단계(manual_steps): 단계가 판정을 통과하면 awaitNext 알림과 함께 사람의 "다음 단계로"를 기다린다.
 * 계약 스키마, 기록(reducer), 대기 판정 함수, 문구, 음성 보고(한 번만), 목업 시뮬레이터의 흐름.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import { initialState, reducer } from '../../src/lib/migration/reducer.ts'
import { awaitingNext, logDetailKey, verdictOf } from '../../src/lib/migration/trafficModel.ts'
import { TrafficSim } from '../../src/lib/migration/trafficSim.ts'
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
const data = (phase: string, step: number, notes?: TrafficNote[]): TrafficSnapshotData => ({
  phase, weights: { origin: 100 - step, target: step }, step,
  gate: { failed_requests: 0, max_failed_requests: 0, p99_ratio: 1, max_p99_ratio: 1.5, observe_left_seconds: 0, observe_seconds: 20 },
  residual: { requests_per_sec: 0, streams: 0 }, ...(notes ? { notes } : {}),
}) as TrafficSnapshotData
const snapshot = (phase: string, step: number, notes?: TrafficNote[], extra: Partial<TrafficSnapshotData> = {}): MigrationEvent => ({
  type: 'traffic.snapshot', phase: 'traffic', status: 'running', seq: ++seq, at: '2026-11-08T00:00:00.000Z', data: { ...data(phase, step, notes), ...extra },
}) as MigrationEvent
const wait10: TrafficNote = { key: 'awaitNext', params: { pct: 10, next: 50 } }
const pass = (step: number) => ({ step, verdict: 'pass' as const, failed_requests: 0, p99_ratio: 1, observed_seconds: 20 })

test('계약: awaitNext 노트가 이벤트 스키마를 통과하고, 모르는 키는 여전히 거절한다', () => {
  assert.ok(validateEvent(snapshot('gate', 10, [wait10])), ajv.errorsText(validateEvent.errors))
  assert.ok(!validateEvent(snapshot('gate', 10, [{ key: 'bogus' } as unknown as TrafficNote])))
})

test('reducer: awaitNext 기록에 단계(%)와 다음 단계가 들어가고, 서버가 보낸 값은 그대로 남는다', () => {
  let state = reducer(initialState, { type: 'event', event: snapshot('gate', 10, [{ key: 'awaitNext' }]) })
  assert.equal(state.traffic.logs[0].key, 'awaitNext')
  assert.deepEqual(state.traffic.logs[0].params, { pct: 10 }) // 단계 목록이 없으면 next는 비운다
  state = reducer(initialState, { type: 'event', event: snapshot('gate', 10, [{ key: 'awaitNext' }], { steps: [10, 50, 100] }) })
  assert.deepEqual(state.traffic.logs[0].params, { pct: 10, next: 50 })
  state = reducer(initialState, { type: 'event', event: snapshot('gate', 10, [wait10]) })
  assert.deepEqual(state.traffic.logs[0].params, { pct: 10, next: 50 })
})

test('대기 판정: 가장 최근 스냅숏에 awaitNext가 있을 때만 대기 중이다', () => {
  assert.equal(awaitingNext(null), null)
  assert.equal(awaitingNext(data('gate', 10)), null)
  assert.deepEqual(awaitingNext(data('gate', 10, [wait10])), { pct: 10, next: 50 })
  // next가 빠져도 단계 목록에서 찾는다
  assert.deepEqual(awaitingNext({ ...data('gate', 50, [{ key: 'awaitNext', params: { pct: 50 } }]), steps: [10, 50, 100] }), { pct: 50, next: 100 })
  // 다음 단계가 시작되면(알림 없는 새 스냅숏) 끝난다. 롤백·완료에서도 아니다.
  assert.equal(awaitingNext(data('applying', 50)), null)
  assert.equal(awaitingNext(data('rolledback', 0, [wait10])), null)
  assert.equal(awaitingNext(data('complete', 100, [wait10])), null)
  const state = reducer(reducer(initialState, { type: 'event', event: snapshot('gate', 10, [wait10]) }), { type: 'event', event: snapshot('applying', 50) })
  assert.equal(awaitingNext(state.traffic.snapshot), null)
})

test('판정 안내: 대기 중이면 awaiting, 아니면 예전 그대로', () => {
  assert.deepEqual(verdictOf('gate', [], false, false, { pct: 10, next: 50 }), { key: 'awaiting', tone: 'pass', step: 10 })
  assert.equal(verdictOf('gate', [], false).key, 'gate')
  assert.equal(verdictOf('rolledback', [], true, false, { pct: 10, next: 50 }).key, 'manual')
  assert.equal(logDetailKey('awaitNext', { pct: 10, next: 50 }), 'traffic.log.awaitNextDetail')
})

test('화면 문구: 새 키가 세 언어에 모두 있고 같은 변수를 쓴다', () => {
  const keys = ['traffic.log.awaitNext', 'traffic.log.awaitNextDetail', 'traffic.verdict.awaiting', 'traffic.btn.advance', 'traffic.gate.awaitLeft', 'traffic.foot.awaiting'] as const
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

test('음성: 대기에 들어갈 때 한 번만 묻고(통과 보고는 이 질문이 대신한다), 다음 대기에서 다시 묻는다', () => {
  const pass10 = snapshot('gate', 10, [wait10], { results: [pass(10)] })
  const repeat = snapshot('gate', 10, [wait10], { results: [pass(10)] })
  assert.deepEqual(said([pass10, repeat]), ['10퍼센트 확인 완료. 다음 단계로 넘어갈까요?'])
  assert.equal(said([pass10], 'en')[0], '10 percent checked. Move to the next step?')
  assert.equal(said([pass10], 'ja')[0], '10パーセント確認完了。次の段階に進みますか？')
  const wait50 = snapshot('gate', 50, [{ key: 'awaitNext', params: { pct: 50, next: 100 } }], { results: [pass(10), pass(50)] })
  assert.deepEqual(said([pass10, repeat, wait50]), ['10퍼센트 확인 완료. 다음 단계로 넘어갈까요?', '50퍼센트 확인 완료. 다음 단계로 넘어갈까요?'])
  assert.ok(said([pass10])[0].length <= 40)
})

test('음성: 알림이 없는 자동 흐름의 보고는 그대로다', () => {
  assert.deepEqual(said([snapshot('gate', 10)]), [])
  assert.deepEqual(said([snapshot('applying', 50, undefined, { results: [pass(10)] })]).length, 2) // 통과 보고 + 단계 전환 보고
})

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const until = async (check: () => boolean) => { for (let i = 0; i < 300 && !check(); i++) await wait(20); assert.ok(check(), 'timeout') }

test('목업 시뮬레이터: manualSteps면 10%·50%에서 멈추고 advance로만 넘어가며 100%는 그대로 완료된다', async () => {
  const snaps: TrafficSnapshotData[] = []
  const sim = new TrafficSim(d => snaps.push(d), undefined, 200, { manualSteps: true })
  const waiting = () => snaps.filter(d => d.notes?.some(note => note.key === 'awaitNext')).length
  try {
    sim.start()
    await until(() => waiting() === 1)
    const stopped = snaps.length
    const first = snaps[snaps.length - 1]
    assert.equal(first.phase, 'gate'); assert.equal(first.decision, 'advance'); assert.equal(first.step, 10)
    assert.deepEqual(first.notes?.find(note => note.key === 'awaitNext')?.params, { pct: 10, next: 50 })
    await wait(300) // 자동으로 넘어가지 않는다
    assert.equal(snaps.length, stopped)
    sim.advance(); sim.advance() // 두 번 눌러도 한 번만 넘어간다
    assert.equal(snaps[snaps.length - 1].phase, 'applying')
    assert.equal(snaps[snaps.length - 1].step, 50)
    assert.equal(awaitingNext(snaps[snaps.length - 1]), null)
    await until(() => waiting() === 2)
    assert.equal(snaps[snaps.length - 1].step, 50)
    sim.advance()
    await until(() => snaps.some(d => d.phase === 'complete'))
    assert.equal(waiting(), 2) // 100%에는 대기가 없다
  } finally { sim.stop() }
})

test('목업 시뮬레이터: manualSteps가 없으면 알림 없이 자동으로 끝까지 간다', async () => {
  const snaps: TrafficSnapshotData[] = []
  const sim = new TrafficSim(d => snaps.push(d), undefined, 200)
  try {
    sim.start()
    await until(() => snaps.some(d => d.phase === 'complete'))
    assert.ok(!snaps.some(d => d.notes?.some(note => note.key === 'awaitNext')))
    const count = snaps.length
    sim.advance() // 대기 중이 아니면 아무 일도 하지 않는다
    assert.equal(snaps.length, count)
  } finally { sim.stop() }
})
