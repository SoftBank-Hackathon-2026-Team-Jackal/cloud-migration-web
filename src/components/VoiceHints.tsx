import { Fragment } from 'react'

/** 화면 아래의 작은 안내: 지금 말할 수 있는 문구(단계 명령 + 공통 명령). 버튼·단축키는 그대로 쓸 수 있다. */
export default function VoiceHints({ label, hints }: { label: string; hints: string[] }) {
  if (hints.length === 0) return null
  return <p className="voice-hints" data-voice-hints aria-label={label}>
    <span className="voice-hints-label">{label}</span>
    {hints.map((hint, index) => <Fragment key={hint}>{index > 0 && <span className="voice-hints-sep" aria-hidden="true">·</span>}<q>{hint}</q></Fragment>)}
  </p>
}
