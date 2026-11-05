import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VOICE_MESSAGES, voiceText, type VoiceKey } from '../../src/lib/voice/messages.ts'
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

test('보고 문구: 한국어 보고는 명사형으로 짧게(존댓말 어미 없음, 변수 채운 뒤 30자 이하)', () => {
  for (const [key, text] of Object.entries(VOICE_MESSAGES.ko)) {
    if (!key.startsWith('r.')) continue
    const filled = text.replace(/\{\w+\}/g, '12')
    assert.ok(filled.length <= 30, `${key}: ${filled}`)
    assert.ok(!/(어요|에요|예요|했어|습니다|세요)\.?$/.test(filled), `${key}: 존댓말 어미 — ${filled}`)
  }
  assert.equal(voiceText('ko', 'r.sandbox.attemptFail', { attempt: 1, cls: 'cls.CODE' }), '1차 시도 실패. 코드 문제 수정 중')
  assert.equal(voiceText('en', 'r.error', { phase: 'phase.data_copy', code: 'X' }), 'Data error. X')
})

test('엔진: 발견은 합치고 진행은 25/50/75에서만, 완료는 한 번만', () => {
  const engine = new ReportEngine()
  const queue = new ReportQueue()
  const reports: Report[] = []
  for (const [stream, p] of [['infrastructure', 10], ['infrastructure', 20], ['code', 30], ['infrastructure', 55], ['infrastructure', 60]] as const) {
    for (const report of engine.fromEvent(finding(stream, p), 'analysis', 0)) { reports.push(report); queue.push(report) }
  }
  const progress = reports.filter(report => report.key === 'r.analysis.progress').map(report => report.params.p)
  assert.deepEqual(progress, [25, 50])
  // 합치기: 리소스 4개가 한 보고로
  const infra = queue.peek().find(report => report.series === 'found:infrastructure')!
  assert.equal(renderReport(infra, 'ko'), '리소스 4개 추가 발견')
  const done = ev({ type: 'analysis.done', phase: 'analysis', status: 'done', progress: 100, data: {} })
  const complete = engine.fromEvent(done, 'analysis', 0)
  assert.equal(renderReport(complete[0], 'ko'), '분석 완료. 리소스 4개, 코드 1건')
  assert.equal(engine.fromEvent(done, 'analysis', 0).length, 0)
  // 완료가 오면 밀린 진행·발견은 버린다.
  queue.push(complete[0])
  assert.deepEqual(queue.peek().map(report => report.key), ['r.analysis.done'])
})

test('엔진: 화면 단계와 다른 phase의 이벤트는 실패만 말한다', () => {
  const engine = new ReportEngine()
  const ready = ev({ type: 'plan.ready', phase: 'planning', status: 'done', data: { revision: 1 } })
  assert.equal(engine.fromEvent(ready, 'approval', 0).length, 0)
  const error = ev({ type: 'error', phase: 'data_copy', status: 'failed', data: { code: 'LAG', message: '', phase: 'data_copy', retryable: true } })
  assert.equal(renderReport(engine.fromEvent(error, 'approval', 0)[0], 'ko'), '데이터 오류. LAG')
})

