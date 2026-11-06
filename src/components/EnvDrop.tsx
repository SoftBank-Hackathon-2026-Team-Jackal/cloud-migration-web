'use client'

import { useEffect, useRef, useState } from 'react'
import { useT, useTOr } from '../lib/i18n'
import { classifyEnv, crossCheck, envCounts, parseEnvKeys, type EnvCheck, type EnvExceptions, type EnvKey, type EnvRow } from '../lib/setup/envFile'
import { EXAMPLE_ENV } from '../lib/setup/demoRepo'
import type { EnvFileRef } from '../lib/connections/platform'

/**
 * ref: 플랫폼에 암호화 저장된 .env의 참조(실제 모드에서만). upload: 업로드 상태(목업 모드에서는 없다).
 */
export type EnvResult = { fileName: string; keys: EnvKey[]; ref?: EnvFileRef | null; upload?: 'uploading' | 'stored' | 'failed'; uploadError?: string | null }

type Props = {
  /** 코드가 읽는 키(저장소 탐지 결과). 모르면 빈 배열 */
  expected: string[]
  /** [가정] 키 분류(백엔드 분석 EnvExceptions 모양). 없으면 모든 키가 '분류 대기'다. 화면은 키 이름으로 분류를 짐작하지 않는다. */
  exceptions?: EnvExceptions | null
  value: EnvResult | null
  onChange: (value: EnvResult | null) => void
  /** E 키로 예시 .env를 넣을 수 있게 부모에게 함수를 넘긴다 */
  exampleRef?: { current: (() => void) | null }
}

/**
 * .env 드롭 영역. 키 이름은 브라우저에서 읽는다. 값은 화면·상태·로그 어디에도 넣지 않고 화면에는 •••• 만 보인다.
 * - 목업 모드: 원문을 어디에도 보내지 않는다(이 함수 안에서 버린다).
 * - 실제 모드(웹 서버 GET /api/env-files가 upload=true): 원문을 우리 웹 서버로 한 번 보내고, 웹 서버가 플랫폼 암호화 저장소에 넣는다.
 *   브라우저에는 참조(env_file_ref)만 남는다. 원문은 상태에 두지 않으며 업로드가 실패하면 파일을 다시 고르게 한다.
 */
