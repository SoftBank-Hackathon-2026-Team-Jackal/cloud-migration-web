#!/usr/bin/env node
/**
 * 누르고 말하기(헤드리스): 가짜 음성 인식으로 "Space 누름 → start, 뗌 → stop → 그 한 마디 처리 / 안 누르면 start 없음"을 본다.
 * 위젯 마이크 버튼 길게 누르기, 입력창·반복 keydown 무시, 자칼이 말하는 중에 누르면 말을 멈춤, 듣기 방식 저장도 본다.
 *
 *   BASE_URL=http://127.0.0.1:3000 node tests/e2e/voice-ptt.mjs
 *   SHOTS=<폴더>  있으면 위젯 평소·누르는 중 스크린샷을 ko·en·ja로 남긴다.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('playwright')) } catch {
  console.error('playwright를 찾지 못했습니다. `npm i --no-save playwright` 후 다시 실행하세요.')
  process.exit(2)
}
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000'
const SHOTS = process.env.SHOTS
const problems = []
const check = (ok, message) => { if (!ok) problems.push(message); console.log((ok ? '  ✓ ' : '  ✗ ') + message) }

// 가짜 인식기: start·stop 횟수를 센다. 듣는 중에 __speak로 말을 넣어 두면 stop 때(Chrome처럼) 결과를 넘기고 끝난다.
function init() {
  const state = { starts: 0, stops: 0, active: null, pending: '' }
  class FakeRecognition {
    constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this.onresult = null; this.onerror = null; this.onend = null; this.on = false }
    start() { if (this.on) throw new Error('already started'); this.on = true; state.starts += 1; state.active = this }
    stop() {
      if (!this.on) return
      this.on = false; state.stops += 1; state.active = null
      const text = state.pending; state.pending = ''
      setTimeout(() => { if (text) this.onresult?.({ results: [[{ transcript: text }]] }); this.onend?.() }, 0)
    }
  }
  window.SpeechRecognition = FakeRecognition
  window.webkitSpeechRecognition = FakeRecognition
  window.__ptt = state
  window.__speak = text => { state.pending = text }
  const query = navigator.permissions?.query?.bind(navigator.permissions)
  if (query) navigator.permissions.query = d => d?.name === 'microphone' ? Promise.resolve({ state: 'granted' }) : query(d)
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('no mic in test'))
  // 자칼의 말은 끝나지 않게 둔다(말하는 중에 누르면 멈추는지 본다).
  HTMLMediaElement.prototype.play = function () { return new Promise(() => {}) }
}

const browser = await chromium.launch({ ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}) })
const silentWav = () => {
  const buffer = Buffer.alloc(44 + 1600)
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + 1600, 4); buffer.write('WAVE', 8); buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36); buffer.writeUInt32LE(1600, 40)
  return buffer
}
async function open(lang, query = '', listenMode) {
  const context = await browser.newContext({ viewport: { width: 1536, height: 860 } })
  const page = await context.newPage()
  page.setDefaultTimeout(40000)
  page.on('pageerror', error => problems.push('pageerror: ' + error))
  await page.route('**/api/tts*', route => route.request().url().includes('warm=1')
    ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"available":true}' })
    : route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav() }))
  await page.addInitScript(init)
  if (listenMode) await page.addInitScript(mode => { try { localStorage.setItem('jackal.listenMode', mode) } catch {} }, listenMode)
  await page.goto(`${BASE_URL}/?lang=${lang}&speed=10${query}`)
  await page.waitForSelector('.jv-listen')
  await page.waitForTimeout(1500)
  return { page, context }
}
// 단계 화면에서는 위젯이 접혀 있다: 펼친다.
const unfold = async page => { if (await page.getAttribute('.jv-pill', 'aria-expanded') === 'false') await page.click('.jv-pill'); await page.waitForSelector('.jv-log') }
const ptt = page => page.evaluate(() => ({ starts: window.__ptt.starts, stops: window.__ptt.stops }))
const chatText = page => page.locator('.jv-log').innerText()

