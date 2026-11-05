'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import voiceClips from './voiceClips.json'
import { RECORDED_CLIPS } from './voiceRecorded'
import { ttsAudio, warmTts } from './voice/ttsClient'

type RecognitionResult = { results: ArrayLike<ArrayLike<{ transcript: string }>> }
type RecognitionError = { error: string }
type Recognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: RecognitionResult) => void) | null
  onerror: ((event: RecognitionError) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}
type RecognitionConstructor = new () => Recognition
type SpeechWindow = Window & {
  SpeechRecognition?: RecognitionConstructor
  webkitSpeechRecognition?: RecognitionConstructor
}

/** 한글이 있으면 ko, 가나가 있으면 ja, 아니면 화면 언어 */
function scriptLang(text: string, fallback: 'ko' | 'en' | 'ja'): 'ko' | 'en' | 'ja' {
  if (/[\uac00-\ud7a3]/.test(text)) return 'ko'
  if (/[\u3040-\u30ff]/.test(text)) return 'ja'
  return fallback
}
const RECOGNITION_LANG = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP' } as const
const normalize = (value: string) => value.toLowerCase().replace(/[\s.,!?~·]/g, '')
const recorded = new Set(RECORDED_CLIPS)
const clipByText = new Map(Object.entries(voiceClips).filter(([id]) => recorded.has(id)).map(([id, text]) => [text, id]))

