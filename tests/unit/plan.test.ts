import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import { initialState, reducer, type MigrationState } from '../../src/lib/migration/reducer.ts'
import { normalizePlanStep, type DraftEvent, type MigrationEvent, type PlanPreviewData } from '../../src/lib/migration/events.ts'
import { normalizeEvent } from '../../src/lib/migration/sseProvider.ts'
import { DEFAULT_TRAFFIC_STEPS, approvalFacts, diagramSteps, kindOf, ledgerGroupOf, planSummary, planWarnings, reportsStorage } from '../../src/lib/migration/planModel.ts'
import { planPreviewFor, timelineFor } from '../../src/lib/migration/script.ts'
import { TrafficSim, stepIndexOf } from '../../src/lib/migration/trafficSim.ts'
import type { TrafficSnapshotData } from '../../src/lib/migration/events.ts'

let seq = 0
const ev = (draft: DraftEvent): MigrationEvent => ({ ...draft, seq: ++seq, at: '2026-01-01T00:00:00.000Z' }) as MigrationEvent
const run = (state: MigrationState, ...events: MigrationEvent[]) => events.reduce((current, event) => reducer(current, { type: 'event', event }), state)

const schema = JSON.parse(readFileSync(new URL('../../contract/events.schema.json', import.meta.url), 'utf8'))
const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true })
const validate = ajv.compile(schema)

test('예전 등급(direct/convert/none)과 빠진 처리·원본 유지·검증 상태를 채운다', () => {
  assert.equal(normalizePlanStep({ id: 'a', grade: 'direct' }).grade, 'DIRECT')
  assert.equal(normalizePlanStep({ id: 'a', grade: 'convert' }).grade, 'API_DIFF')
  const none = normalizePlanStep({ id: 'a', grade: 'none' })
  assert.deepEqual([none.grade, none.keep_source, none.action, none.verification], ['NONE', true, 'PROCEED', 'UNVERIFIED'])
  assert.equal(normalizePlanStep({ id: 'a', grade: 'NONE', keep_source: false }).action, 'BLOCK')
  assert.equal(normalizePlanStep({ id: 'a', grade: 'PARTIAL' }).action, 'APPROVAL')
  // 서버가 준 값은 그대로 둔다
  const given = normalizePlanStep({ id: 'a', group: 'code', grade: 'API_DIFF', action: 'BLOCK', keep_source: false, verification: 'SANDBOX_VERIFIED', kind: 'proxy' })
  assert.deepEqual([given.group, given.action, given.verification, given.kind], ['code', 'BLOCK', 'SANDBOX_VERIFIED', 'proxy'])
})

test('SSE 이벤트 정규화: plan.step과 snapshot 안의 이벤트, 빠진 미리보기 목록', () => {
  const legacy = { seq: 1, at: 'x', phase: 'planning', type: 'plan.step', status: 'running', data: { id: 'n', group: 'infrastructure', grade: 'convert', before: '', after: '', evidence: '', change: '' } } as unknown as MigrationEvent
  const step = normalizeEvent(legacy)
  assert.ok(step.type === 'plan.step' && step.data.grade === 'API_DIFF' && step.data.action === 'PROCEED')
  const snapshot = normalizeEvent({ seq: 2, at: 'x', phase: 'planning', type: 'snapshot', status: 'running', data: { migration_id: 'm', status: 'running', reset: true, events: [legacy] } } as MigrationEvent)
  assert.ok(snapshot.type === 'snapshot' && snapshot.data.events[0].type === 'plan.step' && snapshot.data.events[0].data.grade === 'API_DIFF')
  const preview = normalizeEvent({ seq: 3, at: 'x', phase: 'planning', type: 'plan.preview', status: 'running', data: { plan_id: 'p', revision: 1, source: { provider: 'AWS', platform: 'EKS', location: 'x' }, target: { provider: 'GCP', platform: 'GKE', location: 'y' } } } as unknown as MigrationEvent)
  assert.ok(preview.type === 'plan.preview')
  assert.deepEqual([preview.data.resources, preview.data.env_remap, preview.data.security_rules, preview.data.validation], [[], [], [], { errors: [], warnings: [] }])
})

