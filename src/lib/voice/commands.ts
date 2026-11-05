/**
 * 단계별 음성 명령표. 말(인식 결과·입력창)을 명령 하나로 맞춘다. 런타임 import 없음(단위 테스트가 직접 읽는다).
 * 규칙
 * - 승인은 "승인해/승인할게"(en approve, ja 承認して)처럼 승인 낱말이 있어야 한다. "좋아·진행해"는 승인이 아니다.
 * - 롤백·장애 주입·이전 취소처럼 되돌리기 어려운 동작은 되묻고, "확인"을 들어야 실행한다.
 * - 부정("승인 안 해", "don't approve")은 승인으로 받지 않는다.
 */
import type { VoiceKey } from './messages.ts'

export type CommandId =
  | 'approve' | 'advance' | 'pause' | 'resume' | 'repeat' | 'status'
  | 'rollback' | 'inject' | 'retry' | 'revise' | 'cancel' | 'confirm' | 'deny'

/** 화면이 음성에 맡기는 동작(버튼과 같은 처리기). 화면이 등록한 것만 실행한다. */
export type ActionId = 'next' | 'approve' | 'rollback' | 'inject' | 'retry' | 'revise' | 'cancel'

export const normalizeUtterance = (value: string) => value.toLowerCase().normalize('NFKC').replace(/[\s.,!?~·'"“”‘’。、！？「」]/g, '')

const NEGATION = /(안해|안할|않|하지마|하지말|말아|못해|don't|dont|donot|not|never|しない|しません|やめ)/

const PATTERNS: Array<[CommandId, RegExp]> = [
  ['approve', /(승인해|승인할게|승인합니다|승인하겠|승인해요|승인하자|approve|iapprove|承認して|承認します|承認する)/],
  ['cancel', /(이전취소|마이그레이션취소|전부취소|취소해|cancelthemigration|cancelmigration|移行を?(取り消|キャンセル|中止))/],
  ['rollback', /(롤백|되돌려|원래대로|rollback|rollitback|ロールバック|元に戻)/],
  ['inject', /(장애(를)?(넣|주입)|장애테스트|오류(를)?넣|inject|failuretest|障害(を)?(入れ|注入))/],
  ['retry', /(다시시도|재시도|retry|tryagain|再試行|もう一回)/],
  ['revise', /(계획(을)?(수정|다시)|revise|replan|計画を?(直|修正))/],
  ['repeat', /(다시말해|뭐라고|한번더|다시한번|repeat|sayagain|saythatagain|もう一度|もういちど)/],
  ['status', /(지금어디|어디까지|어디야|진행상황|상황(이|은)?어때|whereare|whatstage|status|progress|今どこ|状況)/],
  ['pause', /(잠깐|멈춰|그만|조용|기다려|wait|pause|holdon|stop|待って|止まって|静かに)/],
  ['resume', /(계속해|계속보고|다시보고|resume|continue|goon|keepgoing|続けて|再開)/],
  ['advance', /(좋아|진행해|진행하자|다음|넘어가|가자|시작하자|시작해|next|goahead|proceed|moveon|okay|^ok|letsgo|letsstart|次へ|進めて|次に|始めよう|オッケー)/],
]
const CONFIRM = /(확인|^응|^네|^예|그래|맞아|해줘|해주세요|yes|confirm|sure|doit|はい|確認|お願い)/
const DENY = /(아니|취소|됐어|하지마|^no|cancel|nevermind|いいえ|やめ|キャンセル)/

/**
 * 말을 명령으로 맞춘다. 되묻는 중(confirming)이면 확인·거절을 먼저 본다.
 * 맞는 명령이 없으면 null(질문으로 넘긴다).
 */
export function matchCommand(text: string, { confirming = false }: { confirming?: boolean } = {}): CommandId | null {
  const said = normalizeUtterance(text)
  if (!said) return null
  if (confirming) {
    if (DENY.test(said)) return 'deny'
    if (CONFIRM.test(said)) return 'confirm'
  }
  for (const [id, pattern] of PATTERNS) {
    if (!pattern.test(said)) continue
    if (id === 'approve' && NEGATION.test(said)) return null
    return id
  }
  return null
}

/** 되묻고 확인을 받아야 하는 동작과 되묻는 문구 */
export const RISKY: Partial<Record<CommandId, VoiceKey>> = { rollback: 'c.confirmRollback', inject: 'c.confirmInject', cancel: 'c.confirmCancel' }

/** 명령 → 화면 동작 */
export const ACTION_OF: Partial<Record<CommandId, ActionId>> = {
  advance: 'next', approve: 'approve', rollback: 'rollback', inject: 'inject', retry: 'retry', revise: 'revise', cancel: 'cancel',
}

/** 모든 단계에서 받는 명령 */
export const COMMON: CommandId[] = ['status', 'repeat', 'pause', 'resume']

/** 단계별로 받는 동작 명령(화면 아래 안내에 쓴다). 실제 실행 여부는 화면이 등록한 동작으로 정한다. */
export const STAGE_COMMANDS: Record<string, CommandId[]> = {
  setup: ['advance'],
  analysis: ['advance'],
  rehearsal: ['advance', 'retry'],
  planning: ['advance'],
  approval: ['approve', 'revise', 'cancel'],
  provisioning: ['advance'],
  data: ['advance'],
  traffic: ['advance', 'rollback', 'inject', 'retry'],
  cutover: ['approve', 'advance'],
}

const HINT: Record<CommandId, VoiceKey> = {
  approve: 'h.approve', advance: 'h.advance', pause: 'h.pause', resume: 'h.resume', repeat: 'h.repeat', status: 'h.status',
  rollback: 'h.rollback', inject: 'h.inject', retry: 'h.retry', revise: 'h.revise', cancel: 'h.cancel', confirm: 'h.confirm', deny: 'h.cancel',
}

/**
 * 화면 아래에 보일 말 안내. 동작 명령은 화면이 지금 받을 수 있는 것(available)만, 그다음 공통 명령 몇 개.
 * 되묻는 중이면 "확인 · 취소"만 보인다.
 */
export function hintKeys(stage: string, available: ReadonlySet<ActionId>, { confirming = false, paused = false } = {}): VoiceKey[] {
  if (confirming) return ['h.confirm', 'h.cancel']
  const actions = (STAGE_COMMANDS[stage] ?? []).filter(id => {
    const action = ACTION_OF[id]
    return stage === 'setup' || (action ? available.has(action) : true)
  }).map(id => stage === 'setup' && id === 'advance' ? 'h.start' as VoiceKey : HINT[id])
  const common: VoiceKey[] = ['h.status', 'h.repeat', paused ? 'h.resume' : 'h.pause']
  return [...actions.slice(0, 3), ...common]
}
