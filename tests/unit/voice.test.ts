import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveParticles, VOICE_MESSAGES, voiceText, type VoiceKey } from '../../src/lib/voice/messages.ts'
import { approvalFactReports, cutoverFactReports, renderReport, ReportEngine, ReportQueue, type Report } from '../../src/lib/voice/reports.ts'
import { hintKeys, matchCommand } from '../../src/lib/voice/commands.ts'
import { statusLine } from '../../src/lib/voice/status.ts'
import { initialState } from '../../src/lib/migration/reducer.ts'
import { chunkText, preprocess } from '../../src/lib/tts/supertonic.ts'
import { cacheKey, parseTtsRequest } from '../../src/lib/tts/service.ts'
import type { MigrationEvent } from '../../src/lib/migration/events.ts'

let seq = 0
const ev = (event: Omit<MigrationEvent, 'seq' | 'at'>) => ({ ...event, seq: ++seq, at: '2026-11-05T00:00:00Z' }) as MigrationEvent
const finding = (stream: 'infrastructure' | 'code', progress: number) => ev({ type: 'analysis.finding', phase: 'analysis', status: 'running', progress, data: { id: 'f' + seq, stream, key: 'k', via: [], progress, message: '', detail: '' } })

test('보고 문구: 세 언어 모두 같은 키·같은 변수를 가진다', () => {
  const keys = Object.keys(VOICE_MESSAGES.ko) as VoiceKey[]
  for (const lang of ['en', 'ja'] as const) {
    assert.deepEqual(Object.keys(VOICE_MESSAGES[lang]).sort(), [...keys].sort())
    for (const key of keys) {
      const vars = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort().join()
      assert.equal(vars(VOICE_MESSAGES[lang][key]), vars(VOICE_MESSAGES.ko[key]), `${lang} ${key}`)
    }
  }
})

test('보고 문구: 한 문장(두 승인 지점·실패·단계 시작만 두 문장), 단계 끝은 다음 단계를 묻는다', () => {
  const TWO = /^(r\.start\.|r\.approval\.|r\.cutover\.(facts|refused)|r\.data\.preflight|r\.sandbox\.(attemptFail|review|passed)|r\.analysis\.done|r\.plan\.ready|r\.prov\.done|r\.data\.(lagZero|copyDone)|r\.traffic\.(done|step|gate|rollback|alertError|alertP99)|r\.cutover\.(pause|done)|r\.error|r\.migration\.done|c\.confirm)/
  for (const [key, text] of Object.entries(VOICE_MESSAGES.ko)) {
    if (!key.startsWith('r.') && !key.startsWith('c.')) continue
    const sentences = text.split(/[.?!](\s|$)/).filter(part => part.trim().length > 1).length
    assert.ok(sentences <= (TWO.test(key) ? 2 : 1), `${key}: ${text}`)
    assert.ok(text.replace(/\{\w+\}/g, '12').length <= 40, `${key}: 너무 길다 — ${text}`)
  }
  for (const key of ['r.analysis.done', 'r.sandbox.passed', 'r.plan.ready', 'r.prov.done', 'r.data.lagZero', 'r.traffic.done'] as VoiceKey[]) {
    assert.ok(VOICE_MESSAGES.ko[key].endsWith('{next}(으)로 갈까요?'), key)
  }
  assert.equal(voiceText('ko', 'r.sandbox.attemptFail', { attempt: 1, cls: 'cls.CODE' }), '1차 실패. 코드 문제를 고칩니다.')
  assert.equal(voiceText('ko', 'r.analysis.done', { next: 'stage.rehearsal' }), '분석 완료. 샌드박스 검증으로 갈까요?')
  assert.equal(voiceText('ko', 'r.sandbox.passed', { next: 'stage.planning' }), '검증 통과. 계획 수립으로 갈까요?')
  assert.equal(voiceText('ko', 'r.plan.ready', { next: 'stage.approval' }), '계획 완료. 승인으로 갈까요?')
  assert.equal(voiceText('ko', 'r.traffic.done', { next: 'stage.cutover' }), '트래픽 이전 완료. DB 전환으로 갈까요?')
  assert.equal(voiceText('en', 'r.traffic.done', { next: 'stage.cutover' }), 'Traffic migration complete. Go to the DB switch?')
  assert.equal(voiceText('ja', 'r.plan.ready', { next: 'stage.approval' }), '計画完了。承認に進みますか？')
  // 코드는 날 코드가 아니라 읽을 수 있는 문구로
  assert.equal(voiceText('ko', 'r.error', { phase: 'phase.data_copy', reason: 'code:TLS_FAILED' }), '데이터 오류. TLS 실패.')
  assert.equal(voiceText('en', 'r.data.preflightFail', { reason: 'code:ROUTE_NOT_TUNNEL' }), 'Route outside the tunnel. Start blocked.')
  assert.equal(voiceText('ko', 'r.data.preflightFail', { reason: 'code:ROUTE_NOT_TUNNEL' }), '터널 밖 경로. 시작을 막았습니다.')
})

