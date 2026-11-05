import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spell, spokenText, type SpeechLang } from '../../src/lib/tts/pronounce.ts'
import { cacheKey, spokenRequest } from '../../src/lib/tts/service.ts'
import { VOICE_MESSAGES } from '../../src/lib/voice/messages.ts'
import { ko } from '../../src/lib/i18n/ko.ts'
import { en } from '../../src/lib/i18n/en.ts'
import { ja } from '../../src/lib/i18n/ja.ts'

const TABLE: Array<[SpeechLang, string, string]> = [
  // 약어·제품 이름
  ['ko', '어디로 옮길까요? 온프레미스 K3s와 GCP가 연결돼 있어요.', '어디로 옮길까요? 온프레미스 케이 쓰리 에스와 지 씨 피가 연결돼 있어요.'],
  ['ko', '데모 환경의 AWS 인프라와 애플리케이션 분석을 시작하겠습니다.', '데모 환경의 에이 더블유 에스 인프라와 애플리케이션 분석을 시작하겠습니다.'],
  ['ko', 'AWS SDK 호출', '에이 더블유 에스 에스 디 케이 호출'],
  ['ko', 'GCP GKE로', '지 씨 피 지 케이 이로'],
  ['ko', 'EKS·IAM·CDC·LSN·WAL', '이 케이 에스·아이 에이 엠·씨 디 씨·엘 에스 엔·왈'],
  ['ko', 'TLS, DNS, MTU, ALB, RDS, S3', '티 엘 에스, 디 엔 에스, 엠 티 유, 에이 엘 비, 알 디 에스, 에스 쓰리'],
  ['ko', 'PgBouncer와 Envoy, Kubernetes, PostgreSQL, GitHub', '피지 바운서와 엔보이, 쿠버네티스, 포스트그레스큐엘, 깃허브'],
  ['ko', '값은 Secret 참조로만 넘길게요.', '값은 시크릿 참조로만 넘길게요.'],
  ['ko', 'DB 전환 중 쓰기 약 0.1초 중단', '디비 전환 중 쓰기 약 0.1초 중단'],
  ['ko', 'p99 1.08배', '피 구십구 1.08배'],
  // 파일·단위·퍼센트
  ['ko', '코드가 읽지만 .env에 없는 키가 2개 있어요.', '코드가 읽지만 환경 변수 파일에 없는 키가 2개 있어요.'],
  ['ko', '쓰기 중단 12 ms', '쓰기 중단 12 밀리초'],
  ['ko', '쓰기 중단 612ms', '쓰기 중단 612 밀리초'],
  ['ko', '1200 req/s', '초당 1200 요청'],
  ['ko', '트래픽 50% 전달', '트래픽 50 퍼센트 전달'],
  // 분수
  ['ko', '리소스 3/6 준비', '리소스 6개 중 3개 준비'],
  ['ko', '테이블 2/6 복사', '테이블 6개 중 2개 복사'],
  ['ko', '변경 4건, 테스트 24/24 통과, 롤백 가능', '변경 4건, 테스트 24개 중 24개 통과, 롤백 가능'],
  ['ko', '10.8.0.0/24 경로, LSN 0/3AF47DE', '10.8.0.0/24 경로, 엘 에스 엔 0/3AF47DE'],
  // 리전
  ['ko', 'ap-northeast-2와 asia-northeast3', '서울 리전과 서울 리전'],
  ['ko', 'us-east-1로', '버지니아 북부 리전으로'],
  ['ko', 'me-west-1', '중동 서부 1 리전'],
  // 오류 코드·검사 이름
  ['ko', '사전 검사 실패. ROUTE_NOT_TUNNEL', '사전 검사 실패. 터널 밖 경로'],
  ['ko', '데이터 오류. TLS_FAILED', '데이터 오류. 티 엘 에스 실패'],
  ['ko', 'pods_ready 검사 실패', '파드 준비 검사 실패'],
  ['ko', 'pods ready 검사 실패', '파드 준비 검사 실패'],
  ['ko', 'db_connect 검사 실패', '디비 연결 검사 실패'],
  ['ko', 'app_health 검사 실패', '앱 상태 검사 실패'],
  ['ko', 'orders_lost 검증 실패', '주문 유실 검증 실패'],
  ['ko', '사전 검사 실패. route', '사전 검사 실패. 경로'],
  ['ko', '구축 오류. DB_BACKUP_RETENTION_SHORT', '구축 오류. 디비 백업 보관 기간 부족'],
  ['ko', '계획 오류. SOURCE_NOT_FOUND', '계획 오류. 소스 없음'],
  ['ko', 'QUOTA_EXCEEDED', '할당량 초과'],
  ['ko', 'XYZ_FOO', '엑스 와이 지 에프 오 오'],
  ['ko', 'demo-postgres 검사 실패', '데모 포스트그레스 검사 실패'],
  ['ko', 'k3s-pod-net 검사 실패', '케이 쓰리 에스 파드 네트워크 검사 실패'],
  ['en', 'on-prem K3s', 'on-prem K3s'],
  // 남은 약어는 철자로
  ['ko', '찾았어요: Node.js 20 서비스, Dockerfile, K8s 매니페스트 3개, PostgreSQL. 환경 변수 파일만 주세요.', '찾았어요: 노드 제이에스 20 서비스, 도커파일, 쿠버네티스 매니페스트 3개, 포스트그레스큐엘. 환경 변수 파일만 주세요.'],
  ['ko', '.env.example 확인', '환경 변수 예시 파일 확인'],
  ['ko', 'VPC와 API, EC2', '브이 피 씨와 에이 피 아이, 이 씨 투'],
  ['ko', 'NAT 게이트웨이', '엔 에이 티 게이트웨이'],
  // 일본어
  ['ja', 'どこへ移しますか？オンプレミス K3s と GCP が接続されています。', 'どこへ移しますか？オンプレミス ケースリーエス と ジーシーピー が接続されています。'],
  ['ja', 'AWS SDK呼び出し', 'エーダブリューエス エスディーケー呼び出し'],
  ['ja', 'リソース3/6準備', 'リソース6個中3個準備'],
  ['ja', 'コードが読むのに .env にないキー', 'コードが読むのに 環境変数ファイル にないキー'],
  ['ja', '事前確認失敗。ROUTE_NOT_TUNNEL', '事前確認失敗。トンネル外の経路'],
  ['ja', '書き込み停止12 ms', '書き込み停止12ミリ秒'],
  ['ja', 'DB切り替え完了', 'ディービー切り替え完了'],
  ['ja', 'AWS ap-northeast-2', 'エーダブリューエス ソウルリージョン'],
  ['ja', 'VPC', 'ブイピーシー'],
  // 영어: 대부분 그대로
  ['en', 'Where should it go? On-prem K3s and GCP are connected.', 'Where should it go? On-prem K3s and GCP are connected.'],
  ['en', '2/6 resources ready', '2 of 6 resources ready'],
  ['en', 'Retest 12/12 passed. Ready to deploy', 'Retest 12 of 12 passed. Ready to deploy'],
  ['en', 'Write pause 12 ms', 'Write pause 12 milliseconds'],
  ['en', 'Traffic 50% sent', 'Traffic 50 percent sent'],
  ['en', 'Preflight failed. ROUTE_NOT_TUNNEL', 'Preflight failed. route outside the tunnel'],
  ['en', 'Provisioning error. db_backup_retention_short', 'Provisioning error. DB backup retention too short'],
  ['en', 'Provisioning error. QUOTA_EXCEEDED', 'Provisioning error. quota exceeded'],
  ['en', 'not in the .env.', 'not in the dot env.'],
  ['en', 'AWS ap-northeast-2', 'AWS Seoul region'],
  ['en', 'PgBouncer p99', 'P G Bouncer P ninety-nine'],
]

