/**
 * 자칼이 말로 하는 짧은 보고·음성 명령 안내 문구(ko·en·ja). 값은 모두 이벤트에서 채운다({n}·{items}·{next} 등).
 * 화면 문구 사전(lib/i18n)과 따로 두어 여러 화면 작업과 충돌하지 않게 한다. 런타임 import는 순수 모듈뿐(단위 테스트가 직접 읽는다).
 * 규칙
 * - 보고는 한 문장. 두 문장은 두 승인 지점과 실패, 단계 시작 안내에서만.
 * - 단계 끝은 "{next}(으)로 갈까요?"로 묻고 "진행해·좋아"를 기다린다. {next}는 단계 순서에서 고른다.
 * - {items}는 3개까지, 넘으면 "외 N개". 한국어 조사는 (으)로·(은)는·(과)와·(이)가·(을)를 표시로 쓰고 앞 글자의 받침으로 고른다.
 * - {reason}·{label}이 코드면 'code:<코드>'로 넣는다(읽을 수 있는 문구로 바꾼다. 날 코드를 말하지 않는다).
 */
import { codeLabel } from '../tts/pronounce.ts'

export type VoiceLang = 'ko' | 'en' | 'ja'
/** 값: 숫자·글·사전 키(stage.data 등)·'code:<코드>', 또는 그 목록(목록은 3개까지 + "외 N개"로 읽는다) */
export type VoiceParams = Record<string, string | number | string[]>

