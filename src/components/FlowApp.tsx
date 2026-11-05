'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import ParticleField from './ParticleField'
import ParticlePrompt from './ParticlePrompt'
import MigrationSetup from './MigrationSetup'
import AnalysisStage from './AnalysisStage'
import AIPlanningStage from './AIPlanningStage'
import RehearsalStage from './RehearsalStage'
import ApprovalStage from './ApprovalStage'
import ProvisioningStage from './ProvisioningStage'
import DataMigrationStage from './DataMigrationStage'
import TrafficShiftStage from './TrafficShiftStage'
import CutoverStage from './CutoverStage'
import StageRail from './StageRail'
import DemoControls from './DemoControls'
import LangSwitch from './LangSwitch'
import BackButton from './BackButton'
import { ConnectionToast, StatusPanel } from './MigrationStatus'
import { ArriveMorph, DISSOLVE_MS, TransitionLayer } from './ScreenFx'
import { useI18n, type MsgKey } from '../lib/i18n'
import { useMigration } from '../lib/migration/MigrationProvider'
import { requiresSource } from '../lib/migration/config'
import { captureScreen, fx, recentHandoff, registerTransition } from '../lib/particleHandoff'
import { isStage, STAGE_ORDER, type Stage } from '../lib/stages'
import { pathOf, type Target as SetupTarget } from '../lib/migration/events'
import { useVoiceGuide } from '../lib/useVoiceGuide'
import { buildAgentFacts } from '../lib/agent/context'
import { askAgent } from '../lib/agent/ask'
import { FoldIcon, MicIcon, SpeakerIcon } from './JackalIcons'
import { isStartCommand, targetFromUtterance } from '../lib/agent/intent'
import { useStageVoice } from '../lib/voice/useStageVoice'
import { voiceText, type VoiceKey } from '../lib/voice/messages'
import VoiceHints from './VoiceHints'

// 실제 환경을 바꾸기 전(입력~승인)까지만 이전 단계로 돌아갈 수 있다. 승인 이후는 되돌림이 아니라 롤백 정책을 따른다.
const BACK: Partial<Record<Stage, Stage>> = { setup: 'intro', analysis: 'setup', rehearsal: 'analysis', planning: 'rehearsal', approval: 'planning' }

// 이 복제본의 보고 문구는 화면의 데모 단계 전환에만 바인딩한다. 실제 백엔드 결과로 해석하지 않는다.
// 설정 화면은 첫 화면에서 자칼이 의도를 되짚으며 들어가므로 따로 안내하지 않는다.
const REPORT: Partial<Record<Stage, VoiceKey>> = {
  analysis: 'r.start.analysis',
  rehearsal: 'r.start.rehearsal',
  planning: 'r.start.planning',
  approval: 'r.start.approval',
  provisioning: 'r.start.provisioning',
  data: 'r.start.data',
  traffic: 'r.start.traffic',
  cutover: 'r.start.cutover',
}

type ChatMessage = { id: number; role: 'user' | 'agent'; text: string; tag?: 'report' | 'model' | 'local' }

