/**
 * 데이터 이전 단계 대본 [가정: 이벤트 이름·필드는 백엔드와 미정].
 * Finals 리허설(poc/demo · poc/cdc)의 순서를 따른다:
 *   Migration Network Preflight(CIDR 충돌 → 경로 조회 → DB 연결 사슬 → 대량 전송 → 판정·입력 지문)
 *   → PASS일 때만 스키마 덤프(pg_dump --schema-only + mig.marker) → 테이블별 초기 복사 → CDC 따라잡기 → 지연≈0 스트리밍.
 * 브라우저 MockProvider와 목업 SSE 서버(scripts/mock-sse-server.mjs)가 함께 쓴다.
 * Node가 그대로 읽으므로 런타임 import가 없고 타입 문법만 쓴다. 값은 어느 앱에나 맞는 예시다(문구는 화면이 고른다).
 */
import type {
  DataLsnData, DataPhase, DataPreflightData, DataProgressData, DataReadinessData, DataTableData, DraftEvent,
  PreflightCheck, PreflightNetwork, Target,
} from './events'

export type PreflightScenario = 'pass' | 'route' | 'unknown'
export type DataTimed = { after: number; event: DraftEvent }

// ---- 시각(ms, 단계 화면이 준비된 순간부터) ----
const CIDR_DONE = 1200
const ROUTE_DONE = 2600
const DB_STEP_MS = 500
const XFER_START = 5100
const PASS_AT = 7000
export const DATA_SCHEMA_AT = 7200
export const DATA_COPY_AT = 8800
export const DATA_CATCHUP_AT = 13000
export const DATA_STREAM_AT = 18500
/** 게이트 1: 지연≈0 · 긴 트랜잭션·잠금 없음 → 트래픽 이전 가능 */
export const DATA_READY_AT = 21000
/** 대본의 마지막 이벤트(목업 서버가 다음 단계로 넘어가기 전까지 흘려 보내는 시간) */
export const DATA_END_MS = DATA_READY_AT + 2000
export const DATA_LSN_TICK_MS = 250

const XFER_TOTAL = 4 * 1024 * 1024
const XFER_ELAPSED_MS = 1840

// ---- 이전 경로(대상별 예시 값) ----
const NETWORK: Record<Target, PreflightNetwork> = {
  onprem: {
    source_cidr: '10.0.0.0/16', target_cidr: '192.168.0.0/16',
    path: { kind: 'wireguard', name: 'wg0', cidr: '10.8.0.0/24' },
    source_db: 'pg-a.prod.internal:5432', source_addr: '10.0.12.34',
    replication_node: 'k3s-node-2', target_db: 'pg-b', target_db_detail: 'StatefulSet · PVC 10Gi',
  },
  gcp: {
    source_cidr: '10.0.0.0/16', target_cidr: '10.20.0.0/20',
    path: { kind: 'cloud_vpn', name: 'vpn-aws-1', cidr: '169.254.21.0/30' },
    source_db: 'pg-a.prod.internal:5432', source_addr: '10.0.12.34',
    replication_node: 'gke-node-1', target_db: 'pg-b', target_db_detail: 'Cloud SQL · 20 GiB SSD',
  },
}
const ROUTE_EVIDENCE: Record<Target, { pass: string; fail: string }> = {
  onprem: { pass: 'dev wg0 src 10.8.0.2', fail: 'dev eth0 via 192.168.0.1 src 192.168.3.12' },
  gcp: { pass: 'next hop vpn-aws-1 src 10.20.0.12', fail: 'next hop default-internet-gateway src 10.20.0.12' },
}
const FINGERPRINT: Record<Target, string> = { onprem: 'sha256:9c1e4b07d25a6f31', gcp: 'sha256:5e2a7c1904b8d3e6' }

export function dataNetworkFor(target: Target): PreflightNetwork {
  return NETWORK[target === 'onprem' ? 'onprem' : 'gcp']
}

/** 복사할 테이블(예시). mig.marker는 스키마 덤프 때 만드는 전환 표식 테이블이다. */
export const DATA_TABLES: Array<[string, number]> = [
  ['order_items', 142310], ['events', 128400], ['orders', 55660], ['products', 4200], ['users', 3100], ['mig.marker', 1],
]

const iso = (startedAt: number, ms: number) => new Date(startedAt + ms).toISOString()

/** 사전 검사 결과가 나오는 시각(시나리오별). 판정이 끝나는 시각도 돌려준다. */
function preflightDoneAt(scenario: PreflightScenario) {
  return scenario === 'route' ? ROUTE_DONE : scenario === 'unknown' ? XFER_START - DB_STEP_MS : PASS_AT
}

