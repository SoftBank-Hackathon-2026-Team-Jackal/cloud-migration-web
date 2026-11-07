import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTypingTarget, parseListenMode, pttKeyAction, pttRoute } from '../../src/lib/voice/pushToTalk.ts'
import { ko } from '../../src/lib/i18n/ko.ts'
import { en } from '../../src/lib/i18n/en.ts'
import { ja } from '../../src/lib/i18n/ja.ts'

const down = (over: Record<string, unknown> = {}) => ({ type: 'keydown', key: ' ', code: 'Space', ...over })
const up = { type: 'keyup', key: ' ', code: 'Space' }
const ptt = { mode: 'ptt' as const, typing: false, holding: false }

test('듣기 방식: 기본은 누르고 말하기, continuous만 계속 듣기', () => {
  assert.equal(parseListenMode(null), 'ptt')
  assert.equal(parseListenMode('xyz'), 'ptt')
  assert.equal(parseListenMode('ptt'), 'ptt')
  assert.equal(parseListenMode('continuous'), 'continuous')
})

test('스페이스 누름 → press, 뗌 → release', () => {
  assert.equal(pttKeyAction(down(), ptt), 'press')
  assert.equal(pttKeyAction(up, { ...ptt, holding: true }), 'release')
  assert.equal(pttKeyAction(up, ptt), null)
})

test('반복 keydown·누르는 중 keydown·조합키·다른 키는 무시', () => {
  assert.equal(pttKeyAction(down({ repeat: true }), ptt), null)
  assert.equal(pttKeyAction(down(), { ...ptt, holding: true }), null)
  assert.equal(pttKeyAction(down({ ctrlKey: true }), ptt), null)
  assert.equal(pttKeyAction(down({ metaKey: true }), ptt), null)
  for (const key of ['l', 'i', 'o', 'g', 'd', 's', 'e', 'r', 'Enter']) assert.equal(pttKeyAction(down({ key, code: 'Key' + key.toUpperCase() }), ptt), null, key)
})

test('입력창에서는 키가 동작하지 않는다', () => {
  assert.equal(pttKeyAction(down(), { ...ptt, typing: true }), null)
  assert.equal(isTypingTarget({ tagName: 'input' }), true)
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true)
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isTypingTarget({ tagName: 'BUTTON' }), false)
  assert.equal(isTypingTarget(null), false)
})

test('계속 듣기 모드에서는 스페이스를 가로채지 않는다', () => {
  assert.equal(pttKeyAction(down(), { ...ptt, mode: 'continuous' }), null)
})

test('들은 말 보내기: 첫 화면(시작 전) → 호출 + 의도', () => {
  assert.deepEqual(pttRoute('AWS에 있는 서비스를 온프레미스로 옮기고 싶어', { ask: false, started: false }), { kind: 'wake', intent: 'AWS에 있는 서비스를 온프레미스로 옮기고 싶어' })
  assert.deepEqual(pttRoute('헤이 자칼', { ask: false, started: false }), { kind: 'wake', intent: '' })
})

test('들은 말 보내기: 첫 화면(시작 뒤) → 의도, 호출어는 뗀다', () => {
  assert.deepEqual(pttRoute('온프레미스로', { ask: false, started: true }), { kind: 'intent', text: '온프레미스로' })
  assert.deepEqual(pttRoute('  ', { ask: false, started: true }), { kind: 'none' })
})

test('들은 말 보내기: 단계 화면 → 명령/질문', () => {
  assert.deepEqual(pttRoute('다음', { ask: true, started: true }), { kind: 'command', text: '다음' })
  assert.deepEqual(pttRoute('', { ask: true, started: true }), { kind: 'none' })
})

test('새 문구는 세 언어 모두 있다', () => {
  const keys = Object.keys(ko).filter(key => key.startsWith('agent.ptt') || key.startsWith('agent.listenMode'))
  assert.ok(keys.length >= 5)
  for (const dict of [en, ja] as Record<string, string>[]) for (const key of keys) assert.ok(dict[key], key)
})