export function useVoiceGuide({ started, active, ask = false, lang = 'ko', onWake, onStart, onIntent, onCommand, onAsk, onSay, onHeard }: {
  started: boolean
  active: boolean
  /** 시연이 시작된 뒤(첫 화면이 아닐 때): "헤이 자칼, …" 질문을 onAsk로 보낸다. */
  ask?: boolean
  /** 화면 언어: 음성 인식 언어와 말하는 언어 */
  lang?: 'ko' | 'en' | 'ja'
  onWake: () => void
  onStart: () => void
  /** 호출 뒤 첫 화면에서 들은 말(이전 의도). 있으면 onStart 대신 이쪽으로 보낸다. */
  onIntent?: (utterance: string) => void
  /** 시연 중 호출어 없이 받는 명령(예: 설정 화면의 "좋아, 시작하자"). 처리했으면 true. */
  onCommand?: (utterance: string) => boolean
  onAsk?: (question: string) => void
  /** 에이전트가 말한 모든 문구(미리 녹음한 보고·즉석 답변): 채팅 기록용 */
  onSay?: (text: string, meta: { kind: 'report' | 'answer'; source?: 'model' | 'local' }) => void
  /** 사용자가 말한 호출어·명령·질문: 채팅 기록용 */
  onHeard?: (text: string) => void
}) {
  const [micEnabled, setMicEnabled] = useState(false)
  const [recognitionSupported, setRecognitionSupported] = useState(false)
  const [soundEnabled, setSoundEnabled] = useState(true)
  const [speaking, setSpeaking] = useState(false)
  const [heard, setHeard] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const recognitionRef = useRef<Recognition | null>(null)
  const micRef = useRef(false)
  const startedRef = useRef(started)
  const activeRef = useRef(active)
  const speakingRef = useRef(false)
  const soundRef = useRef(true)
  const callbacksRef = useRef({ onWake, onStart, onIntent, onCommand, onAsk, onSay, onHeard })
  const askRef = useRef(ask)
  const askUntil = useRef(0)
  const restartTimer = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const frameRef = useRef(0)
  const finishRef = useRef<(() => void) | null>(null)
  const voiceLevel = useRef(0)
  const voiceActive = useRef(false)
  // 사용자가 말하는 크기(0~1): 구체의 '듣는 중' 반응에 쓴다. 음성 인식과 별도로 마이크 음량만 읽는다.
  const micLevel = useRef(0)
  const micStreamRef = useRef<MediaStream | null>(null)
  const micFrameRef = useRef(0)
  const speakRef = useRef<((text: string) => void) | null>(null)
  const utterToken = useRef(0)
  const langRef = useRef(lang)

  useEffect(() => { startedRef.current = started }, [started])
  useEffect(() => { callbacksRef.current = { onWake, onStart, onIntent, onCommand, onAsk, onSay, onHeard } }, [onWake, onStart, onIntent, onCommand, onAsk, onSay, onHeard])
  useEffect(() => { askRef.current = ask }, [ask])
  useEffect(() => {
    langRef.current = lang
    if (recognitionRef.current) recognitionRef.current.lang = RECOGNITION_LANG[lang]
  }, [lang])
  useEffect(() => { warmTts() }, [])
  useEffect(() => {
    activeRef.current = active
    if (!active) {
      micRef.current = false
      setMicEnabled(false)
      window.clearTimeout(restartTimer.current)
      recognitionRef.current?.stop()
      window.cancelAnimationFrame(micFrameRef.current)
      micStreamRef.current?.getTracks().forEach(track => track.stop())
      micStreamRef.current = null
      micLevel.current = 0
    }
  }, [active])

  useEffect(() => {
    const browser = window as SpeechWindow
    setRecognitionSupported(Boolean(browser.SpeechRecognition || browser.webkitSpeechRecognition))
    return () => {
      micRef.current = false
      window.clearTimeout(restartTimer.current)
      window.cancelAnimationFrame(frameRef.current)
      window.cancelAnimationFrame(micFrameRef.current)
      micStreamRef.current?.getTracks().forEach(track => track.stop())
      recognitionRef.current?.stop()
      if (audioRef.current) {
        audioRef.current.onended = null
        audioRef.current.onerror = null
        audioRef.current.pause()
      }
      void contextRef.current?.close()
    }
  }, [])

  const listen = useCallback(() => {
    if (!micRef.current || !activeRef.current || speakingRef.current || !recognitionRef.current) return
    try { recognitionRef.current.start() } catch { /* 이미 듣는 중 */ }
  }, [])

  const stopListening = useCallback(() => {
    window.clearTimeout(restartTimer.current)
    try { recognitionRef.current?.stop() } catch { /* 이미 중지됨 */ }
  }, [])

  // 첫 사용자 동작에서 오디오 컨텍스트를 열어 이후 자동 보고도 재생할 수 있게 한다.
  const armAudio = useCallback(() => {
    if (!contextRef.current) {
      const audio = new Audio()
      audio.preload = 'auto'
      const context = new AudioContext()
      const source = context.createMediaElementSource(audio)
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      analyser.connect(context.destination)
      audioRef.current = audio
      contextRef.current = context
      analyserRef.current = analyser
    }
    void contextRef.current.resume()
  }, [])

  const stopAudio = useCallback(() => {
    window.cancelAnimationFrame(frameRef.current)
    if (finishRef.current && typeof window !== 'undefined') window.speechSynthesis?.cancel()
    voiceActive.current = false
    voiceLevel.current = 0
    if (audioRef.current) {
      audioRef.current.onended = null
      audioRef.current.onerror = null
      audioRef.current.pause()
      audioRef.current.currentTime = 0
    }
    finishRef.current = null
    speakingRef.current = false
    setSpeaking(false)
  }, [])

  // 녹음 파일이 없는 문구(대상·개수가 들어가는 문장, 다른 언어)는 브라우저 음성 합성으로 읽는다.
  // 합성 음성은 분석기에 연결할 수 없어서, 말하는 동안 구체가 숨 쉬듯 움직이도록 음량을 흉내 낸다.
  const synthesize = useCallback((text: string, language: 'ko' | 'en' | 'ja', options?: { ripple?: boolean; onEnd?: () => void }) => {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined
    if (!synth) { options?.onEnd?.(); window.setTimeout(listen, 150); return }
    synth.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP' }[language]
    speakingRef.current = true
    setSpeaking(true)
    voiceActive.current = Boolean(options?.ripple)
    const startedAt = performance.now()
    const pulse = () => {
      const time = (performance.now() - startedAt) / 1000
      voiceLevel.current += ((.32 + .22 * Math.abs(Math.sin(time * 7.3)) * Math.abs(Math.sin(time * 2.1))) - voiceLevel.current) * .25
      frameRef.current = window.requestAnimationFrame(pulse)
    }
    pulse()
    let finished = false
    const finish = () => {
      // 다른 문구가 끼어들어 끊긴 경우(stopAudio가 바꿔 놓음)에는 이 문구의 onEnd를 부르지 않는다.
      if (finished || finishRef.current !== finish) { finished = true; return }
      finished = true
      synth.cancel()
      stopAudio()
      options?.onEnd?.()
      window.setTimeout(listen, 180)
    }
    finishRef.current = finish
    utterance.onend = finish
    utterance.onerror = finish
    // 일부 브라우저는 합성 음성이 없으면 onend를 부르지 않는다: 글자 수로 넉넉히 잡은 시간 뒤에 끝낸다.
    window.setTimeout(finish, 1500 + text.length * 140)
    synth.speak(utterance)
  }, [listen, stopAudio])

  /** 소리 파일 하나를 분석기에 연결해 재생한다(구체가 실제 음량에 반응한다). 재생할 수 없으면 onFail. */
  const playFile = useCallback(function play(src: string, token: number, options: { ripple?: boolean; onEnd?: () => void } | undefined, onFail: () => void, retries = 1): void {
    const audio = audioRef.current
    const analyser = analyserRef.current
    if (!audio || !analyser) { onFail(); return }
    let finished = false
    const current = () => !finished && token === utterToken.current
    const finish = () => {
      if (!current()) return
      finished = true
      stopAudio()
      options?.onEnd?.()
      window.setTimeout(listen, 180)
    }
    const fail = () => {
      if (!current()) return
      finished = true
      window.cancelAnimationFrame(frameRef.current)
      audio.onended = null
      audio.onerror = null
      audio.pause()
      // 재생이 잠깐 끊긴 경우(다른 load와 겹침 등)가 있어 같은 소리를 한 번 더 시도한 뒤에 다음 방법으로 넘어간다.
      if (retries > 0) play(src, token, options, onFail, retries - 1)
      else onFail()
    }
    finishRef.current = finish
    audio.onended = finish
    audio.onerror = fail
    audio.src = src
    audio.load()
    const samples = new Uint8Array(analyser.fftSize)
    const measure = () => {
      analyser.getByteTimeDomainData(samples)
      let energy = 0
      for (const value of samples) {
        const sample = (value - 128) / 128
        energy += sample * sample
      }
      const rms = Math.sqrt(energy / samples.length)
      voiceLevel.current += (Math.min(1, rms * 4.5) - voiceLevel.current) * .28
      frameRef.current = window.requestAnimationFrame(measure)
    }
    void audio.play().then(() => {
      if (!current()) return
      setSpeaking(true)
      voiceActive.current = Boolean(options?.ripple)
      measure()
    }).catch(fail)
  }, [listen, stopAudio])

  /**
   * 자칼의 목소리 하나로 읽는다: 서버 TTS(Supertonic 3, /api/tts) → (서버를 못 쓰면) 같은 목소리로 미리 녹음한 파일 →
   * (그것도 없으면) 마지막으로 브라우저 음성 합성. 서버 음성과 녹음 파일은 분석기에 연결돼 구체가 실제 음량에 반응한다.
   */
  const utter = useCallback((text: string, language: 'ko' | 'en' | 'ja', options?: { ripple?: boolean; onEnd?: () => void }) => {
    stopListening()
    stopAudio()
    if (!soundRef.current) {
      options?.onEnd?.()
      window.setTimeout(listen, 150)
      return
    }
    armAudio()
    utterToken.current += 1
    const token = utterToken.current
    speakingRef.current = true
    setSpeaking(true)
    // 음성을 받는 동안 소리를 끄면(toggleSound) 이 문구를 끝낸다.
    let waiting = true
    finishRef.current = () => {
      if (!waiting || token !== utterToken.current) return
      waiting = false
      stopAudio()
      options?.onEnd?.()
      window.setTimeout(listen, 150)
    }
    // 문장의 글자로 언어를 고른다(한국어 안내를 영어 화면에서 읽을 때 등). 
    language = scriptLang(text, language)
    const clip = language === 'ko' ? clipByText.get(text) : undefined
    const viaSynth = () => { if (token === utterToken.current) synthesize(text, language, options) }
    const viaClip = clip ? () => playFile(`/voice/${clip}.mp3`, token, options, viaSynth) : viaSynth
    void ttsAudio(text, language).then(url => {
      if (!waiting || token !== utterToken.current) return
      waiting = false
      if (url) playFile(url, token, options, viaClip)
      else viaClip()
    })
  }, [armAudio, listen, playFile, stopAudio, stopListening, synthesize])

  const speak = useCallback((text: string, options?: { ripple?: boolean; onEnd?: () => void; lang?: 'ko' | 'en' | 'ja' }) => {
    setMessage(text)
    callbacksRef.current.onSay?.(text, { kind: 'report' })
    utter(text, options?.lang ?? langRef.current, options)
  }, [utter])

  speakRef.current = speak

  /** 에이전트의 즉석 답변도 같은 목소리(서버 TTS)로 읽는다. */
  const speakText = useCallback((text: string, language: 'ko' | 'en' | 'ja' = 'ko', source?: 'model' | 'local') => {
    setMessage(text)
    callbacksRef.current.onSay?.(text, { kind: 'answer', source })
    utter(text, language)
  }, [utter])

  const stopMicMeter = useCallback(() => {
    window.cancelAnimationFrame(micFrameRef.current)
    micStreamRef.current?.getTracks().forEach(track => track.stop())
    micStreamRef.current = null
    micLevel.current = 0
  }, [])

  // 시연장 소음에 구체가 계속 떨리지 않도록 작은 소리는 버리고(게이트) 큰 소리는 상한을 둔다.
  // 자칼이 말하는 동안에는 스피커 소리가 마이크로 들어오므로 0으로 둔다.
  const startMicMeter = useCallback(() => {
    if (micStreamRef.current || !navigator.mediaDevices?.getUserMedia) return
    void navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(stream => {
      if (!micRef.current) { stream.getTracks().forEach(track => track.stop()); return }
      const context = contextRef.current
      if (!context) { stream.getTracks().forEach(track => track.stop()); return }
      micStreamRef.current = stream
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      context.createMediaStreamSource(stream).connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)
      const GATE = .1
      const measure = () => {
        analyser.getByteTimeDomainData(samples)
        let energy = 0
        for (const value of samples) { const sample = (value - 128) / 128; energy += sample * sample }
        const raw = Math.min(1, Math.sqrt(energy / samples.length) * 7)
        const gated = speakingRef.current ? 0 : Math.max(0, (raw - GATE) / (1 - GATE))
        micLevel.current += (Math.min(.9, gated) - micLevel.current) * (gated > micLevel.current ? .35 : .08)
        micFrameRef.current = window.requestAnimationFrame(measure)
      }
      measure()
    }).catch(() => { /* 음량 없이도 '듣는 중' 모양은 유지된다 */ })
  }, [])

  const toggleMic = useCallback(() => {
    if (micRef.current) {
      micRef.current = false
      setMicEnabled(false)
      stopMicMeter()
      stopListening()
      setError('')
      return
    }
    const browser = window as SpeechWindow
    const Constructor = browser.SpeechRecognition || browser.webkitSpeechRecognition
    if (!Constructor) {
      setError('이 브라우저는 음성 인식을 지원하지 않습니다. 화면 버튼으로 시연할 수 있습니다.')
      return
    }
    armAudio()
    const recognition = new Constructor()
    recognition.lang = RECOGNITION_LANG[langRef.current]
    recognition.continuous = false
    recognition.interimResults = false
    recognition.onresult = event => {
      const transcript = event.results[0]?.[0]?.transcript ?? ''
      setHeard(transcript)
      const command = normalize(transcript)
      if (callbacksRef.current.onCommand?.(transcript)) { callbacksRef.current.onHeard?.(transcript.trim()); return }
      if (askRef.current && callbacksRef.current.onAsk) {
        // 시연 중에는 호출어(헤이 자칼) 뒤의 말만 질문으로 받는다. 호출어만 말하면 10초 동안 다음 말을 질문으로 받는다.
        const wake = transcript.match(/헤이\s*(자칼|재칼|쟈칼)\s*[,.!?]?\s*(.*)$/i) || transcript.match(/hey\s*jackal\s*[,.!?]?\s*(.*)$/i) || transcript.match(/ヘイ\s*ジャッカル\s*[、,.!?]?\s*(.*)$/i)
        if (wake) {
          const rest = (wake[wake.length - 1] || '').trim()
          if (rest.length > 1) { askUntil.current = 0; callbacksRef.current.onHeard?.(rest); callbacksRef.current.onAsk(rest) }
          else { askUntil.current = Date.now() + 10000; callbacksRef.current.onHeard?.('헤이 자칼'); speakRef.current?.(voiceClips.wake) }
        } else if (Date.now() < askUntil.current) {
          askUntil.current = 0
          callbacksRef.current.onHeard?.(transcript.trim())
          callbacksRef.current.onAsk(transcript.trim())
        }
        return
      }
      const intent = callbacksRef.current.onIntent
      const wakeWord = transcript.match(/헤이\s*(?:자칼|재칼|쟈칼)\s*[,.!?]?\s*(.*)$/i) || transcript.match(/hey\s*jackal\s*[,.!?]?\s*(.*)$/i) || transcript.match(/ヘイ\s*ジャッカル\s*[、,.!?]?\s*(.*)$/i)
      if (wakeWord) {
        callbacksRef.current.onHeard?.('헤이 자칼')
        callbacksRef.current.onWake()
        // "헤이 자칼, AWS에 있는 …"처럼 한 번에 말하면 뒷부분을 의도로 받는다.
        const rest = (wakeWord[1] || '').trim()
        if (intent && rest.length > 3) { callbacksRef.current.onHeard?.(rest); window.setTimeout(() => callbacksRef.current.onIntent?.(rest), 1400) }
      } else if (startedRef.current && intent && transcript.trim()) { callbacksRef.current.onHeard?.(transcript.trim()); intent(transcript.trim()) }
      else if (startedRef.current && /(마이그레이션|이전).*(시작|진행)/.test(command)) { callbacksRef.current.onHeard?.(transcript.trim()); callbacksRef.current.onStart() }
    }
    recognition.onerror = event => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        micRef.current = false
        setMicEnabled(false)
        setError('마이크 권한이 필요합니다. 화면 버튼으로도 시연할 수 있습니다.')
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        setError(`음성 인식 오류: ${event.error}`)
      }
    }
    recognition.onend = () => {
      if (micRef.current && activeRef.current && !speakingRef.current) restartTimer.current = window.setTimeout(listen, 350)
    }
    recognitionRef.current = recognition
    micRef.current = true
    setMicEnabled(true)
    setError('')
    listen()
    startMicMeter()
  }, [armAudio, listen, stopListening, startMicMeter, stopMicMeter])

  // 이전 방문에서 권한을 허용했다면 첫 화면부터 호출어를 듣는다.
  // 최초 권한 요청은 브라우저의 사용자 동작 제한 때문에 화면 버튼으로 시작한다.
  useEffect(() => {
    if (!active) return
    if (!navigator.permissions?.query) return
    let cancelled = false
    void navigator.permissions.query({ name: 'microphone' as PermissionName })
      .then(permission => {
        if (!cancelled && permission.state === 'granted' && !micRef.current) toggleMic()
      })
      .catch(() => { /* Permissions API 미지원 브라우저는 버튼으로 활성화 */ })
    return () => { cancelled = true }
  }, [active, toggleMic])

  const toggleSound = useCallback(() => {
    soundRef.current = !soundRef.current
    setSoundEnabled(soundRef.current)
    if (!soundRef.current) {
      const finish = finishRef.current
      if (finish) finish()
      else stopAudio()
    } else armAudio()
  }, [armAudio, stopAudio])

  return { micEnabled, recognitionSupported, soundEnabled, speaking, heard, message, error, speak, speakText, toggleMic, toggleSound, armAudio, voiceLevel, voiceActive, micLevel }
}
