/**
 * 실제 백엔드 SSE(cloud-migration-platform apps/api/src/cmp_api/event_stream.py)의 선 형식을 그대로 흘려 보는 시험.
 * 블록은 `_block`과 같은 모양: `id: <seq>` · (옛 화면용) `event: status` · `data: <json>` · 빈 줄.
 * data는 MigrationEvent.sse_payload() = {seq, at, phase, type, status, progress?, data}(migration_id 없음).
 * 이벤트 data는 계약 packages/contracts/src/cmp_contracts/events.py의 모델을 따른다.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reducer, type Action, type MigrationState } from '../../src/lib/migration/reducer.ts'
import { SseProvider, parseSseBlock } from '../../src/lib/migration/sseProvider.ts'
import { startRequestFor, type DraftEvent } from '../../src/lib/migration/events.ts'

const AT = '2026-11-06T00:00:00.000Z'
const MID = 'migration-demo-1'

type Payload = Record<string, unknown>
/** 백엔드 _block: id·event·data 줄 + 빈 줄. json.dumps(separators=(",", ":"))와 같은 압축 JSON. */
function wire(payload: Payload, options: { id?: number; event?: string } = {}) {
  const lines: string[] = []
  if (options.id !== undefined) lines.push('id: ' + options.id)
  if (options.event) lines.push('event: ' + options.event)
  lines.push('data: ' + JSON.stringify(payload))
  return lines.join('\n') + '\n\n'
}

/** 저장된 이벤트 하나(sse_payload) */
function stored(seq: number, draft: DraftEvent): Payload {
  const { progress, ...rest } = draft as DraftEvent & { progress?: number }
  return { seq, at: AT, ...rest, ...(progress === undefined ? {} : { progress }) }
}

function snapshot(seq: number, status: string, events: Payload[], reset = true): Payload {
  return { seq, at: AT, phase: 'analysis', type: 'snapshot', status: status === 'idle' ? 'running' : status, data: { migration_id: MID, status, reset, events } }
}

/** 옛 화면용 Workflow 상태(event: status). 이전 이벤트가 아니다. */
const LEGACY_STATUS = { workflow_id: MID, phase: 'sandbox', approval_pending: false, cancel_requested: false, mode: 'scaffold', failure_code: null, failure_phase: null, failure_issues: [], execution_status: 'RUNNING' }

/** 이벤트 목록을 seq 1부터 백엔드 선 형식으로 만든다(첫 블록은 빈 snapshot, 그다음 옛 status 블록). */
function stream(drafts: DraftEvent[], options: { from?: number; legacy?: boolean; status?: string } = {}) {
  const from = options.from ?? 0
  let text = wire(snapshot(from, options.status ?? 'running', [], from === 0), { id: from })
  if (options.legacy !== false) text += wire(LEGACY_STATUS, { event: 'status' })
  drafts.forEach((draft, index) => {
    text += wire(stored(from + index + 1, draft), { id: from + index + 1 })
    if (index === 0) text += ': heartbeat\n\n'
  })
  return text
}

/** 선 형식 텍스트를 블록으로 나눠 parseSseBlock → reducer에 흘린다(sseProvider.read와 같은 분할). */
function feed(text: string, state: MigrationState = initialState) {
  let next = state
  for (const block of text.split('\n\n')) {
    const parsed = parseSseBlock(block)
    if (parsed) next = reducer(next, { type: 'event', event: parsed.event })
  }
  return next
}

// ---- 계약 모양의 이벤트 ----

const finding = (id: string, stream: 'infrastructure' | 'code', key: string, progress: number): DraftEvent =>
  ({ type: 'analysis.finding', phase: 'analysis', status: 'running', progress, data: { id, stream, key, via: stream === 'code' ? ['code'] : ['config'], progress, message: '', detail: '' } })
const ANALYSIS: DraftEvent[] = [
  finding('infra-vpc', 'infrastructure', 'vpc', 40),
  finding('code-s3', 'code', 's3', 50),
  finding('infra-rds', 'infrastructure', 'rds', 80),
  // 코드 흐름은 100%를 따로 보내지 않는다: analysis.done만으로 끝나야 한다.
  { type: 'analysis.done', phase: 'analysis', status: 'done', progress: 100, data: {} },
]