test('말 다듬기: 입력 → 말(ko·ja·en 표)', () => {
  for (const [lang, input, expected] of TABLE) assert.equal(spokenText(input, lang), expected, `${lang}: ${input}`)
})

test('말 다듬기: 문장부호는 남긴다, 한글·가나만 있는 문장은 그대로', () => {
  for (const text of ['네, 듣고 있어요.', "승인하려면 '승인해'", '롤백할까요? \'확인\'으로 진행', '복제 지연 0. 전환 준비 완료']) assert.equal(spokenText(text, 'ko'), text)
  for (const text of ['承認するなら「承認して」', 'ロールバックしますか？「確認」で実行']) assert.equal(spokenText(text, 'ja'), text)
  assert.equal(spell('VPC', 'ko'), '브이 피 씨')
  assert.equal(spell('VPC', 'ja'), 'ブイピーシー')
})

test('말 다듬기: 캐시 키는 다듬은 말로 만든다(같은 말이 되는 문구는 캐시를 함께 쓴다)', () => {
  const a = spokenRequest({ text: 'pods_ready 검사 실패', lang: 'ko', voice: 'M1' })
  const b = spokenRequest({ text: 'pods ready 검사 실패', lang: 'ko', voice: 'M1' })
  assert.equal(a.text, '파드 준비 검사 실패')
  assert.equal(cacheKey(a), cacheKey(b))
})

