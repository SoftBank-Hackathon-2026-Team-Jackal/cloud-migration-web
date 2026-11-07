# cloud-migration-web

클라우드 마이그레이션 플랫폼의 웹 화면입니다. 분석 → 샌드박스 검증 → 계획 → 승인 → 프로비저닝 → 데이터 이전 → 트래픽 이전 → DB 전환·리포트 흐름을 보여 줍니다.

**기본(목업) 모드에서는 백엔드 없이 화면의 값이 모두 데모 데이터입니다.** 환경변수로 SSE 모드를 켜면 서버가 보내는 이벤트로 같은 화면이 움직입니다. 백엔드는 [cloud-migration-platform](https://github.com/SoftBank-Hackathon-2026-Team-Jackal/cloud-migration-platform)입니다.

## 음성 시연

Chrome 계열 브라우저에서 처음 한 번 `마이크 켜기`를 누르고 권한을 허용합니다. `헤이 자칼`이라고 말하면 `네.`라는 응답과 함께 기본 화면에 구체가 나타납니다. 이때 구체의 파동은 일어나지 않습니다. 이어서 `마이그레이션 시작하자`라고 말하면 `네, 기본 정보를 바탕으로 마이그레이션을 시작하겠습니다.`라고 답하면서 구체가 음성의 실제 음량에 반응하고 분석 화면으로 이동합니다. 마이크 권한이 이미 허용되어 있으면 첫 화면에서 자동으로 호출어를 듣습니다. 음성 인식을 지원하지 않는 브라우저에서는 화면 버튼으로 같은 흐름을 시연할 수 있습니다.

이 첫 명령은 화면에 표시된 고정 데모 프로필 **AWS EKS → GCP GKE**를 사용합니다. 실제 사용자 계정이나 저장된 자격 증명을 읽지 않습니다. 기존 `?stage=` 단계 이동과 `D` 데모 패널도 사용할 수 있습니다.

### 언어 세 가지(화면·말하는·알아듣는)

- **화면 언어**(우측 위): 화면 글자와 자막. **말하는 언어**: 자칼이 읽는 언어(첫 화면 포함). **알아듣는 언어**: Chrome 음성 인식 언어. 위젯의 두 줄에서 따로 고르고 브라우저에 기억합니다(고르지 않으면 모두 화면 언어를 따릅니다).
- 예) 화면 한국어 · 알아듣기 한국어 · 말하기 일본어 → 한국어로 말하면 일본어로 답하고 자막은 한국어입니다.
- "지금 어디야"는 모델(AI)이 켜져 있으면 풀어서 답하고(최대 5초), 없거나 늦으면 고정 문장으로 답합니다. 호출어 인식과 언어 조합은 `npm run test:e2e:voice-wake`, `npm run test:e2e:voice-lang`(가짜 음성 인식)으로 확인합니다.
- 호출어 오인식 점검: 브라우저 콘솔의 `[jackal-voice]` 줄에 인식 언어·들은 말·호출 여부·듣기 시작/끝/오류가 남습니다.

### 자칼의 목소리(한 목소리, 서버 TTS)

