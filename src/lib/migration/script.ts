/**
 * 데모 대본: 지금까지 화면마다 들어 있던 타이머 대본을 이벤트로 옮겨 한 곳에 둔다.
 * 브라우저의 MockProvider와 목업 SSE 서버(scripts/mock-sse-server.mjs)가 이 모듈을 함께 쓴다.
 * 대본의 시각(after)은 "그 단계 화면이 준비된 순간"부터 센 ms이다.
 * Node가 그대로 읽으므로 런타임 import가 없고, 타입 문법만 쓴다(enum·네임스페이스 금지).
 */
import type { AnalysisFindingData, ApprovalDecisionData, CostEstimate, PlanRollout, BuildErrorCode, BuildFixData, DataProgressData, DataVerifyData, DraftEvent, TrafficReadyData, EnvRemap, FixLine, FlowPath, Grade, PlanEnvironment, PlanPreviewData, PlanResource, PlanStepData, SecurityRule, ReportData, SandboxChecks, SandboxDoneData, SandboxEnvData, SandboxFailureClass, SandboxStep, SandboxTestsData, Target } from './events'
import type { SandboxScenario } from '../demoConfig'

/** events.ts의 pathOf와 같다(이 모듈은 런타임 import가 없어야 Node가 그대로 읽는다). */
const pathOf = (target: Target): FlowPath => (target === 'onprem' ? 'onprem' : 'gcp')

export type TimedDraft = { after: number; event: DraftEvent }
export type ScriptContext = {
  target: Target
  aiFixes: number
  /** 계획 버전(처음 1, 계획 수정 요청마다 +1) */
  revision?: number
  /** 데모(?review=1): 샌드박스 루프가 3회 실패해 사람 검토를 기다린다. */
  review?: boolean
  /** 사람 검토 뒤 재시도한 빌드(이전 빌드를 재사용한다) */
  retried?: boolean
  /** 데모(?digest=mismatch): 검증한 이미지 Digest가 빌드한 것과 다르다. */
  digestMismatch?: boolean
  /** 데모(?sandbox=…): 샌드박스 루프 결과 */
  sandbox?: SandboxScenario
}

// ---- 이미지 Digest(데모 값) ----
export const DEMO_DIGEST = 'sha256:9f2c4a7e1b3d58a06c7f94e2d1a8b35c0e6f7a91b2c3d4e5f60718293a4b5c6d'
const OTHER_DIGEST = 'sha256:41d0b7c9e8a2f6531a0c9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f'
export const DEMO_IMAGE_URI = 'registry.example.com/demo/app@' + DEMO_DIGEST
export const TEMPLATE_VERSION = 'k8s-basic-1.4.0'
export const DEMO_MANIFEST_DIGEST = '3b1f0c9d7a5e4286b0d1c3f5a79e2468b1d3f5a79c0e2468ace13579bdf02468'
export const DEMO_PREVIEW_DIGEST = '7e5c3a19b7d5f3e1c9a7b5d3f1e9c7a5b3d1f9e7c5a3b1d9f7e5c3a1b9d7f5e3'

// ---- 분석 ----

type Finding = Omit<AnalysisFindingData, 'message' | 'detail'> & { after: number }
const FINDINGS: Finding[] = [
  { after: 3200, id: 'infra-vpc', stream: 'infrastructure', progress: 14, key: 'vpc', via: ['config'] },
  { after: 3700, id: 'code-compose', stream: 'code', progress: 15, key: 'compose', via: ['code'] },
  { after: 4300, id: 'infra-alb', stream: 'infrastructure', progress: 28, key: 'alb', via: ['config'] },
  { after: 5000, id: 'code-app', stream: 'code', progress: 31, key: 'app', via: ['code'] },
  { after: 5800, id: 'infra-ec2', stream: 'infrastructure', progress: 43, key: 'ec2', via: ['config'] },
  { after: 6400, id: 'code-db', stream: 'code', progress: 47, key: 'database', via: ['code'] },
  { after: 7200, id: 'infra-postgres', stream: 'infrastructure', progress: 61, key: 'postgres', via: ['config'] },
  { after: 7900, id: 'code-s3', stream: 'code', progress: 63, key: 'sdk', via: ['code', 'trail'] },
  { after: 8600, id: 'infra-s3', stream: 'infrastructure', progress: 74, key: 's3', via: ['config', 'trail'] },
  { after: 9400, id: 'code-env', stream: 'code', progress: 78, key: 'env', via: ['code'] },
  { after: 10200, id: 'infra-network', stream: 'infrastructure', progress: 88, key: 'network', via: ['config'] },
  { after: 10900, id: 'code-auth', stream: 'code', progress: 92, key: 'auth', via: ['iam', 'code'] },
  { after: 11700, id: 'infra-iam', stream: 'infrastructure', progress: 100, key: 'iam', via: ['iam', 'config'] },
  { after: 12400, id: 'code-done', stream: 'code', progress: 100, key: 'code-done', via: ['code'] },
]

