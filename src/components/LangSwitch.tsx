'use client'

import { LANGS, useI18n } from '../lib/i18n'

/** 화면 오른쪽 위의 언어 선택(한국어 · English · 日本語). 고른 언어는 브라우저에 기억한다. */
export default function LangSwitch() {
  const { lang, setLang, t } = useI18n()
  return <div className="lang-switch" role="group" aria-label={t('lang.aria')}>
    {LANGS.map(item => <button key={item.id} type="button" lang={item.id}
      className={item.id === lang ? 'is-active' : ''} aria-pressed={item.id === lang}
      onClick={() => setLang(item.id)}>{item.label}</button>)}
  </div>
}
