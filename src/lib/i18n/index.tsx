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
/** 키가 사전에 없을 수도 있는 조회(서버가 보낸 id로 문구를 찾을 때). 없으면 fallback을 돌려준다. */
export type TranslateOr = (key: string, fallback?: string, params?: Params) => string

type Ctx = { lang: Lang; setLang: (lang: Lang) => void; t: Translate; tOr: TranslateOr }

const lookup = (dict: Record<string, string>, key: string): string | undefined => (Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined)
const I18nContext = createContext<Ctx>({
  lang: 'ko', setLang: () => {},
  t: (key, params) => format(lookup(ko, key) ?? '', params),
  tOr: (key, fallback = '', params) => format(lookup(ko, key) ?? fallback, params),
})



export function isLang(value: unknown): value is Lang {
  return value === 'ko' || value === 'en' || value === 'ja'
}

/** 화면 언어와 상관없이 지정한 언어의 문구(자칼이 화면 언어와 다른 언어로 말할 때 쓴다). 없는 키는 한국어로 대신한다. */
export function translateIn(language: Lang, key: MsgKey, params?: Params): string {
  return format(lookup(DICTS[language], key) ?? lookup(ko, key), params)
}

/** 사전에 없는 키(서버가 보낸 새 id 등)도 예외 없이 빈 문구가 된다. */
export function format(text: string | undefined, params?: Params) {
  if (typeof text !== 'string') return ''
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
    const find = (key: string) => lookup(dict, key) ?? lookup(ko, key)
    return { lang, setLang, t: (key, params) => format(find(key), params), tOr: (key, fallback = '', params) => format(find(key) ?? fallback, params) }
  }, [lang, setLang])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  return useContext(I18nContext)
}

export function useT(): Translate {
  return useContext(I18nContext).t
}

export function useTOr(): TranslateOr {
  return useContext(I18nContext).tOr
}

export type { MsgKey }
