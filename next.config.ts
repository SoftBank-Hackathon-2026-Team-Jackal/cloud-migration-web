import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 로컬 데모 전용: Temporal UI(X-Frame-Options: SAMEORIGIN)를 iframe으로 넣으려고, 웹에 없는 경로를 같은 origin에서 Temporal UI로 넘긴다.
  async rewrites() {
    if (process.env.NEXT_PUBLIC_TEMPORAL_SIDEBAR !== '1') return []
    const ui = (process.env.TEMPORAL_UI_URL || 'http://127.0.0.1:8233').replace(/\/+$/, '')
    return { beforeFiles: [], afterFiles: [], fallback: [{ source: '/:path*', destination: `${ui}/:path*` }] }
  },
}

export default nextConfig
