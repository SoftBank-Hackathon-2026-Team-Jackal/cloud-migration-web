/**
 * 말할 문장 다듬기: 화면 문구는 그대로 두고, 합성기에 넘기기 직전에만 읽기 좋은 글로 바꾼다.
 * Supertonic은 글자 단위 모델이라 문장 전체를 <ko>…</ko>로 감싸면 "AWS"·"3/6"·"ROUTE_NOT_TUNNEL" 같은 라틴 글자를
 * 한국어 규칙으로 읽어 뭉갠다. 그래서 한국어·일본어는 약어·제품 이름·오류 코드·단위·분수를 한글/가나로 풀어 준다.
 *   - 순서: .env → req/s → 리전 → 밑줄 코드(문구 사전, 없으면 낱말 사전) → 아는 영어 낱말 묶음 → 단위·퍼센트 → 분수 → 용어 사전 → 남은 약어 철자
 *   - 문장부호는 지우지 않는다(마침표·쉼표는 쉬는 자리다).
 * 서버(/api/tts, 미리 생성)와 브라우저 음성 합성 대체 경로가 함께 쓴다. 런타임 import 없음(단위 테스트가 직접 읽는다).
 */
export type SpeechLang = 'ko' | 'en' | 'ja'

type Spoken = { ko: string; ja: string; en?: string }

/** 약어·제품 이름(대소문자 무시, 앞뒤가 라틴 글자·숫자가 아닐 때만). 긴 것부터 맞춘다. */
const TERMS: Record<string, Spoken> = {
  'PostgreSQL': { ko: '포스트그레스큐엘', ja: 'ポストグレスキューエル' },
  'Postgres': { ko: '포스트그레스', ja: 'ポストグレス' },
  'PgBouncer': { ko: '피지 바운서', ja: 'ピージーバウンサー', en: 'P G Bouncer' },
  'Kubernetes': { ko: '쿠버네티스', ja: 'クバネティス' },
  'GitHub': { ko: '깃허브', ja: 'ギットハブ' },
  'Dockerfile': { ko: '도커파일', ja: 'ドッカーファイル' },
  'Docker': { ko: '도커', ja: 'ドッカー' },
  'Envoy': { ko: '엔보이', ja: 'エンボイ' },
  'Secret': { ko: '시크릿', ja: 'シークレット' },
  'Terraform': { ko: '테라폼', ja: 'テラフォーム' },
  'Helm': { ko: '헬름', ja: 'ヘルム' },
  'Redis': { ko: '레디스', ja: 'レディス' },
  'Kafka': { ko: '카프카', ja: 'カフカ' },
  'nginx': { ko: '엔진엑스', ja: 'エンジンエックス' },
  'WireGuard': { ko: '와이어가드', ja: 'ワイヤーガード' },
  'Node.js': { ko: '노드 제이에스', ja: 'ノードジェイエス' },
  'Next.js': { ko: '넥스트 제이에스', ja: 'ネクストジェイエス' },
  'Python': { ko: '파이썬', ja: 'パイソン' },
  'Java': { ko: '자바', ja: 'ジャバ' },
  'Go': { ko: '고', ja: 'ゴー' },
  'Kubectl': { ko: '큐브 컨트롤', ja: 'キューブコントロール' },
  'Pods': { ko: '파드', ja: 'ポッド' },
  'Pod': { ko: '파드', ja: 'ポッド' },
  'JSON': { ko: '제이슨', ja: 'ジェイソン' },
  'YAML': { ko: '야믈', ja: 'ヤムル' },
  'CIDR': { ko: '사이더', ja: 'サイダー' },
  'K3s': { ko: '케이 쓰리 에스', ja: 'ケースリーエス' },
  'K8s': { ko: '쿠버네티스', ja: 'クバネティス' },
  'AWS': { ko: '에이 더블유 에스', ja: 'エーダブリューエス' },
  'GCP': { ko: '지 씨 피', ja: 'ジーシーピー' },
  'EKS': { ko: '이 케이 에스', ja: 'イーケーエス' },
  'GKE': { ko: '지 케이 이', ja: 'ジーケーイー' },
  'SDK': { ko: '에스 디 케이', ja: 'エスディーケー' },
  'IAM': { ko: '아이 에이 엠', ja: 'アイアム' },
  'CDC': { ko: '씨 디 씨', ja: 'シーディーシー' },
  'LSN': { ko: '엘 에스 엔', ja: 'エルエスエヌ' },
  'WAL': { ko: '왈', ja: 'ワル' },
  'TLS': { ko: '티 엘 에스', ja: 'ティーエルエス' },
  'DNS': { ko: '디 엔 에스', ja: 'ディーエヌエス' },
  'MTU': { ko: '엠 티 유', ja: 'エムティーユー' },
  'ALB': { ko: '에이 엘 비', ja: 'エーエルビー' },
  'RDS': { ko: '알 디 에스', ja: 'アールディーエス' },
  'VPC': { ko: '브이 피 씨', ja: 'ブイピーシー' },
  'VPN': { ko: '브이 피 엔', ja: 'ブイピーエヌ' },
  'API': { ko: '에이 피 아이', ja: 'エーピーアイ' },
  'S3': { ko: '에스 쓰리', ja: 'エススリー' },
  'EC2': { ko: '이 씨 투', ja: 'イーシーツー' },
  'DB': { ko: '디비', ja: 'ディービー' },
  'OK': { ko: '오케이', ja: 'オーケー' },
  'FAIL': { ko: '실패', ja: '失敗' },
  'PASS': { ko: '통과', ja: '合格' },
  'p99': { ko: '피 구십구', ja: 'ピーきゅうじゅうきゅう', en: 'P ninety-nine' },
  'p95': { ko: '피 구십오', ja: 'ピーきゅうじゅうご', en: 'P ninety-five' },
}

