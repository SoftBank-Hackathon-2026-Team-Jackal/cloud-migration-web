/**
 * 자주 하는 말을 미리 합성해 /api/tts의 디스크 캐시(TTS_CACHE_DIR, 기본 .tts-cache)에 넣는다. 시연 중에는 바로 나온다.
 * 사용: node scripts/pregen-tts.ts [--lang ko,en,ja] [--dry]
 *   기본 언어 ko. 문장: 고정 안내(voiceClips.json) · 첫 화면 대화 · 명령 응답 · 목업 대본을 보고 엔진에 흘려 나오는 모든 보고.
 * 서버와 같은 캐시 키를 쓰므로 `npm run dev` 중에 돌려도 된다(모델: SUPERTONIC_DIR, 기본 ~/.cache/supertonic-3).
 */
import { readFileSync } from 'node:fs'
import { synthesizeCached, ttsAvailable } from '../src/lib/tts/service.ts'
import type { TtsLang } from '../src/lib/tts/supertonic.ts'
import { VOICE_MESSAGES, voiceText, type VoiceKey, type VoiceLang } from '../src/lib/voice/messages.ts'
import { cutoverFactReports, renderReport, ReportEngine } from '../src/lib/voice/reports.ts'
import { approvalTimeline, planPreviewFor, timelineFor, type ScriptedPhase } from '../src/lib/migration/script.ts'
import { dataTickAt, dataTimeline, DATA_END_MS, DATA_LSN_TICK_MS } from '../src/lib/migration/dataScript.ts'
import { ko } from '../src/lib/i18n/ko.ts'
import { en } from '../src/lib/i18n/en.ts'
import { ja } from '../src/lib/i18n/ja.ts'
import type { DraftEvent, MigrationEvent, Target } from '../src/lib/migration/events.ts'

const args = process.argv.slice(2)
const langArg = args.includes('--lang') ? args[args.indexOf('--lang') + 1] : 'ko'
const langs = langArg.split(',').filter((lang): lang is TtsLang => lang === 'ko' || lang === 'en' || lang === 'ja')
const dry = args.includes('--dry')
const DICT = { ko, en, ja } as Record<VoiceLang, Record<string, string>>
const fill = (text: string, params: Record<string, string>) => text.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match)

function linesFor(lang: VoiceLang): Set<string> {
  const lines = new Set<string>()
  const dict = DICT[lang]
  // 첫 화면 대화(변수 없는 것 + 되짚기 문장은 두 대상 모두)
  for (const [key, text] of Object.entries(dict)) if (key.startsWith('open.jackal.') && !text.includes('{')) lines.add(text)
  for (const target of ['onprem', 'gcp'] as const) {
    lines.add(fill(dict['open.jackal.confirm'], {
      source: fill(dict['open.source'], { region: dict['region.ap-northeast-2'] }),
      target: dict['open.target.' + target], targetEnv: dict['open.targetEnv.' + target],
    }))
  }
  // 변수 없는 보고·명령 응답, 단계 이름이 들어간 "지금 어디야"
  for (const [key, text] of Object.entries(VOICE_MESSAGES[lang])) if ((key.startsWith('r.') || key.startsWith('c.')) && !text.includes('{')) lines.add(text)
  for (const stage of ['setup', 'analysis', 'rehearsal', 'planning', 'approval', 'provisioning', 'data', 'traffic', 'cutover']) lines.add(voiceText(lang, 's.stage', { stage: 'stage.' + stage }))
  // 합쳐지는 보고("수정 3건 적용")는 개수가 그때그때 달라서 1~8을 모두 만든다.
  for (let n = 1; n <= 8; n++) for (const key of ['r.sandbox.fix', 'r.prov.ready'] as VoiceKey[]) lines.add(voiceText(lang, key, { n }))
  for (const p of [10, 50, 100]) { lines.add(voiceText(lang, 'r.traffic.step', { p })); if (p < 100) lines.add(voiceText(lang, 'r.traffic.gate', { p })) }

  // 목업 대본을 엔진에 흘린다(두 대상 × 샌드박스 시나리오들).
  let seq = 0
  const feed = (engine: ReportEngine, stage: string, drafts: DraftEvent[]) => {
    for (const draft of drafts) {
      const event = { ...draft, seq: ++seq, at: new Date(0).toISOString() } as MigrationEvent
      for (const report of engine.fromEvent(event, stage, 0)) lines.add(renderReport(report, lang))
    }
  }
  const STAGE: Record<ScriptedPhase, string> = { analysis: 'analysis', build: 'rehearsal', planning: 'planning', provisioning: 'provisioning', verification: 'cutover' }
  for (const target of ['onprem', 'gcp'] as Target[]) {
    for (const sandbox of ['spec', 'pass', 'code', 'infra'] as const) {
      const engine = new ReportEngine()
      for (const phase of ['analysis', 'build', 'planning'] as ScriptedPhase[]) feed(engine, STAGE[phase], timelineFor(phase, { target, aiFixes: 1, sandbox }).map(item => item.event))
      feed(engine, 'approval', [{ type: 'approval.required', phase: 'awaiting_approval', status: 'waiting', data: { excluded: [], rollback_policy: '' } }])
      feed(engine, 'approval', approvalTimeline(1).map(item => item.event))
      for (const phase of ['provisioning', 'verification'] as ScriptedPhase[]) feed(engine, STAGE[phase], timelineFor(phase, { target, aiFixes: 1, sandbox }).map(item => item.event))
      feed(engine, 'data', dataTimeline(target, 'pass', 0).map(item => item.event))
      for (let ms = 0; ms <= DATA_END_MS; ms += DATA_LSN_TICK_MS) feed(engine, 'data', dataTickAt(ms, 'pass'))
    }
    for (const report of cutoverFactReports(planPreviewFor(target, 1).rollout?.expected_write_pause_ms, 0)) lines.add(renderReport(report, lang))
  }
  // 고정 안내(한국어 녹음 문구)
  if (lang === 'ko') for (const text of Object.values(JSON.parse(readFileSync(new URL('../src/lib/voiceClips.json', import.meta.url), 'utf8')) as Record<string, string>)) lines.add(text)
  return lines
}

if (!dry && !ttsAvailable()) {
  console.error('Supertonic 모델이 없습니다. 먼저 `node scripts/download-tts-model.mjs`를 실행하세요.')
  process.exit(1)
}
let total = 0
const started = performance.now()
for (const lang of langs) {
  const lines = [...linesFor(lang)]
  console.log(`[${lang}] ${lines.length}개 문장`)
  for (const text of lines) {
    if (dry) { console.log('  ' + text); continue }
    const { cache, ms } = await synthesizeCached({ text, lang, voice: 'M1' })
    total += 1
    console.log(`  ${cache.padEnd(6)} ${String(Math.round(ms)).padStart(5)}ms  ${text}`)
  }
}
if (!dry) console.log(`\n${total}개 완료 (${((performance.now() - started) / 1000).toFixed(1)}초)`)
