'use client'

import StageShell from './StageShell'
import { useT, type MsgKey } from '../lib/i18n'
import type { Target } from '../lib/stages'
import ArchitectureDiagram, { type NodeState } from './ArchitectureDiagram'
import AiTip, { type TipFix } from './AiTip'
import ZoomableDiagram from './ZoomableDiagram'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'
import { shortDigest, type BuildCheckData, type BuildErrorCode, type BuildFixData, type BuildResultData, type CheckState } from '../lib/migration/events'

// running: 검증 중 · failed: 실패 · fixing: AI(픽서)가 수정 중 · recheck: AI(리베리파이어)가 재검증 중 · done: 통과
// fixed: fixing/recheck 때 지금까지 고친 개수(한 검증 항목 안에서 수정이 여러 개일 수 있다)

const CHECKS = [{ id: 'build' }, { id: 'health' }, { id: 'db' }, { id: 'render' }, { id: 'secret' }, { id: 'scope' }]

/** 11/2 회의의 에이전트 5종. 스캐너·매퍼는 앞 단계에서 끝났고, 샌드박스에서는 테스터·픽서·리베리파이어가 일한다. */
const AGENTS = ['scanner', 'mapper', 'tester', 'fixer', 'verifier'] as const

// AI가 고친 항목은 build.fix 이벤트로 온다. 변경 내용의 줄(fix)·칩·팝업이 같은 id로 이어진다.
type FixId = 'db' | 'host' | 'port' | 'probe'
type Fix = BuildFixData

type DiffLine = { kind: 'file' | 'del' | 'add' | 'note'; text: string; key?: MsgKey; fix?: FixId }
const DIFF: ReadonlyArray<DiffLine> = [
  { kind: 'file', text: '.env' },
  { kind: 'del', text: '- DB_HOST=postgres', fix: 'db' },
  { kind: 'add', text: '+ DB_HOST=postgresql.demo.svc.cluster.local', fix: 'db' },
  { kind: 'del', text: '- HOST=127.0.0.1', fix: 'host' },
  { kind: 'add', text: '+ HOST=0.0.0.0', fix: 'host' },
  { kind: 'del', text: '- DB_USERNAME=demo_user' },
  { kind: 'add', text: '+ DB_USERNAME=', key: 'rehearsal.diffAccount' },
  { kind: 'file', text: '', key: 'rehearsal.diffFile' },
  { kind: 'add', text: '+ containerPort: 8080', fix: 'port' },
  { kind: 'add', text: '+ readinessProbe: { httpGet: { path: /health, port: 8080 } }', fix: 'probe' },
  { kind: 'note', text: '', key: 'rehearsal.diffNote' },
]

export default function RehearsalStage({ target, onNext }: { target: Target; onNext: () => void }) {
  const t = useT()
  const { state } = useMigration()
  // 샌드박스 루프의 시도 횟수(시도 n/3)를 머리글 위 작은 글자에 붙인다.
  const attempt = state.build.attempt
  const kicker = 'SANDBOX · REHEARSAL' + (attempt ? ' · ' + t('rehearsal.attempt', { n: attempt, max: state.build.result?.max_attempts ?? 3 }) : '')
  return <StageShell kicker={kicker} title={t('rehearsal.title')}
    subtitle={t('rehearsal.subtitle')}>
    {ready => <RehearsalBody ready={ready} target={target} onNext={onNext} />}
  </StageShell>
}

// 검증 항목이 어느 구성 요소를 확인하는지(샌드박스는 코드·기능만 보므로 진입·DNS는 대상이 아니다)
const CHECK_NODES: Record<string, string[]> = {
  build: ['group', 'app'], health: ['app', 'entry'], db: ['db'], render: ['group'], secret: [], scope: [],
}

// 이미지 빌드 실패 코드별 안내와 다음 행동(재업로드 / AI 수정 / 재시도). 시도를 다 썼으면 사람 검토다.
const NEXT_ACTION: Record<BuildErrorCode, 'reupload' | 'aifix' | 'retry'> = {
  SOURCE_NOT_FOUND: 'reupload', DOCKERFILE_MISSING: 'aifix', BUILD_FAILED: 'aifix', PUSH_FAILED: 'retry', TIMEOUT: 'retry',
}

