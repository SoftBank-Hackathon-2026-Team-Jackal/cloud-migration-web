/**
 * 되묻는 확인(롤백할까요?)과 묻는 말: 질문이 확인·롤백으로 잡히지 않고, 알림이 세운 롤백 확인은 회복·완료·다른 질문에 거둔다.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isQuestionUtterance, matchCommand } from '../../src/lib/voice/commands.ts'
import { ALERT_CONFIRM_MS, pendingOnEvent, pendingOnReport, type Pending } from '../../src/lib/voice/pending.ts'
import type { DraftEvent, MigrationEvent, TrafficHealthJudgement, TrafficPhase } from '../../src/lib/migration/events.ts'

let seq = 0
const ev = (draft: DraftEvent): MigrationEvent => ({ ...draft, seq: ++seq, at: '2026-11-07T07:00:00.000Z' }) as MigrationEvent
const health: TrafficHealthJudgement = { requests: 120, failed: 0, error_rate: 0, p99_ms: 40, baseline_p99_ms: 30, p99_limit_ms: 45, alert_error_rate: 0.05, judged: true, breach: [] }
const alert = (state: 'breach' | 'recovered') => ev({ type: 'traffic.alert', phase: 'traffic', status: 'running', data: { ...health, state, phase: 'stabilizing' } })
const snap = (phase: TrafficPhase) => ev({ type: 'traffic.snapshot', phase: 'traffic', status: 'running', data: {
  phase, weights: { origin: 0, target: 100 }, step: 100,
  gate: { failed_requests: 0, max_failed_requests: 0, p99_ratio: 1, max_p99_ratio: 1.5, observe_left_seconds: 0 },
  residual: { requests_per_sec: 0, streams: 0 },
} })

test('되묻는 중: 질문·긴 말은 확인이 아니다(에이전트로 넘긴다)', () => {
  for (const text of ['네트워크 문제야?', '예상 원인은?', '원인 확인해줘', '왜 그래?', 'Yesterday?', '네, 근데 원인이 뭐야?', '그래서 지금 어때?', 'yes, but why?']) {
    assert.notEqual(matchCommand(text, { confirming: true }), 'confirm', text)
  }
  for (const text of ['네트워크 문제야?', '예상 원인은?', '원인 확인해줘', '왜 그래?', 'Yesterday?']) assert.equal(matchCommand(text, { confirming: true }), null, text)
})

test('되묻는 중: 짧은 긍정만 확인이다(세 언어)', () => {
  for (const text of ['응', '네', '예', '그래', '좋아', '확인', '확인.', '롤백해', '롤백해줘', '해줘', '응, 롤백해', '네 확인', '헤이 자칼, 확인', 'yes', 'Yes.', 'ok', 'yeah', 'sure', 'do it', 'はい', 'うん', '確認']) {
    assert.equal(matchCommand(text, { confirming: true }), 'confirm', text)
  }
  for (const text of ['아니', '아니, 취소', '취소해', 'no', 'cancel', 'いいえ']) assert.equal(matchCommand(text, { confirming: true }), 'deny', text)
  assert.equal(matchCommand('지금 어디야?', { confirming: true }), 'status', '되묻는 중에도 상태 질문은 그대로')
})

test('롤백을 묻는 말은 명령이 아니라 질문이다, 명령형은 그대로 명령', () => {
  for (const text of ['지금 롤백할까?', '지금 롤백할까', '롤백해야 해?', '롤백해도 돼', '롤백 왜 해?', 'should we roll back?', 'should we roll back', 'is it time to roll back', 'ロールバックしますか', '승인할까?', '장애 넣을까?']) {
    assert.equal(isQuestionUtterance(text), true, text)
    assert.equal(matchCommand(text), null, text)
    assert.notEqual(matchCommand(text, { confirming: true }), 'confirm', text)
  }
  for (const text of ['롤백해', '롤백해줘', '되돌려', '원래대로 돌려', 'roll back', 'roll it back', 'ロールバックして', '헤이 자칼, 롤백해']) {
    assert.equal(isQuestionUtterance(text), false, text)
    assert.equal(matchCommand(text), 'rollback', text)
  }
})

test('알림이 세운 롤백 확인: 안정화 구간에서만 세우고, 회복·완료·다른 질문에 거둔다', () => {
  const asks = (key: string, asks = false) => ({ key, asks })
  const armed = pendingOnReport(null, asks('r.traffic.alertError', true), 1000, 'stabilizing')
  assert.deepEqual(armed, { command: 'rollback', until: 1000 + ALERT_CONFIRM_MS, alert: true })
  assert.equal(pendingOnReport(null, asks('r.traffic.alertP99', true), 1000, 'complete'), null, '안정화가 끝난 뒤 늦게 말한 알림은 확인을 세우지 않는다')

  for (const key of ['r.traffic.recovered', 'r.traffic.done', 'r.traffic.rollbackManual', 'r.migration.done']) assert.equal(pendingOnReport(armed, asks(key), 2000, 'stabilizing'), null, key)
  assert.equal(pendingOnReport(armed, asks('r.cutover.ask', true), 2000, 'stabilizing'), null, '다른 질문이 앞의 롤백 확인을 대신한다')
  assert.equal(pendingOnReport(armed, asks('r.traffic.stabilizing'), 2000, 'stabilizing'), armed, '상관없는 보고는 그대로')

  // 사람이 말로 시작한 롤백 확인("롤백해" → "확인할까요?")은 알림이 아니므로 다른 질문에 거두지 않는다.
  const manual: Pending = { command: 'rollback', until: 5000 }
  assert.equal(pendingOnReport(manual, asks('r.data.lagZero', true), 2000, 'observing'), manual)
})

test('알림이 세운 롤백 확인: 회복 이벤트·안정화 구간을 벗어난 스냅숏에 거둔다', () => {
  const armed: Pending = { command: 'rollback', until: 9000, alert: true }
  assert.equal(pendingOnEvent(armed, alert('recovered')), null)
  assert.equal(pendingOnEvent(armed, alert('breach')), armed)
  assert.equal(pendingOnEvent(armed, snap('stabilizing')), armed)
  for (const phase of ['complete', 'rolledback'] as const) assert.equal(pendingOnEvent(armed, snap(phase)), null, phase)
  const manual: Pending = { command: 'inject', until: 9000 }
  assert.equal(pendingOnEvent(manual, snap('complete')), manual, '알림이 아닌 확인은 이벤트로 거두지 않는다')
})
