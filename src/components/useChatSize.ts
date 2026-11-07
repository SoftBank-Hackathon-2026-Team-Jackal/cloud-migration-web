'use client'

import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { CHAT_SIZE_KEY, clampSize, dragSize, isLarge, largeSize, parseChatSize, type ChatSize } from '../lib/agent/chatSize'

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight })

function store(size: ChatSize | null) {
  try {
    if (size) window.localStorage.setItem(CHAT_SIZE_KEY, JSON.stringify(size))
    else window.localStorage.removeItem(CHAT_SIZE_KEY)
  } catch { /* 저장소를 못 써도 이번 화면에서는 크기가 유지된다 */ }
}

/** Jackal 대화창 크기: 왼쪽 아래 손잡이로 끌어서 바꾸고, 크게 보기 버튼으로 전환한다. 브라우저에 기억한다. */
export function useChatSize(panelRef: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState<ChatSize | null>(null)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ x: number; y: number; start: ChatSize } | null>(null)

  useEffect(() => {
    let saved: ChatSize | null = null
    try { saved = parseChatSize(window.localStorage.getItem(CHAT_SIZE_KEY)) } catch { /* 기본 크기 */ }
    if (saved) setSize(clampSize(saved, viewport()))
    const onResize = () => setSize(current => current && clampSize(current, viewport()))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onGripDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const panel = panelRef.current
    if (!panel || event.button !== 0) return
    event.preventDefault()
    const box = panel.getBoundingClientRect()
    drag.current = { x: event.clientX, y: event.clientY, start: { w: box.width, h: box.height } }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
  }, [panelRef])

  const onGripMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const from = drag.current
    if (!from) return
    setSize(dragSize(from.start, event.clientX - from.x, event.clientY - from.y, viewport()))
  }, [])

  const onGripUp = useCallback(() => {
    if (!drag.current) return
    drag.current = null
    setDragging(false)
    setSize(current => { store(current); return current })
  }, [])

  const reset = useCallback(() => { setSize(null); store(null) }, [])

  /** 키보드: 화살표로 24px씩(왼쪽·아래가 커짐), Home으로 기본 크기 */
  const onGripKey = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const step = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowDown: [0, 24], ArrowUp: [0, -24] }[event.key]
    if (event.key === 'Home') { event.preventDefault(); reset(); return }
    const panel = panelRef.current
    if (!step || !panel) return
    event.preventDefault()
    const box = panel.getBoundingClientRect()
    const next = dragSize({ w: box.width, h: box.height }, step[0], step[1], viewport())
    setSize(next)
    store(next)
  }, [panelRef, reset])

  const large = size !== null && typeof window !== 'undefined' && isLarge(size, viewport())
  const toggleLarge = useCallback(() => {
    if (large) { reset(); return }
    const next = largeSize(viewport())
    setSize(next)
    store(next)
  }, [large, reset])

  const style: CSSProperties | undefined = size ? { width: size.w, height: size.h } : undefined
  return { size, style, large, dragging, toggleLarge, reset, grip: { onPointerDown: onGripDown, onPointerMove: onGripMove, onPointerUp: onGripUp, onPointerCancel: onGripUp, onDoubleClick: reset, onKeyDown: onGripKey } }
}
