#!/usr/bin/env node
/**
 * 실제 모드 분석 검토 게이트 시험(헤드리스). 목업 SSE 서버의 검토 게이트(MOCK_REVIEW_GATE=1)를 쓴다.
 *   1) MOCK_REVIEW_GATE=1 MOCK_REVIEW_DELAY_MS=10000 PORT=8000 npm run mock:server
 *      (MOCK_REVIEW_DELAY_MS: analysis.done 뒤 게이트가 서기까지. 실제 데모 서버처럼 약 10초로 둬야 뼈대 화면을 볼 수 있다)
 *   2) NEXT_PUBLIC_API_MODE=sse NEXT_PUBLIC_SSE_START=legacy NEXT_PUBLIC_API_BASE=http://127.0.0.1:8000 NEXT_PUBLIC_APPROVAL_RELAY=direct npx next dev -p 3200
 *   3) BASE_URL=http://localhost:3200 node tests/e2e/review-gate.mjs
 *      (dev 서버는 127.0.0.1 주소의 개발 자원을 막으므로 localhost로 연다)
 * 확인하는 것:
 *   - 분석 완료 → 바로 [다음] → 샌드박스 화면 위에 뼈대 검토 화면 → 게이트가 서면 같은 시트(다시 마운트 없음)에서 실제 항목
 *   - 서버 제안대로 확정 → 2단계(잃는 것·보안 승인) → 모두 '진행' → 게이트가 닫히고 샌드박스가 진행된다
 *   - 필수 NONE을 고르면 확정 전에 경고 → 확정 → 막힘 화면(i18n 사유, 서버 문장은 보조) → [처음으로]
 *   - 390px 폭에서 가로 넘침이 없다
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('playwright')) } catch {
  console.error('playwright를 찾지 못했습니다. `npm i --no-save playwright` 후 다시 실행하세요.')
  process.exit(2)
}

const BASE_URL = process.env.BASE_URL || 'http://localhost:3200'
const problems = []
const check = (ok, message) => { if (!ok) problems.push(message); console.log((ok ? '  ✓ ' : '  ✗ ') + message) }
const browser = await chromium.launch()

async function open(lang, viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport })
  page.setDefaultTimeout(60000)
  page.on('pageerror', error => problems.push('pageerror: ' + error))
  // 이전이 시작되기 전의 검토 조회(404 = 아직 없음)는 정상이다.
  page.on('console', message => { if (message.type() === 'error' && !/status of 404/.test(message.text())) problems.push('console.error: ' + message.text().slice(0, 160)) })
  await page.goto(`${BASE_URL}/?stage=analysis&target=onprem&speed=${process.env.E2E_SPEED ?? '10'}&lang=${lang}`, { waitUntil: 'domcontentloaded' })
  return page
}

/** 분석이 끝나면 [다음]이 바로 열린다. 눌러서 샌드박스로 가면 그 위에 뼈대 검토 화면이 뜨고, 게이트가 서면 같은 시트가 실제 항목으로 바뀐다. */
async function toGate(page, { checks = false } = {}) {
  const next = page.locator('.analysis-next-area button:not([disabled])')
  await next.waitFor({ timeout: 90000 })
  if (checks) {
    check(await page.locator('.analysis-discovery-item.is-waiting[data-wait=mapping]').waitFor({ timeout: 5000 }).then(() => true, () => false), '분석 화면에는 "기능 매핑 중" 한 줄이 보인다')
    check(await page.locator('.review-sheet').count() === 0, '매핑 중 분석 화면은 덮지 않는다')
  }
  await next.click()
  await page.waitForFunction(() => document.querySelector('.stage-rail [aria-current=step]')?.textContent?.match(/샌드박스|Sandbox|サンドボックス/), null, { timeout: 30000 })
  if (checks) {
    await page.locator('.review-panel.is-loading').waitFor({ timeout: 10000 })
    check(true, '샌드박스 화면 위에 뼈대 검토 화면이 뜬다')
    check((await page.locator('.review-panel h2').innerText()).includes('AI가 기능을 대상 환경에 매핑하고 있어요'), '제목: AI가 기능을 대상 환경에 매핑하고 있어요')
    check(await page.locator('.review-ledger.is-skeleton .review-row').count() === 4 && await page.locator('.review-seg').count() === 0, '줄은 뼈대뿐이고 가짜 항목·선택이 없다')
    check(/기능 매핑.*증거 확인.*검토 준비/s.test(await page.locator('.review-progress').innerText()), '단계: 기능 매핑 → 증거 확인 → 검토 준비')
    await page.waitForFunction(() => /[1-9]\d*초/.test(document.querySelector('.review-elapsed')?.textContent ?? ''), null, { timeout: 5000 })
    check(true, '걸린 시간(초)이 올라간다')
    await page.evaluate(() => { document.querySelector('.review-sheet').dataset.mark = 'kept' })
  }
  await page.locator('.review-sheet[role=dialog] .review-seg').first().waitFor({ timeout: 90000 })
  if (checks) check(await page.locator('.review-sheet[data-mark=kept]').count() === 1, '게이트가 서면 같은 시트(다시 마운트 없음)에서 실제 항목으로 바뀐다')
}
const overflowX = page => page.evaluate(() => document.documentElement.scrollWidth > innerWidth
  || [...document.querySelectorAll('.review-sheet *')].some(element => element.getBoundingClientRect().right > innerWidth + 1))
