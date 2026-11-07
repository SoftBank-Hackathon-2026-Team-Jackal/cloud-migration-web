'use client'

import FixerEnvNotice from './FixerEnvNotice'
import { useEffect, useState } from 'react'
import StageShell from './StageShell'
import { useT, type MsgKey } from '../lib/i18n'
import type { Target } from '../lib/stages'
import { useMigration, useStageFeed } from '../lib/migration/MigrationProvider'
import { useVoiceActions } from '../lib/voice/actions'
import { currentStep, elapsedSeconds, isMasked, mappingCell, splitSeconds, waitingForAnalysisReview, type StepTime } from '../lib/migration/sandboxProgress'
import { shortDigest, type BuildErrorCode, type BuildFixData, type BuildResultData, type SandboxAttemptData, type SandboxEnvData, type SandboxStep, type SandboxTestsData } from '../lib/migration/events'

type DiffLine = { kind: 'file' | 'del' | 'add' | 'note'; text: string }
/** 받은 수정(build.fix)으로 전체 변경 내용을 만든다: 파일별로 묶고, 수정 이유가 있으면 주석 줄로 붙인다. */
function diffOf(fixes: BuildFixData[]): DiffLine[] {
  const files = new Map<string, BuildFixData[]>()
  for (const fix of fixes) {
    const file = fix.file ?? ''
    files.set(file, [...(files.get(file) ?? []), fix])
  }
  const lines: DiffLine[] = []
  for (const [file, items] of files) {
    if (file) lines.push({ kind: 'file', text: file })
    for (const fix of items) {
      lines.push(...fix.lines.map(line => ({ kind: line.kind, text: line.text })))
      if (fix.why) lines.push({ kind: 'note', text: '# ' + fix.why })
    }
  }
  return lines
}

