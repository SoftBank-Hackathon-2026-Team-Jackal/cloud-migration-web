import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CAPABILITIES, SSE_CAPABILITIES, capabilitiesFor, parseCapabilities } from '../../src/lib/migration/capabilities.ts'
import { SseProvider } from '../../src/lib/migration/sseProvider.ts'
import { startRequestFor } from '../../src/lib/migration/events.ts'
import type { Action } from '../../src/lib/migration/reducer.ts'

test('동작 목록: 목업은 모두 되고, SSE 기본값은 백엔드에 없는 API를 모두 끈다', () => {
  assert.deepEqual([...capabilitiesFor('mock')].sort(), [...CAPABILITIES].sort())
  // 목업은 환경변수와 상관없이 모두 된다(목업 화면은 지금과 같다)
  assert.deepEqual([...capabilitiesFor('mock', 'none')].sort(), [...CAPABILITIES].sort())
  assert.deepEqual(SSE_CAPABILITIES, [])
  assert.equal(capabilitiesFor('sse', undefined).size, 0)
  assert.equal(capabilitiesFor('sse', '').size, 0)
})

test('동작 목록: NEXT_PUBLIC_SSE_CAPABILITIES는 쉼표 구분, 모르는 이름은 버리고 none은 모두 끔', () => {
  assert.deepEqual([...parseCapabilities(' report , traffic.rollback,bogus ')].sort(), ['report', 'traffic.rollback'])
  assert.equal(parseCapabilities('none').size, 0)
  assert.deepEqual([...parseCapabilities('', ['report'])], ['report'])
  assert.deepEqual([...parseCapabilities('traffic.retry', ['report'])], ['traffic.retry'])
})

function harness(capabilities?: ReadonlySet<(typeof CAPABILITIES)[number]>) {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/events')) return new Response(null, { status: 404 })
    calls.push((init?.method ?? 'GET') + ' ' + url)
    return Response.json({ id: 'm-1', stages: [], ai_fixes: 0 })
  }) as typeof fetch
  const actions: Action[] = []
  const provider = new SseProvider({ dispatch: action => actions.push(action) }, { baseUrl: 'http://backend.test', startMode: 'legacy', ...(capabilities ? { capabilities } : {}) })
  return { provider, calls, actions, restore: () => { provider.dispose(); globalThis.fetch = original } }
}
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const actionsOf = (provider: SseProvider) => { provider.retrySandbox(); provider.rollbackTraffic(); provider.retryTraffic(); provider.loadReport() }

test('SSE 공급자: 기본값이면 없는 API(샌드박스 재시도·트래픽 롤백/재시도·리포트)를 부르지 않는다', async () => {
  const { provider, calls, actions, restore } = harness()
  try {
    provider.start(startRequestFor('gcp'))
    await settle()
    calls.length = 0
    actionsOf(provider)
    await settle()
    assert.deepEqual(calls, [])
    assert.ok(!actions.some(action => action.type === 'fail' && action.error.code === 'report_failed'), '리포트 실패 안내를 띄우지 않는다')
    // 있는 API는 그대로
    provider.cancel()
    await settle()
    assert.deepEqual(calls, ['POST http://backend.test/migrations/m-1/cancel'])
  } finally { restore() }
})

test('SSE 공급자: 다음 단계(advance)는 capability와 상관없이 보내고, 409는 조용히 넘긴다', async () => {
  const { provider, calls, restore } = harness()
  try {
    provider.start(startRequestFor('gcp'))
    await settle()
    calls.length = 0
    await provider.advanceTraffic()
    assert.deepEqual(calls, ['POST http://backend.test/migrations/m-1/traffic/advance'])
  } finally { restore() }
  // 409 TRAFFIC_ACTION_NOT_ALLOWED: 이미 넘어간 것이라 오류를 띄우지 않는다.
  const original = globalThis.fetch
  const dispatched: Action[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith('/events')) return new Response(null, { status: 404 })
    return Response.json({ detail: { code: 'TRAFFIC_ACTION_NOT_ALLOWED' } }, { status: 409 })
  }) as typeof fetch
  const quiet = new SseProvider({ dispatch: action => dispatched.push(action) }, { baseUrl: 'http://backend.test', startMode: 'legacy' })
  try {
    quiet.start(startRequestFor('gcp'))
    await settle()
    dispatched.length = 0
    await quiet.advanceTraffic()
    assert.ok(!dispatched.some(action => action.type === 'fail' || action.type === 'requestError'), JSON.stringify(dispatched))
  } finally { quiet.dispose(); globalThis.fetch = original }
})

test('SSE 공급자: 동작을 켜면 예전 경로로 보낸다', async () => {
  const { provider, calls, restore } = harness(new Set(CAPABILITIES))
  try {
    provider.start(startRequestFor('gcp'))
    await settle()
    calls.length = 0
    actionsOf(provider)
    await settle()
    assert.deepEqual(calls.sort(), [
      'GET http://backend.test/migrations/m-1/report',
      'POST http://backend.test/migrations/m-1/sandbox/retry',
      'POST http://backend.test/migrations/m-1/traffic/retry',
      'POST http://backend.test/migrations/m-1/traffic/rollback',
    ])
  } finally { restore() }
})
