#!/usr/bin/env node
/**
 * 음성만으로 처음부터 끝까지(헤드리스): 가짜 음성 인식(SpeechRecognition)에 말을 넣어 실제 인식 경로로 명령을 보낸다.
 * 소개 → 설정("좋아, 시작하자") → 분석·샌드박스·계획("다음") → 승인("좋아"는 승인 아님 → 사실 읽기 → "승인")
 * → 구축·데이터("다음") → 트래픽("장애 넣어 봐" 되묻기 → "아니", "지금 어디야", "다음") → DB 전환("다음"은 승인 아님 → "승인할게" → "다음") → 리포트.
 * 이벤트 보고가 채팅 기록에 남는지, 목소리가 서버 TTS(/api/tts)로만 나오는지(브라우저 합성 0회)도 본다.
 *
 *   BASE_URL=http://127.0.0.1:3000 node tests/e2e/voice.mjs
 *   TTS_EXPECT=server(기본: 모델 필요) | fallback(모델 없이: /api/tts 503 → 녹음 파일·브라우저 합성)
 * playwright 필요(`npm i --no-save playwright` 또는 NODE_PATH). PW_CHANNEL=chrome이면 설치된 Chrome을 쓴다.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('playwright')) } catch {
  console.error('playwright를 찾지 못했습니다. `npm i --no-save playwright` 후 다시 실행하세요.')
  process.exit(2)
}

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000'
const EXPECT = process.env.TTS_EXPECT || 'server'
const TIMEOUT = 90000
const problems = []
const note = message => console.log('  ' + message)
const check = (ok, message) => { if (!ok) problems.push(message); console.log((ok ? '  ✓ ' : '  ✗ ') + message) }

const browser = await chromium.launch({ ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}), args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: { width: 1536, height: 800 } })
page.setDefaultTimeout(TIMEOUT)
page.on('pageerror', error => problems.push('pageerror: ' + error))
// /favicon.ico 404는 알려진 문제라 뺀다(다른 404는 주소와 함께 실패로 남긴다).
page.on('console', message => { if (message.type() === 'error' && !/favicon/.test(message.location()?.url ?? '')) problems.push('console.error: ' + message.text().slice(0, 160) + ' @ ' + (message.location()?.url ?? '')) })
page.on('response', response => { if (response.status() === 404 && !response.url().endsWith('/favicon.ico')) problems.push('404: ' + response.url()) })
const tts = []
page.on('response', response => {
  if (!response.url().includes('/api/tts?') || response.url().includes('warm=1')) return
  tts.push({ status: response.status(), cache: response.headers()['x-tts-cache'], ms: Number(response.headers()['x-tts-ms'] ?? 0) })
})

// 가짜 음성 인식: 듣는 중(start)일 때만 말을 받는다(실제처럼 자칼이 말하는 동안에는 듣지 않는다).
await page.addInitScript(() => {
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
      const recognition = state.current
      if (recognition?.active) {
        recognition.active = false
        state.said.push(text)
        recognition.onresult?.({ results: [[{ transcript: text }]] })
        setTimeout(() => recognition.onend?.(), 0)
        resolve(true)
      } else if (Date.now() - started > 40000) reject(new Error('인식이 듣는 상태가 아님: ' + text))
      else setTimeout(tick, 100)
    }
    tick()
  })
  // 마이크 권한은 허용된 것으로 둔다(첫 화면부터 듣는다). 음량 측정용 마이크 스트림은 없어도 된다.
  const query = navigator.permissions?.query?.bind(navigator.permissions)
  if (query) navigator.permissions.query = descriptor => descriptor?.name === 'microphone' ? Promise.resolve({ state: 'granted' }) : query(descriptor)
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('no mic in test'))
  // 브라우저 음성 합성을 썼는지 센다(서버 TTS가 되면 0이어야 한다).
  window.__synth = 0
  if (window.speechSynthesis) {
    const speak = window.speechSynthesis.speak.bind(window.speechSynthesis)
    window.__synthTexts = []
    window.speechSynthesis.speak = utterance => { window.__synth += 1; window.__synthTexts.push(utterance.text); speak(utterance); setTimeout(() => utterance.onend?.(new Event('end')), 300) }
  }
})

const say = async text => { await page.evaluate(value => window.__say(value), text); note('🎙 ' + text) }
const chat = () => page.evaluate(() => [...document.querySelectorAll('.jv-msg')].map(node => node.textContent ?? '').join('\n'))
const waitChat = (pattern, label) => page.waitForFunction(source => new RegExp(source).test([...document.querySelectorAll('.jv-msg')].map(node => node.textContent ?? '').join('\n')), pattern.source, { timeout: TIMEOUT })
  .then(() => check(true, label), () => check(false, label))
const waitHint = word => page.waitForFunction(value => (document.querySelector('[data-voice-hints]')?.textContent ?? '').includes(value), word, { timeout: TIMEOUT })
const openChat = async () => { if (await page.locator('.jv-panel').count() === 0) await page.locator('.jv-pill').click() }

try {
  console.log(`음성 흐름 시험: ${BASE_URL} (TTS_EXPECT=${EXPECT})`)
  await page.goto(`${BASE_URL}/?lang=ko&target=gcp`)
  // 클릭하면 입자가 구로 모인다(호출과 같다). 하이드레이션 전 클릭은 무시되므로 되풀이한다.
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.mouse.click(768, 400)
    if (await page.locator('.prompt-overlay').waitFor({ state: 'attached', timeout: 10000 }).then(() => true, () => false)) break
  }
  await say('AWS에 있는 채팅 서비스를 GCP로 옮기고 싶어')
  await page.locator('.setup2').waitFor()
  check(true, '말한 의도로 설정 화면에 왔다')
  await waitHint('시작하자')
  await say('좋아, 시작하자')
  // 이전 범위 선택: 음성으로 시작하면 범위 분석 화면이 열린다. 후보 확인·범위 확정은 화면에서(근거를 보고 사람이 확정).
  await page.locator('.scope [data-scope-action=analyze]:not([disabled])').click()
  await page.locator('.scope-row').first().waitFor()
  await page.locator('.scope [data-scope-action=confirm]').click()
  await page.locator('.analysis-next-area').waitFor()
  check(true, '"좋아, 시작하자" → 분석')
  await openChat()

  await waitHint('다음')
  await waitChat(/분석 완료\. 샌드박스 검증으로 갈까요\?/, '분석 완료 → 다음 단계를 묻는다')
  await say('다음')
  await page.locator('.sbx-split').waitFor()
  check(true, '"다음" → 샌드박스')
  await waitHint('다음')
  await waitChat(/검증 통과\. 계획 수립으로 갈까요\?/, '샌드박스 통과 → 계획 수립을 묻는다')
  await say('다음')
  await page.locator('.plan-next').waitFor()
  await waitHint('다음')
  await say('지금 어디야?')
  await waitChat(/지금 계획 수립\./, '"지금 어디야" → 단계 요약')
  await say('다음')
  await page.locator('.approval-panel').waitFor()
  check(true, '"다음" → 승인 화면')

  // 승인: 일반 동의("좋아")로는 승인하지 않는다. 사실을 읽고 승인 방법을 알려 준다.
  await waitChat(/만들 리소스, 원본에 남는 항목, 비용을 확인해 주세요/, '승인 사실(확인할 것)을 읽는다')
  await waitChat(/맞으면 '승인'이라고 해 주세요/, '승인 방법을 알려 준다')
  await say('좋아')
  await page.waitForTimeout(1500)
  check(await page.locator('.approval-delivery').count() === 0, '"좋아"로는 승인되지 않는다')
  await say('승인')
  await page.locator('.approval-delivery').waitFor().then(() => check(true, '"승인" → 승인 전달 시작'), () => check(false, '"승인" → 승인 전달 시작'))
  await page.waitForSelector('.approval-panel', { state: 'detached' })
  note('승인 전달됨 → 구축')

  await waitHint('다음')
  await waitChat(/구축 완료\. 데이터 이전으로 갈까요\?/, '구축 완료 → 데이터 이전을 묻는다')
  await say('다음')
  await page.locator('.dm').waitFor()
  await waitHint('다음')
  await waitChat(/복제 지연 0\. 트래픽 이전으로 갈까요\?/, '복제 지연 0 → 트래픽 이전을 묻는다')
  await say('다음')
  await page.locator('.traffic-layout').waitFor()
  check(true, '"다음" → 트래픽')

  // 위험한 동작은 되묻는다: "장애 넣어 봐" → 되묻기 → "아니" → 하지 않는다.
  await waitHint('장애 넣어 봐')
  await say('장애 넣어 봐')
  await waitChat(/장애를 넣어 볼까요/, '장애 주입은 되묻는다')
  await waitHint('확인')
  await say('아니')
  await waitChat(/요청 취소/, '"아니" → 취소')
  check(!(await chat()).includes('게이트 실패'), '되묻기를 거절하면 장애를 넣지 않는다')
  await waitHint('다음')
  await waitChat(/트래픽 이전 완료\. DB 전환으로 갈까요\?/, '트래픽 완료 → DB 전환을 묻는다')
  await say('다음')

  // DB 전환: "다음"은 승인이 아니다 → 사실 읽기 → "승인할게"
  await page.locator('.cx-approve').waitFor()
  await waitChat(/진행하려면 '승인'이라고 해 주세요/, 'DB 전환 승인 방법을 알려 준다')
  await say('다음')
  await page.waitForTimeout(1500)
  check(await page.locator('.cx-approve').count() === 1, '"다음"으로는 DB 전환을 승인하지 않는다')
  await say('승인할게')
  await page.waitForFunction(() => document.querySelectorAll('.cutover-tile').length >= 3)
  check(true, '"승인할게" → DB 전환·검증')
  await waitHint('다음')
  await say('다음')
  await page.waitForSelector('.report-panel').then(() => check(true, '"다음" → 리포트'), () => check(false, '"다음" → 리포트'))
  await page.waitForTimeout(2500)

  const synth = await page.evaluate(() => window.__synth)
  const ok = tts.filter(item => item.status === 200)
  console.log(`\n  TTS 응답 ${tts.length}개(200: ${ok.length}), 캐시 ${JSON.stringify(ok.reduce((acc, item) => ({ ...acc, [item.cache]: (acc[item.cache] ?? 0) + 1 }), {}))}, 브라우저 합성 ${synth}회`)
  if (EXPECT === 'server') {
    check(ok.length >= 10, '목소리가 서버 TTS로 나온다(200 응답 10개 이상)')
    check(synth === 0, '브라우저 음성 합성을 쓰지 않았다(한 목소리)' + (synth ? ': ' + JSON.stringify(await page.evaluate(() => window.__synthTexts)) : ''))
  } else {
    check(tts.every(item => item.status === 503), '모델이 없으면 /api/tts가 503')
  }
} catch (error) {
  problems.push('흐름 중단: ' + (error instanceof Error ? error.message.split('\n')[0] : String(error)))
  await page.screenshot({ path: process.env.SHOT || 'e2e-voice-failure.png' }).catch(() => {})
  console.log((await chat().catch(() => '')).split('\n').slice(-12).join('\n'))
}

await browser.close()
if (problems.length) {
  console.log('\n실패:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log('\n통과')
