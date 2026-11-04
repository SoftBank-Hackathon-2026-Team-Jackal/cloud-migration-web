import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Ajv from 'ajv/dist/2020.js'
import { DATA_VERIFY_TOTAL_MS, TRAFFIC_READY_EVENTS, dataProgressAt, dueDataVerify, reportFor, timelineFor, type ScriptedPhase } from '../../src/lib/migration/script.ts'
import { TrafficSim } from '../../src/lib/migration/trafficSim.ts'
import { startRequestFor, type Target } from '../../src/lib/migration/events.ts'

const read = (path: string) => JSON.parse(readFileSync(new URL('../../' + path, import.meta.url), 'utf8'))
const eventsSchema = read('contract/events.schema.json')
const restSchema = read('contract/rest.schema.json')

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true })
ajv.addSchema(eventsSchema)
ajv.addSchema(restSchema)
const validateEvent = ajv.getSchema('events.schema.json')!
const validateRest = (name: string) => ajv.getSchema('rest.schema.json#/$defs/' + name)!

function assertValid(validate: ReturnType<typeof ajv.compile>, value: unknown, label: string) {
  if (!validate(value)) assert.fail(label + ' 스키마 위반: ' + ajv.errorsText(validate.errors) + '\n' + JSON.stringify(value).slice(0, 300))
}

let seq = 0
const stamp = (draft: object) => ({ ...draft, seq: ++seq, at: new Date().toISOString() })

test('스키마가 events.ts의 모든 이벤트 type을 빠짐없이, 남김없이 담는다', () => {
  const source = readFileSync(new URL('../../src/lib/migration/events.ts', import.meta.url), 'utf8')
  const inTypes = new Set([...source.matchAll(/Base<'([a-z.]+)'/g)].map(match => match[1]))
  const inSchema = new Set<string>(eventsSchema.oneOf.map((entry: { $ref: string }) => entry.$ref.replace('#/$defs/event:', '')))
  assert.ok(inTypes.size >= 14, 'events.ts에서 type을 읽지 못했습니다')
  assert.deepEqual([...inTypes].filter(type => !inSchema.has(type)), [], '스키마에 없는 type')
  assert.deepEqual([...inSchema].filter(type => !inTypes.has(type)), [], 'events.ts에 없는 type')
})

test('목업 대본의 모든 이벤트가 스키마를 통과한다(target × aifix)', () => {
  const phases: ScriptedPhase[] = ['analysis', 'build', 'planning', 'provisioning', 'verification']
  let count = 0
  for (const target of ['gcp', 'onprem'] as Target[]) {
    for (let aiFixes = 1; aiFixes <= 4; aiFixes++) {
      for (const phase of phases) {
        for (const { event } of timelineFor(phase, { target, aiFixes })) {
          assertValid(validateEvent, stamp(event), `${phase}/${target}/aifix${aiFixes}`)
          count++
        }
      }
    }
  }
  assert.ok(count > 300, '검증한 이벤트 수: ' + count)
})

test('사람 검토·이미지 불일치 데모 대본도 스키마를 통과한다', () => {
  let reviews = 0
  for (const target of ['gcp', 'onprem'] as Target[]) {
    for (const event of [
      ...timelineFor('build', { target, aiFixes: 1, review: true }),
      ...timelineFor('build', { target, aiFixes: 1, retried: true }),
      ...timelineFor('planning', { target, aiFixes: 1, digestMismatch: true }),
    ]) {
      assertValid(validateEvent, stamp(event.event), 'demo/' + target + '/' + event.event.type)
      if (event.event.type === 'build.review') reviews++
    }
  }
  assert.equal(reviews, 2, 'build.review 이벤트')
})

