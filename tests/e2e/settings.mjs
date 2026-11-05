#!/usr/bin/env node
/**
 * /settings 연결 관리 시험(헤드리스). 실제 플랫폼 대신 같은 경로·응답을 흉내 내는 가짜 플랫폼 API를 띄운다.
 * Agent 등록 토큰 발급 → 설치 명령 → 상태 조회 → 폐기는 "실제 API 경로"(웹 서버 → 가짜 플랫폼)로,
 * AWS·GCP·통합 목록·범위 선택은 웹 서버의 목업 어댑터로 끝까지 누른다.
 * 운영자 키·등록 토큰이 브라우저 번들·저장소·주소·콘솔·다른 응답에 나오지 않는지도 본다.
 * 이 시험이 지금 빌드(.next)로 앱을 직접 띄운다(포트 3412).
 *   npm run build && node tests/e2e/settings.mjs          (SHOTS=dir 를 주면 1536×860 스크린숏)
 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('playwright')) } catch {
  console.error('playwright를 찾지 못했습니다. `npm i --no-save playwright` 후 다시 실행하세요.')
  process.exit(2)
}

const PORT = Number(process.env.PORT || 3412)
const BASE = 'http://127.0.0.1:' + PORT
const KEY = 'e2e-operator-key-NOT-REAL-7d1c'
const PUBLIC_URL = 'https://cmp.e2e.example'
const SHOTS = process.env.SHOTS || ''
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const problems = []
const check = (ok, message) => { if (!ok) problems.push(message); console.log((ok ? '  ✓ ' : '  ✗ ') + message) }

// ---- 가짜 플랫폼 API(cmp_api.routes.agents와 같은 경로·응답·오류) ----
const agents = new Map()
const issued = []
let rejectKey = false
const platformCalls = []
const platform = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  let raw = ''
  for await (const chunk of req) raw += chunk
  platformCalls.push({ method: req.method, path: url.pathname, key: req.headers['x-enrollment-admin-key'], origin: req.headers.origin ?? null })
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  // 시험 조작용(웹 서버는 부르지 않는다)
  if (url.pathname === '/__test/register') { const a = agents.get(url.searchParams.get('id')); if (a) { a.registered = true; a.last_seen_at = Math.floor(Date.now() / 1000) - 3 } return json(200, {}) }
  if (url.pathname === '/__test/reject') { rejectKey = url.searchParams.get('on') === '1'; return json(200, {}) }
  if (rejectKey || req.headers['x-enrollment-admin-key'] !== KEY) return json(403, { detail: 'Enrollment administration unavailable' })
  if (req.method === 'POST' && url.pathname === '/agent-enrollments') {
    const body = JSON.parse(raw || '{}')
    if (agents.has(body.agent_id)) return json(409, { detail: 'AGENT_ID_RESERVED' })
    const token = 'tok_' + Math.random().toString(36).slice(2) + '_E2E_SECRET'
    issued.push({ body, token })
    agents.set(body.agent_id, { owner_id: body.owner_id, registered: false, last_seen_at: null, revoked: false })
    return json(200, { enrollment_token: token, expires_in_seconds: body.ttl_seconds })
  }
  const match = url.pathname.match(/^\/agent-admin\/agents\/([^/]+)(\/revoke)?$/)
  const agent = match && agents.get(decodeURIComponent(match[1]))
  if (!match || !agent?.registered) return json(404, { detail: 'AGENT_NOT_FOUND' })
  if (match[2] && req.method === 'POST') agent.revoked = true
  json(200, { agent_id: match[1], owner_id: agent.owner_id, cluster_uid: 'e2e-cluster-uid', last_seen_at: agent.last_seen_at, revoked: agent.revoked })
})
await new Promise(resolve => platform.listen(0, '127.0.0.1', resolve))
const PLATFORM = 'http://127.0.0.1:' + platform.address().port
const control = path => fetch(PLATFORM + path)

const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(PORT)], {
  env: { ...process.env, PLATFORM_API_BASE: PLATFORM, PLATFORM_ENROLLMENT_ADMIN_KEY: KEY, PLATFORM_PUBLIC_URL: PUBLIC_URL, PLATFORM_OWNER_ID: 'platform', PLATFORM_KNOWN_AGENT_IDS: '' },
  stdio: 'ignore',
})
async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(url); if (r.ok) return } catch { /* 아직 */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('앱이 뜨지 않았습니다: ' + url)
}

