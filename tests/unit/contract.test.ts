import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Ajv from 'ajv/dist/2020.js'
import { APPROVAL_ID, DATA_VERIFY_TOTAL_MS, PLAN_ID, TRAFFIC_READY_EVENTS, approvalTimeline, dataProgressAt, planPreviewFor, dueDataVerify, reportFor, timelineFor, type ScriptedPhase } from '../../src/lib/migration/script.ts'
import { TrafficSim } from '../../src/lib/migration/trafficSim.ts'
import { DATA_END_MS, DATA_READY_AT, dataTickAt, dataTimeline, type PreflightScenario } from '../../src/lib/migration/dataScript.ts'
import { startRequestFor, type Target } from '../../src/lib/migration/events.ts'
import { adaptBackendPreview } from '../../src/lib/migration/previewAdapter.ts'
import { cutoverPlan, cutoverRefusesFirst, cutoverRun, pauseWindowMs, type CutoverScenario } from '../../src/lib/migration/cutoverScript.ts'
import { DATA_TABLES } from '../../src/lib/migration/dataScript.ts'

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
  const phases: ScriptedPhase[] = ['analysis', 'build', 'planning', 'provisioning']
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
  assert.ok(count > 250, '검증한 이벤트 수: ' + count)
})

test('DB 전환 대본(fast·classic·kill·tamper × 시도)이 스키마를 통과하고, 백엔드 PoC 순서·시간 보고 방식을 따른다 [가정]', () => {
  const scenarios: CutoverScenario[] = ['fast', 'classic', 'kill', 'tamper', 'tamper-classic']
  for (const target of ['gcp', 'onprem'] as Target[]) {
    for (const scenario of scenarios) {
      const plan = cutoverPlan(target, scenario)
      assertValid(validateEvent, stamp({ type: 'cutover.plan', phase: 'verification', status: 'waiting', data: plan }), 'cutover.plan/' + scenario)
      assert.ok(plan.preconditions.find(item => item.id === 'gate2')?.proposal, 'gate2 조건은 제안안')
      for (const attempt of [1, 2]) {
        const items = cutoverRun(scenario, attempt, DATA_TABLES)
        for (const { event } of items) assertValid(validateEvent, stamp(event), `cutover/${target}/${scenario}/${attempt}/${event.type}`)
        const sorted = [...items].sort((a, b) => a.after - b.after).map(item => item.event)
        const steps = sorted.flatMap(event => event.type === 'cutover.step' && event.data.state === 'done' ? [event.data] : [])
        assert.deepEqual(steps.map(step => step.n), steps.map((_, index) => index + 1), '단계 번호는 1부터 차례대로')
        assert.ok(steps.every(step => step.of === steps.length && step.ms === undefined), '실행 중에는 단계 상태만(시간은 결과로)')
        const outcome = sorted.find(event => event.type === 'cutover.outcome')
        assert.ok(outcome?.type === 'cutover.outcome')
        if (outcome?.type !== 'cutover.outcome') continue
        const refused = cutoverRefusesFirst(scenario) && attempt === 1
        assert.equal(outcome.data.result, refused ? 'refused' : 'switched')
        assert.notEqual(outcome.status, 'failed', '거부는 이전 실패가 아니다(원본으로 RESUME)')
        if (refused) {
          assert.equal(outcome.data.pause_ms, null, '중단이면 write_pause_ms가 없다')
          assert.equal(outcome.data.steps, undefined, '중단이면 단계별 시간이 없다')
          assert.ok(outcome.data.message, '중단이면 stderr 글')
        } else {
          const timed = outcome.data.steps ?? []
          assert.ok(timed.length > 0, '통과면 steps_ms')
          assert.equal(outcome.data.pause_ms, pauseWindowMs(timed), '쓰기 중단 = PAUSE 구간 길이')
          const method = steps[0]?.method
          if (method === 'fast') {
            assert.equal(timed.find(step => step.id === 'seq_raise')?.window, 'pre', 'fast는 시퀀스를 PAUSE 전에 올린다')
            const off = timed.find(step => step.id === 'sub_off'), on = timed.find(step => step.id === 'reverse')
            assert.ok(off && on && off.start_ms === on.start_ms, '정방향 disable과 역방향 enable은 동시에')
            assert.ok(!timed.some(step => step.id === 'checksum'), 'fast는 PAUSE 안 체크섬이 없다')
          } else {
            assert.ok(timed.some(step => step.id === 'checksum' && step.window === 'pause'), 'classic은 PAUSE 안에서 체크섬')
          }
        }
        const lastReady = sorted.map(event => event.type).lastIndexOf('cutover.ready')
        assert.ok(lastReady < sorted.findIndex(event => event.type === 'cutover.step'), '전환 가능 시점을 기다린 뒤 PAUSE')
        const tables = sorted.flatMap(event => event.type === 'cutover.verify' ? [event.data.checksum] : [])
        const mismatched = scenario === 'tamper' && !refused
        assert.equal(tables.includes('mismatch'), mismatched, 'fast 변조는 전환 뒤 검증에서만 불일치')
        const handover = sorted.flatMap(event => event.type === 'cutover.handover' ? [event.data.state] : [])
        assert.ok(refused || mismatched ? handover.every(state => state === 'held') : handover.includes('done'), '거부·불일치면 인계 보류')
      }
    }
  }
  const pauseOf = (scenario: CutoverScenario) => { const event = cutoverRun(scenario, 1, DATA_TABLES).find(item => item.event.type === 'cutover.outcome')!.event; return event.type === 'cutover.outcome' ? event.data.pause_ms ?? 0 : 0 }
  assert.ok(pauseOf('classic') > 50 * pauseOf('fast'), 'classic은 fast보다 훨씬 오래 멈춘다')
  const tamper = cutoverRun('tamper-classic', 1, DATA_TABLES).find(item => item.event.type === 'cutover.outcome')!.event
  assert.equal(tamper.type === 'cutover.outcome' && tamper.data.reason, 'CHECKSUM_MISMATCH', 'classic 변조는 사유 코드로 거부')
  const kill = cutoverRun('kill', 1, DATA_TABLES).find(item => item.event.type === 'cutover.outcome')!.event
  assert.equal(kill.type === 'cutover.outcome' && kill.data.reason, undefined, 'kill은 사유 코드 없이 stderr만')
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

test('승인 결정(접수 → 전달) 이벤트와 승인 API 응답이 스키마를 통과한다 [가정: approval.decision]', () => {
  const ok = approvalTimeline(2)
  const failed = approvalTimeline(1, { fail: true })
  for (const { event } of [...ok, ...failed, ...approvalTimeline(1, { attempt: 2 })]) assertValid(validateEvent, stamp(event), 'approval.decision')
  assert.deepEqual(ok.map(item => item.event.type === 'approval.decision' && item.event.data.delivery_status), ['PENDING', 'DELIVERED'], '전달 완료는 마지막에 온다')
  const last = failed[failed.length - 1].event
  assert.equal(last.type === 'approval.decision' && last.data.delivery_status, 'FAILED')
  assert.notEqual(last.status, 'failed', '전달 실패는 이전 실패가 아니다(이벤트 status가 failed면 화면이 이전 전체를 실패로 본다)')
  const response = { approval_id: APPROVAL_ID, plan_id: PLAN_ID, revision: 1, decision: 'APPROVE', approver_id: 'demo', scope: 'FULL', delivery_status: 'PENDING', delivery_attempts: 1, execution_status: 'NOT_STARTED', workflow_state: 'WAITING_FOR_APPROVAL' }
  assertValid(validateRest('ApprovalResponse'), response, 'ApprovalResponse')
  assert.equal(validateRest('ApprovalResponse')({ ...response, delivery_status: 'DONE' }), false, 'delivery_status 값')
  assert.equal(validateEvent(stamp({ type: 'approval.decision', phase: 'awaiting_approval', status: 'waiting', data: { ...response, approver_id: undefined, delivery_status: 'SENT' } })), false, '모르는 전달 상태')
})

test('계획 미리보기: 백엔드 Preview 모양을 받고, 화면 모델(어댑터 결과)의 전환 방법·요금 추정은 선택 필드다', () => {
  for (const target of ['gcp', 'onprem'] as Target[]) {
    const preview = planPreviewFor(target, 1)
    const event = (data: unknown) => stamp({ type: 'plan.preview', phase: 'planning', status: 'running', data })
    assertValid(validateEvent, event(preview), 'plan.preview(백엔드) ' + target)
    assert.equal('rollout' in preview || 'cost' in preview, false, '백엔드 Preview에는 전환 방법·요금 추정이 없다')
    // 감싸기(계획 입력·앱 Values)가 없는 Preview 그대로도 통과한다
    const { plan_id: _p, revision: _r, source: _s, target: _t, env_remap: _e, security_rules: _sr, ...bare } = preview
    assertValid(validateEvent, event(bare), 'plan.preview(Preview만) ' + target)
    assert.equal(validateEvent(event({ ...bare, changes: [{ resource_type: 'NODE', action: 'MOVE', name: 'x' }] })), false, '모르는 action')
    assert.equal(validateEvent(event({ ...bare, pending_decisions: [{ code: 'CLEANUP_POLICY_REQUIRED' }] })), false, 'ValidationIssue에는 path·message가 있다')
    // 화면 모델(예전 미리보기)도 그대로 받는다
    const model = adaptBackendPreview(preview, { steps: [], meta: null })
    const { pending_decisions: _pd, manifest_digest: _m, ...legacy } = model
    assertValid(validateEvent, event({ ...legacy, source: preview.source, target: preview.target }), 'plan.preview(화면 모델) ' + target)
    assert.equal(validateEvent(event({ ...legacy, source: preview.source, target: preview.target, rollout: { traffic_steps: [] } })), false, '빈 전환 단계')
    assert.equal(validateEvent(event({ ...legacy, source: preview.source, target: preview.target, cost: { currency: 'USD', lines: [{ id: 'lb', source_usd: -1, target_usd: null }] } })), false, '음수 요금')
  }
})

test('분석: 스캔 배치(기본)와 예전 항목 방식(?analysis=items) 모두 스키마를 통과한다', () => {
  const scans = timelineFor('analysis', { target: 'gcp', aiFixes: 1 })
  const items = timelineFor('analysis', { target: 'gcp', aiFixes: 1, analysisItems: true })
  for (const { event } of [...scans, ...items]) assertValid(validateEvent, stamp(event), 'analysis/' + event.type)
  assert.ok(scans.every(item => item.event.type !== 'analysis.finding'), '기본 대본은 항목마다 보내지 않는다')
  assert.ok(items.every(item => item.event.type !== 'analysis.scan'))
  const bad = { type: 'analysis.scan', phase: 'analysis', status: 'running', data: { id: 's', activity: 'scan_code', stream: 'code', completed: 1, total: 1, items: [], evidence: [{ kind: 'GIT', locator: '', verified: true }] } }
  assert.equal(validateEvent(stamp(bad)), false, '모르는 근거 종류')
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

// ---- 데이터 이전 단계 상세 [가정] ----
test('데이터 이전 대본(사전 검사 3가지 × 대상)과 250ms 틱이 스키마를 통과한다', () => {
  const start = Date.UTC(2026, 10, 5, 9, 0, 0)
  for (const target of ['gcp', 'onprem'] as Target[]) {
    for (const scenario of ['pass', 'route', 'unknown'] as PreflightScenario[]) {
      const items = dataTimeline(target, scenario, start)
      for (const { event } of items) assertValid(validateEvent, stamp(event), `data/${target}/${scenario}/${event.type}`)
      const verdict = items.filter(item => item.event.type === 'data.preflight').map(item => item.event.data as { status: string; may_start: boolean; input_fingerprint: string | null }).at(-1)!
      assert.equal(verdict.status, scenario === 'pass' ? 'PASS' : scenario === 'route' ? 'FAIL' : 'UNKNOWN', 'verdict ' + scenario)
      assert.equal(verdict.may_start, scenario === 'pass', '시작 허용은 PASS일 때만')
      assert.ok(verdict.input_fingerprint, '입력 지문')
      const phases = items.filter(item => item.event.type === 'data.phase').map(item => (item.event.data as { phase: string }).phase)
      assert.deepEqual(phases, scenario === 'pass' ? ['preflight', 'schema', 'copy', 'catchup', 'streaming'] : ['preflight', 'blocked'], 'phase 순서 ' + scenario)
      // 시작 차단이면 테이블 복사·LSN이 없다(초기 복사·CDC를 시작하지 않는다).
      if (scenario !== 'pass') {
        assert.equal(items.some(item => item.event.type === 'data.table' || item.event.type === 'data.readiness'), false, '차단 뒤 복제 없음')
        assert.equal(dataTickAt(DATA_END_MS, scenario).some(event => event.type === 'data.lsn'), false, '차단 뒤 LSN 없음')
      } else {
        const ready = items.filter(item => item.event.type === 'data.readiness').map(item => item.event.data as { ready: boolean })
        assert.equal(ready.at(-1)?.ready, true, '게이트 1 통과')
        assert.ok(items.filter(item => item.event.type === 'data.table').every(item => item.after <= DATA_READY_AT), '테이블 이벤트는 게이트 1까지')
      }
      for (let ms = 0; ms <= DATA_END_MS + 2000; ms += 250) {
        for (const event of dataTickAt(ms, scenario)) assertValid(validateEvent, stamp(event), `tick/${scenario}/${ms}/${event.type}`)
      }
    }
  }
  const lsn = dataTickAt(DATA_END_MS, 'pass').find(event => event.type === 'data.lsn')!.data as { lag_bytes: number; source_lsn: string; target_lsn: string }
  assert.equal(lsn.lag_bytes, 0, '스트리밍 뒤 지연 0 B')
  assert.equal(lsn.source_lsn, lsn.target_lsn, '원본 쓰기 위치 = 대상 재생 위치')
  assert.equal(validateEvent(stamp({ type: 'data.preflight', phase: 'data_copy', status: 'running', data: { status: 'MAYBE', checks: [], probe_location: 'x', input_fingerprint: null, checked_at: null, may_start: false, network: dataTimeline('onprem', 'pass', start)[1].event.data } })), false, 'preflight status')
  assert.equal(validateEvent(stamp({ type: 'data.phase', phase: 'data_copy', status: 'running', data: { phase: 'dump' } })), false, 'data.phase 값')
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
  // 고른 공개 GitHub 저장소(source): 커밋 SHA로 고정한 참조만, 토큰 같은 다른 값은 받지 않는다.
  const source = { kind: 'GITHUB_PUBLIC' as const, repository_id: 42, full_name: 'octo/real', commit_sha: 'a'.repeat(40) }
  assertValid(validateRest('StartRequest'), { project_id: 'demo', source_provider: 'AWS', target_provider: 'GCP', ...startRequestFor('gcp', { source }) }, 'StartRequest source')
  assert.equal(validateRest('StartRequest')({ ...startRequestFor('gcp'), source: { ...source, commit_sha: 'main' } }), false, 'source는 브랜치가 아니라 커밋 SHA')
  assert.equal(validateRest('StartRequest')({ ...startRequestFor('gcp'), source: { ...source, token: 'gho_x' } }), false, 'source에 토큰을 싣지 않는다')
  // 확정한 이전 범위(scope_id): 플랫폼 MigrationRequest.scope_id와 같은 형식만 받는다.
  const scopeId = 'scope-' + 'a1'.repeat(8)
  const scoped = startRequestFor('gcp', { scopeId })
  assert.equal(scoped.scope_id, scopeId)
  assertValid(validateRest('StartRequest'), { project_id: 'demo', source_provider: 'AWS', target_provider: 'GCP', ...scoped }, 'StartRequest scope_id')
  assert.equal('scope_id' in startRequestFor('gcp'), false, '범위를 확정하지 않으면 scope_id를 싣지 않는다')
  assert.equal(validateRest('StartRequest')({ ...startRequestFor('gcp'), scope_id: 'scan-123' }), false, 'scope_id는 scope- 형식')
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
  assert.equal(validateEvent({ ...good, type: 'cutover.step', phase: 'verification', data: { n: 33, state: 'done' } }), false, 'n 범위')
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
    cwd: new URL('../../', import.meta.url), env: { ...process.env, PORT: String(port), MOCK_STATE_FILE: state, MOCK_SPEED: '10' }, stdio: 'ignore',
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
    for (const type of ['snapshot', 'analysis.scan', 'analysis.done', 'sandbox.env', 'sandbox.step', 'sandbox.attempt', 'sandbox.done', 'build.fix', 'build.result', 'plan.step', 'plan.ready', 'approval.required', 'approval.decision', 'provision.resource', 'provision.check', 'error']) {
      assert.ok(seen.includes(type), type + ' 이벤트를 받지 못했습니다')
    }
    const report = await (await fetch(`${base}/migrations/${id}/report`)).json()
    assertValid(validateRest('Report'), report, 'Report')
    // 이어 받기: Last-Event-ID 뒤의 이벤트만 담긴 snapshot(reset=false)이 온다
    const resumed = await fetch(`${base}/migrations/${id}/events`, { headers: { 'Last-Event-ID': '5' }, signal: controller.signal })
    // 첫 조각에는 `retry:` 줄만 있을 수 있다: data 줄이 나올 때까지 읽는다.
    const resumeReader = resumed.body!.getReader()
    let first = ''
    while (!first.split('\n').some(item => item.startsWith('data: '))) {
      const { done, value } = await resumeReader.read()
      if (done) break
      first += new TextDecoder().decode(value)
    }
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
