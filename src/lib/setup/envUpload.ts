import { MAX_ENV_FILE_BYTES, PlatformError, type EnvFileUploaded } from '../connections/platform.ts'

/**
 * /api/env-files의 본체(BFF). 브라우저는 .env 원문을 우리 웹 서버로만 보내고, 웹 서버가 운영자 키를 붙여 플랫폼에 넘긴다.
 * - 목업 모드(PLATFORM_CONNECTIONS=mock·개발 서버)에서는 업로드하지 않는다: GET이 upload=false를 알려 주고, 브라우저는 원문을 보내지 않는다.
 * - 원문은 응답·로그에 넣지 않는다. 응답은 참조(env_file_ref)와 키 이름뿐이다.
 */
export type EnvUploadDeps = { real: boolean; upload: (text: string) => Promise<EnvFileUploaded> }

const json = (status: number, body: object) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

/** GET /api/env-files → 이 서버가 .env를 플랫폼에 올리는지 */
export function handleEnvUploadMode(deps: EnvUploadDeps): Response {
  return json(200, { upload: deps.real })
}

/** POST /api/env-files (본문: .env 원문 text/plain) → {env_file_ref, keys, warnings} */
export async function handleEnvUpload(request: Request, deps: EnvUploadDeps): Promise<Response> {
  if (!deps.real) return json(409, { error: 'conflict', detail: 'ENV_UPLOAD_DISABLED' })
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > MAX_ENV_FILE_BYTES) return json(400, { error: 'bad_request', detail: 'ENV_FILE_TOO_LARGE' })
  let text: string
  try { text = await request.text() } catch { return json(400, { error: 'bad_request' }) }
  if (new TextEncoder().encode(text).length > MAX_ENV_FILE_BYTES) return json(400, { error: 'bad_request', detail: 'ENV_FILE_TOO_LARGE' })
  if (!text.trim()) return json(400, { error: 'bad_request', detail: 'ENV_FILE_EMPTY' })
  try {
    return json(201, await deps.upload(text))
  } catch (error) {
    if (error instanceof PlatformError) return json(error.status, error.detail ? { error: error.code, detail: error.detail } : { error: error.code })
    return json(502, { error: 'platform_error' })
  }
}
