/**
 * 이벤트에 묶인 말 보고. 목업이든 SSE든 같은 이벤트를 읽으므로 똑같이 동작한다.
 * - ReportEngine: 이벤트 → 짧은 보고(시작 · 발견 · 확인 · 완료 · 실패 · 결정). 값은 모두 이벤트에서 온다(지어내지 않는다).
 *   단계가 끝나면 "{다음 단계}(으)로 갈까요?"로 묻는다(다음 단계는 단계 순서에서 고른다).
 * - ReportQueue: 우선순위(실패 > 결정 > 완료 > 진행·발견), 같은 종류 합치기("수정 3건", "네트워크와 클러스터 생성 완료"),
 *   보고 사이 최소 간격, 오래된 진행 보고 버리기, 잠깐 멈춤.
 * 런타임 import는 순수 모듈뿐이다(단위 테스트가 직접 읽는다).
 */
import type { BackendPhase, MigrationEvent } from '../migration/events'
import { VOICE_MESSAGES, voiceText, type VoiceKey, type VoiceLang, type VoiceParams } from './messages.ts'

export type ReportKind = 'failure' | 'decision' | 'complete' | 'milestone' | 'discovery'
export type Report = {
  key: VoiceKey
  params: VoiceParams
  kind: ReportKind
  phase: BackendPhase | null
  /** 같은 series의 보고는 큐에서 합치거나(발견: 개수 더하기·이름 잇기) 새 값으로 바꾼다(진행). */
  series?: string
  /** 발견 개수(합칠 때 더한다). params의 countParam 자리에 들어간다. */
  count?: number
  countParam?: string
  /** 합칠 때 이어 붙일 목록이 든 params 이름("네트워크와 클러스터 생성 완료") */
  listParam?: string
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
/** 단계 순서(lib/stages.ts의 STAGE_ORDER와 같다) */
const STAGE_ORDER = ['intro', 'setup', 'analysis', 'rehearsal', 'planning', 'approval', 'provisioning', 'data', 'traffic', 'cutover'] as const
/** 플랫폼 실제 순서(데이터 → DB 전환 → 트래픽 → 완료 리포트). lib/stages.ts의 DB_FIRST_ORDER와 같고, 끝은 완료 리포트다. */
const DB_FIRST_NEXT: Partial<Record<string, string>> = { data: 'cutover', cutover: 'traffic', traffic: 'report' }
/** 이 phase 다음 단계의 이름 키(stage.<다음>). 마지막이면 null. dbFirst: DB 전환 계획이 트래픽보다 먼저 왔다(실제 순서). */
export function nextStageOf(phase: BackendPhase, dbFirst = false): string | null {
  const stage = Object.keys(PHASE_OF).find(key => PHASE_OF[key] === phase)
  if (dbFirst && stage && DB_FIRST_NEXT[stage]) return 'stage.' + DB_FIRST_NEXT[stage]
  const index = stage ? STAGE_ORDER.indexOf(stage as typeof STAGE_ORDER[number]) : -1
  const next = index >= 0 ? STAGE_ORDER[index + 1] : undefined
  return next ? 'stage.' + next : null
}

/** 승인 전에 확인할 항목(경고·정해야 할 값): 개수와 첫 항목('code:<코드>' 또는 글) */
export type ApprovalFacts = { warnings: number; first: string | null }
/** 승인 전에 읽어 줄 사실: 확인할 것 + (있으면) 경고 + 승인 방법 */
export function approvalFactReports(facts: ApprovalFacts, at: number): Report[] {
  const reports: Report[] = [{ key: 'r.approval.facts', params: {}, kind: 'decision', phase: 'awaiting_approval', series: 'facts', at }]
  if (facts.warnings > 0 && facts.first) reports.push({ key: 'r.approval.warn', params: { n: facts.warnings, first: facts.first }, kind: 'decision', phase: 'awaiting_approval', series: 'warn', at })
  reports.push({ key: 'r.approval.ask', params: {}, kind: 'decision', phase: 'awaiting_approval', series: 'ask', at })
  return reports
}
/** DB 전환(두 번째 승인) 전에 읽어 줄 사실: 예상 쓰기 중단(ms) · 되돌릴 수 있음 · 승인 방법 */
export function cutoverFactReports(pauseMs: number | null | undefined, at: number): Report[] {
  const ms = typeof pauseMs === 'number' && Number.isFinite(pauseMs) ? Math.max(1, Math.round(pauseMs)) : null
  return [
    ms === null
      ? { key: 'r.cutover.factsShort', params: {}, kind: 'decision', phase: 'verification', series: 'facts', at }
      : { key: 'r.cutover.facts', params: { ms }, kind: 'decision', phase: 'verification', series: 'facts', at },
    { key: 'r.cutover.rollback', params: {}, kind: 'decision', phase: 'verification', series: 'rollback', at },
    { key: 'r.cutover.ask', params: {}, kind: 'decision', phase: 'verification', series: 'ask', at },
  ]
}

/** 사전 검사 이름 → 통과 보고 */
const PREFLIGHT_PASS: Record<string, VoiceKey> = {
  cidr_overlap: 'r.data.check.cidr', route: 'r.data.check.route', db_path: 'r.data.check.dbPath', large_transfer: 'r.data.check.transfer',
}
/** 사전에 이름이 있으면 그 키, 없으면 받은 값(이름)·코드 문구 */
const labelOf = (prefix: string, key: string, fallback?: string) => (prefix + key) in VOICE_MESSAGES.ko ? prefix + key : fallback || 'code:' + key

/**
 * 이벤트를 보고로 바꾼다. 상태를 조금 기억한다(한 번만 말할 것, 스캔에서 찾은 것, 계획 요약, 승인 전 경고).
 * 지금 화면의 단계와 다른 phase의 이벤트(예: 승인 화면이 다시 받는 계획 이벤트)는 실패만 말한다.
 */
export class ReportEngine {
  private once = new Set<string>()
  private milestone = new Map<string, number>()
  /** 스캔 흐름별로 찾은 것(사전에 이름이 있는 것만, 순서대로) */
  private found = new Map<string, string[]>()
  /** 데이터 테이블별 복사 끝남 여부: 초기 복사를 n/m으로 말한다 */
  private tables = new Map<string, boolean>()
  private planSteps = new Map<string, { keep: boolean; grade: string; label: string }>()
  private keepNames: string[] = []
  private secretEnv = 0
  private warnings: string[] = []
  private lastAttempt = 0
  private trafficStep = -1
  private trafficPhase = ''
  private gatesPassed = new Set<number>()
  /** 트래픽 이벤트보다 DB 전환 계획·승인 요청이 먼저 왔는지(reducer의 cutover.dbFirst와 같은 규칙) */
  private dbFirst = false
  private trafficSeen = false
  private checksums: boolean[] = []
  writePauseMs: number | null = null

  reset() {
    this.once.clear(); this.milestone.clear(); this.found.clear(); this.tables.clear(); this.planSteps.clear()
    this.keepNames = []; this.secretEnv = 0; this.warnings = []
    this.lastAttempt = 0; this.trafficStep = -1; this.trafficPhase = ''; this.gatesPassed.clear(); this.checksums = []; this.writePauseMs = null
    this.dbFirst = false; this.trafficSeen = false
  }

  /** 단계 화면을 다시 열어 그 단계를 처음부터 받을 때(목업의 resetPhase) */
  resetPhase(phase: BackendPhase) {
    for (const key of [...this.once]) if (key.startsWith(phase + ':')) this.once.delete(key)
    for (const key of [...this.milestone.keys()]) if (key.startsWith(phase + ':')) this.milestone.delete(key)
    if (phase === 'analysis') this.found.clear()
    if (phase === 'data_copy') this.tables.clear()
    if (phase === 'build') this.lastAttempt = 0
    if (phase === 'traffic') { this.trafficStep = -1; this.trafficPhase = ''; this.gatesPassed.clear() }
    if (phase === 'verification') this.checksums = []
  }

  approvalFacts(): ApprovalFacts {
    return { warnings: this.warnings.length, first: this.warnings[0] ?? null }
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

  private remember(stream: string, key: string) {
    const label = 'item.' + key
    if (!(label in VOICE_MESSAGES.ko)) return
    const list = this.found.get(stream) ?? []
    if (!list.includes(label)) list.push(label)
    this.found.set(stream, list)
  }

  private read(event: MigrationEvent, at: number): Report[] {
    const phase = event.phase
    if (event.type.startsWith('traffic.')) this.trafficSeen = true
    if ((event.type === 'cutover.plan' || (event.type === 'approval.required' && event.data.gate === 'cutover')) && !this.trafficSeen) this.dbFirst = true
    const make = (key: VoiceKey, kind: ReportKind, params: VoiceParams = {}, extra: Partial<Report> = {}): Report => ({ key, params, kind, phase, at, ...extra })
    const ask = (key: VoiceKey, params: VoiceParams = {}) => {
      const next = nextStageOf(phase, this.dbFirst)
      return make(key, 'complete', next ? { ...params, next } : params)
    }
    const scanDone = (stream: 'infrastructure' | 'code') => {
      if (!this.first(phase, 'scan:' + stream)) return []
      const items = this.found.get(stream) ?? []
      return [items.length
        ? make(`r.analysis.scanDone.${stream}`, 'milestone', { items }, { series: 'scan:' + stream })
        : make(`r.analysis.scanEmpty.${stream}`, 'milestone', {}, { series: 'scan:' + stream })]
    }
    switch (event.type) {
      case 'snapshot': return []
      case 'analysis.scan': {
        // 백엔드: 스캔 Activity가 끝날 때마다 한 건. 그 흐름의 스캔이 모두 끝나면(completed = total) 찾은 것을 한 번 말한다.
        const { stream, items, completed, total } = event.data
        for (const item of items) if (item.n > 0) this.remember(stream, item.key)
        return total > 0 && completed >= total ? scanDone(stream) : []
      }
      case 'analysis.finding': {
        // 예전 방식(항목마다 한 건): 이름을 아는 항목을 모아 두었다가 그 흐름의 진행이 100이 되면 말한다.
        const stream = event.data.stream === 'code' ? 'code' : 'infrastructure'
        this.remember(stream, event.data.key)
        return (event.data.progress ?? 0) >= 100 ? scanDone(stream) : []
      }
      case 'analysis.done':
        return this.first(phase, 'done') ? [ask('r.analysis.done')] : []
      case 'sandbox.tests':
        return this.first(phase, 'start') ? [make('r.start.rehearsal', 'milestone', { n: event.data.total })] : []
      case 'sandbox.step':
      case 'build.check':
        // 테스트 수를 보내지 않는 백엔드: 첫 진행 이벤트에서 시작만 알린다.
        return this.first(phase, 'start') ? [make('r.start.rehearsalPlain', 'milestone')] : []
      case 'build.fix':
        return [make('r.sandbox.fix', 'discovery', {}, { series: 'fix', count: 1, countParam: 'n' })]
      case 'sandbox.attempt': {
        const { attempt, verdict, failure_class: cls } = event.data
        this.lastAttempt = Math.max(this.lastAttempt, attempt)
        if (verdict.passed || !this.first(phase, 'attempt:' + event.data.run)) return []
        return [make('r.sandbox.attemptFail', 'failure', { attempt, cls: `cls.${cls ?? 'CODE'}` })]
      }
      case 'sandbox.done': {
        const status = event.data.status
        if (status === 'PASSED') return this.first(phase, 'done') ? [ask('r.sandbox.passed')] : []
        if (status === 'NEEDS_REVIEW') return this.first(phase, 'review') ? [make('r.sandbox.review', 'decision', { n: Math.max(1, this.lastAttempt) })] : []
        return this.first(phase, 'failed') ? [make('r.sandbox.failed', 'failure')] : []
      }
      case 'build.review':
        return this.first(phase, 'review') ? [make('r.sandbox.review', 'decision', { n: event.data.attempts })] : []
      case 'plan.step': {
        const { id, keep_source: keep, grade, before } = event.data
        this.planSteps.set(id, { keep: Boolean(keep), grade, label: labelOf('step.', id, before) })
        return []
      }
      case 'plan.preview': {
        const data = event.data
        // 원본에 두는 것 · Secret으로 넘기는 환경 변수 · 승인 전에 확인할 경고(경고 + 정해야 할 값).
        if ('changes' in data) {
          this.warnings = [...data.warnings, ...data.pending_decisions].map(issue => issue.code ? 'code:' + issue.code : issue.message).filter(Boolean)
          this.keepNames = []
        } else {
          this.warnings = [...data.validation.warnings, ...(data.pending_decisions ?? [])].map(issue => issue.message || 'code:' + issue.id).filter(Boolean)
          this.keepNames = data.resources.filter(resource => resource.change === 'KEEP_SOURCE').map(resource => resource.name || labelOf('step.', resource.id))
          this.writePauseMs = data.rollout?.expected_write_pause_ms ?? this.writePauseMs
        }
        this.secretEnv = (data.env_remap ?? []).filter(item => item.secret).length
        return []
      }
      case 'plan.ready': {
        if (!this.first(phase, 'ready:' + (event.data.revision ?? 1))) return []
        // 계획 요약은 완료와 같은 무게로 순서대로 말한다(완료가 오면 앞의 진행 보고를 버리므로).
        const out: Report[] = []
        const steps = [...this.planSteps.values()].filter(step => !step.keep)
        const direct = steps.filter(step => step.grade === 'DIRECT').length
        if (steps.length) out.push(make('r.plan.mapping', 'complete', { direct, diff: steps.length - direct }, { series: 'plan:mapping' }))
        const keep = this.keepNames.length ? this.keepNames : [...this.planSteps.values()].filter(step => step.keep).map(step => step.label)
        if (keep.length) out.push(make('r.plan.keep', 'complete', { items: keep }, { series: 'plan:keep' }))
        const { built_digest: built, verified_digest: verified } = event.data
        if (verified && (!built || built === verified)) out.push(make('r.plan.pinned', 'complete', {}, { series: 'plan:pinned' }))
        if (this.secretEnv > 0) out.push(make('r.plan.env', 'complete', { n: this.secretEnv }, { series: 'plan:env' }))
        out.push(ask('r.plan.ready'))
        return out
      }
      case 'approval.required':
        if (event.data.gate === 'cutover') return this.first('verification', 'gate') ? cutoverFactReports(this.writePauseMs, at) : []
        if (event.data.pending_decisions?.length && !this.warnings.length) this.warnings = event.data.pending_decisions.map(issue => 'code:' + issue.code)
        return this.first(phase, 'required') ? approvalFactReports(this.approvalFacts(), at) : []
      case 'approval.decision': {
        const { delivery_status: delivery, decision, approval_id: id, delivery_attempts: attempts } = event.data
        if (decision !== 'APPROVE') return []
        if (delivery === 'DELIVERED') return this.first(phase, 'delivered:' + id) ? [make('r.approval.delivered', 'complete')] : []
        if (delivery === 'FAILED') return this.first(phase, 'deliveryFail:' + id + ':' + attempts) ? [make('r.approval.failed', 'failure')] : []
        return []
      }
      case 'provision.resource': {
        const { id, key, state, name } = event.data
        const label = name || labelOf('res.', key)
        if (state === 'failed') return this.first(phase, 'res:' + id) ? [make('r.prov.fail', 'failure', { name: label })] : []
        if (state === 'running') return this.first(phase, 'creating:' + id) ? [make('r.prov.creating', 'milestone', { name: label }, { series: 'creating:' + id })] : []
        // 빨리 연달아 끝나면 큐가 이름을 잇는다("네트워크와 클러스터 생성 완료").
        return this.first(phase, 'ready:' + id) ? [make('r.prov.ready', 'discovery', { name: [label] }, { series: 'ready', listParam: 'name' })] : []
      }
      case 'provision.check': {
        const { name, state } = event.data
        if (state === 'failed') return this.first(phase, 'check:' + name) ? [make('r.prov.checkFail', 'failure', { check: labelOf('check.', name) })] : []
        if (state !== 'done') return []
        if (name === 'retest') return this.first(phase, 'done') ? [ask('r.prov.done')] : []
        return this.first(phase, 'checked:' + name) ? [make('r.prov.check', 'milestone', { check: labelOf('check.', name) }, { series: 'check:' + name })] : []
      }
      case 'data.preflight': {
        const { status, checks } = event.data
        const out: Report[] = []
        if (status === 'FAIL') {
          const failed = checks.find(check => check.status === 'FAIL')
          return this.first(phase, 'preflightFail') ? [make('r.data.preflightFail', 'failure', { reason: 'code:' + (failed?.code ?? failed?.name ?? 'FAIL') })] : []
        }
        for (const check of checks) {
          const key = PREFLIGHT_PASS[check.name]
          if (key && check.status === 'PASS' && this.first(phase, 'pf:' + check.name)) out.push(make(key, 'milestone', {}, { series: 'pf:' + check.name }))
        }
        if (status === 'PASS' && this.first(phase, 'preflight')) out.push(make('r.data.preflightPass', 'complete'))
        return out
      }
      case 'data.table': {
        // 초기 복사 진행은 "테이블 m개 중 n개"로만 말한다(25·50·75를 지날 때). 모두 복사되면 한 번 끝났다고 말한다.
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
        return event.data.ready && this.first(phase, 'lagZero') ? [ask('r.data.lagZero')] : []
      case 'data.verify':
        if (event.data.state === 'failed') return this.first(phase, 'verifyFail') ? [make('r.data.verifyFail', 'failure')] : []
        return event.data.name === 'checksum' && event.data.state === 'done' && this.first(phase, 'verified') ? [make('r.data.verified', 'milestone')] : []
      case 'traffic.prepare':
        return event.data.state === 'failed' && this.first(phase, 'prepareFail') ? [make('r.traffic.prepareFail', 'failure')] : []
      case 'traffic.snapshot': {
        const { phase: state, step, gate } = event.data
        const out: Report[] = []
        const previous = this.trafficPhase
        this.trafficPhase = state
        const notes = event.data.notes ?? []
        if (state === 'rolledback') {
          // 안정화 구간에서 사람이 롤백했으면 "기준 초과" 대신 되돌린 사실을, DB까지 되돌렸으면 한 번 더 말한다.
          if (previous !== 'rolledback') out.push(make(previous === 'stabilizing' ? 'r.traffic.rollbackManual' : 'r.traffic.rollback', 'failure'))
          if (notes.some(note => note.key === 'dbRollback') && this.first(phase, 'dbRollback')) out.push(make('r.traffic.dbRollback', 'complete'))
          return out
        }
        if (state === 'stabilizing') {
          if (previous !== 'stabilizing' && this.first(phase, 'stabilizing')) out.push(make('r.traffic.stabilizing', 'milestone'))
          return out
        }
        if (previous === 'rolledback') {
          this.trafficStep = -1; this.gatesPassed.clear()
          for (const key of ['done', 'stabilizing', 'dbRollback']) this.once.delete(phase + ':' + key)
        }
        for (const result of event.data.results ?? []) {
          if (result.verdict === 'pass' && !this.gatesPassed.has(result.step) && result.step < 100) {
            this.gatesPassed.add(result.step)
            out.push(make('r.traffic.gate', 'milestone', { p: result.step, f: result.failed_requests }, { series: 'gate:' + phase }))
          }
        }
        if (state === 'complete') {
          if (this.first(phase, 'done')) out.push(ask('r.traffic.done'))
          return out
        }
        if (state === 'applying' && step !== this.trafficStep && step > 0) {
          this.trafficStep = step
          const seconds = gate.observe_seconds
          out.push(step < 100 && typeof seconds === 'number' && seconds > 0
            ? make('r.traffic.step', 'milestone', { p: step, s: seconds }, { series: 'progress:' + phase })
            : make('r.traffic.stepShort', 'milestone', { p: step }, { series: 'progress:' + phase }))
        }
        return out
      }
      case 'traffic.alert': {
        // 안정화 구간의 이상: 사람이 묻기 전에 먼저 말하고 롤백할지 묻는다. 값은 이벤트 그대로(오류율 %, p99 ms).
        const data = event.data
        if (data.state === 'recovered') return [make('r.traffic.recovered', 'milestone', {}, { series: 'alert:' + phase })]
        const error = data.breach.find(item => item.code === 'ERROR_RATE')
        const p99 = data.breach.find(item => item.code === 'P99')
        if (error) return [make('r.traffic.alertError', 'failure', { p: Math.round(error.value * 1000) / 10 }, { series: 'alert:' + phase })]
        if (p99) return [make('r.traffic.alertP99', 'failure', { ms: Math.round(p99.value) }, { series: 'alert:' + phase })]
        return []
      }
      case 'cutover.step': {
        const { state, id, result } = event.data
        if (state === 'verify') return this.first(phase, 'verify') ? [make('r.cutover.verify', 'milestone')] : []
        if (id === 'pause' && state === 'done' && this.first(phase, 'paused')) return [make('r.cutover.paused', 'milestone')]
        if (result === 'fail' && id && this.first(phase, 'stepFail')) this.once.add(phase + ':failedStep:' + id)
        return []
      }
      case 'cutover.outcome': {
        const { result, reason } = event.data
        if (result !== 'refused' || !this.first(phase, 'refused')) return []
        const failedStep = [...this.once].find(key => key.startsWith(phase + ':failedStep:'))?.split(':').pop()
        const why = reason || (failedStep ? failedStep + '_failed' : 'switch_refused')
        return [make('r.cutover.refused', 'failure', { reason: 'code:' + why })]
      }
      case 'cutover.verify':
        if (event.data.checksum === 'match' || event.data.checksum === 'mismatch') this.checksums.push(event.data.checksum === 'match')
        return []
      case 'cutover.result': {
        const { id, value, label, ok } = event.data
        const out: Report[] = []
        if (ok === false) out.push(make('r.cutover.fail', 'failure', { label: label || 'code:' + id }))
        // 쓰기 중단(ms)은 성공 뒤 결과로만 온다: 결과가 오면 한 번 말한다.
        else if (/pause|delay/.test(id) && value && this.first(phase, 'pause')) out.push(make('r.cutover.pause', 'milestone', { value }))
        if (event.status === 'done' && this.first(phase, 'done')) {
          const matched = this.checksums.length > 0 && this.checksums.every(Boolean)
          out.push(make(matched ? 'r.cutover.done' : 'r.cutover.doneShort', 'complete'))
        }
        return out
      }
      case 'error':
        return [make('r.error', 'failure', { phase: event.data.phase ? 'phase.' + event.data.phase : event.phase ? 'phase.' + event.phase : '', reason: 'code:' + event.data.code }, { phase: event.data.phase ?? event.phase })]
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
      if (report.listParam && Array.isArray(same.params[report.listParam]) && Array.isArray(report.params[report.listParam])) {
        // 합치기: 이름 잇기("네트워크와 클러스터 생성 완료")
        const names = [...same.params[report.listParam] as string[], ...report.params[report.listParam] as string[]]
        same.params = { ...same.params, [report.listParam]: [...new Set(names)] }
        same.at = report.at
        return
      }
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
