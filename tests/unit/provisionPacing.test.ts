import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextRevealDelay, stagedProgress, stagedResources, REVEAL_FIRST_MS, REVEAL_GAP_MS } from '../../src/lib/migration/provisionPacing.ts'

const items = (states: Array<'running' | 'done' | 'failed'>) => states.map((state, index) => ({ id: 'r' + index, state }))

test('보이는 것은 revealed 개까지만', () => {
  assert.equal(stagedResources(items(['running', 'running', 'running', 'running']), 2, new Set()).length, 2)
  assert.equal(stagedResources(items(['running']), 0, new Set()).length, 0)
})

test('앞 블록이 완성되기 전에는 뒤 블록의 done을 running으로 보인다', () => {
  const all = items(['done', 'done', 'done'])
  assert.deepEqual(stagedResources(all, 3, new Set()).map(item => item.state), ['done', 'running', 'running'])
  assert.deepEqual(stagedResources(all, 3, new Set(['r0'])).map(item => item.state), ['done', 'done', 'running'])
  assert.deepEqual(stagedResources(all, 3, new Set(['r0', 'r1'])).map(item => item.state), ['done', 'done', 'done'])
})

test('실패는 그대로 보이고 뒤 블록을 막지 않는다', () => {
  assert.deepEqual(stagedResources(items(['failed', 'done']), 2, new Set()).map(item => item.state), ['failed', 'done'])
})

test('등장 간격', () => {
  assert.equal(nextRevealDelay(0, 4), REVEAL_FIRST_MS)
  assert.equal(nextRevealDelay(1, 4), REVEAL_GAP_MS)
  assert.equal(nextRevealDelay(4, 4), null)
})

test('진행률은 완성된 블록 수로 센다', () => {
  const all = items(['done', 'done', 'done', 'done'])
  assert.equal(stagedProgress(all, new Set()), 0)
  assert.equal(stagedProgress(all, new Set(['r0', 'r1'])), 50)
  assert.equal(stagedProgress(all, new Set(['r0', 'r1', 'r2', 'r3'])), 100)
  assert.equal(stagedProgress([], new Set()), 0)
})
