import { test } from 'node:test'
import assert from 'node:assert/strict'
import { currentStep, elapsedSeconds, isMasked, mappingCell, markTime, splitSeconds, waitingForAnalysisReview } from '../../src/lib/migration/sandboxProgress.ts'
import { reducer as reduce, initialState } from '../../src/lib/migration/reducer.ts'
import { ko } from '../../src/lib/i18n/ko.ts'
import { en } from '../../src/lib/i18n/en.ts'
import { ja } from '../../src/lib/i18n/ja.ts'

const T0 = '2026-11-07T10:00:00.000Z'
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString()

test('markTime: running은 새로 시작, done·failed는 끝을 찍는다', () => {
  const run = markTime(undefined, 'running', at(2.2))
  assert.deepEqual(run, { start: at(2.2), end: null })
  assert.deepEqual(markTime(run, 'done', at(35.7)), { start: at(2.2), end: at(35.7) })
  assert.deepEqual(markTime(undefined, 'done', at(5)), { start: at(5), end: at(5) })
  assert.deepEqual(markTime({ start: at(1), end: at(2) }, 'running', at(9)), { start: at(9), end: null })
})

test('elapsedSeconds: 끝났으면 끝-시작, 진행 중이면 지금까지', () => {
  assert.equal(elapsedSeconds({ start: at(2.2), end: at(35.7) }, 0), 33)
  assert.equal(elapsedSeconds({ start: at(2.2), end: null }, Date.parse(at(25.4))), 23)
  assert.equal(elapsedSeconds(undefined, 0), null)
  assert.equal(elapsedSeconds({ start: 'x', end: null }, 0), null)
  assert.equal(elapsedSeconds({ start: at(10), end: null }, Date.parse(at(5))), 0)
})

test('currentStep: 마지막으로 running인 단계', () => {
  assert.equal(currentStep({ render: 'done', apply: 'running' }), 'apply')
  assert.equal(currentStep({ render: 'done', apply: 'done' }), null)
  assert.equal(currentStep({}), null)
})

test('splitSeconds', () => {
  assert.deepEqual(splitSeconds(23), { m: 0, s: 23 })
  assert.deepEqual(splitSeconds(65), { m: 1, s: 5 })
})

test('isMasked: 서버가 가린 값', () => {
  for (const v of ['[MASKED]', 'MASKED', '***', '<redacted>', '', null]) assert.equal(isMasked(v), true, String(v))
  assert.equal(isMasked('cmp-sbx-abc123'), false)
})

test('mappingCell: 호출 0건이면 확인할 것 없음', () => {
  assert.deepEqual(mappingCell(0, 0), { kind: 'none' })
  assert.deepEqual(mappingCell(2, 3), { kind: 'ratio', text: '2 / 3' })
})

test('waitingForAnalysisReview: 실제 모드 · 이전 시작 · 분석 phase · 샌드박스 이벤트 없음', () => {
  const base = { mode: 'sse' as const, migrationId: 'm1', lastPhase: 'analysis', hasSandboxEvents: false }
  assert.equal(waitingForAnalysisReview(base), true)
  assert.equal(waitingForAnalysisReview({ ...base, mode: 'mock' }), false)
  assert.equal(waitingForAnalysisReview({ ...base, migrationId: null }), false)
  assert.equal(waitingForAnalysisReview({ ...base, lastPhase: 'build' }), false)
  assert.equal(waitingForAnalysisReview({ ...base, hasSandboxEvents: true }), false)
})

test('reducer: 빌드·샌드박스 단계 시각을 이벤트 at으로 남긴다', () => {
  let seq = 0
  const ev = (type: string, data: unknown, s: number) => ({ type: 'event' as const, event: { seq: ++seq, type, phase: 'build', status: 'running', at: at(s), data } as never })
  let state = initialState
  state = reduce(state, ev('build.check', { id: 'build', state: 'running' }, 0))
  state = reduce(state, ev('build.check', { id: 'build', state: 'done' }, 1.1))
  state = reduce(state, ev('sandbox.step', { run: 1, attempt: 1, step: 'apply', state: 'running' }, 2.2))
  state = reduce(state, ev('sandbox.step', { run: 1, attempt: 1, step: 'apply', state: 'done' }, 35.7))
  assert.deepEqual(state.build.buildAt, { start: at(0), end: at(1.1) })
  assert.equal(elapsedSeconds(state.sandbox.at[1].apply, 0), 33)
})

test('새 문구는 세 언어 모두 있다', () => {
  const keys = Object.keys(ko).filter(key => /^sbx\.(build|ing\.|doing\.|sec|minSec|statusNow|doneIn|failedIn|foot\.now|nsHidden|cond\.mappingNone|verdictWait|waitReview)/.test(key))
  assert.ok(keys.length >= 20)
  for (const dict of [en, ja] as Record<string, string>[]) for (const key of keys) assert.ok(dict[key], key)
})
