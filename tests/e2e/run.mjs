/**
 * e2e 묶음을 한 번에(동시에) 돌린다.
 *
 *   node tests/e2e/run.mjs flow opening          # 고른 묶음만
 *   node tests/e2e/run.mjs all                   # flow · opening · review · agent · github
 *
 * BASE_URL이 없으면 빌드된 앱(`npm run build` 필요)을 빈 포트에서 `next start`로 띄우고 끝나면 내린다.
 * 목업 시계는 E2E_SPEED(기본 10)배로 돈다. 각 묶음의 출력은 끝난 순서대로 한꺼번에 보인다.
 * 콘솔 오류 중 `/favicon.ico` 404만 있는 실패는 알려진 문제로 따로 표시한다.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const ALL = ['flow', 'opening', 'review', 'agent', 'github', 'settings']
const asked = process.argv.slice(2)
const suites = asked.length === 0 || asked.includes('all') ? ALL : asked
const unknown = suites.filter(name => !ALL.includes(name) && name !== 'sse-states')
if (unknown.length) { console.error('모르는 묶음: ' + unknown.join(', ')); process.exit(2) }

const freePort = () => new Promise(resolve => {
  const server = createServer()
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)) })
})

async function waitFor(url, ms = 60000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try { if ((await fetch(url)).status < 500) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error('앱이 뜨지 않았습니다: ' + url)
}

let app = null
let base = process.env.BASE_URL
if (!base) {
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  app = spawn('npx', ['next', 'start', '-H', '127.0.0.1', '-p', String(port)], { stdio: 'ignore' })
  await waitFor(base)
}

const started = Date.now()
const run = name => new Promise(resolve => {
  const began = Date.now()
  const child = spawn(process.execPath, [`tests/e2e/${name}.mjs`], { env: { ...process.env, BASE_URL: base, E2E_SPEED: process.env.E2E_SPEED ?? '10' } })
  let out = ''
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { out += chunk })
  child.on('close', code => {
    const failures = out.split('\n').filter(line => line.startsWith('- '))
    const onlyFavicon = code !== 0 && failures.length > 0 && failures.every(line => /404 \(Not Found\)/.test(line))
    const seconds = ((Date.now() - began) / 1000).toFixed(1)
    console.log(`\n===== ${name} · ${code === 0 ? '통과' : onlyFavicon ? '통과(알려진 favicon 404만)' : '실패'} · ${seconds}s =====`)
    console.log(out.trimEnd())
    resolve({ name, ok: code === 0 || onlyFavicon, seconds })
  })
})

try {
  // 한꺼번에 너무 많이 띄우면 노트북에서 페이지 로드가 시간 초과로 실패한다: 동시에 E2E_PARALLEL(기본 3)개까지만.
  const limit = Math.max(1, Number(process.env.E2E_PARALLEL) || 3)
  const queue = [...suites]
  const results = []
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) results.push(await run(queue.shift()))
  }))
  console.log(`\n요약 (${((Date.now() - started) / 1000).toFixed(1)}s, 목업 시계 ×${process.env.E2E_SPEED ?? '10'})`)
  for (const result of results) console.log(`  ${result.ok ? '✓' : '✗'} ${result.name} ${result.seconds}s`)
  process.exitCode = results.every(result => result.ok) ? 0 : 1
} finally {
  app?.kill('SIGTERM')
}
