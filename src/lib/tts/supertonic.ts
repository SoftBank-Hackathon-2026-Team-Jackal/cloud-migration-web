/**
 * Supertonic 3 음성 합성(서버 전용, onnxruntime-node).
 * supertone-inc/supertonic의 공식 Node 예제(nodejs/helper.js, MIT)를 TypeScript로 옮기고 배열 대신 Float32Array를 쓴다.
 * 모델(ONNX 4개 + 설정 + 목소리 JSON)은 scripts/download-tts-model.mjs로 SUPERTONIC_DIR(기본 ~/.cache/supertonic-3)에 받는다.
 * 모델 라이선스: BigScience Open RAIL-M (public/voice/LICENSE-SUPERTONIC.txt).
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type * as Ort from 'onnxruntime-node'

export type TtsLang = 'ko' | 'en' | 'ja'
export const VOICES = ['M1', 'M2', 'M3', 'M4', 'M5', 'F1', 'F2', 'F3', 'F4', 'F5'] as const
export type Voice = typeof VOICES[number]
/** 미리 녹음한 안내(scripts/generate-voice-clips.ts)와 같은 목소리 */
export const DEFAULT_VOICE: Voice = 'M1'

export function modelDir(): string {
  return process.env.SUPERTONIC_DIR || join(homedir(), '.cache', 'supertonic-3')
}

export function modelAvailable(dir = modelDir()): boolean {
  return existsSync(join(dir, 'onnx', 'vector_estimator.onnx')) && existsSync(join(dir, 'onnx', 'tts.json'))
}

type Config = { ae: { sample_rate: number; base_chunk_size: number }; ttl: { chunk_compress_factor: number; latent_dim: number } }
type Style = { ttl: Ort.Tensor; dp: Ort.Tensor }

const REPLACE: Array<[string, string]> = [
  ['–', '-'], ['‑', '-'], ['—', '-'], ['_', ' '], ['“', '"'], ['”', '"'], ['‘', "'"], ['’', "'"],
  ['´', "'"], ['`', "'"], ['[', ' '], [']', ' '], ['|', ' '], ['/', ' '], ['#', ' '], ['→', ' '], ['←', ' '], ['·', ', '],
  ['@', ' at '],
]

