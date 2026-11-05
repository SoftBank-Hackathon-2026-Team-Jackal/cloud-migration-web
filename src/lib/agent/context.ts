/**
 * 에이전트(헤이 자칼)가 "지금 무슨 단계야?", "뭐가 문제야?", "로그 읊어 줘" 같은 질문에 답할 때 쓰는 현재 상태 요약.
 * 화면이 이미 가진 이전 상태(reducer 상태)에서 만들며, 비밀값은 상태에 없으므로 담기지 않는다.
 * 순수 함수만 둔다(React·런타임 import 없음): 단위 시험과 서버(API 라우트)가 같은 코드를 쓴다.
 */
import type { MigrationState } from '../migration/reducer'

export type AgentFacts = {
  stage: string
  /** 화면 단계의 표시 이름(언어에 맞게 호출하는 쪽이 채운다) */
  stageLabel: string
  status: MigrationState['status']
  connection: MigrationState['connection']
  failures: Array<{ phase: string; code: string; message: string }>
  sandbox: { attempt: number | null; maxAttempts: number | null; failedChecks: string[]; reviewWaiting: boolean; lastResult: string | null; errorCode: string | null }
  plan: { steps: number; ready: boolean; revision: number | null; digestMismatch: boolean }
  approval: { required: boolean; cutoverRequired: boolean }
  provision: { resourcesDone: number; resourcesTotal: number; failed: string[]; checksDone: number; checksTotal: number }
  data: { step: string | null; rows: number; totalRows: number; lagMs: number | null; verifyDone: boolean }
  traffic: { phase: string | null; targetWeight: number; failedRequests: number; maxFailedRequests: number; p99Ratio: number; readyState: string | null }
  cutover: { doneSteps: number; results: number; handoverDone: number }
  /** 최근 기록(오래된 것 → 최신 순). 사람이 읽는 문장이 아니라 짧은 항목 이름이다. */
  recent: string[]
}

const RECENT_LIMIT = 8

export function buildAgentFacts(state: MigrationState, stage: string, stageLabel = stage): AgentFacts {
  const checks = Object.values(state.build.checks)
  const meta = state.plan.meta
  const digestMismatch = Boolean(meta?.built_digest && meta?.verified_digest && meta.built_digest !== meta.verified_digest)
  const resources = state.provision.resources
  const snapshot = state.traffic.snapshot

  const recent: string[] = []
  for (const fix of state.build.fixes.slice(-2)) recent.push('AI 수정 ' + fix.id + ' (' + fix.check + ')')
  if (state.build.result) recent.push('빌드 ' + state.build.result.attempt + '회차 ' + (state.build.result.status === 'SUCCEEDED' ? '성공' : '실패'))
  for (const resource of resources.slice(-2)) recent.push('리소스 ' + resource.key + ' ' + resource.state + ' ' + resource.progress + '%')
  for (const check of state.provision.checks.slice(-2)) recent.push('준비 검사 ' + check.name + ' ' + check.state)
  if (state.data.current) recent.push('데이터 ' + state.data.current.step + ' ' + state.data.current.rows + '/' + state.data.current.total_rows + '행')
  for (const verify of state.data.verify.slice(-2)) recent.push('정합성 ' + verify.name + ' ' + verify.state)
  if (state.data.preflight) recent.push('이전 경로 사전 검사 ' + state.data.preflight.status + state.data.preflight.checks.filter(check => check.code).map(check => ' ' + check.name + ':' + check.code).join(''))
  if (state.data.phase) recent.push('데이터 단계 ' + state.data.phase)
  for (const log of state.traffic.logs.slice(0, 3).reverse()) recent.push('트래픽 ' + log.key)
  if (state.traffic.ready) recent.push('전환 조건 ' + state.traffic.ready.state)
  for (const item of state.cutover.handover.slice(-2)) recent.push('운영권 인계 ' + item.item + ' ' + item.state)

  return {
    stage,
    stageLabel,
    status: state.status,
    connection: state.connection,
    failures: Object.entries(state.failures).map(([phase, failure]) => ({ phase, code: failure?.code ?? '', message: failure?.message ?? '' })),
    sandbox: {
      attempt: state.build.attempt,
      maxAttempts: state.build.result?.max_attempts ?? null,
      failedChecks: checks.filter(check => check.state === 'failed' || check.state === 'fixing').map(check => check.id),
      reviewWaiting: state.build.review !== null,
      lastResult: state.build.result?.status ?? null,
      errorCode: state.build.result?.error_code ?? null,
    },
    plan: { steps: state.plan.steps.length, ready: state.plan.ready, revision: meta?.revision ?? null, digestMismatch },
    approval: { required: state.approval.required, cutoverRequired: state.approval.cutoverRequired },
    provision: {
      resourcesDone: resources.filter(resource => resource.state === 'done').length,
      resourcesTotal: resources.length,
      failed: resources.filter(resource => resource.state === 'failed').map(resource => resource.key),
      checksDone: state.provision.checks.filter(check => check.state === 'done').length,
      checksTotal: state.provision.checks.length,
    },
    data: {
      step: state.data.current?.step ?? null,
      rows: state.data.current?.rows ?? 0,
      totalRows: state.data.current?.total_rows ?? 0,
      lagMs: state.data.current?.lag_ms ?? null,
      verifyDone: state.data.verify.some(item => item.name === 'checksum' && item.state === 'done') || (state.data.tables.length > 0 && state.data.tables.every(item => item.state === 'matched')),
    },
    traffic: {
      phase: snapshot?.phase ?? null,
      targetWeight: snapshot?.weights.target ?? 0,
      failedRequests: snapshot?.gate.failed_requests ?? 0,
      maxFailedRequests: snapshot?.gate.max_failed_requests ?? 0,
      p99Ratio: snapshot?.gate.p99_ratio ?? 1,
      readyState: state.traffic.ready?.state ?? null,
    },
    cutover: { doneSteps: state.cutover.doneSteps, results: state.cutover.results.length, handoverDone: state.cutover.handover.filter(item => item.state === 'done').length },
    recent: recent.slice(-RECENT_LIMIT),
  }
}

