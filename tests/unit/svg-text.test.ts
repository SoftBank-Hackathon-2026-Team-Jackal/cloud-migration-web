/** SVG 구성도 글자 줄이기: 한글 폭 반영, 끝(포트) 보존, 중복 포트 방지. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitSize, fitText, textUnits, withPort } from '../../src/lib/svgText.ts'

test('한글은 영문보다 넓게 센다', () => {
  assert.equal(textUnits('abc'), 3)
  assert.equal(textUnits('가나'), 3.6)
})

test('칸 안이면 그대로, 넘으면 줄이고 끝을 남긴다', () => {
  assert.equal(fitText('chat-db-0', 22), 'chat-db-0')
  const cut = fitText('peer-db-0123456789abcdef.cmp-dm-poc.svc.cluster.local:5432', 30, 5)
  assert.ok(textUnits(cut) <= 30, cut)
  assert.ok(cut.endsWith(':5432'), cut)
  assert.ok(cut.includes('…'), cut)
})

test('한글 문구도 폭 기준으로 줄인다(글자 수 기준이면 넘친다)', () => {
  const text = '외부 공개 없음; 클러스터 내부 Service만'
  assert.ok(textUnits(text) > 32)
  const cut = fitText(text, 32)
  assert.ok(textUnits(cut) <= 32, cut)
  assert.ok(cut.endsWith('…'), cut)
})

test('글자 크기는 상자 폭과 범위 안에서 정해진다', () => {
  assert.equal(fitSize('abc', 1000, 20, 10), 20)
  assert.equal(fitSize('a'.repeat(100), 100, 20, 10), 10)
  const size = fitSize('chat-source/chat-db-0', 150, 30, 9)
  assert.ok(size < 30 && size >= 9)
})

test('주소에 포트가 있으면 다시 붙이지 않는다', () => {
  assert.equal(withPort('10.0.0.5', 5432), '10.0.0.5:5432')
  assert.equal(withPort('peer-db:5432', '5432'), 'peer-db:5432')
})
