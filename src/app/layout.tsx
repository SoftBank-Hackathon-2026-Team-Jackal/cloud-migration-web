import type { Metadata, Viewport } from 'next'
import './globals.css'
import './flow.css'
import { I18nProvider } from '../lib/i18n'

export const metadata: Metadata = {
  title: 'Cloud Migration Demo',
  description: 'Cloud migration platform demo · analysis, plan, approval, provisioning, data and traffic cutover',
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
