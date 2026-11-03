/**
 * 데모 대본: 지금까지 화면마다 들어 있던 타이머 대본을 이벤트로 옮겨 한 곳에 둔다.
 * 브라우저의 MockProvider와 목업 SSE 서버(scripts/mock-sse-server.mjs)가 이 모듈을 함께 쓴다.
 * 대본의 시각(after)은 "그 단계 화면이 준비된 순간"부터 센 ms이다.
 * Node가 그대로 읽으므로 런타임 import가 없고, 타입 문법만 쓴다(enum·네임스페이스 금지).
 */
import type { AnalysisFindingData, BuildFixData, DataProgressData, DraftEvent, FixLine, Grade, PlanStepData, ReportData, Target } from './events'

export type TimedDraft = { after: number; event: DraftEvent }
export type ScriptContext = { target: Target; aiFixes: number }

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

const CHECK_IDS = ['build', 'health', 'db', 'render', 'secret', 'scope']

type FixId = 'db' | 'host' | 'port' | 'probe'
// AI가 고치는 항목. 수정은 검증 항목 하나에 여러 개 붙을 수 있다(예: 상태 확인에서 서너 건).
const FIX_POOL: Array<{ id: FixId; check: string; lines: FixLine[] }> = [
  { id: 'db', check: 'db', lines: [{ kind: 'del', text: '- DB_HOST=postgres' }, { kind: 'add', text: '+ DB_HOST=postgresql.demo.svc.cluster.local' }] },
  { id: 'host', check: 'health', lines: [{ kind: 'del', text: '- HOST=127.0.0.1' }, { kind: 'add', text: '+ HOST=0.0.0.0' }] },
  { id: 'port', check: 'health', lines: [{ kind: 'add', text: '+ containerPort: 8080' }] },
  { id: 'probe', check: 'health', lines: [{ kind: 'add', text: '+ readinessProbe: { httpGet: { path: /health, port: 8080 } }' }] },
]

const FIX_GAP_MS = 1400 // 수정 하나를 고치는 데 걸리는 시간

function buildTimeline(aiFixes: number): TimedDraft[] {
  const fixes: BuildFixData[] = FIX_POOL.slice(0, aiFixes).map(fix => ({ id: fix.id, check: fix.check, lines: fix.lines, why: '', evidence: '' }))
  // 수정 목록은 단계 시작에 한꺼번에 알려 준다(검증 항목 카드의 개수 표시와 변경 내용 칩이 처음부터 같은 목록을 본다).
  const items: TimedDraft[] = fixes.map(data => ({ after: 0, event: { type: 'build.fix', phase: 'build', status: 'running', data } }))
  const check = (after: number, id: string, state: 'running' | 'failed' | 'fixing' | 'recheck' | 'done', fixed?: number) => {
    items.push({ after, event: { type: 'build.check', phase: 'build', status: state === 'done' ? 'done' : 'running', data: fixed === undefined ? { id, state } : { id, state, fixed } } })
  }
  // 검증 항목은 차례로 돌고, 수정이 붙은 항목은 "실패 → 수정(여러 개면 하나씩) → 재검증 → 통과"를 거친다.
  let at = 500
  for (const id of CHECK_IDS) {
    const count = fixes.filter(fix => fix.check === id).length
    check(at, id, 'running')
    if (count > 0) {
      check(at + 900, id, 'failed')
      for (let index = 0; index < count; index++) check(at + 1600 + index * FIX_GAP_MS, id, 'fixing', index)
      const recheckAt = at + 1600 + count * FIX_GAP_MS + 200
      check(recheckAt, id, 'recheck', count)
      check(recheckAt + 1000, id, 'done', count)
      at = recheckAt + 1400
    } else {
      check(at + 900, id, 'done')
      at += 1400
    }
  }
  return items
}

// ---- 계획 ----

const PLAN_STEPS: Array<{ id: string; group: 'infrastructure' | 'code' }> = [
  { id: 'network', group: 'infrastructure' },
  { id: 'compute', group: 'infrastructure' },
  { id: 'database', group: 'infrastructure' },
  { id: 'storage', group: 'infrastructure' },
  { id: 'db-code', group: 'code' },
  { id: 's3-code', group: 'code' },
]

/** 매핑 등급(11/2 회의): 대상에 그대로 쓸 수 있으면 직접 대응, 대응물이 없으면 MVP에서 제외. 가운데 등급은 화면용 제안. */
export function gradeOf(id: string, target: Target): Grade {
  switch (id) {
    case 'network': case 'db-code': return 'convert'
    case 'storage': case 's3-code': return target === 'gcp' ? 'direct' : 'none'
    default: return 'direct'
  }
}

/** 계획 화면이 항목을 하나씩 드러내는 연출(화면이 쓴다): 첫 항목까지의 시간, 항목 간격, 전체 길이. 서버는 연출이 끝난 뒤 승인을 요청한다. */
export const PLAN_FIRST_REVEAL_MS = 2550
export const PLAN_REVEAL_GAP_MS = 720
export const PLAN_STEP_COUNT = PLAN_STEPS.length
export const PLAN_REVEAL_MS = PLAN_FIRST_REVEAL_MS + PLAN_STEP_COUNT * PLAN_REVEAL_GAP_MS + 850

function planTimeline(target: Target): TimedDraft[] {
  // 문구(전·후·근거·변경)는 비워 두고 화면이 id로 자기 문구를 쓴다(GCP 대상일 때만 다른 문구 포함).
  const items: TimedDraft[] = PLAN_STEPS.map(step => {
    const data: PlanStepData = { id: step.id, group: step.group, grade: gradeOf(step.id, target), before: '', after: '', evidence: '', change: '' }
    return { after: 0, event: { type: 'plan.step', phase: 'planning', status: 'running', data } }
  })
  items.push({ after: 0, event: { type: 'plan.ready', phase: 'planning', status: 'done', progress: 100, data: {} } })
  return items
}

// ---- 구축 ----

export const PROVISION_NODES: Record<Target, string[]> = {
  gcp: ['network', 'cluster', 'db', 'app', 'lb', 'cert'],
  onprem: ['agent', 'cluster', 'db', 'app', 'relay', 'cert'],
}

function provisionTimeline(target: Target): TimedDraft[] {
  const keys = PROVISION_NODES[target]
  return keys.map((key, index) => {
    const progress = Math.round(((index + 1) / keys.length) * 100)
    return { after: 600 + index * 1250, event: { type: 'provision.resource', phase: 'provisioning', status: progress === 100 ? 'done' : 'running', progress, data: { id: target + '-' + key, key, state: 'done', progress } } }
  })
}

// ---- 데이터 복제 ----

export const DATA_TOTAL_ROWS = 128400
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
const CUTOVER_RESULTS: Array<{ id: 'fail' | 'delay' | 'loss'; value: string }> = [
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
    case 'build': return buildTimeline(context.aiFixes)
    case 'planning': return planTimeline(context.target)
    case 'provisioning': return provisionTimeline(context.target)
    case 'verification': return cutoverTimeline()
  }
}

/** 마지막 이벤트 시각(ms). 서버가 다음 단계로 넘어가기 전에 기다릴 시간을 계산할 때 쓴다. */
export function timelineEnd(items: TimedDraft[]): number {
  return items.reduce((end, item) => Math.max(end, item.after), 0)
}
