'use client'

import PhaseStrip, { STRIP_GATE } from './PhaseStrip'
import { useMigration } from '../lib/migration/MigrationProvider'

/**
 * 단계 띠를 스스로 그리는 래퍼: 지금 단계(stage)만 받고, 위치·게이트는 reducer 상태에서 읽는다.
 * 다른 화면은 import 한 줄과 <MigrationLanes stage="…" /> 한 줄만 넣으면 된다. 문구는 PhaseStrip의 strip.* 키.
 *  traffic  게이트 1과 2 사이: 대상 비율(traffic.snapshot.weights.target)만큼, 잔여 요청 0이면 게이트 2 통과
 *  cutover  게이트 1 자리: 전환이 통과하면(cutover.outcome switched) 게이트 1 통과
 * 순서는 데이터 → DB 전환 → 트래픽(백엔드 Workflow와 같다): DB 전환은 게이트 1 자리(PgBouncer 전환)에서 일어나므로
 * 전환 화면은 게이트 1에 머물고(앱 트래픽은 아직 원본), 트래픽 화면은 그 뒤 게이트 2까지 간다.
 */
export default function MigrationLanes({ stage, className = 'flow-strip' }: { stage: 'traffic' | 'cutover'; className?: string }) {
  const { state } = useMigration()
  if (stage === 'traffic') {
    const snapshot = state.traffic.snapshot
    const weight = snapshot?.weights.target ?? 0
    const drained = snapshot?.phase === 'complete' && snapshot.residual.requests_per_sec === 0 && snapshot.residual.streams === 0
    const position = STRIP_GATE.synced + (weight / 100) * (STRIP_GATE.switchover - STRIP_GATE.synced)
    return <div className={className}><PhaseStrip compact position={position} gates={['pass', 'pass', drained ? 'pass' : 'wait']} /></div>
  }
  // DB 전환 화면: 게이트 1(PgBouncer 전환) 자리. 전환이 통과하면 게이트 1을 지나고, 앱 트래픽은 아직 원본이다.
  const switched = state.cutover.outcome?.result === 'switched'
  return <div className={className}><PhaseStrip compact position={STRIP_GATE.synced} gates={['pass', switched ? 'pass' : 'wait', 'wait']} /></div>
}