test('보고 문구: 목록은 3개까지 + "외 N개", 조사는 받침으로', () => {
  const items = (n: number) => ['item.vpc', 'item.subnet', 'item.alb', 'item.node', 'item.iam_role'].slice(0, n)
  assert.equal(voiceText('ko', 'r.analysis.scanDone.infrastructure', { items: items(1) }), '인프라에서 VPC 발견.')
  assert.equal(voiceText('ko', 'r.analysis.scanDone.infrastructure', { items: items(2) }), '인프라에서 VPC와 서브넷 발견.')
  assert.equal(voiceText('ko', 'r.analysis.scanDone.infrastructure', { items: items(5) }), '인프라에서 VPC, 서브넷, ALB 외 2개 발견.')
  assert.equal(voiceText('en', 'r.analysis.scanDone.infrastructure', { items: items(5) }), 'Found VPC, subnets, ALB and 2 more in the infrastructure.')
  assert.equal(voiceText('ja', 'r.analysis.scanDone.infrastructure', { items: items(5) }), 'インフラでVPC、サブネット、ALBほか2個を発見。')
  assert.equal(voiceText('ko', 'r.prov.ready', { name: ['res.app', 'res.lb'] }), '앱과 로드 밸런서 생성 완료.')
  assert.equal(voiceText('ko', 'r.prov.ready', { name: ['res.network', 'res.cluster'] }), '네트워크와 클러스터 생성 완료.')
  assert.equal(voiceText('ko', 'r.plan.keep', { items: ['step.storage'] }), 'S3 버킷은 원본에 둡니다.')
  assert.equal(voiceText('ko', 'r.plan.keep', { items: ['step.storage', 'step.s3-code'] }), 'S3 버킷과 S3 호출 코드는 원본에 둡니다.')
  assert.equal(resolveParticles('DB 전환(으)로 · 서울(으)로 · 승인(으)로 · K3s(으)로 · 레일(으)로'), 'DB 전환으로 · 서울로 · 승인으로 · K3s로 · 레일로')
})

test('엔진: 분석은 스캔 흐름이 끝날 때 찾은 것을 말하고, 끝나면 다음 단계를 묻는다', () => {
  const engine = new ReportEngine()
  const said: string[] = []
  const scan = (stream: 'infrastructure' | 'code', completed: number, total: number, keys: string[]) => ev({ type: 'analysis.scan', phase: 'analysis', status: 'running', data: {
    id: stream + completed, activity: 'x', stream, completed, total, items: keys.map(key => ({ key, n: 1 })), evidence: [] } })
  for (const event of [scan('infrastructure', 1, 2, ['vpc', 'subnet']), scan('code', 1, 1, ['db_driver', 'files']), scan('infrastructure', 2, 2, ['resources', 'eks_cluster', 'alb'])]) {
    for (const report of engine.fromEvent(event, 'analysis', 0)) said.push(renderReport(report, 'ko'))
  }
  assert.deepEqual(said, ['코드에서 DB 드라이버 발견.', '인프라에서 VPC, 서브넷, EKS 클러스터 외 1개 발견.'])
  const done = ev({ type: 'analysis.done', phase: 'analysis', status: 'done', progress: 100, data: {} })
  assert.deepEqual(engine.fromEvent(done, 'analysis', 0).map(report => renderReport(report, 'ko')), ['분석 완료. 샌드박스 검증으로 갈까요?'])
  assert.equal(engine.fromEvent(done, 'analysis', 0).length, 0, '완료는 한 번만')
  // 예전 방식(항목마다 한 건)도 흐름의 진행이 100이 될 때 한 번
  const legacy = new ReportEngine()
  const codeFinding = (key: string, progress: number) => ev({ type: 'analysis.finding', phase: 'analysis', status: 'running', progress, data: { id: key, stream: 'code', key, via: [], progress, message: '', detail: '' } })
  const legacySaid = [codeFinding('database', 40), codeFinding('compose', 60), codeFinding('code-done', 100), finding('infrastructure', 100)]
    .flatMap(event => legacy.fromEvent(event, 'analysis', 0)).map(report => renderReport(report, 'ko'))
  assert.deepEqual(legacySaid, ['코드에서 DB 드라이버와 컨테이너 구성 발견.', '인프라 스캔 완료.'])
})

