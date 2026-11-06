#!/usr/bin/env node
/**
 * GitHub 로그인 → 공개 저장소 검색·페이지 이동 → 선택 → 시작 요청 시험(헤드리스).
 * 가짜 GitHub API 서버와 시험용 세션 쿠키(시험용 AUTH_SECRET으로 직접 만든 JWT)만 쓴다. 실제 GitHub 호출은 하지 않는다.
 * 이 시험이 지금 빌드(.next)로 앱을 직접 띄운다(포트 3411). 빌드할 때의 모드와 같은 환경변수로 실행한다.
 *   npm run build && npm run test:e2e:github                                                        (목업 모드)
 *   NEXT_PUBLIC_API_MODE=sse npm run build && NEXT_PUBLIC_API_MODE=sse npm run test:e2e:github        (SSE, 백엔드 연결 대기)
 *   NEXT_PUBLIC_API_MODE=sse NEXT_PUBLIC_SSE_START=source npm run build && NEXT_PUBLIC_API_MODE=sse NEXT_PUBLIC_SSE_START=source npm run test:e2e:github
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
const { encode } = await import('@auth/core/jwt')

const MODE = process.env.NEXT_PUBLIC_API_MODE === 'sse' ? 'sse' : 'mock'
const START = process.env.NEXT_PUBLIC_SSE_START === 'source' ? 'source' : process.env.NEXT_PUBLIC_SSE_START === 'legacy' ? 'legacy' : 'wait'
const API = (process.env.NEXT_PUBLIC_API_BASE || 'http://127.0.0.1:8000').replace(/\/+$/, '')
const PORT = Number(process.env.PORT || 3411)
const BASE = 'http://127.0.0.1:' + PORT
const SECRET = 'e2e-auth-secret-not-real-0123456789'
const GOOD_TOKEN = 'gho_e2e_token_not_real'
const EXPIRED_TOKEN = 'gho_e2e_expired'
const SHA = '0123456789abcdef0123456789abcdef01234567'
const problems = []
const check = (ok, message) => { if (!ok) problems.push(message); console.log((ok ? '  ✓ ' : '  ✗ ') + message) }
console.log(`모드: ${MODE}${MODE === 'sse' ? ' / ' + START : ''}`)

// ---- 가짜 GitHub API: 공개 22개 + 비공개 3개, 갱신 순 ----
const repos = Array.from({ length: 25 }, (_, index) => {
  const id = 1000 + index
  const hidden = index % 9 === 4
  return { id, full_name: 'octo/' + (index === 7 ? 'needle-service' : 'repo-' + String(index).padStart(2, '0')), default_branch: index === 7 ? 'trunk' : 'main',
    description: hidden ? 'secret stuff' : 'demo repository ' + index, html_url: 'https://github.com/octo/x' + index, updated_at: '2026-10-01T00:00:00Z',
    private: hidden, visibility: hidden ? 'private' : 'public', owner: { login: 'octo' }, permissions: { admin: true } }
})
const TREE = [['package.json', 'blob'], ['Dockerfile', 'blob'], ['k8s', 'tree'], ['k8s/deploy.yaml', 'blob'], ['src', 'tree'], ['src/index.js', 'blob'], ['.env.example', 'blob']]
const FILES = {
  'package.json': JSON.stringify({ dependencies: { pg: '^8' } }),
  Dockerfile: 'FROM node:20\n',
  'k8s/deploy.yaml': 'kind: Deployment\n',
  'src/index.js': 'SOURCE_MARKER_DO_NOT_READ',
  '.env.example': 'PORT=ENV_VALUE_MARKER\nDATABASE_URL=ENV_VALUE_MARKER\n',
}
const githubCalls = []
const github = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  githubCalls.push({ path: url.pathname + url.search, auth: req.headers.authorization })
  const json = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }
  if (req.headers.authorization === 'Bearer ' + EXPIRED_TOKEN) return json(401, { message: 'Bad credentials' })
  if (req.headers.authorization !== 'Bearer ' + GOOD_TOKEN) return json(401, { message: 'Requires authentication' })
  if (url.pathname === '/user/repos') {
    const page = Number(url.searchParams.get('page') || 1)
    const perPage = Number(url.searchParams.get('per_page') || 30)
    // 실제 GitHub처럼 visibility=public이면 공개만 주지만, 서버가 한 번 더 거르는지 보려고 비공개도 섞어 돌려준다.
    const slice = repos.slice((page - 1) * perPage, page * perPage)
    const next = page * perPage < repos.length ? { link: `<https://api.github.com/user/repos?page=${page + 1}>; rel="next"` } : {}
    return json(200, slice, next)
  }
  const byId = url.pathname.match(/^\/repositories\/(\d+)$/)
  if (byId) { const found = repos.find(item => item.id === Number(byId[1])); return found ? json(200, found) : json(404, {}) }
  if (/^\/repos\/octo\/[^/]+\/commits\/[^/]+$/.test(url.pathname)) { res.writeHead(200); return res.end(SHA) }
  // 저장소 구성 읽기(/api/github/scan): 트리와 구성 파일. 소스 파일(src/index.js)은 읽히면 안 된다.
  if (url.pathname === '/repos/octo/needle-service/git/trees/' + SHA) return json(200, { tree: TREE.map(([path, type]) => ({ path, type, size: 40 })) })
  const content = url.pathname.match(/^\/repos\/octo\/needle-service\/contents\/(.+)$/)
  if (content && FILES[decodeURIComponent(content[1])] !== undefined) { res.writeHead(200); return res.end(FILES[decodeURIComponent(content[1])]) }
  json(404, { message: 'Not Found' })
})
await new Promise(resolve => github.listen(0, '127.0.0.1', resolve))
const GITHUB = 'http://127.0.0.1:' + github.address().port

const app = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(PORT)], {
  env: { ...process.env, AUTH_GITHUB_ID: 'e2e-client-id', AUTH_GITHUB_SECRET: 'e2e-client-secret', AUTH_SECRET: SECRET, GITHUB_API_BASE: GITHUB, AUTH_URL: '', PLATFORM_CONNECTIONS: 'mock' },
  stdio: 'ignore',
})
async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(url); if (r.ok) return } catch { /* 아직 */ }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('앱이 뜨지 않았습니다: ' + url)
}

