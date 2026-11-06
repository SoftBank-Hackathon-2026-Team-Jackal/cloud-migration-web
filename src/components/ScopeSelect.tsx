'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'
import { api, SHOW_MOCK_BADGE } from '../lib/connections/client'
import type { ApiErrorCode, Connection, ScopeAnalysis, ScopeConfirmation, ScopeLevel, ScopeSelection } from '../lib/connections/types'
import '../app/scope.css'

type Props = {
  /** 연결된 AWS 원본 */
  sources: Connection[]
  onConfirmed: (confirmation: ScopeConfirmation) => void
  onBack: () => void
  /** 음성("시작하자")·S 키가 부르는 다음 동작: 분석 시작 → 범위 확정 */
  actionRef: { current: (() => void) | null }
  onSay?: (text: string) => void
}

type Field = 'connection_id' | 'region' | 'cluster' | 'namespace' | 'workload'
const LEVELS: Array<{ level: ScopeLevel; field: Exclude<Field, 'connection_id'> }> = [
  { level: 'regions', field: 'region' }, { level: 'clusters', field: 'cluster' }, { level: 'namespaces', field: 'namespace' }, { level: 'workloads', field: 'workload' },
]
type Options = { status: 'idle' | 'loading' | 'ready' | 'error'; items: string[]; error?: ApiErrorCode; detail?: string | null }
const IDLE: Options = { status: 'idle', items: [] }

/**
 * 이전 범위 선택 [가정 — 목업]: 계정 전체를 스캔하지 않고 고른 앱(Deployment)에서 출발한다.
 * 원본 연결 → 리전 → EKS 클러스터 → Namespace → 워크로드 → 분석 시작 → 후보 포함·제외 → 범위 확정.
 * 각 단계는 처음 나온 값을 기본으로 골라 두므로 발표자는 "분석 시작"만 눌러도 된다.
 */
