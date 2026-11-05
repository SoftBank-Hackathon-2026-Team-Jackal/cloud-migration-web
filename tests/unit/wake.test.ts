import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isQuestionLine, parseWake } from '../../src/lib/voice/wake.ts'

test('호출어만 말하면 woke이고 뒷말은 비어 있다', () => {
  assert.deepEqual(parseWake('헤이 자칼'), { woke: true, rest: '' })
  assert.deepEqual(parseWake('헤이자칼.'), { woke: true, rest: '' })
  assert.deepEqual(parseWake('Hey Jackal'), { woke: true, rest: '' })
  assert.deepEqual(parseWake('ヘイ ジャッカル'), { woke: true, rest: '' })
})

test('호출어 뒤의 말은 rest로 나뉜다(ko·en·ja)', () => {
  assert.deepEqual(parseWake('헤이 자칼, 다음 넘어가자'), { woke: true, rest: '다음 넘어가자' })
  assert.deepEqual(parseWake('헤이 재칼 지금 문제 있어?'), { woke: true, rest: '지금 문제 있어?' })
  assert.deepEqual(parseWake('hey jackal, go to the next step'), { woke: true, rest: 'go to the next step' })
  assert.deepEqual(parseWake('ヘイ ジャッカル、次へ'), { woke: true, rest: '次へ' })
})

test('인식이 잘못 붙인 앞말이 있어도 호출어를 찾는다', () => {
  assert.equal(parseWake('네 헤이 자칼 승인해').rest, '승인해')
})

test('호출어가 없으면 woke이 아니다', () => {
  assert.deepEqual(parseWake('다음 넘어가자'), { woke: false, rest: '다음 넘어가자' })
  assert.deepEqual(parseWake(''), { woke: false, rest: '' })
  assert.equal(parseWake('자칼이 뭐야').woke, false)
})

test('자칼이 되묻거나 시키는 말은 질문으로 본다', () => {
  assert.equal(isQuestionLine('데이터 이전으로 갈까요?'), true)
  assert.equal(isQuestionLine("진행하려면 '승인'이라고 해 주세요."), true)
  assert.equal(isQuestionLine('원본으로 되돌릴까요'), true)
  assert.equal(isQuestionLine('Shall we move on to data migration?'), true)
  assert.equal(isQuestionLine('データ移行に進みますか？'), true)
  assert.equal(isQuestionLine("Say 'approve' to continue."), true)
})

test('보고 문장은 질문이 아니다', () => {
  assert.equal(isQuestionLine('원본 분석을 시작합니다.'), false)
  assert.equal(isQuestionLine('체크섬 일치. 검증 완료.'), false)
  assert.equal(isQuestionLine('Replication caught up.'), false)
  assert.equal(isQuestionLine(''), false)
})
