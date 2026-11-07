'use client'

import { useEffect, useRef, useState } from 'react'
import { temporalStatusOf, type TemporalStatus } from '../lib/temporalStatus'
import { FaultCard, HealthCard } from './tools/ToolsPage'
import '../app/settings/settings.css'
import '../app/tools/tools.css'

/**
 * 오른쪽 패널(항상 켜짐): Temporal 탭은 Temporal UI를 iframe으로, Tools 탭은 시연용 장애 주입과 원본·대상 지표를 보여 준다.
 * 다른 화면은 `window.dispatchEvent(new Event(OPEN_TOOLS_EVENT))`로 패널을 Tools 탭으로 연다.
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
export const OPEN_TOOLS_EVENT = 'jackal:open-tools'
type Tab = 'temporal' | 'tools'
const MIN = 280
const defaultWidth = () => Math.round(window.innerWidth * 0.38)
const clamp = (w: number) => Math.min(Math.max(w, MIN), window.innerWidth - 40)

export default function TemporalSidebar() {
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<Tab>('temporal')
  const [width, setWidth] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [root, setRoot] = useState<string | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const start = useRef({ x: 0, w: 0 })

  useEffect(() => {
    const saved = Number(localStorage.getItem(KEY))
    setWidth(clamp(saved || defaultWidth()))
  }, [])

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const wf = new URLSearchParams(location.search).get('wf')
        const res = await fetch('/api/temporal' + (wf ? `?wf=${encodeURIComponent(wf)}` : ''), { cache: 'no-store' })
        const json = await res.json()
        if (!alive) return
        if (json.root) setRoot(json.root)
        setStatus(json.error ? 'error' : temporalStatusOf(json.workflows ?? []))
      } catch { if (alive) setStatus('error') }
    }
    tick()
    const timer = setInterval(tick, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [])

  useEffect(() => {
    const show = () => { setTab('tools'); setOpen(true) }
    window.addEventListener(OPEN_TOOLS_EVENT, show)
    return () => window.removeEventListener(OPEN_TOOLS_EVENT, show)
  }, [])

  useEffect(() => {
    if (width && !dragging) localStorage.setItem(KEY, String(width))
  }, [width, dragging])

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
        <nav className="tsb-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'temporal'} className={tab === 'temporal' ? 'is-on' : ''} onClick={() => setTab('temporal')}>
            <strong className={`is-${status}`}><StatusIcon status={status} /> Temporal <em>{LABEL[status]}</em></strong>
          </button>
          <button role="tab" aria-selected={tab === 'tools'} className={tab === 'tools' ? 'is-on' : ''} data-testid="tsb-tools-tab" onClick={() => setTab('tools')}>Tools</button>
        </nav>
        <button onClick={() => setOpen(false)} aria-label="close">×</button>
      </header>
      {/* iframe은 탭을 바꿔도 남겨 둔다(다시 불러오지 않게). */}
      <iframe key={src} src={src} title="Temporal UI" hidden={tab !== 'temporal'} />
      {tab === 'tools' && <div className="tsb-tools"><FaultCard /><HealthCard /></div>}
    </aside>
  </>
}