export default function RehearsalStage({ target, onNext, onComplete }: { target: Target; onNext: () => void; onComplete?: () => void }) {
  const t = useT()
  const { state } = useMigration()
  // 샌드박스 루프의 시도 횟수(시도 n/3)를 머리글 위 작은 글자에 붙인다.
  const attempt = state.build.attempt
  const kicker = 'SANDBOX · REHEARSAL' + (attempt ? ' · ' + t('rehearsal.attempt', { n: attempt, max: state.build.result?.max_attempts ?? 3 }) : '')
  return <StageShell kicker={kicker} title={t('rehearsal.title')}
    subtitle={t('rehearsal.subtitle')}>
    {ready => <RehearsalBody ready={ready} target={target} onNext={onNext} onComplete={onComplete} />}
  </StageShell>
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

const STEPS: SandboxStep[] = ['render', 'apply', 'ready', 'test', 'judge']

type Track = { run: number; attempt: number; steps: Partial<Record<SandboxStep, 'running' | 'done' | 'failed'>>; at: Partial<Record<SandboxStep, StepTime>>; result?: SandboxAttemptData; retry: boolean }

/** 실제 모드에서 진행 중인 것이 있으면 1초마다 다시 그린다(경과 시간). 목업·멈춘 화면에서는 돌지 않는다. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])
  return now
}

/** 초 → 사전 문구(23초 · 1분 5초) */
function useDuration() {
  const t = useT()
  return (seconds: number | null) => {
    if (seconds === null) return ''
    const { m, s } = splitSeconds(seconds)
    return m > 0 ? t('sbx.minSec', { m, s }) : t('sbx.sec', { s })
  }
}

/** 실제 모드의 진행 정보: 지금 시각·시험 개수(트랙 카드가 경과 시간과 하는 일을 보인다). 목업이면 null. */
type Live = { now: number; tests: SandboxTestsData | null } | null

/** 단계에서 지금 하는 일(짧은 문구). 테스트는 개수를 붙인다(테스트별 진행 이벤트는 없다). */
function useDoing() {
  const t = useT()
  return (step: SandboxStep | 'build', tests: SandboxTestsData | null) =>
    step === 'test' ? (tests ? t('sbx.doing.test', { n: tests.total }) : t('sbx.doing.testAny')) : t(('sbx.doing.' + step) as MsgKey)
}

/** 실제 모드: 이미지 빌드(build.check id=build)를 트랙과 같은 모양으로 트랙 위에 보인다. 빌드 결과 메모는 아래에 그대로 둔다. */
function BuildCard({ state, time, now, current }: { state: string; time: StepTime | null; now: number; current: boolean }) {
  const t = useT()
  const duration = useDuration()
  const doing = useDoing()
  const seconds = elapsedSeconds(time ?? undefined, now)
  const running = state !== 'done' && state !== 'failed'
  const status = running ? (seconds === null ? t('sbx.ing.build') : t('sbx.statusNow', { step: t('sbx.ing.build'), time: duration(seconds) }))
    : state === 'failed' ? (seconds === null ? t('rehearsal.state.failed') : t('sbx.failedIn', { time: duration(seconds) }))
    : (seconds === null ? t('rehearsal.state.done') : t('sbx.doneIn', { time: duration(seconds) }))
  return <article className={'sbx-track sbx-build' + (state === 'failed' ? ' is-failed' : running ? ' is-running' : ' is-passed') + (current ? ' is-current' : '')}>
    <header>
      <strong>{t('sbx.build')}</strong>
      <span className="sbx-status" role={current ? 'status' : undefined}>{status}</span>
    </header>
    {running && <p className="sbx-doing"><span aria-hidden="true" />{doing('build', null)}</p>}
  </article>
}

/** 시도 트랙 한 줄: 렌더 → 적용 → 준비 검사 → 테스트 → 판정. 실패하면 분류·다음 행동·수정 카드가 붙는다. */
function TrackCard({ track, fixes, current, live }: { track: Track; fixes: BuildFixData[]; current: boolean; live: Live }) {
  const t = useT()
  const duration = useDuration()
  const doing = useDoing()
  const result = track.result
  const failed = result && !result.verdict.passed
  const cls = result?.failure_class
  const fixList = result ? fixes.filter(fix => result.fix_ids.includes(fix.id)) : []
  // 실제 모드: 지금 단계와 경과 시간(이벤트 at 기준). 단계 사이(다음 단계 이벤트 전)에는 '진행 중'
  const now = live ? currentStep(track.steps) : null
  const nowSeconds = live && now ? elapsedSeconds(track.at[now], live.now) : null
  const status = !result ? (now && nowSeconds !== null ? t('sbx.statusNow', { step: t(('sbx.ing.' + now) as MsgKey), time: duration(nowSeconds) }) : t('sbx.running')) : result.verdict.passed ? t('sbx.passed') : t('sbx.failed', { cls: t(('sbx.cls.' + cls) as MsgKey) })
  const noSteps = Object.keys(track.steps).length === 0
  return <article className={'sbx-track' + (failed ? ' is-failed' : result ? ' is-passed' : ' is-running') + (current ? ' is-current' : '')}>
    <header>
      <strong>{t('sbx.run', { n: track.attempt })}{track.retry && <small> · {t('sbx.retry')}</small>}</strong>
      <span className="sbx-status" role={current ? 'status' : undefined}>{status}</span>
    </header>
    {!noSteps && <ol className="sbx-lane" aria-label={t('sbx.run', { n: track.attempt })}>
      {STEPS.map(step => <li key={step} className={'is-' + (track.steps[step] ?? 'idle')}>
        <span aria-hidden="true" /><em>{t(('sbx.step.' + step) as MsgKey)}</em>
        {live && track.steps[step] && <small className="sbx-time">{duration(elapsedSeconds(track.at[step], live.now))}</small>}
      </li>)}
    </ol>}
    {live && now && !result && <p className="sbx-doing"><span aria-hidden="true" />{doing(now, live.tests)}</p>}
    {failed && cls && <p className="sbx-next">{t(('sbx.next.' + cls) as MsgKey)}{result.verdict.reasons[0] && <code>{result.verdict.reasons[0]}</code>}</p>}
    {fixList.length > 0 && <div className="sbx-fix">
      <small>{t('sbx.fixer', { n: fixList.length })}</small>
      {fixList.map(fix => <pre key={fix.id}>{fix.lines.map((line, index) => <span key={index} className={'flow-diff-' + line.kind}>{line.text}</span>)}</pre>)}
    </div>}
  </article>
}

/** 격리실: 임시 Namespace 안의 앱 Pod·테스트 DB·출구 관문. 원본은 바깥에서 읽기만 한다. 정리되면 흩어진다. */
function Chamber({ env, digest, applied, blocked, cleaned }: { env: SandboxEnvData | null; digest: string | null; applied: boolean; blocked: number; cleaned: boolean }) {
  const t = useT()
  return <figure className={'sbx-chamber' + (applied ? ' is-applied' : '') + (cleaned ? ' is-cleaned' : '')} aria-label={t('sbx.chamberAria')}>
    <figcaption><b>{t('sbx.ns')}</b> {env ? (isMasked(env.namespace) ? t('sbx.nsHidden') : env.namespace) + ' · ' + t('sbx.expires', { m: env.expires_minutes }) : t('sbx.preparing')}</figcaption>
    <svg viewBox="0 0 330 168" role="img" aria-label={t('sbx.chamberAria')}>
      <rect className="sbx-src" x="2" y="52" width="66" height="64" rx="8" />
      <text className="sbx-t" x="35" y="80" textAnchor="middle">{t('sbx.source')}</text>
      <text className="sbx-ts" x="35" y="96" textAnchor="middle">{t('sbx.readOnly')}</text>
      <line className="sbx-flow" x1="68" y1="84" x2="112" y2="60" />
      <g className="sbx-room">
        <rect className="sbx-wall" x="92" y="8" width="234" height="152" rx="14" />
        <rect className="sbx-pod" x="112" y="30" width="96" height="50" rx="9" />
        <text className="sbx-t is-inv" x="160" y="52" textAnchor="middle">{t('sbx.pod')}</text>
        <text className="sbx-ts is-inv" x="160" y="68" textAnchor="middle">{digest ? shortDigest(digest) : '—'}</text>
        <line className="sbx-link" x1="208" y1="55" x2="222" y2="55" />
        <rect className="sbx-db" x="222" y="30" width="90" height="50" rx="9" />
        <text className="sbx-t" x="267" y="52" textAnchor="middle">{t('sbx.db')}</text>
        <text className="sbx-ts" x="267" y="68" textAnchor="middle">PostgreSQL 16</text>
        <line className="sbx-link" x1="160" y1="80" x2="160" y2="104" />
        <rect className={'sbx-gate' + (blocked > 0 ? ' is-warn' : '')} x="112" y="104" width="200" height="38" rx="9" />
        <text className="sbx-ts" x="212" y="127" textAnchor="middle">{t('sbx.egress', { a: env?.egress_allowed ?? 0, b: blocked })}</text>
      </g>
      {cleaned && <text className="sbx-cleaned" x="209" y="90" textAnchor="middle">{t('sbx.cleaned')}</text>}
    </svg>
  </figure>
}

function Verdict({ result, live }: { result: SandboxAttemptData | null; live: boolean }) {
  const t = useT()
  const c = result?.checks
  const rows: Array<[MsgKey, string, boolean]> = c ? [
    ['sbx.cond.tests', c.required_passed + ' / ' + c.required_total, c.required_passed === c.required_total],
    ['sbx.cond.unsupported', String(c.unsupported_calls), c.unsupported_calls === 0],
    ['sbx.cond.mapping', live && mappingCell(c.calls_in_mapping, c.calls_total).kind === 'none' ? t('sbx.cond.mappingNone') : c.calls_in_mapping + ' / ' + c.calls_total, c.calls_in_mapping === c.calls_total],
    ['sbx.cond.egress', String(c.blocked_egress), c.blocked_egress === 0],
  ] : (['sbx.cond.tests', 'sbx.cond.unsupported', 'sbx.cond.mapping', 'sbx.cond.egress'] as MsgKey[]).map(key => [key, '—', true])
  return <section className="sbx-verdict" aria-label={t('sbx.verdict')}>
    <div className="flow-panel-head"><strong>{t('sbx.verdict')}</strong><small>{t('sbx.verdictBy')}</small></div>
    {live && !c && <p className="sbx-verdict-wait">{t('sbx.verdictWait')}</p>}
    <dl>{rows.map(([key, value, ok]) => <div key={key} className={c && !ok ? 'is-bad' : c ? 'is-ok' : ''}><dt>{t(key)}</dt><dd>{value}</dd></div>)}</dl>
  </section>
}

function RehearsalBody({ ready, target, onNext, onComplete }: { ready: boolean; target: Target; onNext: () => void; onComplete?: () => void }) {
  const t = useT()
  const { state: migration, provider, can, mode } = useMigration()
  const duration = useDuration()
  useStageFeed('build', ready, target)
  const sandbox = migration.sandbox
  const fixes = migration.build.fixes
  // 트랙: 단계 이벤트와 판정 이벤트를 run 순번으로 묶는다. 같은 attempt가 다시 나오면 환경(INFRA) 재시도다.
  const runs = [...new Set([...Object.keys(sandbox.steps).map(Number), ...sandbox.attempts.map(item => item.run)])].sort((a, b) => a - b)
  const tracks: Track[] = runs.map((run, index) => {
    const result = sandbox.attempts.find(item => item.run === run)
    const attempt = result?.attempt ?? migration.build.attempt ?? run
    const previous = index > 0 ? (sandbox.attempts.find(item => item.run === runs[index - 1])?.attempt ?? -1) : -1
    return { run, attempt, steps: sandbox.steps[run] ?? {}, at: sandbox.at[run] ?? {}, result, retry: previous === attempt }
  })
  const done = sandbox.done
  const passed = done?.status === 'PASSED'
  useEffect(() => { if (passed) onComplete?.() }, [passed, onComplete])
  useVoiceActions({ next: passed && onNext, retry: !!migration.build.review && can('sandbox.retry') && (() => provider.retrySandbox()) })
  const latest = sandbox.attempts[sandbox.attempts.length - 1] ?? null
  // 판정판은 실제로 테스트까지 돈 마지막 트랙의 결과만 보여 준다(빌드 실패·적용 실패 트랙은 판정 숫자가 없다).
  const judged = [...sandbox.attempts].reverse().find(item => sandbox.steps[item.run]?.test === 'done' || sandbox.steps[item.run]?.judge) ?? null
  const current = tracks[tracks.length - 1]
  const appliedFixes = sandbox.attempts.flatMap(item => item.fix_ids)
  const digest = migration.build.result?.digest ?? null
  const applied = !!current && (current.steps.apply === 'done' || current.steps.apply === 'running')
  const tests = sandbox.tests
  // 실제 모드만: 빌드 카드·단계별 경과 시간·지금 하는 일·검토 대기 이유. 목업 화면은 그대로 둔다.
  const real = mode === 'sse'
  const buildCheck = real ? migration.build.checks.build ?? null : null
  const buildRunning = !!buildCheck && buildCheck.state !== 'done' && buildCheck.state !== 'failed'
  const nowStep = current && !current.result ? currentStep(current.steps) : null
  const now = useNow(real && !done && (buildRunning || !!nowStep))
  const live: Live = real ? { now, tests } : null
  const reviewFirst = waitingForAnalysisReview({ mode, migrationId: migration.migrationId, lastPhase: migration.lastPhase, hasSandboxEvents: tracks.length > 0 || !!sandbox.env || !!buildCheck || !!migration.build.result })
  const nowText = nowStep ? t('sbx.statusNow', { step: t(('sbx.ing.' + nowStep) as MsgKey), time: duration(elapsedSeconds(current?.at[nowStep], now)) })
    : buildRunning && tracks.length === 0 ? t('sbx.statusNow', { step: t('sbx.ing.build'), time: duration(elapsedSeconds(migration.build.buildAt ?? undefined, now)) })
    : null

  return <div className="flow-split flow-split-wide sbx-split">
    <section className="flow-list sbx-tracks" aria-label={t('rehearsal.listAria')}>
      {buildCheck && <BuildCard state={buildCheck.state} time={migration.build.buildAt} now={now} current={buildRunning && tracks.length === 0 && !done} />}
      {tracks.length === 0 && !buildCheck && <p className="flow-note">{reviewFirst ? t('sbx.waitReview') : t('sbx.preparing')}</p>}
      {tracks.map(track => <TrackCard key={track.run} track={track} fixes={fixes} current={track === current && !done} live={live} />)}
      {tests && <p className="flow-note sbx-tests"><b>{t('sbx.testsBy')}</b> {t('sbx.tests', { total: tests.total, catalog: tests.catalog, original: tests.original, generated: tests.generated, readOnly: tests.read_only })}</p>}
      {migration.build.result && <BuildResultNote result={migration.build.result} />}
      <FixerEnvNotice fixes={fixes} />
    </section>

    <aside className="flow-panel sbx-side" aria-label={t('sbx.chamberAria')}>
      <Chamber env={sandbox.env} digest={digest} applied={applied} blocked={latest?.checks.blocked_egress ?? 0} cleaned={done?.cleanup_status === 'CLEANED'} />
      <Verdict result={judged} live={real} />
      <div className="sbx-tiles">
        <div className={'sbx-tile' + (passed ? ' is-locked' : '')}>
          <small>{passed && <svg className="sbx-lock" viewBox="0 0 12 14" aria-hidden="true"><rect x="1" y="6" width="10" height="7" rx="1.5" /><path d="M3.5 6V4a2.5 2.5 0 0 1 5 0v2" /></svg>}{t('sbx.digest')}</small>
          <b>{passed && done?.digest ? shortDigest(done.digest) : '—'}</b>
          <small>{passed ? t('sbx.digestSame') : t('sbx.digestWait')}</small>
        </div>
        <div className="sbx-tile">
          <small>{t('sbx.cleanup')}</small>
          <b>{done?.cleanup_status ?? '—'}</b>
          <small>{done ? t(('sbx.cleanup.' + done.cleanup_status) as MsgKey) : t('sbx.cleanup.none')}</small>
        </div>
      </div>
      {fixes.length > 0 && <details className="rehearsal-diff">
        <summary>{t('sbx.diffAll')}</summary>
        <pre className="flow-diff" aria-label={t('rehearsal.diffAria')}>
          {diffOf(fixes).map((line, index) => <span key={index} className={'flow-diff-' + line.kind}>{line.text}</span>)}
        </pre>
      </details>}
      <p className="flow-note">{t('rehearsal.note')}</p>
    </aside>

    <div className="flow-footer">
      <span>{passed
        ? t('sbx.foot.pass') + (appliedFixes.length ? ' ' + t('sbx.foot.fixes', { n: appliedFixes.length }) : '')
        : done?.status === 'STOPPED_RENDER' ? t('sbx.foot.render')
        : migration.build.review ? t('review.title')
        : real && nowText ? (current ? t('sbx.foot.now', { n: current.attempt, max: latest?.max_attempts ?? 3, now: nowText }) : nowText)
        : current ? t('sbx.foot.run', { n: current.attempt, max: latest?.max_attempts ?? 3 })
        : reviewFirst ? t('sbx.waitReview') : t('sbx.foot.wait')}</span>
      <button type="button" className="flow-primary" disabled={!passed} onClick={onNext}>{t('rehearsal.next')} <span aria-hidden="true">→</span></button>
    </div>
  </div>
}
