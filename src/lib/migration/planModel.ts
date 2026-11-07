/**
 * 계획 화면이 받은 데이터에서 계산하는 값(요약 수, 경고, 구성도 노드 분류). 순수 함수만 둔다(런타임 import 없음).
 * 서버가 무엇을 보내든(앱마다 리소스가 다르다) 같은 규칙으로 화면을 그리려는 것이다.
 */
import type { BuildFixData, PlanEnvironment, PlanIssue, PlanNodeKind, PlanPreviewData, PlanResource, PlanStepData, Target } from './events'
import type { MigrationState } from './reducer'
import { PENDING_DECISION_ROW, ROLLOUT_POLICY_DEFAULTS } from './policy.ts'
import { estimateCost, type CostView } from './pricing.ts'

/** 매핑 요약: 원본 유지는 따로 세고, 나머지는 처리(진행·승인 필요·차단)별로 센다. 합은 항상 전체 매핑 수다. */
export function planSummary(steps: PlanStepData[]) {
  const moved = steps.filter(step => !step.keep_source)
  return {
    total: steps.length,
    proceed: moved.filter(step => step.action === 'PROCEED').length,
    approval: moved.filter(step => step.action === 'APPROVAL').length,
    block: moved.filter(step => step.action === 'BLOCK').length,
    keep: steps.length - moved.length,
  }
}

/** 경고는 한 목록에서만 센다: 검증 경고 + 리소스에만 달려 온 경고(같은 리소스의 경고는 하나로). */
export function planWarnings(preview: PlanPreviewData | null): PlanIssue[] {
  if (!preview) return []
  const list = [...preview.validation.warnings]
  for (const resource of preview.resources) {
    if (resource.warning && !list.some(issue => issue.resource === resource.id)) list.push({ id: 'res-' + resource.id, resource: resource.id, message: resource.warning })
  }
  return list
}

/** 원본·대상 리소스 분류. 서버가 kind를 주지 않으면 id·문구로 짐작한다. */
export function kindOf(item: { id: string; kind?: PlanNodeKind; before?: string; after?: string; name?: string }): PlanNodeKind {
  if (item.kind) return item.kind
  const text = (item.id + ' ' + (item.before ?? '') + ' ' + (item.name ?? '')).toLowerCase()
  if (/pgbouncer|proxy|pooler/.test(text)) return 'proxy'
  if (/redis|memcache|cache/.test(text)) return 'cache'
  if (/sqs|kafka|queue|pubsub|rabbit/.test(text)) return 'queue'
  if (/s3|bucket|storage|blob|gcs/.test(text)) return 'storage'
  if (/postgres|mysql|database|rds|\bdb\b|sql/.test(text)) return 'database'
  if (/alb|nlb|elb|ingress|lb\b|load ?balancer|gateway/.test(text)) return 'ingress'
  if (/vpc|subnet|network|nat/.test(text)) return 'network'
  if (/env|config|secret|code/.test(text)) return 'config'
  if (/eks|ec2|compute|deploy|app|pod|node|cluster|service/.test(text)) return 'compute'
  return 'other'
}

/** 구성도 줄 순서: 진입 → 실행 → 중간(프록시) → 데이터 */
const TIER: Record<PlanNodeKind, number> = { ingress: 0, network: 0, compute: 1, proxy: 2, database: 3, cache: 4, queue: 5, storage: 6, other: 7, config: 9 }
export function tierOf(kind: PlanNodeKind) { return TIER[kind] }

/** 구성도에 노드로 놓을 매핑: 인프라 항목 중 설정(config)이 아닌 것, 줄 순서대로 */
export function diagramSteps(steps: PlanStepData[]) {
  return steps
    .filter(step => step.group === 'infrastructure' && kindOf(step) !== 'config')
    .map((step, index) => ({ step, kind: kindOf(step), index }))
    .sort((a, b) => tierOf(a.kind) - tierOf(b.kind) || a.index - b.index)
}

/** 대상 구성 표의 묶음 순서. 원본 유지(KEEP_SOURCE)는 원래 묶음과 관계없이 마지막 '원본 유지' 묶음으로 간다. */
export const LEDGER_GROUPS = ['network', 'compute', 'data', 'other', 'keep'] as const
export type LedgerGroup = (typeof LEDGER_GROUPS)[number]
export function ledgerGroupOf(resource: PlanResource): LedgerGroup {
  return resource.change === 'KEEP_SOURCE' ? 'keep' : resource.group
}

