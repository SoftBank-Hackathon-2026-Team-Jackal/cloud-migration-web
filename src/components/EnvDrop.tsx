'use client'

import { useRef, useState } from 'react'
import { useT } from '../lib/i18n'
import { crossCheck, parseEnvKeys, type EnvCheck, type EnvKey } from '../lib/setup/envFile'
import { EXAMPLE_ENV } from '../lib/setup/demoRepo'

export type EnvResult = { fileName: string; keys: EnvKey[] }

type Props = {
  /** 코드가 읽는 키(저장소 탐지 결과). 모르면 빈 배열 */
  expected: string[]
  value: EnvResult | null
  onChange: (value: EnvResult | null) => void
  /** E 키로 예시 .env를 넣을 수 있게 부모에게 함수를 넘긴다 */
  exampleRef?: { current: (() => void) | null }
}

/**
 * .env 드롭 영역. 파일은 브라우저 안에서만 읽고 키 이름만 남긴다(원문 문자열은 이 함수 안에서 버린다).
 * 값은 화면·상태·로그·요청 어디에도 넣지 않는다. 화면에는 키 이름과 •••• 만 보인다.
 */
export default function EnvDrop({ expected, value, onChange, exampleRef }: Props) {
  const t = useT()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState(false)

  const accept = (fileName: string, text: string) => {
    const keys = parseEnvKeys(text)
    setError(false)
    onChange({ fileName, keys })
  }
  const readFile = (file: File | undefined) => {
    if (!file) return
    file.text().then(text => accept(file.name, text), () => setError(true))
  }
  const useExample = () => accept('.env', EXAMPLE_ENV)
  if (exampleRef) exampleRef.current = useExample

  const check: EnvCheck | null = value && expected.length ? crossCheck(value.keys, expected) : null
  const missing = new Set(check?.missing ?? [])
  // 순서: 코드가 읽는 키(있음) → 없는 키(기본값) → .env에만 있는 키
  const wanted = new Set(expected)
  const row = (key: EnvKey) => ({ name: key.name, state: key.empty ? 'empty' as const : key.kind })
  const rows: Array<{ name: string; state: 'config' | 'secret' | 'missing' | 'empty' }> = value
    ? [
        ...value.keys.filter(key => wanted.has(key.name) && !missing.has(key.name)).map(row),
        ...[...missing].map(name => ({ name, state: 'missing' as const })),
        ...value.keys.filter(key => !wanted.has(key.name) && !missing.has(key.name)).map(row),
      ]
    : []
  const tag = { config: t('setup2.envConfig'), secret: t('setup2.envSecret'), missing: t('setup2.envDefault'), empty: t('setup2.envEmpty') }

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
        <button type="button" className="repo-link" onClick={() => onChange(null)}>{t('setup2.envReplace')}</button>
      </div>
      {check && <div className="envd-sum" role="status">
        <strong>{t('setup2.envSummary', { expected: check.expected, present: check.present.length })}</strong>
        <span>{check.missing.length ? t('setup2.envMissingKeys', { keys: check.missing.join(', ') }) : t('setup2.envAll')}</span>
      </div>}
      {!check && <div className="envd-sum" role="status"><strong>{t('setup2.envCount', { count: value.keys.length })}</strong></div>}
      <ul className="envd-keys" aria-label={t('setup2.keysAria')}>
        {rows.map((row, index) => <li key={row.name} className={'envd-key is-' + row.state} style={{ animationDelay: index * 90 + 'ms' }}>
          <code>{row.name}</code>
          <span className="envd-mask" aria-label={t('setup2.masked')}>{row.state === 'missing' || row.state === 'empty' ? '—' : '••••'}</span>
          <span className="envd-tag">{tag[row.state]}</span>
        </li>)}
      </ul>
    </>}
    <p className="envd-policy">{t('setup2.envPolicy')}</p>
  </div>
}
