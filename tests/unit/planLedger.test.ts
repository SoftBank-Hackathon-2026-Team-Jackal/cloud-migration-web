import { test } from 'node:test'
import assert from 'node:assert/strict'
import { networkPolicyRule, realLedger, shortImage, splitBackendName, splitBackendSize } from '../../src/lib/migration/planModel.ts'
import { adaptBackendPreview, isAppBody } from '../../src/lib/migration/previewAdapter.ts'
import { planPreviewFor } from '../../src/lib/migration/script.ts'
import type { BackendPreviewData } from '../../src/lib/migration/events.ts'

const IMAGE = '714066696240.dkr.ecr.ap-northeast-2.amazonaws.com/cmp-platform-builds@sha256:818c75d7' + 'a'.repeat(56)
const NP = (text: string) => ({ resource_type: 'NETWORK', action: 'CREATE', name: 'NetworkPolicy ' + text })
/** 데모 서버 실제 실행(온프레미스 K3s)의 Preview 줄 */
export const REAL_PREVIEW: BackendPreviewData = {
  contract_version: '1',
  manifest_digest: 'sha256:' + 'b'.repeat(64),
  changes: [
    { resource_type: 'CLUSTER', action: 'NO_CHANGE', name: '기존 K3s b7394441-d07d-46b0-aee1-8a683e928142 · Agent cmp-kms-k3s-01 · Namespace cmp-app' },
    { resource_type: 'DATABASE', action: 'CREATE', name: 'chat-db', quantity: 1, size: 'PostgreSQL 16 StatefulSet · DB chat · CPU 500m · 메모리 1024MiB · 논리 복제 설정 wal_level=logical · 슬롯 10 · 송신자 10' },
    { resource_type: 'STORAGE', action: 'CREATE', name: 'chat-db PVC', quantity: 1, size: '10 GiB · StorageClass local-path' },
    { resource_type: 'APP', action: 'CREATE', name: 'chat-app', quantity: 1, size: IMAGE + ' · CPU 250m · 메모리 256MiB · 포트 :8080 · 헬스 /healthz · 환경변수 5개(Secret 참조 5개)' },
    { resource_type: 'APP', action: 'CREATE', name: 'chat-app Service', quantity: 1, size: '클러스터 내부 :8080' },
    { resource_type: 'INGRESS', action: 'NO_CHANGE', name: '외부 공개 없음; 클러스터 내부 Service만' },
    { resource_type: 'APP', action: 'CREATE', name: '앱 환경변수 Secret chat-app-env 생성·갱신', size: 'PASS 키 ADDR, DRAIN_DELAY, ENV_NAME, POLL_INTERVAL_MS (값은 실행 시 .env에서 읽고 Plan에 없음)' },
    { resource_type: 'DATABASE', action: 'CREATE', name: '대상 DB 출력 연결(REPLACED, secretKeyRef)', size: 'DATABASE_URL→connection_url_secret_ref' },
    NP('Namespace 기본 차단(cmp-default-deny: 모든 Pod 수신·송신)'),
    NP('chat-app → chat-db TCP 5432 허용'),
    NP('외부 진입(LB/Ingress) → chat-app TCP 8080 허용, 다른 포트 차단'),
  ],
  applied_defaults: [
    { resource_type: 'CLUSTER', action: 'CREATE', name: 'Namespace cmp-app가 없으면 플랫폼 관리 라벨로 생성' },
    { resource_type: 'DATABASE', action: 'CREATE', name: 'DB 비밀번호 Secret chat-db-auth/password가 없으면 클러스터 안에서 생성(값은 외부로 나가지 않음)' },
    { resource_type: 'DATABASE', action: 'CREATE', name: 'DB 연결 URL Secret chat-db-url/url를 비밀번호로 클러스터 안에서 생성·갱신(값은 외부로 나가지 않음)' },
    NP('모든 Pod → kube-system kube-dns·node-local-dns UDP/TCP 53 허용'),
    NP('chat-db 자기 점검·복제 연결 TCP 5432 허용(수신은 자신만)'),
    NP('Agent 터널 → chat-db TCP 5432 허용'),
    NP('Network Preflight 점검 Pod 송신 허용'),
  ],
  warnings: [], errors: [], pending_decisions: [],
} as BackendPreviewData