const ko = {
  // ---- 단계 시작 안내(화면이 단계를 열 때. 샌드박스는 테스트 수를 받은 뒤 엔진이 말한다) ----
  'r.start.analysis': '원본 분석을 시작합니다.',
  'r.start.rehearsal': '샌드박스 검증을 시작합니다. 테스트 {n}개.',
  'r.start.rehearsalPlain': '샌드박스 검증을 시작합니다.',
  'r.start.planning': '이전 계획을 세웁니다.',
  'r.start.approval': '대상 인프라 생성 승인입니다.',
  'r.start.provisioning': '대상 인프라를 구축합니다.',
  'r.start.data': '데이터 이전을 시작합니다. 경로부터 검사합니다.',
  'r.start.traffic': '트래픽 이전을 시작합니다.',
  'r.start.cutover': 'DB 전환 승인입니다.',
  'r.migration.done': '마이그레이션 완료. 보고서를 확인해 주세요.',
  // ---- 분석: 스캔 흐름(인프라·코드)이 모두 끝날 때 찾은 것을 말한다 ----
  'r.analysis.scanDone.infrastructure': '인프라에서 {items} 발견.',
  'r.analysis.scanDone.code': '코드에서 {items} 발견.',
  'r.analysis.scanEmpty.infrastructure': '인프라 스캔 완료.',
  'r.analysis.scanEmpty.code': '코드 스캔 완료.',
  'r.analysis.done': '분석 완료. {next}(으)로 갈까요?',
  'item.vpc': 'VPC', 'item.subnet': '서브넷', 'item.security_group': '보안 그룹', 'item.eks_cluster': 'EKS 클러스터', 'item.node': '노드',
  'item.alb': 'ALB', 'item.nat_gateway': 'NAT 게이트웨이', 'item.ebs_gb': 'EBS 볼륨', 'item.s3_bucket': 'S3 버킷', 'item.iam_role': 'IAM 역할',
  'item.manifests': '매니페스트', 'item.services': '서비스', 'item.statefulsets': '스테이트풀셋', 'item.db_driver': 'DB 드라이버',
  'item.s3_sdk': 'S3 SDK 호출', 'item.env_keys': '환경 변수', 'item.health_endpoint': '상태 확인 경로',
  'item.ec2': 'EC2', 'item.postgres': 'PostgreSQL', 'item.s3': 'S3', 'item.network': '네트워크', 'item.iam': 'IAM',
  'item.database': 'DB 드라이버', 'item.sdk': 'AWS SDK 호출', 'item.auth': '인증 설정', 'item.env': '환경 변수', 'item.compose': '컨테이너 구성', 'item.app': '앱',
  // ---- 샌드박스 ----
  'r.sandbox.fix': '수정 {n}건 적용.',
  'r.sandbox.attemptFail': '{attempt}차 실패. {cls} 문제를 고칩니다.',
  'r.sandbox.review': '{n}회 실패. 다시 시도할까요?',
  'r.sandbox.failed': '샌드박스 검증 실패.',
  'r.sandbox.passed': '검증 통과. {next}(으)로 갈까요?',
  'cls.SPEC': '명세', 'cls.CODE': '코드', 'cls.BUILD': '빌드', 'cls.RENDER': '렌더링', 'cls.INFRA': '환경',
  // ---- 계획 ----
  'r.plan.mapping': '그대로 {direct}개, 설정 변경 {diff}개.',
  'r.plan.keep': '{items}(은)는 원본에 둡니다.',
  'r.plan.pinned': '검증한 이미지로 고정.',
  'r.plan.env': '환경 변수 {n}개를 Secret으로 연결.',
  'r.plan.ready': '계획 완료. {next}(으)로 갈까요?',
  'step.network': '네트워크', 'step.compute': '컴퓨팅', 'step.database': 'DB', 'step.storage': 'S3 버킷', 'step.db-code': 'DB 연결 코드', 'step.s3-code': 'S3 호출 코드',
  // ---- 승인(대상 인프라 생성) ----
  'r.approval.facts': '만들 리소스, 원본에 남는 항목, 비용을 확인해 주세요.',
  'r.approval.warn': '확인할 항목 {n}건. {first}.',
  'r.approval.ask': "맞으면 '승인'이라고 해 주세요.",
  'r.approval.delivered': '승인 전달. 구축을 시작합니다.',
  'r.approval.failed': '승인 전달 실패. 다시 승인해 주세요.',
  'r.approval.blocked': '지금은 승인할 수 없습니다.',
  // ---- 구축 ----
  'r.prov.creating': '{name} 생성 중.',
  'r.prov.ready': '{name} 생성 완료.',
  'r.prov.fail': '{name} 생성 실패.',
  'r.prov.check': '{check} 확인.',
  'r.prov.checkFail': '{check} 확인 실패.',
  'r.prov.done': '구축 완료. {next}(으)로 갈까요?',
  'res.network': '네트워크', 'res.cluster': '클러스터', 'res.db': 'DB', 'res.app': '앱', 'res.lb': '로드 밸런서', 'res.cert': '인증서',
  'res.agent': '에이전트', 'res.relay': '릴레이',
  'check.pods_ready': '파드 준비', 'check.db_connect': 'DB 연결', 'check.app_health': '앱 상태', 'check.retest': '재검증',
  // ---- 데이터 ----
  'r.data.check.cidr': 'CIDR 충돌 없음.',
  'r.data.check.route': '터널 경로 확인.',
  'r.data.check.dbPath': '원본 DB 연결 확인.',
  'r.data.check.transfer': '대량 전송 통과.',
  'r.data.preflightPass': '사전 검사 통과. 초기 복사를 시작합니다.',
  'r.data.preflightFail': '{reason}. 시작을 막았습니다.',
  'r.data.tables': '테이블 {m}개 중 {n}개 복사.',
  'r.data.copyDone': '초기 복사 완료. 변경분을 따라잡습니다.',
  'r.data.lagZero': '복제 지연 0. {next}(으)로 갈까요?',
  'r.data.verified': '체크섬 일치.',
  'r.data.verifyFail': '데이터 정합성 확인 실패.',
  // ---- 트래픽 ----
  'r.traffic.prepareFail': '트래픽 사전 확인 실패.',
  'r.traffic.step': '{p}퍼센트 전환. {s}초 관찰합니다.',
  'r.traffic.stepShort': '{p}퍼센트 전환.',
  'r.traffic.gate': '{p}퍼센트 통과. 실패 {f}건.',
  'r.traffic.rollback': '기준 초과. 원본으로 되돌렸습니다.',
  'r.traffic.rollbackP99': 'p99가 {p}밀리초로 기준을 넘어 원본으로 되돌렸습니다.',
  'r.traffic.rollbackFailed': '실패 요청 {n}건이 나와 원본으로 되돌렸습니다.',
  'r.traffic.rollbackRequests': '요청이 {n}건뿐이라 판단 못 해 원본으로 되돌렸습니다.',
  'r.traffic.idle': '사용자 트래픽이 없어 합성 요청 {n}건으로 확인했습니다.',
  'r.traffic.done': '트래픽 이전 완료. {next}(으)로 갈까요?',
  // ---- DB 전환(두 번째 승인과 실행) ----
  'r.cutover.facts': '전환 중 쓰기가 약 {ms}밀리초 멈춥니다. 요청은 실패하지 않습니다.',
  'r.cutover.factsShort': '전환 중 쓰기가 잠깐 멈춥니다. 요청은 실패하지 않습니다.',
  'r.cutover.rollback': '문제가 생기면 원본으로 되돌릴 수 있습니다.',
  'r.cutover.ask': "진행하려면 '승인'이라고 해 주세요.",
  'r.cutover.paused': '쓰기를 잠시 멈췄습니다.',
  'r.cutover.pause': '전환 완료. 쓰기 중단 {value}.',
  'r.cutover.verify': '결과를 검증합니다.',
  'r.cutover.refused': '{reason}. 원본으로 되돌렸습니다.',
  'r.cutover.fail': '{label} 검증 실패.',
  'r.cutover.done': '체크섬 일치. 검증 완료.',
  'r.cutover.doneShort': '검증 완료.',
  // ---- 오류 ----
  'r.error': '{phase} 오류. {reason}.',
  // ---- 음성 명령 응답 ----
  'c.paused': '보고 멈춤.',
  'c.resumed': '보고 재개.',
  'c.nothing': '보고할 내용 없음.',
  'c.notYet': '아직 다음 단계로 못 갑니다.',
  'c.noAction': '이 화면에선 안 됩니다.',
  'c.notApproval': '승인할 내용이 없습니다.',
  'c.confirmRollback': "원본으로 되돌릴까요? '확인'이라고 해 주세요.",
  'c.confirmInject': "장애를 넣어 볼까요? '확인'이라고 해 주세요.",
  'c.confirmCancel': "이전을 취소할까요? '확인'이라고 해 주세요.",
  'c.confirmed': '진행합니다.',
  'c.denied': '요청 취소.',
  'c.revise': '계획을 다시 세웁니다.',
  'c.retry': '다시 시도합니다.',
  'c.ok': '네.',
  'c.wake': '네, 말씀하세요.',
  'c.next': '네, 넘어갈게요.',
  // ---- 지금 어디야: "지금 데이터 이전. 테이블 6개 중 4개." ----
  's.stage': '지금 {stage}.',
  's.analysis': '스캔 {m}개 중 {n}개.',
  's.rehearsal': '{attempt}차 시도 중.',
  's.provisioning': '리소스 {m}개 중 {n}개.',
  's.data': '테이블 {m}개 중 {n}개.',
  's.traffic': '트래픽 {p}퍼센트.',
  'stage.intro': '시작', 'stage.setup': '설정', 'stage.analysis': '분석', 'stage.rehearsal': '샌드박스 검증', 'stage.planning': '계획 수립',
  'stage.approval': '승인', 'stage.provisioning': '구축', 'stage.data': '데이터 이전', 'stage.traffic': '트래픽 이전', 'stage.cutover': 'DB 전환', 'stage.report': '완료 리포트',
  'phase.analysis': '분석', 'phase.build': '샌드박스', 'phase.planning': '계획', 'phase.awaiting_approval': '승인', 'phase.provisioning': '구축',
  'phase.data_copy': '데이터', 'phase.traffic': '트래픽', 'phase.verification': '검증',
  'list.more': '외 {n}개',
  // ---- 화면 아래 안내(말할 수 있는 문구) ----
  'h.label': '말해 보세요',
  'h.advance': '다음', 'h.start': '시작하자', 'h.approve': '승인', 'h.pause': '잠깐', 'h.resume': '계속해', 'h.repeat': '다시 말해줘', 'h.status': '지금 어디야',
  'h.rollback': '롤백해', 'h.inject': '장애 넣어 봐', 'h.retry': '다시 시도해', 'h.revise': '계획 수정해', 'h.cancel': '취소해', 'h.confirm': '확인',
}

