/**
 * 실제 모드 구축 화면의 연출 순서. 온프렘 Agent는 작업 하나에 결과 하나만 돌려주므로
 * 서버는 리소스를 한꺼번에 running으로, 15초쯤 뒤 한꺼번에 done으로 보낸다(백엔드 OnPremRolloutEvents).
 * 그대로 그리면 블록이 모두 같은 순간에 생기고 같은 순간에 완성된다. 그래서 화면이 순서를 매긴다:
 * - 등장: 받은 순서대로 REVEAL_GAP_MS 간격으로 하나씩(revealed 개까지만 보인다).
 * - 완성: 앞 블록이 다 완성(settled)된 뒤에야 다음 블록의 done을 받아들인다(그 전에는 running으로 보인다).
 * - 검사: 모든 블록이 완성된 뒤 CHECK_GAP_MS 간격으로 하나씩.
 * 목업은 대본이 이미 간격을 두고 보내므로 쓰지 않는다(화면이 바뀌지 않게).
 */
export const REVEAL_FIRST_MS = 300
export const REVEAL_GAP_MS = 700
export const CHECK_GAP_MS = 500

type Item = { id: string; state: 'running' | 'done' | 'failed' }

/** 보일 리소스와 화면에 쓸 상태. 실패는 그대로 보인다(숨기지 않는다). */
export function stagedResources<T extends Item>(items: T[], revealed: number, settled: ReadonlySet<string>): T[] {
  const visible = items.slice(0, Math.max(0, revealed))
  return visible.map((item, index) => {
    if (item.state !== 'done') return item
    const before = visible.slice(0, index).every(prev => prev.state === 'failed' || settled.has(prev.id))
    return before ? item : { ...item, state: 'running' as const }
  })
}

/** 다음 등장까지 기다릴 시간(더 보일 것이 없으면 null) */
export function nextRevealDelay(revealed: number, total: number): number | null {
  if (revealed >= total) return null
  return revealed === 0 ? REVEAL_FIRST_MS : REVEAL_GAP_MS
}

/** 완성된(또는 실패한) 블록 비율로 본 진행률(0~100) */
export function stagedProgress(items: Item[], settled: ReadonlySet<string>): number {
  if (items.length === 0) return 0
  const finished = items.filter(item => item.state === 'failed' || (item.state === 'done' && settled.has(item.id))).length
  return Math.round((100 * finished) / items.length)
}