const CHECKS = { required_passed: 12, required_total: 12, unsupported_calls: 0, calls_in_mapping: 4, calls_total: 4, blocked_egress: 0 }
const DIGEST = 'sha256:' + 'a'.repeat(64)
const steps = (run: number, attempt: number, failAt?: string): DraftEvent[] => {
  const out: DraftEvent[] = []
  for (const step of ['render', 'apply', 'ready', 'test', 'judge'] as const) {
    out.push({ type: 'sandbox.step', phase: 'build', status: 'running', data: { run, attempt, step, state: 'running' } })
    out.push({ type: 'sandbox.step', phase: 'build', status: 'running', data: { run, attempt, step, state: failAt === step ? 'failed' : 'done' } })
    if (failAt === step) break
  }
  return out
}
const attempt = (run: number, n: number, passed: boolean, fixIds: string[] = []): DraftEvent =>
  ({ type: 'sandbox.attempt', phase: 'build', status: 'running', data: { run, attempt: n, max_attempts: 3, verdict: { passed, reasons: passed ? [] : ['TEST:required failed'] }, failure_class: passed ? null : 'CODE', checks: passed ? CHECKS : { ...CHECKS, required_passed: 10 }, fix_ids: fixIds } })
const SANDBOX_START: DraftEvent[] = [
  { type: 'build.result', phase: 'build', status: 'done', data: { attempt: 1, max_attempts: 3, status: 'SUCCEEDED', digest: DIGEST, image_uri: 'registry/app@' + DIGEST, reused: false, error_code: null } },
  { type: 'sandbox.env', phase: 'build', status: 'running', data: { namespace: 'sbx-demo', expires_minutes: 30, egress_allowed: 2 } },
  { type: 'sandbox.tests', phase: 'build', status: 'running', data: { total: 12, catalog: 4, original: 6, generated: 2, read_only: 3 } },
]

test('선 형식: 이름 없는 블록은 이벤트, event: status(옛 Workflow 상태)·heartbeat·retry는 건너뛴다', () => {
  const typed = parseSseBlock(wire(stored(3, ANALYSIS[0]), { id: 3 }).trimEnd())
  assert.equal(typed?.id, '3')
  assert.equal(typed?.event.type, 'analysis.finding')
  assert.equal(parseSseBlock(wire(LEGACY_STATUS, { event: 'status' }).trimEnd()), null)
  assert.equal(parseSseBlock(': heartbeat'), null)
  assert.equal(parseSseBlock('retry: 1000'), null)
  assert.equal(parseSseBlock('id: 9\ndata: not json'), null)
  // 목업 서버는 type을 이름으로 붙인다(event: analysis.finding). 이름이 type과 다르면 이전 이벤트가 아니다.
  assert.equal(parseSseBlock(wire(stored(5, ANALYSIS[0]), { id: 5, event: 'analysis.finding' }).trimEnd())?.event.seq, 5)
  assert.equal(parseSseBlock(wire(stored(6, ANALYSIS[0]), { id: 6, event: 'status' }).trimEnd()), null)
  // event: message는 기본 이름과 같다.
  assert.equal(parseSseBlock('event: message\n' + wire(stored(4, ANALYSIS[1]), { id: 4 }).trimEnd())?.event.seq, 4)
})

test('옛 status 블록이 섞여 와도 상태가 망가지지 않는다(전에는 type 없는 값이 reducer를 undefined로 만들었다)', () => {
  const state = feed(stream(ANALYSIS))
  assert.ok(state && typeof state === 'object')
  assert.equal(state.lastSeq, ANALYSIS.length)
  assert.equal(state.status, 'running')
})

test('분석: finding → done. 흐름마다 100%가 오지 않아도 analysis.done이면 끝난다', () => {
  const state = feed(stream(ANALYSIS))
  assert.deepEqual(state.analysis.findings.map(item => item.id), ['infra-vpc', 'code-s3', 'infra-rds'])
  assert.equal(state.analysis.done, true)
  assert.deepEqual(state.failures, {})
})

