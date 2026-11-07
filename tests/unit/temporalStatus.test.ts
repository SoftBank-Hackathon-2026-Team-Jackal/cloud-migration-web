import { test } from 'node:test'
import assert from 'node:assert/strict'
import { temporalStatusOf } from '../../src/lib/temporalStatus.ts'

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
