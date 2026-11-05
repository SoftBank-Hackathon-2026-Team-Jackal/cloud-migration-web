/**
 * [가정] 목업 모드 시연용 저장소와 가져오기 결과. GitHub 로그인 없이도 가져오기 장면을 보여 주기 위한 값이다.
 * 실제 저장소는 /api/github/scan(이 앱의 서버가 GitHub에서 구성 파일만 읽음)이 같은 RepoScan 형태로 돌려준다.
 * 시연용 저장소는 시작 요청(source)에 싣지 않는다(목업 모드에서만 쓰인다).
 */
import type { RepoScan } from '../github/scan'

export const DEMO_REPO = { full_name: 'acme/chat-service', default_branch: 'main', commit_sha: '4f2a91c07e3b5d8a1c6f0e9b2d4a7c3e5f1b8d06' }

export const DEMO_SCAN: RepoScan = {
  tree: [
    '.env.example', 'Dockerfile', 'k8s/', 'k8s/configmap.yaml', 'k8s/deployment.yaml', 'k8s/ingress.yaml', 'k8s/service.yaml',
    'migrations/', 'migrations/001_init.sql', 'package.json', 'src/', 'src/chat/rooms.ts', 'src/config.ts', 'src/db/pool.ts',
    'src/server.ts', 'tsconfig.json',
  ],
  detections: [
    { kind: 'runtime', name: 'Node.js 20', evidence: 'Dockerfile' },
    { kind: 'dockerfile', evidence: 'Dockerfile', stages: 2 },
    { kind: 'k8s', count: 4, evidence: 'k8s/' },
    { kind: 'postgres', evidence: 'pg' },
    { kind: 'env', count: 6, evidence: '.env.example' },
  ],
  env_keys: ['PORT', 'NODE_ENV', 'DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'LOG_LEVEL'],
  truncated: false,
}

/** [가정] "예시 .env 사용" 버튼이 넣는 파일. 값은 가짜이고, 이 파일도 실제 업로드와 똑같이 키 이름만 읽는다. */
export const EXAMPLE_ENV = [
  '# example values (fake)',
  'PORT=8080',
  'NODE_ENV=production',
  'DATABASE_URL=postgres://chat:example@db.internal:5432/chat',
  'REDIS_URL=redis://cache.internal:6379',
  'JWT_SECRET=example-not-a-real-secret',
  'SENTRY_DSN=',
].join('\n')
