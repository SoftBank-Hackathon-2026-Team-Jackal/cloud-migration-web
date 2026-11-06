import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Ajv from 'ajv/dist/2020.js'
import { initialState, reducer, type MigrationState } from '../../src/lib/migration/reducer.ts'
import { isBackendPreview, normalizePlanStep, type DraftEvent, type MigrationEvent, type PlanPreviewData } from '../../src/lib/migration/events.ts'
import { normalizeEvent } from '../../src/lib/migration/sseProvider.ts'
import { DEFAULT_TRAFFIC_STEPS, approvalFacts, diagramSteps, kindOf, ledgerGroupOf, planSummary, planWarnings, reportsStorage } from '../../src/lib/migration/planModel.ts'
import { planPreviewFor, timelineFor } from '../../src/lib/migration/script.ts'
import { TrafficSim, stepIndexOf } from '../../src/lib/migration/trafficSim.ts'
import { adaptBackendPreview } from '../../src/lib/migration/previewAdapter.ts'
import { ROLLOUT_POLICY_DEFAULTS } from '../../src/lib/migration/policy.ts'

/** 목업 Preview(백엔드 모양)를 화면 모델로 옮긴 것 */
const modelPreview = (target: 'gcp' | 'onprem', revision: number) => adaptBackendPreview(planPreviewFor(target, revision), { steps: [], meta: null })
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
  assert.ok(preview.type === 'plan.preview' && !isBackendPreview(preview.data))
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
  const preview: PlanPreviewData = { ...modelPreview('gcp', 1) }
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
  const state = { analysis: { findings: [], scans: [], done: true }, plan: { steps, ready: true, meta: null, preview: null, backend: null } }
  assert.equal(reportsStorage(state), false)
  assert.equal(reportsStorage({ analysis: { findings: [], scans: [], done: false }, plan: { steps: [], ready: false, meta: null, preview: null, backend: null } }), true, '아무 결과도 없으면 예전처럼 보인다')
  // 스캔 배치가 버킷을 찾았으면 저장소가 있다
  const scanned = { ...state, analysis: { ...state.analysis, scans: [{ id: 's', activity: 'scan_aws_infra', stream: 'infrastructure' as const, completed: 1, total: 1, items: [{ key: 's3_bucket', n: 1 }], evidence: [] }] } }
  assert.equal(reportsStorage(scanned), true)
})

test('원본 유지 리소스는 원래 묶음과 관계없이 원본 유지 묶음으로 간다', () => {
  const [vpc] = modelPreview('gcp', 1).resources
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
  // 계획이 rollout을 보내지 않으면 정책 기본값(policy.ts)을 defaulted로 쓴다
  assert.deepEqual(empty.writePause, { ms: ROLLOUT_POLICY_DEFAULTS.expected_write_pause_ms, defaulted: true })
  assert.deepEqual(empty.traffic, { steps: DEFAULT_TRAFFIC_STEPS, method: null, defaulted: true })
  assert.deepEqual(empty.pending, { rollback: [], excluded: [] })

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
  assert.equal(facts.traffic.defaulted, true, '백엔드 Preview에는 rollout이 없다: 정책 기본값')
  assert.deepEqual(facts.writePause, { ms: 1000, defaulted: true })
  assert.deepEqual(facts.dataMethod, { value: 'DUMP_CDC', defaulted: true })
  assert.deepEqual(facts.pending, { rollback: ['CLEANUP_POLICY_REQUIRED'], excluded: [] }, 'Preview pending_decisions의 정리 정책은 롤백 줄로')
  // 서버가 다른 전환 단계를 보내면 그대로 쓴다.
  const preview = { ...state.plan.preview!, rollout: { traffic_steps: [25, 100], traffic_method: 'DNS_WEIGHTED', expected_write_pause_ms: 400 } }
  const custom = approvalFacts({ ...state, plan: { ...state.plan, preview } })
  assert.deepEqual(custom.traffic, { steps: [25, 100], method: 'DNS_WEIGHTED', defaulted: false })
  assert.deepEqual(custom.writePause, { ms: 400, defaulted: false })
  // 승인 요청이 보낸 code도 합친다(모르는 code는 제외 목록으로)
  const asked = approvalFacts({ ...state, approval: { pendingDecisions: ['CLEANUP_POLICY_REQUIRED', 'INSPECTION_REQUIRED', 'NEW_CODE'] } })
  assert.deepEqual(asked.pending, { rollback: ['CLEANUP_POLICY_REQUIRED'], excluded: ['INSPECTION_REQUIRED', 'NEW_CODE'] })
})