const rowOf = (page, text) => page.locator('.review-row').filter({ hasText: text })

try {
  console.log('확정 → 승인 → 샌드박스 (ko)')
  {
    const page = await open('ko')
    await toGate(page, { checks: true })
    const sheet = page.locator('.review-sheet')
    check(await sheet.getAttribute('aria-modal') === 'true', '검토 화면은 aria-modal 대화상자다')
    check(await page.locator('.stage-rail').isVisible(), '단계 표시줄이 가려지지 않는다')
    check(await sheet.locator('input[type=checkbox]').count() === 0, '체크박스가 없다')
    check((await rowOf(page, 'WAF').innerText()).includes('제안: 필수 아님'), '서버 제안을 "제안: 필수 아님"으로 보인다')
    check((await rowOf(page, 'WAF').locator('.review-outcome').innerText()).includes('2단계에서 승인'), 'NONE × 필수 아님 = 2단계에서 승인')
    check((await rowOf(page, 'Orders').locator('.review-outcome').innerText()).includes('그대로 진행'), 'DIRECT = 그대로 진행')
    check(await page.locator('.review-aside .review-sec li').count() === 4, '1단계에서도 보안 비교 4개가 모두 보인다')
    check((await page.locator('.review-aside').innerText()).includes('배포 뒤 확인'), '증명 방식(배포 뒤 확인)이 보인다')
    await page.locator('.review-actions .flow-primary').click()
    await page.locator('.review-row.is-security').waitFor()
    check((await page.locator('.review-step').innerText()).includes('2/2'), '2단계로 넘어간다')
    const send = page.locator('.review-actions .flow-primary')
    check(await send.isDisabled(), '모두 답하기 전에는 보낼 수 없다')
    for (const row of await page.locator('.review-ledger .review-row').all()) await row.locator('.review-seg [role=radio]').first().click()
    check(!(await page.locator('.review-warn').count()), '모두 진행이면 중단 경고가 없다')
    await send.click()
    await page.locator('.review-sheet').waitFor({ state: 'detached', timeout: 20000 })
    check(true, '승인을 보내면 검토 화면이 닫힌다')
    await page.locator('.sbx-track').first().waitFor({ timeout: 30000 })
    check(true, '승인 뒤 샌드박스 이벤트가 와서 진행된다')
    await page.close()
  }

  for (const lang of ['ko', 'en', 'ja']) {
    console.log(`필수 NONE → 막힘 → ${lang === 'en' ? '설정으로' : '처음으로'} (${lang}, 390px)`)
    const page = await open(lang, { width: 390, height: 844 })
    await toGate(page)
    check(!(await overflowX(page)), '1단계에서 가로 넘침이 없다')
    await rowOf(page, 'WAF').locator('.review-seg [role=radio]').first().click()
    await page.locator('.review-warn[role=alert]').waitFor()
    check(true, '필수 NONE을 고르면 확정 전에 경고가 뜬다')
    check((await rowOf(page, 'WAF').locator('.review-outcome').getAttribute('class')).includes('is-block'), '그 행의 결과가 이전 중단이 된다')
    await page.locator('.review-actions .flow-primary').click()
    await page.locator('.review-panel.is-blocked').waitFor({ timeout: 20000 })
    const text = await page.locator('.review-panel.is-blocked .review-why').first().innerText()
    const expected = { ko: '대체할 수 없습니다', en: 'has no replacement', ja: '代替がありません' }[lang]
    check(text.includes(expected), '막힘 사유는 화면 언어 문구다: ' + text)
    check(!text.includes('등급이라'), '서버 한국어 문장을 사유로 그대로 쓰지 않는다')
    check(!(await overflowX(page)), '막힘 화면에서 가로 넘침이 없다')
    // en은 [설정으로], 나머지는 [처음으로]
    await page.locator('.review-panel.is-blocked .review-actions ' + (lang === 'en' ? '.flow-secondary' : '.flow-primary')).click()
    await page.locator('.review-sheet').waitFor({ state: 'detached', timeout: 20000 })
    await page.waitForFunction(() => !document.querySelector('.stage-rail'), null, { timeout: 20000 })
    check(true, (lang === 'en' ? '[설정으로]' : '[처음으로]') + '를 누르면 그 화면으로 가고 검토 화면이 닫힌다')
    await page.waitForTimeout(2500)
    check(await page.locator('.review-sheet').count() === 0, '조금 기다려도 막힘 화면이 다시 뜨지 않는다')
    await page.close()
  }
} catch (error) {
  problems.push(String(error))
}

await browser.close()
if (problems.length) { console.log('\n실패:\n  ' + problems.join('\n  ')); process.exit(1) }
console.log('\n모두 통과')
