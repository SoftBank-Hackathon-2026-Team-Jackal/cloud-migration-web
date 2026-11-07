import { test } from 'node:test'
import assert from 'node:assert/strict'
import { temporalStatusOf } from '../../src/lib/temporalStatus.ts'
import { isTemporalReadOnlyRequest, temporalUiUrl } from '../../src/lib/temporalUi.ts'

test('Temporal 사이드바 상태: 실행 중이 하나라도 있으면 running', () => {
  assert.equal(temporalStatusOf([{ status: 'COMPLETED' }, { status: 'RUNNING' }]), 'running')
  // 실행 중이면 이미 실패한 자식이 있어도 아이콘은 계속 돈다
  assert.equal(temporalStatusOf([{ status: 'FAILED' }, { status: 'RUNNING' }]), 'running')
})

test('Temporal 사이드바 상태: 모두 끝나면 실패 여부로 done·failed, 워크플로가 없으면 idle', () => {
  assert.equal(temporalStatusOf([{ status: 'COMPLETED' }, { status: 'COMPLETED' }]), 'done')
  assert.equal(temporalStatusOf([{ status: 'COMPLETED' }, { status: 'TERMINATED' }]), 'failed')
  assert.equal(temporalStatusOf([{ status: 'TIMED_OUT' }]), 'failed')
  assert.equal(temporalStatusOf([]), 'idle')
})

test('Temporal UI 주소: 배포는 compose의 temporal-ui, 개발은 SSM 터널, TEMPORAL_UI_URL이 우선', () => {
  assert.equal(temporalUiUrl({ NODE_ENV: 'production' }), 'http://temporal-ui:8080')
  assert.equal(temporalUiUrl({ NODE_ENV: 'development' }), 'http://127.0.0.1:8233')
  assert.equal(temporalUiUrl({ NODE_ENV: 'production', TEMPORAL_UI_URL: 'http://x:1/' }), 'http://x:1')
})

test('Temporal UI는 읽기 전용: 조회와 워크플로 Query만 통과하고 취소·종료·Signal은 막는다', () => {
  const ns = '/api/v1/namespaces/default/workflows/migration-1'
  assert.equal(isTemporalReadOnlyRequest('GET', ns), true)
  assert.equal(isTemporalReadOnlyRequest('POST', `${ns}/query/__stack_trace`), true)
  assert.equal(isTemporalReadOnlyRequest('POST', `${ns}/cancel`), false)
  assert.equal(isTemporalReadOnlyRequest('POST', `${ns}/terminate`), false)
  assert.equal(isTemporalReadOnlyRequest('POST', `${ns}/signal/approve`), false)
  assert.equal(isTemporalReadOnlyRequest('POST', `${ns}/reset`), false)
  assert.equal(isTemporalReadOnlyRequest('DELETE', ns), false)
  assert.equal(isTemporalReadOnlyRequest('POST', '/api/v1/namespaces/default/batch-operations/x'), false)
})