모든 말(고정 안내·이벤트 보고·명령 응답·에이전트 답변, ko·en·ja)은 웹 서버의 `/api/tts`가 [Supertonic 3](https://huggingface.co/supertone-oss-archive/supertonic-3)(로컬 ONNX, `onnxruntime-node`)으로 합성한 WAV로 읽습니다. 목소리는 예전 녹음 파일과 같은 `M1`·8단계·속도 1.0입니다. 소리를 분석기에 연결하므로 모든 문장에서 구체가 실제 음량에 반응합니다. 서버를 못 쓰면(모델 없음·오류) 같은 목소리의 녹음 파일(`public/voice/*.mp3`, 고정 문구만) 순서로 대신하고, 둘 다 없으면 소리 없이 글자만 보입니다. 브라우저 음성 합성은 목소리가 달라서 쓰지 않습니다. 처음 듣는 긴 답변은 합성을 30초까지 기다리고, 시간 초과·연결 오류는 한 번 더 받아 봅니다.

```bash
npm run tts:download   # 모델 약 400MB → ~/.cache/supertonic-3 (SUPERTONIC_DIR로 바꿈). 저장소에는 올리지 않음
npm run tts:pregen     # 자주 하는 말(목업 대본에서 나오는 보고 전부 + 명령 응답)을 미리 합성 → .tts-cache/ (--lang ko,en,ja)
```

- `GET /api/tts?text=&lang=ko|en|ja&voice=M1` (또는 POST 같은 JSON) → `audio/wav`. 캐시: 메모리(200개) → 디스크(`TTS_CACHE_DIR`, 기본 `.tts-cache/`, git 제외) → 합성. 헤더 `x-tts-cache`(memory|disk|miss)·`x-tts-ms`. 모델이 없으면 503(`TTS_DISABLED=1`로 일부러 끌 수 있음). `TTS_STEPS`로 품질·속도 조정(기본 8).
- 실측(Apple M4, 다른 작업으로 부하 10~28): 첫 요청(모델 로드+합성) 1.9초, 캐시 없는 짧은 보고 0.8~1.2초(긴 안내 2.2초), 미리 만든 문장 4ms. 한국어 125문장 미리 생성 약 2분.
- 라이선스: 코드 MIT(supertone-inc/supertonic), 모델 BigScience Open RAIL-M([`public/voice/LICENSE-SUPERTONIC.txt`](public/voice/LICENSE-SUPERTONIC.txt)).

### 이벤트에 묶인 말 보고

`src/lib/voice/reports.ts`가 데이터 계층의 이벤트(목업·SSE 같음)를 짧은 명사형 보고로 바꿉니다: 예) `인프라 스캔 완료`, `코드에서 DB 드라이버 확인`, `리소스 3/6 준비`, `테이블 2/4 복사`, `트래픽 50퍼센트 전달`(정책의 전환 비율), `트래픽 이전 완료`, `게이트 실패. 롤백 완료`. 분석은 항목마다가 아니라 스캔이 끝날 때, 진행은 정확한 n/m(리소스·테스트·테이블)으로만 말하고 퍼센트·개수를 지어내지 않습니다. 개수는 이벤트에 있을 때만, 비용 문장은 없습니다. DB 전환의 쓰기 중단은 결과(`cutover.result`)가 온 뒤 한 번 말합니다. 문구는 `src/lib/voice/messages.ts`(ko·en·ja, 값은 이벤트에서 채움).
- 말하는 때: 스캔 완료·발견 · n/m이 25/50/75%를 지날 때 · 완료 · 실패 · 결정(승인 필요). 그 밖의 진행 이벤트는 말하지 않습니다.
- 큐: 실패 > 결정 > 완료 > 진행·발견. 같은 종류는 합치고(`수정 3건 적용`), 보고 사이 3.5초 이상, 오래된(9초) 진행은 버리고, 완료가 오면 같은 단계의 밀린 진행은 버립니다. 말한 보고는 Jackal 채팅 기록에도 남습니다.

### 음성 명령(모든 단계)

명령표는 `src/lib/voice/commands.ts`, 처리는 `src/lib/voice/useStageVoice.ts`입니다. 화면은 버튼과 같은 처리기를 `useVoiceActions({ next: … })` 한 줄로 맡기고, 음성은 버튼이 켜져 있을 때만 실행합니다. 지금 말할 수 있는 문구는 Jackal 알약 아래에 작게 보입니다. 버튼·단축키는 그대로입니다.

| 말 | 동작 |
| --- | --- |
| `좋아`·`진행해`·`다음` | 다음 단계(갈 수 있을 때만). 설정 화면에서는 시작 |
| `잠깐`·`멈춰` / `계속해` | 보고 멈춤(실패는 계속 말함) / 다시 보고 |
| `다시 말해줘` · `지금 어디야` | 마지막 말 반복 · 현재 단계와 숫자 하나 |
| `승인해`·`승인할게` | 승인(계획 승인·DB 전환). 자칼이 변경 수·테스트·롤백(또는 쓰기 중단 시간)을 읽은 뒤에만. `좋아`는 승인이 아니고, 부정(`승인 안 해`)도 받지 않음 |
| `롤백해`·`장애 넣어 봐`·`취소해` | 되묻고 `확인`을 들어야 실행(`아니`면 취소) |
| `다시 시도해`·`계획 수정해` | 재시도(트래픽·샌드박스 검토) · 계획 수정 |