test('계획 표(실제 모드): 백엔드 name을 짧은 이름과 설명으로 나눈다', () => {
  const at = (name: string) => splitBackendName(name)
  assert.deepEqual(at('기존 K3s b7394441-d07d-46b0-aee1-8a683e928142 · Agent cmp-kms-k3s-01 · Namespace cmp-app'), { title: '기존 K3s b7394441…', rest: ['Agent cmp-kms-k3s-01 · Namespace cmp-app'], ok: true })
  assert.deepEqual(at('Namespace cmp-app가 없으면 플랫폼 관리 라벨로 생성'), { title: 'Namespace cmp-app', rest: ['없으면 플랫폼 관리 라벨로 생성'], ok: true })
  assert.deepEqual(at('앱 환경변수 Secret chat-app-env 생성·갱신'), { title: 'Secret chat-app-env', rest: ['앱 환경변수', '생성·갱신'], ok: true })
  assert.deepEqual(at('DB 비밀번호 Secret chat-db-auth/password가 없으면 클러스터 안에서 생성(값은 외부로 나가지 않음)'), { title: 'Secret chat-db-auth/password', rest: ['DB 비밀번호', '없으면 클러스터 안에서 생성(값은 외부로 나가지 않음)'], ok: true })
  assert.deepEqual(at('DB 연결 URL Secret chat-db-url/url를 비밀번호로 클러스터 안에서 생성·갱신(값은 외부로 나가지 않음)').title, 'Secret chat-db-url/url')
  assert.deepEqual(at('대상 DB 출력 연결(REPLACED, secretKeyRef)'), { title: '대상 DB 출력 연결', rest: ['REPLACED, secretKeyRef'], ok: true })
  assert.deepEqual(at('chat-app Service'), { title: 'chat-app Service', rest: [], ok: true })
  assert.deepEqual(at('chat-db PVC'), { title: 'chat-db PVC', rest: [], ok: true })
  assert.deepEqual(at('chat-app'), { title: 'chat-app', rest: [], ok: true })
  // 모르는 문장은 그대로(안전한 기본)
  assert.deepEqual(at('무언가 새로운 설명 문장'), { title: '무언가 새로운 설명 문장', rest: [], ok: false })
})

test('계획 표(실제 모드): 크기 칸에는 CPU·메모리·용량만, 이미지·포트·헬스는 보조 줄로', () => {
  assert.equal(shortImage(IMAGE), '714066696240…/cmp-platform-builds@sha256:818c75d7aaaa')
  assert.deepEqual(splitBackendSize(IMAGE + ' · CPU 250m · 메모리 256MiB · 포트 :8080 · 헬스 /healthz · 환경변수 5개(Secret 참조 5개)'), {
    size: 'CPU 250m · 메모리 256MiB',
    extra: ['714066696240…/cmp-platform-builds@sha256:818c75d7aaaa', '포트 :8080', '헬스 /healthz', '환경변수 5개(Secret 참조 5개)'],
  })
  assert.deepEqual(splitBackendSize('10 GiB · StorageClass local-path'), { size: '10 GiB', extra: ['StorageClass local-path'] })
  assert.deepEqual(splitBackendSize('클러스터 내부 :8080'), { size: '', extra: ['클러스터 내부 :8080'] })
  assert.deepEqual(splitBackendSize('CPU 250m × 2'), { size: 'CPU 250m × 2', extra: [] })
  assert.deepEqual(splitBackendSize(''), { size: '', extra: [] })
})

test('계획 표(실제 모드): NetworkPolicy 문장을 보안 규칙 한 줄로', () => {
  const rule = (text: string) => { const { from, to, ports, deny } = networkPolicyRule('NetworkPolicy ' + text); return { from, to, ports, deny } }
  assert.deepEqual(rule('Namespace 기본 차단(cmp-default-deny: 모든 Pod 수신·송신)'), { from: '*', to: '*', ports: '', deny: true })
  assert.deepEqual(rule('chat-app → chat-db TCP 5432 허용'), { from: 'chat-app', to: 'chat-db', ports: 'TCP 5432', deny: false })
  assert.deepEqual(rule('외부 진입(LB/Ingress) → chat-app TCP 8080 허용, 다른 포트 차단'), { from: '외부 진입(LB/Ingress)', to: 'chat-app', ports: 'TCP 8080', deny: false })
  assert.deepEqual(rule('모든 Pod → kube-system kube-dns·node-local-dns UDP/TCP 53 허용'), { from: '모든 Pod', to: 'kube-system kube-dns·node-local-dns', ports: 'UDP/TCP 53', deny: false })
  assert.deepEqual(rule('chat-db 자기 점검·복제 연결 TCP 5432 허용(수신은 자신만)'), { from: 'chat-db 자기 점검·복제 연결', to: '', ports: 'TCP 5432', deny: false })
  assert.deepEqual(rule('Network Preflight 점검 Pod 송신 허용'), { from: 'Network Preflight 점검 Pod 송신', to: '', ports: '', deny: false })
})

