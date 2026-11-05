/**
 * 플랫폼에 등록된 환경(원본 AWS 계정, 대상 클라우드, 온프레미스 에이전트).
 * 백엔드 문서: 사용자 엔티티가 없고(P0에 공개 가입 없음) 이 값들은 운영자가 플랫폼에 등록한다. 화면은 읽기만 한다.
 *
 * [가정] 이 응답 형태와 GET {apiBase}/environments 주소는 백엔드에 아직 없다. 목업 모드는 아래 MOCK_ENVIRONMENTS를 쓰고,
 * 백엔드가 같은 형태로 돌려주면 그대로 바꿔 끼운다. 이 파일은 단위 테스트가 직접 읽으므로 런타임 import를 두지 않는다.
 */
export type AgentStatus = 'online' | 'offline'

export type RegisteredEnvironments = {
  source: {
    provider: 'AWS'
    account_id: string
    region: string
    cluster: { kind: 'EKS'; name: string }
  }
  targets: {
    onprem: { agent_id: string; status: AgentStatus; last_heartbeat_at: string; profile: string; distribution: 'K3s' }
    gcp: { project_id: string; region: string; profile: string; cluster: { kind: 'GKE'; name: string } }
  }
}

/** [가정] 시연용 등록 정보. 하트비트는 "방금"처럼 보이도록 불러온 시각 기준으로 만든다. */
export function mockEnvironments(now = Date.now()): RegisteredEnvironments {
  return {
    source: { provider: 'AWS', account_id: '123456789012', region: 'ap-northeast-2', cluster: { kind: 'EKS', name: 'chat-prod' } },
    targets: {
      onprem: { agent_id: 'office-seoul-01', status: 'online', last_heartbeat_at: new Date(now - 6000).toISOString(), profile: 'onprem-k3s-basic', distribution: 'K3s' },
      gcp: { project_id: 'jackal-demo', region: 'asia-northeast3', profile: 'gcp-vm-basic', cluster: { kind: 'GKE', name: 'chat-target' } },
    },
  }
}

function isEnvironments(value: unknown): value is RegisteredEnvironments {
  const data = value as RegisteredEnvironments | null
  return Boolean(data?.source?.account_id && data.source.region && data.targets?.onprem?.agent_id && data.targets?.gcp?.region)
}

/**
 * 목업 모드는 MOCK, SSE 모드는 백엔드에 묻는다. 백엔드가 아직 주지 못하면 null(화면은 "등록 정보를 불러오지 못했어요").
 * SSE 모드에서 목업 값을 "연결됨"으로 보이면 사실이 아니므로 대신 넣지 않는다.
 */
export async function loadEnvironments(mode: 'mock' | 'sse', apiBase: string, signal?: AbortSignal): Promise<RegisteredEnvironments | null> {
  if (mode === 'mock') return mockEnvironments()
  try {
    const response = await fetch(apiBase + '/environments', { signal, cache: 'no-store' })
    if (!response.ok) return null
    const body = await response.json() as unknown
    return isEnvironments(body) ? body : null
  } catch {
    return null
  }
}

/** 마지막 하트비트가 몇 초 전인지 */
export function secondsSince(iso: string, now = Date.now()): number {
  const at = Date.parse(iso)
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : 0
}
