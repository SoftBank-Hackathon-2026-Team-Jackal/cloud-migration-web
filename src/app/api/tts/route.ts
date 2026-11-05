/**
 * 자칼의 목소리: Supertonic 3(로컬 ONNX)으로 문장을 합성해 WAV로 돌려준다. 외부 TTS 서비스를 부르지 않는다.
 *   GET  /api/tts?text=…&lang=ko|en|ja&voice=M1   (브라우저 캐시가 그대로 쓰도록 같은 문장은 같은 주소)
 *   POST /api/tts {text, lang, voice}
 * 모델이 없으면(SUPERTONIC_DIR에 모델 없음, TTS_DISABLED=1) 503을 돌려주고 화면은 브라우저 음성 합성으로 읽는다.
 * 응답 헤더 x-tts-cache(memory|disk|miss)·x-tts-ms로 지연을 잴 수 있다.
 */
import { parseTtsRequest, synthesizeCached, ttsAvailable, warmUp } from '../../../lib/tts/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function respond(body: unknown) {
  const request = parseTtsRequest(body)
  if (!request) return Response.json({ error: 'bad_request' }, { status: 400 })
  try {
    const { audio, cache, ms } = await synthesizeCached(request)
    return new Response(new Uint8Array(audio), {
      headers: {
        'content-type': 'audio/wav',
        'content-length': String(audio.length),
        'cache-control': 'public, max-age=31536000, immutable',
        'x-tts-cache': cache,
        'x-tts-ms': ms.toFixed(0),
      },
    })
  } catch (error) {
    const unavailable = error instanceof Error && error.message === 'tts_unavailable'
    if (!unavailable) console.error('[tts]', error)
    return Response.json({ error: unavailable ? 'tts_unavailable' : 'tts_failed' }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  // ?warm=1: 모델만 올리고 바로 답한다(첫 화면에서 미리 부른다).
  if (params.get('warm') === '1') {
    void warmUp().catch(() => undefined)
    return Response.json({ available: ttsAvailable() }, { headers: { 'cache-control': 'no-store' } })
  }
  return respond({ text: params.get('text'), lang: params.get('lang'), voice: params.get('voice') })
}

export async function POST(request: Request) {
  return respond(await request.json().catch(() => null))
}
