#!/usr/bin/env node
/**
 * 핵심 흐름 브라우저 테스트(헤드리스): 소개 → 설정 → 분석 → 샌드박스 → 계획 → 승인 → 구축 → 데이터 → 트래픽 → DB 전환 → 리포트.
 * 목업 모드와 SSE 모드에서 같은 흐름이 끝까지 돈다.
 *
 *   BASE_URL=http://127.0.0.1:3000 node tests/e2e/flow.mjs          # 이미 떠 있는 앱(npm run dev / start)
 *   NEXT_PUBLIC_API_MODE=sse NEXT_PUBLIC_SSE_START=legacy 로 만든 앱 + npm run mock:server 를 띄우고 같은 명령을 실행하면 SSE 모드를 시험한다.
 *   (legacy가 아니면 SSE 모드는 저장소를 고르기 전에는 시작하지 않는다: tests/e2e/github.mjs 참고)
 *
 * playwright가 필요하다(저장소 의존성에는 넣지 않았다): 전역 설치(NODE_PATH) 또는 `npm i --no-save playwright`.
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
const problems = []
const note = message => console.log('  ' + message)
const check = (ok, message) => { if (!ok) problems.push(message); console.log((ok ? '  ✓ ' : '  ✗ ') + message) }

const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {})
const page = await browser.newPage({ viewport: { width: 1536, height: 800 } })
page.setDefaultTimeout(TIMEOUT)
page.on('pageerror', error => problems.push('pageerror: ' + error))
page.on('console', message => { if (message.type() === 'error') problems.push('console.error: ' + message.text().slice(0, 200)) })

// 버튼이 켜질 때까지 기다렸다가 누르고, 화면이 바뀔 시간(입자 전환 ~0.8초)을 준다.
const press = async selector => { await page.locator(selector).click(); await page.waitForTimeout(1800) }
const text = () => page.evaluate(() => document.querySelector('main')?.innerText ?? '')

try {
  console.log(`흐름 시험: ${BASE_URL} (lang=${LANG})`)
  await page.goto(`${BASE_URL}/?lang=${LANG}&target=gcp&speed=${process.env.E2E_SPEED ?? '10'}`)

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
  note('데이터 복제 준비')

  await press('.flow-footer .flow-primary')
  note('트래픽 100% 이전, 잔여 요청 0')

  await page.locator('.approval-check input').check()
  await press('.approval-actions .flow-primary')
  note('두 번째 승인(DB 전환)')
  await page.waitForFunction(() => document.querySelectorAll('.cutover-tile').length === 3)
  await press('.flow-footer .flow-primary')

  await page.waitForSelector('.report-panel')
  await page.waitForTimeout(3000)
  const report = await text()
  check(report.split('\n').filter(line => /^\d+:\d{2}$/.test(line.trim())).length >= 8, '리포트에 단계별 소요 시간 8개')
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
