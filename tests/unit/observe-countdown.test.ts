import assert from 'node:assert/strict'
import { test } from 'node:test'
import { observeLeftNow } from '../../src/lib/migration/observeCountdown.ts'

test('남은 관찰 시간은 상태를 받은 뒤 흐른 만큼 줄어든다', () => {
  assert.equal(observeLeftNow(10, 0), 10)
  assert.equal(observeLeftNow(10, 2500), 7.5)
  assert.equal(observeLeftNow(20, 19000), 1)
})

test('0 아래로 내려가지 않고, 시계가 거꾸로 가도 늘지 않는다', () => {
  assert.equal(observeLeftNow(10, 12000), 0)
  assert.equal(observeLeftNow(10, -500), 10)
})
