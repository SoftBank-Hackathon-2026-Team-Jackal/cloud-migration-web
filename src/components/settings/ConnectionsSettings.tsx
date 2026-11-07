'use client'

import { useCallback, useEffect, useState } from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import { useI18n } from '../../lib/i18n'
import { api } from '../../lib/connections/client'
import type { ApiErrorCode, ConnectionsList } from '../../lib/connections/types'
import LangSwitch from '../LangSwitch'
import AwsSection from './AwsSection'
import GcpSection from './GcpSection'
import AgentSection from './AgentSection'
import { ErrorNote, Skeleton, useNowSeconds } from './parts'

type Tab = 'aws' | 'gcp' | 'agent'
const TABS: Tab[] = ['aws', 'gcp', 'agent']

/** /settings 연결 관리: AWS · GCP · 온프레미스 Agent. 모든 호출은 같은 출처의 웹 서버(/api/*)를 거친다. */
export default function ConnectionsSettings() {
  const { t } = useI18n()
  const now = useNowSeconds()
  const [list, setList] = useState<ConnectionsList | 'loading' | { error: ApiErrorCode; detail: string | null }>('loading')
  const [tab, setTab] = useState<Tab>('aws')

  const load = useCallback(async (signal?: AbortSignal) => {
    const result = await api<ConnectionsList>('/api/connections', { signal }).catch(() => null)
    if (!result || signal?.aborted) return
    setList(current => (result.ok ? result.data : current !== 'loading' && !('error' in current) ? current : { error: result.error, detail: result.detail }))
  }, [])

  // 주소의 #agent 등으로 탭을 고를 수 있다. Agent 상태(마지막 접속)는 10초마다 다시 읽는다.
  useEffect(() => {
    const hash = window.location.hash.slice(1) as Tab
    if (TABS.includes(hash)) setTab(hash)
    const controller = new AbortController()
    void load(controller.signal)
    const timer = window.setInterval(() => void load(controller.signal), 10000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [load])
  const refresh = useCallback(() => { void load() }, [load])

  const data = list !== 'loading' && !('error' in list) ? list : null
  const count = (value: Tab) => !data ? null
    : value === 'aws' ? data.connections.filter(item => item.kind !== 'GCP_TARGET').length
      : value === 'gcp' ? data.connections.filter(item => item.kind === 'GCP_TARGET').length : data.agents.length

  return <div className="cx-page">
    <header className="cx-top">
      <a className="cx-back" href="/">← {t('cx.backToDemo')}</a>
      <LangSwitch />
    </header>
    <main className="cx-main" aria-labelledby="cx-title">
      <div className="cx-heading">
        <h1 id="cx-title">{t('cx.title')}</h1>
        <p>{t('cx.lead')}</p>
      </div>
      <Tabs.Root value={tab} onValueChange={value => { setTab(value as Tab); window.history.replaceState(null, '', '#' + value) }}>
        <Tabs.List className="cx-tabs" aria-label={t('cx.tabsAria')}>
          {TABS.map(value => <Tabs.Trigger key={value} value={value} className="cx-tab" data-tab={value}>
            {t(('cx.tab.' + value) as 'cx.tab.aws')}{count(value) !== null && <span className="cx-count-pill">{count(value)}</span>}
          </Tabs.Trigger>)}
        </Tabs.List>
        {list === 'loading' && <Skeleton rows={2} />}
        {list !== 'loading' && 'error' in list && <ErrorNote error={list.error} detail={list.detail} onRetry={refresh} />}
        {data && <>
          <Tabs.Content value="aws" className="cx-panel"><AwsSection connections={data.connections} error={data.meta.connections.error} errorDetail={data.meta.connections.detail} mock={data.meta.connections.mock} now={now} onChanged={refresh} /></Tabs.Content>
          <Tabs.Content value="gcp" className="cx-panel"><GcpSection connections={data.connections} error={data.meta.connections.error} errorDetail={data.meta.connections.detail} mock={data.meta.connections.mock} now={now} onChanged={refresh} /></Tabs.Content>
          <Tabs.Content value="agent" className="cx-panel"><AgentSection agents={data.agents} error={data.meta.agents.error} errorDetail={data.meta.agents.detail} mock={data.meta.agents.mock} now={now} onChanged={refresh} /></Tabs.Content>
        </>}
      </Tabs.Root>
      <p className="cx-policy">{t('cx.policy')}</p>
    </main>
  </div>
}
