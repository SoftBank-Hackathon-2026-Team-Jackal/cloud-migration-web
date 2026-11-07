import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reducer, type MigrationState } from '../../src/lib/migration/reducer.ts'
import type { DraftEvent, MigrationEvent, ShadowResultData } from '../../src/lib/migration/events.ts'
import { preconditionMark, preconditionTone, preconditionsAllowCutover, shadowView } from '../../src/lib/migration/shadow.ts'

let seq = 0
const ev = (draft: DraftEvent): MigrationEvent => ({ ...draft, seq: ++seq, at: '2026-01-01T00:00:00.000Z' }) as MigrationEvent
const run = (state: MigrationState, ...events: MigrationEvent[]) => events.reduce((current, event) => reducer(current, { type: 'event', event }), state)

const progress = (run_id: string, compared: number, elapsed_s = 10): DraftEvent => ({
  type: 'shadow.progress', phase: 'data_copy', status: 'running',
  data: { run_id, compared, match: compared, mismatch: 0, elapsed_s, window_s: 60 },
})
const resultData = (over: Partial<ShadowResultData> = {}): ShadowResultData => ({
  run_id: 'r1', state: 'warn', compared: 1240, match: 1238, mismatch: 2, match_ratio: 1238 / 1240, target_5xx: 0, p99_ratio: 1.1, reason: null,
  samples: [{ method: 'GET', path: '/api/orders/7', status_origin: 200, status_target: 200, diff: [{ pointer: '/total', origin: 10, target: 11 }] }],
  ai: { category: 'data', summary: '합계 값이 한 건 다르다', hypotheses: ['복제 지연 중 쓰기'] },
  ...over,
})
const result = (over: Partial<ShadowResultData> = {}): DraftEvent => ({ type: 'shadow.result', phase: 'data_copy', status: 'done', data: resultData(over) })

test('shadow 이벤트가 없으면 그림자 리허설 상태는 비어 있고 화면은 아무것도 그리지 않는다', () => {
  assert.deepEqual(initialState.data.shadow, { progress: null, result: null })
  assert.equal(shadowView(initialState.data.shadow), null)
})

test('shadow.progress는 진행 중 비교 수와 관찰 시간을 남긴다', () => {
  seq = 0
  const state = run(initialState, ev(progress('r1', 10)), ev(progress('r1', 42, 20)))
  assert.equal(state.data.shadow.progress?.compared, 42)
  assert.deepEqual(shadowView(state.data.shadow), { mode: 'running', compared: 42, elapsed_s: 20, window_s: 60 })
  assert.equal(state.flowStage, 'data')
  assert.equal(state.status, 'running')
})

test('shadow.result가 오면 결과를 보이고, 새 run_id의 진행이 오면 지난 결과를 비운다', () => {
  seq = 0
  let state = run(initialState, ev(progress('r1', 10)), ev(result()))
  const view = shadowView(state.data.shadow)
  assert.equal(view?.mode, 'result')
  assert.equal(view?.mode === 'result' && view.result.mismatch, 2)
  state = run(state, ev(progress('r2', 3)))
  assert.equal(state.data.shadow.result, null)
  assert.equal(shadowView(state.data.shadow)?.mode, 'running')
})

test('warn 결과도 이전을 실패로 바꾸지 않는다(경고·표시 전용)', () => {
  seq = 0
  const state = run(initialState, ev(result({ state: 'warn' })), ev(result({ run_id: 'r1', state: 'stopped', reason: 'SHADOW_STOPPED_REPLICATION' })))
  assert.equal(state.status, 'running')
  assert.deepEqual(state.failures, {})
  assert.equal(state.data.shadow.result?.state, 'stopped')
})

test('데이터 단계를 비우면 그림자 리허설 상태도 비운다', () => {
  seq = 0
  const state = run(initialState, ev(result()))
  assert.deepEqual(reducer(state, { type: 'resetPhase', phase: 'data_copy' }).data.shadow, { progress: null, result: null })
})

test('DB 전환 사전 조건은 warn·skip이어도 승인을 막지 않고, wait·fail은 막는다', () => {
  assert.equal(preconditionsAllowCutover([{ id: 'lag', state: 'pass' }, { id: 'shadow', state: 'warn' }]), true)
  assert.equal(preconditionsAllowCutover([{ id: 'shadow', state: 'skip' }]), true)
  assert.equal(preconditionsAllowCutover([{ id: 'lag', state: 'wait' }, { id: 'shadow', state: 'pass' }]), false)
  assert.equal(preconditionsAllowCutover([{ id: 'lag', state: 'fail' }]), false)
})

test('사전 조건 줄은 기존 표시 클래스(pass·wait·fail)만 쓴다', () => {
  assert.deepEqual((['pass', 'wait', 'fail', 'warn', 'skip'] as const).map(preconditionTone), ['pass', 'wait', 'fail', 'wait', 'wait'])
  assert.deepEqual((['pass', 'wait', 'fail', 'warn', 'skip'] as const).map(preconditionMark), ['✓', '', '✕', '!', '–'])
})

test('그림자 리허설 음성: 시작 한 번, 결과 pass·warn·skipped 한 번씩, warn도 다음 단계(DB 전환)로 갈지 묻는다', async () => {
  const { ReportEngine, renderReport } = await import('../../src/lib/voice/reports.ts')
  seq = 0
  const say = (events: DraftEvent[], lang: 'ko' | 'en' | 'ja' = 'ko') => {
    const engine = new ReportEngine()
    return events.map(ev).flatMap(event => engine.fromEvent(event, 'data', 0).map(report => renderReport(report, lang)))
  }
  const warn = say([progress('r1', 1), progress('r1', 5), result(), result()])
  assert.equal(warn.length, 2)
  assert.match(warn[0], /그림자 리허설로 실제 요청을 비교/)
  assert.match(warn[1], /1240건 중 2건 불일치/)
  assert.match(warn[1], /DB 전환/)
  assert.match(say([result({ state: 'pass', mismatch: 0, match: 1240 })], 'en')[0], /all 1240 requests matched\. Go to the DB switch\?/)
  assert.match(say([result({ state: 'skipped', reason: 'SHADOW_NO_TRAFFIC' })], 'ja')[0], /スキップ/)
  assert.deepEqual(say([result({ state: 'stopped' })]), [])
})