function analysisTimeline(): TimedDraft[] {
  const items: TimedDraft[] = FINDINGS.map(({ after, ...finding }) => ({
    after,
    // message·detail이 비어 있으면 화면이 key로 자기 문구(현재 언어)를 쓴다.
    event: { type: 'analysis.finding', phase: 'analysis', status: 'running', progress: finding.progress, data: { ...finding, message: '', detail: '' } },
  }))
  const end = FINDINGS[FINDINGS.length - 1].after
  items.push({ after: end, event: { type: 'analysis.done', phase: 'analysis', status: 'done', progress: 100, data: {} } })
  return items
}

// ---- 샌드박스 검증(build) ----

type FixId = 'db' | 'host' | 'port' | 'probe'
// AI가 고치는 항목. 수정은 검증 항목 하나에 여러 개 붙을 수 있다(예: 상태 확인에서 서너 건).
const FIX_POOL: Array<{ id: FixId; check: string; file: string; lines: FixLine[] }> = [
  { id: 'db', check: 'db', file: '.env', lines: [{ kind: 'del', text: '- DB_HOST=postgres' }, { kind: 'add', text: '+ DB_HOST=postgresql.demo.svc.cluster.local' }] },
  { id: 'host', check: 'health', file: '.env', lines: [{ kind: 'del', text: '- HOST=127.0.0.1' }, { kind: 'add', text: '+ HOST=0.0.0.0' }] },
  { id: 'port', check: 'health', file: 'k8s/deployment.yaml', lines: [{ kind: 'add', text: '+ containerPort: 8080' }] },
  { id: 'probe', check: 'health', file: 'k8s/deployment.yaml', lines: [{ kind: 'add', text: '+ readinessProbe: { httpGet: { path: /health, port: 8080 } }' }] },
]

const FIX_GAP_MS = 1400 // 수정 하나를 고치는 데 걸리는 시간

const MAX_ATTEMPTS = 3

// 샌드박스 루프(AV-011~016): 빌드는 샌드박스 밖에서 먼저 → 임시 Namespace → 시도마다 렌더 → 적용 → 준비 검사 → 테스트 → 판정.
// 실패하면 원인을 나눈다: SPEC(매핑) 재렌더 · CODE/BUILD 수정·재빌드 · INFRA 같은 입력으로 재시도(횟수 제외) · RENDER 중단·보고.
// 통과하면 그 Digest가 고정되고, 성공·실패와 관계없이 정리(Namespace 삭제)한다.
const SANDBOX_STEPS: SandboxStep[] = ['render', 'apply', 'ready', 'test', 'judge']
const STEP_MS = 620
const SANDBOX_TESTS: SandboxTestsData = { total: 24, catalog: 12, original: 8, generated: 4, read_only: 17 }
const PASS_CHECKS: SandboxChecks = { required_passed: 24, required_total: 24, unsupported_calls: 0, calls_in_mapping: 9, calls_total: 9, blocked_egress: 0 }
const SANDBOX_ENV: SandboxEnvData = { namespace: 'sbx-run-7f2c', expires_minutes: 120, egress_allowed: 3 }
// 코드 수정 시나리오에서 첫 빌드(수정 전) 이미지
const FIRST_DIGEST = 'sha256:4b1e07c9a2d3f5e6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4'

type RunPlan = { attempt: number; fail?: { cls: SandboxFailureClass; at: SandboxStep; checks: SandboxChecks; reasons: string[] } }

function sandboxPlans(scenario: SandboxScenario): RunPlan[] {
  const failTests = (cls: SandboxFailureClass, reasons: string[]): RunPlan['fail'] => ({ cls, at: 'judge', reasons, checks: { ...PASS_CHECKS, required_passed: 21, calls_in_mapping: 8 } })
  switch (scenario) {
    case 'pass': return [{ attempt: 1 }]
    case 'spec': return [{ attempt: 1, fail: failTests('SPEC', ['required test failed: db.read_write', 'call outside mapping: postgres:5432']) }, { attempt: 2 }]
    case 'code': return [{ attempt: 1, fail: failTests('CODE', ['required test failed: files.upload']) }, { attempt: 2 }]
    case 'infra': return [{ attempt: 1, fail: { cls: 'INFRA', at: 'apply', reasons: ['registry pull timeout'], checks: { ...PASS_CHECKS, required_passed: 0 } } }, { attempt: 1 }]
    case 'render': return [{ attempt: 1, fail: { cls: 'RENDER', at: 'render', reasons: ['render output does not match requirements: service.ports'], checks: { ...PASS_CHECKS, required_passed: 0 } } }]
  }
}