호출어 없이 받는 명령은 짧은 말(14자 이하)뿐입니다(발표 중 긴 설명이 명령으로 잡히지 않게). `헤이 자칼, …`으로 시작하면 길어도 받습니다. 음성 인식 언어는 화면 언어를 따릅니다.

실제 백엔드에 연결할 때는 화면 단계 전환 대신 실행 ID에 묶인 검증 가능한 이벤트와 산출물 상태를 API/SSE로 받아 보고해야 합니다. 실제 인프라 생성은 사용자 승인 후에만 시작해야 합니다.

## 실행

Node 20 이상이 필요합니다.

```bash
npm install
npm run dev      # http://127.0.0.1:3000
npm run build
npm run typecheck
```

### 컨테이너로 실행

서버(예: 플랫폼 EC2)에서는 `Dockerfile`로 실행합니다. 서버 TTS의 `onnxruntime-node`가 glibc용이라 `node:22-slim`을 씁니다.

```bash
docker build -t jackal-web .                       # NEXT_PUBLIC_* 값은 빌드 인자(--build-arg)로 넣습니다(기본: 목업 모드)
docker run -d --name jackal-web -p 3000:3000 --env-file .env -v jackal-models:/models jackal-web
```

- `AUTH_*`, `PLATFORM_*`, `GEMINI_API_KEY` 같은 서버용 값은 실행할 때(`--env-file`) 넣습니다. 이미지에는 비밀값을 넣지 않습니다.
- 음성 모델(약 400MB)은 이미지에 없습니다. 처음 한 번 `docker exec jackal-web npm run tts:download`로 `/models`에 받습니다. 없으면 `/api/tts`가 503을 돌려주고, 미리 녹음한 문장만 소리가 나며 나머지(에이전트 답변 등)는 글자로만 보입니다. 브라우저 음성 합성은 목소리가 달라서 쓰지 않습니다.
- 컨테이너는 `node` 사용자(uid 1000)로 돌고, 상태 확인(`HEALTHCHECK`)이 `/`를 봅니다.

## GitHub 로그인과 저장소 선택

설정 화면의 "GitHub 저장소"는 주소 입력 대신 **GitHub 로그인 → 공개 저장소 검색 → 선택**입니다. 고르면 서버가 그 저장소를 id로 다시 조회해 공개 저장소인지 확인하고, 기본 브랜치의 지금 커밋 SHA를 고정합니다. 시작 요청에는 `source: { kind: "GITHUB_PUBLIC", repository_id, full_name, commit_sha }`만 실립니다.

