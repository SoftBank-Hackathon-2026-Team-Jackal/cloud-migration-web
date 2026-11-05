/**
 * 이벤트에 묶인 말 보고. 목업이든 SSE든 같은 이벤트를 읽으므로 똑같이 동작한다.
 * - ReportEngine: 이벤트 → 짧은 보고(발견 · 25/50/75% · 완료 · 실패 · 결정)만 만든다. 그 밖의 진행 이벤트는 말하지 않는다.
 * - ReportQueue: 우선순위(실패 > 결정 > 완료 > 진행·발견), 같은 종류 합치기("리소스 3개 더 발견"),
 *   보고 사이 최소 간격, 오래된 진행 보고 버리기, 잠깐 멈춤.
 * 런타임 import는 같은 폴더의 순수 모듈뿐이다(단위 테스트가 직접 읽는다).
 */
import type { BackendPhase, MigrationEvent } from '../migration/events'
import { VOICE_MESSAGES, voiceText, type VoiceKey, type VoiceLang, type VoiceParams } from './messages.ts'

export type ReportKind = 'failure' | 'decision' | 'complete' | 'milestone' | 'discovery'
export type Report = {
  key: VoiceKey
  params: VoiceParams
  kind: ReportKind
  phase: BackendPhase | null
  /** 같은 series의 보고는 큐에서 합치거나(발견: 개수 더하기) 새 값으로 바꾼다(진행). */
  series?: string
  /** 발견 개수(합칠 때 더한다). params의 countParam 자리에 들어간다. */
  count?: number
  countParam?: string
  at: number
}

export const PRIORITY: Record<ReportKind, number> = { failure: 3, decision: 2, complete: 1, milestone: 0, discovery: 0 }
export const MILESTONES = [25, 50, 75] as const

export function renderReport(report: Report, lang: VoiceLang): string {
  const params = report.countParam && report.count !== undefined ? { ...report.params, [report.countParam]: report.count } : report.params
  return voiceText(lang, report.key, params)
}

/** 프론트 단계 → 백엔드 phase (events.ts의 PHASE_OF_STAGE와 같다. 런타임 import를 피하려고 다시 적는다) */
const PHASE_OF: Record<string, BackendPhase> = {
  analysis: 'analysis', rehearsal: 'build', planning: 'planning', approval: 'awaiting_approval',
  provisioning: 'provisioning', data: 'data_copy', traffic: 'traffic', cutover: 'verification',
}

export type ApprovalFacts = { changes: number; passed: number | null; total: number | null }
/** 승인 전에 읽어 줄 사실(변경 수·테스트 통과·롤백) + 승인 방법 */
export function approvalFactReports(facts: ApprovalFacts, at: number): Report[] {
  const params: VoiceParams = { changes: facts.changes }
  const known = facts.total !== null && facts.passed !== null && facts.total > 0
  if (known) { params.passed = facts.passed as number; params.total = facts.total as number }
  return [
    { key: known ? 'r.approval.facts' : 'r.approval.factsShort', params, kind: 'decision', phase: 'awaiting_approval', series: 'facts', at },
    { key: 'r.approval.ask', params: {}, kind: 'decision', phase: 'awaiting_approval', series: 'ask', at },
  ]
}
/** DB 전환(두 번째 승인) 전에 읽어 줄 사실: 예상 쓰기 중단 */
export function cutoverFactReports(pauseMs: number | null | undefined, at: number): Report[] {
  const seconds = typeof pauseMs === 'number' ? Math.max(.1, Math.round(pauseMs / 100) / 10) : null
  return [
    seconds === null
      ? { key: 'r.cutover.factsShort', params: {}, kind: 'decision', phase: 'verification', series: 'facts', at }
      : { key: 'r.cutover.facts', params: { s: seconds }, kind: 'decision', phase: 'verification', series: 'facts', at },
    { key: 'r.cutover.ask', params: {}, kind: 'decision', phase: 'verification', series: 'ask', at },
  ]
}

/**
 * 이벤트를 보고로 바꾼다. 상태를 조금 기억한다(지난 진행 구간, 한 번만 말할 것, 승인 사실에 쓸 개수).
 * 지금 화면의 단계와 다른 phase의 이벤트(예: 승인 화면이 다시 받는 계획 이벤트)는 실패만 말한다.
 */
