import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { RECORDED_CLIPS } from '../../src/lib/voiceRecorded.ts'
import { isStartCommand, targetFromUtterance } from '../../src/lib/agent/intent.ts'
import { classifyEnv, crossCheck, envCounts, parseEnvKeys } from '../../src/lib/setup/envFile.ts'
import { DEMO_SCAN, EXAMPLE_ENV } from '../../src/lib/setup/demoRepo.ts'
import { detectStack, displayTree, runtimeFromDockerfile, scanPublicSource } from '../../src/lib/github/scan.ts'
import { createMockAgents, createMockConnections, resetMock } from '../../src/lib/connections/mock.ts'
import { agentState } from '../../src/lib/connections/types.ts'
import { ko } from '../../src/lib/i18n/ko.ts'
import { en } from '../../src/lib/i18n/en.ts'
import { ja } from '../../src/lib/i18n/ja.ts'

const clips = JSON.parse(readFileSync(new URL('../../src/lib/voiceClips.json', import.meta.url), 'utf8')) as Record<string, string>

test('발표자의 말에서 이전 대상을 고른다', () => {
  assert.equal(targetFromUtterance('AWS에 있는 채팅 서비스를 우리 사무실 서버로 옮기고 싶어'), 'onprem')
  assert.equal(targetFromUtterance('온프레미스 K3s로 옮겨 줘'), 'onprem')
  assert.equal(targetFromUtterance('구글 클라우드로 옮기자'), 'gcp')
  assert.equal(targetFromUtterance('Move our chat service on AWS to our office servers'), 'onprem')
  assert.equal(targetFromUtterance('AWSのチャットサービスを社内サーバーに移したい'), 'onprem')
  assert.equal(targetFromUtterance('GCP GKE'), 'gcp')
  assert.equal(targetFromUtterance('on-prem K3s'), 'onprem')
  // 모호하면 되묻는다
  assert.equal(targetFromUtterance('채팅 서비스를 옮기고 싶어'), null)
  assert.equal(targetFromUtterance('사무실 서버랑 GCP 중에 어디가 나아?'), null)
})

test('"좋아, 시작하자"를 시작 명령으로 받는다', () => {
  assert.ok(isStartCommand('좋아, 시작하자'))
  assert.ok(isStartCommand("OK, let's start"))
  assert.ok(!isStartCommand('지금 무슨 단계야?'))
})

test('.env는 키 이름만 꺼내고 값은 돌려주지 않는다', () => {
  const text = '# comment\nPORT=8080\nexport NODE_ENV=production\nDATABASE_URL="postgres://u:hunter2@db/x"\nJWT_SECRET=s3cr3t-value\nEMPTY=\nQUOTED=""\nnot a line\n'
  const keys = parseEnvKeys(text)
  assert.deepEqual(keys.map(key => key.name), ['PORT', 'NODE_ENV', 'DATABASE_URL', 'JWT_SECRET', 'EMPTY', 'QUOTED'])
  const serialized = JSON.stringify(keys)
  for (const secret of ['8080', 'production', 'hunter2', 's3cr3t-value', 'postgres://']) assert.ok(!serialized.includes(secret), 'value leaked: ' + secret)
  assert.deepEqual(Object.keys(keys[0]).sort(), ['empty', 'name'])
  assert.equal(keys.find(key => key.name === 'EMPTY')?.empty, true)
  assert.equal(keys.find(key => key.name === 'QUOTED')?.empty, true)
})