test('정합성 확인·전환 조건 확인 이벤트가 스키마를 통과한다', () => {
  const verify = dueDataVerify(DATA_VERIFY_TOTAL_MS, 0)
  assert.equal(verify.events.length, 4, 'data.verify 이벤트 수')
  for (const event of verify.events) assertValid(validateEvent, stamp(event), 'data.verify')
  for (const item of TRAFFIC_READY_EVENTS) assertValid(validateEvent, stamp({ type: 'traffic.ready', phase: 'traffic', status: 'running', data: item.data }), 'traffic.ready')
  assert.equal(validateEvent(stamp({ type: 'data.verify', phase: 'data_copy', status: 'running', data: { name: 'unknown', state: 'done' } })), false, 'data.verify name')
  assert.equal(validateEvent(stamp({ type: 'cutover.handover', phase: 'verification', status: 'running', data: { item: 'dns', state: 'paused' } })), false, 'handover state')
})

test('데이터 복제 진행 값(0~30초)이 스키마를 통과한다', () => {
  for (let tick = 0; tick <= 120; tick++) {
    const data = dataProgressAt(tick / 4)
    assertValid(validateEvent, stamp({ type: 'data.progress', phase: 'data_copy', status: 'running', data }), 'data.progress ' + tick)
  }
})

test('트래픽 시뮬레이터의 스냅샷(적용·장애 주입·롤백·재시도)이 스키마를 통과한다', async () => {
  const sim = new TrafficSim(data => assertValid(validateEvent, stamp({ type: 'traffic.snapshot', phase: 'traffic', status: 'running', data }), 'traffic.snapshot'))
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
  try {
    sim.start()
    await sleep(1700)
    sim.inject()
    await sleep(3000) // 관찰 → 게이트 실패 → 롤백
    sim.retry()
    await sleep(1600)
    sim.rollback()
  } finally { sim.stop() }
})

test('REST 요청·응답 형식', () => {
  for (const target of ['gcp', 'onprem'] as const) assertValid(validateRest('StartRequest'), { project_id: 'demo', source_provider: 'AWS', target_provider: startRequestFor(target).target.provider, ...startRequestFor(target, { envFileRef: 'local:.env' }) }, 'StartRequest ' + target)
  assertValid(validateRest('Report'), reportFor(2), 'Report')
  assert.equal(validateRest('StartRequest')({ target: 'aws' }), false)
  assert.equal(validateRest('StartRequest')({ target: { provider: 'AWS', profile: 'aws-ec2-basic' } }), false, 'AWS는 대상이 아니다')
  assert.equal(validateRest('StartRequest')({ ...startRequestFor('gcp'), password: 'x' }), false)
  assertValid(validateRest('StartResponse'), { workflow_id: 'wf-1', run_id: 'run-1', mode: 'scaffold' }, 'StartResponse(백엔드)')
  const digest = 'a'.repeat(64)
  assertValid(validateRest('ApprovalRequest'), { decision: 'APPROVE', scope: 'FULL', manifest_digest: digest, preview_digest: digest }, 'ApprovalRequest')
  assert.equal(validateRest('ApprovalRequest')({ decision: 'APPROVE', scope: 'FULL', manifest_digest: 'x', preview_digest: digest }), false, 'digest 형식')
  assert.equal(validateRest('Report')({ stages: [{ id: 'a' }], ai_fixes: 1 }), false)
})

test('잘못된 이벤트는 실패한다', () => {
  const good = stamp({ type: 'analysis.done', phase: 'analysis', status: 'done', data: {} }) as Record<string, unknown>
  assert.equal(validateEvent(good), true)
  const { at: _at, ...noAt } = good
  assert.equal(validateEvent(noAt), false, '필수 필드(at) 누락')
  assert.equal(validateEvent({ ...good, status: 'paused' }), false, '허용되지 않는 status')
  assert.equal(validateEvent({ ...good, phase: 'deploy' }), false, '허용되지 않는 phase')
  assert.equal(validateEvent({ ...good, type: 'analysis.unknown' }), false, '모르는 type')
  assert.equal(validateEvent({ ...good, at: '어제' }), false, '시각 형식')
  const check = { ...good, type: 'build.check', phase: 'build', data: { id: 'build', state: 'running' } }
  assert.equal(validateEvent(check), true)
  assert.equal(validateEvent({ ...check, data: { id: 'build', state: 'broken' } }), false, '허용되지 않는 state')
  assert.equal(validateEvent({ ...check, data: { id: 'unknown', state: 'running' } }), false, '허용되지 않는 id')
  assert.equal(validateEvent({ ...check, data: { state: 'running' } }), false, 'data 필수 필드 누락')
  assert.equal(validateEvent({ ...check, data: { id: 'build', state: 'running', extra: 1 } }), false, '계약에 없는 필드')
  assert.equal(validateEvent({ ...good, type: 'cutover.step', phase: 'verification', data: { n: 7, state: 'done' } }), false, 'n 범위')
})