export class ReportEngine {
  private once = new Set<string>()
  private milestone = new Map<string, number>()
  /** 계획 미리보기의 만들 리소스 수(원본 유지 제외): 구축 진행을 n/m으로 말할 때 m */
  private provTotal: number | null = null
  /** 데이터 테이블별 복사 끝남 여부: 초기 복사를 n/m으로 말한다 */
  private tables = new Map<string, boolean>()
  private planSteps = new Map<string, boolean>()
  private sandboxChecks: { passed: number; total: number } | null = null
  private lastAttempt = 0
  private provReady = new Set<string>()
  private trafficStep = -1
  private trafficPhase = ''
  private gatesPassed = new Set<number>()
  writePauseMs: number | null = null

  reset() {
    this.once.clear(); this.milestone.clear(); this.provTotal = null; this.tables.clear(); this.planSteps.clear()
    this.sandboxChecks = null; this.lastAttempt = 0; this.provReady.clear(); this.trafficStep = -1; this.trafficPhase = ''; this.gatesPassed.clear(); this.writePauseMs = null
  }

  /** 단계 화면을 다시 열어 그 단계를 처음부터 받을 때(목업의 resetPhase) */
  resetPhase(phase: BackendPhase) {
    for (const key of [...this.once]) if (key.startsWith(phase + ':')) this.once.delete(key)
    for (const key of [...this.milestone.keys()]) if (key.startsWith(phase + ':')) this.milestone.delete(key)
    if (phase === 'data_copy') this.tables.clear()
    if (phase === 'build') { this.sandboxChecks = null; this.lastAttempt = 0 }
    if (phase === 'provisioning') this.provReady.clear()
    if (phase === 'traffic') { this.trafficStep = -1; this.trafficPhase = ''; this.gatesPassed.clear() }
  }

  approvalFacts(): ApprovalFacts {
    const changes = [...this.planSteps.values()].filter(keep => !keep).length
    return { changes, passed: this.sandboxChecks?.passed ?? null, total: this.sandboxChecks?.total ?? null }
  }

  private first(phase: BackendPhase, key: string) {
    const id = phase + ':' + key
    if (this.once.has(id)) return false
    this.once.add(id)
    return true
  }

  /** 지나간 진행 구간(25·50·75) 중 가장 높은 것. 이미 말한 구간이면 null */
  private crossed(phase: BackendPhase, series: string, percent: number | undefined): number | null {
    if (typeof percent !== 'number' || !Number.isFinite(percent)) return null
    const id = phase + ':' + series
    const last = this.milestone.get(id) ?? 0
    const reached = [...MILESTONES].filter(mark => percent >= mark).pop() ?? 0
    if (reached <= last) return null
    this.milestone.set(id, reached)
    return reached
  }

  fromEvent(event: MigrationEvent, stage: string, now: number): Report[] {
    const reports = this.read(event, now)
    const current = PHASE_OF[stage]
    // 승인 결정과 DB 전환 승인은 phase 이름이 화면 단계와 다를 수 있다.
    return reports.filter(report => report.kind === 'failure' || !current || report.phase === null || report.phase === current
      || (stage === 'cutover' && report.phase === 'awaiting_approval'))
  }