/** 분석·계획이 오브젝트 저장소를 보고했는가. 아무 결과도 없으면(시연용 단계 이동) 예전처럼 보여 준다. */
export function reportsStorage(state: Pick<MigrationState, 'analysis' | 'plan'>): boolean {
  const findings = state.analysis.findings
  const scanItems = (state.analysis.scans ?? []).flatMap(scan => scan.items)
  const steps = state.plan.steps
  const resources = state.plan.preview?.resources ?? []
  if (findings.length === 0 && scanItems.length === 0 && steps.length === 0 && resources.length === 0) return true
  return findings.some(finding => kindOf({ id: finding.key, name: finding.message }) === 'storage')
    || scanItems.some(item => kindOf({ id: item.key }) === 'storage')
    || steps.some(step => kindOf(step) === 'storage')
    || resources.some(resource => kindOf(resource) === 'storage')
}

/** 계획이 전환 단계를 보내지 않았을 때 쓰는 기본 단계(정책 기본값, policy.ts) */
export const DEFAULT_TRAFFIC_STEPS = ROLLOUT_POLICY_DEFAULTS.traffic_steps

/** 계획이 원본 환경을 보내지 않았을 때(Preview에는 없다) 쓰는 원본. 이 데모의 원본은 서울 리전의 EKS다. */
export const SOURCE_FALLBACK: PlanEnvironment = { provider: 'AWS', platform: 'EKS', location: 'ap-northeast-2' }
/** 계획이 대상 환경을 보내지 않았을 때 설정 화면의 대상으로 만든다(provider·기본 지역). */
const TARGET_FALLBACK: Record<Target, PlanEnvironment> = {
  gcp: { provider: 'GCP', platform: '', location: 'asia-northeast3' },
  onprem: { provider: 'ON_PREM', platform: '', location: '' },
}
export function targetEnvOf(preview: PlanPreviewData | null, target: Target): PlanEnvironment {
  return preview?.target ?? TARGET_FALLBACK[target]
}

/**
 * 비용 탭의 값. 계획이 요금 추정(cost)을 보내면 그대로 쓰고, 아니면 가격표(pricing.ts)로 계산한다:
 * 원본은 분석 스캔의 인벤토리, 대상은 미리보기의 리소스. 대상이 온프레미스면 추가 클라우드 비용이 없다(noCloudTarget).
 */
export function costViewOf(state: Pick<MigrationState, 'analysis' | 'plan'>, target: Target): CostView | null {
  const preview = state.plan.preview
  if (preview?.cost) return { ...preview.cost, bases: preview.cost.basis ? [{ provider: '', region: '', date: preview.cost.basis, basis: '' }] : [], noCloudTarget: target === 'onprem' }
  return estimateCost({ source: preview?.source ?? SOURCE_FALLBACK, target: targetEnvOf(preview, target), scans: state.analysis.scans ?? [], resources: preview?.resources ?? [] })
}

/**
 * 승인 화면 요약의 값. 모두 받은 데이터에서 계산하고, 없는 값은 null로 둔다(화면이 '받지 못함'으로 보인다).
 * - changes: 옮기는 매핑 수(인프라·코드 설정), 원본 유지 수, 처리별 수
 * - sandbox: 판정이 끝난 마지막 시도의 필수 테스트 결과. 없으면 매핑 항목의 검증 상태로 대신 센다.
 * - traffic: 계획의 전환 단계(없으면 기본 단계, defaulted로 표시)
 */
