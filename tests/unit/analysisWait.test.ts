import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analysisWait, showMappingSheet } from '../../src/lib/migration/analysisWait.ts'
import type { ReviewView } from '../../src/lib/migration/review.ts'
import { ko } from '../../src/lib/i18n/ko.ts'
import { en } from '../../src/lib/i18n/en.ts'
import { ja } from '../../src/lib/i18n/ja.ts'

const view = (phase: string, pending: ReviewView['pending'] = null): ReviewView =>
  ({ phase, analysis_ref: null, pending, items: [], security: [], blocked: [] })
const sse = { mode: 'sse' as const, done: true, known: false, past: false }

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

test('게이트를 지나거나(승인·다음 단계) 검토할 것이 없으면(404) 대기 표시가 없다', () => {
  assert.equal(analysisWait({ ...sse, past: true, view: null }), null)
  assert.equal(analysisWait({ ...sse, view: view('APPROVED') }), null)
  assert.equal(analysisWait({ ...sse, known: true, view: null }), null, '404')
  assert.equal(analysisWait({ ...sse, known: true, view: view('ANALYZING') }), 'mapping')
})

test('막힘 등 다른 상태는 대기 표시를 하지 않는다', () => {
  assert.equal(analysisWait({ ...sse, view: view('BLOCKED') }), null)
})

test('대기 문구는 세 언어 모두 있다', () => {
  const keys = ['analysis.wait.label', 'analysis.wait.mapping', 'analysis.wait.mappingDetail', 'analysis.wait.review', 'analysis.wait.reviewDetail', 'analysis.footer.mapping', 'analysis.footer.review']
  for (const dict of [ko, en, ja] as Record<string, string>[]) for (const key of keys) assert.ok(dict[key], key)
})

test('뼈대 검토 화면: 매핑 구간에 분석·첫 화면 밖에서만, 막힘에서 나갔으면 띄우지 않는다', () => {
  const base = { active: true, dismissed: false, stage: 'rehearsal', wait: 'mapping' as const }
  assert.equal(showMappingSheet(base), true)
  assert.equal(showMappingSheet({ ...base, stage: 'analysis' }), false, '분석 화면은 한 줄로')
  assert.equal(showMappingSheet({ ...base, stage: 'intro' }), false)
  assert.equal(showMappingSheet({ ...base, dismissed: true }), false)
  assert.equal(showMappingSheet({ ...base, active: false }), false, '이전이 끝났거나 분석을 지났다')
  assert.equal(showMappingSheet({ ...base, wait: 'review' }), false, '게이트가 서면 실제 검토 화면')
  assert.equal(showMappingSheet({ ...base, wait: null }), false, '404: 검토할 것이 없으면 닫는다')
})

test('뼈대 검토 화면 문구가 세 언어에 있다', () => {
  const keys = ['step', 'title', 'lead', 'stepsAria', 'mapping', 'evidence', 'ready', 'elapsed', 'note', 'security'].map(key => 'reviewGate.loading.' + key)
  for (const dict of [ko, en, ja] as Record<string, string>[]) for (const key of keys) assert.ok(dict[key], key)
  assert.ok(ko['reviewGate.loading.title'].includes('매핑'))
})
