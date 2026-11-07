import { parseWake } from './wake.ts'

/**
 * 누르고 말하기(Push-to-talk): 지정 키(스페이스바)나 위젯 마이크 버튼을 누르고 있는 동안만 듣는다.
 * 계속 듣기(예전 방식)는 위젯에서 고를 수 있고, 고른 값은 localStorage에 남는다.
 */
export type ListenMode = 'ptt' | 'continuous'
export const LISTEN_MODE_KEY = 'jackal.listenMode'
/** 누르고 말하기 키. 다른 발표자 단축키(L·I·O·G·D·S·E·R)와 겹치지 않는다. */
export const PTT_CODE = 'Space'

/** 저장된 값 → 듣기 방식(모르는 값이면 기본: 누르고 말하기) */
export const parseListenMode = (saved: string | null | undefined): ListenMode => saved === 'continuous' ? 'continuous' : 'ptt'

/** 글자를 치는 곳이면 키를 가로채지 않는다(INPUT·TEXTAREA·SELECT·contenteditable). */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!target) return false
  const tag = (target.tagName ?? '').toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
}

type KeyLike = { type: string; key: string; code?: string; repeat?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }

/**
 * 키 이벤트 → 누름(press) · 뗌(release) · 무시(null).
 * 누르고 말하기 모드에서 스페이스바만 본다. 꾹 눌러 생기는 반복 keydown, 입력창, 조합키는 무시한다.
 * 뗌은 누르는 중일 때만 의미가 있다(holding).
 */
export function pttKeyAction(event: KeyLike, { mode, typing, holding }: { mode: ListenMode; typing: boolean; holding: boolean }): 'press' | 'release' | null {
  if (mode !== 'ptt') return null
  const space = event.code === PTT_CODE || event.key === ' ' || event.key === 'Spacebar'
  if (!space) return null
  if (event.type === 'keyup') return holding ? 'release' : null
  if (event.type !== 'keydown' || event.repeat || typing || event.metaKey || event.ctrlKey || event.altKey) return null
  return holding ? null : 'press'
}

/**
 * 누른 동안 들은 한 마디를 어디로 보낼지. 호출어는 없어도 되고, 있으면 떼고 쓴다.
 * - 첫 화면(질문을 받지 않는 화면): 시작 전이면 호출(wake) 뒤 의도, 시작 뒤면 의도
 * - 단계 화면: 명령 → (명령이 아니면) 질문. 지금의 armed 상태와 같다.
 */
export type PttRoute = { kind: 'none' } | { kind: 'wake'; intent: string } | { kind: 'intent'; text: string } | { kind: 'command'; text: string }
export function pttRoute(transcript: string, { ask, started }: { ask: boolean; started: boolean }): PttRoute {
  const { woke, rest } = parseWake(transcript)
  const text = (woke ? rest : transcript).trim()
  if (ask) return text ? { kind: 'command', text } : { kind: 'none' }
  if (!started) return { kind: 'wake', intent: text.length > 3 ? text : '' }
  return text ? { kind: 'intent', text } : { kind: 'none' }
}
