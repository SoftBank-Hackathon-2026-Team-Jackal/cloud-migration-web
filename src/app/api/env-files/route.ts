import { guard } from '../../../lib/connections/guard'
import { uploadEnvFile } from '../../../lib/connections/platform'
import { platformDeps, platformMode } from '../../../lib/connections/server'
import { handleEnvUpload, handleEnvUploadMode, type EnvUploadDeps } from '../../../lib/setup/envUpload'

export const dynamic = 'force-dynamic'

function deps(): EnvUploadDeps {
  return { real: platformMode() === 'real', upload: text => uploadEnvFile(platformDeps(), text) }
}

/** 이 서버가 .env를 플랫폼에 올리는지(브라우저는 false면 원문을 보내지 않는다) */
export function GET() {
  return handleEnvUploadMode(deps())
}

/** .env 원문 → 플랫폼 POST /env-files → {env_file_ref, keys, warnings}. 연결 관리와 같은 입구 검사(같은 출처·허용 계정)를 거친다. */
export async function POST(request: Request) {
  return (await guard(request)) ?? handleEnvUpload(request, deps())
}