function buildTimeline(aiFixes: number, retried = false, scenario: SandboxScenario = 'spec'): TimedDraft[] {
  const plans = sandboxPlans(scenario)
  const fixing = plans.some(plan => plan.fail && (plan.fail.cls === 'SPEC' || plan.fail.cls === 'CODE'))
  const fixes: BuildFixData[] = fixing ? FIX_POOL.slice(0, aiFixes).map(fix => ({ id: fix.id, check: fix.check, file: fix.file, lines: fix.lines, why: '', evidence: '' })) : []
  const items: TimedDraft[] = fixes.map(data => ({ after: 0, event: { type: 'build.fix', phase: 'build', status: 'running', data } }))
  const build = (after: number, attempt: number, digest: string, reused: boolean) => items.push({ after, event: { type: 'build.result', phase: 'build', status: 'running', data: { attempt, max_attempts: MAX_ATTEMPTS, status: 'SUCCEEDED', digest, image_uri: 'registry.example.com/demo/app@' + digest, reused, error_code: null } } })
  // 이미지 빌드(샌드박스 밖) → 임시 Namespace 준비 → 테스트 묶음 고정(Tester)
  build(0, 1, scenario === 'code' ? FIRST_DIGEST : DEMO_DIGEST, retried)
  items.push({ after: 200, event: { type: 'sandbox.env', phase: 'build', status: 'running', data: SANDBOX_ENV } })
  items.push({ after: 450, event: { type: 'sandbox.tests', phase: 'build', status: 'running', data: SANDBOX_TESTS } })
  let at = 800
  let finalStatus: SandboxDoneData['status'] = 'PASSED'
  plans.forEach((plan, index) => {
    const run = index + 1
    for (const step of SANDBOX_STEPS) {
      items.push({ after: at, event: { type: 'sandbox.step', phase: 'build', status: 'running', data: { run, attempt: plan.attempt, step, state: 'running' } } })
      at += STEP_MS
      // 테스트 실패는 Activity 실패가 아니라 판정 결과다: 테스트 단계는 끝나고 판정에서 실패한다.
      const failed = plan.fail?.at === step
      items.push({ after: at, event: { type: 'sandbox.step', phase: 'build', status: 'running', data: { run, attempt: plan.attempt, step, state: failed ? 'failed' : 'done' } } })
      if (failed) break
    }
    const fixIds = plan.fail && (plan.fail.cls === 'SPEC' || plan.fail.cls === 'CODE') ? fixes.map(fix => fix.id) : []
    items.push({ after: at + 150, event: { type: 'sandbox.attempt', phase: 'build', status: 'running', data: {
      run, attempt: plan.attempt, max_attempts: MAX_ATTEMPTS,
      verdict: { passed: !plan.fail, reasons: plan.fail?.reasons ?? [] },
      failure_class: plan.fail?.cls ?? null, checks: plan.fail?.checks ?? PASS_CHECKS, fix_ids: fixIds,
    } } })
    at += 500
    if (!plan.fail) return
    if (plan.fail.cls === 'RENDER') { finalStatus = 'STOPPED_RENDER'; return }
    // Fixer가 하나씩 고친다(SPEC은 재렌더, CODE는 수정 뒤 재빌드). INFRA는 고치지 않고 같은 입력으로 다시 돈다.
    at += fixIds.length * FIX_GAP_MS
    if (plan.fail.cls === 'CODE') { build(at, 2, DEMO_DIGEST, false); at += 700 }
    if (plan.fail.cls === 'INFRA') at += 600
  })
  // 정리는 검증 결과와 따로 보고한다: 먼저 정리 중(PENDING), 곧 정리 완료(CLEANED).
  const digest = finalStatus === 'PASSED' ? DEMO_DIGEST : null
  items.push({ after: at, event: { type: 'sandbox.done', phase: 'build', status: 'running', data: { status: finalStatus, cleanup_status: 'PENDING', digest } } })
  items.push({ after: at + 900, event: { type: 'sandbox.done', phase: 'build', status: finalStatus === 'PASSED' ? 'done' : 'failed', data: { status: finalStatus, cleanup_status: 'CLEANED', digest } } })
  return items
}

