/**
 * public/voice에 녹음 파일(mp3)이 있는 문구 id. 여기에 없는 문구는 파일을 요청하지 않고 바로 음성 합성으로 읽는다
 * (없는 파일을 요청하면 콘솔에 404가 남는다). `npm run tts:clips -- <id>`(scripts/generate-voice-clips.ts)로 새 문구를 녹음하면 이 목록에 더한다.
 * tests/unit/opening.test.ts가 폴더 내용과 같은지 확인한다.
 */
export const RECORDED_CLIPS: readonly string[] = [
  'analysis_done', 'analysis_start', 'approval_required', 'cutover_start', 'data_start', 'migration_done', 'planning_start',
  'provisioning_ready', 'provisioning_start', 'sandbox_done', 'sandbox_start', 'setup', 'start', 'traffic_start', 'wake',
]