  private read(event: MigrationEvent, at: number): Report[] {
    const phase = event.phase
    const make = (key: VoiceKey, kind: ReportKind, params: VoiceParams = {}, extra: Partial<Report> = {}): Report => ({ key, params, kind, phase, at, ...extra })
    switch (event.type) {
      case 'snapshot': return []
      case 'analysis.finding': {
        // 백엔드는 항목마다가 아니라 스캔(Activity)이 끝날 때 알린다: 스캔 완료(그 스트림의 진행 100)만 말하고,
        // 코드에서 찾은 것은 이름을 아는 항목(f.<key>)만 말한다. 개수·퍼센트를 지어내지 않는다.
        const stream = event.data.stream === 'code' ? 'code' : 'infrastructure'
        const out: Report[] = []
        const label = 'f.' + event.data.key
        if (stream === 'code' && label in VOICE_MESSAGES.ko && this.first(phase, 'code:' + event.data.key)) {
          out.push(make('r.analysis.codeFound', 'discovery', { item: label }, { series: 'code:' + event.data.key }))
        }
        if ((event.data.progress ?? 0) >= 100 && this.first(phase, 'scan:' + stream)) out.push(make(`r.analysis.scanDone.${stream}`, 'milestone', {}, { series: 'scan:' + stream }))
        return out
      }
      case 'analysis.done':
        return this.first(phase, 'done') ? [make('r.analysis.done', 'complete')] : []
      case 'build.fix':
        return [make('r.sandbox.fix', 'discovery', {}, { series: 'fix', count: 1, countParam: 'n' })]
      case 'sandbox.attempt': {
        const { attempt, verdict, failure_class: cls, checks } = event.data
        this.lastAttempt = Math.max(this.lastAttempt, attempt)
        if (checks?.required_total) this.sandboxChecks = { passed: checks.required_passed, total: checks.required_total }
        if (verdict.passed || !this.first(phase, 'attempt:' + event.data.run)) return []
        return [make('r.sandbox.attemptFail', 'failure', { attempt, cls: `cls.${cls ?? 'CODE'}` })]
      }
      case 'sandbox.done': {
        const status = event.data.status
        if (status === 'PASSED') return this.first(phase, 'done') ? [make('r.sandbox.passed', 'complete', { attempt: Math.max(1, this.lastAttempt) })] : []
        if (status === 'NEEDS_REVIEW') return this.first(phase, 'review') ? [make('r.sandbox.review', 'decision', { n: Math.max(1, this.lastAttempt) })] : []
        return this.first(phase, 'failed') ? [make('r.sandbox.failed', 'failure')] : []
      }
      case 'build.review':
        return this.first(phase, 'review') ? [make('r.sandbox.review', 'decision', { n: event.data.attempts })] : []
      case 'plan.step':
        this.planSteps.set(event.data.id, Boolean(event.data.keep_source))
        return []
      case 'plan.preview': {
        const data = event.data
        // 백엔드 Preview(changes[])면 만들 리소스 수만 센다. 예상 쓰기 중단은 계획 단계에 없으므로 전환 계획(cutover.plan)에서 받는다.
        if ('changes' in data) this.provTotal = data.changes.filter(change => change.action === 'CREATE').length || null
        else {
          this.provTotal = data.resources.filter(resource => resource.change !== 'KEEP_SOURCE').length || null
          this.writePauseMs = data.rollout?.expected_write_pause_ms ?? this.writePauseMs
        }
        return []
      }
      case 'plan.ready':
        return this.first(phase, 'ready:' + (event.data.revision ?? 1)) ? [make('r.plan.ready', 'complete', { n: this.approvalFacts().changes })] : []
      case 'approval.required':
        if (event.data.gate === 'cutover') return this.first('verification', 'gate') ? cutoverFactReports(this.writePauseMs, at) : []
        return this.first(phase, 'required') ? approvalFactReports(this.approvalFacts(), at) : []
      case 'approval.decision': {
        const { delivery_status: delivery, decision, approval_id: id, delivery_attempts: attempts } = event.data
        if (decision !== 'APPROVE') return []
        if (delivery === 'DELIVERED') return this.first(phase, 'delivered:' + id) ? [make('r.approval.delivered', 'complete')] : []
        if (delivery === 'FAILED') return this.first(phase, 'deliveryFail:' + id + ':' + attempts) ? [make('r.approval.failed', 'failure')] : []
        return []
      }
      case 'provision.resource': {
        if (event.data.state === 'failed') return this.first(phase, 'res:' + event.data.id) ? [make('r.prov.checkFail', 'failure', { name: event.data.name || event.data.key })] : []
        if (event.data.state !== 'done' || this.provReady.has(event.data.id)) return []
        this.provReady.add(event.data.id)
        const n = this.provReady.size
        const m = this.provTotal
        // 전체 수를 알면 "리소스 3/6 준비"(25·50·75를 지날 때만), 모르면 개수만 합쳐 말한다.
        if (m && n <= m) {
          const mark = this.crossed(phase, 'ready', (n / m) * 100)
          return mark && n < m ? [make('r.prov.readyOf', 'milestone', { n, m }, { series: 'progress:' + phase })] : []
        }
        return [make('r.prov.ready', 'discovery', {}, { series: 'ready', count: 1, countParam: 'n' })]
      }
      case 'provision.check': {
        const { name, state, passed, total } = event.data
        if (state === 'failed') return this.first(phase, 'check:' + name) ? [make('r.prov.checkFail', 'failure', { name: String(name).replace(/_/g, ' ') })] : []
        if (name === 'retest' && state === 'done' && this.first(phase, 'done')) return [make('r.prov.done', 'complete', { passed: passed ?? 0, total: total ?? 0 })]
        return []
      }
      case 'data.preflight': {
        const { status, checks } = event.data
        if (status === 'PASS') return this.first(phase, 'preflight') ? [make('r.data.preflightPass', 'milestone')] : []
        if (status === 'FAIL') {
          const failed = checks.find(check => check.status === 'FAIL')
          return this.first(phase, 'preflightFail') ? [make('r.data.preflightFail', 'failure', { code: failed?.code ?? failed?.name ?? 'FAIL' })] : []
        }
        return []
      }
      case 'data.table': {
        // 초기 복사 진행은 테이블 n/m으로만 말한다(25·50·75를 지날 때). 모두 복사되면 한 번 끝났다고 말한다.
        const copied = event.data.state === 'copied' || event.data.state === 'matched'
        this.tables.set(event.data.name, copied || (this.tables.get(event.data.name) ?? false))
        const m = this.tables.size
        const n = [...this.tables.values()].filter(Boolean).length
        if (!copied || m === 0) return []
        if (n === m) return this.first(phase, 'copyDone') ? [make('r.data.copyDone', 'milestone', {}, { series: 'progress:' + phase })] : []
        const mark = this.crossed(phase, 'tables', (n / m) * 100)
        return mark ? [make('r.data.tables', 'milestone', { n, m }, { series: 'progress:' + phase })] : []
      }
      case 'data.readiness':
        return event.data.ready && this.first(phase, 'lagZero') ? [make('r.data.lagZero', 'complete')] : []
      case 'data.verify':
        if (event.data.state === 'failed') return this.first(phase, 'verifyFail') ? [make('r.data.verifyFail', 'failure')] : []
        return event.data.name === 'checksum' && event.data.state === 'done' && this.first(phase, 'verified') ? [make('r.data.verified', 'complete')] : []
      case 'traffic.prepare':
        return event.data.state === 'failed' && this.first(phase, 'prepareFail') ? [make('r.traffic.prepareFail', 'failure')] : []
      case 'traffic.snapshot': {
        const { phase: state, step } = event.data
        const out: Report[] = []
        const previous = this.trafficPhase
        this.trafficPhase = state
        if (state === 'rolledback') {
          if (previous !== 'rolledback') out.push(make('r.traffic.rollback', 'failure'))
          return out
        }
        if (previous === 'rolledback') { this.trafficStep = -1; this.gatesPassed.clear(); this.once.delete(phase + ':done') }
        for (const result of event.data.results ?? []) {
          if (result.verdict === 'pass' && !this.gatesPassed.has(result.step) && result.step < 100) {
            this.gatesPassed.add(result.step)
            out.push(make('r.traffic.gate', 'milestone', { p: result.step }, { series: 'gate:' + phase }))
          }
        }
        if (state === 'complete') {
          if (this.first(phase, 'done')) out.push(make('r.traffic.done', 'complete'))
          return out
        }
        if (state === 'applying' && step !== this.trafficStep && step > 0) {
          this.trafficStep = step
          out.push(make('r.traffic.step', 'milestone', { p: step }, { series: 'progress:' + phase }))
        }
        return out
      }
      case 'cutover.step':
        return event.data.state === 'verify' && this.first(phase, 'verify') ? [make('r.cutover.verify', 'milestone')] : []
      case 'cutover.result': {
        const { id, value, label, ok } = event.data
        const out: Report[] = []
        if (ok === false) out.push(make('r.cutover.fail', 'failure', { label: label || id }))
        // 쓰기 중단(ms)은 성공 뒤 결과로만 온다: 결과가 오면 한 번 말한다.
        else if (/pause|delay/.test(id) && value && this.first(phase, 'pause')) out.push(make('r.cutover.pause', 'milestone', { value }))
        if (event.status === 'done' && this.first(phase, 'done')) out.push(make('r.cutover.done', 'complete'))
        return out
      }
      case 'error':
        return [make('r.error', 'failure', { phase: event.data.phase ? 'phase.' + event.data.phase : event.phase ? 'phase.' + event.phase : '', code: event.data.code }, { phase: event.data.phase ?? event.phase })]
      default:
        return []
    }
  }
}