/** ?review=1 데모: 이미지 빌드가 3번 실패(BUILD)하고 사람 검토를 기다린다. 샌드박스에는 들어가지 못한다. */
function reviewTimeline(): TimedDraft[] {
  const errors: BuildErrorCode[] = ['DOCKERFILE_MISSING', 'BUILD_FAILED', 'BUILD_FAILED']
  const items: TimedDraft[] = []
  const none: SandboxChecks = { ...PASS_CHECKS, required_passed: 0, calls_in_mapping: 0 }
  errors.forEach((error, index) => {
    const attempt = index + 1
    const at = 600 + index * 2200
    items.push({ after: at, event: { type: 'build.result', phase: 'build', status: 'running', data: { attempt, max_attempts: MAX_ATTEMPTS, status: 'FAILED', digest: null, image_uri: null, reused: false, error_code: error } } })
    items.push({ after: at + 400, event: { type: 'sandbox.attempt', phase: 'build', status: 'running', data: { run: attempt, attempt, max_attempts: MAX_ATTEMPTS, verdict: { passed: false, reasons: ['image build failed: ' + error] }, failure_class: 'BUILD', checks: none, fix_ids: [] } } })
  })
  items.push({ after: 600 + errors.length * 2200, event: { type: 'build.review', phase: 'build', status: 'waiting', data: { reason: 'max_attempts', attempts: MAX_ATTEMPTS } } })
  return items
}

// ---- 계획 ----

type PlanStepSeed = Pick<PlanStepData, 'id' | 'group' | 'kind' | 'verification'>
const PLAN_STEPS: PlanStepSeed[] = [
  { id: 'network', group: 'infrastructure', kind: 'ingress', verification: 'EVIDENCE_CHECKED' },
  { id: 'compute', group: 'infrastructure', kind: 'compute', verification: 'SANDBOX_VERIFIED' },
  { id: 'database', group: 'infrastructure', kind: 'database', verification: 'SANDBOX_VERIFIED' },
  { id: 'storage', group: 'infrastructure', kind: 'storage', verification: 'UNVERIFIED' },
  { id: 'db-code', group: 'code', kind: 'config', verification: 'SANDBOX_VERIFIED' },
  { id: 's3-code', group: 'code', kind: 'config', verification: 'UNVERIFIED' },
]
/** 이번 범위에서 옮기지 않고 원본을 그대로 쓰는 항목(AV-022) */
const KEEP_SOURCE = new Set(['storage', 's3-code'])

/** 매핑 등급(AV-008): 그대로 대응 · API 차이 · 일부 대응 · 대응 없음. 원본 유지 항목은 등급과 관계없이 원본 유지로 보인다. */
export function gradeOf(id: string, target: Target): Grade {
  switch (id) {
    case 'network': return 'API_DIFF'
    case 'db-code': return 'PARTIAL'
    case 'storage': case 's3-code': return pathOf(target) === 'gcp' ? 'API_DIFF' : 'NONE'
    default: return 'DIRECT'
  }
}

