#!/usr/bin/env node
/**
 * 말은 말대로, 화면은 화면대로(헤드리스, 목업 모드): 자칼의 말이 끝나지 않아도 화면은 바로 다음 단계로 넘어가고,
 * 사용자가 화면에서 눌러 넘어가면 나오던 말이 끊긴다.
 *   BASE_URL=http://127.0.0.1:3000 node tests/e2e/voice-async-nav.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('playwright')) } catch {
  console.error('playwright를 찾지 못했습니다. `npm i --no-save playwright` 후 다시 실행하세요.')
  process.exit(2)
}

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000'
const CHANNEL = process.env.PW_CHANNEL || undefined
const problems = []
const check = (ok, message) => { if (!ok) problems.push(message); console.log((ok ? '  ✓ ' : '  ✗ ') + message) }

const browser = await chromium.launch(CHANNEL ? { channel: CHANNEL } : {})
try {
  const page = await browser.newPage({ viewport: { width: 1536, height: 860 } })
  // 말이 끝나지 않는 상황: 녹음 재생과 음성 합성이 시작만 하고 끝 신호를 주지 않는다.
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () { return new Promise(() => {}) }
    try { window.speechSynthesis.speak = () => {}; window.speechSynthesis.cancel = () => {} } catch { /* 합성 음성이 없는 브라우저 */ }
  })
  await page.goto(`${BASE_URL}/?lang=ko&speed=10`)
  // 하이드레이션 전의 키 입력은 무시되므로 첫 화면 대답이 나올 때까지 L을 되풀이한다.
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.keyboard.press('l')
    if (await page.waitForFunction(() => document.querySelector('.jv-log')?.textContent?.includes('듣고 있어요'), null, { timeout: 6000 }).then(() => true, () => false)) break
  }
  await page.keyboard.press('i')
  const startedAt = Date.now()
  await page.waitForSelector('.setup2', { timeout: 40000 })
  const elapsed = Date.now() - startedAt
  check(elapsed < 4500, `말이 끝나지 않아도 설정 화면으로 바로 넘어간다(${elapsed}ms)`)
  check(await page.locator('.jv.is-speaking').count() === 1, '화면이 넘어간 뒤에도 말은 계속 나온다')
  await page.waitForTimeout(800)
  await page.click('.back-btn')
  await page.waitForSelector('.setup2', { state: 'detached', timeout: 10000 }).catch(() => {})
  await page.waitForTimeout(600)
  check(await page.locator('.jv.is-speaking').count() === 0, '화면에서 눌러 넘어가면 나오던 말이 끊긴다')
} finally {
  await browser.close()
}
if (problems.length) { console.log('\n실패:\n- ' + problems.join('\n- ')); process.exit(1) }
console.log('\n통과')