/** 오류 코드·검사 이름(밑줄로 이은 것, 소문자 키) → 말로 하는 문구. 문구 안의 약어는 뒤에서 용어 사전이 다시 읽는다. */
const CODES: Record<string, Spoken & { en: string }> = {
  route_not_tunnel: { ko: '터널 밖 경로', ja: 'トンネル外の経路', en: 'route outside the tunnel' },
  tls_failed: { ko: 'TLS 실패', ja: 'TLS失敗', en: 'TLS failed' },
  assume_role_denied: { ko: '역할 위임 거부', ja: 'ロール引き受け拒否', en: 'role assumption denied' },
  db_backup_retention_short: { ko: 'DB 백업 보관 기간 부족', ja: 'DBバックアップ保持期間不足', en: 'DB backup retention too short' },
  cleanup_policy_required: { ko: '정리 정책 필요', ja: 'クリーンアップポリシーが必要', en: 'cleanup policy required' },
  build_failed: { ko: '빌드 실패', ja: 'ビルド失敗', en: 'build failed' },
  dockerfile_missing: { ko: 'Dockerfile 없음', ja: 'Dockerfileなし', en: 'Dockerfile missing' },
  user_secret_required: { ko: '사용자 Secret 필요', ja: 'ユーザーSecretが必要', en: 'user secret required' },
  source_required: { ko: '소스 필요', ja: 'ソースが必要', en: 'source required' },
  source_not_found: { ko: '소스 없음', ja: 'ソースが見つからない', en: 'source not found' },
  push_failed: { ko: '푸시 실패', ja: 'プッシュ失敗', en: 'push failed' },
  inspection_required: { ko: '점검 필요', ja: '点検が必要', en: 'inspection required' },
  explicit_target_required: { ko: '대상 지정 필요', ja: '移行先の指定が必要', en: 'explicit target required' },
  checksum_mismatch: { ko: '체크섬 불일치', ja: 'チェックサム不一致', en: 'checksum mismatch' },
  github_error: { ko: 'GitHub 오류', ja: 'GitHubエラー', en: 'GitHub error' },
  start_failed: { ko: '시작 실패', ja: '開始失敗', en: 'start failed' },
  request_failed: { ko: '요청 실패', ja: 'リクエスト失敗', en: 'request failed' },
  report_failed: { ko: '보고서 실패', ja: 'レポート失敗', en: 'report failed' },
  migration_not_found: { ko: '마이그레이션 없음', ja: '移行が見つからない', en: 'migration not found' },
  auth_expired: { ko: '인증 만료', ja: '認証切れ', en: 'auth expired' },
  pods_ready: { ko: '파드 준비', ja: 'ポッド準備', en: 'pods ready' },
  db_connect: { ko: 'DB 연결', ja: 'DB接続', en: 'DB connect' },
  app_health: { ko: '앱 상태', ja: 'アプリの状態', en: 'app health' },
  cidr_overlap: { ko: 'CIDR 충돌', ja: 'CIDR衝突', en: 'CIDR overlap' },
  db_path: { ko: 'DB 경로', ja: 'DB経路', en: 'DB path' },
  large_transfer: { ko: '대량 전송', ja: '大量転送', en: 'large transfer' },
  orders_lost: { ko: '주문 유실', ja: '注文の消失', en: 'orders lost' },
  msg_lost: { ko: '메시지 유실', ja: 'メッセージ消失', en: 'messages lost' },
  msg_dup: { ko: '메시지 중복', ja: 'メッセージ重複', en: 'duplicate messages' },
  latency_max: { ko: '최대 지연', ja: '最大遅延', en: 'max latency' },
  long_tx: { ko: '긴 트랜잭션', ja: '長いトランザクション', en: 'long transactions' },
  reverse_sub: { ko: '역방향 구독', ja: '逆方向サブスクリプション', en: 'reverse subscription' },
  sub_off: { ko: '구독 해제', ja: 'サブスクリプション停止', en: 'subscription off' },
  seq_raise: { ko: '시퀀스 올리기', ja: 'シーケンス引き上げ', en: 'sequence raise' },
  resume_source: { ko: '원본 재개', ja: '移行元の再開', en: 'resume source' },
  liveness_failed: { ko: '대상 DB 응답 없음', ja: '移行先DBの応答なし', en: 'target DB not responding' },
  switch_refused: { ko: '전환 거부', ja: '切り替え拒否', en: 'switch refused' },
}

