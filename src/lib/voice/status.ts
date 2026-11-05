/**
 * "지금 어디야"에 답할 한 문장: 지금 단계 + 그 단계에서 가장 중요한 숫자 하나. 상태(MigrationState)에서만 읽는다.
 * 런타임 import 없음(단위 테스트가 직접 읽는다).
 */
import type { MigrationState } from '../migration/reducer'
import type { VoiceKey, VoiceParams } from './messages.ts'

export type StatusLine = Array<{ key: VoiceKey; params?: VoiceParams }>

export function statusLine(stage: string, state: MigrationState): StatusLine {
  const lines: StatusLine = [{ key: 's.stage', params: { stage: 'stage.' + stage } }]
  switch (stage) {
    case 'analysis': {
      const n = state.analysis.findings.filter(finding => finding.stream !== 'code').length
      if (n > 0 && !state.analysis.done) lines.push({ key: 's.analysis', params: { n } })
      break
    }
    case 'rehearsal': {
      const attempt = state.sandbox.attempts.at(-1)?.attempt ?? state.build.attempt
      if (attempt && !state.sandbox.done) lines.push({ key: 's.rehearsal', params: { attempt } })
      break
    }
    case 'provisioning': {
      const total = state.provision.resources.length
      if (total > 0) lines.push({ key: 's.provisioning', params: { done: state.provision.resources.filter(item => item.state === 'done').length, total } })
      break
    }
    case 'data': {
      const p = state.data.current?.dump_percent
      if (typeof p === 'number') lines.push({ key: 's.data', params: { p: Math.round(p) } })
      break
    }
    case 'traffic': {
      const p = state.traffic.snapshot?.weights.target
      if (typeof p === 'number') lines.push({ key: 's.traffic', params: { p: Math.round(p) } })
      break
    }
  }
  return lines
}
