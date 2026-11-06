import { test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalIds, approvalsOf, defaultRequired, parseReview, reviewBlocked, reviewErrorKey, reviewWaiting } from '../../src/lib/migration/review.ts'
import { SseProvider } from '../../src/lib/migration/sseProvider.ts'
import { startRequestFor } from '../../src/lib/migration/events.ts'
import { ko } from '../../src/lib/i18n/ko.ts'
import { en } from '../../src/lib/i18n/en.ts'
import { ja } from '../../src/lib/i18n/ja.ts'
import type { Action } from '../../src/lib/migration/reducer.ts'

// 플랫폼 ReviewGate.view() 모양(cmp_worker/review_gate.py)
const row = (id: string, grade: string, over: Record<string, unknown> = {}) => ({
  id, capability: 'cap-' + id, usage: 'usage ' + id, grade, loses: ['x'],
  required_proposed: grade === 'DIRECT', required_reason: 'why ' + id, required: null, treatment: null, ...over,
})
const security = (criterion: string, verdict: string) => ({
  id: 'security:' + criterion, criterion, source_state: 'PROTECTED', target_state: 'UNPROTECTED', verdict, weak_source: false,
  reasons: ['TARGET_ENTRY_WITHOUT_TLS'], suggestion: 'ENFORCE_HTTPS_AT_ENTRY', proof: null, approvable: verdict === 'LOWER', decision: null,
})
const waitingConfirm = {
  phase: 'WAITING_CONFIRMATION', analysis_ref: { id: 'analysis', version: 1 }, pending: 'confirm_requirements',
  items: [row('a', 'DIRECT'), row('b', 'PARTIAL'), row('c', 'NONE')], security: [security('EXTERNAL_HTTPS', 'LOWER'), security('DB_ACCESS_SCOPE', 'SAME')],
  blocked: [], rejections: [],
}

test('검토 게이트: 서버 응답을 화면 모양으로 바꾸고, 분석 버전은 문자열로 맞춘다', () => {
  const view = parseReview(waitingConfirm)
  assert.ok(view)
  assert.equal(view.pending, 'confirm_requirements')
  assert.deepEqual(view.analysis_ref, { id: 'analysis', version: '1' })
  assert.deepEqual(view.items.map(item => item.id), ['a', 'b', 'c'])
  assert.equal(view.items[1].loses[0], 'x')
  assert.equal(view.security[0].approvable, true)
  assert.ok(reviewWaiting(view) && !reviewBlocked(view))
})

test('검토 게이트: 모양이 틀린 응답은 null이고, 모르는 pending은 기다리지 않는 것으로 본다', () => {
  assert.equal(parseReview(null), null)
  assert.equal(parseReview([]), null)
  assert.equal(parseReview({ detail: 'ANALYSIS_NOT_FOUND' }), null)
  const odd = parseReview({ ...waitingConfirm, pending: 'something_new', items: [{ nope: 1 }, row('a', 'DIRECT')], security: 'x' })
  assert.equal(odd?.pending, null)
  assert.deepEqual(odd?.items.map(item => item.id), ['a'])
  assert.deepEqual(odd?.security, [])
  assert.equal(reviewWaiting(odd), false)
  assert.equal(reviewWaiting(null), false)
})

test('검토 게이트: 확정의 처음 값은 서버 제안이고, 이미 확정된 값이 있으면 그것이다', () => {
  const view = parseReview(waitingConfirm)!
  assert.deepEqual(defaultRequired(view), { a: true, b: false, c: false })
  const decided = parseReview({ ...waitingConfirm, items: [row('a', 'DIRECT', { required: false }), row('b', 'PARTIAL', { required: true })] })!
  assert.deepEqual(defaultRequired(decided), { a: false, b: true })
})

test('검토 게이트: 승인은 처리가 APPROVAL인 기능과 승인 대상 보안 항목 전부에 답해야 보낼 수 있다', () => {
  const view = parseReview({
    ...waitingConfirm, phase: 'WAITING_APPROVAL', pending: 'approve_losses',
    items: [row('a', 'DIRECT', { treatment: 'MIGRATE' }), row('b', 'PARTIAL', { treatment: 'APPROVAL' }), row('c', 'NONE', { treatment: 'APPROVAL' })],
  })!
  assert.deepEqual(approvalIds(view), ['b', 'c', 'security:EXTERNAL_HTTPS'])
  assert.equal(approvalsOf(view, {}), null)
  assert.equal(approvalsOf(view, { b: 'APPROVED', c: 'REJECTED' }), null, '보안 항목이 빠졌다')
  assert.deepEqual(approvalsOf(view, { b: 'APPROVED', c: 'REJECTED', 'security:EXTERNAL_HTTPS': 'APPROVED', a: 'APPROVED' }),
    { b: 'APPROVED', c: 'REJECTED', 'security:EXTERNAL_HTTPS': 'APPROVED' }, '승인 대상이 아닌 항목(a)은 보내지 않는다')
})

test('검토 게이트: 막힌 상태와 서버 거절 코드의 문구 키', () => {
  const blocked = parseReview({ ...waitingConfirm, phase: 'BLOCKED', pending: null, blocked: [{ id: 'c', capability: 'cap-c', usage: 'u', grade: 'NONE', reason: 'r', alternative: 'alt' }] })!
  assert.ok(reviewBlocked(blocked) && !reviewWaiting(blocked))
  assert.equal(blocked.blocked[0].alternative, 'alt')
  assert.equal(reviewErrorKey('MISSING_ROW'), 'reviewGate.err.missing')
  assert.equal(reviewErrorKey('SOMETHING_NEW'), 'reviewGate.err.generic')
})