// ---- 계획 미리보기(PROV-014) ----
// 이름·설명은 비워 두고 화면이 id로 자기 문구를 쓴다. 크기·주소·키처럼 언어와 무관한 값만 담는다.
type ResourceSeed = Omit<PlanResource, 'name' | 'detail'>
const PREVIEW_RESOURCES: Record<FlowPath, ResourceSeed[]> = {
  gcp: [
    { id: 'vpc', group: 'network', kind: 'network', size: '10.20.0.0/20', size_detail: '1 subnet', change: 'CREATE' },
    { id: 'lb', group: 'network', kind: 'ingress', size: 'HTTPS 443', size_detail: 'managed cert', change: 'CREATE' },
    { id: 'cluster', group: 'compute', kind: 'compute', size: 'e2-standard-2 × 2', size_detail: '2 vCPU · 8 GiB', change: 'CREATE' },
    { id: 'app', group: 'compute', kind: 'compute', size: 'replicas 2', size_detail: '0.5 vCPU · 512 MiB', change: 'PINNED' },
    { id: 'db', group: 'data', kind: 'database', size: 'db-custom-2-7680', size_detail: '20 GiB SSD', change: 'CREATE' },
    { id: 'secret', group: 'data', kind: 'config', size: '2 keys', change: 'CREATE' },
    { id: 'storage', group: 'other', kind: 'storage', size: '—', change: 'KEEP_SOURCE' },
  ],
  onprem: [
    { id: 'vpc', group: 'network', kind: 'network', size: '10.42.0.0/16', size_detail: 'pod CIDR', change: 'CREATE' },
    { id: 'lb', group: 'network', kind: 'ingress', size: 'HTTPS 443', size_detail: 'relay tunnel', change: 'CREATE' },
    { id: 'cluster', group: 'compute', kind: 'compute', size: '3 nodes', size_detail: '4 vCPU · 16 GiB', change: 'CREATE' },
    { id: 'app', group: 'compute', kind: 'compute', size: 'replicas 2', size_detail: '0.5 vCPU · 512 MiB', change: 'PINNED' },
    { id: 'db', group: 'data', kind: 'database', size: 'StatefulSet 1', size_detail: 'PV 20 GiB', change: 'CREATE' },
    { id: 'secret', group: 'data', kind: 'config', size: '2 keys', change: 'CREATE' },
    { id: 'storage', group: 'other', kind: 'storage', size: '—', change: 'KEEP_SOURCE' },
  ],
}
const PREVIEW_ENV: Record<FlowPath, EnvRemap[]> = {
  gcp: [
    { key: 'DB_HOST', from: 'postgres', to: '10.20.0.5', secret: false },
    { key: 'DB_PASSWORD', from: 'secret', to: 'sm://db-password', secret: true },
    { key: 'S3_BUCKET', from: 'uploads-demo', to: 'uploads-demo', secret: false, keep: true },
  ],
  onprem: [
    { key: 'DB_HOST', from: 'postgres', to: 'postgresql.app.svc', secret: false },
    { key: 'DB_PASSWORD', from: 'secret', to: 'k8s://app/db-password', secret: true },
    { key: 'S3_BUCKET', from: 'uploads-demo', to: 'uploads-demo', secret: false, keep: true },
  ],
}
const PREVIEW_RULES: SecurityRule[] = [
  { from: 'internet', to: 'lb', port: 443, protocol: 'TCP', action: 'ALLOW' },
  { from: 'lb', to: 'app', port: 8080, protocol: 'TCP', action: 'ALLOW' },
  { from: 'app', to: 'db', port: 5432, protocol: 'TCP', action: 'ALLOW' },
  { from: '*', to: '*', port: null, protocol: 'ANY', action: 'DENY' },
]
const PREVIEW_TARGET: Record<FlowPath, PlanEnvironment> = {
  gcp: { provider: 'GCP', platform: 'GKE', location: 'asia-northeast3' },
  onprem: { provider: 'ON_PREM', platform: 'K3s', location: 'dc-1' },
}
export const PLAN_ID = 'pln-7f2c9a'

/** 전환 방법(데모 값). 트래픽 방식(Route 53 가중치·중계 프록시)은 아직 정해지지 않아 보내지 않는다. 단계는 trafficSim의 TRAFFIC_STEPS와 같다. */
const PREVIEW_ROLLOUT: PlanRollout = { traffic_steps: [10, 50, 100], expected_write_pause_ms: 1000, data_method: 'DUMP_CDC' }

/**
 * 고정 요금 추정(데모 값, USD/월 = 시간당 요금 × 730). 공개 요금표 기준(2026-11-03 조회):
 * EKS·GKE 클러스터 관리 $0.10/시간(GKE는 청구 계정당 클러스터 하나에 월 $74.40 크레딧), ALB 고정 $0.0225/시간(서울),
 * NAT 게이트웨이 고정 $0.059/시간(서울), GCP 전달 규칙 $0.025/시간(처음 5개), Cloud NAT VM당 $0.0014/시간(노드 2대).
 * 노드·스토리지·전송은 사양·사용량에 따라 달라 넣지 않는다.
 */
const PREVIEW_COST: Record<FlowPath, CostEstimate> = {
  gcp: {
    currency: 'USD', credits_usd: 74.4, basis: '2026-11-03',
    lines: [
      { id: 'control', source_usd: 73.0, target_usd: 73.0 },
      { id: 'lb', source_usd: 16.4, target_usd: 18.3 },
      { id: 'nat', source_usd: 43.1, target_usd: 2.0 },
      { id: 'nodes', source_usd: null, target_usd: null, excluded: true },
    ],
  },
  onprem: {
    currency: 'USD', basis: '2026-11-03',
    lines: [
      { id: 'control', source_usd: 73.0, target_usd: 0 },
      { id: 'lb', source_usd: 16.4, target_usd: 0 },
      { id: 'nat', source_usd: 43.1, target_usd: 0 },
      { id: 'nodes', source_usd: null, target_usd: null, excluded: true },
    ],
  },
}

