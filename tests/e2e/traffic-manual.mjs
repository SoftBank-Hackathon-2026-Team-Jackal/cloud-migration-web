#!/usr/bin/env node
/**
 * 수동 단계 브라우저 테스트(목업, ?manual=1): 트래픽 10% 통과 뒤 멈춰 "다음 단계로" 버튼을 보이고,
 * 누르면 50%, 다시 누르면 100%로 가서 끝난다. ?manual=1이 없으면 버튼이 없다는 것도 flow.mjs가 이미 확인한다(자동 흐름).
 *
 *   BASE_URL=http://127.0.0.1:3470 PW_CHANNEL=chrome node tests/e2e/traffic-manual.mjs
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('playwright')) } catch {
  console.error('playwright를 찾지 못했습니다. `npm i --no-save playwright` 후 다시 실행하세요.')
  process.exit(2)
}

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000'
const LANG = process.env.LANG_ID || 'ko'
const TIMEOUT = 60000
const SPEED = process.env.E2E_SPEED ?? '10'
const problems = []
const note = message => console.log('  ' + message)
const check = (ok, message) => { if (!ok) problems.push(message); console.log((ok ? '  ✓ ' : '  ✗ ') + message) }

const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {})
const page = await browser.newPage({ viewport: { width: 1536, height: 800 } })
page.setDefaultTimeout(TIMEOUT)
page.on('pageerror', error => problems.push('pageerror: ' + error))
page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) problems.push('console.error: ' + message.text().slice(0, 200)) })

// 버튼이 켜질 때까지 기다렸다가 누르고, 화면이 바뀔 시간(입자 전환 ~0.8초)을 준다.
const press = async selector => { await page.locator(selector).click(); await page.waitForTimeout(1800) }
const text = () => page.evaluate(() => document.querySelector('main')?.innerText ?? '')

try {
  console.log(`수동 단계 시험: ${BASE_URL} (lang=${LANG})`)
  await page.goto(`${BASE_URL}/?lang=${LANG}&target=gcp&manual=1&speed=${SPEED}`)

  // 소개 화면은 클릭하면 입자가 구로 모이고, 문장이 다 쓰이면 "예" 버튼이 나온다.
  // 개발 서버처럼 느린 첫 로드에서는 하이드레이션 전의 클릭이 무시되므로 "예" 버튼이 나올 때까지 클릭을 되풀이한다.
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.mouse.click(768, 400)
    if (await page.locator('.prompt-overlay').waitFor({ state: 'attached', timeout: 10000 }).then(() => true, () => false)) break
  }
  // 첫 화면에는 선택지 버튼이 없다: 발표자 단축키 I(예시 의도)로 말한 것처럼 넣어 설정 화면으로 간다.
  for (let attempt = 0; attempt < 10; attempt++) {
    await page.keyboard.press('i')
    if (await page.locator('.setup2').waitFor({ timeout: 6000 }).then(() => true, () => false)) break
  }
  note('소개 → 설정')
  // 설정 화면: 등록된 환경은 읽기 전용이다. 대상을 GCP로 고르면 플랫폼 기본 리전(asia-northeast3)이 보인다.
  check(await page.locator('input[name=accessKeyId], input[name=agentId], select[name=destRegion]').count() === 0, '설정 화면에 AWS 키·에이전트 ID·리전 입력이 없다')
  await page.locator('[role=radio]').first().click()
  await page.locator('.senv-card.is-selected[data-target=gcp]').waitFor()
  check((await page.locator('.senv-card.is-selected').innerText()).includes('asia-northeast3'), 'GCP 선택 시 대상 리전 기본값 asia-northeast3')
  await press('.migration-next')
  // 이전 범위 선택: 기본값(첫 워크로드)으로 분석 → 후보 확인 → 범위 확정해야 분석 단계로 넘어간다.
  await page.locator('.scope [data-scope-action=analyze]:not([disabled])').click()
  await page.locator('.scope-row').first().waitFor()
  check(await page.locator('.analysis-discovery-item').count() === 0, '범위 확정 전에는 다음 단계로 넘어가지 않는다')
  check(await page.locator('.scope-evi b[data-evidence=MANIFEST]').count() > 0, '범위 후보에 근거 배지가 보인다')
  await press('.scope [data-scope-action=confirm]')

  await press('.analysis-next-area button')
  note('분석 완료')
  check(true, '분석 → 샌드박스')

  await press('.flow-footer .flow-primary')
  note('샌드박스 통과')

  await press('.plan-next button')
  note('계획 완료')

  // 승인 화면: 이미지 대조가 일치로 보이고, 계획 수정 요청을 하면 계획 단계로 돌아가 버전이 올라간다.
  check(await page.locator('.approval-digest:not(.is-warn)').count() === 1, '승인 화면에 이미지 대조(일치)가 보인다')
  await press('.approval-actions .flow-secondary:nth-child(2)')
  // 계획 화면으로 돌아오면 메타 줄에 새 리비전이 보인다(넘어가기 전에 확인)
  await page.locator('.plan-meta').filter({ hasText: /(리비전|revision|リビジョン) 2/ }).waitFor({ timeout: 30000 }).then(() => check(true, '계획 수정 뒤 계획 리비전 2가 보인다'), () => check(false, '계획 수정 뒤 계획 리비전 2가 보인다'))
  await press('.plan-next button')
  check(/v2/.test(await page.locator('.approval-digest').innerText()), '승인 화면의 계획 버전이 v2다')
  await page.locator('.approval-check input').check()
  await page.locator('.approval-actions .flow-primary').first().click()
  // 승인은 기록 → 실행 엔진 전달을 거친다. 전달되기 전에는 승인 화면에 머문다(ADR-002).
  await page.waitForSelector('.approval-delivery').then(() => check(true, '승인 뒤 전달 상태가 보인다'), () => check(false, '승인 뒤 전달 상태가 보인다'))
  await page.waitForSelector('.approval-panel', { state: 'detached' })
  await page.waitForTimeout(1800)
  note('승인 전달됨')

  // 구축: 준비 상태 검사 3개와 같은 테스트 묶음 재실행이 끝나야 다음으로 넘어간다.
  await press('.flow-footer .flow-primary')
  check((await text()).length > 0, '구축·준비 검사 완료 → 데이터 복제')

  await press('.flow-footer .flow-primary')
  note('데이터 복제 준비 → DB 전환(백엔드 순서)')

  await page.locator('.cx-decide[data-gate=ready]').waitFor()
  await page.locator('.approval-check input').check()
  await press('.approval-actions .flow-primary')
  note('두 번째 승인(DB 전환)')
  // 전환 → 쓰기 중단 구간 재생 → 테이블 검증·합계 → 인계가 끝나면 "트래픽 전환으로"가 켜진다(합계 개수는 서버가 정한다).
  await page.waitForFunction(() => document.querySelectorAll('.cutover-tile').length >= 3)
  await page.waitForSelector('.flow-footer .flow-primary:not([disabled])')
  await press('.flow-footer .flow-primary')

  await page.locator('.traffic-layout').waitFor()
  const advance = page.locator('[data-testid=traffic-advance]')
  // 10% 통과 뒤 자동으로 넘어가지 않고 버튼이 나온다.
  await advance.waitFor({ timeout: 120000 })
  check(/10%/.test(await advance.innerText()) === false && /50%/.test(await advance.innerText()), '버튼에 다음 단계(50%)가 보인다: ' + (await advance.innerText()).trim())
  check(/10%/.test(await page.locator('.traffic-foot-note').innerText()), '대기 안내에 확인한 단계(10%)가 보인다')
  await page.waitForTimeout(3000)
  check(await advance.count() === 1 && await advance.isEnabled(), '기다려도 자동으로 넘어가지 않는다')
  check(await page.locator('.traffic-actions .flow-primary:not([disabled])').count() === 1, '대기 중에는 완료 버튼이 꺼져 있다(다음 단계 버튼만 켜짐)')
  await advance.click()
  // 누르면 버튼이 사라지고(중복 클릭 방지·다음 스냅숏) 50% 통과 뒤 다시 나온다.
  await page.waitForFunction(() => /50%/.test(document.querySelector('[data-testid=traffic-advance]')?.textContent ?? '') === false, null, { timeout: 120000 })
  await advance.waitFor({ timeout: 120000 })
  check(/100%/.test(await advance.innerText()), '50% 통과 뒤 버튼이 100%로 간다: ' + (await advance.innerText()).trim())
  await advance.click()
  await page.waitForSelector('.traffic-actions .flow-primary:not([disabled])', { timeout: 120000 })
  check(await advance.count() === 0, '100% 단계에는 대기·버튼이 없다')
  await press('.traffic-actions .flow-primary')
  await page.waitForSelector('.report-panel')
  note('트래픽 100% 이전 → 완료 리포트')
} catch (error) {
  problems.push('흐름 중단: ' + (error instanceof Error ? error.message.split('\n')[0] : String(error)))
  await page.screenshot({ path: process.env.SHOT || 'e2e-failure.png' }).catch(() => {})
}

await browser.close()
if (problems.length) {
  console.log('\n실패:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log('\n통과')