/** 코드를 낱말로 나눠 읽을 때 쓰는 낱말(소문자). 영어는 그대로 읽되 약어만 대문자로 둔다. */
const WORDS: Record<string, { ko: string; ja: string }> = {
  pod: { ko: '파드', ja: 'ポッド' }, pods: { ko: '파드', ja: 'ポッド' }, ready: { ko: '준비', ja: '準備' },
  connect: { ko: '연결', ja: '接続' }, connection: { ko: '연결', ja: '接続' }, app: { ko: '앱', ja: 'アプリ' },
  health: { ko: '상태', ja: '状態' }, route: { ko: '경로', ja: '経路' }, tunnel: { ko: '터널', ja: 'トンネル' },
  fail: { ko: '실패', ja: '失敗' }, failed: { ko: '실패', ja: '失敗' }, failure: { ko: '실패', ja: '失敗' },
  error: { ko: '오류', ja: 'エラー' }, required: { ko: '필요', ja: '必要' }, missing: { ko: '없음', ja: 'なし' },
  found: { ko: '발견', ja: '発見' }, timeout: { ko: '시간 초과', ja: 'タイムアウト' }, denied: { ko: '거부', ja: '拒否' },
  expired: { ko: '만료', ja: '期限切れ' }, auth: { ko: '인증', ja: '認証' }, source: { ko: '원본', ja: '移行元' },
  target: { ko: '대상', ja: '移行先' }, network: { ko: '네트워크', ja: 'ネットワーク' }, check: { ko: '검사', ja: '確認' },
  lag: { ko: '지연', ja: '遅延' }, latency: { ko: '지연', ja: '遅延' }, max: { ko: '최대', ja: '最大' }, min: { ko: '최소', ja: '最小' },
  lost: { ko: '유실', ja: '消失' }, dup: { ko: '중복', ja: '重複' }, msg: { ko: '메시지', ja: 'メッセージ' },
  order: { ko: '주문', ja: '注文' }, orders: { ko: '주문', ja: '注文' }, backup: { ko: '백업', ja: 'バックアップ' },
  retention: { ko: '보관', ja: '保持' }, short: { ko: '부족', ja: '不足' }, policy: { ko: '정책', ja: 'ポリシー' },
  cleanup: { ko: '정리', ja: 'クリーンアップ' }, build: { ko: '빌드', ja: 'ビルド' }, push: { ko: '푸시', ja: 'プッシュ' },
  image: { ko: '이미지', ja: 'イメージ' }, secret: { ko: 'Secret', ja: 'Secret' }, user: { ko: '사용자', ja: 'ユーザー' },
  invalid: { ko: '잘못됨', ja: '無効' }, quota: { ko: '할당량', ja: 'クォータ' }, exceeded: { ko: '초과', ja: '超過' },
  permission: { ko: '권한', ja: '権限' }, role: { ko: '역할', ja: 'ロール' }, cluster: { ko: '클러스터', ja: 'クラスター' },
  node: { ko: '노드', ja: 'ノード' }, service: { ko: '서비스', ja: 'サービス' }, cert: { ko: '인증서', ja: '証明書' },
  certificate: { ko: '인증서', ja: '証明書' }, schema: { ko: '스키마', ja: 'スキーマ' }, table: { ko: '테이블', ja: 'テーブル' },
  replication: { ko: '복제', ja: 'レプリケーション' }, slot: { ko: '슬롯', ja: 'スロット' }, sub: { ko: '구독', ja: 'サブスクリプション' },
  seq: { ko: '시퀀스', ja: 'シーケンス' }, tx: { ko: '트랜잭션', ja: 'トランザクション' }, long: { ko: '긴', ja: '長い' },
  reverse: { ko: '역방향', ja: '逆方向' }, resume: { ko: '재개', ja: '再開' }, pause: { ko: '중단', ja: '停止' },
  mismatch: { ko: '불일치', ja: '不一致' }, checksum: { ko: '체크섬', ja: 'チェックサム' }, overlap: { ko: '충돌', ja: '衝突' },
  path: { ko: '경로', ja: '経路' }, large: { ko: '대량', ja: '大量' }, transfer: { ko: '전송', ja: '転送' },
  migration: { ko: '마이그레이션', ja: '移行' }, report: { ko: '보고서', ja: 'レポート' }, request: { ko: '요청', ja: 'リクエスト' },
  start: { ko: '시작', ja: '開始' }, unknown: { ko: '알 수 없음', ja: '不明' }, rows: { ko: '행', ja: '行' },
  gate: { ko: '게이트', ja: 'ゲート' }, traffic: { ko: '트래픽', ja: 'トラフィック' }, rollback: { ko: '롤백', ja: 'ロールバック' },
  verify: { ko: '검증', ja: '検証' }, liveness: { ko: '생존 확인', ja: '生存確認' }, marker: { ko: '마커', ja: 'マーカー' },
  revert: { ko: '되돌리기', ja: '元に戻す' }, retarget: { ko: '대상 변경', ja: '接続先変更' }, off: { ko: '해제', ja: '停止' },
  raise: { ko: '올리기', ja: '引き上げ' }, explicit: { ko: '명시', ja: '明示' }, inspection: { ko: '점검', ja: '点検' },
  demo: { ko: '데모', ja: 'デモ' }, net: { ko: '네트워크', ja: 'ネットワーク' }, lb: { ko: '로드 밸런서', ja: 'ロードバランサー' },
  pool: { ko: '풀', ja: 'プール' }, nodes: { ko: '노드', ja: 'ノード' }, relay: { ko: '릴레이', ja: 'リレー' },
  ingress: { ko: '인그레스', ja: 'イングレス' }, env: { ko: '환경', ja: '環境' }, prem: { ko: '프레미스', ja: 'プレミス' },
  https: { ko: 'HTTPS', ja: 'HTTPS' }, postgres: { ko: 'Postgres', ja: 'Postgres' }, k3s: { ko: 'K3s', ja: 'K3s' }, gke: { ko: 'GKE', ja: 'GKE' }, vpc: { ko: 'VPC', ja: 'VPC' },
  not: { ko: '아님', ja: 'なし' }, no: { ko: '없음', ja: 'なし' }, too: { ko: '너무', ja: 'とても' },
  // 약어는 용어 사전이 읽는다.
  db: { ko: 'DB', ja: 'DB' }, tls: { ko: 'TLS', ja: 'TLS' }, dns: { ko: 'DNS', ja: 'DNS' }, mtu: { ko: 'MTU', ja: 'MTU' },
  iam: { ko: 'IAM', ja: 'IAM' }, cidr: { ko: 'CIDR', ja: 'CIDR' }, github: { ko: 'GitHub', ja: 'GitHub' },
  dockerfile: { ko: 'Dockerfile', ja: 'Dockerfile' }, wal: { ko: 'WAL', ja: 'WAL' }, cdc: { ko: 'CDC', ja: 'CDC' }, lsn: { ko: 'LSN', ja: 'LSN' },
}