test('엔진: 구축은 리소스 이름(연달아 끝나면 큐가 잇는다)·확인, 데이터는 사전 검사·테이블 m개 중 n개', () => {
  const engine = new ReportEngine()
  const resource = (key: string, state: 'running' | 'done') => ev({ type: 'provision.resource', phase: 'provisioning', status: 'running', data: { id: 'p-' + key, key, state, progress: 0 } })
  const queue = new ReportQueue({ gapMs: 3500, restMs: 0, staleMs: 60000 })
  for (const event of [resource('network', 'running'), resource('network', 'done'), resource('cluster', 'done'), resource('db', 'done')]) for (const report of engine.fromEvent(event, 'provisioning', 0)) queue.push(report)
  const spoken: string[] = []
  for (let now = 0; now < 20000; now += 500) { const next = queue.next(now, false); if (next) spoken.push(renderReport(next, 'ko')) }
  assert.deepEqual(spoken, ['네트워크 생성 중.', '네트워크, 클러스터, DB 생성 완료.'])
  const check = (name: string, state: 'done' | 'failed') => ev({ type: 'provision.check', phase: 'provisioning', status: 'running', data: { name: name as 'pods_ready', state } })
  const prov = [check('pods_ready', 'done'), check('db_connect', 'failed'), check('retest', 'done')].flatMap(event => engine.fromEvent(event, 'provisioning', 0)).map(report => renderReport(report, 'ko'))
  assert.deepEqual(prov, ['파드 준비 확인.', 'DB 연결 확인 실패.', '구축 완료. 데이터 이전으로 갈까요?'])

  const preflight = (status: 'RUNNING' | 'PASS' | 'FAIL', checks: Array<[string, string, string | null]>) => ev({ type: 'data.preflight', phase: 'data_copy', status: 'running', data: {
    status, checks: checks.map(([name, state, code]) => ({ name, status: state, code, evidence: '' })), probe_location: '', input_fingerprint: null, checked_at: null, may_start: status === 'PASS' } } as never)
  const pf = [preflight('RUNNING', [['cidr_overlap', 'PASS', null], ['route', 'RUNNING', null]]), preflight('PASS', [['cidr_overlap', 'PASS', null], ['route', 'PASS', null], ['db_path', 'PASS', null], ['large_transfer', 'PASS', null]])]
    .flatMap(event => engine.fromEvent(event, 'data', 0)).map(report => renderReport(report, 'ko'))
  assert.deepEqual(pf, ['CIDR 충돌 없음.', '터널 경로 확인.', '원본 DB 연결 확인.', '대량 전송 통과.', '사전 검사 통과. 초기 복사를 시작합니다.'])
  const failEngine = new ReportEngine()
  assert.deepEqual(failEngine.fromEvent(preflight('FAIL', [['route', 'FAIL', 'ROUTE_NOT_TUNNEL']]), 'data', 0).map(report => renderReport(report, 'ko')), ['터널 밖 경로. 시작을 막았습니다.'])

  const table = (name: string, state: 'copying' | 'copied') => ev({ type: 'data.table', phase: 'data_copy', status: 'running', data: { name, rows_copied: 1, rows_total: 2, state } })
  const said = [table('t1', 'copying'), table('t2', 'copying'), table('t3', 'copying'), table('t4', 'copying'), table('t1', 'copied'), table('t2', 'copied'), table('t3', 'copied'), table('t4', 'copied')]
    .flatMap(event => engine.fromEvent(event, 'data', 0)).map(report => renderReport(report, 'ko'))
  assert.deepEqual(said, ['테이블 4개 중 1개 복사.', '테이블 4개 중 2개 복사.', '테이블 4개 중 3개 복사.', '초기 복사 완료. 변경분을 따라잡습니다.'])
  const ready = ev({ type: 'data.readiness', phase: 'data_copy', status: 'running', data: { ready: true } } as never)
  assert.deepEqual(engine.fromEvent(ready, 'data', 0).map(report => renderReport(report, 'ko')), ['복제 지연 0. DB 전환으로 갈까요?'], '백엔드 순서: 데이터 다음은 DB 전환')
})

