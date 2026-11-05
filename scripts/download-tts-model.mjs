#!/usr/bin/env node
/**
 * Supertonic 3 모델(ONNX, 약 400MB)을 내려받는다. 모델은 저장소에 올리지 않는다.
 * 사용: node scripts/download-tts-model.mjs [DIR]
 *   DIR 기본값: $SUPERTONIC_DIR 또는 ~/.cache/supertonic-3 (워크트리끼리 같은 모델을 쓴다)
 * 모델 라이선스: BigScience Open RAIL-M (public/voice/LICENSE-SUPERTONIC.txt), 코드는 MIT.
 */
import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const REPO = 'supertone-oss-archive/supertonic-3'
const REVISION = 'aafc6e32416a594460b32413efc49d7fe4ce6d46'
// 서버 합성에 필요한 파일만(오디오 예시·그림 제외). 목소리는 남성 M1~M5, 여성 F1~F5.
const FILES = [
  'LICENSE', 'config.json',
  'onnx/duration_predictor.onnx', 'onnx/text_encoder.onnx', 'onnx/vector_estimator.onnx', 'onnx/vocoder.onnx',
  'onnx/tts.json', 'onnx/unicode_indexer.json',
  ...['M1', 'M2', 'M3', 'M4', 'M5', 'F1', 'F2', 'F3', 'F4', 'F5'].map(voice => `voice_styles/${voice}.json`),
]

const dir = resolve(process.argv[2] || process.env.SUPERTONIC_DIR || join(homedir(), '.cache', 'supertonic-3'))

for (const file of FILES) {
  const target = join(dir, file)
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${file}`
  const head = await fetch(url, { method: 'HEAD', redirect: 'follow' })
  const size = Number(head.headers.get('content-length') || 0)
  if (existsSync(target) && (!size || statSync(target).size === size)) { console.log(`ok   ${file}`); continue }
  mkdirSync(dirname(target), { recursive: true })
  const partial = target + '.part'
  // curl이 있으면 curl로 받는다(Node fetch는 큰 파일에서 훨씬 느리다: 실측 40KB/s 대 12MB/s).
  const curl = spawnSync('curl', ['-fL', '--retry', '3', '-sS', '-o', partial, url], { stdio: 'inherit' })
  if (curl.error || curl.status !== 0) {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok || !response.body) throw new Error(`${file}: HTTP ${response.status}`)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
  }
  renameSync(partial, target)
  console.log(`get  ${file} (${(statSync(target).size / 1e6).toFixed(1)} MB)`)
}
console.log(`\nSupertonic 3 → ${dir}\n서버는 SUPERTONIC_DIR(기본 ~/.cache/supertonic-3)에서 모델을 읽는다.`)
