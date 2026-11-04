import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkDigests } from '../../src/lib/migration/digest.ts'
import { shortDigest, startRequestFor, targetOfRequest } from '../../src/lib/migration/events.ts'

test('이미지 Digest 대조: 같으면 match, 하나라도 다르면 mismatch, 비교할 값이 모자라면 unknown', () => {
  assert.equal(checkDigests({ built: 'sha256:a', verified: 'sha256:a', deploy: 'sha256:a' }).status, 'match')
  assert.equal(checkDigests({ built: 'sha256:a', verified: 'sha256:b', deploy: 'sha256:a' }).status, 'mismatch')
  assert.equal(checkDigests({ built: 'sha256:a' }).status, 'unknown')
  assert.equal(checkDigests({}).status, 'unknown')
})

test('Digest는 sha256: 뒤 12자리로 줄인다', () => {
  assert.equal(shortDigest('sha256:9f2c4a7e1b3d58a06c'), '9f2c4a7e1b3d')
  assert.equal(shortDigest(null), '')
})

test('시작 요청: provider·profile은 대상에서 정하고 리전/Agent ID는 대상에 맞는 것만 담는다', () => {
  assert.deepEqual(startRequestFor('aws'), { target: { provider: 'AWS', profile: 'aws-ec2-basic', region: 'ap-northeast-2' } })
  assert.deepEqual(startRequestFor('gcp', { region: 'us-central1', envFileRef: 'local:.env' }), { target: { provider: 'GCP', profile: 'gcp-vm-basic', region: 'us-central1' }, env_file_ref: 'local:.env' })
  assert.deepEqual(startRequestFor('onprem', { agentId: 'agent-1', region: 'ignored' }), { target: { provider: 'ON_PREM', profile: 'onprem-k3s-basic', agent_id: 'agent-1' } })
})

test('시작 요청에서 대상 읽기: 새 형식과 예전 형식 모두', () => {
  assert.equal(targetOfRequest(startRequestFor('aws')), 'aws')
  assert.equal(targetOfRequest(startRequestFor('onprem')), 'onprem')
  assert.equal(targetOfRequest({ target: 'gcp' }), 'gcp')
  assert.equal(targetOfRequest({}), 'gcp')
})