test('엔진: 화면 단계와 다른 phase의 이벤트는 실패만 말한다', () => {
  const engine = new ReportEngine()
  const ready = ev({ type: 'plan.ready', phase: 'planning', status: 'done', data: { revision: 1 } })
  assert.equal(engine.fromEvent(ready, 'approval', 0).length, 0)
  const error = ev({ type: 'error', phase: 'data_copy', status: 'failed', data: { code: 'LAG', message: '', phase: 'data_copy', retryable: true } })
  assert.equal(renderReport(engine.fromEvent(error, 'approval', 0)[0], 'ko'), '데이터 오류. 지연.')
})

test('엔진: 샌드박스 시작·실패 분류·통과, 계획 요약, 승인 사실, 트래픽 단계·롤백', () => {
  const engine = new ReportEngine()
  const tests = ev({ type: 'sandbox.tests', phase: 'build', status: 'running', data: { total: 24, catalog: 20, original: 4, generated: 0, read_only: 0 } })
  assert.deepEqual(engine.fromEvent(tests, 'rehearsal', 0).map(report => renderReport(report, 'ko')), ['샌드박스 검증을 시작합니다. 테스트 24개.'])
  const checks = { required_passed: 12, required_total: 12, unsupported_calls: 0, calls_in_mapping: 3, calls_total: 3, blocked_egress: 0 }
  const fail = ev({ type: 'sandbox.attempt', phase: 'build', status: 'running', data: { run: 1, attempt: 1, max_attempts: 3, verdict: { passed: false, reasons: [] }, failure_class: 'CODE', checks, fix_ids: [] } })
  const [failure] = engine.fromEvent(fail, 'rehearsal', 0)
  assert.equal(failure.kind, 'failure')
  assert.equal(renderReport(failure, 'ja'), '1回目失敗。コードの問題を直します。')
  engine.fromEvent(ev({ type: 'sandbox.attempt', phase: 'build', status: 'running', data: { run: 2, attempt: 2, max_attempts: 3, verdict: { passed: true, reasons: [] }, failure_class: null, checks, fix_ids: [] } }), 'rehearsal', 0)
  const [passed] = engine.fromEvent(ev({ type: 'sandbox.done', phase: 'build', status: 'running', data: { status: 'PASSED', cleanup_status: 'PENDING', digest: null } }), 'rehearsal', 0)
  assert.equal(renderReport(passed, 'ko'), '검증 통과. 계획 수립으로 갈까요?')

  const step = (id: string, grade: string, keep: boolean) => ev({ type: 'plan.step', phase: 'planning', status: 'running', data: { id, group: 'infrastructure', grade, before: '', after: '', evidence: '', change: '', action: 'PROCEED', keep_source: keep, verification: 'UNVERIFIED' } } as never)
  for (const event of [step('network', 'API_DIFF', false), step('compute', 'DIRECT', false), step('database', 'DIRECT', false), step('storage', 'NONE', true)]) engine.fromEvent(event, 'planning', 0)
  engine.fromEvent(ev({ type: 'plan.preview', phase: 'planning', status: 'running', data: { manifest_digest: 'm', changes: [], applied_defaults: [], errors: [],
    warnings: [{ code: 'DB_BACKUP_RETENTION_SHORT', path: '', message: '' }], pending_decisions: [{ code: 'CLEANUP_POLICY_REQUIRED', path: '', message: '' }],
    env_remap: [{ key: 'DB_PASSWORD', from: 'secret', to: 'sm://x', secret: true }, { key: 'DB_HOST', from: 'a', to: 'b', secret: false }] } }), 'planning', 0)
  const plan = engine.fromEvent(ev({ type: 'plan.ready', phase: 'planning', status: 'done', data: { revision: 1, built_digest: 'sha256:a', verified_digest: 'sha256:a' } }), 'planning', 0)
  assert.deepEqual(plan.map(report => renderReport(report, 'ko')), ['그대로 2개, 설정 변경 1개.', 'S3 버킷은 원본에 둡니다.', '검증한 이미지로 고정.', '환경 변수 1개를 Secret으로 연결.', '계획 완료. 승인으로 갈까요?'])
  assert.ok(plan.every(report => report.kind === 'complete'), '계획 요약은 완료와 함께 순서대로')

  const required = engine.fromEvent(ev({ type: 'approval.required', phase: 'awaiting_approval', status: 'waiting', data: { excluded: [], rollback_policy: '' } }), 'approval', 0)
  assert.deepEqual(required.map(report => renderReport(report, 'ko')), ['만들 리소스, 원본에 남는 항목, 비용을 확인해 주세요.', '확인할 항목 2건. DB 백업 보관 기간 부족.', "맞으면 '승인'이라고 해 주세요."])
  assert.ok(required.every(report => report.kind === 'decision'))

  const snap = (phase: string, step: number, results: Array<{ step: number; verdict: 'pass' | 'rollback'; failed?: number }> = []) => ev({ type: 'traffic.snapshot', phase: 'traffic', status: 'running', data: {
    phase: phase as 'applying', weights: { origin: 100 - step, target: step }, step, gate: { failed_requests: 0, max_failed_requests: 5, p99_ratio: 1, max_p99_ratio: 1.5, observe_left_seconds: 0, observe_seconds: 30 },
    residual: { requests_per_sec: 0, streams: 0 }, results: results.map(result => ({ step: result.step, verdict: result.verdict, failed_requests: result.failed ?? 0, p99_ratio: 1 })) } })
  const said = (event: MigrationEvent) => engine.fromEvent(event, 'traffic', 0).map(report => renderReport(report, 'ko'))
  assert.deepEqual(said(snap('applying', 10)), ['10퍼센트 전환. 30초 관찰합니다.'])
  assert.deepEqual(said(snap('observing', 10)), [])
  assert.deepEqual(said(snap('applying', 50, [{ step: 10, verdict: 'pass', failed: 2 }])), ['10퍼센트 통과. 실패 2건.', '50퍼센트 전환. 30초 관찰합니다.'])
  assert.deepEqual(said(snap('rolledback', 0)), ['기준 초과. 원본으로 되돌렸습니다.'])
  assert.deepEqual(said(snap('rolledback', 0)), [])
})