test('Preview 어댑터: Digest 고정은 이미지가 있는 앱 본체에만', () => {
  const preview = adaptBackendPreview(REAL_PREVIEW, { steps: [], meta: { plan_id: 'p', revision: 1, verified_digest: 'sha256:' + 'c'.repeat(64) } })
  const change = (name: string) => preview.resources.find(resource => resource.backend_name === name)?.change
  assert.equal(change('chat-app'), 'PINNED')
  assert.equal(change('chat-app Service'), 'CREATE')
  assert.equal(change('앱 환경변수 Secret chat-app-env 생성·갱신'), 'CREATE')
  assert.equal(isAppBody({ name: 'demo-app', size: 'replicas' }), true, '목업 앱 줄은 그대로 본체')
  assert.equal(isAppBody({ name: '대상에 복사하지 않는 .env 키(EXCLUDED)', size: 'A, B' }), false)
})

test('계획 표(실제 모드): NetworkPolicy는 한 줄로 묶고 규칙은 보안 규칙 칸으로, 외부 공개 없음은 칩 없는 진입 줄', () => {
  const preview = adaptBackendPreview(REAL_PREVIEW, { steps: [], meta: { plan_id: 'p', revision: 1, verified_digest: 'sha256:' + 'c'.repeat(64) } })
  const { rows, rules } = realLedger(preview.resources, () => ({ name: 'own', detail: '' }))
  const policies = rows.filter(row => typeof row.title !== 'string' && row.title.key === 'plan.np.title')
  assert.equal(policies.length, 1)
  assert.deepEqual(policies[0].title, { key: 'plan.np.title', params: { n: 7 } })
  assert.deepEqual(policies[0].sub, [{ key: 'plan.np.subDeny', params: { n: 6 } }])
  assert.equal(policies[0].change, 'CREATE')
  assert.equal(policies[0].ids.length, 7, '묶은 줄의 경고는 어느 정책에 걸려도 보인다')
  assert.equal(rules.length, 7)
  assert.equal(rows.length, preview.resources.length - 6)
  const ingress = rows.find(row => row.resource.resource_type === 'INGRESS')!
  assert.deepEqual([ingress.title, ingress.sub, ingress.chip], [{ key: 'plan.type.INGRESS' }, ['외부 공개 없음; 클러스터 내부 Service만'], false])
  const app = rows.find(row => row.title === 'chat-app')!
  assert.deepEqual([app.size, app.change], ['CPU 250m · 메모리 256MiB', 'PINNED'])
  assert.equal(app.sub[0], '714066696240…/cmp-platform-builds@sha256:818c75d7aaaa')
  const cluster = rows.find(row => row.resource.resource_type === 'CLUSTER' && !row.defaulted)!
  assert.equal(cluster.title, '기존 K3s b7394441…')
  const ns = rows.find(row => row.title === 'Namespace cmp-app')!
  assert.equal(ns.defaulted, true)
  // 설명이 없는 짧은 이름은 종류를 보조 줄로
  assert.deepEqual(rows.find(row => row.title === 'chat-app Service')!.sub, ['클러스터 내부 :8080'])
  assert.deepEqual(rows.find(row => row.title === 'chat-db PVC')!.size, '10 GiB')
})

test('계획 표: 목업 Preview는 실제 모드 줄 만들기와 무관하다(어댑터 결과 그대로)', () => {
  for (const target of ['gcp', 'onprem'] as const) {
    const preview = adaptBackendPreview(planPreviewFor(target, 1), { steps: [], meta: { plan_id: 'p', revision: 1, verified_digest: 'sha256:' + 'c'.repeat(64) } })
    assert.equal(preview.resources.find(resource => resource.id === 'app')?.change, 'PINNED', target)
    assert.equal(preview.resources.filter(resource => resource.change === 'PINNED').length, 1, target)
  }
})