export function approvalFacts(state: Pick<MigrationState, 'plan' | 'sandbox' | 'traffic'> & { approval?: Pick<MigrationState['approval'], 'pendingDecisions'> }) {
  const steps = state.plan.steps
  const moved = steps.filter(step => !step.keep_source)
  const summary = planSummary(steps)
  const last = state.sandbox.attempts[state.sandbox.attempts.length - 1]
  const sandbox = last
    ? { kind: 'tests' as const, passed: last.checks.required_passed, total: last.checks.required_total, attempt: last.attempt, ok: last.verdict.passed }
    : steps.length > 0
      ? { kind: 'mapping' as const, passed: moved.filter(step => step.verification === 'SANDBOX_VERIFIED').length, total: moved.length, attempt: null, ok: moved.every(step => step.verification !== 'UNVERIFIED') }
      : null
  const rollout = state.plan.preview?.rollout
  const planned = rollout?.traffic_steps?.filter(value => value > 0 && value <= 100) ?? []
  const live = state.traffic.snapshot?.steps ?? []
  const trafficSteps = planned.length > 0 ? planned : live.length > 0 ? live : DEFAULT_TRAFFIC_STEPS
  // 승인 전에 정해야 할 값: 미리보기의 pending_decisions + 승인 요청의 pending_decisions(code, 중복 없이)
  const pending = [...new Set([...(state.plan.preview?.pending_decisions ?? []).map(issue => issue.id), ...(state.approval?.pendingDecisions ?? [])])]
  const pause = rollout?.expected_write_pause_ms
  return {
    hasPlan: steps.length > 0,
    changes: {
      infrastructure: moved.filter(step => step.group === 'infrastructure').length,
      code: moved.filter(step => step.group === 'code').length,
      keep: summary.keep,
      approval: summary.approval,
      block: summary.block,
    },
    sandbox,
    database: steps.find(step => kindOf(step) === 'database' && !step.keep_source) ?? null,
    traffic: { steps: trafficSteps, method: rollout?.traffic_method ?? null, defaulted: planned.length === 0 && live.length === 0 },
    /** 계획이 보내지 않으면 정책 기본값(defaulted) */
    writePause: { ms: pause ?? ROLLOUT_POLICY_DEFAULTS.expected_write_pause_ms, defaulted: pause === undefined },
    dataMethod: { value: rollout?.data_method ?? ROLLOUT_POLICY_DEFAULTS.data_method, defaulted: rollout?.data_method === undefined },
    /** pending_decisions code를 요약의 줄로 나눈다: 롤백·정리 정책 줄 · 제외·한계 목록 */
    pending: { rollback: pending.filter(code => PENDING_DECISION_ROW[code] === 'rollback'), excluded: pending.filter(code => PENDING_DECISION_ROW[code] !== 'rollback') },
    keepSteps: steps.filter(step => step.keep_source),
  }
}

/** Fixer 수정이 새로 읽게 된 환경 변수(중복 없이, 받은 순서). build.fix의 new_env_keys [가정]에서 센다. */
export function fixerEnvKeys(fixes: BuildFixData[]): string[] {
  return [...new Set(fixes.flatMap(fix => fix.new_env_keys ?? []))]
}

/** 계획 화면이 연출 타이머로 한 줄씩 드러내는 최대 줄 수. 이보다 많은 줄은 마지막 타이머에 한꺼번에 드러난다. */
export const PLAN_MAX_REVEAL = 12

/**
 * 계획 화면의 드러난 줄 수와 완료 여부.
 * - units: 받은 줄 수(매핑·리소스 중 많은 쪽), revealed: 연출 타이머가 센 수(최대 PLAN_MAX_REVEAL)
 * - 타이머가 끝까지 돌면 12줄을 넘는 실제 계획도 나머지 줄까지 모두 드러나고, 서버가 "계획 끝"을 알렸으면 완료다.
 */
export function planReveal(revealed: number, units: number, ready: boolean): { visibleCount: number; complete: boolean } {
  const visibleCount = revealed >= PLAN_MAX_REVEAL ? units : Math.min(revealed, units)
  return { visibleCount, complete: ready && units > 0 && visibleCount === units }
}

/**
 * 실제 백엔드 Preview 줄의 제목. 백엔드 name(예: "NetworkPolicy chat-app → chat-db", "chat-app Service")이 사람이 읽는 값이라
 * 화면 id(vpc-2·app-2…) 대신 이것을 쓴다. NetworkPolicy처럼 앞에 종류가 붙은 이름은 "종류 · 나머지"로 나눠 보인다.
 */
export function backendResourceTitle(name: string): string {
  const match = /^(NetworkPolicy|Namespace|Secret|Service|Deployment|StatefulSet|PVC)\s+(.+)$/.exec(name.trim())
  return match ? match[1] + ' · ' + match[2] : name.trim()
}

/**
 * 매핑이 돌지 않았다는 백엔드 경고(MAPPING_NOT_RUN)의 이유. code가 MAPPING_NOT_RUN이거나
 * 메시지가 "MAPPING_NOT_RUN: <이유>"이면 이유를, 경고가 없으면 null을 준다(이유가 비었으면 '').
 */
