// 말하는·듣는·화면 언어 분리 시험: 가짜 음성 인식에 말을 넣어 실제 인식 경로를 시험한다.
//   BASE_URL=http://127.0.0.1:3000 PW_CHANNEL=chrome node tests/e2e/voice-lang.mjs   (playwright 또는 playwright-core 필요)
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('playwright')) } catch { ({ chromium } = require('playwright-core')) }

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000'
const browser = await chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}), args: ['--autoplay-policy=no-user-gesture-required'] })

const init = ({ voice, input }) => {
  const state = { current: null, said: [] }
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
      const r = state.current
      if (r?.active) { r.active = false; state.said.push({ text, lang: r.lang }); r.onresult?.({ results: [[{ transcript: text }]] }); setTimeout(() => r.onend?.(), 0); resolve(r.lang) }
      else if (Date.now() - started > 30000) reject(new Error('not listening'))
      else setTimeout(tick, 100)
    }
    tick()
  })
  const q = navigator.permissions?.query?.bind(navigator.permissions)
  if (q) navigator.permissions.query = d => d?.name === 'microphone' ? Promise.resolve({ state: 'granted' }) : q(d)
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('no mic'))
  try { if (voice) localStorage.setItem('jackal.voiceLang', voice); if (input) localStorage.setItem('jackal.inputLang', input) } catch {}
}

const results = []
const record = (name, ok, detail) => { results.push({ name, ok }); console.log((ok ? '✓ ' : '✗ ') + name + (detail ? '  — ' + detail : '')) }

async function open({ screen, voice, input, stage }) {
  const context = await browser.newContext({ viewport: { width: 1536, height: 800 } })
  const page = await context.newPage()
  page.setDefaultTimeout(40000)
  await page.addInitScript(init, { voice, input })
  await page.goto(`${BASE}/?lang=${screen}&target=gcp` + (stage ? `&stage=${stage}` : ''))
  await page.waitForTimeout(1500)
  return { page, context }
}
const chatText = page => page.evaluate(() => [...document.querySelectorAll('.jv-msg')].map(n => n.className.includes('is-user') ? 'U:' + n.textContent : 'A:' + n.textContent))
const waitChat = (page, re) => page.waitForFunction(s => new RegExp(s).test([...document.querySelectorAll('.jv-msg')].map(n => n.textContent ?? '').join('\n')), re.source, { timeout: 15000 }).then(() => true, () => false)
const openPanel = async page => { if (await page.locator('.jv-panel').count() === 0) await page.locator('.jv-pill').click({ timeout: 5000 }).catch(() => {}) }

// A) 화면 ko · 말하는 ja · 듣는 ko: 한국어로 부르면 일본어로 답한다(단계 화면)
{
  const { page, context } = await open({ screen: 'ko', voice: 'ja', input: 'ko', stage: 'planning' })
  const heard = await page.evaluate(t => window.__say(t), '헤이 자칼')
  await openPanel(page)
  record('A 듣는 언어=ko → 인식 언어 ko-KR', heard === 'ko-KR', heard)
  record('A 말하는 언어=ja → 호출 응답이 일본어', await waitChat(page, /はい、どうぞ/))
  const chat = await chatText(page)
  record('A 채팅 순서: 사용자 말 → 자칼 응답', chat.findIndex(x => x.startsWith('U:')) < chat.findIndex(x => /^A:.*はい、どうぞ/.test(x)), chat.slice(-3).join(' | ').slice(0, 100))
  const widget = await page.evaluate(() => document.querySelector('[data-input-lang]')?.getAttribute('data-input-lang'))
  record('A "알아듣는 언어" 설정 표시 ko', widget === 'ko', widget)
  await context.close()
}
// B) 화면 ko · 말하는 ja · 듣는 ja: 일본어로 부르고 일본어로 답한다
{
  const { page, context } = await open({ screen: 'ko', voice: 'ja', input: 'ja', stage: 'planning' })
  const heard = await page.evaluate(t => window.__say(t), 'ヘイ ジャッカル')
  await openPanel(page)
  record('B 듣는 언어=ja → 인식 언어 ja-JP', heard === 'ja-JP', heard)
  record('B 응답 일본어', await waitChat(page, /はい、どうぞ/))
  await context.close()
}
// C) 첫 화면: 화면 ko · 말하는 ja · 듣는 ko → 일본어로 답하고 화면 언어(한국어) 자막이 붙는다
{
  const { page, context } = await open({ screen: 'ko', voice: 'ja', input: 'ko' })
  const heard = await page.evaluate(t => window.__say(t), '헤이 자칼')
  await openPanel(page)
  record('C 첫 화면 듣는 언어 ko-KR', heard === 'ko-KR', heard)
  record('C 첫 화면 응답이 일본어', await waitChat(page, /はい、聞いています/))
  const caption = await page.waitForFunction(() => /네, 듣고 있어요/.test(document.querySelector('[data-voice-caption]')?.textContent ?? ''), null, { timeout: 8000 }).then(() => true, () => false)
  record('C 첫 화면 자막이 화면 언어(한국어)', caption)
  await context.close()
}
// D) 지금 어디야: 모델이 없으면(로컬) 고정 문장으로 답하고 순서가 맞다
{
  const { page, context } = await open({ screen: 'ko', voice: 'ja', input: 'ja', stage: 'planning' })
  await page.evaluate(t => window.__say(t), 'ヘイ ジャッカル、今どこ')
  await openPanel(page)
  const ok = await waitChat(page, /今は/)
  const chat = await chatText(page)
  const iu = chat.findIndex(x => x.startsWith('U:ヘイ')), ia = chat.findIndex(x => /^A:今は/.test(x))
  record('D 지금 어디야 → 일본어로 상태 답', ok, chat.slice(-3).join(' | ').slice(0, 110))
  record('D 채팅 순서: 사용자 말 → 자칼 답', iu >= 0 && ia > iu, `U=${iu} A=${ia}`)
  await context.close()
}
// E) 기본값(선택 없음)은 예전과 같다: 화면 en → 듣기·말하기 en
{
  const { page, context } = await open({ screen: 'en', stage: 'planning' })
  const heard = await page.evaluate(t => window.__say(t), 'hey jackal')
  await openPanel(page)
  record('E 기본값 en: 인식 en-US', heard === 'en-US', heard)
  record('E 기본값 en: 응답 영어', await waitChat(page, /Yes\? I'm listening/))
  await context.close()
}
await browser.close()
const failed = results.filter(r => !r.ok)
console.log(`\n합계 ${results.length}건, 통과 ${results.length - failed.length}, 실패 ${failed.length}`)
if (failed.length) process.exit(1)
