'use client'

import PhaseStrip, { STRIP_GATE } from './PhaseStrip'
import { useMigration } from '../lib/migration/MigrationProvider'

/**
 * 단계 띠를 스스로 그리는 래퍼: 지금 단계(stage)만 받고, 위치·게이트는 reducer 상태에서 읽는다.
 * 다른 화면은 import 한 줄과 <MigrationLanes stage="…" /> 한 줄만 넣으면 된다. 문구는 PhaseStrip의 strip.* 키.
 *  traffic  게이트 1과 2 사이: 대상 비율(traffic.snapshot.weights.target)만큼, 잔여 요청 0이면 게이트 2 통과
 *  cutover  게이트 2 뒤: 전환 결과·테이블 검증·인계(cutover.outcome · tables · handover)만큼
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
  // 게이트 2 뒤: 전환 통과(1/3) → 테이블 검증(2/3) → 인계(3/3)만큼 끝까지. 전환이 거부되면 게이트 2에 머문다.
  const cutover = state.cutover
  const switched = cutover.outcome?.result === 'switched'
  const verified = cutover.tables.length > 0 && cutover.tables.every(table => table.checksum === 'match') ? 1 : 0
  const handed = cutover.handover.length > 0 ? cutover.handover.filter(item => item.state === 'done').length / cutover.handover.length : 0
  const fraction = switched ? (1 + verified + handed) / 3 : 0
  const position = STRIP_GATE.switchover + fraction * (100 - STRIP_GATE.switchover)
  return <div className={className}><PhaseStrip compact position={position} gates={['pass', 'pass', 'pass']} /></div>
}