export function mappingNotRunReason(preview: Pick<PlanPreviewData, 'validation'> | null | undefined): string | null {
  const issues = [...(preview?.validation.warnings ?? []), ...(preview?.validation.errors ?? [])]
  const prefix = /^\s*MAPPING_NOT_RUN\s*:?\s*/
  const hit = issues.find(issue => issue.id === 'MAPPING_NOT_RUN' || prefix.test(issue.message ?? ''))
  if (!hit) return null
  return (hit.message ?? '').replace(prefix, '').trim()
}

/**
 * 계획 화면 왼쪽 "인프라 분석" 상태. 목업은 기존 그대로(분석 없이 열면 완료, 코드만 왔으면 대기).
 * 실제 모드는 인프라 스캔이 무언가를 찾아 왔을 때만 완료다. 스캔을 안 했거나(NOT_COLLECTED: 빈 묶음) 아예 안 왔으면 skipped.
 */
export function infraScanState(mode: 'mock' | 'sse', analysis: Pick<MigrationState['analysis'], 'findings' | 'scans'>): 'done' | 'waiting' | 'skipped' {
  if (mode === 'mock') {
    const streams = [...analysis.findings.map(update => update.stream), ...analysis.scans.map(scan => scan.stream)]
    return streams.length === 0 || streams.includes('infrastructure') ? 'done' : 'waiting'
  }
  const collected = analysis.scans.some(scan => scan.stream === 'infrastructure' && scan.items.length > 0)
    || analysis.findings.some(update => update.stream === 'infrastructure')
  return collected ? 'done' : 'skipped'
}

/* ==== 실제 모드 대상 구성 표(Ledger) 줄 만들기 ====
 * 백엔드 Preview의 name·size는 사람이 읽는 긴 문장이다. 표가 읽히도록 짧은 이름(제목)·설명(보조 줄)·크기 칸으로 나눈다.
 * 모양을 모르는 문장은 예전처럼 그대로 제목에 둔다(안전한 기본). 목업 모드는 이 함수를 쓰지 않는다.
 */

/** 화면 문구: 그대로 보일 값이거나 사전 키(+값) */
export type LedgerText = string | { key: string; params?: Record<string, string | number> }
export type LedgerRow = {
  /** 줄 key·경고를 찾는 리소스 id(묶은 줄은 첫 리소스) */
  id: string
  ids: string[]
  resource: PlanResource
  title: LedgerText
  /** 제목 칸 툴팁(백엔드 원문) */
  full: string
  sub: LedgerText[]
  /** 크기 칸 첫 줄(예: CPU 250m)과 둘째 줄(예: 메모리 256MiB) */
  size: string
  sizeSub: string
  /** false면 변경 칩을 붙이지 않는다(예: 외부 공개 없음 안내 줄) */
  chip: boolean
  change: PlanResource['change']
  defaulted: boolean
}
/** 보안 규칙 칸 한 줄. deny는 기본 차단(그 외 전부 차단), ports는 "TCP 5432" 같은 프로토콜·포트 */
export type LedgerRule = { from: string; to: string; ports: string; deny: boolean; full: string }

const UUID = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
/** 클러스터 UID 같은 긴 UUID는 앞 8자 + … */
export function shortenIds(text: string): string {
  return text.replace(UUID, '$1…')
}

/** 이미지 주소(레지스트리/저장소@sha256:…)를 짧게: 긴 레지스트리 호스트는 첫 마디만, Digest는 앞 12자 */
export function shortImage(image: string): string {
  const at = image.indexOf('@sha256:')
  if (at < 0) return image
  const repo = image.slice(0, at)
  const digest = image.slice(at + 1).replace(/^sha256:/, '').replace(/[^0-9a-f].*$/i, '').slice(0, 12)
  const slash = repo.indexOf('/')
  const host = slash > 0 ? repo.slice(0, slash) : ''
  const path = slash > 0 ? repo.slice(slash + 1) : repo
  const shortHost = host.length > 24 && host.includes('.') ? host.split('.')[0] + '…' : host
  return (shortHost ? shortHost + '/' : '') + path + '@sha256:' + digest
}

