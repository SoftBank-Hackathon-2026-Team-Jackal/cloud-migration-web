#!/usr/bin/env node
/**
 * 목업 SSE 서버. 백엔드 없이 NEXT_PUBLIC_API_MODE=sse 로 화면을 시험하려고 쓴다. 외부 의존성 없이 Node 기본 모듈만 쓴다.
 * 이벤트 대본과 트래픽 시뮬레이터는 브라우저의 MockProvider와 같은 모듈(src/lib/migration)을 읽는다.
 * Node 22.18 이상이 필요하다(.ts 파일을 그대로 읽는다).
 *
 *   npm run mock:server                      # http://127.0.0.1:8000
 *   PORT=9000 npm run mock:server
 *   MOCK_STATE_FILE=/tmp/x.json npm run mock:server   # 진행 상황 저장 위치(서버를 껐다 켜도 이어 간다)
 *
 * 승인 이벤트(approval.required)에서는 POST /migrations/{id}/approve 가 올 때까지 기다린다.
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APPROVAL_ID, PLAN_ID, PLAN_REVEAL_MS, approvalTimeline, REPORT_SECONDS, TRAFFIC_READY_EVENTS, timelineEnd, timelineFor } from '../src/lib/migration/script.ts'
import { DATA_END_MS, DATA_LSN_TICK_MS, dataTickAt, dataTimeline } from '../src/lib/migration/dataScript.ts'
import { targetOfRequest } from '../src/lib/migration/events.ts'
import { TrafficSim } from '../src/lib/migration/trafficSim.ts'

const PORT = Number(process.env.PORT || 8000)
const HOST = process.env.HOST || '127.0.0.1'
const STATE_FILE = process.env.MOCK_STATE_FILE || join(tmpdir(), 'mock-sse-state.json')
const HEARTBEAT_MS = 15000
const PHASE_GAP_MS = 800

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID, Authorization, Accept',
  'Access-Control-Expose-Headers': 'Content-Type',
}

/** @typedef {{ id: string, target: 'gcp'|'onprem', status: string, phase: string, seq: number, history: any[], approved: { plan: boolean, cutover: boolean, review: boolean }, aiFixes: number, revision: number, review: boolean, retried: boolean }} Record */
/** 실행 중인 상태(저장하지 않는 것): 연결된 클라이언트, 대기 중인 타이머, 트래픽 시뮬레이터 */
const live = new Map()
/** @type {Map<string, Record>} */
const migrations = new Map()

const CANCELLED = Symbol('cancelled')

// ---- 저장 ----

let saveQueued = false
function save() {
  if (saveQueued) return
  saveQueued = true
  setImmediate(() => {
    saveQueued = false
    try { writeFileSync(STATE_FILE, JSON.stringify([...migrations.values()])) } catch (error) { console.error('상태 저장 실패:', error.message) }
  })
}

function load() {
  if (!existsSync(STATE_FILE)) return
  try {
    for (const record of JSON.parse(readFileSync(STATE_FILE, 'utf8'))) migrations.set(record.id, record)
  } catch (error) { console.error('저장된 상태를 읽지 못했습니다:', error.message) }
}

// ---- 이벤트 ----

function runtime(id) {
  let state = live.get(id)
  if (!state) {
    state = { clients: new Set(), waiters: new Set(), approvals: new Map(), sim: null, cancelled: false }
    live.set(id, state)
  }
  return state
}

