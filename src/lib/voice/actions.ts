'use client'

/**
 * 단계 화면이 음성에 맡기는 동작(버튼과 같은 처리기)을 등록하는 곳. 화면마다 한 줄:
 *   useVoiceActions({ next: canGo ? onNext : undefined })
 * 처리기가 없거나 false면 그 동작은 지금 받을 수 없다(버튼이 꺼져 있는 것과 같다). 한 번에 한 화면만 등록한다.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { ActionId } from './commands'

export type VoiceActions = Partial<Record<ActionId, (() => void) | false | null | undefined>>

let current: { owner: symbol; actions: VoiceActions } | null = null
let available: ReadonlySet<ActionId> = new Set()
const listeners = new Set<() => void>()

function publish(next: typeof current) {
  current = next
  const ids = next ? (Object.keys(next.actions) as ActionId[]).filter(id => typeof next.actions[id] === 'function') : []
  const same = ids.length === available.size && ids.every(id => available.has(id))
  if (same) return
  available = new Set(ids)
  listeners.forEach(listener => listener())
}

/** 지금 화면이 받을 수 있으면 처리기, 아니면 null */
export function voiceAction(id: ActionId): (() => void) | null {
  const handler = current?.actions[id]
  return typeof handler === 'function' ? handler : null
}

export function useVoiceActions(actions: VoiceActions) {
  const owner = useRef(Symbol('voice-actions'))
  useEffect(() => { publish({ owner: owner.current, actions }) })
  useEffect(() => {
    const me = owner.current
    return () => { if (current?.owner === me) publish(null) }
  }, [])
}

/** 화면 아래 안내가 읽는다: 지금 받을 수 있는 동작 */
export function useAvailableVoiceActions(): ReadonlySet<ActionId> {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    () => available,
    () => available,
  )
}
