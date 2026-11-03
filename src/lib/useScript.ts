'use client'

import { useEffect, useState } from 'react'

export type TimedItem<T> = { after: number; item: T }

/** 데모용: enabled가 true가 된 시점부터 스크립트의 항목을 시간 순서대로 하나씩 내보낸다. */
export function useScript<T>(script: ReadonlyArray<TimedItem<T>>, enabled: boolean): T[] {
  const [items, setItems] = useState<T[]>([])
  useEffect(() => {
    if (!enabled) return
    setItems([])
    const timers = script.map(({ after, item }) =>
      window.setTimeout(() => setItems(current => [...current, item]), after))
    return () => timers.forEach(timer => window.clearTimeout(timer))
  }, [enabled, script])
  return items
}
