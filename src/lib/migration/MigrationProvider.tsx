'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from 'react'
import { apiBase, apiMode, approvalBase, sseStartMode, type ApiMode } from './config'
import type { BackendPhase, Target } from './events'
import { initialState, reducer, type Action, type MigrationState } from './reducer'
import { reportFor } from './script'
import { aiFixCount } from '../demoConfig'
import { MockProvider } from './mockProvider'
import { SseProvider } from './sseProvider'
import type { MigrationProvider as Provider } from './provider'
import { capabilitiesFor, type Capability } from './capabilities'

type Api = {
  state: MigrationState
  mode: ApiMode
  provider: Provider
  /** 이 모드에서 되는 동작인지(capabilities.ts). 목업은 모두 true, SSE는 백엔드에 API가 있는 것만. */
  can: (capability: Capability) => boolean
  /** 공급자가 보낸 액션(이벤트 포함)을 받는다: 말 보고처럼 상태가 아니라 '방금 온 이벤트'가 필요한 곳이 쓴다. */
  subscribe: (listener: (action: Action) => void) => () => void
}

const MigrationContext = createContext<Api | null>(null)

/**
 * 데이터 계층. FlowApp 위쪽에 두어 단계 화면이 바뀌어도 상태가 유지된다.
 * 모드는 NEXT_PUBLIC_API_MODE(mock|sse)로 고른다.
 */
export function MigrationProvider({ children, mode = apiMode() }: { children: ReactNode; mode?: ApiMode }) {
  const [state, dispatch] = useReducer(reducer, undefined, () =>
    // 목업은 리포트의 값(소요 시간·AI 수정 개수)을 처음부터 알고 있다.
    mode === 'mock' ? { ...initialState, report: reportFor(aiFixCount()) } : initialState)
  const [listeners] = useState(() => new Set<(action: Action) => void>())
  const [capabilities] = useState(() => capabilitiesFor(mode))
  const [provider] = useState<Provider>(() => {
    const host = { dispatch: (action: Action) => { dispatch(action); listeners.forEach(listener => listener(action)) } }
    return mode === 'sse' ? new SseProvider(host, { baseUrl: apiBase(), startMode: sseStartMode(), approvalBase: approvalBase(), capabilities }) : new MockProvider(host)
  })
  const subscribe = useCallback((listener: (action: Action) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }, [listeners])
  useEffect(() => () => provider.dispose(), [provider])
  const can = useCallback((capability: Capability) => capabilities.has(capability), [capabilities])
  const value = useMemo(() => ({ state, mode, provider, can, subscribe }), [state, mode, provider, can, subscribe])
  return <MigrationContext.Provider value={value}>{children}</MigrationContext.Provider>
}

/** 화면이 읽는 단 하나의 입구: 상태(state)와 동작(provider)을 돌려준다. */
export function useMigration(): Api {
  const value = useContext(MigrationContext)
  if (!value) throw new Error('useMigration은 MigrationProvider 안에서만 쓸 수 있습니다.')
  return value
}

/** 단계 화면이 준비됐을 때(ready) 데이터 공급자에 알린다. 화면을 떠나면 자동으로 정리된다. */
export function useStageFeed(phase: BackendPhase, ready: boolean, target: Target) {
  const { provider } = useMigration()
  useEffect(() => {
    if (!ready) return
    return provider.enter(phase, { target })
  }, [provider, phase, ready, target])
}