/** ms 시점의 run_network_preflight 결과 전체 */
export function preflightAt(ms: number, target: Target, scenario: PreflightScenario, startedAt: number): DataPreflightData {
  const key = target === 'onprem' ? 'onprem' : 'gcp'
  const network = NETWORK[key]
  const probe = network.replication_node + ' · ns migration'
  const at = (t: number) => iso(startedAt, t)

  const cidr: PreflightCheck = ms < CIDR_DONE
    ? { name: 'cidr_overlap', status: 'RUNNING', code: null, evidence: '' }
    : { name: 'cidr_overlap', status: 'PASS', code: null, evidence: [network.source_cidr, network.target_cidr, network.path.cidr].filter(Boolean).join(' · '), checked_at: at(CIDR_DONE) }

  const routeFail = scenario === 'route'
  const route: PreflightCheck = ms < CIDR_DONE ? { name: 'route', status: 'PENDING', code: null, evidence: '' }
    : ms < ROUTE_DONE ? { name: 'route', status: 'RUNNING', code: null, evidence: '', tested_endpoint: network.source_addr }
    : { name: 'route', status: routeFail ? 'FAIL' : 'PASS', code: routeFail ? 'ROUTE_NOT_TUNNEL' : null, evidence: ROUTE_EVIDENCE[key][routeFail ? 'fail' : 'pass'], tested_endpoint: network.source_addr, checked_at: at(ROUTE_DONE) }

  // DB 연결 사슬: 0.5초마다 한 단계. 확인 불가 시나리오는 TLS에서 인증서 체인을 확인하지 못한다.
  const names = ['DNS', 'TCP', 'TLS', 'AUTH', 'QUERY'] as const
  const unknown = scenario === 'unknown'
  const steps = names.map((name, index) => {
    const doneAt = ROUTE_DONE + (index + 1) * DB_STEP_MS
    if (unknown && index > 2) return { name, status: 'PENDING' as const }
    if (ms < doneAt) return { name, status: 'PENDING' as const }
    return { name, status: unknown && index === 2 ? 'UNKNOWN' as const : 'PASS' as const }
  })
  const dbEndpoint = { tested_endpoint: network.source_db }
  const dbEvidence = network.source_db + ' · sslmode=verify-full · secretRef'
  const dbDone = unknown ? XFER_START - DB_STEP_MS : XFER_START
  const db: PreflightCheck = routeFail && ms >= ROUTE_DONE ? { name: 'db_path', status: 'SKIPPED', code: null, evidence: '' }
    : ms < ROUTE_DONE ? { name: 'db_path', status: 'PENDING', code: null, evidence: '', steps: names.map(name => ({ name, status: 'PENDING' as const })) }
    : ms < dbDone ? { name: 'db_path', status: 'RUNNING', code: null, evidence: unknown && ms >= ROUTE_DONE + 3 * DB_STEP_MS ? 'x509: certificate signed by unknown authority' : dbEvidence, steps, ...dbEndpoint }
    : unknown ? { name: 'db_path', status: 'UNKNOWN', code: 'TLS_FAILED', evidence: 'x509: certificate signed by unknown authority', steps, checked_at: at(dbDone), ...dbEndpoint }
    : { name: 'db_path', status: 'PASS', code: null, evidence: dbEvidence, steps, checked_at: at(dbDone), ...dbEndpoint }

  const xferBase = { bytes_total: XFER_TOTAL, mtu: 'NOT_ATTEMPTED' as const, tested_endpoint: network.source_db }
  const xfer: PreflightCheck = (routeFail && ms >= ROUTE_DONE) || (unknown && ms >= dbDone) ? { name: 'large_transfer', status: 'SKIPPED', code: null, evidence: '' }
    : ms < XFER_START ? { name: 'large_transfer', status: 'PENDING', code: null, evidence: '', bytes_done: 0, ...xferBase }
    : ms < PASS_AT ? { name: 'large_transfer', status: 'RUNNING', code: null, evidence: '', bytes_done: Math.round(Math.min(1, (ms - XFER_START) / (PASS_AT - XFER_START)) * XFER_TOTAL), ...xferBase }
    : { name: 'large_transfer', status: 'PASS', code: null, evidence: '', bytes_done: XFER_TOTAL, elapsed_ms: XFER_ELAPSED_MS, checked_at: at(PASS_AT), ...xferBase }

  const doneAt = preflightDoneAt(scenario)
  const done = ms >= doneAt
  const status: DataPreflightData['status'] = !done ? 'RUNNING' : scenario === 'route' ? 'FAIL' : scenario === 'unknown' ? 'UNKNOWN' : 'PASS'
  return {
    status,
    checks: [cidr, route, db, xfer],
    probe_location: probe,
    input_fingerprint: FINGERPRINT[key],
    checked_at: done ? at(doneAt) : null,
    may_start: status === 'PASS',
    network,
  }
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value))
/** 초기 복사 진행(0~1) */
const copyFraction = (ms: number) => clamp01((ms - DATA_COPY_AT) / (DATA_CATCHUP_AT - DATA_COPY_AT))