test('DB 전환: 쓰기 중단 밀리초·되돌릴 수 있음·승인 방법, 실행 중 보고', () => {
  assert.deepEqual(cutoverFactReports(1800, 0).map(report => renderReport(report, 'ko')),
    ['전환 중 쓰기가 약 1800밀리초 멈춥니다. 요청은 실패하지 않습니다.', '문제가 생기면 원본으로 되돌릴 수 있습니다.', "진행하려면 '승인'이라고 해 주세요."])
  assert.equal(renderReport(cutoverFactReports(null, 0)[0], 'en'), 'Writes pause briefly during the switch. No requests fail.')
  assert.deepEqual(approvalFactReports({ warnings: 0, first: null }, 0).map(report => report.key), ['r.approval.facts', 'r.approval.ask'])
  const engine = new ReportEngine()
  const cut = (event: Omit<MigrationEvent, 'seq' | 'at'>) => engine.fromEvent(ev(event), 'cutover', 0).map(report => renderReport(report, 'ko'))
  assert.deepEqual(cut({ type: 'cutover.step', phase: 'verification', status: 'running', data: { n: 2, state: 'done', id: 'pause' } }), ['쓰기를 잠시 멈췄습니다.'])
  assert.deepEqual(cut({ type: 'cutover.step', phase: 'verification', status: 'running', data: { n: 6, state: 'verify' } }), ['결과를 검증합니다.'])
  cut({ type: 'cutover.verify', phase: 'verification', status: 'running', data: { table: 'orders', source_rows: 1, target_rows: 1, checksum: 'match' } })
  assert.deepEqual(cut({ type: 'cutover.result', phase: 'verification', status: 'done', data: { id: 'pause', value: '8 ms', ok: true } }), ['전환 완료. 쓰기 중단 8 ms.', '체크섬 일치. 검증 완료.'])
  const refused = new ReportEngine()
  refused.fromEvent(ev({ type: 'cutover.step', phase: 'verification', status: 'running', data: { n: 6, state: 'done', id: 'liveness', result: 'fail' } }), 'cutover', 0)
  const outcome = ev({ type: 'cutover.outcome', phase: 'verification', status: 'waiting', data: { result: 'refused', message: 'x', active: 'source', pause_ms: null, replication: { direction: 'forward', lag_ms: null } } })
  assert.deepEqual(refused.fromEvent(outcome, 'cutover', 0).map(report => renderReport(report, 'ko')), ['대상 DB 응답 없음. 원본으로 되돌렸습니다.'])
})