export function planPreviewFor(target: Target, revision: number): PlanPreviewData {
  const path = pathOf(target)
  return {
    plan_id: PLAN_ID,
    revision,
    source: { provider: 'AWS', platform: 'EKS', location: 'ap-northeast-2' },
    target: PREVIEW_TARGET[path],
    resources: PREVIEW_RESOURCES[path].map(resource => ({ ...resource, name: '', detail: '' })),
    env_remap: PREVIEW_ENV[path],
    security_rules: PREVIEW_RULES,
    // 경고 하나: 대상 DB의 자동 백업 보존 기간이 원본보다 짧다(문구는 화면이 id로 찾는다).
    validation: { errors: [], warnings: [{ id: 'db-backup', resource: 'db', message: '' }] },
    rollout: PREVIEW_ROLLOUT,
    cost: PREVIEW_COST[path],
  }
}

// ---- 승인 결정(접수 → 전달 → 실행) ----

/** 결정을 기록한 뒤 실행 엔진에 전달되기까지 걸리는 시간(데모 값) */
export const APPROVAL_DELIVERY_MS = 1400
export const APPROVAL_ID = 'apr-3c81e0'

/**
 * 승인 버튼을 누른 뒤의 대본: 결정 기록(PENDING) → 전달 완료(DELIVERED, 실행 시작).
 * fail이면 전달이 실패한다(FAILED). 전달 실패는 이전 실패가 아니므로(API도 201 + FAILED) 이벤트 status는 waiting이다. attempt는 전달 시도 횟수(다시 전달할 때마다 +1).
 */
export function approvalTimeline(revision: number, options: { attempt?: number; fail?: boolean } = {}): TimedDraft[] {
  const attempt = options.attempt ?? 1
  const base: ApprovalDecisionData = { approval_id: APPROVAL_ID, plan_id: PLAN_ID, revision, decision: 'APPROVE', scope: 'FULL', delivery_status: 'PENDING', delivery_attempts: attempt, execution_status: 'NOT_STARTED', workflow_state: 'WAITING_FOR_APPROVAL' }
  const done: ApprovalDecisionData = options.fail
    ? { ...base, delivery_status: 'FAILED', workflow_state: 'UNAVAILABLE' }
    : { ...base, delivery_status: 'DELIVERED', execution_status: 'RUNNING', workflow_state: 'PROVISIONING' }
  return [
    { after: 0, event: { type: 'approval.decision', phase: 'awaiting_approval', status: 'waiting', data: base } },
    { after: APPROVAL_DELIVERY_MS, event: { type: 'approval.decision', phase: 'awaiting_approval', status: options.fail ? 'waiting' : 'done', data: done } },
  ]
}

/** 계획 화면이 항목을 하나씩 드러내는 연출(화면이 쓴다): 첫 항목까지의 시간, 항목 간격, 전체 길이. 서버는 연출이 끝난 뒤 승인을 요청한다. */
export const PLAN_FIRST_REVEAL_MS = 2550
export const PLAN_REVEAL_GAP_MS = 720
/** 드러내는 줄 수: 매핑 항목과 만들 리소스 중 많은 쪽 */
export const PLAN_STEP_COUNT = Math.max(PLAN_STEPS.length, PREVIEW_RESOURCES.gcp.length)
export const PLAN_REVEAL_MS = PLAN_FIRST_REVEAL_MS + PLAN_STEP_COUNT * PLAN_REVEAL_GAP_MS + 850

function planTimeline(target: Target, revision: number, mismatch: boolean): TimedDraft[] {
  // 문구(전·후·근거·변경)는 비워 두고 화면이 id로 자기 문구를 쓴다(GCP 대상일 때만 다른 문구 포함).
  const items: TimedDraft[] = PLAN_STEPS.map(step => {
    const keep = KEEP_SOURCE.has(step.id)
    const data: PlanStepData = { ...step, grade: gradeOf(step.id, target), before: '', after: '', evidence: '', change: '', action: 'PROCEED', keep_source: keep }
    return { after: 0, event: { type: 'plan.step', phase: 'planning', status: 'running', data } }
  })
  items.push({ after: 0, event: { type: 'plan.preview', phase: 'planning', status: 'running', data: planPreviewFor(target, revision) } })
  const verified = mismatch ? OTHER_DIGEST : DEMO_DIGEST
  items.push({ after: 0, event: { type: 'plan.ready', phase: 'planning', status: 'done', progress: 100, data: { plan_id: PLAN_ID, revision, template_version: TEMPLATE_VERSION, built_digest: DEMO_DIGEST, verified_digest: verified, manifest_digest: DEMO_MANIFEST_DIGEST, preview_digest: DEMO_PREVIEW_DIGEST } } })
  return items
}

// ---- 구축 ----