function tableAt(ms: number, index: number): DataTableData {
  const [name, total] = DATA_TABLES[index]
  if (ms >= DATA_READY_AT) return { name, rows_copied: total, rows_total: total, state: 'matched' }
  if (ms >= DATA_CATCHUP_AT) return { name, rows_copied: total, rows_total: total, state: 'copied' }
  const share = clamp01(copyFraction(ms) * 1.3 - index * 0.06)
  if (ms < DATA_COPY_AT || share === 0) return { name, rows_copied: 0, rows_total: total, state: 'waiting' }
  return { name, rows_copied: Math.round(share * total), rows_total: total, state: share >= 1 ? 'copied' : 'copying' }
}

function readinessAt(ms: number): DataReadinessData {
  const wobble = Math.round(Math.sin(ms / 700) * 4)
  if (ms >= DATA_READY_AT) return { longest_tx_ms: 40, lock_waits: 0, commits_per_sec: 124 + wobble, ready: true }
  const k = clamp01((ms - DATA_CATCHUP_AT) / (DATA_READY_AT - DATA_CATCHUP_AT))
  return { longest_tx_ms: Math.round(1800 - k * 1500), lock_waits: k < 0.5 ? 2 : k < 0.85 ? 1 : 0, commits_per_sec: 124 + wobble, ready: false }
}

/**
 * 이산 이벤트 대본: 사전 검사 결과(바뀔 때마다 전체) · 단계 전환 · 테이블 복사 · 전환 가능 시점(1초마다).
 * 사전 검사가 PASS가 아니면 시작 차단(blocked)에서 멈춘다(초기 복사·CDC를 시작하지 않는다).
 */
export function dataTimeline(target: Target, scenario: PreflightScenario = 'pass', startedAt = Date.now()): DataTimed[] {
  const items: DataTimed[] = []
  const phase = (after: number, value: DataPhase) => items.push({ after, event: { type: 'data.phase', phase: 'data_copy', status: value === 'blocked' ? 'waiting' : 'running', data: { phase: value } } })
  phase(0, 'preflight')
  const doneAt = preflightDoneAt(scenario)
  const marks = new Set<number>([0, CIDR_DONE, ROUTE_DONE, doneAt])
  for (let index = 1; index <= 5; index++) if (ROUTE_DONE + index * DB_STEP_MS <= doneAt) marks.add(ROUTE_DONE + index * DB_STEP_MS)
  if (scenario === 'pass') for (let t = XFER_START; t <= PASS_AT; t += 250) marks.add(t)
  if (scenario === 'unknown') marks.add(ROUTE_DONE + 3 * DB_STEP_MS)
  for (const after of [...marks].filter(t => t <= doneAt).sort((a, b) => a - b)) {
    const data = preflightAt(after, target, scenario, startedAt)
    items.push({ after, event: { type: 'data.preflight', phase: 'data_copy', status: data.status === 'RUNNING' || data.status === 'PASS' ? 'running' : 'waiting', data } })
  }
  if (scenario !== 'pass') {
    // 시작 차단: 다음 단계로 넘어가지 않는다. 같은 입력의 이전 PASS가 있어도 재사용하지 않는다.
    phase(doneAt + 150, 'blocked')
    return items
  }
  phase(DATA_SCHEMA_AT, 'schema')
  for (let index = 0; index < DATA_TABLES.length; index++) items.push({ after: DATA_SCHEMA_AT + 300 + index * 120, event: { type: 'data.table', phase: 'data_copy', status: 'running', data: tableAt(DATA_SCHEMA_AT, index) } })
  phase(DATA_COPY_AT, 'copy')
  // 테이블 복사 진행: 0.4초마다 바뀐 테이블만
  const last = DATA_TABLES.map((_, index) => JSON.stringify(tableAt(DATA_SCHEMA_AT, index)))
  const copyTicks: number[] = []
  for (let t = DATA_COPY_AT + 400; t < DATA_CATCHUP_AT; t += 400) copyTicks.push(t)
  copyTicks.push(DATA_CATCHUP_AT)
  for (const t of copyTicks) {
    DATA_TABLES.forEach((_, index) => {
      const data = tableAt(t, index)
      const key = JSON.stringify(data)
      if (key === last[index]) return
      last[index] = key
      items.push({ after: t, event: { type: 'data.table', phase: 'data_copy', status: 'running', data } })
    })
  }
  phase(DATA_CATCHUP_AT, 'catchup')
  for (let t = DATA_CATCHUP_AT; t <= DATA_END_MS; t += 1000) items.push({ after: t, event: { type: 'data.readiness', phase: 'data_copy', status: 'running', data: readinessAt(t) } })
  phase(DATA_STREAM_AT, 'streaming')
  // 게이트 1: 원본과 행 수 일치(체크섬은 전환 때) · 전환 가능
  DATA_TABLES.forEach((_, index) => items.push({ after: DATA_READY_AT, event: { type: 'data.table', phase: 'data_copy', status: 'running', data: tableAt(DATA_READY_AT, index) } }))
  items.push({ after: DATA_READY_AT, event: { type: 'data.readiness', phase: 'data_copy', status: 'done', data: readinessAt(DATA_READY_AT) } })
  return items.sort((a, b) => a.after - b.after)
}

