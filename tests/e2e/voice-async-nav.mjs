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
/** 올바른 헤더를 가진 1초짜리 무음 WAV(8kHz·16bit·모노). 깨진 파일이면 재생 오류로 말이 바로 끝난다. */
function silentWav() {
  const samples = 8000
  const header = Buffer.alloc(44)
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples * 2, 4); header.write('WAVE', 8)
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(8000, 24); header.writeUInt32LE(16000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write('data', 36); header.writeUInt32LE(samples * 2, 40)
  return Buffer.concat([header, Buffer.alloc(samples * 2)])
}
const problems = []
const check = (ok, message) => { if (!ok) problems.push(message); console.log((ok ? '  ✓ ' : '  ✗ ') + message) }

const browser = await chromium.launch(CHANNEL ? { channel: CHANNEL } : {})
try {
  const page = await browser.newPage({ viewport: { width: 1536, height: 860 } })
  // 말이 끝나지 않는 상황: 서버 TTS는 소리 파일을 주고(시험 서버에는 TTS가 없어 가짜로 대신한다), 재생은 시작만 하고
  // 끝 신호를 주지 않는다. 브라우저 음성 합성은 쓰지 않는다(자칼 목소리는 Supertonic 하나뿐이다).
  await page.route('**/api/tts*', route => route.request().url().includes('warm=1')
    ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"available":true}' })
    : route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() }))
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () { return new Promise(() => {}) }
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
