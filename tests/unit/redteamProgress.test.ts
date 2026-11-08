import assert from 'node:assert/strict'
import { test } from 'node:test'
import { redteamProgress } from '../../src/lib/migration/redteamView.ts'
import type { RedTeamFinding } from '../../src/lib/migration/events.ts'

const finding = (id: string, state: RedTeamFinding['state']): RedTeamFinding => ({
  id, category: 'AUTH', severity: 'HIGH', endpoint: 'GET /x', summary: 's', repro_summary: 'r', state,
})

test('약점 수는 findings 개수 그대로다: 1개든 4개든 달라진다', () => {
  const one = redteamProgress({ findings: [finding('a', 'OPEN')], round: 0, max_rounds: 3 })
  const four = redteamProgress({ findings: ['a', 'b', 'c', 'd'].map(id => finding(id, 'OPEN')), round: 0, max_rounds: 3 })
  assert.equal(one.found, 1)
  assert.equal(four.found, 4)
})

test('고친 수는 FIXED만 센다(STILL_OPEN·OPEN은 아니다)', () => {
  const data = { findings: [finding('a', 'FIXED'), finding('b', 'STILL_OPEN'), finding('c', 'OPEN'), finding('d', 'FIXED')], round: 2, max_rounds: 3 }
  assert.equal(redteamProgress(data).fixed, 2)
})

test('백엔드의 첫 FIXING 이벤트(round 0)도 수정 중이므로 1/3으로 센다', () => {
  const p = redteamProgress({ findings: [finding('a', 'OPEN')], round: 0, max_rounds: 3 })
  assert.deepEqual([p.n, p.max], [1, 3])
})

test('회차는 상한을 넘기지 않고, 약점이 없으면 모두 0이다', () => {
  assert.equal(redteamProgress({ findings: [], round: 9, max_rounds: 3 }).n, 3)
  const none = redteamProgress({ findings: [], round: 0, max_rounds: 3 })
  assert.deepEqual([none.found, none.fixed], [0, 0])
})
