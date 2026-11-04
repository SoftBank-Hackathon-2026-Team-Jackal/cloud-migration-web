import type { Metadata, Viewport } from 'next'
import './globals.css'
import './flow.css'
import './voice.css'
import './polish.css'
import { I18nProvider } from '../lib/i18n'

export const metadata: Metadata = {
  title: 'Jackal Voice Migration Demo',
  description: 'Voice guided cloud migration demo',
}

export const viewport: Viewport = {
  themeColor: '#f7f7f7',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="ko">
    <body><I18nProvider>{children}</I18nProvider></body>
  </html>
}
