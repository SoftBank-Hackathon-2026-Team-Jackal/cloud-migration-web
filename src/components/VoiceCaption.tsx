'use client'

import { useEffect, useState } from 'react'

/**
 * 화면 아래에 떠 있는 자막: 자칼이 말하는 동안(그리고 끝난 뒤 잠깐) 말한 문장을 보여 준다.
 * 음성 언어와 화면 언어가 다르면 같은 문장의 화면 언어 문구(caption)를 아래에 작게 같이 보인다.
 * 클릭을 막지 않고, 말이 없으면 사라진다. 끄고 켜는 버튼은 Jackal 위젯에 있다.
 */
export default function VoiceCaption({ utterance, text, caption, speaking }: {
  /** 말한 횟수(같은 문장을 다시 말해도 다시 뜨게 한다) */
  utterance: number
  text: string
  caption: string
  speaking: boolean
}) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!utterance || !text) return
    setVisible(true)
    if (speaking) return
    // 소리를 끄거나 말이 끝난 뒤에도 읽을 시간만큼 남겨 둔다.
    const timer = window.setTimeout(() => setVisible(false), 1600 + Math.min(text.length, 200) * 40)
    return () => window.clearTimeout(timer)
  }, [utterance, text, speaking])
  return <div className={'jv-caption' + (visible ? ' is-on' : '')} data-voice-caption role="status" aria-live="off" aria-hidden={!visible}>
    <p>{text}</p>
    {caption && caption !== text && <p className="jv-caption-sub" lang="und">{caption}</p>}
  </div>
}
