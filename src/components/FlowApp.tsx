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
import { useI18n } from '../lib/i18n'
import { useMigration } from '../lib/migration/MigrationProvider'
import { captureScreen, fx, recentHandoff, registerTransition } from '../lib/particleHandoff'
import { isStage, STAGE_ORDER, type Stage, type Target } from '../lib/stages'

// 실제 환경을 바꾸기 전(입력~승인)까지만 이전 단계로 돌아갈 수 있다. 승인 이후는 되돌림이 아니라 롤백 정책을 따른다.
const BACK: Partial<Record<Stage, Stage>> = { setup: 'intro', analysis: 'setup', rehearsal: 'analysis', planning: 'rehearsal', approval: 'planning' }

export default function FlowApp() {
  const { t, lang } = useI18n()
  const { provider } = useMigration()
  const [stage, setStage] = useState<Stage>('intro')
  const [started, setStarted] = useState(false)
  const [sphereFormed, setSphereFormed] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)
  const [textReady, setTextReady] = useState(false)
  const [target, setTarget] = useState<Target>('onprem')
  const [demoPanel, setDemoPanel] = useState(false)
  // 단계 화면을 처음부터 다시 그리기 위한 값(다시 보기·단계 이동에 쓴다)
  const [round, setRound] = useState(0)
  // 옛 화면이 입자로 풀어지는 동안 true
  const [dissolving, setDissolving] = useState(false)
  const busy = useRef(false)
  // 되돌아갈 수 없는 단계에서 브라우저 뒤로가기를 눌렀을 때 잠깐 보여 주는 안내
  const [notice, setNotice] = useState(false)
  const noticeTimer = useRef(0)

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
    <ParticleField morphToSphere={started} analysisMode={exited}
      onStart={() => { setStarted(true) }} onSphereFormed={() => setSphereFormed(true)} />
    {stage === 'intro' && showPrompt && <section className="prompt-overlay" aria-label={t('prompt.aria')}>
      <ParticlePrompt key={lang} onComplete={() => setTextReady(true)} />
      <div className="prompt-action">
        {textReady && <button type="button" className="prompt-yes"
          onClick={() => go('setup')}>{t('prompt.yes')}</button>}
      </div>
    </section>}
    {stage === 'setup' && <MigrationSetup target={target} onTarget={setTarget} onNext={() => { provider.start({ target }); go('analysis') }} />}
    {stage === 'setup' && <ArriveMorph key={'setup' + round} />}
    {stage === 'analysis' && <AnalysisStage key={round} target={target} onAdvance={() => go('rehearsal')} />}
    {stage === 'rehearsal' && <RehearsalStage key={round} target={target} onNext={next('planning')} />}
    {stage === 'planning' && <AIPlanningStage key={round} target={target} onNext={next('approval')} />}
    {stage === 'planning' && <ArriveMorph key={'planning' + round} />}
    {stage === 'approval' && <ApprovalStage key={round} target={target} onApprove={next('provisioning')} onCancel={() => jump('intro')} />}
    {stage === 'approval' && <ArriveMorph key={'approval' + round} />}
    {stage === 'provisioning' && <ProvisioningStage key={round + target} target={target} onNext={next('data')} />}
    {stage === 'data' && <DataMigrationStage key={round} target={target} onNext={next('traffic')} />}
    {stage === 'traffic' && <TrafficShiftStage key={round + target} target={target} onNext={next('cutover')} />}
    {stage === 'cutover' && <CutoverStage key={round + target} target={target} onRestart={() => jump('intro')} />}
    <StatusPanel stage={stage} onHome={() => jump('intro')} />
    <TransitionLayer />
    {backTo && !dissolving && <BackButton onBack={goBack} />}
    <div className={'flow-toast' + (notice ? ' is-on' : '')} role="status" aria-hidden={!notice}>{t('nav.noBack')}</div>
    <ConnectionToast />
    <LangSwitch />
    {exited && <StageRail stage={stage} />}
    {demoPanel && <DemoControls stage={stage} target={target} onJump={jump} onTarget={setTarget} />}
  </main>
}
