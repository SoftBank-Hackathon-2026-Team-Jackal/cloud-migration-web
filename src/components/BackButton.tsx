'use client'

import { useT } from '../lib/i18n'

/** 아직 실제 환경을 바꾸기 전(입력~승인) 단계에서만 보이는 작은 "이전" 버튼. */
export default function BackButton({ onBack }: { onBack: () => void }) {
  const t = useT()
  return <button type="button" className="back-btn" onClick={onBack} aria-label={t('nav.backAria')}>
    <span aria-hidden="true">←</span> {t('nav.back')}
  </button>
}