export type VoiceKey = keyof typeof ko

const en: Record<VoiceKey, string> = {
  'r.start.analysis': 'Starting source analysis.',
  'r.start.rehearsal': 'Starting the sandbox check. {n} tests.',
  'r.start.rehearsalPlain': 'Starting the sandbox check.',
  'r.start.planning': 'Building the migration plan.',
  'r.start.approval': 'Approval to create the target infrastructure.',
  'r.start.provisioning': 'Building the target infrastructure.',
  'r.start.data': 'Starting data migration. Checking the path first.',
  'r.start.traffic': 'Starting traffic migration.',
  'r.start.cutover': 'Approval for the DB switch.',
  'r.migration.done': 'Migration complete. Please check the report.',
  'r.analysis.scanDone.infrastructure': 'Found {items} in the infrastructure.',
  'r.analysis.scanDone.code': 'Found {items} in the code.',
  'r.analysis.scanEmpty.infrastructure': 'Infrastructure scan complete.',
  'r.analysis.scanEmpty.code': 'Code scan complete.',
  'r.analysis.done': 'Analysis complete. Go to {next}?',
  'item.vpc': 'VPC', 'item.subnet': 'subnets', 'item.security_group': 'security groups', 'item.eks_cluster': 'EKS cluster', 'item.node': 'nodes',
  'item.alb': 'ALB', 'item.nat_gateway': 'NAT gateway', 'item.ebs_gb': 'EBS volumes', 'item.s3_bucket': 'S3 bucket', 'item.iam_role': 'IAM roles',
  'item.manifests': 'manifests', 'item.services': 'services', 'item.statefulsets': 'StatefulSets', 'item.db_driver': 'DB driver',
  'item.s3_sdk': 'S3 SDK calls', 'item.env_keys': 'environment variables', 'item.health_endpoint': 'health endpoint',
  'item.ec2': 'EC2', 'item.postgres': 'PostgreSQL', 'item.s3': 'S3', 'item.network': 'network', 'item.iam': 'IAM',
  'item.database': 'DB driver', 'item.sdk': 'AWS SDK calls', 'item.auth': 'auth settings', 'item.env': 'environment variables', 'item.compose': 'container setup', 'item.app': 'app',
  'r.sandbox.fix': '{n} fixes applied.',
  'r.sandbox.attemptFail': 'Attempt {attempt} failed. Fixing the {cls} issue.',
  'r.sandbox.review': '{n} failures. Try again?',
  'r.sandbox.failed': 'Sandbox check failed.',
  'r.sandbox.passed': 'Check passed. Go to {next}?',
  'cls.SPEC': 'spec', 'cls.CODE': 'code', 'cls.BUILD': 'build', 'cls.RENDER': 'render', 'cls.INFRA': 'environment',
  'r.plan.mapping': '{direct} as is, {diff} with config changes.',
  'r.plan.keep': '{items} stay on the source.',
  'r.plan.pinned': 'Pinned to the verified image.',
  'r.plan.env': '{n} environment variables linked as Secrets.',
  'r.plan.ready': 'Plan complete. Go to {next}?',
  'step.network': 'network', 'step.compute': 'compute', 'step.database': 'DB', 'step.storage': 'S3 bucket', 'step.db-code': 'DB connection code', 'step.s3-code': 'S3 call code',
  'r.approval.facts': 'Please review the resources to create, what stays on the source, and the cost.',
  'r.approval.warn': '{n} items to check. {first}.',
  'r.approval.ask': "If it looks right, say 'approve'.",
  'r.approval.delivered': 'Approval delivered. Starting the build.',
  'r.approval.failed': 'Approval delivery failed. Please approve again.',
  'r.approval.blocked': "Can't approve right now.",
  'r.prov.creating': 'Creating {name}.',
  'r.prov.ready': '{name} created.',
  'r.prov.fail': '{name} creation failed.',
  'r.prov.check': '{check} confirmed.',
  'r.prov.checkFail': '{check} check failed.',
  'r.prov.done': 'Build complete. Go to {next}?',
  'res.network': 'network', 'res.cluster': 'cluster', 'res.db': 'DB', 'res.app': 'app', 'res.lb': 'load balancer', 'res.cert': 'certificate',
  'res.agent': 'agent', 'res.relay': 'relay',
  'check.pods_ready': 'Pods ready', 'check.db_connect': 'DB connection', 'check.app_health': 'App health', 'check.retest': 'Retest',
  'r.data.check.cidr': 'No CIDR overlap.',
  'r.data.check.route': 'Tunnel route confirmed.',
  'r.data.check.dbPath': 'Source DB connection confirmed.',
  'r.data.check.transfer': 'Bulk transfer passed.',
  'r.data.preflightPass': 'Preflight passed. Starting the initial copy.',
  'r.data.preflightFail': '{reason}. Start blocked.',
  'r.data.tables': '{n} of {m} tables copied.',
  'r.data.copyDone': 'Initial copy complete. Catching up on changes.',
  'r.data.lagZero': 'Replication lag zero. Go to {next}?',
  'r.data.verified': 'Checksums match.',
  'r.data.verifyFail': 'Data consistency check failed.',
  'r.traffic.prepareFail': 'Traffic preflight failed.',
  'r.traffic.step': '{p} percent switched. Watching for {s} seconds.',
  'r.traffic.stepShort': '{p} percent switched.',
  'r.traffic.gate': '{p} percent passed. {f} failures.',
  'r.traffic.rollback': 'Threshold exceeded. Switched back to the source.',
  'r.traffic.rollbackP99': 'p99 was {p} milliseconds, over the limit, so I switched back.',
  'r.traffic.rollbackFailed': '{n} requests failed, so I switched back to the source.',
  'r.traffic.rollbackRequests': 'Only {n} requests, so I could not judge and switched back.',
  'r.traffic.idle': 'No user traffic, so I checked with {n} test requests.',
  'r.traffic.done': 'Traffic migration complete. Go to {next}?',
  'r.cutover.facts': 'Writes pause for about {ms} milliseconds during the switch. No requests fail.',
  'r.cutover.factsShort': 'Writes pause briefly during the switch. No requests fail.',
  'r.cutover.rollback': 'If anything goes wrong, we can switch back to the source.',
  'r.cutover.ask': "To proceed, say 'approve'.",
  'r.cutover.paused': 'Writes paused.',
  'r.cutover.pause': 'Switch complete. Write pause {value}.',
  'r.cutover.verify': 'Verifying the results.',
  'r.cutover.refused': '{reason}. Switched back to the source.',
  'r.cutover.fail': '{label} check failed.',
  'r.cutover.done': 'Checksums match. Verification complete.',
  'r.cutover.doneShort': 'Verification complete.',
  'r.error': '{phase} error. {reason}.',
  'c.paused': 'Reports paused.',
  'c.resumed': 'Reports resumed.',
  'c.nothing': 'Nothing to report.',
  'c.notYet': "Can't go to the next step yet.",
  'c.noAction': 'Not available on this screen.',
  'c.notApproval': 'Nothing to approve.',
  'c.confirmRollback': "Switch back to the source? Say 'confirm'.",
  'c.confirmInject': "Inject a failure? Say 'confirm'.",
  'c.confirmCancel': "Cancel the migration? Say 'confirm'.",
  'c.confirmed': 'Proceeding.',
  'c.denied': 'Request cancelled.',
  'c.revise': 'Replanning.',
  'c.retry': 'Retrying.',
  'c.ok': 'Okay.',
  'c.wake': "Yes? I'm listening.",
  'c.next': 'Okay, moving on.',
  's.stage': 'Now: {stage}.',
  's.analysis': '{n} of {m} scans.',
  's.rehearsal': 'Attempt {attempt}.',
  's.provisioning': '{n} of {m} resources.',
  's.data': '{n} of {m} tables.',
  's.traffic': 'Traffic at {p} percent.',
  'stage.intro': 'start', 'stage.setup': 'setup', 'stage.analysis': 'analysis', 'stage.rehearsal': 'the sandbox check', 'stage.planning': 'planning',
  'stage.approval': 'approval', 'stage.provisioning': 'provisioning', 'stage.data': 'data migration', 'stage.traffic': 'traffic migration', 'stage.cutover': 'the DB switch', 'stage.report': 'the completion report',
  'phase.analysis': 'Analysis', 'phase.build': 'Sandbox', 'phase.planning': 'Planning', 'phase.awaiting_approval': 'Approval', 'phase.provisioning': 'Provisioning',
  'phase.data_copy': 'Data', 'phase.traffic': 'Traffic', 'phase.verification': 'Verification',
  'list.more': '{n} more',
  'h.label': 'Try saying',
  'h.advance': 'next', 'h.start': "let's start", 'h.approve': 'approve', 'h.pause': 'wait', 'h.resume': 'continue', 'h.repeat': 'say again', 'h.status': 'where are we',
  'h.rollback': 'roll back', 'h.inject': 'inject failure', 'h.retry': 'try again', 'h.revise': 'revise plan', 'h.cancel': 'cancel', 'h.confirm': 'confirm',
}

