'use client'

/**
 * 브라우저 쪽 TTS: /api/tts(Supertonic 3)에서 WAV를 받아 object URL로 돌려준다.
 * - 같은 문장은 한 번만 받는다(메모리 캐시, 미리 받기).
 * - 서버에 모델이 없으면(503) 잠시(30초) 서버를 부르지 않는다: 그동안은 녹음 파일이 있는 문장만 소리 내고 나머지는 글자로만 보인다.
 * - 처음 듣는 긴 답변은 CPU 합성에 시간이 걸리므로 넉넉히(30초) 기다리고, 시간 초과·연결 오류는 한 번 더 받아 본다.
 */
export type TtsLang = 'ko' | 'en' | 'ja'
export const TTS_VOICE = 'M1'
const TIMEOUT_MS = 30000
const DOWN_MS = 30000
const LIMIT = 80

const cache = new Map<string, Promise<string | null>>()
let downUntil = 0

const keyOf = (text: string, lang: TtsLang) => `${TTS_VOICE}|${lang}|${text}`

export function ttsUrlFor(text: string, lang: TtsLang) {
  return `/api/tts?${new URLSearchParams({ text, lang, voice: TTS_VOICE })}`
}

/** 문장의 음성(object URL). 서버를 쓸 수 없으면 null */
export function ttsAudio(text: string, lang: TtsLang): Promise<string | null> {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean || typeof window === 'undefined') return Promise.resolve(null)
  if (Date.now() < downUntil) return Promise.resolve(null)
  const key = keyOf(clean, lang)
  const hit = cache.get(key)
  if (hit) return hit
  const fetchOnce = () => fetch(ttsUrlFor(clean, lang), { signal: AbortSignal.timeout(TIMEOUT_MS) })
    .then(async response => {
      if (!response.ok) { if (response.status === 503) downUntil = Date.now() + DOWN_MS; return null }
      return URL.createObjectURL(await response.blob())
    })
  const job = fetchOnce().catch(() => fetchOnce()).catch(() => null)
  cache.set(key, job)
  // 실패한 문장은 다음에 다시 받아 본다.
  void job.then(url => { if (!url) cache.delete(key) })
  while (cache.size > LIMIT) {
    const oldest = cache.keys().next().value as string
    const stale = cache.get(oldest)
    cache.delete(oldest)
    void stale?.then(url => { if (url) URL.revokeObjectURL(url) })
  }
  return job
}

/** 곧 말할 문장을 미리 받아 둔다(보고가 큐에 들어올 때) */
export function prefetchTts(text: string, lang: TtsLang) { void ttsAudio(text, lang) }

/** 첫 화면에서 서버 모델을 미리 올린다. 모델이 없으면 바로 '서버 없음'으로 둔다. */
export function warmTts() {
  if (typeof window === 'undefined') return
  void fetch('/api/tts?warm=1').then(response => response.json() as Promise<{ available?: boolean }>)
    .then(body => { if (!body.available) downUntil = Date.now() + DOWN_MS })
    .catch(() => { downUntil = Date.now() + DOWN_MS })
}
