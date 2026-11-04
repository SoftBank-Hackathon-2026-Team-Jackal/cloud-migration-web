#!/usr/bin/env node
/**
 * 에이전트 질문(헤이 자칼, 지금 무슨 단계야?) 시험(헤드리스). 임시 백엔드(/api/agent)까지 거친다.
 *   npm run build 를 먼저 해 두면 된다. 이 시험이 앱을 직접 띄운다(포트 3401~3403).
 * 시나리오
 *   1) 모델 답변: 가짜 Anthropic 서버를 가리키게 하고 키(시험용 값)를 서버 환경변수로만 준다 → 답이 모델 답으로 표시되고,
 *      상태 요약이 서버에 도착하고, 키가 브라우저로 새지 않는다.
 *   2) 키 없음: 규칙 기반 답으로 대신한다.
 *   3) 모델 서버 장애(500): 규칙 기반 답으로 대신한다.
 * 가짜 서버와 시험용 키만 쓴다. 실제 모델 호출은 하지 않는다.
 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
let chromium
try { ({ chromium } = require('playwright')) } catch {
  console.error('playwright를 찾지 못했습니다. `npm i --no-save playwright` 후 다시 실행하세요.')
  process.exit(2)
}

const problems = []
const check = (ok, message) => { if (!ok) problems.push(message); console.log((ok ? '  ✓ ' : '  ✗ ') + message) }
const TEST_KEY = 'test-key-not-real'

// ---- 가짜 모델 서버 ----
const received = []
let fakeMode = 'ok'
const fake = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    received.push({ url: req.url, key: req.headers['x-api-key'], body: body ? JSON.parse(body) : null })
    if (fakeMode === 'fail') { res.writeHead(500); return res.end('{"error":"boom"}') }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ content: [{ type: 'text', text: '모델 답변: 지금은 트래픽 단계예요.' }] }))
  })
})
await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve))
const fakeUrl = 'http://127.0.0.1:' + fake.address().port

function startApp(port, env) {
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
    env: { ...process.env, ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', AGENT_PROVIDER: '', ...env }, stdio: 'ignore',
  })
  return child
}
async function waitFor(url) {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(url); if (r.ok) return } catch { /* 아직 */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('앱이 뜨지 않았습니다: ' + url)
}

const browser = await chromium.launch()
async function ask(port, text) {
  const page = await browser.newPage({ viewport: { width: 1536, height: 800 } })
  const browserRequests = []
  page.on('request', request => browserRequests.push({ url: request.url(), headers: request.headers(), body: request.postData() }))
  await page.goto(`http://127.0.0.1:${port}/?lang=ko&stage=traffic&target=gcp`)
  await page.waitForTimeout(4000)
  // 시연 중에는 위젯이 접혀 있다: 눌러서 열고, 입력창에 질문을 쓴다.
  await page.locator('.jv-pill').click()
  await page.locator('.jv-form input').fill(text)
  await page.locator('.jv-form input').press('Enter')
  await page.waitForSelector('[data-agent-source]', { timeout: 20000 })
  const result = {
    source: await page.locator('[data-agent-source]').last().getAttribute('data-agent-source'),
    caption: await page.locator('.jv-msg.is-agent p').last().innerText(),
    userMessage: await page.locator('.jv-msg.is-user p').last().innerText(),
    reports: await page.locator('[data-msg-tag="report"]').count(),
    html: await page.content(),
    browserRequests,
  }
  await page.close()
  return result
}

const apps = []
try {
  console.log('1) 모델 답변')
  apps.push(startApp(3401, { ANTHROPIC_API_KEY: TEST_KEY, ANTHROPIC_BASE_URL: fakeUrl }))
  await waitFor('http://127.0.0.1:3401/')
  fakeMode = 'ok'
  const first = await ask(3401, '지금 무슨 단계야?')
  check(first.source === 'model', '모델 답으로 표시된다')
  check(first.caption.includes('모델 답변'), '답이 채팅에 보인다')
  check(first.userMessage === '지금 무슨 단계야?', '내가 한 질문도 채팅에 남는다')
  check(first.reports >= 1, '음성 안내 문구(보고)도 채팅에 남는다')
  const call = received.at(-1)
  check(call && call.url === '/v1/messages' && call.key === TEST_KEY, '서버가 모델 서버에 키를 붙여 호출한다')
  const prompt = call?.body?.messages?.[0]?.content ?? ''
  check(prompt.includes('화면 단계: 트래픽') && prompt.includes('질문: 지금 무슨 단계야?'), '현재 상태 요약과 질문이 모델에 전달된다')
  check(typeof call?.body?.system === 'string' && call.body.system.includes('자칼'), '시스템 지침이 서버에서 붙는다')
  const leaked = first.html.includes(TEST_KEY) || first.browserRequests.some(item => JSON.stringify(item.headers).includes(TEST_KEY) || (item.body ?? '').includes(TEST_KEY))
  check(!leaked, '키가 브라우저(화면·요청)로 새지 않는다')

  console.log('3) 모델 서버 장애')
  fakeMode = 'fail'
  const failed = await ask(3401, '뭐가 문제야?')
  check(failed.source === 'local', '장애 때는 규칙 기반 답으로 대신한다')
  check(failed.caption.length > 5, '그래도 답이 나온다')

  console.log('2) 키 없음')
  apps.push(startApp(3402, {}))
  await waitFor('http://127.0.0.1:3402/')
  const local = await ask(3402, '로그 읊어줘')
  check(local.source === 'local', '키가 없으면 규칙 기반 답이다')
  check(local.caption.length > 5, '답이 화면에 보인다')
  const api = await fetch('http://127.0.0.1:3402/api/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '안녕', context: '', lang: 'ko' }) })
  const apiBody = await api.json()
  check(api.status === 200 && apiBody.answer === null && apiBody.provider === 'none', 'API는 키가 없으면 provider none으로 답한다')
  const bad = await fetch('http://127.0.0.1:3402/api/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '  ' }) })
  check(bad.status === 400, '빈 질문은 400')
} catch (error) {
  problems.push('중단: ' + (error instanceof Error ? error.message : String(error)))
} finally {
  await browser.close()
  for (const app of apps) app.kill()
  fake.close()
}

if (problems.length) { console.error('\n실패:\n- ' + problems.join('\n- ')); process.exit(1) }
console.log('\n통과')
