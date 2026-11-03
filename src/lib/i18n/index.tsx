'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ko, type MsgKey } from './ko'
import { en } from './en'
import { ja } from './ja'

export type Lang = 'ko' | 'en' | 'ja'
export const LANGS: Array<{ id: Lang; label: string }> = [
  { id: 'ko', label: '한국어' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
]

const DICTS: Record<Lang, Record<MsgKey, string>> = { ko, en, ja }
const STORAGE_KEY = 'jackal.lang'

export type Params = Record<string, string | number>
export type Translate = (key: MsgKey, params?: Params) => string

type Ctx = { lang: Lang; setLang: (lang: Lang) => void; t: Translate }

const I18nContext = createContext<Ctx>({ lang: 'ko', setLang: () => {}, t: key => ko[key] })

export function isLang(value: unknown): value is Lang {
  return value === 'ko' || value === 'en' || value === 'ja'
}

function format(text: string, params?: Params) {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>('ko')

  useEffect(() => {
    let next: Lang | null = null
    try {
      const fromUrl = new URLSearchParams(window.location.search).get('lang')
      if (isLang(fromUrl)) next = fromUrl
      else {
        const saved = window.localStorage.getItem(STORAGE_KEY)
        if (isLang(saved)) next = saved
      }
    } catch { /* 저장소를 못 쓰는 환경은 기본값 사용 */ }
    if (!next) {
      const browser = navigator.language.toLowerCase()
      next = browser.startsWith('ja') ? 'ja' : browser.startsWith('ko') ? 'ko' : 'en'
    }
    setLangState(next)
  }, [])

  useEffect(() => { document.documentElement.lang = lang }, [lang])

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try { window.localStorage.setItem(STORAGE_KEY, next) } catch { /* 무시 */ }
  }, [])

  const value = useMemo<Ctx>(() => {
    const dict = DICTS[lang]
    return { lang, setLang, t: (key, params) => format(dict[key] ?? ko[key], params) }
  }, [lang, setLang])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  return useContext(I18nContext)
}

export function useT(): Translate {
  return useContext(I18nContext).t
}

export type { MsgKey }
