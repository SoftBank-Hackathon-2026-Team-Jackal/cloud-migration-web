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
      // 스캔(스트림) 단위: 진행이 100이 된 스캔 수 / 시작된 스캔 수
      const streams = new Map<string, number>()
      for (const finding of state.analysis.findings) streams.set(finding.stream, Math.max(streams.get(finding.stream) ?? 0, finding.progress ?? 0))
      if (streams.size > 0 && !state.analysis.done) lines.push({ key: 's.analysis', params: { n: [...streams.values()].filter(value => value >= 100).length, m: streams.size } })
      break
    }
    case 'rehearsal': {
      const attempt = state.sandbox.attempts.at(-1)?.attempt ?? state.build.attempt
      if (attempt && !state.sandbox.done) lines.push({ key: 's.rehearsal', params: { attempt } })
      break
    }
    case 'provisioning': {
      // m은 계획의 만들 리소스 수(원본 유지 제외). 모르면 받은 리소스 수.
      const planned = state.plan.preview?.resources.filter(resource => resource.change !== 'KEEP_SOURCE').length
      const done = state.provision.resources.filter(item => item.state === 'done').length
      const m = planned && planned >= done ? planned : state.provision.resources.length
      if (m > 0) lines.push({ key: 's.provisioning', params: { n: done, m } })
      break
    }
    case 'data': {
      const tables = state.data.tables
      if (tables.length > 0) lines.push({ key: 's.data', params: { n: tables.filter(table => table.state === 'copied' || table.state === 'matched').length, m: tables.length } })
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