function BuildResultNote({ result }: { result: BuildResultData }) {
  const t = useT()
  if (result.status === 'SUCCEEDED') {
    return <p className="flow-note build-result">{t('rehearsal.build.ok', { digest: shortDigest(result.digest) })}{result.reused ? ' · ' + t('rehearsal.build.reused') : ''}</p>
  }
  const code = result.error_code ?? 'BUILD_FAILED'
  const next = result.attempt >= result.max_attempts ? 'review' : NEXT_ACTION[code]
  return <p className="flow-note build-result is-failed" role="status">
    {t('rehearsal.build.fail', { code })} {t(('rehearsal.err.' + code) as MsgKey)} {t(('rehearsal.next.' + next) as MsgKey)}
  </p>
}

const MARK: Record<CheckState, string> = { running: '', failed: '!', fixing: '✎', recheck: '', done: '✓' }

function RehearsalBody({ ready, target, onNext }: { ready: boolean; target: Target; onNext: () => void }) {
  const t = useT()
  const { state: migration } = useMigration()
  useStageFeed('build', ready, target)
  const fixes = migration.build.fixes
  const states = new Map<string, BuildCheckData>(Object.entries(migration.build.checks))
  const stateOf = (id: string) => states.get(id)?.state
  const done = CHECKS.filter(check => stateOf(check.id) === 'done').length
  const finished = done === CHECKS.length
  const last = migration.build.lastCheck
  const fixesOf = (checkId: string) => fixes.filter(fix => fix.check === checkId)
  // 수정이 적용된 것: 재검증에 들어갔거나 통과한 항목의 수정 전부 + 수정 중인 항목에서는 지금까지 고친 개수만큼
  const isApplied = (fix: Fix) => {
    const event = states.get(fix.check)
    if (!event) return false
    if (event.state === 'recheck' || event.state === 'done') return true
    return event.state === 'fixing' && fixesOf(fix.check).indexOf(fix) < (event.fixed ?? 0)
  }
  const applied = fixes.filter(isApplied)
  const tipFixes = (list: Fix[]): TipFix[] => list.map(fix => ({ id: fix.id, lines: fix.lines }))
  const agentStatus = (agent: (typeof AGENTS)[number]): 'done' | 'active' | 'idle' => {
    if (agent === 'scanner' || agent === 'mapper') return 'done'
    if (agent === 'tester') return finished ? 'done' : last && (last.state === 'fixing' || last.state === 'recheck') ? 'idle' : 'active'
    if (agent === 'fixer') return last?.state === 'fixing' ? 'active' : applied.length > 0 ? 'done' : 'idle'
    return last?.state === 'recheck' ? 'active' : fixes.length > 0 && fixes.every(fix => stateOf(fix.check) === 'done') ? 'done' : 'idle'
  }
  const nodeStates: Record<string, NodeState> = {}
  for (const check of CHECKS) {
    const state = stateOf(check.id)
    if (!state) continue
    for (const node of CHECK_NODES[check.id]) {
      if (state === 'done') nodeStates[node] = 'done'
      else if (nodeStates[node] !== 'done') nodeStates[node] = 'on'
    }
  }

  // 검증 항목 카드의 설명: 수정이 있는 항목은 단계(실패 → 수정 → 재검증)에 맞춰 바뀌고, 여러 개면 하나씩 진행 상황을 보여 준다.
  const detailOf = (id: string) => {
    const event = states.get(id)
    const list = fixesOf(id)
    if (list.length === 0 || !event || event.state === 'running' || event.state === 'done') return t(('rehearsal.check.' + id + '.detail') as MsgKey)
    const many = list.length > 1
    if (event.state === 'failed') return many ? t('rehearsal.failMany', { n: list.length }) : t(('rehearsal.fail.' + list[0].id) as MsgKey)
    if (event.state === 'fixing') {
      const current = list[Math.min(event.fixed ?? 0, list.length - 1)]
      return <><b>{t(('rehearsal.fix.' + current.id + '.title') as MsgKey)}</b><br />{t(('rehearsal.fix.' + current.id + '.detail') as MsgKey)}</>
    }
    return many ? t('rehearsal.recheckMany', { n: list.length }) : t(('rehearsal.recheck.' + list[0].id) as MsgKey)
  }

  return <div className="flow-split flow-split-wide">
    <section className="flow-list" aria-label={t('rehearsal.listAria')}>
      <div className="agent-strip" role="group" aria-label={t('rehearsal.agents.title')}>
        <small>{t('rehearsal.agents.title')}</small>
        {AGENTS.map(agent => <span key={agent} className={'agent-pill is-' + agentStatus(agent)}>{t(('rehearsal.agent.' + agent) as MsgKey)}</span>)}
      </div>
      {CHECKS.map((check, index) => {
        const event = states.get(check.id)
        const state = event?.state
        const list = fixesOf(check.id)
        const statusKey = state ? 'rehearsal.state.' + state : 'rehearsal.state.wait'
        const working = list.length > 1 && (state === 'failed' || state === 'fixing' || state === 'recheck')
        return <article key={check.id} className={'flow-check' + (state ? ' is-' + state : '')}>
          <span className="flow-check-mark" aria-hidden="true">{state ? MARK[state] : String(index + 1).padStart(2, '0')}</span>
          <div>
            <strong>{t(('rehearsal.check.' + check.id + '.title') as MsgKey)}{list.length > 0 && state === 'done' && <AiTip fixes={tipFixes(list)} />}</strong>
            <p>{detailOf(check.id)}</p>
            {working && <ul className="fix-list" aria-label={t('rehearsal.aiTag')}>
              {list.map((fix, i) => <li key={fix.id} className={isApplied(fix) ? 'is-done' : state === 'fixing' && i === (event?.fixed ?? 0) ? 'is-active' : ''}>
                <span aria-hidden="true">{isApplied(fix) ? '✓' : state === 'fixing' && i === (event?.fixed ?? 0) ? '✎' : '·'}</span>{t(('rehearsal.fixLabel.' + fix.id) as MsgKey)}
              </li>)}
            </ul>}
          </div>
          <small>{t(statusKey as MsgKey)}</small>
        </article>
      })}
      {migration.build.result && <BuildResultNote result={migration.build.result} />}
    </section>

    <aside className="flow-panel rehearsal-side" aria-label={t('rehearsal.diffTitle')}>
      <div className="rehearsal-diagram">
        <ZoomableDiagram><ArchitectureDiagram view="after" target={target} states={nodeStates} adaptive /></ZoomableDiagram>
      </div>
      <p className="flow-note">{t('rehearsal.diagramNote')}</p>
      <div className="rehearsal-diff">
        <div className="flow-panel-head"><strong>{t('rehearsal.diffTitle')}</strong></div>
        <pre className="flow-diff" aria-label={t('rehearsal.diffAria')}>
          {DIFF.map((line, index) => {
            // 같은 수정에 속한 연속된 줄(삭제+추가)에는 칩을 하나만, 그 묶음의 마지막 줄에 단다. 수정마다 칩이 하나다.
            const fix = line.fix ? fixes.find(item => item.id === line.fix) : undefined
            const groupEnd = fix && DIFF[index + 1]?.fix !== line.fix
            return <span key={index} className={'flow-diff-' + line.kind}>{line.text + (line.key ? t(line.key) : '')}{groupEnd && fix && isApplied(fix) && <AiTip fixes={tipFixes([fix])} />}</span>
          })}
        </pre>
        <p className="flow-note">{t('rehearsal.note')}</p>
      </div>
    </aside>

    <div className="flow-footer">
      <span>{finished
        ? t('rehearsal.footDone', { done, total: CHECKS.length }) + ' ' + t('rehearsal.fixSummary', { n: applied.length })
        : t('rehearsal.footRun', { done, total: CHECKS.length })}</span>
      <button type="button" className="flow-primary" disabled={!finished} onClick={onNext}>{t('rehearsal.next')} <span aria-hidden="true">→</span></button>
    </div>
  </div>
}
