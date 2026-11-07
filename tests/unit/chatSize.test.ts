import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clampSize, dragSize, isLarge, largeSize, MIN_H, MIN_W, parseChatSize } from '../../src/lib/agent/chatSize.ts'

const view = { w: 1440, h: 900 }

test('dragging the bottom-left corner left and down grows the panel', () => {
  assert.deepEqual(dragSize({ w: 340, h: 430 }, -200, 150, view), { w: 540, h: 580 })
})

test('dragging right and up shrinks the panel down to the minimum', () => {
  assert.deepEqual(dragSize({ w: 340, h: 430 }, 500, -500, view), { w: MIN_W, h: MIN_H })
})

test('size never exceeds the viewport', () => {
  assert.deepEqual(clampSize({ w: 5000, h: 5000 }, view), { w: 1412, h: 780 })
})

test('large size is readable width and nearly full height, and toggles back', () => {
  const large = largeSize(view)
  assert.deepEqual(large, { w: 640, h: 780 })
  assert.equal(isLarge(large, view), true)
  assert.equal(isLarge({ w: 340, h: 430 }, view), false)
  assert.equal(isLarge(null, view), false)
})

test('stored size parses only well-formed numbers', () => {
  assert.deepEqual(parseChatSize('{"w":500,"h":600}'), { w: 500, h: 600 })
  assert.equal(parseChatSize('{"w":"500"}'), null)
  assert.equal(parseChatSize('nope'), null)
  assert.equal(parseChatSize(null), null)
})