export default function ScopeSelect({ sources, onConfirmed, onBack, actionRef, onSay }: Props) {
  const { t, tOr } = useI18n()
  const [selection, setSelection] = useState<Partial<ScopeSelection>>({ connection_id: sources[0]?.connection_id })
  const [options, setOptions] = useState<Record<ScopeLevel, Options>>({ regions: IDLE, clusters: IDLE, namespaces: IDLE, workloads: IDLE })
  const [analysis, setAnalysis] = useState<ScopeAnalysis | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [included, setIncluded] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [failure, setFailure] = useState<{ error: ApiErrorCode; detail: string | null } | null>(null)
  const sayRef = useRef(onSay)
  sayRef.current = onSay

  // 한 단계 값을 바꾸면 그 아래 단계는 비우고 분석 결과도 버린다.
  const choose = (field: Field, value: string) => {
    setAnalysis(null); setFailure(null)
    const below = LEVELS.slice(LEVELS.findIndex(item => item.field === field) + 1)
    setOptions(current => ({ ...current, ...Object.fromEntries(below.map(({ level }) => [level, IDLE])) }))
    setSelection(current => {
      const order: Field[] = ['connection_id', 'region', 'cluster', 'namespace', 'workload']
      const next: Partial<ScopeSelection> = {}
      for (const key of order.slice(0, order.indexOf(field))) next[key] = current[key]
      next[field] = value || undefined
      return next
    })
  }

  // 위 단계가 정해지면 다음 단계 목록을 읽는다. 원본 연결의 리전·클러스터가 목록에 있으면 그것을, 아니면 첫 값을 기본으로 고른다.
  const source = sources.find(item => item.connection_id === selection.connection_id)
  const nextLevel = LEVELS.find(({ field }) => !selection[field])
  const levelKey = nextLevel ? nextLevel.level + '|' + JSON.stringify(selection) : ''
  useEffect(() => {
    if (!nextLevel || !selection.connection_id) return
    const { level, field } = nextLevel
    const controller = new AbortController()
    setOptions(current => ({ ...current, [level]: { status: 'loading', items: [] } }))
    const params = new URLSearchParams({ level })
    for (const [key, value] of Object.entries(selection)) if (value) params.set(key, value)
    void api<{ options: string[] }>('/api/scope/options?' + params, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return
      if (!result.ok) { setOptions(current => ({ ...current, [level]: { status: 'error', items: [], error: result.error, detail: result.detail } })); return }
      const items = result.data.options
      setOptions(current => ({ ...current, [level]: { status: 'ready', items } }))
      const preferred = field === 'region' ? source?.region : field === 'cluster' ? source?.eks_clusters?.[0] : undefined
      const pick = preferred && items.includes(preferred) ? preferred : items[0]
      if (pick) setSelection(current => ({ ...current, [field]: pick }))
    }, () => {})
    return () => controller.abort()
  }, [levelKey]) // levelKey가 단계와 위 단계 값을 모두 담는다

  const complete = LEVELS.every(({ field }) => selection[field]) && Boolean(selection.connection_id)
  const analyze = useCallback(async () => {
    if (!complete || analyzing) return
    setAnalyzing(true); setFailure(null); setAnalysis(null)
    const result = await api<ScopeAnalysis>('/api/scope/analyze', { method: 'POST', body: selection })
    setAnalyzing(false)
    if (!result.ok) { setFailure(result); return }
    setAnalysis(result.data)
    setIncluded(new Set(result.data.candidates.filter(item => item.suggested).map(item => item.candidate_id)))
    sayRef.current?.(t('scope.jackal.found', { count: result.data.candidates.length, workload: result.data.selection.workload }))
  }, [analyzing, complete, selection, t])

  const confirm = useCallback(async () => {
    if (!analysis || !included.size || confirming) return
    setConfirming(true); setFailure(null)
    const result = await api<ScopeConfirmation>('/api/scope/confirm', { method: 'POST', body: { analysis_id: analysis.analysis_id, included: [...included] } })
    setConfirming(false)
    if (!result.ok) { setFailure(result); return }
    onConfirmed(result.data)
  }, [analysis, confirming, included, onConfirmed])

  const primary = analysis ? confirm : analyze
  useEffect(() => {
    actionRef.current = () => void primary()
    return () => { actionRef.current = null }
  }, [actionRef, primary])

  const toggle = (id: string) => setIncluded(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const fieldLabel = (field: Field) => t(('scope.field.' + field) as 'scope.field.region')
  const selectFor = (field: Field, items: string[], state: Options['status'], disabled: boolean, render: (value: string) => string = value => value) =>
    <label className="scope-field" key={field}>
      <span>{fieldLabel(field)}</span>
      <select name={'scope-' + field} value={selection[field] ?? ''} disabled={disabled || state === 'loading' || analyzing || confirming}
        onChange={event => choose(field, event.target.value)}>
        {!selection[field] && <option value="">{state === 'loading' ? t('scope.loadingOptions') : state === 'ready' && !items.length ? t('scope.noOptions') : '—'}</option>}
        {items.map(value => <option key={value} value={value}>{render(value)}</option>)}
      </select>
    </label>

  const emptyLevel = LEVELS.find(({ level }) => options[level].status === 'ready' && !options[level].items.length)
  const errorLevel = LEVELS.find(({ level }) => options[level].status === 'error')
  const excluded = analysis ? analysis.candidates.length - included.size : 0
  return <div className="scope" data-step={analysis ? 'review' : 'select'}>
    <div className="scope-head">
      <div>
        <h3>{t('scope.title')} {SHOW_MOCK_BADGE && <span className="scope-mock" title={t('cx.mockHint')}>{t('cx.mock')}</span>}</h3>
        <p>{t('scope.lead')}</p>
      </div>
    </div>
    {!sources.length
      ? <p className="setup2-note is-alert" role="alert">{t('scope.noSource')} <a href="/settings#aws">{t('setup3.manage')}</a></p>
      : <div className="scope-pickers">
        {selectFor('connection_id', sources.map(item => item.connection_id), 'ready', false, id => {
          const item = sources.find(value => value.connection_id === id)
          return item ? item.display_name + ' · ' + (item.account_id ?? '') : id
        })}
        {LEVELS.map(({ level, field }) => selectFor(field, options[level].items, options[level].status,
          LEVELS.findIndex(item => item.field === field) > 0 && !selection[LEVELS[LEVELS.findIndex(item => item.field === field) - 1].field],
          field === 'region' ? value => value + ' · ' + tOr('region.' + value, value) : undefined))}
      </div>}
    {emptyLevel && <p className="setup2-note" role="status">{t(('scope.empty.' + emptyLevel.field) as 'scope.empty.cluster')}</p>}
    {errorLevel && <p className="setup2-note is-alert" role="alert">{tOr('cx.code.' + (options[errorLevel.level].detail ?? ''), '') || t(('cx.err.' + options[errorLevel.level].error) as 'cx.err.not_found')}{options[errorLevel.level].detail && <code className="scope-code">{options[errorLevel.level].detail}</code>}</p>}
    {analyzing && <div className="scope-progress" role="status"><i />{t('scope.analyzing', { workload: selection.workload ?? '' })}</div>}
    {analysis && <div className="scope-result">
      <div className="scope-sum">
        <strong>{t('scope.candidates', { count: analysis.candidates.length })}</strong>
        <span>{t('scope.counts', { included: included.size, excluded })}</span>
      </div>
      <ul className="scope-list" aria-label={t('scope.listAria')}>
        {analysis.candidates.map(item => <li key={item.candidate_id} className={'scope-row' + (included.has(item.candidate_id) ? ' is-in' : '')} data-candidate={item.candidate_id}>
          <label>
            <input type="checkbox" checked={included.has(item.candidate_id)} onChange={() => toggle(item.candidate_id)} disabled={confirming}
              aria-label={t('scope.include', { name: item.name })} />
            <span className="scope-type">{tOr('scope.type.' + item.resource_type, item.resource_type)}</span>
            <span className="scope-name"><strong>{item.name}</strong>{item.arn && <code>{item.arn}</code>}</span>
            <span className="scope-ev">{item.evidence.map((evidence, index) => <span key={index} className="scope-evi">
              <b data-evidence={evidence.kind}>{evidence.kind}</b><small>{evidence.location}</small>
            </span>)}</span>
          </label>
        </li>)}
      </ul>
    </div>}
    {failure && <p className="setup2-note is-alert" role="alert">{tOr('cx.code.' + (failure.detail ?? ''), '') || t(('cx.err.' + failure.error) as 'cx.err.not_found')}{failure.detail && <code className="scope-code">{failure.detail}</code>}</p>}
    <div className="migration-footer setup2-footer">
      <button type="button" className="envd-btn" onClick={onBack} disabled={analyzing || confirming}>{t('scope.back')}</button>
      <span className="migration-hint repo-footer-note">{analysis ? (included.size ? t('scope.hintConfirm') : t('scope.hintNone')) : t('scope.hintAnalyze')}</span>
      <button className="migration-next" type="button" data-scope-action={analysis ? 'confirm' : 'analyze'}
        disabled={analysis ? !included.size || confirming : !complete || analyzing} onClick={() => void primary()}>
        {analysis ? (confirming ? t('cx.working') : t('scope.confirm')) : (analyzing ? t('scope.analyzingShort') : t('scope.analyze'))} <kbd>S</kbd>
      </button>
    </div>
  </div>
}
