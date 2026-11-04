import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reducer, type MigrationState } from '../../src/lib/migration/reducer.ts'
import type { DraftEvent, MigrationEvent } from '../../src/lib/migration/events.ts'
import { buildAgentFacts, factsToText } from '../../src/lib/agent/context.ts'
import { answerLocally, intentOf } from '../../src/lib/agent/mock.ts'

let seq = 0
const ev = (draft: DraftEvent): MigrationEvent => { seq += 1; return { ...draft, seq, at: '2026-01-01T00:00:00.000Z' } as MigrationEvent }
const run = (state: MigrationState, ...events: MigrationEvent[]) => events.reduce((current, event) => reducer(current, { type: 'event', event }), state)

test('질문 뜻 가리기: 문제·기록·다음·단계', () => {
  assert.equal(intentOf('뭐가 문제야?'), 'problem')
  assert.equal(intentOf('로그 읊어줘'), 'log')
  assert.equal(intentOf('다음에 뭐 해야 돼?'), 'next')
  assert.equal(intentOf('지금 무슨 단계야?'), 'stage')
  assert.equal(intentOf('what is the problem?'), 'problem')
  assert.equal(intentOf('今どの段階？'), 'stage')
})

test('상태 요약: 사람 검토 대기·이미지 불일치·허용을 넘은 실패가 문제로 잡힌다', () => {
  seq = 0
  const state = run(initialState,
    ev({ type: 'build.result', phase: 'build', status: 'running', data: { attempt: 3, max_attempts: 3, status: 'FAILED', digest: null, image_uri: null, reused: false, error_code: 'BUILD_FAILED' } }),
    ev({ type: 'build.review', phase: 'build', status: 'waiting', data: { reason: 'max_attempts', attempts: 3 } }),
    ev({ type: 'plan.ready', phase: 'planning', status: 'done', data: { plan_id: 'p', revision: 2, built_digest: 'sha256:a', verified_digest: 'sha256:b' } }))
  const facts = buildAgentFacts(state, 'rehearsal', '샌드박스')
  assert.equal(facts.sandbox.reviewWaiting, true)
  assert.equal(facts.sandbox.errorCode, 'BUILD_FAILED')
  assert.equal(facts.plan.digestMismatch, true)
  const text = factsToText(facts)
  assert.ok(text.includes('화면 단계: 샌드박스 (rehearsal)'))
  assert.ok(text.includes('사람 검토 대기 중'))
  assert.ok(text.includes('Digest 불일치'))
  const answer = answerLocally('뭐가 문제야?', facts, 'ko')
  assert.ok(answer.includes('사람 검토') && answer.includes('Digest'), answer)
  assert.ok(answerLocally('what is the problem?', facts, 'en').includes('human review'))
  assert.ok(answerLocally('問題は？', facts, 'ja').includes('人の確認'))
})

test('상태 요약: 문제가 없으면 없다고 답하고, 단계와 기록을 읽어 준다', () => {
  seq = 0
  const state = run(initialState,
    ev({ type: 'provision.resource', phase: 'provisioning', status: 'running', data: { id: 'r1', key: 'cluster', state: 'done', progress: 100 } }),
    ev({ type: 'provision.check', phase: 'provisioning', status: 'running', data: { name: 'pods_ready', state: 'done' } }))
  const facts = buildAgentFacts(state, 'provisioning', '프로비저닝')
  assert.ok(answerLocally('지금 무슨 단계야?', facts, 'ko').includes('프로비저닝'))
  assert.ok(answerLocally('지금 무슨 단계야?', facts, 'ko').includes('리소스 1/1'))
  assert.ok(answerLocally('뭐가 문제야?', facts, 'ko').includes('문제는 없어요'))
  const log = answerLocally('로그 읊어줘', facts, 'ko')
  assert.ok(log.includes('리소스 cluster done') && log.includes('준비 검사 pods_ready'), log)
  assert.ok(answerLocally('로그', buildAgentFacts(initialState, 'analysis', '분석'), 'ko').includes('기록이 없어요'))
})

test('상태 요약에는 비밀값이 없다(상태에 없는 필드만 쓴다)', () => {
  const facts = buildAgentFacts(initialState, 'analysis', '분석')
  const text = JSON.stringify(facts) + factsToText(facts)
  assert.ok(!/secret|password|api[_-]?key|access[_-]?key|token/i.test(text))
})
