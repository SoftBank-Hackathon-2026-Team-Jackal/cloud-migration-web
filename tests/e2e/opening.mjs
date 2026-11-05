#!/usr/bin/env node
/**
 * 오프닝 시나리오 시험(헤드리스, 목업 모드): 호출(L) → 의도(I) → 설정 화면 → 데모 저장소(R) → 예시 .env(E) → 시작(S) → 분석.
 * 대상이 모호한 의도는 되묻고 대상 버튼을 보여 주는지, .env 값이 화면·콘솔에 남지 않는지도 본다.
 *   BASE_URL=http://127.0.0.1:3000 node tests/e2e/opening.mjs
 *   SHOTS=dir 를 주면 1536×860·2000×1590 스크린숏을 남긴다.
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'

const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('playwright')) } catch {
  console.error('playwright를 찾지 못했습니다. `npm i --no-save playwright` 후 다시 실행하세요.')
  process.exit(2)
}

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000'
const SHOTS = process.env.SHOTS || ''
const CHANNEL = process.env.PW_CHANNEL || undefined
const problems = []
const check = (ok, message) => { if (!ok) problems.push(message); console.log((ok ? '  ✓ ' : '  ✗ ') + message) }
// 예시 .env의 값(가짜). 이 문자열이 화면·콘솔 어디에도 나오면 안 된다.
const VALUES = ['8080', 'production', 'postgres://', 'chat:example', 'redis://', 'example-not-a-real-secret']
if (SHOTS) mkdirSync(SHOTS, { recursive: true })

const browser = await chromium.launch(CHANNEL ? { channel: CHANNEL } : {})
const consoleText = []

async function open(size, lang = 'ko') {
  const page = await browser.newPage({ viewport: size })
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => problems.push('pageerror: ' + error))
  page.on('console', message => { consoleText.push(message.text()); if (message.type() === 'error' && !/favicon/.test(message.text() + (message.location()?.url ?? ''))) problems.push('console.error: ' + message.text().slice(0, 200)) })
  await page.goto(`${BASE_URL}/?lang=${lang}`)
  // 하이드레이션 전의 키 입력은 무시되므로 첫 화면 버튼이 나올 때까지 L을 되풀이한다.
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.keyboard.press('l')
    if (await page.waitForFunction(() => document.querySelector('.jv-log')?.textContent?.includes('듣고 있어요'), null, { timeout: 6000 }).then(() => true, () => false)) break
  }
  return page
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }) }

try {
  for (const size of [{ width: 1536, height: 860 }, { width: 2000, height: 1590 }]) {
    const tag = size.width + 'x' + size.height
    console.log('오프닝 ' + tag)
    const page = await open(size)
    check(await page.locator('.prompt-intent, .prompt-setup').count() === 0, '호출 뒤 선택지 버튼 없이 말·채팅으로만 진행한다')
    check((await page.locator('.jv-log').innerText()).includes('네, 듣고 있어요.'), '자칼: "네, 듣고 있어요."')
    await shot(page, `1-listening-${tag}`)

    await page.keyboard.press('i')
    await page.waitForFunction(() => document.querySelector('.jv-log')?.textContent?.includes('온프레미스 K3s로 옮기는 거죠'))
    check(true, '의도를 되짚고 대상을 온프레미스로 고른다')
    await shot(page, `2-confirm-${tag}`)

    await page.waitForSelector('.setup2', { timeout: 40000 })
    await page.waitForSelector('.senv-card.is-selected[data-target=onprem]')
    // 설정 화면에 들어오면 채팅이 접힌다: 자칼의 말을 확인하려고 펼친다.
    if (!(await page.locator('.jv-panel').count())) await page.click('.jv-pill')
    const envText = await page.locator('.senv').innerText()
    check(/연결됨/.test(envText) && /온라인/.test(envText) && envText.includes('office-seoul-01'), '등록된 원본·대상이 읽기 전용으로 보인다(에이전트 온라인)')
    check(await page.locator('.setup2 a[href="/settings"]').count() === 1, '등록·수정은 /settings 링크로만')
    check(await page.locator('.setup2 input[type=text], .setup2 input[type=password], .setup2 select').count() === 0, '설정 화면에 키·리전·에이전트 입력칸이 없다')
    await page.waitForTimeout(1200)
    await shot(page, `3-setup-${tag}`)

    await page.keyboard.press('r')
    await page.waitForSelector('.rimp[data-complete=true]', { timeout: 20000 })
    check(await page.locator('.rimp-det.is-on').count() === 5, '가져오기 장면: 탐지 5개가 켜진다')
    await page.waitForFunction(() => document.querySelector('.jv-log')?.textContent?.includes('환경 변수 파일만 주세요'))
    check(true, '자칼: "…찾았어요. 환경 변수 파일만 주세요."')
    await shot(page, `4-import-${tag}`)

    await page.keyboard.press('e')
    await page.waitForSelector('.envd-key')
    const sum = await page.locator('.envd-sum').innerText()
    check(sum.includes('6개 중 5개 있음') && sum.includes('LOG_LEVEL'), '.env 대조: 6개 중 5개 있음 · LOG_LEVEL 없음 → 기본값')
    check(await page.locator('.envd-key.is-secret').count() === 3, 'Secret 키 3개는 "플랫폼 Secret으로 연결"')
    const html = await page.content()
    check(VALUES.every(value => !html.includes(value)), '.env 값이 화면(DOM)에 없다')
    await page.waitForTimeout(800)
    await shot(page, `5-env-${tag}`)

    // S: 이전 범위 선택으로 → S: 분석 시작(기본 워크로드) → S: 범위 확정 → 분석 단계
    await page.keyboard.press('s')
    await page.waitForSelector('.scope [data-scope-action=analyze]:not([disabled])', { timeout: 20000 })
    check((await page.locator('.jv-log').innerText()).includes('옮길 앱을 골라 주세요'), '자칼: 옮길 앱을 골라 달라고 안내한다')
    await shot(page, `6-scope-${tag}`)
    await page.keyboard.press('s')
    await page.waitForSelector('.scope [data-scope-action=confirm]', { timeout: 20000 })
    check(await page.locator('.scope-row').count() >= 5, '분석 결과: 이전 범위 후보와 근거')
    await page.waitForFunction(() => document.querySelector('.jv-log')?.textContent?.includes('근거를 보고 확정해 주세요'))
    await shot(page, `7-scope-review-${tag}`)
    await page.keyboard.press('s')
    await page.waitForFunction(() => document.querySelector('.jv-log')?.textContent?.includes('원본 분석부터 시작할게요'))
    await page.waitForSelector('.analysis-discovery-item', { timeout: 30000 })
    check(true, '"좋아, 시작하자" → 자칼 "원본 분석부터 시작할게요." → 분석 단계')
    await page.close()
  }

  console.log('모호한 의도는 되묻는다')
  {
    const page = await open({ width: 1536, height: 860 })
    await page.fill('.jv-form input', '채팅 서비스를 옮기고 싶어')
    await page.press('.jv-form input', 'Enter')
    await page.waitForSelector('.prompt-target')
    check((await page.locator('.jv-log').innerText()).includes('어디로 옮길까요?'), '자칼: "어디로 옮길까요? …"와 대상 버튼')
    await shot(page, 'ask-target-1536x860')
    // 입력칸에 포커스가 있으면 단축키를 받지 않는다(타이핑과 구분): 포커스를 뺀 뒤 G를 누른다.
    await page.locator('.jv-form input').blur()
    await page.keyboard.press('g')
    await page.waitForSelector('.senv-card.is-selected[data-target=gcp]', { timeout: 40000 })
    check(true, 'G 키로 GCP를 고르면 설정 화면의 대상이 GCP로 정해진다')
    await page.close()
  }

  console.log('영어')
  {
    const page = await open({ width: 1536, height: 860 }, 'en')
    await page.keyboard.press('i')
    await page.waitForSelector('.senv-card.is-selected[data-target=onprem]', { timeout: 40000 })
    check(true, 'en: sample intent picks on-prem')
    await page.close()
  }
  check(VALUES.every(value => !consoleText.some(line => line.includes(value))), '.env 값이 콘솔에 없다')
} catch (error) {
  problems.push('중단: ' + (error instanceof Error ? error.message.split('\n')[0] : String(error)))
}

await browser.close()
if (problems.length) {
  console.log('\n실패:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log('\n통과')
