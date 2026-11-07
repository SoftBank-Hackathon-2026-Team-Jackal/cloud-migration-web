/**
 * Jackal 대화창 크기. 창은 화면 오른쪽 위에 붙어 있어서 왼쪽 아래 모서리를 끌어 키운다.
 * null은 기본 크기(CSS가 정함). 저장한 크기는 창 크기가 바뀌어도 화면 안으로 다시 맞춘다.
 */
export type ChatSize = { w: number; h: number }
export type Viewport = { w: number; h: number }

export const CHAT_SIZE_KEY = 'jackal.chatSize'
export const MIN_W = 300
export const MIN_H = 260
/** 화면 가장자리와 위쪽 알약·아래쪽 데모 바에 남겨 두는 여백 */
const SIDE_GAP = 28
const VERTICAL_GAP = 120

export function clampSize(size: ChatSize, view: Viewport): ChatSize {
  const maxW = Math.max(MIN_W, view.w - SIDE_GAP)
  const maxH = Math.max(MIN_H, view.h - VERTICAL_GAP)
  return {
    w: Math.round(Math.min(maxW, Math.max(MIN_W, size.w))),
    h: Math.round(Math.min(maxH, Math.max(MIN_H, size.h))),
  }
}

/** 왼쪽 아래 모서리를 (dx, dy)만큼 끈 크기: 왼쪽으로 끌면 넓어지고 아래로 끌면 길어진다 */
export function dragSize(start: ChatSize, dx: number, dy: number, view: Viewport): ChatSize {
  return clampSize({ w: start.w - dx, h: start.h + dy }, view)
}

/** 크게 보기: 화면 높이에 가깝고 읽기 편한 너비(최대 640px) */
export function largeSize(view: Viewport): ChatSize {
  return clampSize({ w: Math.min(640, view.w * .45), h: view.h }, view)
}

/** 지금 크기가 '크게 보기'와 거의 같으면 true(버튼을 다시 누르면 기본 크기로 돌아간다) */
export function isLarge(size: ChatSize | null, view: Viewport): boolean {
  if (!size) return false
  const large = largeSize(view)
  return Math.abs(size.w - large.w) < 8 && Math.abs(size.h - large.h) < 8
}

export function parseChatSize(raw: string | null): ChatSize | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<ChatSize>
    return typeof value.w === 'number' && typeof value.h === 'number' && Number.isFinite(value.w) && Number.isFinite(value.h)
      ? { w: value.w, h: value.h }
      : null
  } catch {
    return null
  }
}
