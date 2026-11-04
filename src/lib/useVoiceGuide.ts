'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import voiceClips from './voiceClips.json'

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

const normalize = (value: string) => value.toLowerCase().replace(/[\s.,!?~·]/g, '')
const clipByText = new Map(Object.entries(voiceClips).map(([id, text]) => [text, id]))

export function useVoiceGuide({ started, active, onWake, onStart }: {
  started: boolean
  active: boolean
  onWake: () => void
  onStart: () => void
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
  const callbacksRef = useRef({ onWake, onStart })
  const restartTimer = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const frameRef = useRef(0)
  const finishRef = useRef<(() => void) | null>(null)
  const voiceLevel = useRef(0)
  const voiceActive = useRef(false)

  useEffect(() => { startedRef.current = started }, [started])
  useEffect(() => { callbacksRef.current = { onWake, onStart } }, [onWake, onStart])
  useEffect(() => {
    activeRef.current = active
    if (!active) {
      micRef.current = false
      setMicEnabled(false)
      window.clearTimeout(restartTimer.current)
      recognitionRef.current?.stop()
    }
  }, [active])

  useEffect(() => {
    const browser = window as SpeechWindow
    setRecognitionSupported(Boolean(browser.SpeechRecognition || browser.webkitSpeechRecognition))
    return () => {
      micRef.current = false
      window.clearTimeout(restartTimer.current)
      window.cancelAnimationFrame(frameRef.current)
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

  const speak = useCallback((text: string, options?: { ripple?: boolean; onEnd?: () => void }) => {
    setMessage(text)
    stopListening()
    stopAudio()

    if (!soundRef.current) {
      options?.onEnd?.()
      window.setTimeout(listen, 150)
      return
    }
    const clip = clipByText.get(text)
    if (!clip) {
      setError('이 안내 문구의 음성 파일을 찾지 못했습니다.')
      options?.onEnd?.()
      window.setTimeout(listen, 150)
      return
    }

    armAudio()
    const audio = audioRef.current
    const analyser = analyserRef.current
    if (!audio || !analyser) return
    speakingRef.current = true
    audio.src = `/voice/${clip}.mp3`
    audio.load()
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      stopAudio()
      options?.onEnd?.()
      window.setTimeout(listen, 180)
    }
    finishRef.current = finish
    audio.onended = finish
    audio.onerror = () => { setError('음성 파일을 재생하지 못했습니다.'); finish() }
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
      setSpeaking(true)
      voiceActive.current = Boolean(options?.ripple)
      measure()
    }).catch(() => { setError('자동 재생이 제한되었습니다. 화면 버튼을 눌러 다시 시작해 주세요.'); finish() })
  }, [armAudio, listen, stopAudio, stopListening])

  const toggleMic = useCallback(() => {
    if (micRef.current) {
      micRef.current = false
      setMicEnabled(false)
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
    recognition.lang = 'ko-KR'
    recognition.continuous = false
    recognition.interimResults = false
    recognition.onresult = event => {
      const transcript = event.results[0]?.[0]?.transcript ?? ''
      setHeard(transcript)
      const command = normalize(transcript)
      if (/헤이(자칼|재칼|쟈칼)|heyjackal/.test(command)) callbacksRef.current.onWake()
      else if (startedRef.current && /(마이그레이션|이전).*(시작|진행)/.test(command)) callbacksRef.current.onStart()
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
  }, [armAudio, listen, stopListening])

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

  return { micEnabled, recognitionSupported, soundEnabled, speaking, heard, message, error, speak, toggleMic, toggleSound, armAudio, voiceLevel, voiceActive }
}