/** 공식 예제의 전처리와 같다(이모지·기호 정리, 끝 문장부호, 언어 태그). */
export function preprocess(text: string, lang: TtsLang): string {
  let value = text.normalize('NFKD')
  value = value.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, '')
  for (const [from, to] of REPLACE) value = value.replaceAll(from, to)
  value = value.replace(/[♥☆♡©\\]/g, '')
  value = value.replace(/ ([,.!?;:'])/g, '$1').replace(/\s+/g, ' ').trim()
  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(value)) value += '.'
  return `<${lang}>${value}</${lang}>`
}

/** 문장 단위로 나눈다(한국어·일본어 120자, 영어 300자: 공식 예제와 같다). */
export function chunkText(text: string, lang: TtsLang): string[] {
  const max = lang === 'en' ? 300 : 120
  const chunks: string[] = []
  for (const paragraph of text.trim().split(/\n\s*\n+/).map(part => part.trim()).filter(Boolean)) {
    let current = ''
    for (const sentence of paragraph.split(/(?<=[.!?。！？])\s+/)) {
      if (current.length + sentence.length + 1 <= max) current += (current ? ' ' : '') + sentence
      else { if (current) chunks.push(current); current = sentence }
    }
    if (current) chunks.push(current)
  }
  return chunks.length ? chunks : [text]
}

export class Supertonic {
  private styles = new Map<Voice, Style>()
  // Node의 타입 지우기(스크립트·테스트)가 읽을 수 있도록 생성자 매개변수 속성을 쓰지 않는다.
  private ort: typeof Ort
  private dir: string
  private cfg: Config
  private indexer: number[]
  private dp: Ort.InferenceSession
  private textEnc: Ort.InferenceSession
  private vectorEst: Ort.InferenceSession
  private vocoder: Ort.InferenceSession
  private constructor(ort: typeof Ort, dir: string, cfg: Config, indexer: number[], sessions: Ort.InferenceSession[]) {
    this.ort = ort
    this.dir = dir
    this.cfg = cfg
    this.indexer = indexer
    this.dp = sessions[0]
    this.textEnc = sessions[1]
    this.vectorEst = sessions[2]
    this.vocoder = sessions[3]
  }

  get sampleRate() { return this.cfg.ae.sample_rate }

  static async load(dir = modelDir()): Promise<Supertonic> {
    const ort = await import('onnxruntime-node')
    const onnx = join(dir, 'onnx')
    const cfg = JSON.parse(readFileSync(join(onnx, 'tts.json'), 'utf8')) as Config
    const indexer = JSON.parse(readFileSync(join(onnx, 'unicode_indexer.json'), 'utf8')) as number[]
    const options: Ort.InferenceSession.SessionOptions = { graphOptimizationLevel: 'all' }
    const sessions = await Promise.all(
      ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'].map(name => ort.InferenceSession.create(join(onnx, name + '.onnx'), options)))
    return new Supertonic(ort, dir, cfg, indexer, sessions)
  }

  private style(voice: Voice): Style {
    const cached = this.styles.get(voice)
    if (cached) return cached
    const raw = JSON.parse(readFileSync(join(this.dir, 'voice_styles', voice + '.json'), 'utf8')) as Record<'style_ttl' | 'style_dp', { dims: number[]; data: unknown[] }>
    const tensor = (part: { dims: number[]; data: unknown[] }) => new this.ort.Tensor('float32', Float32Array.from(part.data.flat(Infinity) as number[]), part.dims)
    const style = { ttl: tensor(raw.style_ttl), dp: tensor(raw.style_dp) }
    this.styles.set(voice, style)
    return style
  }

  private async infer(chunk: string, lang: TtsLang, style: Style, steps: number, speed: number): Promise<Float32Array> {
    const { Tensor } = this.ort
    const processed = Array.from(preprocess(chunk, lang))
    const length = processed.length
    const ids = BigInt64Array.from(processed.map(char => BigInt(this.indexer[char.charCodeAt(0)] ?? 0)))
    const textIds = new Tensor('int64', ids, [1, length])
    const textMask = new Tensor('float32', new Float32Array(length).fill(1), [1, 1, length])

    const { duration } = await this.dp.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask })
    const seconds = (duration.data as Float32Array)[0] / speed
    const { text_emb: textEmb } = await this.textEnc.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask })

    const { sample_rate: rate, base_chunk_size: base } = this.cfg.ae
    const factor = this.cfg.ttl.chunk_compress_factor
    const dim = this.cfg.ttl.latent_dim * factor
    const chunkSize = base * factor
    const wavLength = Math.floor(seconds * rate)
    const latentLength = Math.floor((wavLength + chunkSize - 1) / chunkSize)
    // 잡음에서 시작해 vector_estimator로 여러 번 다듬는다(마스크는 길이 하나라 모두 1).
    let latent = new Float32Array(dim * latentLength)
    for (let i = 0; i < latent.length; i++) {
      const u1 = Math.max(1e-10, Math.random())
      latent[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random())
    }
    const latentMask = new Tensor('float32', new Float32Array(latentLength).fill(1), [1, 1, latentLength])
    const total = new Tensor('float32', Float32Array.of(steps), [1])
    for (let step = 0; step < steps; step++) {
      const result = await this.vectorEst.run({
        noisy_latent: new Tensor('float32', latent, [1, dim, latentLength]),
        text_emb: textEmb, style_ttl: style.ttl, text_mask: textMask, latent_mask: latentMask,
        total_step: total, current_step: new Tensor('float32', Float32Array.of(step), [1]),
      })
      latent = Float32Array.from(result.denoised_latent.data as Float32Array)
    }
    const { wav_tts: wav } = await this.vocoder.run({ latent: new Tensor('float32', latent, [1, dim, latentLength]) })
    // 보코더 출력은 마지막 덩어리까지 채워져 있으므로 예측 길이로 자른다.
    return (wav.data as Float32Array).slice(0, wavLength)
  }

  /** 문장을 합성해 PCM(-1~1)을 돌려준다. steps가 많을수록 품질↑ 속도↓(공식 기본 8~5). */
  async synthesize(text: string, { lang = 'ko', voice = DEFAULT_VOICE, steps = 8, speed = 1.05 }: { lang?: TtsLang; voice?: Voice; steps?: number; speed?: number } = {}): Promise<Float32Array> {
    const style = this.style(voice)
    const parts: Float32Array[] = []
    const silence = new Float32Array(Math.floor(.3 * this.sampleRate))
    for (const chunk of chunkText(text, lang)) {
      if (parts.length) parts.push(silence)
      parts.push(await this.infer(chunk, lang, style, steps, speed))
    }
    const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
    let offset = 0
    for (const part of parts) { out.set(part, offset); offset += part.length }
    return out
  }
}

/** 16비트 모노 WAV */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const buffer = Buffer.alloc(44 + samples.length * 2)
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + samples.length * 2, 4); buffer.write('WAVE', 8)
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36); buffer.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  return buffer
}
