/**
 * 레드팀(샌드박스 능동 공격 검증) 목업 대본. 백엔드에는 아직 화면용 이벤트가 없어서([가정]) 이 모양으로 먼저 만들었다.
 * 실제 연결 후에는 워크플로 Query `redteam_state`와 실행 결과 `redteam`이 같은 모양의 `sandbox.redteam` 이벤트로 온다.
 * 흐름: 승인 대기 → (승인) 공격 중 → 약점 발견 → 보안 수정 → 다시 확인 → 끝. 거절하면 바로 건너뜀으로 끝난다.
 * 약점은 지어낸 예시이고 목업 모드에서만 나온다(?redteam=1).
 */
import type { DraftEvent, RedTeamData, RedTeamFinding, RedTeamRequest } from './events.ts'

export type RedTeamScenario = 'fix' | 'clean' | 'open'
export type TimedRedTeamDraft = { after: number; event: DraftEvent }

export const REDTEAM_MAX_ROUNDS = 3

export const REDTEAM_REQUEST: RedTeamRequest = {
  target: 'cmp-sbx-7f3a91',
  scope: 'this Sandbox copy of the application only',
  intensity: 'ACTIVE',
  time_budget_seconds: 300,
  test_data_is_reset_afterwards: true,
  outside_calls_are_cut_meanwhile: true,
  wait_seconds: 600,
}

const XSS: RedTeamFinding = {
  id: 'xss_stored-3fa91c20be', category: 'XSS_STORED', severity: 'MEDIUM', endpoint: 'POST /api/messages', state: 'OPEN',
  summary: '메시지 본문에 넣은 스크립트가 걸러지지 않고 그대로 저장됩니다.',
  repro_summary: '본문에 <script> 태그가 든 메시지를 보내면 저장된 값에도 같은 태그가 남습니다.',
}
const RATE: RedTeamFinding = {
  id: 'rate_limit_missing-91c0d4e7a2', category: 'RATE_LIMIT_MISSING', severity: 'LOW', endpoint: 'POST /api/messages', state: 'OPEN',
  summary: '요청 횟수 제한이 없어 짧은 시간에 메시지를 수백 건 저장할 수 있습니다.',
  repro_summary: '같은 이름으로 1초 안에 50건을 보내도 모두 저장됩니다.',
}
const STATS: RedTeamFinding = {
  id: 'info_exposure-5be27d10c8', category: 'INFO_EXPOSURE', severity: 'LOW', endpoint: 'GET /api/stats', state: 'OPEN',
  summary: '내부 처리 통계(앱 환경·DB 노드별 건수)가 로그인 없이 보입니다.',
  repro_summary: '로그인 없이 호출해도 환경별·DB별 메시지 건수가 그대로 돌아옵니다.',
}

const base = (extra: Partial<RedTeamData>): RedTeamData => ({
  phase: 'RUNNING', request: REDTEAM_REQUEST, round: 0, max_rounds: REDTEAM_MAX_ROUNDS, findings: [], status: null, code: null, withheld: 0, ...extra,
})

const draft = (data: RedTeamData): DraftEvent => ({
  type: 'sandbox.redteam', phase: 'build', status: data.phase === 'DONE' ? 'done' : data.phase === 'WAITING_FOR_APPROVAL' ? 'waiting' : 'running', data,
})

/** 테스트가 통과한 샌드박스에서 공격 전에 사람의 승인을 기다린다. */
export function redteamWaiting(): DraftEvent {
  return draft(base({ phase: 'WAITING_FOR_APPROVAL' }))
}

/** 거절(건너뛰기): 공격하지 않고 사유를 남기고 끝낸다. 샌드박스는 그대로 통과로 끝난다. */
export function redteamDeclined(): TimedRedTeamDraft[] {
  return [{ after: 0, event: draft(base({ phase: 'DONE', status: 'SKIPPED', code: 'REDTEAM_DECLINED' })) }]
}

/** 승인 뒤: 공격 중 → 약점 발견 → 보안 수정 → 다시 확인. 시각은 승인한 순간부터의 밀리초. */
export function redteamRun(scenario: RedTeamScenario): TimedRedTeamDraft[] {
  const open = (items: RedTeamFinding[]) => items.map(item => ({ ...item, state: 'OPEN' as const }))
  const fixed = (items: RedTeamFinding[]) => items.map(item => ({ ...item, state: 'FIXED' as const }))
  const all = [XSS, RATE, STATS]
  if (scenario === 'clean') {
    return [
      { after: 0, event: draft(base({ phase: 'RUNNING' })) },
      { after: 3500, event: draft(base({ phase: 'DONE', status: 'CLEAN' })) },
    ]
  }
  const found: TimedRedTeamDraft[] = [
    { after: 0, event: draft(base({ phase: 'RUNNING' })) },
    { after: 1800, event: draft(base({ phase: 'RUNNING', findings: open([XSS]) })) },
    { after: 3200, event: draft(base({ phase: 'RUNNING', findings: open(all) })) },
    { after: 4800, event: draft(base({ phase: 'FIXING', round: 1, findings: open(all) })) },
  ]
  if (scenario === 'open') {
    // 보안 수정을 끝까지 해도 하나가 남는다: 표시와 기록만 하고 이전은 막지 않는다(ADR-008 R3).
    const rest = [{ ...RATE, state: 'STILL_OPEN' as const }]
    return [
      ...found,
      { after: 7600, event: draft(base({ phase: 'FIXING', round: 2, findings: [...fixed([XSS, STATS]), ...open([RATE])] })) },
      { after: 10200, event: draft(base({ phase: 'FIXING', round: 3, findings: [...fixed([XSS, STATS]), ...open([RATE])] })) },
      { after: 12800, event: draft(base({ phase: 'DONE', round: 3, findings: [...fixed([XSS, STATS]), ...rest], status: 'STILL_OPEN' })) },
    ]
  }
  return [
    ...found,
    { after: 7600, event: draft(base({ phase: 'FIXING', round: 2, findings: [...fixed([XSS, STATS]), ...open([RATE])] })) },
    { after: 10200, event: draft(base({ phase: 'DONE', round: 2, findings: fixed(all), status: 'FIXED' })) },
  ]
}

/** 마지막 이벤트가 나온 뒤 샌드박스 완료(정리)를 내보내기까지 기다리는 시간(밀리초) */
export const REDTEAM_TAIL_GAP_MS = 900