test('plan.preview는 상태에 담기고 계획 단계 초기화로 비워진다', () => {
  const preview = planPreviewFor('gcp', 2)
  let state = run(initialState, ev({ type: 'plan.preview', phase: 'planning', status: 'running', data: preview }))
  assert.equal(state.plan.preview?.revision, 2)
  state = reducer(state, { type: 'resetPhase', phase: 'planning' })
  assert.equal(state.plan.preview, null)
})

test('목업 계획 대본: 미리보기·매핑이 스키마를 통과하고, 요약 수가 맞는다', () => {
  for (const target of ['gcp', 'onprem'] as const) {
    const items = timelineFor('planning', { target, aiFixes: 2 })
    for (const { event } of items) assert.ok(validate({ ...event, seq: ++seq, at: '2026-01-01T00:00:00.000Z' }), JSON.stringify(validate.errors))
    const steps = items.flatMap(item => item.event.type === 'plan.step' ? [item.event.data] : [])
    const summary = planSummary(steps)
    assert.equal(summary.proceed + summary.approval + summary.block + summary.keep, summary.total)
    assert.deepEqual([summary.total, summary.keep, summary.block], [6, 2, 0])
  }
})

test('경고는 검증 경고와 리소스 경고를 한 목록으로 합친다(같은 리소스는 한 번)', () => {
  const preview: PlanPreviewData = { ...planPreviewFor('gcp', 1) }
  assert.equal(planWarnings(preview).length, 1)
  preview.resources = preview.resources.map(resource => resource.id === 'db' ? { ...resource, warning: 'same' } : resource.id === 'vpc' ? { ...resource, warning: 'cidr overlap' } : resource)
  assert.deepEqual(planWarnings(preview).map(issue => issue.resource), ['db', 'vpc'])
  assert.equal(planWarnings(null).length, 0)
})

test('구성도 분류: kind가 없어도 다른 앱(Go + PgBouncer, S3 없음)의 항목을 줄 순서대로 놓는다', () => {
  const steps = [
    normalizePlanStep({ id: 'db', grade: 'DIRECT', before: 'RDS PostgreSQL' }),
    normalizePlanStep({ id: 'pgbouncer', grade: 'DIRECT', before: 'PgBouncer' }),
    normalizePlanStep({ id: 'chat-api', grade: 'DIRECT', before: 'Go chat API · Deployment' }),
    normalizePlanStep({ id: 'ingress', grade: 'API_DIFF', before: 'ALB Ingress' }),
    normalizePlanStep({ id: 'database-url', group: 'code', grade: 'PARTIAL', before: 'DATABASE_URL' }),
  ]
  assert.deepEqual(diagramSteps(steps).map(item => item.kind), ['ingress', 'compute', 'proxy', 'database'])
  assert.equal(kindOf({ id: 'uploads', before: 'S3 bucket' }), 'storage')
  // 분석·계획 어디에도 저장소가 없으면 S3 상자를 그리지 않는다
  const state = { analysis: { findings: [], done: true }, plan: { steps, ready: true, meta: null, preview: null } }
  assert.equal(reportsStorage(state), false)
  assert.equal(reportsStorage({ analysis: { findings: [], done: false }, plan: { steps: [], ready: false, meta: null, preview: null } }), true, '아무 결과도 없으면 예전처럼 보인다')
})

test('원본 유지 리소스는 원래 묶음과 관계없이 원본 유지 묶음으로 간다', () => {
  const [vpc] = planPreviewFor('gcp', 1).resources
  assert.equal(ledgerGroupOf(vpc), 'network')
  assert.equal(ledgerGroupOf({ ...vpc, change: 'KEEP_SOURCE' }), 'keep')
})

