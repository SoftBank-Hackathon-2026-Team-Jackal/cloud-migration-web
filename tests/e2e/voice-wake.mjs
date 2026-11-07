// 호출어 매트릭스 시험(언어×단계×표기): 가짜 음성 인식에 말을 넣어 실제 인식 경로를 시험한다.
//   BASE_URL=http://127.0.0.1:3000 PW_CHANNEL=chrome node tests/e2e/voice-wake.mjs   (playwright 또는 playwright-core 필요)
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('playwright')) } catch { ({ chromium } = require('playwright-core')) }

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000'
const ANSWER = { ko: /네, 말씀하세요/, en: /Yes\? I'm listening/, ja: /はい、どうぞ/ }
const PHRASES = { ko: '헤이 자칼', en: 'hey jackal', ja: 'ヘイ ジャッカル' }
const STAGES = ['setup', 'analysis', 'rehearsal', 'planning', 'approval', 'provisioning', 'data', 'cutover', 'traffic']

const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}), args: ['--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'] })

const initScript = voiceLang => {
  const state = { current: null, said: [], logs: [] }
  class FakeRecognition {
    constructor() { this.lang = ''; this.continuous = false; this.interimResults = false; this.onresult = null; this.onerror = null; this.onend = null; this.active = false }
    start() { if (this.active) throw new Error('already started'); this.active = true; state.current = this }
    stop() { if (!this.active) return; this.active = false; setTimeout(() => this.onend?.(), 0) }
  }
  window.SpeechRecognition = FakeRecognition
  window.webkitSpeechRecognition = FakeRecognition
  window.__voice = state
  window.__say = text => new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const recognition = state.current
      if (recognition?.active) {
        recognition.active = false
        state.said.push({ text, lang: recognition.lang })
        recognition.onresult?.({ results: [[{ transcript: text }]] })
        setTimeout(() => recognition.onend?.(), 0)
        resolve(recognition.lang)
      } else if (Date.now() - started > 60000) reject(new Error('listening state timeout'))
      else setTimeout(tick, 100)
    }
    tick()
  })
  const query = navigator.permissions?.query?.bind(navigator.permissions)
  if (query) navigator.permissions.query = d => d?.name === 'microphone' ? Promise.resolve({ state: 'granted' }) : query(d)
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('no mic in test'))
  try { if (voiceLang) localStorage.setItem('jackal.voiceLang', voiceLang) } catch {}
  const info = console.info.bind(console)
  console.info = (...args) => { try { if (String(args[0]).includes('jackal-voice')) state.logs.push(args[1]) } catch {} info(...args) }
}

async function runCase({ name, screen, voice, stage, phrase, expect }) {
  const context = await browser.newContext({ viewport: { width: 1536, height: 800 } })
  const page = await context.newPage()
  page.setDefaultTimeout(60000)
  await page.addInitScript(initScript, voice)
  const result = { name, ok: false, detail: '' }
  try {
    const url = `${BASE}/?lang=${screen}&target=gcp` + (stage && stage !== 'intro' ? `&stage=${stage}` : '')
    await page.goto(url)
    await page.waitForTimeout(1500)
    if (stage === 'intro-started') {
      // 첫 화면에서 한 번 호출해 시작한 뒤, 다시 호출한다.
      await page.evaluate(t => window.__say(t), PHRASES[screen])
      await page.waitForTimeout(2500)
    }
    const heardLang = await page.evaluate(t => window.__say(t), phrase)
    // 응답이 채팅 기록에 남을 때까지 기다린다(패널이 접혀 있으면 연다).
    if (await page.locator('.jv-panel').count() === 0) await page.locator('.jv-pill').click({ timeout: 5000 }).catch(() => {})
    const ok = await page.waitForFunction(source => new RegExp(source).test([...document.querySelectorAll('.jv-msg')].map(n => n.textContent ?? '').join('\n')), expect.source, { timeout: 15000 }).then(() => true, () => false)
    const logs = await page.evaluate(() => window.__voice.logs)
    const chat = await page.evaluate(() => [...document.querySelectorAll('.jv-msg')].map(n => n.textContent ?? '').slice(-3).join(' | '))
    result.ok = ok
    result.detail = `인식언어=${heardLang} woke=${logs.map(l => JSON.parse(l).woke).join(',')} 채팅=${chat.slice(0, 80)}`
  } catch (error) {
    result.detail = '오류: ' + String(error.message).split('\n')[0]
  }
  await context.close()
  return result
}

const cases = []
// 1) 단계별: 각 음성 언어에서 그 언어의 호출어
for (const stage of STAGES) for (const voice of ['ko', 'en', 'ja']) {
  cases.push({ name: `단계 ${stage} · 음성 ${voice} · 호출어 ${voice}`, screen: 'ko', voice, stage, phrase: PHRASES[voice], expect: ANSWER[voice] })
}
// 2) 교차: 한 단계에서 모든 (음성 언어 × 호출어 표기) 조합(Chrome이 다른 언어로 받아 적는 경우)
for (const voice of ['ko', 'en', 'ja']) for (const spoken of ['ko', 'en', 'ja']) if (voice !== spoken) {
  cases.push({ name: `교차 planning · 음성 ${voice} · 호출어 ${spoken}`, screen: 'ko', voice, stage: 'planning', phrase: PHRASES[spoken], expect: ANSWER[voice] })
}
// 3) 호출어 + 뒷말
cases.push({ name: '호출어+뒷말 planning ko', screen: 'ko', voice: 'ko', stage: 'planning', phrase: '헤이 자칼 지금 어디야', expect: /(지금|현재).*계획|계획 (수립|단계)/ })
// 4) 첫 화면: 처음 호출 / 이미 시작된 뒤 호출 (화면 언어별)
for (const screen of ['ko', 'en', 'ja']) {
  cases.push({ name: `첫 화면(처음) · 화면 ${screen}`, screen, voice: screen, stage: 'intro', phrase: PHRASES[screen], expect: ({ ko: /말씀하세요|듣고|어디로|옮기/, en: /listening|Where|move/, ja: /どうぞ|聞い|どこ|移/ })[screen] })
  cases.push({ name: `첫 화면(이미 시작) · 화면 ${screen}`, screen, voice: screen, stage: 'intro-started', phrase: PHRASES[screen], expect: ({ ko: /듣고 있어요[\s\S]*듣고 있어요/, en: /I'm listening[\s\S]*I'm listening/, ja: /聞いています[\s\S]*聞いています/ })[screen] })
}

const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null
const todo = cases.filter(c => !only || only.test(c.name))
const results = []
let index = 0
const CONC = Number(process.env.CONC || 3)
await Promise.all(Array.from({ length: CONC }, async () => {
  while (index < todo.length) {
    const c = todo[index++]
    const r = await runCase(c)
    results.push(r)
    console.log((r.ok ? '✓ ' : '✗ ') + r.name + '  — ' + r.detail)
  }
}))
await browser.close()
const failed = results.filter(r => !r.ok)
console.log(`\n합계 ${results.length}건, 통과 ${results.length - failed.length}, 실패 ${failed.length}`)
if (failed.length) console.log('실패 목록:\n' + failed.map(r => '- ' + r.name).join('\n'))
if (failed.length) process.exit(1)