try {
  console.log('첫 화면(기본: 누르고 말하기)')
  {
    const { page, context } = await open('ko')
    check(await page.getAttribute('.jv-listen', 'data-listen-mode') === 'ptt', '기본 듣기 방식은 누르고 말하기')
    await page.waitForTimeout(1500)
    check((await ptt(page)).starts === 0, '누르지 않으면 인식기를 켜지 않는다(마이크 권한이 있어도)')
    check(await page.locator('.jv.is-idle').count() === 1, '누르지 않을 때 위젯은 대기')
    await page.keyboard.down('Space')
    await page.waitForTimeout(200)
    check((await ptt(page)).starts === 1, 'Space를 누르면 인식기를 켠다')
    check(await page.locator('.jv.is-listening').count() === 1 && await page.locator('.jv-ptt.is-holding').count() === 1, '누르는 동안 위젯이 듣는 중')
    await page.keyboard.down('Space') // 꾹 눌러 생기는 반복 keydown
    await page.waitForTimeout(150)
    check((await ptt(page)).starts === 1, '반복 keydown은 무시한다')
    await page.evaluate(() => window.__speak('AWS에 있는 서비스를 온프레미스로 옮기고 싶어'))
    await page.keyboard.up('Space')
    await page.waitForTimeout(300)
    check((await ptt(page)).stops === 1, '떼면 인식을 멈춘다')
    check(await page.locator('.jv.is-listening').count() === 0, '뗀 뒤에는 듣는 중이 아니다')
    await page.waitForFunction(() => document.querySelector('.jv-log')?.textContent?.includes('온프레미스로 옮기고 싶어'), null, { timeout: 10000 }).catch(() => {})
    check((await chatText(page)).includes('온프레미스로 옮기고 싶어'), '누른 동안 한 말은 호출어 없이 처리된다(첫 화면: 호출 + 의도)')
    await page.waitForTimeout(2500)
    check((await ptt(page)).starts === 1, '뗀 뒤 자동으로 다시 듣지 않는다')
    // 자칼이 말하는 중에 누르면 말을 멈추고 듣는다.
    if (await page.locator('.jv.is-speaking').count() === 1) {
      await page.keyboard.down('Space')
      await page.waitForTimeout(200)
      check(await page.locator('.jv.is-speaking').count() === 0 && (await ptt(page)).starts === 2, '자칼이 말하는 중에 누르면 말을 멈추고 듣는다')
      await page.keyboard.up('Space')
    } else check(false, '자칼이 말하는 중 상태를 만들지 못했다')
    await context.close()
  }

  console.log('단계 화면(명령 → 질문)')
  {
    const { page, context } = await open('ko', '&stage=analysis&target=onprem')
    await unfold(page)
    await page.keyboard.down('Space')
    await page.waitForTimeout(200)
    await page.evaluate(() => window.__speak('샌드박스는 어디에서 돌아?'))
    await page.keyboard.up('Space')
    await page.waitForFunction(() => document.querySelector('.jv-log')?.textContent?.includes('샌드박스는 어디에서 돌아?'), null, { timeout: 10000 }).catch(() => {})
    check((await chatText(page)).includes('샌드박스는 어디에서 돌아?'), '단계 화면: 호출어 없이 한 질문을 받는다')
    // 입력창에서는 Space가 글자다.
    const before = (await ptt(page)).starts
    await page.click('.jv-form input')
    await page.keyboard.press('Space')
    await page.waitForTimeout(200)
    check((await ptt(page)).starts === before, '입력창에서는 Space가 듣기를 켜지 않는다')
    // 위젯 마이크 버튼 길게 누르기
    await page.locator('.jv-form input').blur()
    const box = await page.locator('.jv-ptt').boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(200)
    check((await ptt(page)).starts === before + 1 && await page.locator('.jv.is-listening').count() === 1, '마이크 버튼을 누르는 동안 듣는다')
    await page.mouse.up()
    await page.waitForTimeout(200)
    check(await page.locator('.jv.is-listening').count() === 0, '마이크 버튼을 떼면 듣기를 멈춘다')
    await context.close()
  }

  console.log('듣기 방식 저장')
  {
    const { page, context } = await open('ko')
    await page.click('.jv-listen button:nth-of-type(2)')
    check(await page.evaluate(() => localStorage.getItem('jackal.listenMode')) === 'continuous', '계속 듣기를 고르면 저장한다')
    await page.reload()
    await page.waitForSelector('.jv-listen')
    await page.waitForTimeout(2000)
    check(await page.getAttribute('.jv-listen', 'data-listen-mode') === 'continuous', '다시 열어도 고른 방식이 남는다')
    check((await ptt(page)).starts >= 1, '계속 듣기는 예전처럼 마이크 권한이 있으면 바로 듣는다')
    await page.keyboard.down('Space'); await page.keyboard.up('Space')
    check(await page.locator('.jv-ptt').count() === 0, '계속 듣기에서는 마이크 버튼이 켜기/끄기 토글이다')
    await context.close()
  }

  if (SHOTS) {
    for (const lang of ['ko', 'en', 'ja']) {
      const { page, context } = await open(lang, '&stage=analysis&target=onprem')
      await unfold(page)
      const widget = page.locator('.jv')
      await widget.screenshot({ path: `${SHOTS}/ptt-${lang}-idle.png` })
      await page.keyboard.down('Space')
      await page.waitForTimeout(400)
      await widget.screenshot({ path: `${SHOTS}/ptt-${lang}-holding.png` })
      await page.screenshot({ path: `${SHOTS}/ptt-${lang}-holding-full.png` })
      await page.keyboard.up('Space')
      await context.close()
    }
    console.log('  스크린샷: ' + SHOTS)
  }
} catch (error) {
  problems.push('중단: ' + (error?.message ?? error))
} finally {
  await browser.close()
}
if (problems.length) { console.log('\n실패:'); for (const p of problems) console.log('- ' + p); process.exit(1) }
console.log('\n통과')