test('큐: 실패·결정 먼저, 최소 간격, 오래된 진행 버림, 잠깐 멈춤', () => {
  const queue = new ReportQueue({ gapMs: 3500, restMs: 1000, staleMs: 9000 })
  const make = (key: Report['key'], kind: Report['kind'], at: number, series?: string): Report => ({ key, params: { n: at, m: 9 }, kind, phase: 'data_copy', at, series })
  queue.push(make('r.data.tables', 'milestone', 0, 'progress:data_copy'))
  queue.push(make('r.data.preflightFail', 'failure', 0))
  assert.equal(queue.size, 1, '실패가 오면 같은 단계의 진행은 버린다')
  assert.equal(queue.next(0, true), null, '말하는 중에는 기다린다')
  assert.equal(queue.next(500, false)?.key, 'r.data.preflightFail')
  // 진행은 같은 series면 새 값으로 바뀐다(낡은 진행은 말하지 않는다).
  queue.push(make('r.data.tables', 'milestone', 600, 'progress:data_copy'))
  queue.push(make('r.data.tables', 'milestone', 700, 'progress:data_copy'))
  assert.equal(queue.size, 1)
  assert.equal(queue.next(1000, false), null, '간격(3.5초) 전에는 말하지 않는다')
  assert.equal(queue.next(4100, false)?.params.n, 700)
  // 오래된 진행은 버린다.
  queue.push(make('r.data.tables', 'milestone', 5000, 'progress:data_copy'))
  assert.equal(queue.next(20000, false), null)
  assert.equal(queue.size, 0)
  // 잠깐: 실패만 말한다.
  queue.paused = true
  queue.push(make('r.data.lagZero', 'complete', 21000))
  assert.equal(queue.next(30000, false), null)
  queue.push(make('r.data.verifyFail', 'failure', 30000))
  assert.equal(queue.next(30500, false)?.key, 'r.data.verifyFail')
  queue.paused = false
  assert.equal(queue.next(40000, false)?.key, 'r.data.lagZero')
})

test('명령: 일반 동의는 승인이 아니다, 명시 승인·부정·되묻기', () => {
  for (const text of ['좋아', '진행해', '다음', '좋아, 진행하자', 'next', 'go ahead', '次へ']) assert.equal(matchCommand(text), 'advance', text)
  for (const text of ['승인', '승인.', '승인해', '승인할게', '헤이 자칼, 승인합니다', '헤이 자칼, 승인', 'approve', 'I approve', '承認', '承認して']) assert.equal(matchCommand(text), 'approve', text)
  for (const text of ['좋아', '승인이 뭐야', '승인 기준 알려줘']) assert.notEqual(matchCommand(text), 'approve', text)
  for (const text of ['승인 안 해', '승인하지 마', "don't approve", '承認しない']) assert.notEqual(matchCommand(text), 'approve', text)
  assert.equal(matchCommand('잠깐'), 'pause')
  assert.equal(matchCommand('멈춰'), 'pause')
  assert.equal(matchCommand('계속해'), 'resume')
  assert.equal(matchCommand('다시 말해줘'), 'repeat')
  assert.equal(matchCommand('지금 어디야?'), 'status')
  assert.equal(matchCommand('where are we'), 'status')
  assert.equal(matchCommand('롤백해'), 'rollback')
  assert.equal(matchCommand('장애 넣어 봐'), 'inject')
  assert.equal(matchCommand('다시 시도해'), 'retry')
  assert.equal(matchCommand('계획 수정해'), 'revise')
  assert.equal(matchCommand('확인'), null, '되묻는 중이 아니면 확인은 명령이 아니다')
  assert.equal(matchCommand('확인', { confirming: true }), 'confirm')
  assert.equal(matchCommand('네', { confirming: true }), 'confirm')
  assert.equal(matchCommand('아니, 취소', { confirming: true }), 'deny')
  assert.equal(matchCommand('뭐가 문제야?'), null, '질문은 명령이 아니다')
  assert.equal(matchCommand('지금 무슨 단계야?'), null, '에이전트 질문(무슨 단계)은 명령이 아니다')
})

