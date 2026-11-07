import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Temporal UI(X-Frame-Options: SAMEORIGIN)를 사이드바 iframe으로 넣으려고, 웹에 없는 경로를 같은 origin에서 Temporal UI로 넘긴다.
  // rewrites는 빌드할 때 정해지므로 TEMPORAL_UI_URL은 빌드 인자로도 넘긴다(Dockerfile).
  async rewrites() {
    const ui = (process.env.TEMPORAL_UI_URL || 'http://127.0.0.1:8233').replace(/\/+$/, '')
    return { beforeFiles: [], afterFiles: [], fallback: [{ source: '/:path*', destination: `${ui}/:path*` }] }
  },
}

export default nextConfig