test('.env 분류는 받은 데이터(EnvExceptions)만 따른다: 원본 전용·대상 DB 연결·코드만 읽음·그 밖의 처리', () => {
  const keys0 = parseEnvKeys('PORT=1\nAWS_REGION=x\nDATABASE_URL=y\nREDIS_URL=z\nJWT_SECRET=\n')
  // 분류 데이터가 없으면 이름으로 짐작하지 않는다(JWT_SECRET도 분류 대기)
  assert.deepEqual(classifyEnv(keys0, null).map(row => row.treatment), ['pending', 'pending', 'pending', 'pending', 'pending'])
  const rows = classifyEnv(keys0, { excluded: ['AWS_REGION'], replaced: { DATABASE_URL: 'db/url', REDIS_URL: '' }, missing: ['LOG_LEVEL'], others: 'COPY' })
  assert.deepEqual(rows.map(row => [row.name, row.treatment, row.ref ?? null]), [
    ['PORT', 'others', null], ['AWS_REGION', 'excluded', null], ['DATABASE_URL', 'replaced', 'db/url'], ['REDIS_URL', 'replaced', null], ['JWT_SECRET', 'others', null], ['LOG_LEVEL', 'missing', null],
  ])
  assert.equal(rows.find(row => row.name === 'JWT_SECRET')?.empty, true)
  assert.equal(rows[0].others, 'COPY', '그 밖의 처리는 데이터 값 그대로')
  // others가 없으면(확인 대기) 나머지는 분류 대기
  assert.equal(classifyEnv(keys0, { excluded: [], replaced: {}, missing: [] })[0].treatment, 'pending')
  // 목업 저장소 + 예시 .env
  const demo = envCounts(classifyEnv(parseEnvKeys(EXAMPLE_ENV), DEMO_SCAN.env_exceptions))
  assert.deepEqual(demo, { others: 4, replaced: 2, excluded: 1, missing: 1, pending: 0 })
  assert.ok(!JSON.stringify(classifyEnv(parseEnvKeys(EXAMPLE_ENV), DEMO_SCAN.env_exceptions)).includes('example-not-a-real-secret'), '값이 줄에 없다')
})

test('코드가 읽는 키와 대조한다', () => {
  const keys = parseEnvKeys('PORT=1\nDATABASE_URL=x\nJWT_SECRET=y\nREDIS_URL=\nEXTRA=1')
  const check = crossCheck(keys, ['PORT', 'DATABASE_URL', 'JWT_SECRET', 'REDIS_URL', 'LOG_LEVEL'])
  assert.deepEqual(check.present, ['PORT', 'DATABASE_URL', 'JWT_SECRET'])
  assert.deepEqual(check.missing, ['REDIS_URL', 'LOG_LEVEL'])
  assert.deepEqual(check.extra, ['EXTRA'])
  assert.equal(check.expected, 5)
})

test('저장소 구성에서 런타임·Dockerfile·K8s·PostgreSQL·환경 변수 키를 찾는다', () => {
  const paths = ['package.json', 'tsconfig.json', 'Dockerfile', 'k8s/deployment.yaml', 'k8s/service.yaml', 'src/server.ts', '.env.example']
  const result = detectStack(paths, {
    'package.json': JSON.stringify({ engines: { node: '>=20' }, dependencies: { pg: '^8', express: '^4' }, devDependencies: { typescript: '^5' } }),
    Dockerfile: 'FROM node:20 AS build\nRUN npm ci\nFROM node:20-slim\n',
    '.env.example': 'PORT=8080\nDATABASE_URL=postgres://example\n# c\nJWT_SECRET=\n',
  })
  assert.deepEqual(result.detections.map(item => item.kind), ['runtime', 'dockerfile', 'k8s', 'postgres', 'env'])
  assert.deepEqual(result.detections[0], { kind: 'runtime', name: 'Node.js 20', evidence: 'Dockerfile' })
  // Dockerfile이 없으면 의존성 파일로 짐작하고, 언어(TypeScript) 이름은 붙이지 않는다
  assert.deepEqual(detectStack(['package.json', 'tsconfig.json'], { 'package.json': JSON.stringify({ engines: { node: '20' }, devDependencies: { typescript: '^5' } }) }).detections[0],
    { kind: 'runtime', name: 'Node.js 20', evidence: 'package.json' })
  assert.deepEqual(result.detections[1], { kind: 'dockerfile', evidence: 'Dockerfile', stages: 2 })
  assert.deepEqual(result.detections[2], { kind: 'k8s', count: 2, evidence: 'k8s/' })
  assert.deepEqual(result.env_keys, ['PORT', 'DATABASE_URL', 'JWT_SECRET'])
  // 탐지 결과에 파일 내용(예: 접속 문자열)이 섞이지 않는다
  assert.ok(!JSON.stringify(result).includes('postgres://example'))
})

test('Dockerfile 기반 이미지에서 런타임을 짐작한다', () => {
  assert.equal(runtimeFromDockerfile('FROM golang:1.22 AS build\nFROM gcr.io/distroless/static'), 'Go 1.22')
  assert.equal(runtimeFromDockerfile('FROM --platform=linux/amd64 python:3.12-slim'), 'Python 3.12')
  assert.equal(runtimeFromDockerfile('FROM eclipse-temurin:21-jre'), 'Java 21')
  assert.equal(runtimeFromDockerfile('FROM node:20 AS build\nFROM gcr.io/distroless/nodejs20'), 'Node.js 20')
  assert.equal(runtimeFromDockerfile('FROM alpine:3.20'), null)
})

