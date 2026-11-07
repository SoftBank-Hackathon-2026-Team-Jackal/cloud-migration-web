import type { NextConfig } from 'next'
import { temporalUiUrl } from './src/lib/temporalUi'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Temporal UI 사이드바: Temporal UI는 X-Frame-Options: SAMEORIGIN이라, 웹에 없는 경로(/namespaces, /_app, /api/v1 …)를
  // 같은 origin에서 Temporal UI로 넘겨 iframe으로 연다. 상태를 바꾸는 요청은 src/proxy.ts가 막는다.
  // rewrite 주소는 빌드할 때 정해진다(TEMPORAL_UI_URL을 바꾸면 다시 빌드).
  async rewrites() {
    return { beforeFiles: [], afterFiles: [], fallback: [{ source: '/:path*', destination: `${temporalUiUrl()}/:path*` }] }
  },
}

export default nextConfig
