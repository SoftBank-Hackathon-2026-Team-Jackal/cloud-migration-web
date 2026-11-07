/**
 * 100% 전환 뒤 안정화 구간 [확정: 플랫폼 stability.py · events.py]: traffic.snapshot(stabilizing · health) · traffic.alert,
 * reducer(알림 기록) · 화면 모델(stabilizing 국면) · Jackal이 먼저 말하는 보고(롤백할까요?).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import { initialState, reducer, type MigrationState } from '../../src/lib/migration/reducer.ts'
import { breachOf, policyOf, stageOf, stepCards, verdictOf } from '../../src/lib/migration/trafficModel.ts'
import { ReportEngine } from '../../src/lib/voice/reports.ts'
import type { DraftEvent, MigrationEvent, TrafficHealthJudgement, TrafficSnapshotData } from '../../src/lib/migration/events.ts'

const schema = JSON.parse(readFileSync(new URL('../../contract/events.schema.json', import.meta.url), 'utf8'))
const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true })
const validate = ajv.compile(schema)
const valid = (event: MigrationEvent) => { if (!validate(event)) assert.fail(ajv.errorsText(validate.errors) + '\n' + JSON.stringify(event).slice(0, 300)) }

let seq = 0
const ev = (draft: DraftEvent): MigrationEvent => ({ ...draft, seq: ++seq, at: '2026-11-07T07:00:00.000Z' }) as MigrationEvent
const run = (state: MigrationState, ...events: MigrationEvent[]) => events.reduce((current, event) => reducer(current, { type: 'event', event }), state)

const health = (over: Partial<TrafficHealthJudgement> = {}): TrafficHealthJudgement => ({
  requests: 120, failed: 0, error_rate: 0, p99_ms: 40, baseline_p99_ms: 30, p99_limit_ms: 45, alert_error_rate: 0.05, judged: true, breach: [], ...over,
})
const snap = (over: Partial<TrafficSnapshotData> = {}) => ev({ type: 'traffic.snapshot', phase: 'traffic', status: 'running', data: {
  phase: 'stabilizing', weights: { origin: 0, target: 100 }, step: 100,
  gate: { failed_requests: 0, max_failed_requests: 0, p99_ratio: 1, max_p99_ratio: 1.5, observe_left_seconds: 0 },
  residual: { requests_per_sec: 0, streams: 0 }, notes: [], health: health(), stabilize_left_seconds: 1200, ...over,
} })
const breach = health({ failed: 60, error_rate: 0.5, p99_ms: 1000, breach: [{ code: 'ERROR_RATE', value: 0.5, limit: 0.05 }, { code: 'P99', value: 1000, limit: 45 }] })
const alert = (state: 'breach' | 'recovered', data = breach) => ev({ type: 'traffic.alert', phase: 'traffic', status: 'running', data: { ...data, state, phase: 'stabilizing' } })

test('안정화 구간 이벤트가 계약 스키마를 통과한다', () => {
  valid(snap())
  valid(snap({ notes: [{ key: 'finalized' }, { key: 'dbRollback' }] }))
  valid(alert('breach'))
  valid(alert('recovered', health()))
  assert.equal(validate({ ...alert('breach'), data: { ...breach, state: 'breach', phase: 'stabilizing', breach: [{ code: 'CPU', value: 1, limit: 1 }] } }), false)
})

test('안정화 구간: 모든 단계 통과 · 기준 안이면 중립 판정, 넘으면 실패 판정', () => {
  const state = run(initialState, snap())
  const { snapshot, prepare } = state.traffic
  const stage = stageOf(snapshot, prepare)
  assert.equal(stage, 'stabilizing')
  const cards = stepCards(snapshot, policyOf(snapshot, prepare))
  assert.ok(cards.every(card => card.state === 'pass'))
  assert.equal(breachOf(snapshot, state.traffic.alert), false)
  assert.deepEqual(verdictOf(stage, cards, false, false), { key: 'stabilizing', tone: 'neutral' })
  assert.equal(verdictOf(stage, cards, false, true).key, 'stabilizingAlert')
  // 판정하지 않은 창(요청이 적음)의 breach는 이상으로 보지 않는다
  assert.equal(breachOf(run(initialState, snap({ health: { ...breach, judged: false } })).traffic.snapshot, null), false)
  assert.equal(breachOf(run(initialState, snap({ health: breach })).traffic.snapshot, null), true)
})

test('traffic.alert: 기록에 남기고, 회복하거나 안정화 구간을 벗어나면 알림을 지운다', () => {
  let state = run(initialState, snap(), alert('breach'))
  assert.equal(state.traffic.alert?.state, 'breach')
  assert.equal(breachOf(state.traffic.snapshot, state.traffic.alert), true)
  assert.equal(state.traffic.logs[0].key, 'alert')
  assert.deepEqual(state.traffic.logs[0].params, { rate: 50, p99: 1000, rateLimit: 5, p99Limit: 45 })
  state = run(state, alert('recovered', health()))
  assert.equal(state.traffic.alert, null)
  assert.equal(state.traffic.logs[0].key, 'recovered')
  state = run(state, alert('breach'), snap({ phase: 'rolledback', weights: { origin: 100, target: 0 }, notes: [{ key: 'manual' }] }))
  assert.equal(state.traffic.alert, null)
})

test('Jackal이 먼저 말한다: 안정화 시작 · 이상(롤백할까요?) · 회복 · 사람이 롤백 · DB 롤백', () => {
  const engine = new ReportEngine()
  const keys = (event: MigrationEvent) => engine.fromEvent(event, 'traffic', 0).map(report => report.key)
  assert.deepEqual(keys(snap()), ['r.traffic.stabilizing'])
  assert.deepEqual(keys(snap()), [])
  const [report] = engine.fromEvent(alert('breach'), 'traffic', 0)
  assert.equal(report.key, 'r.traffic.alertError')
  assert.equal(report.kind, 'failure')
  assert.deepEqual(report.params, { p: 50 })
  const p99Only = health({ p99_ms: 900, breach: [{ code: 'P99', value: 900, limit: 45 }] })
  assert.deepEqual(engine.fromEvent(alert('breach', p99Only), 'traffic', 0).map(r => [r.key, r.params]), [['r.traffic.alertP99', { ms: 900 }]])
  assert.deepEqual(keys(alert('recovered', health())), ['r.traffic.recovered'])
  const rolled = { phase: 'rolledback' as const, weights: { origin: 100, target: 0 }, step: 100 }
  assert.deepEqual(keys(snap({ ...rolled, notes: [{ key: 'manual' }] })), ['r.traffic.rollbackManual'])
  assert.deepEqual(keys(snap({ ...rolled, notes: [{ key: 'manual' }, { key: 'dbRollback' }] })), ['r.traffic.dbRollback'])
  assert.deepEqual(keys(snap({ ...rolled, notes: [{ key: 'dbRollback' }] })), [])
})

test('목업 시뮬레이터(?stabilize=N): 100% → 안정화 → 장애 → 알림 → 롤백(+DB) → 재시도 → 확정', async () => {
  const { TrafficSim } = await import('../../src/lib/migration/trafficSim.ts')
  const snaps: TrafficSnapshotData[] = []
  const alerts: string[] = []
  const sim = new TrafficSim(data => snaps.push(data), undefined, 20, { stabilizeSeconds: 60, emitAlert: data => alerts.push(data.state) })
  const until = async (check: () => boolean, ms = 5000) => {
    const end = Date.now() + ms
    while (!check()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(resolve => setTimeout(resolve, 10)) }
  }
  const last = () => snaps[snaps.length - 1]
  try {
    sim.start()
    await until(() => last()?.phase === 'stabilizing')
    assert.equal(last().weights.target, 100)
    assert.ok(last().health && last().stabilize_left_seconds === 60)
    sim.inject()
    await until(() => alerts.includes('breach'))
    await until(() => (last().health?.breach.length ?? 0) > 0)
    assert.equal(last().phase, 'stabilizing') // 자동으로 되돌리지 않는다
    sim.rollback()
    assert.equal(last().phase, 'rolledback')
    assert.deepEqual(last().notes?.map(note => note.key), ['manual'])
    await until(() => last().notes?.some(note => note.key === 'dbRollback') ?? false)
    sim.retry()
    await until(() => last()?.phase === 'stabilizing')
    assert.equal(last().health?.breach.length, 0) // 재시도는 장애 없이 시작한다
    sim.finalize()
    assert.equal(last().phase, 'complete')
    assert.deepEqual(last().notes?.map(note => note.key), ['finalized'])
  } finally {
    sim.stop()
  }
})
