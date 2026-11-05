/**
 * 트래픽 이전 [가정] 계약: traffic.prepare 이벤트, traffic.snapshot의 추가 필드(backends · results · replication · activity),
 * reducer(사전 확인 기록·p99 추이), 화면 모델(trafficModel), SSE 정규화.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import { initialState, reducer, TRAFFIC_TRACE_POINTS, type MigrationState } from '../../src/lib/migration/reducer.ts'
import { trafficPrepareTimeline, TRAFFIC_PREPARE_MS } from '../../src/lib/migration/script.ts'
import { TrafficSim } from '../../src/lib/migration/trafficSim.ts'
import { normalizeEvent } from '../../src/lib/migration/sseProvider.ts'
import { DEFAULT_ACTIVITY, policyOf, stageOf, stepCards, verdictOf } from '../../src/lib/migration/trafficModel.ts'
import type { DraftEvent, MigrationEvent, TrafficPrepareData, TrafficSnapshotData } from '../../src/lib/migration/events.ts'

const schema = JSON.parse(readFileSync(new URL('../../contract/events.schema.json', import.meta.url), 'utf8'))
const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true })
const validate = ajv.compile(schema)

let seq = 0
function ev(draft: DraftEvent, at = '2026-01-01T00:00:00.000Z'): MigrationEvent {
  seq += 1
  return { ...draft, seq, at } as MigrationEvent
}
const run = (state: MigrationState, ...events: MigrationEvent[]) => events.reduce((current, event) => reducer(current, { type: 'event', event }), state)
const valid = (event: MigrationEvent) => { if (!validate(event)) assert.fail(ajv.errorsText(validate.errors) + '\n' + JSON.stringify(event).slice(0, 300)) }

const snapshot = (over: Partial<TrafficSnapshotData> = {}): TrafficSnapshotData => ({
  phase: 'observing', weights: { origin: 50, target: 50 }, step: 50, steps: [10, 50, 100],
  gate: { failed_requests: 0, max_failed_requests: 0, p99_ratio: 1.1, max_p99_ratio: 1.5, observe_left_seconds: 2, observe_seconds: 4 },
  residual: { requests_per_sec: 0, streams: 0 }, ...over,
})
const snapEvent = (data: TrafficSnapshotData, at?: string) => ev({ type: 'traffic.snapshot', phase: 'traffic', status: 'running', data }, at)
const prepEvent = (data: TrafficPrepareData, at?: string) => ev({ type: 'traffic.prepare', phase: 'traffic', status: data.state === 'done' ? 'done' : 'running', data }, at)

test('사전 확인 대본(온프레·GCP)이 스키마를 통과하고 마지막이 done이다', () => {
  for (const target of ['onprem', 'gcp'] as const) {
    const timeline = trafficPrepareTimeline(target)
    for (const item of timeline) valid(prepEvent(item.data))
    const last = timeline[timeline.length - 1]
    assert.equal(last.data.state, 'done')
    assert.equal(last.after, TRAFFIC_PREPARE_MS)
    assert.ok(last.data.checks.every(check => check.state === 'done' && check.value))
    assert.equal(Boolean(last.data.target?.tunnel), target === 'onprem', '터널 정보는 온프레미스만')
    assert.ok(last.data.target?.external_endpoint?.startsWith('http://'))
  }
  // 확인 목록이 없거나 모르는 상태 값은 받지 않는다.
  assert.equal(validate({ ...prepEvent({ state: 'done', checks: [] }), data: { state: 'done' } }), false)
  assert.equal(validate(prepEvent({ state: 'paused' as 'done', checks: [] })), false)
  assert.equal(validate(prepEvent({ state: 'done', checks: [], target: { name: 'x', tunnel: { interface: 'wg0', mtu: 10 } } })), false, 'MTU 하한')
})

test('시뮬레이터 스냅샷: 백엔드별 지표·단계 판정·activity가 실리고 장애 주입은 롤백으로 끝난다', async () => {
  const snaps: TrafficSnapshotData[] = []
  const sim = new TrafficSim(data => { snaps.push(data); valid(snapEvent(data)) })
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  try {
    sim.start()
    await sleep(1700) // 10% 적용 → 관찰 시작
    sim.inject()
    await sleep(2200) // 실패 → 게이트 → 롤백
  } finally { sim.stop() }
  const apply = snaps.flatMap(s => s.notes ?? []).find(note => note.key === 'apply')
  assert.equal(apply?.activity, 'traffic_set_weight')
  assert.ok(snaps.some(s => s.notes?.some(note => note.key === 'observe' && note.activity === 'traffic_observe')))
  const last = snaps[snaps.length - 1]
  assert.equal(last.phase, 'rolledback')
  assert.deepEqual(last.weights, { origin: 100, target: 0 })
  assert.deepEqual(last.notes?.map(note => [note.key, note.activity]), [['gateFail', 'gate'], ['rollback', 'traffic_rollback']])
  assert.equal(last.results?.[0].verdict, 'rollback')
  assert.equal(last.results?.[0].step, 10)
  const observing = snaps.find(s => s.phase === 'observing' && s.weights.target === 10)
  assert.ok(observing?.backends)
  assert.equal(observing!.backends!.origin.requests_per_sec + observing!.backends!.target.requests_per_sec > 0, true)
  assert.equal(observing!.gate.observe_seconds, 4)
})

test('reducer: 사전 확인은 끝날 때 한 번만 기록하고, 실패면 이유와 함께 prepareFail', () => {
  seq = 0
  const base = trafficPrepareTimeline('onprem')
  let state = run(initialState, ...base.map(item => prepEvent(item.data, '2026-01-01T00:00:01.000Z')))
  assert.equal(state.traffic.prepare?.state, 'done')
  assert.deepEqual(state.traffic.logs.map(entry => entry.key), ['prepare'])
  assert.equal(state.traffic.logs[0].params.endpoint, 'http://10.8.0.12:80')
  assert.equal(state.traffic.startedAt, '2026-01-01T00:00:01.000Z')
  // 같은 done이 다시 와도(재전송) 기록은 하나
  state = run(state, prepEvent(base[base.length - 1].data))
  assert.equal(state.traffic.logs.length, 1)

  const blocked = run(initialState, prepEvent({ state: 'failed', checks: [{ id: 'external_endpoint', state: 'failed' }], reason: 'external_endpoint missing' }))
  assert.equal(blocked.traffic.logs[0].key, 'prepareFail')
  assert.equal(blocked.traffic.logs[0].params.reason, 'external_endpoint missing')
  assert.equal(stageOf(null, blocked.traffic.prepare), 'blocked')
  assert.equal(stageOf(null, null), 'prepare')
})

test('reducer: 관찰 중 p99 비율만 추이에 쌓고 restart에서 비운다. activity는 기록에 남는다', () => {
  seq = 0
  let state = run(initialState,
    snapEvent(snapshot({ phase: 'applying', notes: [{ key: 'apply', activity: 'traffic_set_weight', params: { pct: 50 } }] })),
    snapEvent(snapshot({ gate: { ...snapshot().gate, p99_ratio: 1.2 } })),
    snapEvent(snapshot({ phase: 'gate', gate: { ...snapshot().gate, p99_ratio: 1.3 } })))
  assert.deepEqual(state.traffic.trace, [1.2, 1.3])
  assert.equal(state.traffic.logs[0].activity, 'traffic_set_weight')
  for (let i = 0; i < TRAFFIC_TRACE_POINTS + 20; i++) state = run(state, snapEvent(snapshot()))
  assert.equal(state.traffic.trace.length, TRAFFIC_TRACE_POINTS)
  state = run(state, snapEvent(snapshot({ phase: 'applying', notes: [{ key: 'restart' }] })))
  assert.deepEqual(state.traffic.trace, [])
  assert.equal(state.traffic.logs.length, 0)
  state = reducer(state, { type: 'resetPhase', phase: 'traffic' })
  assert.equal(state.traffic.prepare, null)
  assert.equal(state.traffic.startedAt, null)
})

test('화면 모델: 정책은 스냅샷 → 사전 확인 → 기본값 순서, 카드는 결과 기록을 우선한다', () => {
  assert.deepEqual(policyOf(null, null), { steps: [10, 50, 100], observeSeconds: 4, maxFailed: 0, maxP99Ratio: 1.5 })
  assert.deepEqual(policyOf(null, { state: 'done', checks: [], policy: { steps: [50, 100], observe_seconds: 30, max_failed_requests: 2, max_p99_ratio: 2 } }), { steps: [50, 100], observeSeconds: 30, maxFailed: 2, maxP99Ratio: 2 })
  const policy = policyOf(snapshot(), null)
  // 10% 통과, 50% 관찰 중(창의 절반), 100% 대기
  const cards = stepCards(snapshot({ results: [{ step: 10, verdict: 'pass', failed_requests: 0, p99_ratio: 1.06 }] }), policy)
  assert.deepEqual(cards.map(card => card.state), ['pass', 'observing', 'wait'])
  assert.equal(cards[0].p99Ratio, 1.06)
  assert.equal(cards[1].observe, 0.5)
  assert.equal(cards[1].failed, 0)
  // 결과 기록이 없는 서버도 지나간 단계는 통과로 본다
  assert.deepEqual(stepCards(snapshot({ step: 100, phase: 'applying' }), policy).map(card => card.state), ['pass', 'pass', 'applying'])
  // 롤백: 결과의 단계만 롤백, 나머지는 대기
  const rolled = stepCards(snapshot({ phase: 'rolledback', weights: { origin: 100, target: 0 }, results: [{ step: 10, verdict: 'pass', failed_requests: 0, p99_ratio: 1 }, { step: 50, verdict: 'rollback', failed_requests: 7, p99_ratio: 2.1 }] }), policy)
  assert.deepEqual(rolled.map(card => card.state), ['pass', 'rollback', 'wait'])
  assert.deepEqual(verdictOf('rolledback', rolled, false), { key: 'rollback', tone: 'fail', step: 50 })
  assert.equal(verdictOf('rolledback', rolled, true).key, 'manual')
  assert.deepEqual(verdictOf('applying', stepCards(snapshot({ phase: 'applying', results: [{ step: 10, verdict: 'pass', failed_requests: 0, p99_ratio: 1 }] }), policy), false), { key: 'advance', tone: 'pass', step: 10 })
  assert.equal(verdictOf('applying', stepCards(snapshot({ phase: 'applying', step: 10 }), policy), false).key, 'applying')
  // 완료: 남은 요청이 0이어야 drained
  assert.equal(stageOf(snapshot({ phase: 'complete', residual: { requests_per_sec: 3, streams: 1 } }), null), 'complete')
  assert.equal(stageOf(snapshot({ phase: 'complete' }), null), 'drained')
  assert.equal(DEFAULT_ACTIVITY.apply, 'traffic_set_weight')
})

test('SSE 정규화: 빠진 확인 목록·notes·results는 빈 목록, 빈 steps는 지운다', () => {
  const prep = normalizeEvent({ seq: 1, at: 'x', phase: 'traffic', type: 'traffic.prepare', status: 'running', data: { state: 'running' } } as unknown as MigrationEvent)
  assert.deepEqual(prep.type === 'traffic.prepare' && prep.data.checks, [])
  const snap = normalizeEvent({ seq: 2, at: 'x', phase: 'traffic', type: 'traffic.snapshot', status: 'running', data: { ...snapshot(), steps: [] } } as MigrationEvent)
  assert.ok(snap.type === 'traffic.snapshot')
  if (snap.type === 'traffic.snapshot') {
    assert.equal('steps' in snap.data, false)
    assert.deepEqual(snap.data.notes, [])
    assert.deepEqual(snap.data.results, [])
  }
})