test('검토 게이트: 쓰는 문구가 한국어·영어·일본어에 모두 있다', () => {
  const keys = Object.keys(ko).filter(key => key.startsWith('reviewGate.'))
  assert.ok(keys.length > 40)
  for (const key of keys) {
    assert.ok((en as Record<string, string>)[key], 'en ' + key)
    assert.ok((ja as Record<string, string>)[key], 'ja ' + key)
  }
  for (const grade of ['DIRECT', 'API_DIFF', 'PARTIAL', 'NONE']) assert.ok(keys.includes('reviewGate.grade.' + grade), '등급 문구 ' + grade) // 플랫폼 MappingRow.grade 전부
  for (const code of ['MISSING_ROW', 'UNKNOWN_ROW', 'NOT_APPROVABLE', 'ANALYSIS_REF_MISMATCH', 'REVIEW_NOT_PENDING', 'REVIEW_UNAVAILABLE', 'X']) {
    assert.ok(keys.includes(reviewErrorKey(code)), code)
  }
})

// ---- SSE 공급자: 검토 API 호출 ----

function harness(respond: (method: string, url: string, body: unknown) => Response) {
  const original = globalThis.fetch
  const calls: Array<{ method: string; url: string; body: unknown }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/events')) return new Response(null, { status: 404 })
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })
    if (method === 'POST' && url.endsWith('/migrations')) return Response.json({ workflow_id: 'm-1', run_id: 'r-1' }, { status: 202 })
    return respond(method, url, body)
  }) as typeof fetch
  const actions: Action[] = []
  const provider = new SseProvider({ dispatch: action => actions.push(action) }, { baseUrl: 'http://backend.test', startMode: 'legacy' })
  return { provider, calls, actions, restore: () => { provider.dispose(); globalThis.fetch = original } }
}
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const REVIEW = 'http://backend.test/migrations/m-1/analysis/review'

test('SSE 공급자: 이전이 시작되기 전이나 서버에 검토 API가 없으면 검토할 것이 없다(오류 안내 없음)', async () => {
  const { provider, calls, actions, restore } = harness(() => Response.json({ detail: 'ANALYSIS_NOT_FOUND' }, { status: 404 }))
  try {
    assert.equal(await provider.loadReview(), null)
    assert.equal(calls.length, 0, '이전 ID가 없으면 부르지 않는다')
    provider.start(startRequestFor('gcp'))
    await settle()
    assert.equal(await provider.loadReview(), null)
    assert.ok(calls.some(call => call.url === REVIEW))
    assert.ok(!actions.some(action => action.type === 'fail' && action.error.code === 'request_failed'), '404는 요청 실패 안내를 띄우지 않는다')
  } finally { restore() }
})

test('SSE 공급자: 필수 확정과 승인은 읽어 둔 분석 버전과 함께 보내고, 보낸 뒤 새 상태를 돌려준다', async () => {
  let state: unknown = waitingConfirm
  const { provider, calls, restore } = harness((method, url) => {
    if (method === 'GET' && url === REVIEW) return Response.json(state)
    if (method === 'POST' && url === REVIEW + '/confirm') { state = { ...waitingConfirm, phase: 'WAITING_APPROVAL', pending: 'approve_losses' }; return Response.json({}, { status: 202 }) }
    if (method === 'POST' && url === REVIEW + '/approve') { state = { ...waitingConfirm, phase: 'APPROVED', pending: null }; return Response.json({}, { status: 202 }) }
    return new Response(null, { status: 404 })
  })
  try {
    provider.start(startRequestFor('gcp'))
    await settle()
    assert.deepEqual(await provider.confirmReview({ a: true }), { ok: false, code: 'REVIEW_NOT_PENDING' }, '읽기 전에는 보내지 않는다')
    const view = await provider.loadReview()
    assert.equal(view?.pending, 'confirm_requirements')

    const confirmed = await provider.confirmReview({ a: true, b: false, c: false })
    assert.ok(confirmed.ok && confirmed.view?.pending === 'approve_losses')
    const approved = await provider.approveReview({ b: 'APPROVED', 'security:EXTERNAL_HTTPS': 'REJECTED' })
    assert.ok(approved.ok && approved.view?.pending === null)

    const posts = calls.filter(call => call.method === 'POST' && call.url.startsWith(REVIEW))
    assert.deepEqual(posts.map(call => call.body), [
      { analysis_version: '1', required: { a: true, b: false, c: false } },
      { analysis_version: '1', approvals: { b: 'APPROVED', 'security:EXTERNAL_HTTPS': 'REJECTED' } },
    ])
  } finally { restore() }
})

test('SSE 공급자: 서버가 거절하면 코드를 그대로 돌려주고 화면 전체 실패로 만들지 않는다', async () => {
  const { provider, actions, restore } = harness((method, url) => {
    if (method === 'GET' && url === REVIEW) return Response.json(waitingConfirm)
    if (method === 'POST') return Response.json({ detail: 'MISSING_ROW' }, { status: 422 })
    return new Response(null, { status: 404 })
  })
  try {
    provider.start(startRequestFor('gcp'))
    await settle()
    await provider.loadReview()
    assert.deepEqual(await provider.confirmReview({ a: true }), { ok: false, code: 'MISSING_ROW' })
    assert.ok(!actions.some(action => action.type === 'fail' && action.error.code === 'request_failed'), '요청 실패 안내를 띄우지 않는다')
  } finally { restore() }
})