test('엔진: 샌드박스 실패 분류 → 통과, 승인 사실, 트래픽 단계·롤백', () => {
  const engine = new ReportEngine()
  const checks = { required_passed: 12, required_total: 12, unsupported_calls: 0, calls_in_mapping: 3, calls_total: 3, blocked_egress: 0 }
  const fail = ev({ type: 'sandbox.attempt', phase: 'build', status: 'running', data: { run: 1, attempt: 1, max_attempts: 3, verdict: { passed: false, reasons: [] }, failure_class: 'CODE', checks, fix_ids: [] } })
  const [failure] = engine.fromEvent(fail, 'rehearsal', 0)
  assert.equal(failure.kind, 'failure')
  assert.equal(renderReport(failure, 'ja'), '1回目失敗。コードの問題を修正中')
  engine.fromEvent(ev({ type: 'sandbox.attempt', phase: 'build', status: 'running', data: { run: 2, attempt: 2, max_attempts: 3, verdict: { passed: true, reasons: [] }, failure_class: null, checks, fix_ids: [] } }), 'rehearsal', 0)
  const [passed] = engine.fromEvent(ev({ type: 'sandbox.done', phase: 'build', status: 'running', data: { status: 'PASSED', cleanup_status: 'PENDING', digest: null } }), 'rehearsal', 0)
  assert.equal(renderReport(passed, 'ko'), '샌드박스 검증 통과. 2차 시도')

  engine.fromEvent(ev({ type: 'plan.step', phase: 'planning', status: 'running', data: { id: 'a', group: 'infrastructure', grade: 'DIRECT', before: '', after: '', evidence: '', change: '', action: 'PROCEED', keep_source: false, verification: 'UNVERIFIED' } }), 'planning', 0)
  engine.fromEvent(ev({ type: 'plan.step', phase: 'planning', status: 'running', data: { id: 'b', group: 'infrastructure', grade: 'NONE', before: '', after: '', evidence: '', change: '', action: 'APPROVAL', keep_source: true, verification: 'UNVERIFIED' } }), 'planning', 0)
  const required = engine.fromEvent(ev({ type: 'approval.required', phase: 'awaiting_approval', status: 'waiting', data: { excluded: [], rollback_policy: '' } }), 'approval', 0)
  assert.deepEqual(required.map(report => renderReport(report, 'ko')), ['변경 1건, 테스트 12/12 통과, 롤백 가능', "승인하려면 '승인해'"])
  assert.ok(required.every(report => report.kind === 'decision'))

  const snap = (phase: string, step: number, results: Array<{ step: number; verdict: 'pass' | 'rollback' }> = []) => ev({ type: 'traffic.snapshot', phase: 'traffic', status: 'running', data: {
    phase: phase as 'applying', weights: { origin: 100 - step, target: step }, step, gate: { failed_requests: 0, max_failed_requests: 5, p99_ratio: 1, max_p99_ratio: 1.5, observe_left_seconds: 0 },
    residual: { requests_per_sec: 0, streams: 0 }, results: results.map(result => ({ ...result, failed_requests: 0, p99_ratio: 1 })) } })
  const said = (event: MigrationEvent) => engine.fromEvent(event, 'traffic', 0).map(report => renderReport(report, 'ko'))
  assert.deepEqual(said(snap('applying', 10)), ['트래픽 10퍼센트 전달'])
  assert.deepEqual(said(snap('observing', 10)), [])
  assert.deepEqual(said(snap('applying', 50, [{ step: 10, verdict: 'pass' }])), ['10퍼센트 게이트 통과', '트래픽 50퍼센트 전달'])
  assert.deepEqual(said(snap('rolledback', 0)), ['게이트 실패. 롤백 완료'])
  assert.deepEqual(said(snap('rolledback', 0)), [])
})

test('DB 전환 사실: 쓰기 중단 초', () => {
  assert.equal(renderReport(cutoverFactReports(1800, 0)[0], 'ko'), 'DB 전환 중 쓰기 약 1.8초 중단')
  assert.equal(renderReport(cutoverFactReports(null, 0)[0], 'en'), 'Writes pause briefly during DB switch')
  assert.equal(renderReport(approvalFactReports({ changes: 3, passed: null, total: null }, 0)[0], 'ko'), '변경 3건, 롤백 가능')
})

test('큐: 실패·결정 먼저, 최소 간격, 오래된 진행 버림, 잠깐 멈춤', () => {
  const queue = new ReportQueue({ gapMs: 3500, restMs: 1000, staleMs: 9000 })
  const make = (key: Report['key'], kind: Report['kind'], at: number, series?: string): Report => ({ key, params: { p: at }, kind, phase: 'data_copy', at, series })
  queue.push(make('r.data.copy', 'milestone', 0, 'progress:data_copy'))
  queue.push(make('r.data.preflightFail', 'failure', 0))
  assert.equal(queue.size, 1, '실패가 오면 같은 단계의 진행은 버린다')
  assert.equal(queue.next(0, true), null, '말하는 중에는 기다린다')
  assert.equal(queue.next(500, false)?.key, 'r.data.preflightFail')
  // 진행은 같은 series면 새 값으로 바뀐다(낡은 진행은 말하지 않는다).
  queue.push(make('r.data.copy', 'milestone', 600, 'progress:data_copy'))
  queue.push(make('r.data.copy', 'milestone', 700, 'progress:data_copy'))
  assert.equal(queue.size, 1)
  assert.equal(queue.next(1000, false), null, '간격(3.5초) 전에는 말하지 않는다')
  assert.equal(queue.next(4100, false)?.params.p, 700)
  // 오래된 진행은 버린다.
  queue.push(make('r.data.copy', 'milestone', 5000, 'progress:data_copy'))
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
  for (const text of ['승인해', '승인할게', '헤이 자칼, 승인합니다', 'approve', 'I approve', '承認して']) assert.equal(matchCommand(text), 'approve', text)
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
  const state = { ...initialState, data: { ...initialState.data, current: { step: 'dump' as const, rows: 1, total_rows: 2, lag_ms: null, writes_per_sec: 0, dump_percent: 42.4 } } }
  assert.deepEqual(statusLine('data', state).map(part => voiceText('ko', part.key, part.params)), ['현재 데이터 이전 단계', '데이터 복사 42퍼센트'])
  assert.deepEqual(statusLine('planning', initialState).map(part => voiceText('en', part.key, part.params)), ['Now in planning'])
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