// ---- 연속 값(250ms마다): WAL 위치와 지연, 예전 화면용 진행 값 ----

const WAL_BASE = 0x3A1F2C8
const WAL_BYTES_PER_SEC = 52000
const BYTES_PER_LAG_MS = 1200
const lsnText = (bytes: number) => '0/' + Math.max(0, Math.floor(bytes)).toString(16).toUpperCase()

/** 복제 지연(ms). 초기 복사 중에는 쌓이고, 따라잡기에서 줄고, 스트리밍에서 0이 된다. */
export function dataLagAt(ms: number): number | null {
  if (ms < DATA_COPY_AT) return null
  if (ms < DATA_CATCHUP_AT) return Math.round(3400 * clamp01((ms - DATA_COPY_AT) / 1500) + Math.sin(ms / 400) * 40)
  if (ms < DATA_STREAM_AT) return Math.round(3400 * Math.pow(1 - (ms - DATA_CATCHUP_AT) / (DATA_STREAM_AT - DATA_CATCHUP_AT), 2.2) + 30 + Math.sin(ms / 300) * 12)
  return Math.max(0, Math.round(30 - (ms - DATA_STREAM_AT) / 1000 * 15))
}

/** ms 시점의 원본 쓰기 위치 · 대상 재생 위치 · 지연. 사전 검사가 통과하지 않았거나 스키마 전이면 null. */
export function dataLsnAt(ms: number, scenario: PreflightScenario = 'pass'): DataLsnData | null {
  if (scenario !== 'pass' || ms < DATA_SCHEMA_AT) return null
  const source = WAL_BASE + (ms - DATA_SCHEMA_AT) / 1000 * WAL_BYTES_PER_SEC
  const lag = dataLagAt(ms)
  const lagBytes = lag === null ? 0 : lag * BYTES_PER_LAG_MS
  return { source_lsn: lsnText(source), target_lsn: lag === null ? null : lsnText(source - lagBytes), lag_bytes: Math.round(lagBytes), lag_ms: lag }
}

/** 예전 화면·에이전트 문맥이 읽는 data.progress 값(같은 대본에서 계산). */
export function dataProgressFor(ms: number, scenario: PreflightScenario = 'pass'): DataProgressData {
  const total = DATA_TABLES.reduce((sum, [, rows]) => sum + rows, 0)
  const rows = DATA_TABLES.reduce((sum, _, index) => sum + tableAt(scenario === 'pass' ? ms : 0, index).rows_copied, 0)
  const lag = scenario === 'pass' ? dataLagAt(ms) : null
  const step = scenario !== 'pass' || ms < DATA_SCHEMA_AT ? 'connect' : ms < DATA_CATCHUP_AT ? 'dump' : ms < DATA_READY_AT ? 'cdc' : 'ready'
  return { step, rows, total_rows: total, lag_ms: lag, writes_per_sec: readinessAt(ms).commits_per_sec, dump_percent: Math.round((scenario === 'pass' ? copyFraction(ms) : 0) * 100) }
}

/** 250ms 틱마다 보낼 연속 이벤트 */
export function dataTickAt(ms: number, scenario: PreflightScenario = 'pass'): DraftEvent[] {
  const events: DraftEvent[] = []
  const lsn = dataLsnAt(ms, scenario)
  if (lsn) events.push({ type: 'data.lsn', phase: 'data_copy', status: 'running', data: lsn })
  const progress = dataProgressFor(ms, scenario)
  events.push({ type: 'data.progress', phase: 'data_copy', status: progress.step === 'ready' ? 'done' : 'running', data: progress })
  return events
}
