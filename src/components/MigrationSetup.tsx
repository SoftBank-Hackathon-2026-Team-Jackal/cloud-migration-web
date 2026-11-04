'use client'

import { useRef, useState } from 'react'
import { useT } from '../lib/i18n'
import { DEFAULT_REGION, startRequestFor, type StartRequest, type Target } from '../lib/migration/events'

type Props = { target: Target; onTarget: (target: Target) => void; onNext: (request: StartRequest) => void }

// 대상 리전 선택지(클라우드 대상). 첫 항목이 기본값이다.
const REGIONS: Record<'aws' | 'gcp', string[]> = {
  aws: ['ap-northeast-2', 'ap-northeast-1', 'us-east-1'],
  gcp: ['asia-northeast3', 'asia-northeast1', 'us-central1'],
}

type EnvFile = { name: string; size: number; modified: number }

export default function MigrationSetup({ target, onTarget, onNext }: Props) {
  const t = useT()
  const fileInputRef = useRef<HTMLInputElement>(null)
  // .env는 파일 이름만 들고 있고 내용은 읽지도 저장하지도 보내지도 않는다.
  const [files, setFiles] = useState<EnvFile[]>([])
  const [regions, setRegions] = useState<Partial<Record<Target, string>>>({})
  const [agentId, setAgentId] = useState('')
  const [dragging, setDragging] = useState(false)

  const addFiles = (incoming: FileList | File[]) => {
    setFiles(current => {
      const next = [...current]
      for (const file of Array.from(incoming)) {
        if (!next.some(item => item.name === file.name && item.size === file.size && item.modified === file.lastModified)) {
          next.push({ name: file.name, size: file.size, modified: file.lastModified })
        }
      }
      return next
    })
  }

  return <section className="migration-setup" aria-label={t('setup.aria')}>
    <div className="migration-form-panel" onPaste={event => {
      if (event.clipboardData.files.length) {
        event.preventDefault()
        addFiles(event.clipboardData.files)
      }
    }}>
      <div className="migration-heading">
        <h2 className="migration-title">{t('setup.title')}</h2>
        <p>{t('setup.subtitle')}</p>
      </div>
      <div className="migration-fields">
        <div className="migration-key-row">
          <label className="migration-field">
            <span className="migration-label">{t('setup.ak')}</span>
            <input className="migration-input" type="text" name="accessKeyId" autoComplete="off" placeholder="AKIA..." />
          </label>
          <label className="migration-field">
            <span className="migration-label">{t('setup.sk')}</span>
            <input className="migration-input" type="password" name="secretAccessKey" autoComplete="new-password" placeholder={t('setup.skPh')} />
          </label>
        </div>
        <label className="migration-field">
          <span className="migration-label">{t('setup.st')}</span>
          <input className="migration-input" type="password" name="sessionToken" autoComplete="new-password" placeholder={t('setup.stPh')} />
        </label>
        <label className="migration-field">
          <span className="migration-label">{t('setup.region')}</span>
          <input className="migration-input" type="text" name="region" autoComplete="off" placeholder={t('setup.regionPh')} />
        </label>
        <p className="migration-hint">{t('setup.hint')}</p>
        <label className="migration-field">
          <span className="migration-label">{t('setup.repo')}</span>
          <input className="migration-input" type="url" name="repository" autoComplete="off" placeholder="https://github.com/owner/repo" />
        </label>
        <div className="migration-field">
          <span className="migration-label">{t('setup.target')}</span>
          <div className="migration-segment" role="radiogroup" aria-label={t('setup.targetAria')}>
            {(['aws', 'gcp', 'onprem'] as const).map(value => <button key={value} type="button"
              role="radio" aria-checked={target === value} className={target === value ? 'is-selected' : ''}
              onClick={() => onTarget(value)}>{t(value === 'onprem' ? 'target.onprem.short' : value === 'aws' ? 'target.aws' : 'target.gcp')}</button>)}
          </div>
        </div>
        {target === 'onprem'
          ? <label className="migration-field">
              <span className="migration-label">{t('setup.agentId')}</span>
              <input className="migration-input" type="text" name="agentId" autoComplete="off" placeholder={t('setup.agentIdPh')}
                value={agentId} onChange={event => setAgentId(event.target.value)} />
            </label>
          : <label className="migration-field">
              <span className="migration-label">{t('setup.destRegion')}</span>
              <select className="migration-input" name="destRegion" value={regions[target] ?? DEFAULT_REGION[target]}
                onChange={event => setRegions(current => ({ ...current, [target]: event.target.value }))}>
                {REGIONS[target].map(region => <option key={region} value={region}>{region}</option>)}
              </select>
            </label>}
        <div className="migration-field">
          <span className="migration-label">{t('setup.env')}</span>
          <input ref={fileInputRef} className="migration-file-input" type="file" multiple
            aria-label={t('setup.envPick')}
            onChange={event => {
              if (event.target.files) addFiles(event.target.files)
              event.target.value = ''
            }} />
          <div className={'migration-upload' + (dragging ? ' is-dragging' : '')}
            role="button" tabIndex={0} aria-label={t('setup.envAttach')}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                fileInputRef.current?.click()
              }
            }}
            onDragOver={event => { event.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={event => {
              event.preventDefault()
              setDragging(false)
              addFiles(event.dataTransfer.files)
            }}>
            <span className="migration-upload-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 16.5v2A1.5 1.5 0 005.5 20h13a1.5 1.5 0 001.5-1.5v-2" />
              </svg>
            </span>
            <strong>{t('setup.uploadTitle')}</strong>
            <span>{t('setup.uploadSub')}</span>
          </div>
          {files.length > 0 && <ul className="migration-file-list">
            {files.map((file, index) => <li key={file.name + file.modified + index}>
              <span className="migration-file-name">{file.name}</span>
              <button type="button" aria-label={t('setup.remove', { name: file.name })} onClick={() => setFiles(current => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>
            </li>)}
          </ul>}
        </div>
      </div>
      <div className="migration-footer">
        <button className="migration-next" type="button" onClick={() => onNext(startRequestFor(target, {
          region: regions[target], agentId: agentId.trim() || undefined,
          // 보내는 것은 참조 문자열뿐이다(.env 내용은 어디에도 보내지 않는다).
          envFileRef: files.length > 0 ? 'local:' + files[0].name : undefined,
        }))}>
          {t('setup.next')} <span aria-hidden="true">→</span>
        </button>
      </div>
    </div>
  </section>
}