function frame(event) {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

function emit(record, draft) {
  record.seq += 1
  const event = { ...draft, seq: record.seq, at: new Date().toISOString() }
  record.history.push(event)
  if (draft.phase) record.phase = draft.phase
  save()
  for (const client of runtime(record.id).clients) client.write(frame(event))
  return event
}

/** 연결 직후(재접속 포함)에 보내는 상태 복원 이벤트. Last-Event-ID가 있으면 그 뒤의 이벤트만 담는다. */
function snapshotFor(record, lastEventId) {
  const events = record.history.filter(event => event.seq > lastEventId)
  return {
    seq: record.seq, at: new Date().toISOString(), phase: record.phase, type: 'snapshot', status: 'running',
    data: { migration_id: record.id, status: record.status, reset: lastEventId === 0, events },
  }
}

// ---- 대본 실행 ----

function wait(record, ms) {
  const state = runtime(record.id)
  return new Promise((resolve, reject) => {
    if (state.cancelled) return reject(CANCELLED)
    const waiter = { timer: setTimeout(() => { state.waiters.delete(waiter); resolve() }, ms), reject }
    state.waiters.add(waiter)
  })
}

function cancelRun(record) {
  const state = runtime(record.id)
  state.cancelled = true
  state.sim?.stop()
  for (const waiter of state.waiters) { clearTimeout(waiter.timer); waiter.reject(CANCELLED) }
  state.waiters.clear()
  for (const [, approval] of state.approvals) approval.reject(CANCELLED)
  state.approvals.clear()
}

/** 대본을 정해진 시각대로 내보낸다. */
async function play(record, items) {
  const began = Date.now()
  for (const { after, event } of [...items].sort((a, b) => a.after - b.after)) {
    await wait(record, Math.max(0, after - (Date.now() - began)))
    emit(record, event)
  }
}

/** 승인이 올 때까지 기다린다. 이미 승인된 이전(서버 재시작 뒤 이어 가기)은 바로 지나간다. */
function waitApproval(record, gate) {
  if (record.approved[gate]) return Promise.resolve()
  const state = runtime(record.id)
  return new Promise((resolve, reject) => { state.approvals.set(gate, { resolve, reject }) })
}

function approve(record, gate) {
  if (record.approved[gate]) return true
  const approval = runtime(record.id).approvals.get(gate)
  if (!approval) return false
  record.approved[gate] = true
  runtime(record.id).approvals.delete(gate)
  save()
  approval.resolve()
  return true
}

const PHASES = ['analysis', 'build', 'planning', 'approval', 'provisioning', 'data_copy', 'traffic', 'verification']

const phaseRunners = {
  async analysis(record) {
    const items = timelineFor('analysis', context(record))
    await play(record, items)
  },
  async build(record) {
    // 데모(?review=1): 처음 빌드는 3번 실패하고 사람 검토를 기다린다. POST …/sandbox/retry 뒤에는 이전 빌드를 재사용해 성공한다.
    if (record.review && !record.approved.review) {
      await play(record, timelineFor('build', { ...context(record), review: true }))
      record.status = 'waiting'
      await waitApproval(record, 'review')
      record.status = 'running'
      record.retried = true
    }
    await play(record, timelineFor('build', context(record)))
  },
  async planning(record) {
    await play(record, timelineFor('planning', context(record)))
    // 화면이 계획 항목을 하나씩 드러내는 연출이 끝날 때까지 기다린다.
    await wait(record, PLAN_REVEAL_MS)
  },
  async approval(record) {
    emit(record, { type: 'approval.required', phase: 'awaiting_approval', status: 'waiting', data: { excluded: [], rollback_policy: '' } })
    record.status = 'waiting'
    await waitApproval(record, 'plan')
    record.status = 'running'
    // 결정 기록(PENDING) → 실행 엔진에 전달(DELIVERED). 전달이 끝난 뒤에 구축을 시작한다(ADR-002).
    await play(record, approvalTimeline(record.revision))
  },
  async provisioning(record) {
    await play(record, timelineFor('provisioning', context(record)))
  },
  async data_copy(record) {
    // 사전 검사 → (PASS면) 스키마 → 초기 복사 → CDC → 스트리밍. 대본과 250ms 틱(data.lsn·data.progress)을 함께 흘린다.
    // 사전 검사가 PASS가 아니면(?preflight=route|unknown) 시작 차단에서 멈춘다(다음 단계로 넘어가지 않는다).
    const scenario = record.preflight ?? 'pass'
    const began = Date.now()
    let finished = false
    const script = play(record, dataTimeline(record.target, scenario, began)).finally(() => { finished = true })
    for (;;) {
      await wait(record, DATA_LSN_TICK_MS)
      for (const event of dataTickAt(Date.now() - began, scenario)) emit(record, event)
      if (scenario === 'pass' && finished && Date.now() - began > DATA_END_MS) break
      // 시작 차단: 판정 뒤에는 더 보낼 것이 없다. 취소될 때까지 기다린다.
      if (scenario !== 'pass' && finished) await wait(record, 2 ** 31 - 1)
    }
    await script
  },
  async traffic(record) {
    const state = runtime(record.id)
    // 먼저 전환 조건을 확인한다(전환 가능 시점).
    let readyDone = 0
    for (const item of TRAFFIC_READY_EVENTS) {
      await wait(record, item.after - readyDone)
      readyDone = item.after
      emit(record, { type: 'traffic.ready', phase: 'traffic', status: 'running', data: item.data })
    }
    await new Promise((resolve, reject) => {
      const sim = new TrafficSim(data => {
        emit(record, { type: 'traffic.snapshot', phase: 'traffic', status: data.phase === 'complete' ? 'done' : 'running', data })
        if (data.phase === 'complete' && data.residual.requests_per_sec === 0 && data.residual.streams === 0) resolve()
      })
      state.sim = sim
      state.approvals.set('traffic', { resolve, reject })
      sim.start()
    })
    state.approvals.delete('traffic')
    state.sim?.stop()
    state.sim = null
  },
  async verification(record) {
    emit(record, { type: 'approval.required', phase: 'verification', status: 'waiting', data: { excluded: [], rollback_policy: '', gate: 'cutover' } })
    record.status = 'waiting'
    await waitApproval(record, 'cutover')
    record.status = 'running'
    await play(record, timelineFor('verification', context(record)))
  },
}

function context(record) {
  return { target: record.target, aiFixes: record.aiFixes, revision: record.revision, retried: record.retried }
}

async function run(record, from) {
  const state = runtime(record.id)
  state.cancelled = false
  try {
    for (const phase of PHASES.slice(PHASES.indexOf(from))) {
      record.pending = phase
      save()
      await phaseRunners[phase](record)
      await wait(record, PHASE_GAP_MS)
    }
    record.status = 'done'
    record.pending = null
    save()
  } catch (error) {
    if (error !== CANCELLED) {
      console.error('대본 실행 실패:', error)
      fail(record, 'internal_error', String(error?.message ?? error))
    }
  }
}

function fail(record, code, message) {
  record.status = 'failed'
  emit(record, { type: 'error', phase: record.phase, status: 'failed', message, data: { code, message, phase: record.phase, retryable: false } })
}

// ---- HTTP ----

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

function openStream(req, res, record) {
  const header = Array.isArray(req.headers['last-event-id']) ? req.headers['last-event-id'][0] : req.headers['last-event-id']
  const lastEventId = Number(header ?? new URL(req.url, 'http://x').searchParams.get('lastEventId') ?? 0) || 0
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...CORS })
  res.write('retry: 1000\n\n')
  res.write(frame(snapshotFor(record, lastEventId)))
  const state = runtime(record.id)
  state.clients.add(res)
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)
  req.on('close', () => { clearInterval(heartbeat); state.clients.delete(res) })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname.replace(/\/+$/, '') || '/'
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end() }

  if (req.method === 'POST' && path === '/migrations') {
    const body = await readBody(req)
    const record = {
      id: 'm-' + randomUUID().slice(0, 8), target: targetOfRequest(body), status: 'running', phase: 'analysis',
      revision: 1, review: url.searchParams.get('review') === '1', retried: false,
      preflight: ['route', 'unknown'].includes(url.searchParams.get('preflight')) ? url.searchParams.get('preflight') : 'pass',
      seq: 0, history: [], approved: { plan: false, cutover: false, review: false }, aiFixes: Number(body.ai_fixes) >= 1 && Number(body.ai_fixes) <= 4 ? Number(body.ai_fixes) : 1, pending: 'analysis',
    }
    migrations.set(record.id, record)
    save()
    void run(record, 'analysis')
    return send(res, 201, { id: record.id, status: record.status })
  }

  // 개발용: 모든 SSE 연결을 끊는다(네트워크가 끊긴 상황을 흉내 낸다).
  if (req.method === 'POST' && path === '/__debug/disconnect') {
    for (const state of live.values()) for (const client of [...state.clients]) client.destroy()
    return send(res, 200, { ok: true })
  }

  // 백엔드 승인 API(openapi): POST /provisioning/plans/{plan_id}/revisions/{revision}/approvals
  // 본문 {decision, scope, manifest_digest, preview_digest}. 목업은 승인을 기다리는 이전 하나에 적용한다.
  const approvals = path.match(/^\/provisioning\/plans\/([^/]+)\/revisions\/(\d+)\/approvals$/)
  if (req.method === 'POST' && approvals) {
    const body = await readBody(req)
    // 목업의 plan_id는 모두 같으므로, 승인을 기다리는 가장 최근 이전을 고른다.
    const record = [...migrations.values()].reverse().find(item => item.status === 'waiting' && item.pending === 'approval')
    if (!record) return send(res, 404, { error: 'PLAN_NOT_FOUND' })
    if (Number(approvals[2]) !== record.revision) return send(res, 409, { error: 'STALE_REVISION', revision: record.revision })
    const hex64 = /^[a-f0-9]{64}$/
    if (!['APPROVE', 'REJECT'].includes(body.decision) || !['INFRASTRUCTURE', 'WORKLOADS', 'FULL'].includes(body.scope) || !hex64.test(String(body.manifest_digest)) || !hex64.test(String(body.preview_digest))) return send(res, 422, { error: 'VALIDATION_ERROR' })
    if (body.decision === 'REJECT') {
      // 거절: 목업은 계획 버전을 올려 계획 단계부터 다시 보낸다(실제 백엔드의 재계획 방식은 아직 미정).
      cancelRun(record)
      record.revision += 1
      record.approved.plan = false
      record.status = 'running'
      void run(record, 'planning')
      return send(res, 200, { decision: 'REJECT', revision: approvals[2] })
    }
    // 응답은 백엔드 ApprovalResponse 모양: 기록은 됐지만 아직 전달 전(PENDING). 전달 완료는 approval.decision 이벤트로 온다.
    if (!approve(record, 'plan')) return send(res, 409, { error: 'ALREADY_DECIDED' })
    return send(res, 201, { approval_id: APPROVAL_ID, plan_id: PLAN_ID, revision: record.revision, decision: 'APPROVE', approver_id: 'demo', scope: body.scope, delivery_status: 'PENDING', delivery_attempts: 1, execution_status: 'NOT_STARTED', workflow_state: 'WAITING_FOR_APPROVAL' })
  }

  const match = path.match(/^\/migrations\/([^/]+)(\/.*)?$/)
  const record = match ? migrations.get(match[1]) : undefined
  if (!match) return send(res, 404, { error: 'not_found' })
  if (!record) return send(res, 404, { error: 'migration_not_found' })
  const sub = match[2] || ''

  if (req.method === 'GET' && sub === '') return send(res, 200, { id: record.id, target: record.target, status: record.status, phase: record.phase, last_seq: record.seq })
  if (req.method === 'GET' && sub === '/events') return openStream(req, res, record)
  if (req.method === 'GET' && sub === '/report') return send(res, 200, { stages: REPORT_SECONDS, ai_fixes: record.aiFixes })

  if (req.method === 'POST' && sub === '/approve') {
    const gate = url.searchParams.get('gate') === 'cutover' ? 'cutover' : 'plan'
    // 승인 본문에 revision이 있으면 지금 계획 버전과 같아야 한다(계획이 수정된 뒤의 옛 승인을 막는다).
    const body = await readBody(req)
    if (gate === 'plan' && body.revision !== undefined && Number(body.revision) !== record.revision) return send(res, 409, { error: 'stale_revision', revision: record.revision })
    return approve(record, gate) ? send(res, 200, { ok: true }) : send(res, 409, { error: 'not_waiting_for_approval' })
  }
  if (req.method === 'POST' && sub === '/cancel') {
    if (record.status === 'cancelled' || record.status === 'done') return send(res, 409, { error: 'already_finished' })
    cancelRun(record)
    record.status = 'cancelled'
    emit(record, { type: 'error', phase: record.phase, status: 'failed', data: { code: 'cancelled', message: '', phase: record.phase, retryable: false } })
    return send(res, 200, { ok: true })
  }
  // 계획 수정 요청: 계획 버전을 올리고 계획 단계부터 다시 보낸다(승인은 다시 받는다).
  if (req.method === 'POST' && sub === '/plan/revise') {
    if (record.status !== 'waiting' || record.pending !== 'approval') return send(res, 409, { error: 'not_waiting_for_approval' })
    cancelRun(record)
    record.revision += 1
    record.approved.plan = false
    record.status = 'running'
    void run(record, 'planning')
    return send(res, 200, { revision: record.revision })
  }
  // 사람 검토 뒤 샌드박스 재시도
  if (req.method === 'POST' && sub === '/sandbox/retry') {
    return approve(record, 'review') ? send(res, 200, { ok: true }) : send(res, 409, { error: 'not_waiting_for_review' })
  }
  if (req.method === 'POST' && sub === '/traffic/rollback') { runtime(record.id).sim?.rollback(); return send(res, 200, { ok: true }) }
  if (req.method === 'POST' && sub === '/traffic/retry') { runtime(record.id).sim?.retry(); return send(res, 200, { ok: true }) }
  // 개발용: 지금 단계를 실패시킨다(실패 화면 시험). 예: POST /migrations/{id}/debug/fail
  if (req.method === 'POST' && sub === '/debug/fail') {
    cancelRun(record)
    fail(record, 'debug_failure', '시험용으로 일으킨 실패입니다.')
    return send(res, 200, { ok: true })
  }
  return send(res, 404, { error: 'not_found' })
})

load()
server.listen(PORT, HOST, () => {
  console.log(`목업 SSE 서버: http://${HOST}:${PORT}  (상태 파일: ${STATE_FILE})`)
  // 서버가 꺼졌던 사이 멈춘 이전은 하던 단계를 처음부터 다시 흘려 보낸다(이미 한 승인은 다시 묻지 않는다).
  for (const record of migrations.values()) {
    if (record.status === 'running' || record.status === 'waiting') { record.status = 'running'; void run(record, record.pending || 'analysis') }
  }
})

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); setImmediate(() => process.exit(0)) })
