'use client'

import { useEffect, useRef, useState } from 'react'
import { temporalStatusOf, type TemporalStatus } from '../lib/temporalStatus'
import { readMigration } from '../lib/migration/session'

/**
 * 오른쪽 패널(항상 켜짐): Temporal UI를 iframe으로 띄운다. 시연용 장애 주입은 왼쪽 ToolsPanel이 맡는다.
 * 보여 줄 이전: 이 탭이 진행 중인 이전 → 없으면 실행 중인 이전 → 없으면 워크플로 목록.
 * 열림·닫힘은 localStorage에 남겨, 페이지를 새로 불러와도(로그인 리다이렉트, /settings 이동) 닫아 둔 패널이 다시 열리지 않는다.
 * Temporal UI는 next.config.ts의 fallback rewrite로 같은 origin에서 열린다. 새 이전 건이 시작되면 그 워크플로로 옮겨 간다.
 * 왼쪽 가장자리를 끌어 폭을 바꾸고(더블클릭하면 기본 폭), 폭은 localStorage에 남긴다.
 */
type Status = TemporalStatus
const LABEL: Record<Status, string> = { idle: 'Idle', running: 'Running', done: 'Completed', failed: 'Failed', error: 'Disconnected' }

/** 실행 중이면 도는 고리, 끝나면 체크, 실패면 X */
function StatusIcon({ status }: { status: Status }) {
  return <svg className={`tsb-icon is-${status}`} viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
    <circle className="tsb-icon-track" cx="10" cy="10" r="8" />
    {status === 'running' && <circle className="tsb-icon-arc" cx="10" cy="10" r="8" />}
    {status === 'done' && <path d="M6 10.5l2.7 2.7L14.2 7.4" />}
    {(status === 'failed' || status === 'error') && <path d="M7 7l6 6M13 7l-6 6" />}
    {status === 'idle' && <circle cx="10" cy="10" r="2" className="tsb-icon-dot" />}
  </svg>
}

const KEY = 'temporal-sidebar-width'
const OPEN_KEY = 'temporal-sidebar-open'
const MIN = 280
const defaultWidth = () => Math.round(window.innerWidth * 0.38)
const clamp = (w: number) => Math.min(Math.max(w, MIN), window.innerWidth - 40)

export default function TemporalSidebar() {
  // null: 저장된 값을 읽기 전(서버 렌더와 맞추려고 그동안은 그리지 않는다)
  const [open, setOpenState] = useState<boolean | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [root, setRoot] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const start = useRef({ x: 0, w: 0 })

  useEffect(() => {
    const saved = Number(localStorage.getItem(KEY))
    setWidth(clamp(saved || defaultWidth()))
    setOpenState(localStorage.getItem(OPEN_KEY) !== '0')
  }, [])

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        // 이 탭이 진행 중인 이전(?migration= 또는 sessionStorage)을 따라간다. 없으면 서버가 실행 중인 이전을 고른다.
        let storage: Storage | null = null
        try { storage = sessionStorage } catch { /* 저장소를 못 쓰면 주소만 */ }
        const wf = new URLSearchParams(location.search).get('wf') ?? readMigration({ location, history, storage })?.id ?? null
        const res = await fetch('/api/temporal' + (wf ? `?wf=${encodeURIComponent(wf)}` : ''), { cache: 'no-store' })
        const json = await res.json()
        if (!alive) return
        setRoot(json.root ?? null)
        setStatus(json.error ? 'error' : temporalStatusOf(json.workflows ?? []))
      } catch { if (alive) setStatus('error') }
    }
    tick()
    const timer = setInterval(tick, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  useEffect(() => {
    if (width && !dragging) localStorage.setItem(KEY, String(width))
  }, [width, dragging])

  const setOpen = (value: boolean) => {
    setOpenState(value)
    try { localStorage.setItem(OPEN_KEY, value ? '1' : '0') } catch { /* 저장 못 해도 이번 화면에서는 동작한다 */ }
  }

  if (open === null) return null
  const src = root ? `/namespaces/default/workflows/${encodeURIComponent(root)}` : '/namespaces/default/workflows'

  return <>
    {!open && <button className={`tsb-toggle is-${status}`} onClick={() => setOpen(true)}><StatusIcon status={status} /> Temporal</button>}
    <aside className={`tsb${dragging ? ' is-dragging' : ''}`} hidden={!open} style={width ? { width } : undefined}>
      <div
        className="tsb-handle"
        title="끌어서 폭 조절 · 더블클릭하면 기본 폭"
        onPointerDown={e => {
          e.preventDefault()
          e.currentTarget.setPointerCapture(e.pointerId)
          start.current = { x: e.clientX, w: width ?? defaultWidth() }
          setDragging(true)
        }}
        onPointerMove={e => { if (dragging) setWidth(clamp(start.current.w + start.current.x - e.clientX)) }}
        onPointerUp={e => { e.currentTarget.releasePointerCapture(e.pointerId); setDragging(false) }}
        onPointerCancel={() => setDragging(false)}
        onDoubleClick={() => setWidth(clamp(defaultWidth()))}
      />
      <header>
        <strong className={`is-${status}`}><StatusIcon status={status} /> Temporal <em>{LABEL[status]}</em></strong>
        <button onClick={() => setOpen(false)} aria-label="close">×</button>
      </header>
      <iframe key={src} src={src} title="Temporal UI" />
    </aside>
  </>
}
