'use client'

import { useEffect, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import { FaultCard, HealthCard } from './ToolsPage'
import AppTelemetryPanel from '../AppTelemetryPanel'
import '../../app/settings/settings.css'
import '../../app/tools/tools.css'

/** 다른 화면이 `window.dispatchEvent(new Event(OPEN_TOOLS_EVENT))`로 왼쪽 Tools 패널을 연다(트래픽 안정화 구간의 '장애 주입'). */
export const OPEN_TOOLS_EVENT = 'jackal:open-tools'
const OPEN_KEY = 'tools-panel-open'

/**
 * 왼쪽 Tools 패널(디버그 패널): 시연용 장애 주입과 원본·대상 지표. 오른쪽 Temporal 사이드바와 겹치지 않아 둘을 함께 볼 수 있다.
 * 닫혀 있으면 왼쪽 아래 버튼만 보인다. 열림·닫힘은 localStorage에 남긴다(처음에는 닫힘).
 */
export default function ToolsPanel() {
  const { t } = useI18n()
  const [open, setOpenState] = useState(false)
  const setOpen = (value: boolean) => {
    setOpenState(value)
    try { localStorage.setItem(OPEN_KEY, value ? '1' : '0') } catch { /* 저장 못 해도 이번 화면에서는 동작한다 */ }
  }
  useEffect(() => {
    try { if (localStorage.getItem(OPEN_KEY) === '1') setOpenState(true) } catch { /* 닫힌 채로 시작 */ }
    const show = () => setOpen(true)
    window.addEventListener(OPEN_TOOLS_EVENT, show)
    return () => window.removeEventListener(OPEN_TOOLS_EVENT, show)
  }, [])

  if (!open) return <button type="button" className="tlp-toggle" data-testid="tools-toggle" onClick={() => setOpen(true)}>{t('tools.title')}</button>
  return <aside className="tlp" aria-label={t('tools.title')} data-testid="tools-panel">
    <header>
      <strong>{t('tools.title')}</strong>
      <button type="button" onClick={() => setOpen(false)} aria-label="close">×</button>
    </header>
    <div className="tlp-body"><FaultCard /><HealthCard /><AppTelemetryPanel /></div>
  </aside>
}