const SIZE_PART = /^(?:(?:CPU|vCPU|메모리|Memory|メモリ)\s+\S+|\d+(?:\.\d+)?\s?(?:GiB|MiB|TiB|GB|MB|TB))$/i
/**
 * size 문자열을 크기 칸(CPU·메모리·용량)과 나머지(보조 줄)로 나눈다. 이미지 주소는 짧게 줄여 보조 줄로 간다.
 * 어댑터가 붙인 "× 개수"는 크기 칸에 남긴다.
 */
export function splitBackendSize(size: string): { size: string; sizeSub: string; extra: string[] } {
  const raw = size.trim()
  if (!raw || raw === '—') return { size: '', sizeSub: '', extra: [] }
  const times = /\s×\s(\d+)$/.exec(raw)
  const body = times ? raw.slice(0, times.index) : raw
  const sizes: string[] = []
  const extra: string[] = []
  const images: string[] = []
  for (const piece of body.split(' · ').map(part => part.trim()).filter(Boolean)) {
    if (piece.includes('@sha256:')) images.push(shortImage(piece))
    else if (SIZE_PART.test(piece)) sizes.push(piece)
    else extra.push(piece)
  }
  // 크기 칸이 좁아 첫 값(CPU)만 첫 줄에, 나머지(메모리 등)는 둘째 줄에. 이미지 주소는 길어서 보조 줄 맨 뒤에 둔다.
  const count = times ? '× ' + times[1] : ''
  return { size: [sizes[0] ?? '', count].filter(Boolean).join(' '), sizeSub: sizes.slice(1).join(' · '), extra: [...extra, ...images] }
}

const KIND_TOKEN = /(?:^|\s)(Namespace|Secret|Service|Deployment|StatefulSet|ConfigMap|PVC)\s+([a-z0-9][a-z0-9.\-/]*)/
const KIND_SUFFIX = /^([a-z0-9][a-z0-9.\-]*)\s+(Service|PVC|Deployment|StatefulSet)$/
/** 한국어 조사(이름 바로 뒤에 붙은 가·를 등)를 떼어 남은 설명만 둔다 */
const PARTICLE = /^(?:가|이|를|을|는|은|로|으로)(?=\s)/

/**
 * 백엔드 name을 짧은 이름(title)과 설명(rest)으로 나눈다. 모르는 모양이면 title = 원문(ok=false).
 * - "Namespace cmp-app가 없으면 …" → "Namespace cmp-app" / "없으면 …"
 * - "앱 환경변수 Secret chat-app-env 생성·갱신" → "Secret chat-app-env" / "앱 환경변수", "생성·갱신"
 * - "기존 K3s <UID> · Agent a · Namespace n" → "기존 K3s <UID 8자>…" / "Agent a · Namespace n"
 * - "대상 DB 출력 연결(REPLACED, secretKeyRef)" → "대상 DB 출력 연결" / "REPLACED, secretKeyRef"
 * - "chat-app Service"·"chat-app"처럼 이미 짧은 이름은 그대로
 */
export function splitBackendName(name: string): { title: string; rest: string[]; ok: boolean } {
  const text = shortenIds(name.trim())
  if (KIND_SUFFIX.test(text) || /^[a-z0-9][a-z0-9.\-]*$/.test(text)) return { title: text, rest: [], ok: true }
  if (text.includes(' · ')) {
    const [head, ...tail] = text.split(' · ')
    return { title: head.trim(), rest: [tail.join(' · ').trim()].filter(Boolean), ok: true }
  }
  const kind = KIND_TOKEN.exec(text)
  if (kind) {
    const start = kind.index + kind[0].indexOf(kind[1])
    const prefix = text.slice(0, start).trim()
    const after = text.slice(kind.index + kind[0].length).replace(PARTICLE, '').trim()
    return { title: kind[1] + ' ' + kind[2], rest: [prefix, after].filter(Boolean), ok: true }
  }
  const paren = /^(.+?)\s*\(([^()]+)\)$/.exec(text)
  if (paren) return { title: paren[1].trim(), rest: [paren[2].trim()], ok: true }
  return { title: backendResourceTitle(text), rest: [], ok: false }
}

