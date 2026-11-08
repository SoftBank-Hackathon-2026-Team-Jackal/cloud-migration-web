import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startRequestFor } from '../../src/lib/migration/events.ts'

test('레드팀 캐시: 기본(켜짐)은 시작 요청에 싣지 않는다(백엔드가 필드를 받기 전에도 요청이 같다)', () => {
  assert.equal('redteam_cache_enabled' in startRequestFor('gcp'), false)
  assert.equal('redteam_cache_enabled' in startRequestFor('onprem', { redteamCache: true }), false)
})

test('레드팀 캐시: 끄면 redteam_cache_enabled:false를 싣고 나머지 요청은 그대로다', () => {
  const base = startRequestFor('onprem', { agentId: 'agent-1', scopeId: 'scope-1' })
  const off = startRequestFor('onprem', { agentId: 'agent-1', scopeId: 'scope-1', redteamCache: false })
  assert.equal(off.redteam_cache_enabled, false)
  const { redteam_cache_enabled: _ignored, ...rest } = off
  assert.deepEqual(rest, base)
})