export const PROVISION_NODES: Record<FlowPath, string[]> = {
  gcp: ['network', 'cluster', 'db', 'app', 'lb', 'cert'],
  onprem: ['agent', 'cluster', 'db', 'app', 'relay', 'cert'],
}

/** 리소스가 모두 만들어진 뒤의 준비 상태 검사와, 승인 뒤 같은 테스트 묶음 재실행(retest) */
const PROVISION_CHECKS = [
  { name: 'pods_ready', ms: 1400 }, { name: 'db_connect', ms: 1200 }, { name: 'app_health', ms: 1200 }, { name: 'retest', ms: 2200 },
] as const
export const RETEST_TOTAL = 12

function provisionTimeline(target: Target): TimedDraft[] {
  const path = pathOf(target)
  const keys = PROVISION_NODES[path]
  const items: TimedDraft[] = keys.map((key, index) => {
    const progress = Math.round(((index + 1) / keys.length) * 100)
    return { after: 600 + index * 1250, event: { type: 'provision.resource', phase: 'provisioning', status: progress === 100 ? 'done' : 'running', progress, data: { id: path + '-' + key, key, state: 'done', progress } } }
  })
  let at = 600 + (keys.length - 1) * 1250
  for (const check of PROVISION_CHECKS) {
    const retest = check.name === 'retest'
    items.push({ after: at, event: { type: 'provision.check', phase: 'provisioning', status: 'running', data: { name: check.name, state: 'running' } } })
    at += check.ms
    items.push({ after: at, event: { type: 'provision.check', phase: 'provisioning', status: 'running', data: retest ? { name: check.name, state: 'done', passed: RETEST_TOTAL, total: RETEST_TOTAL } : { name: check.name, state: 'done' } } })
  }
  return items
}

// ---- 데이터 복제 ----

export const DATA_TOTAL_ROWS = 128400

// ---- 데이터 정합성 확인 (복제가 ready가 된 뒤, 행 수 → 체크섬 순서) ----
const DATA_VERIFY_TIMELINE: Array<{ after: number; data: DataVerifyData }> = [
  { after: 0, data: { name: 'rows', state: 'running' } },
  { after: 700, data: { name: 'rows', state: 'done', source: DATA_TOTAL_ROWS, target: DATA_TOTAL_ROWS } },
  { after: 700, data: { name: 'checksum', state: 'running' } },
  { after: 1600, data: { name: 'checksum', state: 'done' } },
]
/** 복제 준비 완료 시점부터 지난 시간(ms)까지 보낼 정합성 확인 이벤트를 돌려준다. cursor는 이미 보낸 개수. */
export function dueDataVerify(elapsedMs: number, cursor: number): { events: DraftEvent[]; cursor: number } {
  const events: DraftEvent[] = []
  let next = cursor
  while (next < DATA_VERIFY_TIMELINE.length && DATA_VERIFY_TIMELINE[next].after <= elapsedMs) {
    const { data } = DATA_VERIFY_TIMELINE[next]
    events.push({ type: 'data.verify', phase: 'data_copy', status: data.name === 'checksum' && data.state === 'done' ? 'done' : 'running', data })
    next += 1
  }
  return { events, cursor: next }
}
export const DATA_VERIFY_TOTAL_MS = DATA_VERIFY_TIMELINE[DATA_VERIFY_TIMELINE.length - 1].after

// ---- 전환 조건 확인 (트래픽 단계 시작 때, 소울님 PoC의 "전환 가능 시점" 값) ----
export const TRAFFIC_READY_MS = 900
export const TRAFFIC_READY_EVENTS: Array<{ after: number; data: TrafficReadyData }> = [
  { after: 0, data: { state: 'running', lag_ms: 38, longest_tx_ms: 420, commits_per_sec: 118 } },
  { after: TRAFFIC_READY_MS, data: { state: 'done', lag_ms: 12, longest_tx_ms: 85, commits_per_sec: 118 } },
]
export const DATA_TICK_MS = 250

function lagAt(seconds: number): number | null {
  if (seconds < 5) return null
  const base = 2200 * Math.exp(-(seconds - 5) * 0.62)
  const wobble = Math.sin(seconds * 3.1) * 24 + Math.cos(seconds * 1.7) * 14
  return Math.max(0, Math.round(base + wobble * Math.min(1, base / 200)))
}