export default function EnvDrop({ expected, exceptions, value, onChange, exampleRef }: Props) {
  const t = useT()
  const tOr = useTOr()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState(false)
  const [uploadMode, setUploadMode] = useState(false)
  const attempt = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/env-files', { cache: 'no-store', signal: controller.signal })
      .then(response => (response.ok ? response.json() : null))
      .then((data: { upload?: unknown } | null) => setUploadMode(data?.upload === true), () => {})
    return () => controller.abort()
  }, [])

  const accept = (fileName: string, text: string) => {
    const keys = parseEnvKeys(text)
    setError(false)
    const id = ++attempt.current
    if (!uploadMode) { onChange({ fileName, keys }); return }
    onChange({ fileName, keys, ref: null, upload: 'uploading' })
    fetch('/api/env-files', { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text, cache: 'no-store' })
      .then(async response => {
        const data = await response.json().catch(() => null) as { env_file_ref?: EnvFileRef; detail?: string; error?: string } | null
        if (id !== attempt.current) return
        if (response.ok && data?.env_file_ref) onChange({ fileName, keys, ref: data.env_file_ref, upload: 'stored' })
        else onChange({ fileName, keys, ref: null, upload: 'failed', uploadError: data?.detail ?? data?.error ?? String(response.status) })
      }, () => { if (id === attempt.current) onChange({ fileName, keys, ref: null, upload: 'failed', uploadError: 'UNREACHABLE' }) })
  }
  const replace = () => { attempt.current += 1; onChange(null) }
  const readFile = (file: File | undefined) => {
    if (!file) return
    file.text().then(text => accept(file.name, text), () => setError(true))
  }
  const useExample = () => accept('.env', EXAMPLE_ENV)
  if (exampleRef) exampleRef.current = useExample

  const check: EnvCheck | null = value && expected.length ? crossCheck(value.keys, expected) : null
  // 줄은 받은 분류 그대로(.env 키 → .env에 없는 missing 키). 분류 데이터가 없으면 '분류 대기'.
  const rows: EnvRow[] = value ? classifyEnv(value.keys, exceptions) : []
  const counts = envCounts(rows)
  const tagOf = (row: EnvRow) => row.treatment === 'others' ? tOr('setup2.envOthers.' + row.others, row.others ?? '') : t(('setup2.envT.' + row.treatment) as 'setup2.envT.pending')
  const summary = (['others', 'replaced', 'excluded', 'missing', 'pending'] as const).filter(id => counts[id] > 0)
    .map(id => (id === 'others' ? tOr('setup2.envOthers.' + exceptions?.others, exceptions?.others ?? '') : t(('setup2.envT.' + id) as 'setup2.envT.pending')) + ' ' + counts[id]).join(' · ')

  return <div className="envd">
    <input ref={inputRef} className="migration-file-input" type="file" aria-label={t('setup.envPick')}
      onChange={event => { readFile(event.target.files?.[0]); event.target.value = '' }} />
    {!value && <div className={'migration-upload envd-drop' + (dragging ? ' is-dragging' : '')}
      role="button" tabIndex={0} aria-label={t('setup.envAttach')}
      onClick={() => inputRef.current?.click()}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inputRef.current?.click() } }}
      onDragOver={event => { event.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => { event.preventDefault(); setDragging(false); readFile(event.dataTransfer.files[0]) }}
      onPaste={event => { const pasted = event.clipboardData.getData('text'); if (pasted) { event.preventDefault(); accept('.env', pasted) } }}>
      <span className="migration-upload-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 16.5v2A1.5 1.5 0 005.5 20h13a1.5 1.5 0 001.5-1.5v-2" />
        </svg>
      </span>
      <strong>{t('setup2.envDrop')}</strong>
      <span>{t('setup2.envDropSub')}</span>
    </div>}
    {!value && <div className="envd-actions">
      <button type="button" className="envd-btn" onClick={() => inputRef.current?.click()}>{t('setup2.envChoose')}</button>
      <button type="button" className="envd-btn envd-example" onClick={useExample}>{t('setup2.envExample')} <kbd>E</kbd></button>
    </div>}
    {error && <p className="repo-note is-alert" role="alert">{t('setup2.envReadError')}</p>}
    {value && <>
      <div className="envd-head">
        <span className="envd-file">{t('setup2.envFile', { name: value.fileName, count: value.keys.length })}</span>
        <button type="button" className="repo-link" onClick={replace}>{t('setup2.envReplace')}</button>
      </div>
      {value.upload === 'uploading' && <p className="repo-note" role="status" data-env-upload="uploading">{t('setup2.envUploading')}</p>}
      {value.upload === 'stored' && <p className="repo-note" role="status" data-env-upload="stored">{t('setup2.envStored')}</p>}
      {value.upload === 'failed' && <p className="repo-note is-alert" role="alert" data-env-upload="failed">{t('setup2.envUploadFailed', { code: value.uploadError ?? '' })}</p>}
      {check && <div className="envd-sum" role="status">
        <strong>{t('setup2.envSummary', { expected: check.expected, present: check.present.length })}</strong>
        <span>{check.missing.length ? t('setup2.envMissingKeys', { keys: check.missing.join(', ') }) : t('setup2.envAll')}</span>
      </div>}
      {summary && <p className="envd-class" data-classified={exceptions ? 'data' : 'pending'}>{summary}</p>}
      {!check && <div className="envd-sum" role="status"><strong>{t('setup2.envCount', { count: value.keys.length })}</strong></div>}
      <ul className="envd-keys" aria-label={t('setup2.keysAria')}>
        {rows.map((row, index) => <li key={row.name} className={'envd-key is-' + row.treatment + (row.empty ? ' is-empty' : '')} data-treatment={row.treatment} style={{ animationDelay: index * 90 + 'ms' }}>
          <code>{row.name}</code>
          {/* 값은 늘 가린다(빈 값·없는 키는 —). 바인딩 참조 이름은 값이 아니라 참조라 보인다. */}
          <span className="envd-mask" aria-label={t('setup2.masked')}>{row.empty ? '—' : '••••'}</span>
          <span className="envd-tag" title={row.ref ? t('setup2.envRefNote', { ref: row.ref }) : undefined}>{tagOf(row)}{row.ref && <small className="envd-ref">→ {row.ref}</small>}</span>
        </li>)}
      </ul>
    </>}
    <p className="envd-policy">{t(uploadMode ? 'setup2.envPolicyStored' : 'setup2.envPolicy')}</p>
  </div>
}