test('트래픽 단계는 서버가 준 단계를 쓰고 현재 단계를 찾는다(50:50 → 0:100)', () => {
  assert.equal(stepIndexOf([50, 100], 50), 0)
  assert.equal(stepIndexOf([50, 100], 100), 1)
  assert.equal(stepIndexOf([10, 50, 100], 75), 1, '목록에 없는 값은 넘지 않는 가장 큰 단계')
  assert.equal(stepIndexOf([10, 50, 100], undefined), 0)
  const snapshots: TrafficSnapshotData[] = []
  const sim = new TrafficSim(data => snapshots.push(data), [50, 100])
  sim.start()
  sim.stop()
  assert.deepEqual(snapshots[0].steps, [50, 100])
  assert.equal(snapshots[0].step, 50)
  assert.ok(validate({ seq: ++seq, at: '2026-01-01T00:00:00.000Z', phase: 'traffic', type: 'traffic.snapshot', status: 'running', data: snapshots[0] }), JSON.stringify(validate.errors))
})

test('전환 측정 결과: 모르는 id도 받고, 마지막 결과(done)로 이전이 끝난다', () => {
  let state = run(initialState,
    ev({ type: 'cutover.result', phase: 'verification', status: 'running', data: { id: 'duplicate', value: '0', label: 'Duplicate rows', ok: true } }),
    ev({ type: 'cutover.result', phase: 'verification', status: 'running', data: { id: 'checksum', value: 'match' } }))
  assert.equal(state.cutover.results.length, 2)
  assert.notEqual(state.status, 'done')
  state = run(state, ev({ type: 'cutover.result', phase: 'verification', status: 'done', data: { id: 'p99', value: '120ms' } }))
  assert.equal(state.status, 'done')
  assert.ok(validate({ seq: ++seq, at: '2026-01-01T00:00:00.000Z', phase: 'verification', type: 'cutover.result', status: 'running', data: { id: 'duplicate', value: '0', label: 'Duplicate rows', ok: true } }))
})

test('승인 요약은 받은 계획 데이터에서 계산하고, 없는 값은 비워 둔다', () => {
  const empty = approvalFacts(initialState)
  assert.equal(empty.hasPlan, false)
  assert.equal(empty.sandbox, null)
  assert.equal(empty.writePauseMs, null)
  assert.deepEqual(empty.traffic, { steps: DEFAULT_TRAFFIC_STEPS, method: null, defaulted: true })

  let state: MigrationState = initialState
  let n = 0
  for (const { event } of timelineFor('planning', { target: 'gcp', aiFixes: 1 })) state = reducer(state, { type: 'event', event: { ...event, seq: ++n, at: '2026-01-01T00:00:00.000Z' } as MigrationEvent })
  const facts = approvalFacts(state)
  // 목업 계획: 인프라 4(그중 storage 원본 유지) · 코드 2(그중 s3-code 원본 유지)
  assert.deepEqual(facts.changes, { infrastructure: 3, code: 1, keep: 2, approval: 0, block: 0 })
  assert.equal(facts.sandbox?.kind, 'mapping', '샌드박스 판정이 없으면 매핑 항목의 검증 상태로 센다')
  assert.equal(facts.database?.id, 'database')
  assert.deepEqual(facts.traffic.steps, [10, 50, 100])
  assert.equal(facts.traffic.method, null, '트래픽 방식은 미정이라 보내지 않는다')
  assert.equal(facts.traffic.defaulted, false)
  assert.equal(facts.writePauseMs, 1000)
  // 서버가 다른 전환 단계를 보내면 그대로 쓴다.
  const preview = { ...state.plan.preview!, rollout: { traffic_steps: [25, 100], traffic_method: 'DNS_WEIGHTED' } }
  const custom = approvalFacts({ ...state, plan: { ...state.plan, preview } })
  assert.deepEqual(custom.traffic, { steps: [25, 100], method: 'DNS_WEIGHTED', defaulted: false })
  assert.equal(custom.writePauseMs, null)
})