export default function FlowApp() {
  const { t, lang } = useI18n()
  const { provider, state: migrationState, mode } = useMigration()
  // SSE 모드(목업 서버 시험 제외)는 고른 저장소 없이 이전을 시작하지 않는다: 음성 시작도 설정 화면으로 보낸다.
  const needsSource = requiresSource(mode)
  const [stage, setStage] = useState<Stage>('intro')
  const [started, setStarted] = useState(false)
  const [sphereFormed, setSphereFormed] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)
  const [textReady, setTextReady] = useState(false)
  // 설정 화면에서 고른 대상(gcp·onprem).
  const [choice, setTarget] = useState<SetupTarget>('onprem')
  const target = pathOf(choice)
  const [demoPanel, setDemoPanel] = useState(false)
  // 단계 화면을 처음부터 다시 그리기 위한 값(다시 보기·단계 이동에 쓴다)
  const [round, setRound] = useState(0)
  // 옛 화면이 입자로 풀어지는 동안 true
  const [dissolving, setDissolving] = useState(false)
  const busy = useRef(false)
  // 되돌아갈 수 없는 단계에서 브라우저 뒤로가기를 눌렀을 때 잠깐 보여 주는 안내
  const [notice, setNotice] = useState(false)
  const noticeTimer = useRef(0)
  const voiceStarting = useRef(false)
  const previousStage = useRef<Stage>('intro')

  useEffect(() => {
    if (!sphereFormed) return
    const timer = window.setTimeout(() => setShowPrompt(true), 300)
    return () => window.clearTimeout(timer)
  }, [sphereFormed])

  // 화면을 바꾸기 직전에 지금 화면의 위치를 입자로 풀어 두고, 옛 화면이 흐려지는 동안(DISSOLVE_MS) 입자는 멈추지 않고 떠다닌다.
  // 그 뒤 새 화면이 자기 모양을 알려 주면 같은 입자들이 곡선을 그리며 흘러 들어가 새 화면이 된다.
  const transition = useCallback((apply: () => void, release = false) => {
    if (busy.current) return
    busy.current = true
    captureScreen(document.querySelector('main.experience'))
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      apply()
      busy.current = false
      return
    }
    fx.start(recentHandoff())
    setDissolving(true)
    window.setTimeout(() => {
      apply()
      setDissolving(false)
      busy.current = false
      if (release) fx.release()
    }, DISSOLVE_MS)
  }, [])

  // 단계 안에서 내용이 통째로 바뀔 때(DB 전환의 승인 → 진행 → 리포트)도 같은 연출을 쓰도록 등록한다.
  useEffect(() => {
    registerTransition(apply => transition(apply))
    return () => registerTransition(null)
  }, [transition])

  const applyJump = useCallback((next: Stage) => {
    if (next !== 'intro') {
      setStarted(true)
      setSphereFormed(true)
      setShowPrompt(true)
      setTextReady(true)
    } else {
      voiceStarting.current = false
      setStarted(false)
      setSphereFormed(false)
      setShowPrompt(false)
      setTextReady(false)
    }
    setRound(current => current + 1)
    setStage(next)
  }, [])

  const jump = useCallback((next: Stage, animate = true) => {
    if (!animate) { applyJump(next); return }
    transition(() => applyJump(next), next === 'intro')
  }, [applyJump, transition])

  const askHandler = useRef<(question: string) => void>(() => {})
  const voice = useVoiceGuide({
    started,
    active: true,
    lang,
    ask: stage !== 'intro',
    onWake: () => wake(),
    onStart: () => handleIntent(''),
    onIntent: text => handleIntent(text),
    onCommand: text => voiceCommand.current(text),
    onAsk: question => askHandler.current(question),
    onSay: (text, meta) => pushChat('agent', text, meta.kind === 'answer' ? meta.source ?? 'local' : 'report'),
    onHeard: text => pushChat('user', text),
  })

  // 채팅 기록: 음성 안내·음성 질문·입력한 질문과 답을 한 곳에 남긴다. 위젯은 접을 수 있다.
  const [chat, setChat] = useState<ChatMessage[]>([])
  const [chatOpen, setChatOpen] = useState(true)
  const [unread, setUnread] = useState(0)
  const chatId = useRef(0)
  const chatOpenRef = useRef(true)
  const logRef = useRef<HTMLDivElement>(null)
  chatOpenRef.current = chatOpen
  function pushChat(role: ChatMessage['role'], text: string, tag?: ChatMessage['tag']) {
    chatId.current += 1
    const message: ChatMessage = { id: chatId.current, role, text, tag }
    setChat(list => [...list.slice(-59), message])
    if (role === 'agent' && !chatOpenRef.current) setUnread(count => count + 1)
  }
  useEffect(() => { if (chatOpen) setUnread(0) }, [chatOpen])
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }) }, [chat, chatOpen])

  // 에이전트 질문: 화면의 현재 상태를 요약해 임시 백엔드(/api/agent)에 묻고, 답은 말로도 읽어 준다.
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const askContext = useRef({ migrationState, stage, lang })
  askContext.current = { migrationState, stage, lang }
  askHandler.current = async (text: string) => {
    setAsking(true)
    const { migrationState: current, stage: currentStage, lang: currentLang } = askContext.current
    const facts = buildAgentFacts(current, currentStage, t(('stage.' + currentStage) as MsgKey))
    const { answer, source } = await askAgent(text, facts, currentLang)
    setAsking(false)
    voice.speakText(answer, currentLang, source)
  }

  // 자칼의 말: 미리 녹음한 한국어 문구는 녹음 파일로, 대상·개수가 들어간 문장과 다른 언어는 음성 합성으로 읽는다.
  const say = (text: string, options?: { ripple?: boolean; onEnd?: () => void }) => voice.speak(text, { ...options, lang })
  /**
   * 말이 끝나면 다음 화면으로 넘어간다. 다른 말이 끼어들어 끊기거나 음성 합성이 끝 신호를 주지 않아도
   * 화면이 멈추지 않도록 상한 시간 뒤에는 넘어간다(한 번만).
   */
  const sayThen = (text: string, next: () => void) => {
    let done = false
    const proceed = () => { if (!done) { done = true; window.clearTimeout(timer); next() } }
    const timer = window.setTimeout(proceed, 2500 + text.length * 120)
    say(text, { ripple: true, onEnd: proceed })
  }

  // 첫 화면 대화: 호출 → 의도 → (대상이 모호하면 되묻기) → 되짚기 → 설정 화면
  const [askingTarget, setAskingTarget] = useState(false)
  function wake() {
    if (stage !== 'intro' || started) return
    voice.armAudio()
    setStarted(true)
    say(t('open.jackal.listening')) // 호출 응답 중에는 파동을 만들지 않는다.
  }

  function handleIntent(text: string) {
    if (stage !== 'intro' || voiceStarting.current) return
    if (!started) { voice.armAudio(); setStarted(true) }
    const chosen = targetFromUtterance(text)
    if (chosen) { confirmTarget(chosen); return }
    setAskingTarget(true)
    say(t('open.jackal.askTarget'))
  }

  function confirmTarget(chosen: SetupTarget) {
    if (stage !== 'intro' || voiceStarting.current) return
    voiceStarting.current = true
    listenMode.current = false
    setForceListen(false)
    setAskingTarget(false)
    setShowPrompt(false)
    setTarget(chosen)
    sayThen(t('open.jackal.confirm', {
      source: t('open.source', { region: t('region.ap-northeast-2') }),
      target: t(chosen === 'onprem' ? 'open.target.onprem' : 'open.target.gcp'),
      targetEnv: t(chosen === 'onprem' ? 'open.targetEnv.onprem' : 'open.targetEnv.gcp'),
    }), () => go('setup'))
  }

  /** 버튼·단축키로 말한 것처럼 의도를 넣는다(채팅 기록에도 남긴다). */
  function sayIntent(text: string) {
    pushChat('user', text)
    handleIntent(text)
  }

  // 설정 화면의 시작: 음성("좋아, 시작하자")·버튼·S 키가 모두 여기로 온다.
  const setupStart = useRef<(() => void) | null>(null)
  const kickoff = useRef(false)
  const voiceCommand = useRef<(text: string) => boolean>(() => false)
  // 모든 단계의 음성 명령(다음·승인해·롤백해·지금 어디야 …)은 useStageVoice가 받는다. 설정 화면의 예전 시작 명령도 그대로 받는다.
  const stageVoice = useStageVoice({ stage, lang, speaking: voice.speaking, lastLine: voice.message, speak: text => say(text), onSetupStart: () => setupStart.current?.() })
  voiceCommand.current = text => {
    if (stageVoice.handleUtterance(text)) return true
    if (stage !== 'setup' || !isStartCommand(text)) return false
    setupStart.current?.()
    return true
  }
  function startFromSetup(request: Parameters<typeof provider.start>[0]) {
    startRequested.current = true
    provider.start(request)
    kickoff.current = true
    sayThen(t('open.jackal.kickoff'), () => go('analysis'))
  }

  // 설정 화면에서 시작 요청을 보냈는지(SSE에서 주소로 바로 연 단계와 구분한다)
  const startRequested = useRef(false)
  useEffect(() => {
    const previous = previousStage.current
    previousStage.current = stage
    if (previous === 'intro' && stage !== 'intro') setChatOpen(false)
    if (stage === 'intro' || previous === stage) return
    // 저장소 없이 단계를 연 SSE 화면은 시작되지 않았으므로 "시작했다"는 안내를 읽지 않는다.
    if (needsSource && stage !== 'setup' && !startRequested.current) return
    // 설정 화면에서 "원본 분석부터 시작할게요."라고 말하고 넘어왔으면 분석 안내를 겹쳐 읽지 않는다.
    if (stage === 'analysis' && kickoff.current) { kickoff.current = false; return }
    const message = REPORT[stage]
    if (message) say(voiceText(lang, message))
  }, [stage, voice.speak])

  // 구체의 '듣는 중' 모양: "네." 뒤부터 시작 명령을 받을 때까지(마이크가 없어도 유지). 발표자는 L 키로 켜고 끌 수 있다.
  const listenMode = useRef(false)
  const [forceListen, setForceListen] = useState(false)
  useEffect(() => {
    listenMode.current = forceListen || (stage === 'intro' && started && !voice.speaking && !voiceStarting.current)
  }, [forceListen, stage, started, voice.speaking])

  // 분석·샌드박스·구축의 완료 보고는 이벤트에 묶인 말 보고(useStageVoice)가 한다(같은 말을 두 번 하지 않게 화면 완료 신호로는 말하지 않는다).
  const reportAnalysisComplete = useCallback(() => {}, [])
  const reportSandboxComplete = reportAnalysisComplete
  const reportProvisioningComplete = reportAnalysisComplete

  // 주소로 단계를 바로 열 수 있다: ?stage=traffic&target=gcp&demo=1
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const wanted = params.get('stage')
    const wantedTarget = params.get('target')
    if (wantedTarget === 'gcp' || wantedTarget === 'onprem') setTarget(wantedTarget)
    if (params.get('demo') === '1') setDemoPanel(true)
    if (isStage(wanted)) jump(wanted, false)
  }, [jump])

  const presenterKeys = useRef({ stage, listen: () => {}, intent: () => {}, pick: (_: SetupTarget) => {} })
  presenterKeys.current = {
    stage,
    // L: 처음에는 "헤이 자칼"(호출), 그 뒤에는 '듣는 중' 모양을 켜고 끈다.
    listen: () => { if (!started) wake(); else setForceListen(current => !current) },
    // I: 예시 의도를 말한 것처럼 넣는다. O·G: 대상을 바로 고른다.
    intent: () => sayIntent(t('open.sample')),
    pick: chosen => { if (started) sayIntent(t(chosen === 'onprem' ? 'open.target.onprem' : 'open.target.gcp')) },
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (event.key === 'd' || event.key === 'D') setDemoPanel(current => !current)
      // 발표자 단축키(첫 화면): 현장에서 마이크·인식이 안 될 때 구체 반응을 직접 보여 준다.
      if (presenterKeys.current.stage !== 'intro') return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'l') presenterKeys.current.listen()
      if (key === 'i') presenterKeys.current.intent()
      if (key === 'o') presenterKeys.current.pick('onprem')
      if (key === 'g') presenterKeys.current.pick('gcp')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const index = STAGE_ORDER.indexOf(stage)
  const go = (to: Stage, animate = true) => {
    if (!animate) { setStage(to); return }
    transition(() => setStage(to))
  }
  const next = (to: Stage) => () => go(to)
  const exited = index >= STAGE_ORDER.indexOf('analysis')
  const backTo = BACK[stage]
  const goBack = () => { if (backTo) { if (backTo === 'intro') jump('intro'); else go(backTo) } }

  // 브라우저 뒤로가기 가드: 뒤로가기가 앱을 떠나지 않게 막고, 되돌릴 수 있는 단계에서는 "이전" 버튼과 똑같이 동작시킨다.
  // 첫 화면에서는 평소처럼 앱을 떠날 수 있다.
  const latest = useRef({ stage, goBack })
  useEffect(() => { latest.current = { stage, goBack } })
  const showNotice = useCallback(() => {
    setNotice(true)
    window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(false), 2800)
  }, [])
  useEffect(() => {
    const onPop = () => {
      const current = latest.current
      if (current.stage === 'intro') return
      window.history.pushState({ guard: true }, '')
      if (BACK[current.stage]) current.goBack()
      else showNotice()
    }
    window.addEventListener('popstate', onPop)
    return () => { window.removeEventListener('popstate', onPop); window.clearTimeout(noticeTimer.current) }
  }, [showNotice])
  useEffect(() => {
    if (stage !== 'intro' && !window.history.state?.guard) window.history.pushState({ guard: true }, '')
  }, [stage])

  // Jackal 위젯 상태 점: 말하는 중 > 듣는 중(마이크 켬) > 대기
  const jvStatus = voice.speaking ? 'speaking' : voice.micEnabled ? 'listening' : 'idle'

  return <main className={'experience' + (dissolving ? ' is-dissolving' : '')} aria-label={t('flow.aria')}>
    <ParticleField morphToSphere={started} analysisMode={exited} voiceLevel={voice.voiceLevel} voiceActive={voice.voiceActive} micLevel={voice.micLevel} listenMode={listenMode}
      onStart={wake} onSphereFormed={() => setSphereFormed(true)} />
    {stage === 'intro' && showPrompt && <section className="prompt-overlay" aria-label={t('prompt.aria')}>
      <ParticlePrompt key={lang} onComplete={() => setTextReady(true)} />
      <div className="prompt-action">
        {textReady && askingTarget && <div className="prompt-targets" role="group" aria-label={t('open.pickAria')}>
          <button type="button" className="prompt-yes prompt-target" onClick={() => sayIntent(t('open.target.onprem'))}>{t('open.target.onprem')} <kbd>O</kbd></button>
          <button type="button" className="prompt-yes prompt-target" onClick={() => sayIntent(t('open.target.gcp'))}>{t('open.target.gcp')} <kbd>G</kbd></button>
        </div>}
      </div>
    </section>}
    {stage === 'setup' && <MigrationSetup target={choice} onTarget={setTarget} onNext={startFromSetup} onSay={text => { if (!kickoff.current) say(text) }} startRef={setupStart} />}
    {stage === 'setup' && <ArriveMorph key={'setup' + round} />}
    {stage === 'analysis' && <AnalysisStage key={round} target={target} onComplete={reportAnalysisComplete} onAdvance={() => go('rehearsal')} />}
    {stage === 'rehearsal' && <RehearsalStage key={round} target={target} onComplete={reportSandboxComplete} onNext={next('planning')} />}
    {stage === 'planning' && <AIPlanningStage key={round} target={target} onNext={next('approval')} />}
    {stage === 'planning' && <ArriveMorph key={'planning' + round} />}
    {stage === 'approval' && <ApprovalStage key={round} target={target} onApprove={next('provisioning')} onCancel={() => jump('intro')} onRevise={() => go('planning')} />}
    {stage === 'approval' && <ArriveMorph key={'approval' + round} />}
    {stage === 'provisioning' && <ProvisioningStage key={round + target} target={target} onComplete={reportProvisioningComplete} onNext={next('data')} />}
    {stage === 'data' && <DataMigrationStage key={round} target={target} onNext={next('traffic')} />}
    {stage === 'traffic' && <TrafficShiftStage key={round + target} target={target} onNext={next('cutover')} />}
    {stage === 'cutover' && <CutoverStage key={round + target} target={target}
      onComplete={() => say(voiceText(lang, 'r.migration.done'))}
      onRestart={() => jump('intro')} />}
    <StatusPanel stage={stage} onHome={() => jump('intro')} onSetup={() => jump('setup')} />
    <TransitionLayer />
    {backTo && !dissolving && <BackButton onBack={goBack} />}
    <div className={'flow-toast' + (notice ? ' is-on' : '')} role="status" aria-hidden={!notice}>{t('nav.noBack')}</div>
    <ConnectionToast />
    <LangSwitch />
    {exited && <StageRail stage={stage} />}
    {demoPanel && <DemoControls stage={stage} target={target} onJump={jump} onTarget={setTarget} />}
    <aside className={'jv is-' + jvStatus + (chatOpen ? ' is-open' : '') + (stage === 'intro' ? ' is-intro' : '')} aria-label={t('agent.title')}>
      {chatOpen && <section className="jv-panel" aria-label={t('agent.title')}>
        <header className="jv-head">
          <span className="jv-dot" aria-hidden="true" />
          <strong>{t('agent.title')}</strong>
          <span className="jv-status">{t(('agent.status.' + jvStatus) as MsgKey)}</span>
          <div className="jv-head-actions">
            <button type="button" className="jv-toggle" onClick={voice.toggleMic} disabled={!voice.recognitionSupported} aria-pressed={voice.micEnabled}
              aria-label={t('agent.mic')} title={t('agent.mic') + ' · ' + t(voice.micEnabled ? 'agent.on' : 'agent.off')}><MicIcon off={!voice.micEnabled} /></button>
            <button type="button" className="jv-toggle" onClick={voice.toggleSound} aria-pressed={voice.soundEnabled}
              aria-label={t('agent.voice')} title={t('agent.voice') + ' · ' + t(voice.soundEnabled ? 'agent.on' : 'agent.off')}><SpeakerIcon off={!voice.soundEnabled} /></button>
            <button type="button" className="jv-fold" onClick={() => setChatOpen(false)} aria-label={t('agent.fold')} title={t('agent.fold')}><FoldIcon /></button>
          </div>
        </header>
        {exited && <p className="jv-context">{t('agent.route', { from: t('map.from'), to: t(('target.' + target) as MsgKey) })}</p>}
        <div className="jv-log" role="log" aria-live="polite" ref={logRef}>
          {chat.length === 0 && <p className="jv-empty">{started ? t('prompt.question') : t('open.chatHint')} · {t('agent.empty')}</p>}
          {chat.map(message => <div key={message.id} className={'jv-msg is-' + message.role} {...(message.tag ? { 'data-msg-tag': message.tag } : {})}
            {...(message.tag === 'model' || message.tag === 'local' ? { 'data-agent-source': message.tag } : {})}>
            <p>{message.text}</p>
            {(message.tag === 'model' || message.tag === 'local') && <small>{t(message.tag === 'model' ? 'agent.sourceModel' : 'agent.sourceLocal')}</small>}
          </div>)}
          {asking && <div className="jv-msg is-agent is-typing"><p>{t('agent.thinking')}</p></div>}
        </div>
        {voice.error && <small className="jv-error">{voice.error}</small>}
        {stage === 'intro' && <div className="jv-chips">
          {!started && <button type="button" onClick={wake}>{t('open.wake')}</button>}
          {started && <button type="button" onClick={() => sayIntent(t('open.sample'))}>{t('open.sample')}</button>}
        </div>}
        {(stage !== 'intro' || started) && <form className="jv-form" onSubmit={event => {
          event.preventDefault()
          const text = question.trim()
          if (!text || asking) return
          setQuestion('')
          // 첫 화면에서는 적은 말을 이전 의도로 받는다. 설정 화면의 "시작하자"는 시작 명령으로 받는다.
          if (stage === 'intro') { sayIntent(text); return }
          if (voiceCommand.current(text)) { pushChat('user', text); return }
          pushChat('user', text)
          void askHandler.current(text)
        }}>
          <input value={question} onChange={event => setQuestion(event.target.value)} placeholder={t(stage === 'intro' ? 'open.intentPh' : 'agent.placeholder')} aria-label={t(stage === 'intro' ? 'open.intentLabel' : 'agent.label')} maxLength={200} />
          <button type="submit" disabled={asking || !question.trim()}>{t('agent.send')}</button>
        </form>}
      </section>}
      <button type="button" className="jv-pill" aria-expanded={chatOpen} title={chatOpen ? t('agent.fold') : t('agent.open')} onClick={() => setChatOpen(open => !open)}>
        <span className="jv-dot" aria-hidden="true" />{t('agent.title')}{!chatOpen && unread > 0 && <b>{unread}</b>}
      </button>
      {stage !== 'intro' && !dissolving && <VoiceHints label={stageVoice.hintLabel} hints={stageVoice.hints} />}
    </aside>
  </main>
}
