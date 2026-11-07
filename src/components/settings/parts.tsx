'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useI18n, type MsgKey } from '../../lib/i18n'
import type { ApiErrorCode } from '../../lib/connections/types'
import { SHOW_MOCK_BADGE } from '../../lib/connections/client'

/** 1초마다 바뀌는 지금 시각(초) */
export function useNowSeconds(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return now
}

/** "3분 전" 같은 상대 시각. 기준 시각은 title로 보여 준다. */
export function Ago({ at, now }: { at: number | null; now: number }) {
  const { t, lang } = useI18n()
  if (at === null) return <span className="cx-faint">{t('cx.never')}</span>
  const diff = Math.max(0, now - at)
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' })
  const text = diff < 60 ? rtf.format(-diff, 'second') : diff < 3600 ? rtf.format(-Math.floor(diff / 60), 'minute') : diff < 86400 ? rtf.format(-Math.floor(diff / 3600), 'hour') : rtf.format(-Math.floor(diff / 86400), 'day')
  return <time dateTime={new Date(at * 1000).toISOString()} title={new Date(at * 1000).toLocaleString(lang)}>{text}</time>
}

export type ChipTone = 'ok' | 'live' | 'wait' | 'off' | 'bad'
export function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return <span className={'cx-chip is-' + tone} data-tone={tone}><i aria-hidden="true" />{children}</span>
}

/** 개발 모드에서만 보이는 목업 표시 */
export function MockBadge({ show = true }: { show?: boolean }) {
  const { t } = useI18n()
  if (!SHOW_MOCK_BADGE || !show) return null
  return <span className="cx-mock" title={t('cx.mockHint')}>{t('cx.mock')}</span>
}

/** 오류 코드별 안내(403 운영자 키, 404, 409, 503 …) */
export function ErrorNote({ error, detail, title, onRetry }: { error: ApiErrorCode; detail?: string | null; title?: string; onRetry?: () => void }) {
  const { t, tOr } = useI18n()
  const message = (detail && tOr('cx.code.' + detail, '')) || t(('cx.err.' + error) as MsgKey)
  return <div className="cx-error" role="alert" data-error={error}>
    <div>
      <strong>{title ?? ((detail && tOr('cx.codeTitle.' + detail, '')) || t(('cx.errTitle.' + error) as MsgKey))}</strong>
      <span>{message}</span>
      {detail && <code>{detail}</code>}
    </div>
    {onRetry && <button type="button" className="cx-btn" onClick={onRetry}>{t('cx.retry')}</button>}
  </div>
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return <button type="button" className="cx-btn cx-copy" aria-label={label} onClick={() => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1600)
    }, () => {})
  }}>{copied ? t('cx.copied') : t('cx.copy')}</button>
}

/** 카드 오른쪽 위의 작은 메뉴 */
export function CardMenu({ label, items }: { label: string; items: Array<{ id: string; text: string; danger?: boolean; disabled?: boolean; onSelect: () => void }> }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !ref.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', close) }
  }, [open])
  return <div className="cx-menu" ref={ref}>
    <button type="button" className="cx-menu-btn" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen(value => !value)}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></svg>
    </button>
    {open && <div className="cx-menu-list" role="menu">
      {items.map(item => <button key={item.id} type="button" role="menuitem" data-action={item.id} disabled={item.disabled}
        className={item.danger ? 'is-danger' : ''} onClick={() => { setOpen(false); item.onSelect() }}>{item.text}</button>)}
    </div>}
  </div>
}

export function Modal({ open, onOpenChange, title, description, children, wide }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: ReactNode; wide?: boolean
}) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="cx-overlay" />
      <Dialog.Content className={'cx-dialog' + (wide ? ' is-wide' : '')}
        onInteractOutside={event => event.preventDefault()}>
        <Dialog.Title className="cx-dialog-title">{title}</Dialog.Title>
        {description ? <Dialog.Description className="cx-dialog-desc">{description}</Dialog.Description> : <Dialog.Description className="cx-sr" />}
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

/** 되돌릴 수 없는 작업 확인 */
export function ConfirmDialog({ open, title, body, confirm, danger, busy, onCancel, onConfirm }: {
  open: boolean; title: string; body: string; confirm: string; danger?: boolean; busy?: boolean; onCancel: () => void; onConfirm: () => void
}) {
  const { t } = useI18n()
  return <Modal open={open} onOpenChange={value => { if (!value && !busy) onCancel() }} title={title} description={body}>
    <div className="cx-dialog-actions">
      <button type="button" className="cx-btn" onClick={onCancel} disabled={busy}>{t('cx.cancel')}</button>
      <button type="button" className={'cx-primary' + (danger ? ' is-danger' : '')} onClick={onConfirm} disabled={busy} data-confirm="yes">{busy ? t('cx.working') : confirm}</button>
    </div>
  </Modal>
}

export function Skeleton({ rows = 2 }: { rows?: number }) {
  const { t } = useI18n()
  return <div className="cx-skeleton" role="status" aria-label={t('cx.loading')}>
    {Array.from({ length: rows }, (_, index) => <div key={index} className="cx-skel-row"><span /><span /><span /></div>)}
  </div>
}
