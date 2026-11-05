/**
 * 고정 안내(src/lib/voiceClips.json)를 녹음 파일(public/voice/<id>.mp3)로 만든다. 서버 TTS가 없을 때 대신 튼다.
 * 사용: node scripts/generate-voice-clips.ts [--all] [id …]
 *   기본: 이미 녹음된 문구(voiceRecorded.ts) 중 말로 다듬으면(pronounce.ts) 글이 달라지는 것만 다시 만든다.
 *   --all: 녹음된 문구 전부. id를 주면 그 문구만.
 * /api/tts와 같은 합성 서비스를 쓰므로(M1·같은 단계·같은 말 다듬기) 서버 음성과 녹음이 같은 소리가 된다. ffmpeg 필요.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { synthesizeCached, ttsAvailable } from '../src/lib/tts/service.ts'
import { spokenText } from '../src/lib/tts/pronounce.ts'
import { RECORDED_CLIPS } from '../src/lib/voiceRecorded.ts'

const args = process.argv.slice(2)
const all = args.includes('--all')
const ids = args.filter(arg => !arg.startsWith('--'))
const clips = JSON.parse(readFileSync(new URL('../src/lib/voiceClips.json', import.meta.url), 'utf8')) as Record<string, string>
const out = new URL('../public/voice/', import.meta.url)

if (!ttsAvailable()) {
  console.error('Supertonic 모델이 없습니다. 먼저 `npm run tts:download`를 실행하세요.')
  process.exit(1)
}
const chosen = ids.length ? ids : RECORDED_CLIPS.filter(id => all || spokenText(clips[id], 'ko') !== clips[id])
const scratch = mkdtempSync(join(tmpdir(), 'jackal-clips-'))
try {
  for (const id of chosen) {
    const text = clips[id]
    if (!text) { console.error(`없는 문구: ${id}`); process.exitCode = 1; continue }
    const { audio, cache, ms } = await synthesizeCached({ text, lang: 'ko', voice: 'M1' })
    const wav = join(scratch, id + '.wav')
    writeFileSync(wav, audio)
    const target = new URL(id + '.mp3', out).pathname
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-codec:a', 'libmp3lame', '-q:a', '3', target])
    console.log(`${id}: ${statSync(target).size} bytes (${cache} ${Math.round(ms)}ms) — ${spokenText(text, 'ko')}`)
  }
  if (!chosen.length) console.log('다시 만들 녹음이 없습니다(말로 다듬어도 글이 같습니다). --all로 전부 만들 수 있습니다.')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
