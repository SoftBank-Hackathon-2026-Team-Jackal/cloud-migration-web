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
import voiceClips from '../lib/voiceClips.json'
import { FoldIcon, MicIcon, SpeakerIcon } from './JackalIcons'

// 실제 환경을 바꾸기 전(입력~승인)까지만 이전 단계로 돌아갈 수 있다. 승인 이후는 되돌림이 아니라 롤백 정책을 따른다.
const BACK: Partial<Record<Stage, Stage>> = { setup: 'intro', analysis: 'setup', rehearsal: 'analysis', planning: 'rehearsal', approval: 'planning' }

// 이 복제본의 보고 문구는 화면의 데모 단계 전환에만 바인딩한다. 실제 백엔드 결과로 해석하지 않는다.
const REPORT: Partial<Record<Stage, string>> = {
  setup: voiceClips.setup,
  analysis: voiceClips.analysis_start,
  rehearsal: voiceClips.sandbox_start,
  planning: voiceClips.planning_start,
  approval: voiceClips.approval_required,
  provisioning: voiceClips.provisioning_start,
  data: voiceClips.data_start,
  traffic: voiceClips.traffic_start,
  cutover: voiceClips.cutover_start,
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
    ask: stage !== 'intro',
    onWake: () => wake(),
    onStart: () => beginVoiceMigration(),
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

  function wake() {
    if (stage !== 'intro' || started) return
    voice.armAudio()
    setStarted(true)
    voice.speak(voiceClips.wake) // 호출 응답 중에는 파동을 만들지 않는다.
  }

  function beginVoiceMigration() {
    if (stage !== 'intro' || voiceStarting.current) return
    if (needsSource) { go('setup'); return }
    voiceStarting.current = true
    listenMode.current = false
    setForceListen(false)
    setShowPrompt(false)
    setTarget('gcp') // 복제본의 로컬 데모 프로필: AWS EKS → GCP GKE
    voice.speak(voiceClips.start, {
      ripple: true,
      onEnd: () => jump('analysis'),
    })
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
    const message = REPORT[stage]
    if (message) voice.speak(message)
  }, [stage, voice.speak])

  // 구체의 '듣는 중' 모양: "네." 뒤부터 시작 명령을 받을 때까지(마이크가 없어도 유지). 발표자는 L 키로 켜고 끌 수 있다.
  const listenMode = useRef(false)
  const [forceListen, setForceListen] = useState(false)
  useEffect(() => {
    listenMode.current = forceListen || (stage === 'intro' && started && !voice.speaking && !voiceStarting.current)
  }, [forceListen, stage, started, voice.speaking])

  const reportAnalysisComplete = useCallback(() => voice.speak(voiceClips.analysis_done), [voice.speak])
  const reportSandboxComplete = useCallback(() => voice.speak(voiceClips.sandbox_done), [voice.speak])
  const reportProvisioningComplete = useCallback(() => voice.speak(voiceClips.provisioning_ready), [voice.speak])

  // 주소로 단계를 바로 열 수 있다: ?stage=traffic&target=gcp&demo=1
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const wanted = params.get('stage')
    const wantedTarget = params.get('target')
    if (wantedTarget === 'gcp' || wantedTarget === 'onprem') setTarget(wantedTarget)
    if (params.get('demo') === '1') setDemoPanel(true)
    if (isStage(wanted)) jump(wanted, false)
  }, [jump])

  const presenterKeys = useRef({ stage, listen: () => {}, speakTest: () => {} })
  presenterKeys.current = {
    stage,
    listen: () => { if (!started) { voice.armAudio(); setStarted(true) } setForceListen(current => !current) },
    // 시작 안내 문구를 파동과 함께 재생만 한다(분석 화면으로 넘어가지 않음).
    speakTest: () => { voice.armAudio(); if (!started) setStarted(true); setForceListen(false); voice.speak(voiceClips.start, { ripple: true }) },
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (event.key === 'd' || event.key === 'D') setDemoPanel(current => !current)
      // 발표자 단축키(첫 화면): 현장에서 마이크·인식이 안 될 때 구체 반응을 직접 보여 준다.
      if (presenterKeys.current.stage !== 'intro') return
      if (event.key === 'l' || event.key === 'L') presenterKeys.current.listen()
      if (event.key === 's' || event.key === 'S') presenterKeys.current.speakTest()
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
        {textReady && <button type="button" className="prompt-yes"
          onClick={() => beginVoiceMigration()}>마이그레이션 시작</button>}
        {textReady && <button type="button" className="prompt-yes prompt-setup"
          onClick={() => go('setup')}>{t('agent.setup')}</button>}
      </div>
    </section>}
    {stage === 'setup' && <MigrationSetup target={choice} onTarget={setTarget} onNext={request => { startRequested.current = true; provider.start(request); go('analysis') }} />}
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
      onComplete={() => voice.speak(voiceClips.migration_done)}
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
          {chat.length === 0 && <p className="jv-empty">{started ? t('prompt.question') : '“' + t('agent.chip.wake') + '”'} · {t('agent.empty')}</p>}
          {chat.map(message => <div key={message.id} className={'jv-msg is-' + message.role} {...(message.tag ? { 'data-msg-tag': message.tag } : {})}
            {...(message.tag === 'model' || message.tag === 'local' ? { 'data-agent-source': message.tag } : {})}>
            <p>{message.text}</p>
            {(message.tag === 'model' || message.tag === 'local') && <small>{t(message.tag === 'model' ? 'agent.sourceModel' : 'agent.sourceLocal')}</small>}
          </div>)}
          {asking && <div className="jv-msg is-agent is-typing"><p>{t('agent.thinking')}</p></div>}
        </div>
        {voice.error && <small className="jv-error">{voice.error}</small>}
        {stage === 'intro' && <div className="jv-chips">
          <button type="button" onClick={wake}>{t('agent.chip.wake')}</button>
          {started && <button type="button" onClick={() => beginVoiceMigration()}>{t('agent.chip.start')}</button>}
        </div>}
        {stage !== 'intro' && <form className="jv-form" onSubmit={event => { event.preventDefault(); const text = question.trim(); if (text && !asking) { setQuestion(''); pushChat('user', text); void askHandler.current(text) } }}>
          <input value={question} onChange={event => setQuestion(event.target.value)} placeholder={t('agent.placeholder')} aria-label={t('agent.label')} maxLength={200} />
          <button type="submit" disabled={asking || !question.trim()}>{t('agent.send')}</button>
        </form>}
      </section>}
      <button type="button" className="jv-pill" aria-expanded={chatOpen} title={chatOpen ? t('agent.fold') : t('agent.open')} onClick={() => setChatOpen(open => !open)}>
        <span className="jv-dot" aria-hidden="true" />{t('agent.title')}{!chatOpen && unread > 0 && <b>{unread}</b>}
      </button>
    </aside>
  </main>
}
