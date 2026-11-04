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
import { captureScreen, fx, recentHandoff, registerTransition } from '../lib/particleHandoff'
import { isStage, STAGE_ORDER, type Stage } from '../lib/stages'
import { pathOf, type Target as SetupTarget } from '../lib/migration/events'
import { useVoiceGuide } from '../lib/useVoiceGuide'
import { buildAgentFacts } from '../lib/agent/context'
import { askAgent } from '../lib/agent/ask'
import voiceClips from '../lib/voiceClips.json'

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

export default function FlowApp() {
  const { t, lang } = useI18n()
  const { provider, state: migrationState } = useMigration()
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
  })

  // 에이전트 질문: 화면의 현재 상태를 요약해 임시 백엔드(/api/agent)에 묻고, 답은 말로도 읽어 준다.
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [answerSource, setAnswerSource] = useState<'model' | 'local' | null>(null)
  const askContext = useRef({ migrationState, stage, lang })
  askContext.current = { migrationState, stage, lang }
  askHandler.current = async (text: string) => {
    setAsking(true)
    const { migrationState: current, stage: currentStage, lang: currentLang } = askContext.current
    const facts = buildAgentFacts(current, currentStage, t(('stage.' + currentStage) as MsgKey))
    const { answer, source } = await askAgent(text, facts, currentLang)
    setAnswerSource(source)
    setAsking(false)
    voice.speakText(answer, currentLang)
  }

  function wake() {
    if (stage !== 'intro' || started) return
    voice.armAudio()
    setStarted(true)
    voice.speak(voiceClips.wake) // 호출 응답 중에는 파동을 만들지 않는다.
  }

  function beginVoiceMigration() {
    if (stage !== 'intro' || voiceStarting.current) return
    voiceStarting.current = true
    setShowPrompt(false)
    setTarget('gcp') // 복제본의 로컬 데모 프로필: AWS EKS → GCP GKE
    voice.speak(voiceClips.start, {
      ripple: true,
      onEnd: () => jump('analysis'),
    })
  }

  useEffect(() => {
    const previous = previousStage.current
    previousStage.current = stage
    if (stage === 'intro' || previous === stage) return
    const message = REPORT[stage]
    if (message) voice.speak(message)
  }, [stage, voice.speak])

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (event.key === 'd' || event.key === 'D') setDemoPanel(current => !current)
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

  return <main className={'experience' + (dissolving ? ' is-dissolving' : '')} aria-label={t('flow.aria')}>
    <ParticleField morphToSphere={started} analysisMode={exited} voiceLevel={voice.voiceLevel} voiceActive={voice.voiceActive}
      onStart={wake} onSphereFormed={() => setSphereFormed(true)} />
    {stage === 'intro' && showPrompt && <section className="prompt-overlay" aria-label={t('prompt.aria')}>
      <ParticlePrompt key={lang} onComplete={() => setTextReady(true)} />
      <div className="prompt-action">
        {textReady && <button type="button" className="prompt-yes"
          onClick={() => go('setup')}>{t('prompt.yes')}</button>}
      </div>
    </section>}
    {stage === 'setup' && <MigrationSetup target={choice} onTarget={setTarget} onNext={request => { provider.start(request); go('analysis') }} />}
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
    <StatusPanel stage={stage} onHome={() => jump('intro')} />
    <TransitionLayer />
    {backTo && !dissolving && <BackButton onBack={goBack} />}
    <div className={'flow-toast' + (notice ? ' is-on' : '')} role="status" aria-hidden={!notice}>{t('nav.noBack')}</div>
    <ConnectionToast />
    <LangSwitch />
    {exited && <StageRail stage={stage} />}
    {demoPanel && <DemoControls stage={stage} target={target} onJump={jump} onTarget={setTarget} />}
    <aside className={'voice-console' + (stage === 'intro' ? ' is-intro' : '')} aria-label="자칼 음성 안내">
      <div className="voice-console-head"><strong>JACKAL VOICE</strong><span>LOCAL DEMO</span></div>
      {stage === 'intro' && <p className="voice-profile">등록된 시연 정보 · AWS EKS → GCP GKE</p>}
      <p className="voice-caption" aria-live="polite">{voice.message || (started ? '“마이그레이션 시작하자”라고 말해 주세요.' : '“헤이 자칼”이라고 말해 주세요.')}</p>
      {voice.heard && stage === 'intro' && <small className="voice-heard">인식: {voice.heard}</small>}
      {voice.error && <small className="voice-error">{voice.error}</small>}
      <div className="voice-actions">
        <button type="button" onClick={voice.toggleMic} disabled={!voice.recognitionSupported}
          aria-pressed={voice.micEnabled}>{voice.micEnabled ? '● 듣는 중 · 끄기' : '마이크 켜기'}</button>
        <button type="button" onClick={voice.toggleSound} aria-pressed={voice.soundEnabled}>{voice.soundEnabled ? '음성 켜짐' : '음성 꺼짐'}</button>
        {stage === 'intro' && <button type="button" onClick={wake}>헤이 자칼</button>}
        {stage === 'intro' && started && <button type="button" onClick={() => beginVoiceMigration()}>마이그레이션 시작하자</button>}
      </div>
      {stage !== 'intro' && <form className="voice-ask" onSubmit={event => { event.preventDefault(); const text = question.trim(); if (text && !asking) { setQuestion(''); void askHandler.current(text) } }}>
        <input value={question} onChange={event => setQuestion(event.target.value)} placeholder={t('agent.placeholder')} aria-label={t('agent.label')} maxLength={200} />
        <button type="submit" disabled={asking || !question.trim()}>{asking ? t('agent.thinking') : t('agent.send')}</button>
      </form>}
      {stage !== 'intro' && !voice.message && <small className="voice-heard">{t('agent.hint')}</small>}
      {stage !== 'intro' && answerSource && voice.message && <small className="voice-heard" data-agent-source={answerSource}>{answerSource === 'model' ? t('agent.sourceModel') : t('agent.sourceLocal')}</small>}
    </aside>
  </main>
}