/** 클라우드 리전 → 도시 이름 */
const REGIONS: Record<string, { ko: string; ja: string; en: string }> = {
  'ap-northeast-1': { ko: '도쿄', ja: '東京', en: 'Tokyo' }, 'ap-northeast-2': { ko: '서울', ja: 'ソウル', en: 'Seoul' },
  'ap-northeast-3': { ko: '오사카', ja: '大阪', en: 'Osaka' }, 'ap-southeast-1': { ko: '싱가포르', ja: 'シンガポール', en: 'Singapore' },
  'ap-southeast-2': { ko: '시드니', ja: 'シドニー', en: 'Sydney' }, 'ap-south-1': { ko: '뭄바이', ja: 'ムンバイ', en: 'Mumbai' },
  'us-east-1': { ko: '버지니아 북부', ja: 'バージニア北部', en: 'North Virginia' }, 'us-east-2': { ko: '오하이오', ja: 'オハイオ', en: 'Ohio' },
  'us-west-1': { ko: '캘리포니아 북부', ja: '北カリフォルニア', en: 'North California' }, 'us-west-2': { ko: '오리건', ja: 'オレゴン', en: 'Oregon' },
  'eu-west-1': { ko: '아일랜드', ja: 'アイルランド', en: 'Ireland' }, 'eu-central-1': { ko: '프랑크푸르트', ja: 'フランクフルト', en: 'Frankfurt' },
  'asia-northeast1': { ko: '도쿄', ja: '東京', en: 'Tokyo' }, 'asia-northeast2': { ko: '오사카', ja: '大阪', en: 'Osaka' },
  'asia-northeast3': { ko: '서울', ja: 'ソウル', en: 'Seoul' }, 'asia-southeast1': { ko: '싱가포르', ja: 'シンガポール', en: 'Singapore' },
  'us-central1': { ko: '아이오와', ja: 'アイオワ', en: 'Iowa' }, 'europe-west1': { ko: '벨기에', ja: 'ベルギー', en: 'Belgium' },
}
const REGION_WORDS: Record<string, { ko: string; ja: string }> = {
  ap: { ko: '아시아 태평양', ja: 'アジアパシフィック' }, asia: { ko: '아시아', ja: 'アジア' }, us: { ko: '미국', ja: '米国' },
  eu: { ko: '유럽', ja: '欧州' }, europe: { ko: '유럽', ja: '欧州' }, sa: { ko: '남미', ja: '南米' }, ca: { ko: '캐나다', ja: 'カナダ' },
  me: { ko: '중동', ja: '中東' }, af: { ko: '아프리카', ja: 'アフリカ' }, australia: { ko: '호주', ja: 'オーストラリア' },
  northeast: { ko: '북동부', ja: '北東' }, southeast: { ko: '동남부', ja: '東南' }, northwest: { ko: '북서부', ja: '北西' },
  southwest: { ko: '남서부', ja: '南西' }, north: { ko: '북부', ja: '北部' }, south: { ko: '남부', ja: '南部' },
  east: { ko: '동부', ja: '東部' }, west: { ko: '서부', ja: '西部' }, central: { ko: '중부', ja: '中部' },
}
const REGION_RE = /(?<![A-Za-z0-9-])(?:ap|us|eu|sa|ca|me|af|asia|europe|australia)-(?:north|south|east|west|central|northeast|southeast|northwest|southwest)-?\d(?![A-Za-z0-9-])/gi

