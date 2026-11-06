import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uploadEnvFile, PlatformError, MAX_ENV_FILE_BYTES } from '../../src/lib/connections/platform.ts'
import { handleEnvUpload, handleEnvUploadMode, type EnvUploadDeps } from '../../src/lib/setup/envUpload.ts'
import { startRequestFor } from '../../src/lib/migration/events.ts'

const KEY = 'operator-key-not-real-123'
const SECRET = 'postgres-password-NOT-REAL-987'
const TEXT = `DATABASE_URL=postgresql://u:${SECRET}@db:5432/app\nENV_NAME=env-b\n`
const REF = { id: 'envf-abc', version: '1', sha256: 'a'.repeat(64) }

function fakePlatform(reply: (body: string) => Response) {
  const calls: { path: string; headers: Headers; body: string }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    calls.push({ path: new URL(String(input)).pathname, headers, body: String(init?.body) })
    if (headers.get('x-enrollment-admin-key') !== KEY) return Response.json({ detail: 'nope' }, { status: 403 })
    return reply(String(init?.body))
  }) as typeof fetch
  return { calls, fetchImpl }
}

test('업로드 클라이언트: 원문을 운영자 키와 함께 POST /env-files로 보내고 참조·키 이름만 돌려준다', async () => {
  const platform = fakePlatform(() => Response.json({ env_file_ref: { ...REF, version: 1 }, keys: ['DATABASE_URL', 'ENV_NAME'], warnings: [] }, { status: 201 }))
  const result = await uploadEnvFile({ base: 'http://platform.test/', enrollmentAdminKey: KEY, fetchImpl: platform.fetchImpl }, TEXT)
  assert.deepEqual(result, { env_file_ref: REF, keys: ['DATABASE_URL', 'ENV_NAME'], warnings: [] })
  assert.equal(platform.calls[0].path, '/env-files')
  assert.equal(platform.calls[0].body, TEXT)
  assert.match(platform.calls[0].headers.get('content-type') ?? '', /^text\/plain/)
  assert.ok(!JSON.stringify(result).includes(SECRET))
})

test('업로드 클라이언트: 오류는 코드만 남기고, 설정 누락은 목업으로 떨어지지 않는다', async () => {
  const tooLarge = fakePlatform(() => Response.json({ detail: { code: 'ENV_FILE_TOO_LARGE' } }, { status: 413 }))
  await assert.rejects(uploadEnvFile({ base: 'http://p.test', enrollmentAdminKey: KEY, fetchImpl: tooLarge.fetchImpl }, TEXT),
    (error: PlatformError) => error.status === 400 && error.detail === 'ENV_FILE_TOO_LARGE')
  const notUtf8 = fakePlatform(() => Response.json({ detail: { code: 'ENV_FILE_NOT_UTF8' } }, { status: 422 }))
  await assert.rejects(uploadEnvFile({ base: 'http://p.test', enrollmentAdminKey: KEY, fetchImpl: notUtf8.fetchImpl }, TEXT),
    (error: PlatformError) => error.code === 'bad_request' && error.detail === 'ENV_FILE_NOT_UTF8')
  const unconfigured = fakePlatform(() => Response.json({ detail: { code: 'ENV_FILE_STORE_UNCONFIGURED' } }, { status: 503 }))
  await assert.rejects(uploadEnvFile({ base: 'http://p.test', enrollmentAdminKey: KEY, fetchImpl: unconfigured.fetchImpl }, TEXT),
    (error: PlatformError) => error.code === 'unavailable' && error.detail === 'ENV_FILE_STORE_UNCONFIGURED')
  await assert.rejects(uploadEnvFile({ base: 'http://p.test', enrollmentAdminKey: '' }, TEXT), (error: PlatformError) => error.detail === 'PLATFORM_ADMIN_KEY_NOT_CONFIGURED')
  await assert.rejects(uploadEnvFile({ base: '', enrollmentAdminKey: KEY }, TEXT), (error: PlatformError) => error.detail === 'PLATFORM_API_BASE_NOT_CONFIGURED')
})

const post = (body: string) => new Request('http://web.test/api/env-files', { method: 'POST', body, headers: { 'content-type': 'text/plain' } })

test('BFF: 목업 모드는 업로드를 끄고(브라우저가 원문을 보내지 않게), 실제 모드는 참조만 돌려준다', async () => {
  const sent: string[] = []
  const real: EnvUploadDeps = { real: true, upload: async text => { sent.push(text); return { env_file_ref: REF, keys: ['DATABASE_URL'], warnings: [] } } }
  const mock: EnvUploadDeps = { real: false, upload: async () => { throw new Error('목업에서 부르면 안 된다') } }
  assert.deepEqual(await handleEnvUploadMode(mock).json(), { upload: false })
  assert.deepEqual(await handleEnvUploadMode(real).json(), { upload: true })

  const disabled = await handleEnvUpload(post(TEXT), mock)
  assert.equal(disabled.status, 409)
  const ok = await handleEnvUpload(post(TEXT), real)
  assert.equal(ok.status, 201)
  const body = await ok.text()
  assert.ok(!body.includes(SECRET))
  assert.deepEqual(JSON.parse(body).env_file_ref, REF)
  assert.deepEqual(sent, [TEXT])
})

test('BFF: 빈 파일·64KiB 초과는 플랫폼에 보내지 않고, 플랫폼 오류는 코드로 바꾼다', async () => {
  let called = 0
  const real: EnvUploadDeps = { real: true, upload: async () => { called += 1; throw new PlatformError(503, 'unavailable', 'ENV_FILE_STORE_UNCONFIGURED') } }
  assert.deepEqual(await (await handleEnvUpload(post('  \n'), real)).json(), { error: 'bad_request', detail: 'ENV_FILE_EMPTY' })
  assert.deepEqual(await (await handleEnvUpload(post('A=' + 'x'.repeat(MAX_ENV_FILE_BYTES)), real)).json(), { error: 'bad_request', detail: 'ENV_FILE_TOO_LARGE' })
  assert.equal(called, 0)
  const failed = await handleEnvUpload(post(TEXT), real)
  assert.equal(failed.status, 503)
  assert.deepEqual(await failed.json(), { error: 'unavailable', detail: 'ENV_FILE_STORE_UNCONFIGURED' })
})

test('시작 요청: 업로드 참조는 정확한 버전 그대로, 다른 필드는 섞지 않는다', () => {
  const request = startRequestFor('onprem', { agentId: 'laptop', envFileRef: { ...REF, extra: 'x' } as typeof REF })
  assert.deepEqual(request, { target: { provider: 'ON_PREM', profile: request.target.profile, agent_id: 'laptop' }, env_file_ref: REF })
  assert.equal(startRequestFor('gcp', {}).env_file_ref, undefined)
})
