'use client'

import { useT } from '../lib/i18n'
import type { BuildFixData } from '../lib/migration/events'
import { fixerEnvKeys } from '../lib/migration/planModel'

/**
 * "Fixer가 코드를 고쳐 새로 필요한 변수 N개" 안내. 값을 어떻게 받을지는 아직 정해지지 않아 중립 안내만 보인다(입력칸 없음).
 * 새 변수가 없으면 아무것도 그리지 않는다.
 */
export default function FixerEnvNotice({ fixes }: { fixes: BuildFixData[] }) {
  const t = useT()
  const keys = fixerEnvKeys(fixes)
  if (keys.length === 0) return null
  return <p className="fixer-env" role="note" data-count={keys.length}>
    <strong>{t('fixer.env.title', { n: keys.length })}</strong>
    <span>{keys.map(key => <code key={key}>{key}</code>)}</span>
    <small>{t('fixer.env.note')}</small>
  </p>
}