/** 받침(ㄴ)으로 끝나는 말 뒤의 조사 */
const AFTER_BATCHIM: Record<string, string> = { 와: '과', 를: '을', 가: '이', 는: '은', 로: '으로' }

const LETTERS = {
  ko: { A: '에이', B: '비', C: '씨', D: '디', E: '이', F: '에프', G: '지', H: '에이치', I: '아이', J: '제이', K: '케이', L: '엘', M: '엠', N: '엔', O: '오', P: '피', Q: '큐', R: '알', S: '에스', T: '티', U: '유', V: '브이', W: '더블유', X: '엑스', Y: '와이', Z: '지', 0: '제로', 1: '원', 2: '투', 3: '쓰리', 4: '포', 5: '파이브', 6: '식스', 7: '세븐', 8: '에이트', 9: '나인' },
  ja: { A: 'エー', B: 'ビー', C: 'シー', D: 'ディー', E: 'イー', F: 'エフ', G: 'ジー', H: 'エイチ', I: 'アイ', J: 'ジェー', K: 'ケー', L: 'エル', M: 'エム', N: 'エヌ', O: 'オー', P: 'ピー', Q: 'キュー', R: 'アール', S: 'エス', T: 'ティー', U: 'ユー', V: 'ブイ', W: 'ダブリュー', X: 'エックス', Y: 'ワイ', Z: 'ゼット', 0: 'ゼロ', 1: 'ワン', 2: 'ツー', 3: 'スリー', 4: 'フォー', 5: 'ファイブ', 6: 'シックス', 7: 'セブン', 8: 'エイト', 9: 'ナイン' },
} as Record<'ko' | 'ja', Record<string, string>>