export type QueueOptions = {
  /** 보고 시작 사이 최소 간격(ms) */
  gapMs?: number
  /** 말이 끝난 뒤 다음 보고까지 쉬는 시간(ms) */
  restMs?: number
  /** 진행·발견 보고가 이만큼 기다렸으면 버린다(ms) */
  staleMs?: number
  /** 쌓아 둘 최대 개수(넘으면 낮은 우선순위부터 버린다) */
  limit?: number
}

/** 말할 보고를 고르는 큐. 시간은 밖에서 넣는다(테스트가 시간을 정할 수 있게). */
export class ReportQueue {
  private items: Report[] = []
  private lastStart = -Infinity
  private lastEnd = -Infinity
  paused = false
  readonly gapMs: number
  readonly restMs: number
  readonly staleMs: number
  readonly limit: number

  constructor({ gapMs = 3500, restMs = 1200, staleMs = 9000, limit = 12 }: QueueOptions = {}) {
    this.gapMs = gapMs; this.restMs = restMs; this.staleMs = staleMs; this.limit = limit
  }

  get size() { return this.items.length }
  peek(): readonly Report[] { return this.items }

  push(report: Report) {
    // 완료·실패가 오면 같은 phase의 밀린 진행·발견 보고는 의미가 없다.
    if ((report.kind === 'complete' || report.kind === 'failure') && report.phase) {
      this.items = this.items.filter(item => !(item.phase === report.phase && (item.kind === 'milestone' || item.kind === 'discovery')))
    }
    const same = report.series ? this.items.find(item => item.series === report.series && item.phase === report.phase && item.kind === report.kind) : undefined
    if (same) {
      if (report.count !== undefined) { same.count = (same.count ?? 0) + report.count; same.at = report.at; return } // 합치기: "3개 더"
      Object.assign(same, { key: report.key, params: report.params, at: report.at }) // 진행: 새 값으로 바꾼다
      return
    }
    this.items.push({ ...report })
    if (this.items.length > this.limit) {
      const lowest = this.items.reduce((low, item) => PRIORITY[item.kind] < PRIORITY[low.kind] ? item : low)
      this.items.splice(this.items.indexOf(lowest), 1)
    }
  }

  /** 다른 말(단계 안내·답변)이 끝났거나 보고가 끝났을 때 */
  spoke(now: number) { this.lastEnd = now }

  /** 단계가 바뀌면 이전 단계의 진행·발견 보고를 버린다. */
  dropStale(phase: BackendPhase | null) {
    this.items = this.items.filter(item => item.kind === 'failure' || item.phase === phase)
  }

  clear() { this.items = [] }

  /** 지금 말할 보고. 말하는 중이거나 간격이 안 됐으면 null */
  next(now: number, speaking: boolean): Report | null {
    this.items = this.items.filter(item => PRIORITY[item.kind] > 0 || now - item.at <= this.staleMs)
    if (speaking || this.items.length === 0) return null
    const pick = this.items.reduce((best, item) => PRIORITY[item.kind] > PRIORITY[best.kind] ? item : best)
    const urgent = pick.kind === 'failure' || pick.kind === 'decision'
    if (this.paused && pick.kind !== 'failure') return null
    if (!urgent && (now - this.lastStart < this.gapMs || now - this.lastEnd < this.restMs)) return null
    if (urgent && now - this.lastEnd < 400) return null
    this.items.splice(this.items.indexOf(pick), 1)
    this.lastStart = now
    return pick
  }
}
