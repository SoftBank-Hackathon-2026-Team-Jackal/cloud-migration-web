/**
 * 백엔드 정렬(분석 스캔 배치 · 근거 종류 · Preview 어댑터 · 요금 추정)의 단위 시험.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reducer, type MigrationState } from '../../src/lib/migration/reducer.ts'
import { normalizePlanStep, type BackendPreviewData, type DraftEvent, type MigrationEvent } from '../../src/lib/migration/events.ts'
import { normalizeEvent } from '../../src/lib/migration/sseProvider.ts'
import { adaptBackendPreview } from '../../src/lib/migration/previewAdapter.ts'
import { HOURS_PER_MONTH, PRICE_BOOK, estimateCost, sourceUsage, targetUsage } from '../../src/lib/migration/pricing.ts'
import { costViewOf } from '../../src/lib/migration/planModel.ts'
import { DEMO_DIGEST, timelineFor } from '../../src/lib/migration/script.ts'

let seq = 0
const ev = (draft: DraftEvent): MigrationEvent => ({ ...draft, seq: ++seq, at: '2026-01-01T00:00:00.000Z' }) as MigrationEvent
const play = (state: MigrationState, drafts: DraftEvent[]) => drafts.reduce((current, draft) => reducer(current, { type: 'event', event: ev(draft) }), state)
const phase = (name: 'analysis' | 'planning', target: 'gcp' | 'onprem' = 'gcp', extra = {}) => timelineFor(name, { target, aiFixes: 1, ...extra }).map(item => item.event)

test('분석 스캔 배치: 스캔마다 한 건, 진행률은 흐름별 n/m, 클라우드 조회 근거는 늘 미확인', () => {
  const state = play(initialState, phase('analysis'))
  const { scans, findings, done } = state.analysis
  assert.equal(findings.length, 0, '기본 대본은 항목마다 보내지 않는다')
  assert.equal(done, true)
  assert.deepEqual(scans.map(scan => scan.activity), ['fetch_source', 'scan_network', 'scan_manifests', 'scan_aws_infra', 'scan_code'])
  const last = (stream: string) => scans.filter(scan => scan.stream === stream).at(-1)!
  assert.deepEqual([last('infrastructure').completed, last('infrastructure').total], [2, 2])
  assert.deepEqual([last('code').completed, last('code').total], [3, 3])
  for (const evidence of scans.flatMap(scan => scan.evidence)) {
    if (['CLOUD_RESOURCE', 'IAM_POLICY', 'CLOUDTRAIL'].includes(evidence.kind)) assert.equal(evidence.verified, false, evidence.kind)
  }
  assert.ok(scans.some(scan => scan.evidence.some(evidence => evidence.kind === 'MANIFEST')))
})

test('서버가 클라우드 조회 근거를 verified=true로 보내도 미확인으로 맞춘다(같은 id는 덮어쓴다)', () => {
  const scan = { id: 'x', activity: 'scan_aws_infra', stream: 'infrastructure' as const, completed: 1, total: 2, items: [{ key: 'alb', n: 1 }], evidence: [{ kind: 'IAM_POLICY' as const, locator: 'arn', verified: true }, { kind: 'CODE' as const, locator: 'a.py:1', verified: true }] }
  let state = play(initialState, [{ type: 'analysis.scan', phase: 'analysis', status: 'running', data: scan }])
  assert.deepEqual(state.analysis.scans[0].evidence.map(item => item.verified), [false, true])
  state = play(state, [{ type: 'analysis.scan', phase: 'analysis', status: 'running', data: { ...scan, completed: 2 } }])
  assert.equal(state.analysis.scans.length, 1)
  assert.equal(state.analysis.scans[0].completed, 2)
})

test('예전 항목 방식(?analysis=items)도 그대로 받는다', () => {
  const state = play(initialState, phase('analysis', 'gcp', { analysisItems: true }))
  assert.ok(state.analysis.findings.length > 10)
  assert.equal(state.analysis.scans.length, 0)
})

const steps = [
  normalizePlanStep({ id: 'compute', grade: 'DIRECT', kind: 'compute' }),
  normalizePlanStep({ id: 'storage', grade: 'API_DIFF', kind: 'storage', keep_source: true }),
]
const raw: BackendPreviewData = {
  manifest_digest: 'a'.repeat(64),
  changes: [
    { resource_type: 'NETWORK', action: 'CREATE', name: 'demo-vpc', size: '10.0.0.0/20' },
    { resource_type: 'NODE', action: 'CREATE', name: 'pool', quantity: 2, size: 'e2-standard-2' },
    { resource_type: 'APP', action: 'CREATE', name: 'app', quantity: 2, size: 'replicas' },
    { resource_type: 'DATABASE', action: 'UPDATE', name: 'pg', size: null },
    { resource_type: 'CLUSTER', action: 'READ', name: 'k3s' },
  ],
  applied_defaults: [{ resource_type: 'NODE', action: 'CREATE', name: 'pool', quantity: 2, size: 'e2-standard-2' }, { resource_type: 'INGRESS', action: 'CREATE', name: 'lb', size: 'HTTPS 443' }],
  warnings: [{ code: 'DB_BACKUP_RETENTION_SHORT', path: 'resources.db.backup', message: '' }],
  errors: [],
  pending_decisions: [{ code: 'CLEANUP_POLICY_REQUIRED', path: 'spec.cleanup_policy', message: 'choose' }],
}

test('Preview 어댑터: changes·applied_defaults·ValidationIssue를 화면 모델로 옮긴다', () => {
  const preview = adaptBackendPreview(raw, { steps, meta: null })
  const by = (id: string) => preview.resources.find(resource => resource.id === id)!
  assert.deepEqual(preview.resources.map(resource => resource.id), ['vpc', 'nodes', 'app', 'db', 'cluster', 'lb', 'storage'])
  assert.deepEqual([by('nodes').size, by('nodes').quantity, by('nodes').group, by('nodes').defaulted], ['e2-standard-2 × 2', 2, 'compute', true], 'applied_defaults가 같은 줄이면 기본값 표시')
  assert.equal(by('lb').defaulted, true, 'changes에 없는 기본값은 줄로 붙는다')
  assert.deepEqual([by('db').change, by('db').size, by('cluster').change], ['UPDATE', '', 'EXISTING'])
  assert.equal(by('vpc').backend_name, 'demo-vpc')
  assert.equal(by('vpc').name, '', '이름은 화면 사전이 고른다')
  assert.equal(by('app').change, 'CREATE', '검증한 Digest가 없으면 Digest 고정이 아니다')
  assert.deepEqual([by('storage').change, by('storage').kind], ['KEEP_SOURCE', 'storage'], '원본 유지 매핑에서 만든 줄')
  assert.deepEqual(preview.validation.warnings, [{ id: 'DB_BACKUP_RETENTION_SHORT', message: '', resource: 'db' }], 'path에서 리소스를 찾는다')
  assert.deepEqual(preview.pending_decisions, [{ id: 'CLEANUP_POLICY_REQUIRED', message: 'choose' }])
  assert.deepEqual([preview.env_remap, preview.security_rules, preview.source, preview.target], [[], [], undefined, undefined], 'Preview에 없는 값은 비운다')
  assert.equal(preview.plan_id, '')
  // 검증한 Digest가 있으면 APP은 Digest 고정
  const pinned = adaptBackendPreview(raw, { steps, meta: { plan_id: 'p', revision: 3, verified_digest: DEMO_DIGEST } })
  assert.equal(pinned.resources.find(resource => resource.id === 'app')!.change, 'PINNED')
  assert.deepEqual([pinned.plan_id, pinned.revision], ['p', 3])
})

test('reducer: 백엔드 Preview는 매핑·계획 완료가 바뀌면 다시 옮긴다(순서가 뒤바뀌어도 원본 유지·Digest 고정이 맞다)', () => {
  // Preview가 매핑보다 먼저 와도
  let state = play(initialState, [{ type: 'plan.preview', phase: 'planning', status: 'running', data: raw }])
  assert.equal(state.plan.preview?.resources.some(resource => resource.change === 'KEEP_SOURCE'), false)
  state = play(state, steps.map(data => ({ type: 'plan.step' as const, phase: 'planning' as const, status: 'running' as const, data })))
  assert.equal(state.plan.preview?.resources.find(resource => resource.id === 'storage')?.change, 'KEEP_SOURCE')
  state = play(state, [{ type: 'plan.ready', phase: 'planning', status: 'done', data: { plan_id: 'p', revision: 1, verified_digest: DEMO_DIGEST } }])
  assert.equal(state.plan.preview?.resources.find(resource => resource.id === 'app')?.change, 'PINNED')
  assert.ok(state.plan.backend)
  // SSE 정규화는 백엔드 모양을 그대로 두고 빠진 목록만 채운다
  const normalized = normalizeEvent({ seq: 1, at: 'x', phase: 'planning', type: 'plan.preview', status: 'running', data: { manifest_digest: 'd', changes: [] } } as unknown as MigrationEvent)
  assert.ok(normalized.type === 'plan.preview' && 'changes' in normalized.data)
  assert.deepEqual(normalized.data, { manifest_digest: 'd', changes: [], applied_defaults: [], warnings: [], errors: [], pending_decisions: [] })
})

test('목업 계획 대본(백엔드 모양)이 화면 모델로 옮겨진다: 원본 유지·Digest 고정은 매핑에서', () => {
  for (const target of ['gcp', 'onprem'] as const) {
    const state = play(initialState, phase('planning', target))
    const preview = state.plan.preview!
    const change = (id: string) => preview.resources.find(resource => resource.id === id)?.change
    assert.equal(change('storage'), 'KEEP_SOURCE', target)
    assert.equal(change('app'), 'PINNED', target)
    assert.ok(preview.security_rules.length > 0 && preview.env_remap.length > 0, '계획 입력에서 온 재매핑·보안 규칙')
    assert.equal(preview.target?.provider, target === 'gcp' ? 'GCP' : 'ON_PREM')
  }
})

test('요금 추정: 가격표 단가 × 수량으로 계산하고 기준일을 남긴다', () => {
  const aws = PRICE_BOOK['AWS:ap-northeast-2']
  const gcp = PRICE_BOOK['GCP:asia-northeast3']
  const scans = play(initialState, phase('analysis')).analysis.scans
  assert.deepEqual(sourceUsage(scans, aws), [
    { price: 'eks.cluster', qty: 1 }, { price: 't3.large', qty: 2 }, { price: 'elb.alb', qty: 1 }, { price: 'vpc.nat_gateway', qty: 1 }, { price: 'ebs.gp3', qty: 20 },
  ])
  const planned = play(initialState, phase('planning')).plan.preview!
  const usage = targetUsage(planned.resources, gcp)
  assert.ok(usage.some(item => item.price === 'e2-standard-2' && item.qty === 2), JSON.stringify(usage))
  assert.ok(usage.some(item => item.price === 'db-custom-2-7680'))
  assert.ok(usage.some(item => item.price === 'sql.ssd' && item.qty === 20))
  assert.ok(usage.some(item => item.price === 'nat.vm' && item.qty === 2), 'Cloud NAT은 노드 수만큼')

  const view = estimateCost({ source: { provider: 'AWS', location: 'ap-northeast-2' }, target: { provider: 'GCP', location: 'asia-northeast3' }, scans, resources: planned.resources })!
  const line = (id: string) => view.lines.find(item => item.id === id)!
  assert.equal(line('control').source_usd, Math.round(0.10 * HOURS_PER_MONTH * 10) / 10)
  assert.equal(line('nodes').source_usd, Math.round(0.104 * HOURS_PER_MONTH * 2 * 10) / 10)
  assert.equal(line('nodes').target_usd, Math.round(0.086 * HOURS_PER_MONTH * 2 * 10) / 10)
  assert.equal(line('db').source_usd, 0, '원본 DB는 클러스터 안 컨테이너라 관리형 DB 요금이 없다')
  assert.ok(view.lines.every(item => item.excluded || (item.source_usd !== null && item.target_usd !== null)), '알려진 줄에는 추정 대기가 없다')
  assert.equal(view.lines.at(-1)?.id, 'transfer')
  assert.equal(view.credits_usd, 74.4)
  assert.equal(view.noCloudTarget, false)
  assert.deepEqual(view.bases.map(basis => [basis.provider, basis.date]), [['AWS', '2026-11-03'], ['GCP', '2026-11-03']])
})

test('요금 추정: 온프레미스는 추가 클라우드 비용 없음(대상 값 null), 가격표가 없으면 추정 없음', () => {
  let state = play(initialState, phase('analysis', 'onprem'))
  state = play(state, phase('planning', 'onprem'))
  const view = costViewOf(state, 'onprem')!
  assert.equal(view.noCloudTarget, true)
  assert.ok(view.lines.filter(line => !line.excluded).every(line => line.target_usd === null && (line.source_usd ?? 0) >= 0))
  assert.equal(view.bases.length, 1, '원본(AWS) 가격표만')
  assert.equal(estimateCost({ source: { provider: 'AZURE', location: 'x' }, target: { provider: 'ON_PREM', location: '' }, scans: [], resources: [] }), null)
  const gcp = costViewOf(play(play(initialState, phase('analysis')), phase('planning')), 'gcp')!
  assert.equal(gcp.noCloudTarget, false)
  assert.ok((gcp.lines.find(line => line.id === 'nodes')?.target_usd ?? 0) > 0)
})

test('승인 요청의 pending_decisions code를 상태에 담는다', () => {
  const state = play(initialState, [{ type: 'approval.required', phase: 'awaiting_approval', status: 'waiting', data: { excluded: [], rollback_policy: '', pending_decisions: [{ code: 'CLEANUP_POLICY_REQUIRED', path: 'spec', message: '' }] } }])
  assert.deepEqual(state.approval.pendingDecisions, ['CLEANUP_POLICY_REQUIRED'])
  assert.equal(play(initialState, [{ type: 'approval.required', phase: 'awaiting_approval', status: 'waiting', data: { excluded: [], rollback_policy: '' } }]).approval.pendingDecisions.length, 0)
})

test('요금 추정: 인프라 스캔을 받기 전에는 원본 값을 모른다(0이 아니라 null)', () => {
  const planned = play(initialState, phase('planning')).plan.preview!
  const view = estimateCost({ source: { provider: 'AWS', location: 'ap-northeast-2' }, target: { provider: 'GCP', location: 'asia-northeast3' }, scans: [], resources: planned.resources })!
  assert.ok(view.lines.filter(line => !line.excluded).every(line => line.source_usd === null && line.target_usd !== null))
  assert.deepEqual(view.bases.map(basis => basis.provider), ['GCP'])
})

test('Fixer가 새로 읽게 된 환경 변수: build.fix의 new_env_keys에서 센다(없으면 0)', async () => {
  const { fixerEnvKeys } = await import('../../src/lib/migration/planModel.ts')
  const fixes = (scenario: 'spec' | 'pass') => timelineFor('build', { target: 'gcp', aiFixes: 2, sandbox: scenario }).flatMap(item => item.event.type === 'build.fix' ? [item.event.data] : [])
  assert.deepEqual(fixerEnvKeys(fixes('spec')), ['DB_SSLMODE'])
  assert.deepEqual(fixerEnvKeys(fixes('pass')), [], '수정이 없으면 안내도 없다')
  assert.deepEqual(fixerEnvKeys([{ id: 'a', check: 'x', lines: [], why: '', evidence: '', new_env_keys: ['A', 'B'] }, { id: 'b', check: 'x', lines: [], why: '', evidence: '', new_env_keys: ['B'] }]), ['A', 'B'])
})