const ACRONYMS_EN = new Set(['db', 'tls', 'dns', 'mtu', 'iam', 'cidr', 'wal', 'cdc', 'lsn', 'api', 'sdk', 'vpc'])
const NOT_LATIN_BEFORE = '(?<![A-Za-z0-9_])'
const NOT_LATIN_AFTER = '(?![A-Za-z0-9_])'
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const TERM_KEYS = Object.keys(TERMS).sort((a, b) => b.length - a.length)
const TERM_RE = new RegExp(`${NOT_LATIN_BEFORE}(${TERM_KEYS.map(escape).join('|')})${NOT_LATIN_AFTER}`, 'gi')
const TERM_OF = new Map(TERM_KEYS.map(key => [key.toLowerCase(), TERMS[key]]))

/** 철자로 읽기: "VPC" → "브이 피 씨"(한국어는 띄어서, 일본어는 붙여서) */
export function spell(token: string, lang: 'ko' | 'ja'): string {
  const letters = [...token.toUpperCase()].map(char => LETTERS[lang][char] ?? char)
  return letters.join(lang === 'ko' ? ' ' : '')
}

function codePhrase(code: string, lang: SpeechLang): string {
  const known = CODES[code.toLowerCase()]
  if (known) return known[lang] ?? known.en
  const words = code.toLowerCase().split(/[_-]+/).filter(Boolean)
  if (lang === 'en') return words.map(word => ACRONYMS_EN.has(word) ? word.toUpperCase() : word).join(' ')
  // 모르는 낱말: 짧으면 철자, 길면 그대로(합성기가 읽어 본다)
  return words.map(word => WORDS[word]?.[lang] ?? (word.length <= 5 ? spell(word, lang) : word)).join(lang === 'ko' ? ' ' : '')
}