test('모르는 이벤트 type은 무시하고 다음 이벤트를 계속 받는다', () => {
  const unknown = { type: 'analysis.someday', phase: 'analysis', status: 'running', data: {} } as unknown as DraftEvent
  const state = feed(stream([ANALYSIS[0], unknown, ANALYSIS[3]]))
  assert.equal(state.lastSeq, 3)
  assert.equal(state.analysis.done, true)
})

test('샌드박스 통과: 단계 → 판정 통과 → done(PENDING → CLEANED, PASSED)', () => {
  const state = feed(stream([
    ...SANDBOX_START, ...steps(1, 1), attempt(1, 1, true),
    { type: 'sandbox.done', phase: 'build', status: 'running', data: { status: 'PASSED', cleanup_status: 'PENDING', digest: DIGEST } },
    { type: 'sandbox.done', phase: 'build', status: 'done', data: { status: 'PASSED', cleanup_status: 'CLEANED', digest: DIGEST } },
  ]))
  assert.equal(state.sandbox.done?.status, 'PASSED')
  assert.equal(state.sandbox.done?.cleanup_status, 'CLEANED')
  assert.equal(state.sandbox.attempts.length, 1)
  assert.equal(state.sandbox.steps[1].judge, 'done')
  assert.equal(state.sandbox.env?.namespace, 'sbx-demo')
  assert.equal(state.build.review, null)
  assert.equal(state.status, 'running')
  assert.deepEqual(state.failures, {})
})

const FAILING_RUNS: DraftEvent[] = [
  ...SANDBOX_START,
  ...steps(1, 1, 'test'), attempt(1, 1, false, ['fix-1']),
  { type: 'build.fix', phase: 'build', status: 'running', data: { id: 'fix-1', check: 'health', lines: [{ kind: 'del', text: 'a' }, { kind: 'add', text: 'b' }], why: 'x', evidence: 'app.py:1' } },
  ...steps(2, 2, 'test'), attempt(2, 2, false),
  ...steps(3, 3, 'test'), attempt(3, 3, false),
]

test('샌드박스 실패 → 검토: build.review가 오면 검토 대기(waiting), 다음 시도가 시작되면 풀린다', () => {
  let state = feed(stream([
    ...FAILING_RUNS,
    { type: 'sandbox.done', phase: 'build', status: 'waiting', data: { status: 'NEEDS_REVIEW', cleanup_status: 'CLEANED', digest: null } },
    { type: 'build.review', phase: 'build', status: 'waiting', data: { reason: 'max_attempts', attempts: 3 } },
  ]))
  assert.equal(state.status, 'waiting')
  assert.deepEqual(state.build.review, { reason: 'max_attempts', attempts: 3 })
  assert.equal(state.sandbox.done?.status, 'NEEDS_REVIEW')
  assert.equal(state.sandbox.attempts.length, 3)
  // 사람이 고친 뒤 다시 돈다.
  state = feed(stream(steps(4, 3).slice(0, 1), { from: state.lastSeq }), state)
  assert.equal(state.build.review, null)
  assert.equal(state.sandbox.done, null)
  assert.equal(state.status, 'running')
})

test('샌드박스 실패 → 검토: build.review 없이 sandbox.done NEEDS_REVIEW만 와도 검토 안내를 띄운다', () => {
  const state = feed(stream([
    ...FAILING_RUNS,
    { type: 'sandbox.done', phase: 'build', status: 'waiting', data: { status: 'NEEDS_REVIEW', cleanup_status: 'CLEANED', digest: null } },
  ]))
  assert.equal(state.status, 'waiting')
  assert.deepEqual(state.build.review, { reason: 'max_attempts', attempts: 3 })
})

test('샌드박스 FAILED → 실패 안내, 뒤이은 error(_report_failure)가 코드를 정한다', () => {
  let state = feed(stream([
    ...FAILING_RUNS,
    { type: 'sandbox.done', phase: 'build', status: 'done', data: { status: 'FAILED', cleanup_status: 'CLEANED', digest: null } },
  ]))
  assert.equal(state.status, 'failed')
  assert.equal(state.failures.build?.code, 'SANDBOX_FAILED')
  // _report_failure: {code, message: '', phase, retryable: false}, 이벤트 status는 failed
  state = feed(stream([{ type: 'error', phase: 'build', status: 'failed', data: { code: 'SANDBOX_NOT_PASSED', message: '', phase: 'build', retryable: false } }], { from: state.lastSeq }), state)
  assert.equal(state.failures.build?.code, 'SANDBOX_NOT_PASSED')
  assert.equal(state.error?.phase, 'build')
  assert.equal(state.status, 'failed')
})