function walk(dir) {
  return readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path] })
}

let browser
try {
  console.log('번들: 운영자 키 값·헤더 이름·플랫폼 운영 경로가 클라이언트 정적 파일에 없다(환경변수 이름은 안내 문구에만 있다)')
  {
    const files = walk('.next/static').filter(path => /\.(js|css|html)$/.test(path))
    const hits = files.filter(path => { const text = readFileSync(path, 'utf8'); return text.includes(KEY) || /X-Enrollment-Admin-Key|agent-enrollments|agent-admin/i.test(text) })
    check(files.length > 0 && hits.length === 0, `정적 파일 ${files.length}개 중 운영자 키 헤더·플랫폼 운영 경로를 담은 파일 ${hits.length}개 ${hits.slice(0, 3).join(', ')}`)
  }

  await waitFor(BASE + '/api/connections')
  browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {})
  const context = await browser.newContext({ viewport: { width: 1536, height: 860 } })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  const consoleText = []
  const requests = []
  const bodies = []
  page.on('pageerror', error => problems.push('pageerror: ' + error))
  page.on('console', message => { consoleText.push(message.text()); if (message.type() === 'error' && !/favicon|status of 409/.test(message.text() + (message.location()?.url ?? ''))) problems.push('console.error: ' + message.text().slice(0, 200)) })
  page.on('request', request => requests.push({ url: request.url(), headers: request.headers(), body: request.postData() ?? '' }))
  page.on('response', async response => {
    const url = new URL(response.url())
    if (url.origin === BASE) bodies.push({ path: url.pathname, method: response.request().method(), text: await response.text().catch(() => '') })
  })
  const shot = async name => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }) }

  await page.goto(BASE + '/settings?lang=ko')
  await page.waitForSelector('.cx-card[data-kind=AWS_SOURCE]')
  console.log('AWS [가정·목업]')
  check(await page.locator('input[name*=ccess], input[name*=ecret], input[type=password]').count() === 0, 'AWS Access Key·Secret 입력란이 없다')
  check((await page.locator('.cx-card[data-kind=AWS_SOURCE]').innerText()).includes('chat-prod'), '원본 카드에 계정·리전·EKS 클러스터가 보인다')
  await shot('settings-1-aws')

  await page.click('[data-action=aws-connect]')
  await page.waitForSelector('.cx-dialog')
  await page.click('.cx-option:has(input[value=AWS_SOURCE])')
  check(await page.locator('.cx-dialog input[name=displayName]').count() === 1 && await page.locator('.cx-dialog select[name=region]').count() === 1, '#23 요청 형태: 표시 이름·리전')
  await page.fill('input[name=displayName]', 'e2e-source')
  await page.click('[data-step=create]')
  await page.waitForSelector('[data-launch-stack]')
  const launch = page.locator('[data-launch-stack]')
  const href = await launch.getAttribute('href')
  check(href?.startsWith('https://console.aws.amazon.com/cloudformation/') && href.includes('quickcreate') && (await launch.getAttribute('target')) === '_blank', 'Launch Stack: 새 탭으로 CloudFormation 빠른 생성')
  const externalId = await page.textContent('[data-external-id]')
  check(/^cmp-ext-/.test(externalId ?? '') && await page.locator('.cx-readonly input').count() === 0, 'External ID는 읽기 전용 + 복사 버튼')
  await page.fill('input[name=roleArn]', 'arn:aws:iam::12345:role/x')
  await page.click('[data-step=verify]')
  check(await page.locator('.cx-invalid').count() === 1, 'RoleArn 형식 검증(12자리 계정)')
  await page.fill('input[name=roleArn]', 'arn:aws:iam::210987654321:role/cmp-denied')
  await page.click('[data-step=verify]')
  await page.waitForSelector('.cx-dialog [data-error]')
  const failText = await page.textContent('.cx-dialog [data-error]')
  check(failText.includes('ASSUME_ROLE_DENIED') && failText.includes('External ID'), '실패: 오류 코드와 신뢰 정책·External ID 안내')
  await shot('settings-2-aws-denied')
  await page.fill('input[name=roleArn]', 'arn:aws:iam::210987654321:role/cmp-source-readonly')
  await page.click('[data-step=verify]')
  await page.waitForSelector('.cx-pass')
  check((await page.textContent('.cx-pass')).includes('210987654321'), '성공: 계정 ID·리전·EKS 목록')
  await shot('settings-3-aws-verified')
  await page.click('[data-step=close]')
  await page.waitForFunction(() => document.querySelectorAll('.cx-card[data-kind=AWS_SOURCE]').length === 2)
  check(true, '새 원본 연결이 목록에 생긴다')

  const added = page.locator('.cx-card[data-kind=AWS_SOURCE]').nth(1)
  await added.locator('.cx-menu-btn').click()
  await added.locator('[data-action=delete]').click()
  await page.waitForSelector('.cx-dialog')
  check((await page.textContent('.cx-dialog')).includes('CloudFormation 스택을 삭제'), '삭제 확인: 플랫폼 정보만 지운다 · 스택은 직접 삭제')
  await page.click('[data-confirm=yes]')
  await page.waitForFunction(() => document.querySelectorAll('.cx-card[data-kind=AWS_SOURCE]').length === 1)
  check(true, '삭제하면 카드가 사라진다')

  console.log('GCP [가정·목업]')
  await page.click('[data-tab=gcp]')
  await page.waitForSelector('.cx-card[data-kind=GCP_TARGET]')
  await page.locator('.cx-card[data-kind=GCP_TARGET] [data-action=verify]').click()
  await page.waitForFunction(() => document.querySelector('.cx-card[data-kind=GCP_TARGET]')?.getAttribute('aria-busy') === 'false')
  check((await page.textContent('.cx-card[data-kind=GCP_TARGET]')).includes('cmp-demo'), '고정 프로젝트 카드 · 연결 확인')
  check(await page.locator('.cx-soon fieldset[disabled]').count() === 1 && await page.locator('input[type=file]').count() === 0, 'WIF 폼은 "곧 지원"으로 비활성, 서비스 계정 키 업로드 없음')
  await shot('settings-4-gcp')

  console.log('Agent (실제 API 경로 → 가짜 플랫폼)')
  await page.click('[data-tab=agent]')
  await page.waitForSelector('.cx-empty')
  check(true, '빈 목록 안내')
  await page.click('[data-action=agent-add]')
  await page.fill('input[name=agentId]', 'Laptop_K3s')
  await page.click('[data-step=issue]')
  check(await page.locator('.cx-invalid').count() >= 1 && issued.length === 0, 'agent_id 규칙(소문자·숫자·-) 위반이면 보내지 않는다')
  await page.fill('input[name=agentId]', 'laptop-k3s')
  await page.fill('input[name=ttlMinutes]', '15')
  await page.click('[data-step=issue]')
  await page.waitForSelector('[data-install-command]')
  const token = issued[0]?.token
  check(issued[0]?.body?.owner_id === 'platform' && issued[0].body.cluster_uid === null && issued[0].body.ttl_seconds === 900, '플랫폼에 owner_id·agent_id·cluster_uid:null·ttl_seconds 900으로 요청')
  const command = await page.textContent('[data-install-command]')
  check(command === `helm install cmp-agent oci://ghcr.io/softbank-hackathon-2026-team-jackal/charts/onprem-agent --version 0.1.0 -n cmp-system --create-namespace --set agentId=laptop-k3s --set platform.url=${PUBLIC_URL} --set enrollmentToken=${token}`, '설치 명령 템플릿(platform.url은 웹 서버 설정값)')
  check(/^1[45]:\d\d$/.test(await page.textContent('[data-countdown]')), '남은 시간 카운트다운 ' + await page.textContent('[data-countdown]'))
  check((await page.textContent('.cx-dialog')).includes('다시 볼 수 없어요'), '한 번만 보여 준다는 안내')
  await page.locator('.cx-secret').first().locator('.cx-copy').click()
  check((await page.evaluate(() => navigator.clipboard.readText())) === command, '설치 명령 복사')
  await shot('settings-5-agent-token')

  // 토큰은 발급 응답에만: 저장소·주소·콘솔·다른 응답에 남지 않는다
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href + document.cookie)
  check(!storage.includes(token), '토큰이 localStorage·sessionStorage·주소·쿠키에 없다')
  await page.click('[data-step=done]')
  await page.waitForSelector('.cx-card[data-agent=laptop-k3s]')
  check(!(await page.content()).includes(token), '창을 닫으면 화면(DOM)에서 토큰이 사라진다')
  check((await page.locator('.cx-card[data-agent=laptop-k3s]').getAttribute('data-state')) === 'pending', '설치 전: 설치 대기')

  await control('/__test/register?id=laptop-k3s')
  const card = page.locator('.cx-card[data-agent=laptop-k3s]')
  await card.locator('.cx-menu-btn').click()
  await card.locator('[data-action=check]').click()
  await page.waitForFunction(() => document.querySelector('.cx-card[data-agent=laptop-k3s]')?.getAttribute('data-state') === 'online')
  check((await card.innerText()).includes('e2e-cluster-uid') && await card.locator('.cx-tunnel').count() === 1, '등록 후: 온라인 · 클러스터 UID · 터널 상태(목업)')
  check(!(await card.innerText()).includes('Agent 버전'), 'Agent 버전(늘 null)은 자리도 보이지 않는다')
  await shot('settings-6-agent-online')

  await card.locator('.cx-menu-btn').click()
  await card.locator('[data-action=revoke]').click()
  check((await page.textContent('.cx-dialog')).includes('되돌릴 수 없어요'), '폐기 확인: 되돌릴 수 없다는 안내')
  await page.click('[data-confirm=yes]')
  await page.waitForFunction(() => document.querySelector('.cx-card[data-agent=laptop-k3s]')?.getAttribute('data-state') === 'revoked')
  check(platformCalls.some(call => call.method === 'POST' && call.path === '/agent-admin/agents/laptop-k3s/revoke'), '폐기: POST /agent-admin/agents/{id}/revoke')
  await shot('settings-7-agent-revoked')

  console.log('오류 상태')
  await page.click('[data-action=agent-add]')
  await page.fill('input[name=agentId]', 'laptop-k3s')
  await page.click('[data-step=issue]')
  await page.waitForSelector('.cx-dialog [data-error=conflict]')
  check((await page.textContent('.cx-dialog [data-error]')).includes('AGENT_ID_RESERVED'), '409: 이미 쓰는 Agent ID')
  await page.click('.cx-dialog [data-step=cancel]')
  await control('/__test/reject?on=1')
  await page.reload()
  await page.click('[data-tab=agent]')
  await page.waitForSelector('[data-error=operator_key]')
  check(true, '403: 운영자 키 문제 안내')
  await shot('settings-8-operator-key')
  await control('/__test/reject?on=0')

  console.log('네트워크: 브라우저는 같은 출처의 /api만 부르고 운영자 키를 보내지도 받지도 않는다')
  check(requests.every(request => new URL(request.url).origin === BASE), '브라우저 요청은 모두 웹 서버(같은 출처)로')
  check(requests.every(request => !JSON.stringify(request.headers).toLowerCase().includes('admin-key') && !request.body.includes(KEY)), '요청 헤더·본문에 운영자 키가 없다')
  check(bodies.every(body => !body.text.includes(KEY)), '어떤 응답에도 운영자 키가 없다')
  const withToken = bodies.filter(body => token && body.text.includes(token))
  check(withToken.length === 1 && withToken[0].path === '/api/agents' && withToken[0].method === 'POST', '토큰은 발급 응답(POST /api/agents) 한 번에만')
  check(!consoleText.some(line => token && line.includes(token)), '콘솔에 토큰이 없다')
  check(platformCalls.every(call => call.key === KEY || rejectKey === false) && platformCalls.every(call => call.origin === null), '플랫폼은 웹 서버만 부른다(Origin 없음)')

  console.log('다른 출처의 상태 변경 요청은 막는다')
  {
    const response = await fetch(BASE + '/api/agents', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: 'evil-one' }) })
    check(response.status === 400 && !agents.has('evil-one'), '다른 Origin의 발급 요청 거절')
  }
  await context.close()
} catch (error) {
  problems.push(String(error?.stack || error))
} finally {
  await browser?.close()
  app.kill()
  platform.close()
}

if (problems.length) {
  console.error('\n실패:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log('\n모두 통과')