// ---- 목업 서버가 보내는 이벤트 ----

async function waitForServer(port: number) {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/migrations/none`); return } catch { await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  throw new Error('목업 서버가 뜨지 않았습니다')
}

test('목업 서버가 SSE로 보내는 이벤트(snapshot 포함)가 스키마를 통과한다', { timeout: 120000 }, async () => {
  const port = 18000 + Math.floor(Math.random() * 1000)
  const state = join(mkdtempSync(join(tmpdir(), 'contract-')), 'state.json')
  const server: ChildProcess = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/mock-sse-server.mjs'], {
    cwd: new URL('../../', import.meta.url), env: { ...process.env, PORT: String(port), MOCK_STATE_FILE: state }, stdio: 'ignore',
  })
  const base = `http://127.0.0.1:${port}`
  const controller = new AbortController()
  try {
    await waitForServer(port)
    const created = await fetch(base + '/migrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: 'demo', source_provider: 'AWS', target_provider: 'GCP', ...startRequestFor('gcp') }) })
    assert.equal(created.status, 201)
    const { id } = await created.json() as { id: string }
    assertValid(validateRest('StartResponse'), { id, status: 'running' }, 'StartResponse')

    const response = await fetch(`${base}/migrations/${id}/events`, { signal: controller.signal })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const seen: string[] = []
    let buffer = ''
    let approved = false
    let cancelled = false
    outer: for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (let split = buffer.indexOf('\n\n'); split >= 0; split = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const line = block.split('\n').find(item => item.startsWith('data: '))
        if (!line) continue
        const event = JSON.parse(line.slice(6))
        assertValid(validateEvent, event, 'SSE ' + event.type)
        seen.push(event.type)
        if (event.type === 'approval.required' && !approved) {
          approved = true
          assert.equal((await fetch(`${base}/migrations/${id}/approve`, { method: 'POST' })).status, 200)
        }
        if (approved && seen.includes('provision.check') && !cancelled) {
          cancelled = true
          await fetch(`${base}/migrations/${id}/cancel`, { method: 'POST' })
        }
        if (cancelled && event.type === 'error') break outer
      }
    }
    for (const type of ['snapshot', 'analysis.finding', 'analysis.done', 'sandbox.env', 'sandbox.step', 'sandbox.attempt', 'sandbox.done', 'build.fix', 'build.result', 'plan.step', 'plan.ready', 'approval.required', 'provision.resource', 'provision.check', 'error']) {
      assert.ok(seen.includes(type), type + ' 이벤트를 받지 못했습니다')
    }
    const report = await (await fetch(`${base}/migrations/${id}/report`)).json()
    assertValid(validateRest('Report'), report, 'Report')
    // 이어 받기: Last-Event-ID 뒤의 이벤트만 담긴 snapshot(reset=false)이 온다
    const resumed = await fetch(`${base}/migrations/${id}/events`, { headers: { 'Last-Event-ID': '5' }, signal: controller.signal })
    const first = new TextDecoder().decode((await resumed.body!.getReader().read()).value)
    const snapshotLine = first.split('\n').find(item => item.startsWith('data: '))!
    const snapshot = JSON.parse(snapshotLine.slice(6))
    assertValid(validateEvent, snapshot, 'resume snapshot')
    assert.equal(snapshot.type, 'snapshot')
    assert.equal(snapshot.data.reset, false)
    assert.ok(snapshot.data.events.every((item: { seq: number }) => item.seq > 5))
  } finally {
    controller.abort()
    server.kill('SIGTERM')
  }
})