test('끊긴 뒤 재연결의 snapshot(reset=false, 빈 events)은 받은 값을 지우지 않는다', () => {
  let state = feed(stream(ANALYSIS))
  state = feed(stream([], { from: state.lastSeq, status: 'running' }), state)
  assert.equal(state.analysis.done, true)
  assert.equal(state.analysis.findings.length, 3)
})

// ---- 공급자 전체: fetch 스트림 · Last-Event-ID 재연결 · 끝난 뒤 정상 종료 ----

type Call = { url: string; headers: Record<string, string> }
function body(text: string) {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // 블록 중간에서 잘라 보낸다(조각난 수신도 이어 붙여야 한다).
      const cut = Math.floor(bytes.length / 2) + 3
      controller.enqueue(bytes.slice(0, cut))
      controller.enqueue(bytes.slice(cut))
      controller.close()
    },
  })
}

async function runProvider(streams: string[]) {
  const calls: Call[] = []
  const actions: Action[] = []
  let state = initialState
  const original = globalThis.fetch
  let index = 0
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, headers: { ...(init?.headers as Record<string, string> ?? {}) } })
    if (init?.method === 'POST') return new Response(JSON.stringify({ workflow_id: MID }), { status: 202, headers: { 'Content-Type': 'application/json' } })
    const text = streams[index++]
    if (text === undefined) return new Response('', { status: 503 })
    return new Response(body(text), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }) as typeof fetch
  const provider = new SseProvider({ dispatch: action => { actions.push(action); state = reducer(state, action) } }, { baseUrl: 'http://api', startMode: 'legacy' })
  try {
    provider.start(startRequestFor('gcp'))
    // 첫 스트림 + 재연결 대기(500ms) + 다음 스트림 + 닫힌 뒤 다시 붙는지 볼 여유
    await new Promise(resolve => setTimeout(resolve, 1500))
  } finally {
    provider.dispose()
    globalThis.fetch = original
  }
  return { calls: calls.filter(call => call.url.endsWith('/events')), actions, state: () => state }
}

test('공급자: 끝난 이전(error 뒤 서버가 닫음)은 다시 연결하지 않고 끊김 안내도 띄우지 않는다', async () => {
  const run = await runProvider([stream([
    ...ANALYSIS,
    { type: 'error', phase: 'build', status: 'failed', data: { code: 'BUILD_FAILED', message: '', phase: 'build', retryable: false } },
  ])])
  assert.equal(run.calls.length, 1)
  assert.ok(!run.actions.some(action => action.type === 'connection' && action.value === 'reconnecting'))
  const state = run.state()
  assert.equal(state.analysis.done, true)
  assert.equal(state.status, 'failed')
  assert.equal(state.failures.build?.code, 'BUILD_FAILED')
})

test('공급자: 끝나지 않은 채 끊기면 마지막 id를 Last-Event-ID로 보내 이어 받는다', async () => {
  const first = ANALYSIS.slice(0, 2)
  const run = await runProvider([
    stream(first),
    stream([...ANALYSIS.slice(2), ...SANDBOX_START, ...steps(1, 1), attempt(1, 1, true),
      { type: 'sandbox.done', phase: 'build', status: 'done', data: { status: 'PASSED', cleanup_status: 'CLEANED', digest: DIGEST } }], { from: first.length }),
  ])
  assert.ok(run.calls.length >= 2)
  assert.equal(run.calls[0].headers['Last-Event-ID'], undefined)
  assert.equal(run.calls[1].headers['Last-Event-ID'], String(first.length))
  const state = run.state()
  assert.equal(state.analysis.done, true)
  assert.equal(state.analysis.findings.length, 3)
  assert.equal(state.sandbox.done?.status, 'PASSED')
})
