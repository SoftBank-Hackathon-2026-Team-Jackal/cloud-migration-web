'use client'

import StageShell from './StageShell'
import MigrationReport from './MigrationReport'
import { ArriveMorph } from './ScreenFx'
import { useT } from '../lib/i18n'
import type { Target } from '../lib/stages'

/** 완료 리포트: 백엔드 순서의 마지막(데이터 복제 → DB 전환 → 트래픽 전환 → 완료). 제목은 리포트 안에 있으므로 머리글은 숨긴다. */
export default function ReportStage({ target, onRestart }: { target: Target; onRestart: () => void }) {
  const t = useT()
  return <StageShell kicker="MIGRATION REPORT" title={t('stage.report')} subtitle="" className="cx-stage" hideHeader>
    {() => <><MigrationReport target={target} onRestart={onRestart} /><ArriveMorph key="report" /></>}
  </StageShell>
}