const ja: Record<VoiceKey, string> = {
  'r.start.analysis': '移行元の分析を始めます。',
  'r.start.rehearsal': 'サンドボックス検証を始めます。テスト{n}件。',
  'r.start.rehearsalPlain': 'サンドボックス検証を始めます。',
  'r.start.planning': '移行計画を作成します。',
  'r.start.approval': '移行先インフラ作成の承認です。',
  'r.start.provisioning': '移行先インフラを構築します。',
  'r.start.data': 'データ移行を始めます。まず経路を確認します。',
  'r.start.traffic': 'トラフィック移行を始めます。',
  'r.start.cutover': 'DB切り替えの承認です。',
  'r.migration.done': '移行完了。レポートを確認してください。',
  'r.analysis.scanDone.infrastructure': 'インフラで{items}を発見。',
  'r.analysis.scanDone.code': 'コードで{items}を発見。',
  'r.analysis.scanEmpty.infrastructure': 'インフラスキャン完了。',
  'r.analysis.scanEmpty.code': 'コードスキャン完了。',
  'r.analysis.done': '分析完了。{next}に進みますか？',
  'item.vpc': 'VPC', 'item.subnet': 'サブネット', 'item.security_group': 'セキュリティグループ', 'item.eks_cluster': 'EKSクラスター', 'item.node': 'ノード',
  'item.alb': 'ALB', 'item.nat_gateway': 'NATゲートウェイ', 'item.ebs_gb': 'EBSボリューム', 'item.s3_bucket': 'S3バケット', 'item.iam_role': 'IAMロール',
  'item.manifests': 'マニフェスト', 'item.services': 'サービス', 'item.statefulsets': 'ステートフルセット', 'item.db_driver': 'DBドライバー',
  'item.s3_sdk': 'S3 SDK呼び出し', 'item.env_keys': '環境変数', 'item.health_endpoint': 'ヘルスチェック経路',
  'item.ec2': 'EC2', 'item.postgres': 'PostgreSQL', 'item.s3': 'S3', 'item.network': 'ネットワーク', 'item.iam': 'IAM',
  'item.database': 'DBドライバー', 'item.sdk': 'AWS SDK呼び出し', 'item.auth': '認証設定', 'item.env': '環境変数', 'item.compose': 'コンテナ構成', 'item.app': 'アプリ',
  'r.sandbox.fix': '修正{n}件適用。',
  'r.sandbox.attemptFail': '{attempt}回目失敗。{cls}の問題を直します。',
  'r.sandbox.review': '{n}回失敗。再試行しますか？',
  'r.sandbox.failed': 'サンドボックス検証失敗。',
  'r.sandbox.passed': '検証合格。{next}に進みますか？',
  'cls.SPEC': '仕様', 'cls.CODE': 'コード', 'cls.BUILD': 'ビルド', 'cls.RENDER': 'レンダリング', 'cls.INFRA': '環境',
  'r.plan.mapping': 'そのまま{direct}件、設定変更{diff}件。',
  'r.plan.keep': '{items}は移行元に残します。',
  'r.plan.pinned': '検証済みイメージに固定。',
  'r.plan.env': '環境変数{n}個をSecretとして接続。',
  'r.plan.ready': '計画完了。{next}に進みますか？',
  'step.network': 'ネットワーク', 'step.compute': 'コンピュート', 'step.database': 'DB', 'step.storage': 'S3バケット', 'step.db-code': 'DB接続コード', 'step.s3-code': 'S3呼び出しコード',
  'r.approval.facts': '作成するリソース、移行元に残る項目、コストを確認してください。',
  'r.approval.warn': '確認事項{n}件。{first}。',
  'r.approval.ask': '問題なければ「承認」と言ってください。',
  'r.approval.delivered': '承認を伝達。構築を始めます。',
  'r.approval.failed': '承認の伝達に失敗。もう一度承認してください。',
  'r.approval.blocked': '今は承認できません。',
  'r.prov.creating': '{name}を作成中。',
  'r.prov.ready': '{name}の作成完了。',
  'r.prov.fail': '{name}の作成失敗。',
  'r.prov.check': '{check}を確認。',
  'r.prov.checkFail': '{check}の確認失敗。',
  'r.prov.done': '構築完了。{next}に進みますか？',
  'res.network': 'ネットワーク', 'res.cluster': 'クラスター', 'res.db': 'DB', 'res.app': 'アプリ', 'res.lb': 'ロードバランサー', 'res.cert': '証明書',
  'res.agent': 'エージェント', 'res.relay': 'リレー',
  'check.pods_ready': 'ポッド準備', 'check.db_connect': 'DB接続', 'check.app_health': 'アプリの状態', 'check.retest': '再テスト',
  'r.data.check.cidr': 'CIDRの衝突なし。',
  'r.data.check.route': 'トンネル経路を確認。',
  'r.data.check.dbPath': '移行元DBへの接続を確認。',
  'r.data.check.transfer': '大量転送合格。',
  'r.data.preflightPass': '事前確認合格。初期コピーを始めます。',
  'r.data.preflightFail': '{reason}。開始を止めました。',
  'r.data.tables': 'テーブル{m}個中{n}個コピー。',
  'r.data.copyDone': '初期コピー完了。差分を追いかけます。',
  'r.data.lagZero': '複製遅延ゼロ。{next}に進みますか？',
  'r.data.verified': 'チェックサム一致。',
  'r.data.verifyFail': 'データ整合性の確認失敗。',
  'r.traffic.prepareFail': 'トラフィック事前確認失敗。',
  'r.traffic.step': '{p}パーセント切り替え。{s}秒観察します。',
  'r.traffic.stepShort': '{p}パーセント切り替え。',
  'r.traffic.gate': '{p}パーセント合格。失敗{f}件。',
  'r.traffic.rollback': '基準超過。移行元に戻しました。',
  'r.traffic.rollbackP99': 'p99が{p}ミリ秒で基準を超えたため、移行元に戻しました。',
  'r.traffic.rollbackFailed': '失敗リクエストが{n}件出たため、移行元に戻しました。',
  'r.traffic.rollbackRequests': 'リクエストが{n}件だけで判断できず、移行元に戻しました。',
  'r.traffic.idle': 'ユーザートラフィックがないため、テストリクエスト{n}件で確認しました。',
  'r.traffic.done': 'トラフィック移行完了。{next}に進みますか？',
  'r.cutover.facts': '切り替え中、書き込みが約{ms}ミリ秒止まります。リクエストは失敗しません。',
  'r.cutover.factsShort': '切り替え中、書き込みが一時的に止まります。リクエストは失敗しません。',
  'r.cutover.rollback': '問題があれば移行元に戻せます。',
  'r.cutover.ask': '進めるなら「承認」と言ってください。',
  'r.cutover.paused': '書き込みを一時停止しました。',
  'r.cutover.pause': '切り替え完了。書き込み停止{value}。',
  'r.cutover.verify': '結果を検証します。',
  'r.cutover.refused': '{reason}。移行元に戻しました。',
  'r.cutover.fail': '{label}の検証失敗。',
  'r.cutover.done': 'チェックサム一致。検証完了。',
  'r.cutover.doneShort': '検証完了。',
  'r.error': '{phase}エラー。{reason}。',
  'c.paused': '報告停止。',
  'c.resumed': '報告再開。',
  'c.nothing': '報告なし。',
  'c.notYet': 'まだ次に進めません。',
  'c.noAction': 'この画面ではできません。',
  'c.notApproval': '承認対象なし。',
  'c.confirmRollback': '移行元に戻しますか？「確認」と言ってください。',
  'c.confirmInject': '障害を入れますか？「確認」と言ってください。',
  'c.confirmCancel': '移行を取り消しますか？「確認」と言ってください。',
  'c.confirmed': '実行します。',
  'c.denied': 'リクエスト取り消し。',
  'c.revise': '計画を作り直します。',
  'c.retry': '再試行します。',
  'c.ok': 'はい。',
  'c.wake': 'はい、どうぞ。',
  'c.next': 'はい、次に進みます。',
  's.stage': '今は{stage}。',
  's.analysis': 'スキャン{m}個中{n}個。',
  's.rehearsal': '{attempt}回目。',
  's.provisioning': 'リソース{m}個中{n}個。',
  's.data': 'テーブル{m}個中{n}個。',
  's.traffic': 'トラフィック{p}パーセント。',
  'stage.intro': '開始', 'stage.setup': '設定', 'stage.analysis': '分析', 'stage.rehearsal': 'サンドボックス検証', 'stage.planning': '計画作成',
  'stage.approval': '承認', 'stage.provisioning': '構築', 'stage.data': 'データ移行', 'stage.traffic': 'トラフィック移行', 'stage.cutover': 'DB切り替え', 'stage.report': '完了レポート',
  'phase.analysis': '分析', 'phase.build': 'サンドボックス', 'phase.planning': '計画', 'phase.awaiting_approval': '承認', 'phase.provisioning': '構築',
  'phase.data_copy': 'データ', 'phase.traffic': 'トラフィック', 'phase.verification': '検証',
  'list.more': 'ほか{n}個',
  'h.label': '話しかけてみて',
  'h.advance': '次へ', 'h.start': '始めよう', 'h.approve': '承認', 'h.pause': 'ちょっと待って', 'h.resume': '続けて', 'h.repeat': 'もう一度', 'h.status': '今どこ',
  'h.rollback': 'ロールバックして', 'h.inject': '障害を入れて', 'h.retry': 'もう一回', 'h.revise': '計画を直して', 'h.cancel': 'キャンセル', 'h.confirm': '確認',
}