// ---- 말하는 문구 전체를 훑어 라틴 글자가 남지 않는지 본다(새 약어를 쓰면 사전에 더해야 실패가 풀린다) ----
const SAMPLE_PARAMS: Record<string, string> = {
  n: '3', m: '6', p: '50', s: '0.1', attempt: '2', changes: '4', passed: '24', total: '24', present: '3', expected: '5', missing: '2', count: '4',
  // 이벤트에서 들어오는 실제 값(목업 대본·백엔드 코드)
  code: 'ROUTE_NOT_TUNNEL', name: 'pods_ready', label: 'orders_lost', value: '12 ms', item: 'f.sdk', cls: 'cls.CODE', phase: 'phase.data_copy',
  stage: 'stage.cutover', region: 'ap-northeast-2', source: 'AWS ap-northeast-2', target: 'GCP GKE', targetEnv: 'GCP 프로젝트', found: 'Node.js 20 서비스, Dockerfile, K8s 매니페스트 3개, PostgreSQL, .env.example',
}
const fill = (text: string, dict: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, name: string) => {
  const value = SAMPLE_PARAMS[name] ?? '3'
  return dict[value] ?? value
})
const RUNTIME_VALUES = [
  // 오류·사전 검사 코드, 검사 이름, DB 전환 결과 id(목업 대본·백엔드 계약에 나오는 것)
  'ROUTE_NOT_TUNNEL', 'TLS_FAILED', 'ASSUME_ROLE_DENIED', 'DB_BACKUP_RETENTION_SHORT', 'CLEANUP_POLICY_REQUIRED', 'BUILD_FAILED', 'DOCKERFILE_MISSING',
  'USER_SECRET_REQUIRED', 'SOURCE_REQUIRED', 'SOURCE_NOT_FOUND', 'PUSH_FAILED', 'INSPECTION_REQUIRED', 'EXPLICIT_TARGET_REQUIRED', 'CHECKSUM_MISMATCH',
  'github_error', 'start_failed', 'request_failed', 'report_failed', 'migration_not_found', 'auth_expired', 'FAIL', 'OK',
  'pods_ready', 'pods ready', 'db_connect', 'db connect', 'app_health', 'app health', 'route', 'cidr_overlap', 'db_path', 'large_transfer',
  'orders_lost', 'msg_lost', 'msg_dup', 'latency_max', 'long_tx', 'reverse_sub', 'sub_off', 'seq_raise', 'resume_source',
  'Node.js 20', 'Python 3.12', 'Go 1.22', 'Java 21',
  'demo-vpc', 'demo-https-lb', 'demo-gke', 'demo-pool', 'demo-app', 'demo-postgres', 'k3s-pod-net', 'relay-ingress', 'k3s-dc1', 'dc1-nodes', 'env-a', 'env-b',
  '12 ms', '612 ms', '0.04 s', 'ap-northeast-2', 'asia-northeast3',
]

function spokenSources(lang: 'ko' | 'ja'): string[] {
  const dict = ({ ko, ja } as Record<string, Record<string, string>>)[lang]
  const voice = VOICE_MESSAGES[lang] as Record<string, string>
  const lines = Object.values(voice).map(text => fill(text, voice))
  for (const [key, text] of Object.entries(dict)) {
    if (/^open\.(jackal\.|sample$|source$|target\.|targetEnv\.|found\.)/.test(key) || key.startsWith('region.')) lines.push(fill(text, dict))
  }
  if (lang === 'ko') lines.push(...Object.values(JSON.parse(readFileSync(new URL('../../src/lib/voiceClips.json', import.meta.url), 'utf8')) as Record<string, string>))
  lines.push(...RUNTIME_VALUES)
  return lines
}

for (const lang of ['ko', 'ja'] as const) {
  test(`말 다듬기(${lang}): 보고·명령 응답·첫 화면 대화·고정 안내·이벤트 값에 라틴 글자가 남지 않는다`, () => {
    const left = new Map<string, string>()
    for (const line of spokenSources(lang)) {
      const spoken = spokenText(line, lang)
      for (const token of spoken.match(/[A-Za-z][A-Za-z0-9._-]*/g) ?? []) left.set(token, line)
    }
    assert.deepEqual([...left].map(([token, line]) => `${token} ← ${line}`), [])
  })
}

test('말 다듬기(en): 분수·단위는 말로, 나머지 문구는 그대로', () => {
  const voice = VOICE_MESSAGES.en as Record<string, string>
  for (const text of Object.values(voice)) {
    const spoken = spokenText(fill(text, voice), 'en')
    assert.ok(!/\d\s*\/\s*\d/.test(spoken), spoken)
    assert.ok(!/_/.test(spoken), spoken)
  }
  for (const [key, text] of Object.entries(en)) if (key.startsWith('open.jackal.') && !text.includes('/') && !text.includes('.env')) {
    assert.equal(spokenText(text, 'en'), text.replace(/\s+/g, ' ').trim(), key)
  }
})
