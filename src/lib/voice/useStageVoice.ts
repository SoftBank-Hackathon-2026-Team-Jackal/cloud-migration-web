'use client'

/**
 * 모든 단계의 말 보고와 음성 명령을 한곳에서 잇는다(FlowApp이 한 번 부른다).
 * - 보고: 데이터 계층이 보낸 이벤트 → ReportEngine → ReportQueue → 자칼의 목소리. 말한 보고는 채팅 기록에도 남는다(onSay).
 * - 명령: 짧은 말(또는 "헤이 자칼, …")을 명령표로 맞추고, 화면이 useVoiceActions로 등록한 처리기(버튼과 같은 것)를 부른다.
 *   승인은 사실을 읽어 준 뒤 "승인해"를 들어야만, 롤백·장애 주입·취소는 되묻고 "확인"을 들어야만 실행한다.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MigrationState } from '../migration/reducer'
import type { BackendPhase } from '../migration/events'
import { useMigration } from '../migration/MigrationProvider'
import { ACTION_OF, hintKeys, matchCommand, normalizeUtterance, RISKY, type CommandId } from './commands'
import { voiceAction, useAvailableVoiceActions } from './actions'
import { voiceText, type VoiceKey, type VoiceLang, type VoiceParams } from './messages'
import { approvalFactReports, cutoverFactReports, renderReport, ReportEngine, ReportQueue, type Report } from './reports'
import { statusLine } from './status'
import { prefetchTts } from './ttsClient'
import { isQuestionLine, parseWake } from './wake'

const PHASE_OF: Record<string, BackendPhase> = {
  analysis: 'analysis', rehearsal: 'build', planning: 'planning', approval: 'awaiting_approval',
  provisioning: 'provisioning', data: 'data_copy', traffic: 'traffic', cutover: 'verification',
}
/** 호출어 없이 받는 명령의 최대 길이(정규화한 글자 수): 발표 중의 긴 설명이 명령으로 잡히지 않게 */
const BARE_COMMAND_MAX = 14
const CONFIRM_MS = 12000
/** 자칼이 되묻거나 말을 시킨 뒤, 호출어 없이 짧은 대답("응", "승인해")을 받는 시간 */
const ANSWER_MS = 15000
const WAKE = /^(헤이(자칼|재칼|쟈칼)|heyjackal|ヘイジャッカル)/

/** 자막은 두 번째 인자(화면 언어 문구)로 받는다. 음성 언어와 화면 언어가 같으면 비어 있다. */
type Speak = (text: string, caption?: string) => void