/** 모델에 넘기는 상태 요약 글. 사실만 적고 해석은 모델이 한다. */
export function factsToText(facts: AgentFacts): string {
  const lines: string[] = []
  lines.push('화면 단계: ' + facts.stageLabel + ' (' + facts.stage + ')')
  lines.push('이전 상태: ' + facts.status + ', 연결: ' + facts.connection)
  if (facts.failures.length > 0) lines.push('실패: ' + facts.failures.map(item => item.phase + ' ' + item.code + (item.message ? ' - ' + item.message : '')).join('; '))
  else lines.push('실패: 없음')
  const sandbox = facts.sandbox
  lines.push('샌드박스: 시도 ' + (sandbox.attempt ?? '-') + '/' + (sandbox.maxAttempts ?? '-') + ', 마지막 빌드 ' + (sandbox.lastResult ?? '-') + (sandbox.errorCode ? ' (' + sandbox.errorCode + ')' : '')
    + ', 문제 검증 항목 ' + (sandbox.failedChecks.join(', ') || '없음') + (sandbox.reviewWaiting ? ', 사람 검토 대기 중' : ''))
  lines.push('계획: 항목 ' + facts.plan.steps + '개, 완료 ' + (facts.plan.ready ? '예' : '아니오') + ', 버전 ' + (facts.plan.revision ?? '-') + (facts.plan.digestMismatch ? ', 이미지 Digest 불일치(승인 차단)' : ''))
  lines.push('승인: 계획 승인 필요 ' + (facts.approval.required ? '예' : '아니오') + ', DB 전환 승인 필요 ' + (facts.approval.cutoverRequired ? '예' : '아니오'))
  lines.push('프로비저닝: 리소스 ' + facts.provision.resourcesDone + '/' + facts.provision.resourcesTotal + ' 완료, 실패 ' + (facts.provision.failed.join(', ') || '없음') + ', 준비 검사 ' + facts.provision.checksDone + '/' + facts.provision.checksTotal)
  lines.push('데이터: 단계 ' + (facts.data.step ?? '-') + ', 행 ' + facts.data.rows + '/' + facts.data.totalRows + ', 복제 지연 ' + (facts.data.lagMs ?? '-') + 'ms, 정합성 확인 ' + (facts.data.verifyDone ? '완료' : '미완료'))
  lines.push('트래픽: 단계 ' + (facts.traffic.phase ?? '-') + ', 대상 가중치 ' + facts.traffic.targetWeight + '%, 실패 요청 ' + facts.traffic.failedRequests + '(허용 ' + facts.traffic.maxFailedRequests + '), p99 ' + facts.traffic.p99Ratio + '배, 전환 조건 ' + (facts.traffic.readyState ?? '-'))
  lines.push('전환·검증: ' + facts.cutover.doneSteps + '/6 단계, 측정 결과 ' + facts.cutover.results + '/3, 운영권 인계 ' + facts.cutover.handoverDone + '/3')
  lines.push('최근 기록: ' + (facts.recent.join(' → ') || '없음'))
  return lines.join('\n')
}