test('계획 화면: 12줄을 넘는 실제 계획도 연출이 끝나면 완료되고, 12줄 이하는 그대로다', async () => {
  const { planReveal, PLAN_MAX_REVEAL } = await import('../../src/lib/migration/planModel.ts')
  assert.equal(PLAN_MAX_REVEAL, 12)
  // 15줄(실제 데모 계획): 연출 중에는 미완료, 12번째 타이머 뒤 15줄 모두 드러나고 완료
  assert.deepEqual(planReveal(11, 15, true), { visibleCount: 11, complete: false })
  assert.deepEqual(planReveal(PLAN_MAX_REVEAL, 15, true), { visibleCount: 15, complete: true })
  // 서버가 계획 끝을 아직 안 알렸으면 미완료
  assert.equal(planReveal(PLAN_MAX_REVEAL, 15, false).complete, false)
  // 12줄 이하: 기존과 같다
  assert.deepEqual(planReveal(3, 8, true), { visibleCount: 3, complete: false })
  assert.deepEqual(planReveal(8, 8, true), { visibleCount: 8, complete: true })
  assert.deepEqual(planReveal(12, 8, true), { visibleCount: 8, complete: true })
  assert.deepEqual(planReveal(12, 12, true), { visibleCount: 12, complete: true })
  // 줄이 없으면 완료가 아니다
  assert.equal(planReveal(12, 0, true).complete, false)
})

test('계획 화면(실제 모드): 백엔드 Preview 이름을 읽을 수 있는 줄 제목으로 쓴다', async () => {
  const { backendResourceTitle } = await import('../../src/lib/migration/planModel.ts')
  assert.equal(backendResourceTitle('NetworkPolicy chat-app → chat-db'), 'NetworkPolicy · chat-app → chat-db')
  assert.equal(backendResourceTitle('Namespace chat가 없으면 플랫폼 관리 라벨로 생성'), 'Namespace · chat가 없으면 플랫폼 관리 라벨로 생성')
  assert.equal(backendResourceTitle('chat-app Service'), 'chat-app Service')
  assert.equal(backendResourceTitle('기존 K3s k3s-1 · Agent agent-7 · Namespace chat'), '기존 K3s k3s-1 · Agent agent-7 · Namespace chat')
  // 같은 종류가 여러 줄이어도(vpc-2…) 백엔드 이름이 어댑터를 지나 그대로 남는다
  const preview = adaptBackendPreview({ contract_version: '1', manifest_digest: 'sha256:' + 'a'.repeat(64), changes: [
    { resource_type: 'NETWORK', action: 'CREATE', name: 'NetworkPolicy default deny' },
    { resource_type: 'NETWORK', action: 'CREATE', name: 'NetworkPolicy chat-app → chat-db' },
  ] } as never, { steps: [], meta: null })
  assert.deepEqual(preview.resources.map(resource => [resource.id, resource.backend_name, resource.resource_type]), [['vpc', 'NetworkPolicy default deny', 'NETWORK'], ['vpc-2', 'NetworkPolicy chat-app → chat-db', 'NETWORK']])
})

test('계획 화면: MAPPING_NOT_RUN 경고의 이유를 꺼낸다', async () => {
  const { mappingNotRunReason } = await import('../../src/lib/migration/planModel.ts')
  const of = (warnings: Array<{ id: string; message: string }>) => ({ validation: { errors: [], warnings } })
  assert.equal(mappingNotRunReason(of([])), null)
  assert.equal(mappingNotRunReason(null), null)
  assert.equal(mappingNotRunReason(of([{ id: 'MAPPING_NOT_RUN', message: 'LLM이 꺼져 있음' }])), 'LLM이 꺼져 있음')
  assert.equal(mappingNotRunReason(of([{ id: 'X', message: 'MAPPING_NOT_RUN: LLM disabled' }])), 'LLM disabled')
  assert.equal(mappingNotRunReason(of([{ id: 'MAPPING_NOT_RUN', message: 'MAPPING_NOT_RUN: LLM disabled' }])), 'LLM disabled')
})

test('계획 화면: 실제 모드는 AWS 스캔이 무언가 찾아 왔을 때만 인프라 분석 완료, 목업은 그대로', async () => {
  const { infraScanState } = await import('../../src/lib/migration/planModel.ts')
  const scan = (stream: 'infrastructure' | 'code', items: number) => ({ id: stream, activity: 'a', stream, completed: 1, total: 1, items: Array.from({ length: items }, (_, i) => ({ key: 'k' + i, n: 1 })), evidence: [] })
  // 목업: 분석 없이 열면 완료, 코드만 왔으면 대기(기존 동작)
  assert.equal(infraScanState('mock', { findings: [], scans: [] }), 'done')
  assert.equal(infraScanState('mock', { findings: [], scans: [scan('code', 2)] }), 'waiting')
  assert.equal(infraScanState('mock', { findings: [], scans: [scan('infrastructure', 0)] }), 'done')
  // 실제: 안 왔거나 NOT_COLLECTED(빈 묶음)면 skipped
  assert.equal(infraScanState('sse', { findings: [], scans: [] }), 'skipped')
  assert.equal(infraScanState('sse', { findings: [], scans: [scan('code', 2), scan('infrastructure', 0)] }), 'skipped')
  assert.equal(infraScanState('sse', { findings: [], scans: [scan('infrastructure', 3)] }), 'done')
})