export function useStageVoice({ stage, lang, captionLang, speaking, lastLine, speak, onSetupStart }: {
  stage: string
  /** 말하고 알아듣는 언어(음성 언어) */
  lang: VoiceLang
  /** 자막에 같이 보일 화면 언어. lang과 같으면 자막은 따로 만들지 않는다. */
  captionLang: VoiceLang
  speaking: boolean
  /** 자칼이 마지막으로 한 말("다시 말해줘") */
  lastLine: string
  speak: Speak
  /** 설정 화면의 "좋아, 시작하자" */
  onSetupStart: () => void
}) {
  const { subscribe, state } = useMigration()
  const engine = useRef(new ReportEngine())
  const queue = useRef(new ReportQueue())
  const live = useRef({ stage, lang, captionLang, speaking, lastLine, speak, onSetupStart, state })
  live.current = { stage, lang, captionLang, speaking, lastLine, speak, onSetupStart, state }
  const [paused, setPaused] = useState(false)
  const [confirming, setConfirming] = useState<CommandId | null>(null)
  const pending = useRef<{ command: CommandId; until: number } | null>(null)
  // 이 단계에서 승인 사실을 읽어 줬는지(읽어 준 뒤에만 "승인해"로 승인한다)
  const factsRead = useRef(false)
  // 자칼이 마지막으로 되묻거나 말을 시킨 때(이 뒤 잠깐은 호출어 없이 짧은 대답을 받는다)
  const questionAt = useRef(-Infinity)

  /** 말하기: 되묻는 문장이면 때를 적어 둔다. 자막 언어가 다르면 같은 문장의 화면 언어 문구를 같이 넘긴다. */
  const speakLine = useCallback((text: string, caption?: string) => {
    if (isQuestionLine(text)) questionAt.current = performance.now()
    live.current.speak(text, caption)
  }, [])
  const say = useCallback((key: VoiceKey, params?: VoiceParams) => {
    const { lang: spoken, captionLang: shown } = live.current
    speakLine(voiceText(spoken, key, params), shown !== spoken ? voiceText(shown, key, params) : undefined)
  }, [speakLine])

  // ---- 이벤트 → 보고 ----
  useEffect(() => subscribe(action => {
    const now = performance.now()
    if (action.type === 'event') {
      for (const report of engine.current.fromEvent(action.event, live.current.stage, now)) {
        queue.current.push(report)
        prefetchTts(renderReport(report, live.current.lang), live.current.lang)
      }
    } else if (action.type === 'resetPhase') engine.current.resetPhase(action.phase)
    else if (action.type === 'started' || action.type === 'reset') { engine.current.reset(); queue.current.clear() }
  }), [subscribe])

  // ---- 큐 → 말 ----
  const wasSpeaking = useRef(speaking)
  useEffect(() => {
    if (wasSpeaking.current && !speaking) queue.current.spoke(performance.now())
    wasSpeaking.current = speaking
  }, [speaking])
  useEffect(() => {
    const timer = window.setInterval(() => {
      const report = queue.current.next(performance.now(), live.current.speaking)
      if (!report) return
      if (report.key === 'r.approval.ask' || report.key === 'r.cutover.ask') factsRead.current = true
      const { lang: spoken, captionLang: shown } = live.current
      speakLine(renderReport(report, spoken), shown !== spoken ? renderReport(report, shown) : undefined)
    }, 250)
    return () => window.clearInterval(timer)
  }, [speakLine])

  const enqueueFacts = useCallback((reports: Report[]) => {
    for (const report of reports) {
      queue.current.push(report)
      prefetchTts(renderReport(report, live.current.lang), live.current.lang)
    }
  }, [])
  const gateFacts = useCallback(() => {
    const now = performance.now()
    const { stage: current, state: snapshot } = live.current
    return current === 'cutover'
      ? cutoverFactReports(engine.current.writePauseMs ?? snapshot.plan.preview?.rollout?.expected_write_pause_ms, now)
      : approvalFactReports(approvalFactsFrom(snapshot, engine.current.approvalFacts()), now)
  }, [])

  // ---- 단계가 바뀌면 ----
  useEffect(() => {
    queue.current.dropStale(PHASE_OF[stage] ?? null)
    pending.current = null
    setConfirming(null)
    factsRead.current = false
    // DB 전환 화면은 승인부터 시작한다: 단계 안내 뒤에 사실과 승인 방법을 읽는다(첫 승인은 approval.required 이벤트가 읽는다).
    if (stage === 'cutover') enqueueFacts(gateFacts())
  }, [stage, enqueueFacts, gateFacts])

  // ---- 명령 ----
  const run = useCallback((command: CommandId): void => {
    const { stage: current } = live.current
    const gate = current === 'approval' || (current === 'cutover' && voiceAction('approve') !== null)
    switch (command) {
      case 'pause': queue.current.paused = true; setPaused(true); say('c.paused'); return
      case 'resume': queue.current.paused = false; setPaused(false); say('c.resumed'); return
      case 'repeat': { const line = live.current.lastLine; if (line) speakLine(line); else say('c.nothing'); return }
      case 'status': {
        const parts = statusLine(current, live.current.state)
        const { lang: spoken, captionLang: shown } = live.current
        const join = (language: VoiceLang) => parts.map(part => voiceText(language, part.key, part.params)).join(' ')
        speakLine(join(spoken), shown !== spoken ? join(shown) : undefined)
        return
      }
      case 'confirm':
      case 'deny': {
        const waiting = pending.current
        pending.current = null
        setConfirming(null)
        if (!waiting || command === 'deny') { say('c.denied'); return }
        const handler = voiceAction(ACTION_OF[waiting.command]!)
        if (!handler) { say('c.noAction'); return }
        say('c.confirmed')
        handler()
        return
      }
      case 'approve': {
        if (!gate && current !== 'approval') { say('c.notApproval'); return }
        const handler = voiceAction('approve')
        if (!handler) { say(current === 'approval' ? 'r.approval.blocked' : 'c.notApproval'); return }
        // 사실을 아직 읽어 주지 않았으면 먼저 읽고 다시 묻는다.
        if (!factsRead.current) { enqueueFacts(gateFacts()); return }
        say('c.ok')
        handler()
        return
      }
      case 'advance': {
        if (current === 'setup') { live.current.onSetupStart(); return }
        // 승인이 필요한 화면에서 "좋아·다음"은 승인이 아니다: 사실을 읽고 승인 방법을 알려 준다.
        if (gate) { enqueueFacts(gateFacts()); return }
        // "다시 시도할까요?"(샌드박스 사람 검토)에 "좋아·진행해"로 답하면 다시 시도한다.
        const handler = voiceAction('next') ?? (current === 'rehearsal' ? voiceAction('retry') : null)
        if (!handler) { say('c.notYet'); return }
        say('c.next')
        handler()
        return
      }
      default: {
        const action = ACTION_OF[command]
        const handler = action ? voiceAction(action) : null
        if (!handler) { say('c.noAction'); return }
        const ask = RISKY[command]
        if (ask) {
          pending.current = { command, until: performance.now() + CONFIRM_MS }
          setConfirming(command)
          say(ask)
          return
        }
        say(command === 'revise' ? 'c.revise' : 'c.retry')
        handler()
      }
    }
  }, [say, speakLine, enqueueFacts, gateFacts])

  /**
   * 들은 말(또는 입력창)을 명령으로 처리했으면 true. 아니면 질문·의도로 넘긴다.
   * 호출어("헤이 자칼")가 있거나, 호출 직후(armed)이거나, 자칼이 막 되물은 뒤 짧은 대답이거나, 되묻는 확인 중이거나,
   * 설정 화면일 때만 명령으로 받는다. 발표 중의 일반 말이 명령으로 잡히지 않게 하려는 것이다.
   */
  const handleUtterance = useCallback((text: string, options?: { armed?: boolean }): boolean => {
    const current = live.current.stage
    if (current === 'intro') return false
    const said = normalizeUtterance(text)
    const woke = WAKE.test(said) || parseWake(text).woke
    if (pending.current && performance.now() > pending.current.until) { pending.current = null; setConfirming(null) }
    const armed = options?.armed === true
    const answering = pending.current !== null || performance.now() - questionAt.current < ANSWER_MS
    if (!woke && !armed && !answering && current !== 'setup') return false
    if (!woke && !armed && said.length > BARE_COMMAND_MAX) return false
    const command = matchCommand(text, { confirming: pending.current !== null })
    if (!command) return false
    if (current === 'setup' && command !== 'advance' && command !== 'status' && command !== 'repeat') return false
    run(command)
    return true
  }, [run])

  const available = useAvailableVoiceActions()
  const hints = hintKeys(stage, available, { confirming: confirming !== null, paused }).map(key => voiceText(lang, key))
  return { handleUtterance, hints, hintLabel: voiceText(lang, 'h.label'), paused, confirming }
}

/** 상태에서 승인 전 경고를 다시 센다(이벤트를 놓친 경우: 주소로 승인 화면을 바로 연 SSE 등). 이벤트로 센 값이 있으면 그쪽을 쓴다. */
function approvalFactsFrom(state: MigrationState, counted: ReturnType<ReportEngine['approvalFacts']>) {
  if (counted.warnings > 0) return counted
  const preview = state.plan.preview
  const issues = preview ? [...preview.validation.warnings, ...(preview.pending_decisions ?? [])].map(issue => issue.message || 'code:' + issue.id) : []
  return { warnings: issues.length, first: issues[0] ?? null }
}