/**
 * 화면에도 보일 코드 이름(보고 문구의 {reason}·{label}): 아는 코드는 문구, 모르면 낱말 사전으로 옮기고 모르는 낱말은 그대로 둔다.
 * 약어는 라틴 글자로 남는다(말할 때는 spokenText가 읽어 준다).
 */
export function codeLabel(code: string, lang: SpeechLang): string {
  const known = CODES[code.toLowerCase()]
  if (known) return known[lang] ?? known.en
  const words = code.toLowerCase().split(/[_\s-]+/).filter(Boolean)
  if (lang === 'en') return words.map(word => ACRONYMS_EN.has(word) ? word.toUpperCase() : word).join(' ')
  return words.map(word => WORDS[word]?.[lang] ?? (ACRONYMS_EN.has(word) ? word.toUpperCase() : word)).join(lang === 'ko' ? ' ' : '')
}

function regionPhrase(region: string, lang: SpeechLang): string {
  const key = region.toLowerCase()
  const known = REGIONS[key]
  if (lang === 'en') return known ? `${known.en} region` : region.replace(/-/g, ' ')
  if (known) return lang === 'ko' ? `${known.ko} 리전` : `${known.ja}リージョン`
  const parts = key.replace(/(\D)(\d)$/, '$1-$2').split('-')
  const words = parts.map(part => /^\d$/.test(part) ? part : REGION_WORDS[part]?.[lang] ?? spell(part, lang))
  return lang === 'ko' ? `${words.join(' ')} 리전` : `${words.join('')}リージョン`
}

const UNITS: Record<string, { ko: string; ja: string; en: string }> = {
  ms: { ko: '밀리초', ja: 'ミリ秒', en: 'milliseconds' }, s: { ko: '초', ja: '秒', en: 'seconds' },
  KiB: { ko: '키비바이트', ja: 'キビバイト', en: 'kibibytes' }, MiB: { ko: '메비바이트', ja: 'メビバイト', en: 'mebibytes' },
  GiB: { ko: '기비바이트', ja: 'ギビバイト', en: 'gibibytes' }, KB: { ko: '킬로바이트', ja: 'キロバイト', en: 'kilobytes' },
  MB: { ko: '메가바이트', ja: 'メガバイト', en: 'megabytes' }, GB: { ko: '기가바이트', ja: 'ギガバイト', en: 'gigabytes' },
  B: { ko: '바이트', ja: 'バイト', en: 'bytes' },
}

