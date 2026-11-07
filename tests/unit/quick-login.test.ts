import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quickLoginReturn, shouldQuickLogin } from '../../src/lib/github/quickLogin.ts'

test('실제 모드에서 로그인하지 않았으면 대상을 고르자마자 로그인으로 보낸다', () => {
  assert.equal(shouldQuickLogin(true, { configured: true, signed_in: false }, '13.209.240.49.sslip.io'), true)
})

test('이미 로그인했거나 로그인 앱이 없거나 목업 모드면 원래대로 말한 뒤 설정 화면으로 간다', () => {
  assert.equal(shouldQuickLogin(true, { configured: true, signed_in: true }, 'example.test'), false)
  assert.equal(shouldQuickLogin(true, { configured: false, signed_in: false }, 'example.test'), false)
  assert.equal(shouldQuickLogin(false, { configured: true, signed_in: false }, 'example.test'), false)
  assert.equal(shouldQuickLogin(true, null, 'example.test'), false)
})

test('127.0.0.1에서는 콜백 호스트 문제 때문에 바로 보내지 않는다', () => {
  assert.equal(shouldQuickLogin(true, { configured: true, signed_in: false }, '127.0.0.1'), false)
  assert.equal(shouldQuickLogin(true, { configured: true, signed_in: false }, 'localhost'), true)
})

test('로그인 뒤 고른 대상의 설정 화면으로 돌아온다', () => {
  assert.equal(quickLoginReturn('onprem'), '/?stage=setup&target=onprem')
  assert.equal(quickLoginReturn('gcp'), '/?stage=setup&target=gcp')
})
