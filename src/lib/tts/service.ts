/**
 * /api/tts와 미리 생성 스크립트가 함께 쓰는 합성 서비스(서버 전용).
 * - 모델은 프로세스에 한 번만 올린다(개발 서버의 HMR에도 유지되도록 globalThis에 둔다).
 * - 캐시: 메모리(최근 200개) → 디스크(TTS_CACHE_DIR, 기본 .tts-cache) → 합성. 키는 목소리·언어·설정·문장의 해시다.
 * - 합성 직전에 spokenText(pronounce.ts)로 약어·코드·분수를 읽기 좋은 말로 바꾼다. 캐시 키도 바꾼 말로 만든다.
 * - 합성은 CPU를 다 쓰므로 한 번에 하나씩 한다(같은 문장을 동시에 요청하면 하나만 합성한다).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spokenText } from './pronounce.ts'
import { DEFAULT_VOICE, encodeWav, modelAvailable, modelDir, Supertonic, VOICES, type TtsLang, type Voice } from './supertonic.ts'

export const TTS_LANGS: readonly TtsLang[] = ['ko', 'en', 'ja']
export const MAX_TTS_CHARS = 400
/** 품질·속도 설정(바꾸면 캐시 키가 바뀐다). TTS_STEPS로 조정할 수 있다. */
const STEPS = Math.max(2, Math.min(16, Number(process.env.TTS_STEPS) || 8))
// 미리 녹음한 안내(scripts/generate-voice-clips.ts: M1·8단계·속도 1.0)와 같은 목소리가 되도록 맞춘다.
const SPEED = 1.0
const MEMORY_LIMIT = 200

export type TtsRequest = { text: string; lang: TtsLang; voice: Voice }
export type TtsResult = { audio: Buffer; cache: 'memory' | 'disk' | 'miss'; ms: number }

export function parseTtsRequest(body: unknown): TtsRequest | null {
  if (!body || typeof body !== 'object') return null
  const raw = body as Record<string, unknown>
  const text = typeof raw.text === 'string' ? raw.text.replace(/\s+/g, ' ').trim() : ''
  if (!text || text.length > MAX_TTS_CHARS) return null
  const lang = TTS_LANGS.includes(raw.lang as TtsLang) ? raw.lang as TtsLang : 'ko'
  const voice = VOICES.includes(raw.voice as Voice) ? raw.voice as Voice : DEFAULT_VOICE
  return { text, lang, voice }
}

export function cacheKey({ text, lang, voice }: TtsRequest): string {
  return createHash('sha1').update(['supertonic-3', voice, lang, STEPS, SPEED, text].join('\u0000')).digest('hex')
}

export function cacheDir(): string {
  // 실행 중에만 쓰는 캐시 폴더: 빌드 추적(Turbopack)이 프로젝트 전체를 서버 번들에 넣지 않게 한다.
  return resolve(/*turbopackIgnore: true*/ process.env.TTS_CACHE_DIR || join(/*turbopackIgnore: true*/ process.cwd(), '.tts-cache'))
}

type Shared = { engine?: Promise<Supertonic>; memory: Map<string, Buffer>; inflight: Map<string, Promise<Buffer>>; queue: Promise<unknown> }
const shared: Shared = ((globalThis as { __jackalTts?: Shared }).__jackalTts ??= { memory: new Map(), inflight: new Map(), queue: Promise.resolve() })

export function ttsAvailable(): boolean {
  return process.env.TTS_DISABLED !== '1' && modelAvailable()
}

function engine(): Promise<Supertonic> {
  if (!shared.engine) {
    shared.engine = Supertonic.load(modelDir())
    shared.engine.catch(() => { shared.engine = undefined })
  }
  return shared.engine
}

/** 모델을 미리 올린다(첫 요청의 지연을 줄인다). */
export function warmUp(): Promise<unknown> {
  return ttsAvailable() ? engine() : Promise.resolve()
}

function remember(key: string, audio: Buffer) {
  shared.memory.delete(key)
  shared.memory.set(key, audio)
  while (shared.memory.size > MEMORY_LIMIT) shared.memory.delete(shared.memory.keys().next().value as string)
}

/** 실제로 합성할 요청(말로 다듬은 문장). 같은 말이 되는 화면 문구들은 캐시를 함께 쓴다. */
export function spokenRequest(request: TtsRequest): TtsRequest {
  return { ...request, text: spokenText(request.text, request.lang) }
}

export async function synthesizeCached(original: TtsRequest): Promise<TtsResult> {
  const started = performance.now()
  const request = spokenRequest(original)
  const key = cacheKey(request)
  const hit = shared.memory.get(key)
  if (hit) { remember(key, hit); return { audio: hit, cache: 'memory', ms: performance.now() - started } }
  const file = join(cacheDir(), key + '.wav')
  if (existsSync(file)) {
    const audio = readFileSync(file)
    remember(key, audio)
    return { audio, cache: 'disk', ms: performance.now() - started }
  }
  if (!ttsAvailable()) throw new Error('tts_unavailable')
  let job = shared.inflight.get(key)
  if (!job) {
    job = shared.queue.then(async () => {
      const tts = await engine()
      const pcm = await tts.synthesize(request.text, { lang: request.lang, voice: request.voice, steps: STEPS, speed: SPEED })
      const audio = encodeWav(pcm, tts.sampleRate)
      mkdirSync(cacheDir(), { recursive: true })
      writeFileSync(file + '.part', audio)
      renameSync(file + '.part', file)
      remember(key, audio)
      return audio
    })
    shared.queue = job.catch(() => undefined)
    shared.inflight.set(key, job)
    void job.finally(() => shared.inflight.delete(key)).catch(() => undefined)
  }
  return { audio: await job, cache: 'miss', ms: performance.now() - started }
}