/** 합성기에 넘길 말. 화면 문구에는 쓰지 않는다. */
export function spokenText(text: string, lang: SpeechLang): string {
  let value = text
  // 환경 변수 파일
  value = value.replace(new RegExp(`${NOT_LATIN_BEFORE}\\.env(\\.(?:example|sample|template))?${NOT_LATIN_AFTER}`, 'g'), (_, example?: string) => example
    ? { ko: '환경 변수 예시 파일', ja: '環境変数のサンプルファイル', en: 'dot env example' }[lang]
    : { ko: '환경 변수 파일', ja: '環境変数ファイル', en: 'dot env' }[lang])
  // 초당 요청
  value = value.replace(/(\d[\d,.]*)\s*req\/s\b/g, (_, n: string) => ({ ko: `초당 ${n} 요청`, ja: `毎秒${n}リクエスト`, en: `${n} requests per second` }[lang]))
  value = value.replace(/(?<![A-Za-z0-9])req\/s\b/g, { ko: '초당 요청', ja: '毎秒リクエスト', en: 'requests per second' }[lang])
  // 리전
  // 리전("서울 리전")은 받침으로 끝나므로 뒤 조사를 맞춘다(와→과, 를→을 …).
  value = value.replace(new RegExp(REGION_RE.source + (lang === 'ko' ? '(와|과|를|을|가|이|는|은|로|으로)?' : ''), 'gi'),
    (match: string, group: unknown) => {
      const particle = typeof group === 'string' ? group : ''
      const region = particle ? match.slice(0, -particle.length) : match
      return regionPhrase(region, lang) + (particle ? AFTER_BATCHIM[particle] ?? particle : '')
    })
  // 밑줄 코드(ROUTE_NOT_TUNNEL, pods_ready …)
  value = value.replace(/(?<![A-Za-z0-9_.])[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+(?![A-Za-z0-9_])/g, code => codePhrase(code, lang))
  // 하이픈으로 이은 소문자 이름(demo-postgres, k3s-pod-net): 한국어·일본어에서만(영어 문장의 on-prem 등은 그대로)
  if (lang !== 'en') value = value.replace(/(?<![A-Za-z0-9_.-])[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?![A-Za-z0-9_-])/g, name => codePhrase(name, lang))
  if (lang !== 'en') {
    // 모두 아는 낱말인 소문자 영어 묶음("pods ready", "route") → 그 언어 낱말
    value = value.replace(/(?<![A-Za-z0-9_.])[a-z]+(?: [a-z]+)*(?![A-Za-z0-9_])/g, run => {
      const words = run.split(' ')
      return words.every(word => WORDS[word]) ? words.map(word => WORDS[word][lang]).join(lang === 'ko' ? ' ' : '') : run
    })
  }
  // 숫자 뒤 단위·퍼센트
  value = value.replace(/(?<![A-Za-z0-9_.])(\d+(?:[.,]\d+)?)\s*(ms|s|KiB|MiB|GiB|KB|MB|GB|B)(?![A-Za-z0-9])/g, (_, n: string, unit: string) => n + (lang === 'ja' ? '' : ' ') + UNITS[unit][lang])
  value = value.replace(/(\d)\s*%/g, (_, digit: string) => ({ ko: `${digit} 퍼센트`, ja: `${digit}パーセント`, en: `${digit} percent` }[lang]))
  // 분수(n/m): IP·CIDR·LSN(0/3AF…)은 건드리지 않는다.
  value = value.replace(/(?<![\d.\w])(\d+)\s*\/\s*(\d+)(?![\d.\w])/g, (_, n: string, m: string) => ({ ko: `${m}개 중 ${n}개`, ja: `${m}個中${n}個`, en: `${n} of ${m}` }[lang]))
  if (lang === 'en') {
    value = value.replace(TERM_RE, match => TERM_OF.get(match.toLowerCase())?.en ?? match)
    return value.replace(/\s+/g, ' ').trim()
  }
  // 용어 사전
  value = value.replace(TERM_RE, match => TERM_OF.get(match.toLowerCase())![lang])
  // 남은 약어(대문자·숫자 2~5자, 대문자 하나 이상): 철자로
  value = value.replace(/(?<![A-Za-z0-9_])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{2,5}(?![A-Za-z0-9_])/g, token => spell(token, lang))
  // 소문자·숫자 섞인 짧은 이름(dc1, wg0): 철자로
  value = value.replace(/(?<![A-Za-z0-9_.])(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{2,5}(?![A-Za-z0-9_])/g, token => spell(token, lang))
  return value.replace(/ +([,.!?。、])/g, '$1').replace(/\s+/g, ' ').trim()
}
