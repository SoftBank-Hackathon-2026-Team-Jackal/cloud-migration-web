#!/usr/bin/env node
/**
 * 데모 쿼리 시험(헤드리스, 목업 모드):
 *   ?review=1        샌드박스가 3번 실패해 사람 검토 대기 → [수정 후 재시도]로 이어짐, [취소]는 취소 안내
 *   ?digest=mismatch 승인 화면의 이미지 대조가 경고가 되고 승인 버튼이 막힘
 *   BASE_URL=http://127.0.0.1:3000 node tests/e2e/review.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('playwright')) } catch {
  console.error('playwright를 찾지 못했습니다. `npm i --no-save playwright` 후 다시 실행하세요.')
  process.exit(2)
}

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000'
const problems = []
const check = (ok, message) => { if (!ok) problems.push(message); console.log((ok ? '  ✓ ' : '  ✗ ') + message) }
const browser = await chromium.launch()

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 600 } })
  page.setDefaultTimeout(30000)
  page.on('pageerror', error => problems.push('pageerror: ' + error))
  page.on('console', message => { if (message.type() === 'error') problems.push('console.error: ' + message.text().slice(0, 160)) })
  await page.goto(`${BASE_URL}/?${query}${/(^|&)speed=/.test(query) ? '' : `&speed=${process.env.E2E_SPEED ?? '10'}`}`)
  return page
}
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight)

try {
  for (const lang of ['ko', 'en', 'ja']) {
    console.log(`사람 검토 대기 (${lang})`)
    const page = await open(`stage=rehearsal&review=1&target=gcp&lang=${lang}`)
    const panel = page.locator('section[role=alert]')
    await panel.waitFor()
    check((await page.locator('main').innerText()).includes('3/3'), '머리글에 시도 3/3이 보인다')
    check(!(await overflow(page)), '가로·세로 넘침이 없다')
    if (lang === 'ko') {
      await panel.locator('.flow-primary').click()
      await page.locator('section[role=alert]').waitFor({ state: 'detached' })
      await page.waitForSelector('.flow-footer .flow-primary:not([disabled])', { timeout: 40000 })
      check(true, '[수정 후 재시도] 뒤 샌드박스가 통과한다')
      check(/재사용/.test(await page.locator('.build-result').innerText()), '재시도한 빌드는 이전 빌드 재사용으로 표시된다')
    }
    await page.close()
  }

  console.log('사람 검토 → 취소')
  {
    const page = await open('stage=rehearsal&review=1&target=gcp&lang=ko')
    await page.locator('section[role=alert] .flow-secondary').click()
    await page.waitForFunction(() => document.querySelector('section[role=alert]')?.innerText.includes('취소'))
    check(true, '취소하면 취소 안내가 보인다')
    await page.close()
  }

  console.log('이미지 대조 불일치')
  {
    const page = await open('stage=approval&digest=mismatch&target=gcp&lang=ko')
    await page.waitForSelector('.approval-digest.is-warn')
    await page.locator('.approval-check input').check()
    check(await page.locator('.approval-actions .flow-primary').isDisabled(), '불일치면 체크해도 승인 버튼이 막힌다')
    check(!(await overflow(page)), '가로·세로 넘침이 없다')
    await page.close()
  }

  console.log('승인 전달 실패 → 다시 전달 (?delivery=fail)')
  {
    // 잠깐 지나가는 '전달 중' 상태를 확인해야 하므로 이 시험은 실제 시간(×1)으로 돈다.
    const page = await open('stage=approval&delivery=fail&target=gcp&lang=ko&speed=1')
    await page.waitForSelector('.approval-digest')
    await page.locator('.approval-check input').check()
    await page.locator('.approval-actions .flow-primary').click()
    await page.waitForSelector('.approval-delivery.is-pending')
    check(await page.locator('.approval-actions .flow-primary').isDisabled(), '전달을 기다리는 동안 승인 버튼이 막힌다')
    await page.waitForSelector('.approval-delivery.is-failed', { timeout: 10000 })
    await page.waitForTimeout(1500)
    check(await page.locator('.approval-panel').count() === 1, '전달이 실패하면 다음 단계로 넘어가지 않는다')
    check(await page.locator('.approval-actions .flow-primary').isEnabled(), '전달 실패 뒤 [다시 전달]을 누를 수 있다')
    await page.locator('.approval-actions .flow-primary').click()
    await page.waitForSelector('.approval-delivery.is-delivered', { timeout: 10000 })
    await page.waitForSelector('.approval-panel', { state: 'detached', timeout: 15000 })
    check(true, '다시 전달해 전달되면 구축으로 넘어간다')
    await page.close()
  }
} catch (error) {
  problems.push('중단: ' + (error instanceof Error ? error.message.split('\n')[0] : String(error)))
}

await browser.close()
if (problems.length) { console.log('\n실패:\n- ' + problems.join('\n- ')); process.exit(1) }
console.log('\n통과')