const sessionCookie = async accessToken => ({
  name: 'authjs.session-token', domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax',
  value: await encode({ token: { name: 'Octo Cat', picture: null, sub: '1', accessToken, login: 'octo' }, secret: SECRET, salt: 'authjs.session-token', maxAge: 3600 }),
})

let browser
try {
  await waitFor(BASE + '/api/auth/providers')
  browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {})

  async function open(token) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    if (token) await context.addCookies([await sessionCookie(token)])
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    const bodies = []
    page.on('pageerror', error => problems.push('pageerror: ' + error))
    page.on('response', async response => {
      if (new URL(response.url()).origin === BASE && /^\/api\//.test(new URL(response.url()).pathname)) bodies.push(await response.text().catch(() => ''))
    })
    await page.goto(BASE + '/?stage=setup&target=gcp&lang=ko&speed=' + (process.env.E2E_SPEED ?? '10'))
    await page.waitForSelector('.migration-setup')
    return { context, page, bodies }
  }

  console.log('로그인 전')
  {
    const { context, page } = await open(null)
    await page.waitForSelector('.repo-login')
    check(true, 'GitHub 로그인 버튼이 보인다')
    const next = page.locator('.migration-next')
    if (MODE === 'sse') check(await next.isDisabled(), 'SSE: 저장소를 고르기 전에는 "다음"이 막혀 있다')
    else check(!(await next.isDisabled()), '목업: 저장소 없이도 데모로 진행할 수 있다')
    // 로그인 버튼 → GitHub 인증 화면으로 가는 주소: repo 권한을 요청하지 않는다.
    let authorizeUrl = null
    await page.route('https://github.com/**', route => { authorizeUrl = route.request().url(); return route.abort() })
    const visited = []
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) visited.push(frame.url()) })
    await page.click('.repo-login')
    for (let i = 0; i < 40 && !authorizeUrl; i++) await page.waitForTimeout(100)
    const authorize = authorizeUrl ? new URL(authorizeUrl) : null
    check(authorize?.pathname === '/login/oauth/authorize', 'GitHub OAuth 인증 주소로 보낸다')
    check(authorize?.searchParams.get('scope') === 'read:user', 'scope는 read:user뿐이다 (repo 없음): ' + authorize?.searchParams.get('scope'))
    // Next가 127.0.0.1을 localhost로 바꿔 콜백 주소를 만들므로, 로그인은 localhost로 옮겨 가서 시작한다(상태 쿠키와 콜백이 같은 호스트).
    check(authorize?.searchParams.get('redirect_uri') === 'http://localhost:' + PORT + '/api/auth/callback/github', '콜백 주소: ' + authorize?.searchParams.get('redirect_uri'))
    check(visited.some(url => url.startsWith('http://localhost:' + PORT + '/') && url.includes('github_login=1')), '127.0.0.1에서 누르면 localhost로 옮겨 로그인을 시작한다')
    await context.close()
  }

  console.log('세션: 토큰은 서버 JWT에만')
  {
    const cookie = await sessionCookie(GOOD_TOKEN)
    const session = await fetch(BASE + '/api/auth/session', { headers: { cookie: cookie.name + '=' + cookie.value } }).then(r => r.text())
    check(session.includes('"login":"octo"'), '세션에 로그인 이름이 있다')
    check(!session.includes(GOOD_TOKEN) && !/access/i.test(session), '세션 응답에 GitHub 토큰이 없다')
  }

  console.log('토큰 만료')
  {
    const { context, page } = await open(EXPIRED_TOKEN)
    await page.waitForSelector('.repo-auth [role="alert"]')
    check((await page.textContent('.repo-auth')).includes('만료'), '만료 안내와 다시 로그인 버튼이 보인다')
    await context.close()
  }

  console.log('공개 저장소 목록·검색·페이지·선택')
  {
    const { context, page, bodies } = await open(GOOD_TOKEN)
    await page.waitForSelector('.repo-item')
    const names = await page.locator('.repo-item strong').allTextContents()
    check(names.length > 0 && names.length <= 8, '첫 쪽 공개 저장소 ' + names.length + '개')
    check(!names.some(name => repos.find(item => item.full_name === name)?.private), '비공개 저장소는 보이지 않는다')
    check((await page.textContent('.repo-viewer')).includes('octo'), '로그인 계정이 보인다')
    await page.click('.repo-pager button:last-child')
    await page.waitForFunction(() => document.querySelector('.repo-pager span')?.textContent?.includes('2'))
    const second = await page.locator('.repo-item strong').allTextContents()
    check(second.length > 0 && second[0] !== names[0], '다음 쪽으로 넘어간다')
    await page.click('.repo-pager button:first-child')
    await page.waitForFunction(() => document.querySelector('.repo-pager span')?.textContent?.includes('1'))
    check(true, '이전 쪽으로 돌아온다')
    await page.fill('input[name="repositorySearch"]', 'needle')
    await page.waitForFunction(() => document.querySelectorAll('.repo-item').length === 1)
    check((await page.textContent('.repo-item strong')) === 'octo/needle-service', '검색어로 거른다')
    await page.fill('input[name="repositorySearch"]', 'secret')
    await page.waitForFunction(() => document.querySelector('.repo-note')?.textContent?.includes('없어요'))
    check(true, '비공개 저장소의 설명으로는 찾을 수 없다(빈 결과 안내)')
    await page.fill('input[name="repositorySearch"]', 'needle')
    await page.waitForSelector('.repo-item')
    await page.click('.repo-item')
    await page.waitForSelector('.repo-pinned')
    const pinned = await page.textContent('.repo-pinned')
    check(pinned.includes('octo/needle-service') && pinned.includes('trunk') && pinned.includes(SHA.slice(0, 7)), '기본 브랜치 커밋 SHA로 고정됐다')
    check(bodies.every(body => !body.includes(GOOD_TOKEN)), '/api 응답 어디에도 토큰이 없다')
    // 고른 저장소의 구성만 읽어 파일 목록과 탐지 결과를 보여 준다(소스 원문·.env 예시 값은 화면으로 오지 않는다).
    await page.waitForSelector('.rimp[data-complete=true]', { timeout: 15000 })
    check(await page.locator('.rimp-det.is-on').count() >= 4, '가져오기: 런타임·Dockerfile·K8s·PostgreSQL 탐지가 켜진다 (' + await page.locator('.rimp-det.is-on').count() + ')')
    check(!githubCalls.some(call => call.path.includes('src/index.js')), '가져오기: 소스 파일은 읽지 않는다')
    check(bodies.every(body => !body.includes('ENV_VALUE_MARKER') && !body.includes('SOURCE_MARKER')), '가져오기: /api 응답에 .env 예시 값·소스 원문이 없다')
    check(!(await page.locator('.migration-next').isDisabled()), '저장소를 고르면 "다음"이 열린다')

    const posts = []
    await page.route(API + '/migrations**', async route => {
      const request = route.request()
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/migrations') {
        posts.push(request.postDataJSON())
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'm-e2e' }) })
      }
      return route.fulfill({ status: 404, body: '' })
    })
    await page.click('.migration-next')
    // 목업·SSE source: 이전 범위를 확정해야 시작한다(SSE wait는 범위 선택 전에 대기 안내).
    if (MODE === 'mock' || START !== 'wait') {
      await page.click('.scope [data-scope-action=analyze]:not([disabled])')
      await page.click('.scope [data-scope-action=confirm]:not([disabled])')
    }
    if (MODE === 'mock') {
      await page.waitForSelector('.analysis-discovery-item', { timeout: 20000 })
      check(posts.length === 0, '목업: 분석 화면으로 넘어가고 백엔드는 부르지 않는다')
    } else if (START === 'wait') {
      await page.waitForSelector('.repo-pending')
      await page.waitForTimeout(500)
      check((await page.textContent('.repo-pending')).includes('백엔드 연결 대기'), 'SSE wait: "백엔드 연결 대기"를 보여 준다')
      check(posts.length === 0, 'SSE wait: POST /migrations를 부르지 않는다')
      check(await page.locator('.migration-setup').count() === 1, 'SSE wait: 분석 화면으로 넘어가지 않는다')
    } else {
      for (let i = 0; i < 50 && posts.length === 0; i++) await page.waitForTimeout(100)
      const source = posts[0]?.source
      check(source?.kind === 'GITHUB_PUBLIC' && source.repository_id === 1007 && source.full_name === 'octo/needle-service' && source.commit_sha === SHA, 'SSE source: 시작 요청에 source가 실린다 ' + JSON.stringify(source))
      check(posts[0] && !('env_file_ref' in posts[0]) && !JSON.stringify(posts[0]).includes(GOOD_TOKEN), 'SSE source: env 참조·토큰을 보내지 않는다')
    }
    await context.close()
  }

  if (MODE === 'sse' && START !== 'legacy') {
    console.log('주소로 단계를 바로 연 경우')
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const posts = []
    await page.route(API + '/**', route => { if (route.request().method() === 'POST') posts.push(route.request().url()); return route.fulfill({ status: 404, body: '' }) })
    await page.goto(BASE + '/?stage=analysis&target=gcp&lang=ko&speed=' + (process.env.E2E_SPEED ?? '10'))
    await page.waitForSelector('[role="alert"][aria-label="백엔드 연결 대기"]')
    await page.waitForTimeout(500)
    check(posts.length === 0, '저장소 없이 단계를 열면 POST /migrations 없이 대기 안내를 보여 준다')
    await context.close()
  }
} catch (error) {
  problems.push(String(error?.stack || error))
} finally {
  await browser?.close()
  app.kill()
  github.close()
}

if (problems.length) {
  console.error('\n실패:\n- ' + problems.join('\n- '))
  process.exit(1)
}
console.log('\n모두 통과')
