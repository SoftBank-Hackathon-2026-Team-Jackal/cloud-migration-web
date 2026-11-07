'use client'

import { useEffect, useState } from 'react'
import { useI18n } from '../../lib/i18n'
import { faultActive, parseFaultView } from '../../lib/tools/fault'
import '../../app/tools/tools.css'

const POLL_MS = 5000

/**
 * 데모 화면 아래쪽의 "장애 주입 중" 배지. 시연용 장애가 대상 앱에서 실제로 켜져 있을 때만 보인다
 * (일부러 낸 장애임을 화면에 밝힌다). Tools가 꺼져 있거나(404) 플랫폼에 닿지 못하면 묻기를 멈춘다.
 */
export default function FaultBadge() {
  const { t } = useI18n()
  const [active, setActive] = useState(false)
  useEffect(() => {
    let alive = true
    let timer = 0
    const load = async () => {
      const response = await fetch('/api/tools/fault', { cache: 'no-store' }).catch(() => null)
      if (!alive) return
      if (!response || response.status === 204 || response.status === 404 || response.status === 503) { setActive(false); return }
      const view = response.ok ? parseFaultView(await response.json().catch(() => null)) : null
      if (alive) setActive(faultActive(view))
      timer = window.setTimeout(load, POLL_MS)
    }
    void load()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [])
  if (!active) return null
  return <a className="fault-badge" href="/tools" aria-label={t('tools.badgeAria')}><i aria-hidden="true" />{t('tools.badge')}</a>
}
