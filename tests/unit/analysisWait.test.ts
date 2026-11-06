import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analysisWait } from '../../src/lib/migration/analysisWait.ts'
import type { ReviewView } from '../../src/lib/migration/review.ts'
import { ko } from '../../src/lib/i18n/ko.ts'
import { en } from '../../src/lib/i18n/en.ts'
import { ja } from '../../src/lib/i18n/ja.ts'

const view = (phase: string, pending: ReviewView['pending'] = null): ReviewView =>
  ({ phase, analysis_ref: null, pending, items: [], security: [], blocked: [] })
const sse = { mode: 'sse' as const, done: true, finished: false }

test('목업 모드는 대기 표시가 없다', () => {
  assert.equal(analysisWait({ ...sse, mode: 'mock', view: null }), null)
})

test('analysis.done 전에는 대기 표시가 없다', () => {
  assert.equal(analysisWait({ ...sse, done: false, view: null }), null)
})

test('done 뒤 검토 상태를 아직 못 읽었거나 ANALYZING이면 매핑 중', () => {
  assert.equal(analysisWait({ ...sse, view: null }), 'mapping')
  assert.equal(analysisWait({ ...sse, view: view('ANALYZING') }), 'mapping')
})

test('검토가 사람을 기다리면 검토 대기', () => {
  assert.equal(analysisWait({ ...sse, view: view('WAITING_CONFIRMATION', 'confirm_requirements') }), 'review')
  assert.equal(analysisWait({ ...sse, view: view('WAITING_APPROVAL', 'approve_losses') }), 'review')
})

test('게이트를 지나면(finished) 원래 완료 표시로 돌아간다', () => {
  assert.equal(analysisWait({ ...sse, finished: true, view: null }), null)
  assert.equal(analysisWait({ ...sse, finished: true, view: view('APPROVED') }), null)
})

test('막힘 등 다른 상태는 대기 표시를 하지 않는다', () => {
  assert.equal(analysisWait({ ...sse, view: view('BLOCKED') }), null)
})

test('대기 문구는 세 언어 모두 있다', () => {
  const keys = ['analysis.wait.label', 'analysis.wait.mapping', 'analysis.wait.mappingDetail', 'analysis.wait.review', 'analysis.wait.reviewDetail', 'analysis.footer.mapping', 'analysis.footer.review']
  for (const dict of [ko, en, ja] as Record<string, string>[]) for (const key of keys) assert.ok(dict[key], key)
})