test('화면 아래 안내: 화면이 받을 수 있는 동작만', () => {
  const ko = (keys: ReturnType<typeof hintKeys>) => keys.map(key => voiceText('ko', key))
  assert.deepEqual(ko(hintKeys('analysis', new Set())), ['지금 어디야', '다시 말해줘', '잠깐'])
  assert.deepEqual(ko(hintKeys('analysis', new Set(['next']))), ['다음', '지금 어디야', '다시 말해줘', '잠깐'])
  assert.deepEqual(ko(hintKeys('traffic', new Set(['rollback', 'inject']), { paused: true })), ['롤백해', '장애 넣어 봐', '지금 어디야', '다시 말해줘', '계속해'])
  assert.deepEqual(ko(hintKeys('approval', new Set(['approve']), { confirming: true })), ['확인', '취소해'])
  assert.deepEqual(ko(hintKeys('setup', new Set())), ['시작하자', '지금 어디야', '다시 말해줘', '잠깐'])
})

test('지금 어디야: 단계 + 숫자 하나', () => {
  const tables = (['copied', 'matched', 'copying'] as const).map((state, index) => ({ name: 't' + index, rows_copied: 1, rows_total: 2, state }))
  const state = { ...initialState, data: { ...initialState.data, tables } }
  assert.deepEqual(statusLine('data', state).map(part => voiceText('ko', part.key, part.params)), ['지금 데이터 이전.', '테이블 3개 중 2개.'])
  assert.deepEqual(statusLine('planning', initialState).map(part => voiceText('en', part.key, part.params)), ['Now: planning.'])
})

test('TTS: 요청 검증·캐시 키·전처리', () => {
  assert.equal(parseTtsRequest({ text: '  ' }), null)
  assert.equal(parseTtsRequest({ text: 'x'.repeat(401) }), null)
  assert.deepEqual(parseTtsRequest({ text: '안녕  하세요', lang: 'xx', voice: 'Z9' }), { text: '안녕 하세요', lang: 'ko', voice: 'M1' })
  const a = cacheKey({ text: '네.', lang: 'ko', voice: 'M1' })
  assert.equal(a, cacheKey({ text: '네.', lang: 'ko', voice: 'M1' }))
  assert.notEqual(a, cacheKey({ text: '네.', lang: 'ko', voice: 'F1' }))
  assert.notEqual(a, cacheKey({ text: '네.', lang: 'ja', voice: 'M1' }))
  assert.equal(preprocess('AWS → GCP', 'ko').normalize('NFC'), '<ko>AWS GCP.</ko>')
  assert.deepEqual(chunkText('하나. 둘.', 'ko'), ['하나. 둘.'])
  assert.equal(chunkText('가'.repeat(100) + '. ' + '나'.repeat(100) + '.', 'ko').length, 2)
})

test('보고(백엔드 순서): 데이터 다음은 DB 전환, 트래픽 다음은 완료 리포트(실제·목업 같다)', () => {
  const engine = new ReportEngine()
  const plan = ev({ type: 'cutover.plan', phase: 'verification', status: 'waiting', data: {} } as never)
  engine.fromEvent(plan, 'data', 0)
  const ready = ev({ type: 'data.readiness', phase: 'data_copy', status: 'running', data: { ready: true } } as never)
  assert.deepEqual(engine.fromEvent(ready, 'data', 0).map(report => renderReport(report, 'ko')), ['복제 지연 0. DB 전환으로 갈까요?'])
  const complete = ev({ type: 'traffic.snapshot', phase: 'traffic', status: 'running', data: { phase: 'complete', step: 100, gate: {}, results: [] } } as never)
  assert.deepEqual(engine.fromEvent(complete, 'traffic', 0).map(report => renderReport(report, 'ko')), ['트래픽 이전 완료. 완료 리포트로 갈까요?'])
  assert.deepEqual(new ReportEngine().fromEvent(complete, 'traffic', 0).map(report => renderReport(report, 'en')), ['Traffic migration complete. Go to the completion report?'], '전환 계획을 받지 않은 엔진도 같은 순서')
})