export const VOICE_MESSAGES: Record<VoiceLang, Record<VoiceKey, string>> = { ko, en, ja }

/** 목록으로 읽을 최대 개수(넘으면 "외 N개") */
export const LIST_MAX = 3

// ---- 한국어 조사: 앞 글자의 받침으로 고른다 ----
// 라틴 글자·숫자는 읽는 소리로 본다(L·M·N·R, 0·1·3·6·7·8은 받침이 있고, L·R·1·7·8은 ㄹ).
const LATIN_FINAL: Record<string, 'none' | 'rieul' | 'other'> = { L: 'rieul', M: 'other', N: 'other', R: 'rieul', '0': 'other', '1': 'rieul', '3': 'other', '6': 'other', '7': 'rieul', '8': 'rieul' }
function finalOf(word: string): 'none' | 'rieul' | 'other' {
  const char = [...word.replace(/[\s.,)'"\]]+$/, '')].pop() ?? ''
  const code = char.charCodeAt(0)
  if (code >= 0xac00 && code <= 0xd7a3) {
    const final = (code - 0xac00) % 28
    return final === 0 ? 'none' : final === 8 ? 'rieul' : 'other'
  }
  return LATIN_FINAL[char.toUpperCase()] ?? 'none'
}
/** "샌드박스 검증(으)로" → "샌드박스 검증으로", "S3 버킷(은)는" → "S3 버킷은" */
export function resolveParticles(text: string): string {
  return text.replace(/([^\s(]?)\((으|은|과|이|을)\)(로|는|와|가|를)/g, (_, before: string, withBatchim: string, plain: string) => {
    const final = finalOf(before)
    const pick = withBatchim === '으' ? (final === 'other' ? '으로' : '로') : final === 'none' ? plain : withBatchim
    return before + pick
  })
}

/** 목록 읽기: 하나 "a", 둘 "a와 b", 셋 "a, b, c", 넘으면 "a, b, c 외 N개" */
export function formatList(lang: VoiceLang, items: string[]): string {
  const shown = items.slice(0, LIST_MAX)
  const rest = items.length - shown.length
  const more = rest > 0 ? VOICE_MESSAGES[lang]['list.more'].replace('{n}', String(rest)) : ''
  if (lang === 'ko') {
    if (shown.length === 2 && !more) return resolveParticles(`${shown[0]}(과)와 ${shown[1]}`)
    return shown.join(', ') + (more ? ' ' + more : '')
  }
  if (lang === 'ja') {
    if (shown.length === 2 && !more) return shown.join('と')
    return shown.join('、') + more
  }
  if (more) return shown.join(', ') + ' and ' + more
  return shown.length <= 2 ? shown.join(' and ') : shown.slice(0, -1).join(', ') + ', and ' + shown[shown.length - 1]
}

function resolveValue(lang: VoiceLang, value: string | number): string {
  if (typeof value !== 'string') return String(value)
  if (value in VOICE_MESSAGES[lang]) return VOICE_MESSAGES[lang][value as VoiceKey]
  if (value.startsWith('code:')) return codeLabel(value.slice(5), lang)
  return value
}

export function voiceText(lang: VoiceLang, key: VoiceKey, params?: VoiceParams): string {
  const template = VOICE_MESSAGES[lang][key] ?? VOICE_MESSAGES.ko[key] ?? ''
  const filled = !params ? template : template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!(name in params)) return match
    const value = params[name]
    // 값이 사전 키(cls.CODE, stage.data …)면 그 언어의 낱말로, 'code:…'면 읽을 수 있는 문구로, 목록이면 "a, b 외 N개"로 바꾼다.
    return Array.isArray(value) ? formatList(lang, value.map(item => resolveValue(lang, item))) : resolveValue(lang, value)
  })
  if (lang === 'ko') return resolveParticles(filled)
  // 영어: 값으로 시작한 문장도 대문자로("network created." → "Network created.")
  return lang === 'en' ? filled.replace(/(^|[.?!]\s+)([a-z])/g, (_, lead: string, char: string) => lead + char.toUpperCase()) : filled
}
