'use client'

import { useT, type MsgKey } from '../lib/i18n'
import { STAGE_ORDER, type Stage, type Target } from '../lib/stages'

type Props = {
  stage: Stage
  target: Target
  onJump: (stage: Stage) => void
  onTarget: (target: Target) => void
}

/** 발표·시연용 조작판. 주소에 ?demo=1 을 붙이거나 키보드 D 로 켜고 끈다. */
export default function DemoControls({ stage, target, onJump, onTarget }: Props) {
  const t = useT()
  const index = STAGE_ORDER.indexOf(stage)
  return <div className="demo-controls" role="group" aria-label={t('demo.aria')}>
    <strong>DEMO</strong>
    <button type="button" onClick={() => onJump(STAGE_ORDER[Math.max(0, index - 1)])} aria-label={t('demo.prev')}>◀</button>
    <select value={stage} onChange={event => onJump(event.target.value as Stage)} aria-label={t('demo.jump')}>
      {STAGE_ORDER.map(item => <option key={item} value={item}>{t(('stage.' + item) as MsgKey)}</option>)}
    </select>
    <button type="button" onClick={() => onJump(STAGE_ORDER[Math.min(STAGE_ORDER.length - 1, index + 1)])} aria-label={t('demo.next')}>▶</button>
    <select value={target} onChange={event => onTarget(event.target.value as Target)} aria-label={t('demo.target')}>
      <option value="gcp">GCP</option>
      <option value="onprem">{t('target.onprem.short')}</option>
    </select>
  </div>
}