const NP_PREFIX = /^NetworkPolicy\s+/
const NP_DENY = /^Namespace\s+기본\s+차단/
/**
 * NetworkPolicy 한 줄(백엔드 문장)을 보안 규칙 칸의 한 줄로. 예:
 * "chat-app → chat-db TCP 5432 허용" → chat-app → chat-db · TCP 5432,
 * "chat-db 자기 점검·복제 연결 TCP 5432 허용(수신은 자신만)" → chat-db 자기 점검·복제 연결 · TCP 5432,
 * "Namespace 기본 차단(…)" → 그 외 전부 차단. 모양을 모르면 문장 전체를 출발 칸에 둔다.
 */
export function networkPolicyRule(name: string): LedgerRule {
  const full = name.replace(NP_PREFIX, '').trim()
  if (NP_DENY.test(full)) return { from: '*', to: '*', ports: '', deny: true, full }
  const match = /^(.+?)\s+((?:UDP\/TCP|TCP\/UDP|TCP|UDP|SCTP))\s+(\d+(?:-\d+)?)\s+허용/.exec(full)
  if (!match) return { from: full.replace(/\s*허용$/, ''), to: '', ports: '', deny: false, full }
  const [from, to] = match[1].split(/\s+→\s+/)
  return { from: from.trim(), to: (to ?? '').trim(), ports: match[2] + ' ' + match[3], deny: false, full }
}

/**
 * 실제 모드 표의 줄과 보안 규칙. NetworkPolicy 줄은 "NetworkPolicy N개" 한 줄로 묶고, 각 규칙은 보안 규칙 칸으로 보낸다.
 * 외부 공개가 없다는 진입 안내 줄은 "외부 진입" 줄의 보조 줄로 두고 변경 칩을 붙이지 않는다.
 */
export function realLedger(resources: PlanResource[], fallback: (resource: PlanResource) => { name: string; detail: string }): { rows: LedgerRow[]; rules: LedgerRule[] } {
  const rows: LedgerRow[] = []
  const policies = resources.filter(resource => resource.resource_type === 'NETWORK' && NP_PREFIX.test(resource.backend_name ?? ''))
  const rules = policies.map(resource => networkPolicyRule(resource.backend_name!))
  for (const resource of resources) {
    if (policies.includes(resource)) {
      if (resource !== policies[0]) continue
      const allow = rules.filter(rule => !rule.deny).length
      const deny = rules.some(rule => rule.deny)
      rows.push({
        id: resource.id, ids: policies.map(item => item.id), resource,
        title: { key: 'plan.np.title', params: { n: policies.length } },
        full: policies.map(item => item.backend_name).join('\n'),
        sub: [{ key: deny ? 'plan.np.subDeny' : 'plan.np.sub', params: { n: allow } }],
        size: '', sizeSub: '', chip: true, change: 'CREATE', defaulted: false,
      })
      continue
    }
    const name = resource.backend_name ?? ''
    // 백엔드 이름이 없는 줄(매핑에서 만든 원본 유지 줄 등)은 화면 사전 문구를 그대로 쓴다
    if (!name) {
      const own = fallback(resource)
      rows.push({ id: resource.id, ids: [resource.id], resource, title: own.name, full: own.name, sub: [own.detail], size: resource.size === '—' ? '' : resource.size, sizeSub: resource.size_detail ?? '', chip: true, change: resource.change, defaulted: !!resource.defaulted })
      continue
    }
    const { size, sizeSub, extra } = splitBackendSize(resource.size ?? '')
    const typeLabel: LedgerText = { key: 'plan.type.' + (resource.resource_type ?? '') }
    // 진입이 없다는 안내(예: "외부 공개 없음; 클러스터 내부 Service만"): 진입 줄 하나로, 칩 없이
    if (resource.resource_type === 'INGRESS' && resource.change === 'EXISTING' && /없음|\bnone\b|no (?:public|external)/i.test(name)) {
      rows.push({ id: resource.id, ids: [resource.id], resource, title: typeLabel, full: name, sub: [name, ...extra], size, sizeSub, chip: false, change: resource.change, defaulted: !!resource.defaulted })
      continue
    }
    const parsed = splitBackendName(name)
    const sub = [...parsed.rest, ...extra]
    rows.push({
      id: resource.id, ids: [resource.id], resource,
      title: parsed.title, full: name,
      sub: sub.length > 0 ? sub : [typeLabel],
      size, sizeSub, chip: true, change: resource.change, defaulted: !!resource.defaulted,
    })
  }
  return { rows, rules }
}
