import { useEffect, useRef, useState } from 'react'
import type { TrafficSnapshotData } from './events'

/**
 * 관찰 창의 남은 시간. 서버는 단계마다 "관찰 중" 상태를 한 번만 보내며 남은 시간에는 창 전체 길이를 담는다.
 * 그래서 상태를 받은 뒤 흐른 시간을 빼서 화면에서 줄인다(0 아래로 내려가지 않는다).
 */
export function observeLeftNow(baseSeconds: number, elapsedMs: number): number {
  return Math.max(0, baseSeconds - Math.max(0, elapsedMs) / 1000)
}

/** 관찰 중인 상태의 남은 시간을 0.2초마다 줄여 돌려준다. 그 밖의 상태와 목업(자체 시계가 있다)은 받은 값 그대로다. */
export function useLiveObservation(snapshot: TrafficSnapshotData | null, enabled: boolean): TrafficSnapshotData | null {
  const [now, setNow] = useState(() => Date.now())
  const seen = useRef<{ snapshot: TrafficSnapshotData | null; at: number }>({ snapshot, at: Date.now() })
  if (seen.current.snapshot !== snapshot) seen.current = { snapshot, at: Date.now() }
  const active = enabled && snapshot?.phase === 'observing'
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(timer)
  }, [active, snapshot])
  if (!snapshot || !active) return snapshot
  const left = observeLeftNow(snapshot.gate.observe_left_seconds, now - seen.current.at)
  return { ...snapshot, gate: { ...snapshot.gate, observe_left_seconds: left } }
}