/** 복제 시작 후 seconds초 시점의 진행 값. 화면은 이 값을 그대로 보여 준다. */
export function dataProgressAt(seconds: number): DataProgressData {
  const dump = Math.max(0, Math.min(1, (seconds - 1.6) / 3.2))
  const changes = seconds < 5 ? 0 : Math.round((seconds - 5) * 340)
  const lag = lagAt(seconds)
  const step = seconds < 1.6 ? 'connect' : seconds < 5 ? 'dump' : lag !== null && lag > 40 ? 'cdc' : 'ready'
  return {
    step,
    rows: Math.round(dump * DATA_TOTAL_ROWS) + changes,
    total_rows: DATA_TOTAL_ROWS,
    lag_ms: lag,
    writes_per_sec: 118 + Math.round(Math.sin(seconds * 1.3) * 14),
    dump_percent: Math.round(dump * 100),
  }
}

// ---- DB 전환 ----

/** 화면이 입자로 만들어지는 동안(2.4초)은 내용이 아직 안 보이므로, 그만큼 기다렸다가 단계를 시작한다. */
export const CUTOVER_ENTER_MS = 2400
const CUTOVER_STEP_MS = 1100
const RESULT_AT = [600, 1500, 2400]
const CUTOVER_RESULTS: Array<{ id: string; value: string }> = [
  { id: 'fail', value: '' }, { id: 'delay', value: '' }, { id: 'loss', value: '' },
]

/** 승인 뒤 시작 시점(approveCutover)부터의 대본. 측정 값은 비워 두고 화면이 id로 자기 문구를 쓴다. */
function cutoverTimeline(): TimedDraft[] {
  const items: TimedDraft[] = []
  for (let n = 1 as 1 | 2 | 3 | 4 | 5 | 6; n <= 6; n = (n + 1) as typeof n) {
    items.push({ after: CUTOVER_ENTER_MS + n * CUTOVER_STEP_MS, event: { type: 'cutover.step', phase: 'verification', status: 'running', progress: Math.round((n / 6) * 100), data: { n, state: 'done' } } })
  }
  const verifyAt = CUTOVER_ENTER_MS + 6 * CUTOVER_STEP_MS + 900
  items.push({ after: verifyAt, event: { type: 'cutover.step', phase: 'verification', status: 'running', data: { n: 6, state: 'verify' } } })
  CUTOVER_RESULTS.forEach((result, index) => {
    items.push({ after: verifyAt + RESULT_AT[index], event: { type: 'cutover.result', phase: 'verification', status: index === CUTOVER_RESULTS.length - 1 ? 'done' : 'running', data: result } })
  })
  // 최종 검증 뒤 운영권 인계: DNS 마지막 전환 → 원본 대기 유지 → 운영 권한 이전 (순서대로)
  const handoverAt = verifyAt + RESULT_AT[RESULT_AT.length - 1] + 500
  const HANDOVER: Array<'dns' | 'origin' | 'access'> = ['dns', 'origin', 'access']
  HANDOVER.forEach((item, index) => {
    items.push({ after: handoverAt + index * 700, event: { type: 'cutover.handover', phase: 'verification', status: 'running', data: { item, state: 'running' } } })
    items.push({ after: handoverAt + index * 700 + 600, event: { type: 'cutover.handover', phase: 'verification', status: 'done', data: { item, state: 'done' } } })
  })
  return items
}

// ---- 리포트 ----

/** 단계별 소요 시간(데모 값, 초) */
export const REPORT_SECONDS: Array<{ id: string; seconds: number }> = [
  { id: 'analysis', seconds: 42 },
  { id: 'rehearsal', seconds: 18 },
  { id: 'planning', seconds: 9 },
  { id: 'approval', seconds: 30 },
  { id: 'provisioning', seconds: 130 },
  { id: 'data', seconds: 275 },
  { id: 'traffic', seconds: 80 },
  { id: 'cutover', seconds: 12 },
]

export function reportFor(aiFixes: number): ReportData {
  return { stages: REPORT_SECONDS, ai_fixes: aiFixes }
}

// ---- 대본 조회 ----

export type ScriptedPhase = 'analysis' | 'build' | 'planning' | 'provisioning' | 'verification'

export function timelineFor(phase: ScriptedPhase, context: ScriptContext): TimedDraft[] {
  switch (phase) {
    case 'analysis': return analysisTimeline()
    case 'build': return context.review ? reviewTimeline() : buildTimeline(context.aiFixes, context.retried, context.sandbox)
    case 'planning': return planTimeline(context.target, context.revision ?? 1, !!context.digestMismatch)
    case 'provisioning': return provisionTimeline(context.target)
    case 'verification': return cutoverTimeline()
  }
}

/** 마지막 이벤트 시각(ms). 서버가 다음 단계로 넘어가기 전에 기다릴 시간을 계산할 때 쓴다. */
export function timelineEnd(items: TimedDraft[]): number {
  return items.reduce((end, item) => Math.max(end, item.after), 0)
}
