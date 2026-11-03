#!/usr/bin/env node
/**
 * SSE 모드의 연결·실패·취소 상태 시험(헤드리스).
 *   1) npm run mock:server                                  (http://127.0.0.1:8000)
 *   2) NEXT_PUBLIC_API_MODE=sse 로 띄운 앱                  (예: NEXT_PUBLIC_API_MODE=sse npx next dev -p 3200)
 *   3) BASE_URL=http://127.0.0.1:3200 node tests/e2e/sse-states.mjs
 * 서버의 개발용 엔드포인트(/__debug/disconnect, /migrations/{id}/debug/fail)를 쓴다.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('playwright')) } catch {
  console.error('playwright를 찾지 못했습니다. `npm i --no-save playwright` 후 다시 실행하세요.')
  process.exit(2)
}

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3200'
const API = process.env.API_BASE || 'http://127.0.0.1:8000'
const problems = []
const check = (ok, message) => { if (!ok) problems.push(message); console.log((ok ? '  ✓ ' : '  ✗ ') + message) }

const browser = await chromium.launch()

/** 분석 화면을 열어 이전을 하나 시작하고, 그 id를 돌려준다. */
async function open(lang) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 600 } })
  page.setDefaultTimeout(15000)
  page.on('pageerror', error => problems.push('pageerror: ' + error))
  // 연결을 일부러 끊는 시험이므로 그때 브라우저가 남기는 네트워크 오류 로그는 제외한다.
  page.on('console', message => { if (message.type() === 'error' && !/ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONNECTION/.test(message.text())) problems.push('console.error: ' + message.text().slice(0, 160)) })
  const [response] = await Promise.all([
    page.waitForResponse(item => item.request().method() === 'POST' && new URL(item.url()).pathname === '/migrations'),
    page.goto(`${BASE_URL}/?stage=analysis&lang=${lang}&target=gcp`),
  ])
  const { id } = await response.json()
  await page.waitForSelector('.analysis-discovery-item')
  return { page, id }
}

try {
  console.log('연결 끊김 → 자동 재연결 → 이어 받기')
  {
    const { page, id } = await open('ko')
    const before = await page.locator('.analysis-discovery-item').count()
    await fetch(`${API}/__debug/disconnect`, { method: 'POST' })
    await page.waitForSelector('.flow-toast.is-on', { timeout: 5000 })
    check(true, '연결이 끊기면 안내 토스트가 뜬다')
    await page.waitForSelector('.flow-toast:not(.is-on)', { state: 'attached' })
    await page.waitForFunction(() => !document.querySelector('.flow-toast.is-on'))
    check(true, '다시 연결되면 토스트가 사라진다')
    await page.waitForFunction(count => document.querySelectorAll('.analysis-discovery-item').length > count, before)
    check(true, '끊긴 뒤에도 이벤트를 이어 받는다 (' + id + ')')
    await page.close()
  }

  for (const [lang, action, expected] of [['ko', '/debug/fail', '다시 시도할 수 없어요'], ['en', '/cancel', 'cancelled'], ['ja', '/debug/fail', '再試行できません']]) {
    console.log(`${lang} ${action}`)
    const { page, id } = await open(lang)
    await fetch(`${API}/migrations/${id}${action}`, { method: 'POST' })
    const panel = page.locator('section[role=alert]')
    await panel.waitFor()
    check((await panel.innerText()).includes(expected), '안내 문구가 보인다')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight)
    check(!overflow, '가로·세로 넘침이 없다')
    await panel.locator('button').click()
    await page.waitForTimeout(1800)
    check(await panel.count() === 0, '"처음으로"를 누르면 안내가 닫히고 처음으로 돌아간다')
    await page.close()
  }
} catch (error) {
  problems.push('중단: ' + (error instanceof Error ? error.message.split('\n')[0] : String(error)))
}

await browser.close()
if (problems.length) {
  console.log('\n실패:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log('\n통과')