test('파일 목록은 상한까지만, node_modules는 빼고 보여 준다', () => {
  const paths = ['node_modules/x/index.js', ...Array.from({ length: 60 }, (_, index) => 'src/f' + String(index).padStart(2, '0') + '.ts'), 'package.json']
  const shown = displayTree(paths, 10)
  assert.equal(shown.tree.length, 10)
  assert.ok(shown.truncated)
  assert.ok(shown.tree.includes('package.json'))
  assert.ok(!shown.tree.some(path => path.startsWith('node_modules')))
})

test('스캔은 고정한 커밋의 트리와 구성 파일만 읽고 원문을 돌려주지 않는다', async () => {
  const sha = 'b'.repeat(40)
  const asked: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    asked.push(url.pathname + url.search)
    if (url.pathname === '/repos/octo/svc/git/trees/' + sha) return Response.json({ tree: [
      { path: 'package.json', type: 'blob', size: 100 }, { path: 'src', type: 'tree' }, { path: 'src/main.ts', type: 'blob', size: 10 },
      { path: '.env.example', type: 'blob', size: 30 },
    ] })
    if (url.pathname === '/repos/octo/svc/contents/package.json') return new Response(JSON.stringify({ dependencies: { pg: '1' } }))
    if (url.pathname === '/repos/octo/svc/contents/.env.example') return new Response('A=secret-a\nB=secret-b\n')
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  const scan = await scanPublicSource({ token: 't', fetchImpl, apiBase: 'https://gh.test' }, 'octo/svc', sha)
  assert.deepEqual(scan.env_keys, ['A', 'B'])
  assert.ok(scan.tree.includes('src/'))
  assert.ok(!asked.some(path => path.includes('main.ts')), '소스 파일은 읽지 않는다')
  assert.ok(!JSON.stringify(scan).includes('secret-a'))
  await assert.rejects(scanPublicSource({ token: 't', fetchImpl, apiBase: 'https://gh.test' }, 'octo/svc', 'main'))
})

test('등록 환경 목업은 [가정] 통합 목록 형태를 따른다', async () => {
  const now = Date.parse('2026-11-05T00:00:10Z')
  resetMock(now)
  const connections = await createMockConnections({ delayMs: 0, now: () => now }).listConnections()
  assert.deepEqual(connections.map(item => [item.kind, item.status]), [['AWS_SOURCE', 'CONNECTED'], ['GCP_TARGET', 'CONNECTED']])
  const agent = await createMockAgents({ now: () => now }).getAgent('office-seoul-01')
  assert.equal(agentState(agent, Math.floor(now / 1000)), 'online')
})

test('자칼의 고정 문구는 한국어 사전과 녹음 목록이 같다(녹음 파일 이름으로 찾는다)', () => {
  assert.equal(ko['open.jackal.listening'], clips.listening)
  assert.equal(ko['open.jackal.askTarget'], clips.ask_target)
  assert.equal(ko['open.jackal.kickoff'], clips.analysis_kickoff)
})

test('오프닝 문구는 세 언어에 모두 있고 변수 이름이 같다', () => {
  const vars = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join(',')
  for (const key of Object.keys(ko).filter(name => name.startsWith('open.') || name.startsWith('setup2.'))) {
    const k = key as keyof typeof ko
    assert.ok(en[k] && ja[k], 'missing translation: ' + key)
    assert.equal(vars(en[k]), vars(ko[k]), 'en vars: ' + key)
    assert.equal(vars(ja[k]), vars(ko[k]), 'ja vars: ' + key)
  }
  // 자칼의 말은 두 문장까지
  for (const key of Object.keys(ko).filter(name => name.startsWith('open.jackal.'))) {
    const sentences = ko[key as keyof typeof ko].split(/[.?!](\s|$)/).filter(part => part.trim().length > 1)
    assert.ok(sentences.length <= 2, 'too long: ' + key)
  }
})

test('녹음 목록은 public/voice의 mp3와 같고, 모두 voiceClips에 있다', () => {
  const files = readdirSync(new URL('../../public/voice/', import.meta.url)).filter(name => name.endsWith('.mp3')).map(name => name.replace(/\.mp3$/, '')).sort()
  assert.deepEqual([...RECORDED_CLIPS].sort(), files)
  for (const id of RECORDED_CLIPS) assert.ok(clips[id], 'not in voiceClips: ' + id)
})