- [Auth.js](https://authjs.dev) + GitHub OAuth App, DB·사용자 테이블 없이 **암호화된 JWT 쿠키 세션**만 씁니다. 요청 권한은 `read:user`뿐이며 `repo` 권한은 요청하지 않습니다.
- GitHub 액세스 토큰은 서버 쪽 JWT 안에만 있습니다. 브라우저가 받는 세션(`/api/auth/session`)과 `/api/github/*` 응답에는 토큰이 없습니다. 브라우저에서 플랫폼 API로 토큰이나 소스 코드를 보내지 않습니다.
- 서버 API: `GET /api/github/repos?page=&per_page=&q=` (GitHub `GET /user/repos`를 페이지 단위로 호출, 공개 저장소만, `repository_id·full_name·default_branch·description·html_url·updated_at`만 돌려줌. 검색어가 있으면 최근 갱신 순 500개 안에서 이름·설명으로 거름), `POST /api/github/source {repository_id}` (기본 브랜치 커밋 SHA 고정).
- 오류: 로그인 안 함·설정 없음·토큰 만료(GitHub 401 → 다시 로그인 안내)·GitHub 한도 초과·그 밖의 GitHub 오류를 화면에서 구분해 보여 줍니다.

### 설정

1. GitHub → Settings → Developer settings → **OAuth Apps → New OAuth App**
   - Homepage URL: `http://localhost:3000` (운영: `https://<배포 도메인>`)
   - Authorization callback URL
     - 로컬: `http://localhost:3000/api/auth/callback/github` (Next가 `127.0.0.1`을 `localhost`로 바꿔 콜백 주소를 만들기 때문에 `127.0.0.1`이 아니라 `localhost`로 등록합니다. `127.0.0.1:3000`에서 로그인을 누르면 화면이 `localhost:3000`으로 옮겨 가서 로그인을 이어 갑니다.)
     - 운영: `https://<배포 도메인>/api/auth/callback/github`
   - OAuth App 하나에는 콜백 주소가 하나뿐이라 로컬용·운영용 앱을 따로 만듭니다.
2. `.env.example`을 `.env.local`로 복사해 `AUTH_GITHUB_ID`(Client ID), `AUTH_GITHUB_SECRET`(Client secret), `AUTH_SECRET`(`npx auth secret` 또는 `openssl rand -base64 33`)을 채웁니다. `.env*.local`은 git에 올라가지 않습니다.
3. **Vercel**: Project → Settings → Environment Variables에 같은 세 값을 Production(필요하면 Preview)용으로 넣고 다시 배포합니다. 운영 OAuth App의 콜백은 운영 도메인으로 맞춥니다. Preview 배포는 주소가 매번 바뀌므로 GitHub 로그인이 필요하면 고정된 Preview 도메인용 OAuth App을 따로 둡니다. `trustHost`를 켜 두어 `AUTH_URL`은 따로 넣지 않아도 됩니다.

### 모드별 동작

| 모드 | 저장소 선택 | "다음" |
| --- | --- | --- |
| 목업(기본) | 선택하면 `source`를 실어 보냄 | 고르지 않아도 데모 데이터로 진행(기존 데모 흐름 그대로) |
| SSE, `NEXT_PUBLIC_SSE_START=wait`(기본) | 필수 | **백엔드 연결 대기**: 백엔드 `/migrations`가 아직 `source`를 받지 않으므로([platform#60](https://github.com/SoftBank-Hackathon-2026-Team-Jackal/cloud-migration-platform/issues/60)) `POST /migrations`를 부르지 않고 안내만 보여 줌 |
| SSE, `source` | 필수 | `source`를 실어 `POST /migrations` |
| SSE, `legacy` | 선택 | 목업 SSE 서버 시험 전용: 예전처럼 `source` 없이도 시작 |

SSE 모드(legacy 제외)에서는 `?stage=` 주소로 단계를 바로 열거나 첫 화면의 "마이그레이션 시작"을 눌러도 저장소 없이 시작하지 않습니다(대기 안내, 음성 시작은 설정 화면으로 이동). `.env` 첨부는 파일 이름만 아는 상태라 업로드 참조가 아니므로 시작 요청에 보내지 않습니다.

## 데이터 모드 (목업 / SSE)

화면은 `useMigration()`이 주는 상태만 읽고, 값이 어디서 오는지는 공급자가 정합니다.

| 환경변수 | 설명 |
| --- | --- |
| `NEXT_PUBLIC_API_MODE=mock\|sse` | `mock`(기본): 타이머 대본으로 똑같이 동작. `sse`: 서버 이벤트(SSE)로 동작 |
| `NEXT_PUBLIC_API_BASE` | SSE 서버 주소 (기본 `http://127.0.0.1:8000`) |
| `NEXT_PUBLIC_SSE_START=wait\|source\|legacy` | SSE 시작 방식 (기본 `wait`, 위 "모드별 동작" 참고) |

`NEXT_PUBLIC_*` 값은 빌드 때 들어가므로 바꾼 뒤에는 다시 실행(빌드)해야 합니다.

백엔드 없이 SSE 모드를 시험하려면 목업 서버를 띄웁니다(Node 22.18 이상, 외부 의존성 없음).

```bash
npm run mock:server                                   # http://127.0.0.1:8000 (PORT=9000 으로 바꿈)
NEXT_PUBLIC_API_MODE=sse NEXT_PUBLIC_SSE_START=legacy npm run dev   # 다른 터미널(목업 서버는 source 없이 시작)
```

## 백엔드 계약 상태 (SSE 모드)
백엔드 `docs/contracts/openapi.yaml` 기준이다. 확정되지 않은 호출은 코드(`sseProvider.ts`)에 [가정]으로 적혀 있다.

| 호출 | 상태 |
| --- | --- |
| `POST /migrations`, `GET /migrations/{id}`, `GET …/events`, `POST …/cancel` | 학습용 뼈대로 존재 (SSE 이벤트 이름·형식은 미정) |
| `POST /provisioning/plans/{plan_id}/revisions/{revision}/approvals` | 확정 (승인·거절, Bearer 승인자 인증) |
| 계획 수정(`REJECT` 뒤 재계획), 사람 검토 재시도, 두 번째 승인, 트래픽 롤백·재시도 | 가정 (백엔드 미정) |

## 에이전트 질문 (임시 백엔드)
시연 중 "헤이 자칼, 지금 무슨 단계야?", "뭐가 문제야?", "로그 읊어 줘"처럼 물으면 현재 상태를 요약해 답하고 말로 읽어 줍니다(첫 화면 이후, 화면 아래 패널의 입력창으로도 가능).
- 화면이 상태 요약(비밀값 없음)을 `/api/agent`에 보내고, 서버가 모델을 호출합니다. **키는 서버 환경변수로만** 둡니다(`NEXT_PUBLIC_` 금지).
- `ANTHROPIC_API_KEY`(기본 모델 `claude-haiku-5-5`) 또는 `GEMINI_API_KEY`, 모델 변경은 `AGENT_MODEL`, 고르는 방식은 `AGENT_PROVIDER=anthropic|gemini|gemini-live`(Live는 소리를 버리고 전사 글만 씀, 기본 모델 `gemini-3.8-live`, 무료 텍스트 모델보다 빠름)
- 하단 자막: 음성 언어와 화면 언어가 다르면(예: 음성 한국어, 화면 일본어) 서버가 에이전트 답을 화면 언어로 한 번 더 옮겨 자막 아래 줄에 보인다. 번역 모델은 `AGENT_CAPTION_MODEL`(없으면 답과 같은 모델, `gemini-live`는 `gemini-2.5-flash`), 제한 시간은 `AGENT_CAPTION_TIMEOUT_MS`(기본 8000)이다. 번역이 실패하면 자막 아래 줄만 빠진다.
- 키가 없거나 모델 호출이 실패하면 규칙 기반 답으로 대신합니다. 시험: `npm run build` 뒤 `npm run test:e2e:agent`(가짜 모델 서버 사용, 실제 호출 없음)

## 시연용 Tools 화면 (/tools)

이전 대상 앱에 일부러 장애(오류 500, 지연)를 내서 플랫폼이 오류율과 p99로 이상을 알아채는 장면을 보여 주는 화면이다. 원본·대상 지표 미리보기도 함께 있다.

- 웹 서버는 `PLATFORM_API_BASE`(내부망 플랫폼 API)의 `/system/fault`, `/system/traffic-health`를 부른다. 브라우저는 같은 출처의 `/api/tools/fault`, `/api/traffic-health`만 부른다.
- 플랫폼에 `DEMO_TOOLS_ENABLED=true`를 켜야 열린다. 꺼져 있으면 화면에 "Tools가 꺼져 있어요"가 보인다.
- 장애는 플랫폼이 "원하는 상태"로 저장하고, 중계 서버 리포터(`cmp_traffic.health`, `FAULT_TOKEN` 필요)가 5초마다 받아 대상 앱 `/__cmp/fault`에 적용한다. 화면은 대상 앱에서 실제로 켜졌는지를 보인다.
- 켜기·끄기는 연결 관리와 같은 입구 검사(같은 출처, 실제 모드에서는 `ADMIN_GITHUB_LOGINS`에 있는 계정)를 거친다.
- 장애가 실제로 켜져 있는 동안 데모 화면 아래쪽에 "장애 주입 중" 배지가 뜬다(일부러 낸 장애임을 밝힌다).

## 테스트

```bash
npm run typecheck
npm test                    # reducer·GitHub API(가짜 GitHub, 네트워크 없음) 단위 테스트
npm run test:quick          # 평소: 타입 검사 + 단위 테스트(약 15초)
npm run build && npm run test:e2e:merge   # Minseo에 합칠 때: flow·opening e2e를 동시에(약 1분 30초)
npm run build && npm run test:e2e:all     # push·발표 전: e2e 전체를 동시에. BASE_URL이 없으면 빌드된 앱을 빈 포트에 띄운다
# e2e는 목업 시계를 E2E_SPEED(기본 10)배로 돌린다(?speed=N, 화면 애니메이션은 그대로). 단위 시험의 목업 SSE 서버는 MOCK_SPEED=10.
BASE_URL=http://127.0.0.1:3000 npm run test:e2e:review   # ?review=1, ?digest=mismatch 시험
BASE_URL=http://127.0.0.1:3000 npm run test:e2e       # 핵심 흐름 브라우저 테스트(목업 모드의 앱, playwright 필요)
BASE_URL=http://127.0.0.1:3000 npm run test:e2e:voice # 가짜 음성 인식으로 처음부터 끝까지 말로 진행(서버 TTS 필요, 모델 없이 시험하면 TTS_EXPECT=fallback)
npm run build && npm run test:e2e:github                # GitHub 로그인·저장소 선택(가짜 GitHub 서버, 실제 호출 없음). SSE는 같은 NEXT_PUBLIC_* 값으로 빌드·실행
```

```bash
npm run contract:check      # 이벤트 계약(contract/*.schema.json) 검증: 목업 대본·목업 서버 이벤트가 스키마를 지키는지
```

계약 스키마는 `contract/events.schema.json`(이벤트), `contract/rest.schema.json`(요청·응답)입니다. 이벤트를 바꿀 때는 `src/lib/migration/events.ts`와 스키마를 같이 고칩니다(type 목록이 어긋나면 테스트가 실패합니다).

## CI

`.github/workflows/ci.yml`: push와 pull request마다 Node 22에서 `npm ci` → `npm run typecheck` → `npm test`(단위 + 계약) → `npm run build`를 돌립니다. 브라우저 테스트(`test:e2e`)는 느려서 기본으로는 돌지 않고, Actions 탭에서 **Run workflow**로 수동 실행할 때만 `e2e` job이 돕니다.

SSE 모드의 핵심 흐름과 연결 끊김·실패·취소 상태는 `NEXT_PUBLIC_API_MODE=sse NEXT_PUBLIC_SSE_START=legacy` 앱과 `npm run mock:server`를 띄운 뒤 `npm run test:e2e`, `npm run test:e2e:sse`로 확인합니다.

## 주소 옵션

| 옵션 | 설명 |
| --- | --- |
| `?lang=ko\|en\|ja` | 화면 언어 (기본은 브라우저 설정, 마지막 선택은 저장됨) |
| `?stage=<단계>&target=gcp\|onprem` | 해당 단계 화면부터 시작 |
| `?aifix=1..4` | 샌드박스 검증에서 AI가 고치는 항목 수 (데모) |
| `?review=1` | 샌드박스가 3번 실패해 사람 검토 대기 화면이 나옴 (데모, 목업 서버에도 전달됨) |
| `?digest=mismatch` | 승인 화면의 이미지 대조가 불일치가 되어 승인이 막힘 (데모) |
| `?stabilize=N` | 목업에서 100% 전환 뒤 확정 전 안정화 구간을 N초(1~600) 둔다. 안정화 중 "장애 주입"을 누르면 Jackal이 먼저 "롤백할까요?"라고 묻고, "응"이면 롤백(트래픽 + DB)한다 (데모) |
| `?target=gcp\|onprem` | 설정 대상 |

## 구조

- `src/components` 단계별 화면과 공통 부품
- `src/lib/stages.ts` 단계 순서와 백엔드 `phase` 대응표
- `src/lib/migration` 데이터 계층: 이벤트 형식(`events.ts`) · reducer · 목업/SSE 공급자 · 공유 대본(`script.ts`, `trafficSim.ts`)
- `scripts/mock-sse-server.mjs` 목업 SSE 서버
- `src/lib/i18n` 한국어·영어·일본어 문구
- `src/app` 페이지와 스타일
