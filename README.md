# cloud-migration-web

클라우드 마이그레이션 플랫폼의 웹 화면입니다. 분석 → 샌드박스 검증 → 계획 → 승인 → 프로비저닝 → 데이터 이전 → 트래픽 이전 → DB 전환·리포트 흐름을 보여 줍니다.

**기본(목업) 모드에서는 백엔드 없이 화면의 값이 모두 데모 데이터입니다.** 환경변수로 SSE 모드를 켜면 서버가 보내는 이벤트로 같은 화면이 움직입니다. 백엔드는 [cloud-migration-platform](https://github.com/SoftBank-Hackathon-2026-Team-Jackal/cloud-migration-platform)입니다.

## 음성 시연

Chrome 계열 브라우저에서 처음 한 번 `마이크 켜기`를 누르고 권한을 허용합니다. `헤이 자칼`이라고 말하면 `네.`라는 응답과 함께 기본 화면에 구체가 나타납니다. 이때 구체의 파동은 일어나지 않습니다. 이어서 `마이그레이션 시작하자`라고 말하면 `네, 기본 정보를 바탕으로 마이그레이션을 시작하겠습니다.`라고 답하면서 구체가 음성의 실제 음량에 반응하고 분석 화면으로 이동합니다. 마이크 권한이 이미 허용되어 있으면 첫 화면에서 자동으로 호출어를 듣습니다. 음성 인식을 지원하지 않는 브라우저에서는 화면 버튼으로 같은 흐름을 시연할 수 있습니다.

이 첫 명령은 화면에 표시된 고정 데모 프로필 **AWS EKS → GCP GKE**를 사용합니다. 실제 사용자 계정이나 저장된 자격 증명을 읽지 않습니다. 기존 `?stage=` 단계 이동과 `D` 데모 패널도 사용할 수 있습니다.

이후의 안내는 화면의 데모 단계 전환과 완료 이벤트에 연결된 미리 정의된 문구입니다. 안내 문구는 `src/lib/voiceClips.json`, 단계 연결은 `src/components/FlowApp.tsx`, 호출어 인식과 음성 재생은 `src/lib/useVoiceGuide.ts`, 구체의 연속 파동은 `src/components/ParticleField.tsx`에 있습니다. 구체 클릭은 파동을 다시 시작하지 않습니다. `음성 켜짐/꺼짐` 버튼으로 재생을 제어합니다.

| 화면 이벤트 | 음성 보고 |
| --- | --- |
| 분석 시작·완료 | AWS 데모 분석 시작·완료 |
| Sandbox 검증 시작·완료 | 검증 시작·통과 |
| 계획·승인 | 계획 준비·사용자 승인 요청 |
| Provisioning 시작·완료 | 대상 배포 시작·준비 완료 |
| 데이터·트래픽·DB 전환 | 각 단계 시작 안내 |
| 최종 보고서 표시 | 데모 완료 안내 |

안내 음성은 무료 로컬 신경망 TTS인 [Supertonic 3](https://huggingface.co/supertone-oss-archive/supertonic-3)으로 미리 생성한 MP3입니다. 모델 라이선스는 [`public/voice/LICENSE-SUPERTONIC.txt`](public/voice/LICENSE-SUPERTONIC.txt)에 포함했습니다. 실행 중에는 모델이나 외부 TTS 서비스가 필요하지 않습니다. 음성을 다시 생성하려면 Python 3.11 환경에 `supertonic`과 `ffmpeg`를 준비하고 `python scripts/generate_voice.py MODEL_DIR`을 실행합니다.

실제 백엔드에 연결할 때는 화면 단계 전환 대신 실행 ID에 묶인 검증 가능한 이벤트와 산출물 상태를 API/SSE로 받아 보고해야 합니다. 실제 인프라 생성은 사용자 승인 후에만 시작해야 합니다.

## 실행

Node 20 이상이 필요합니다.

```bash
npm install
npm run dev      # http://127.0.0.1:3000
npm run build
npm run typecheck
```

## 데이터 모드 (목업 / SSE)

화면은 `useMigration()`이 주는 상태만 읽고, 값이 어디서 오는지는 공급자가 정합니다.

| 환경변수 | 설명 |
| --- | --- |
| `NEXT_PUBLIC_API_MODE=mock\|sse` | `mock`(기본): 타이머 대본으로 똑같이 동작. `sse`: 서버 이벤트(SSE)로 동작 |
| `NEXT_PUBLIC_API_BASE` | SSE 서버 주소 (기본 `http://127.0.0.1:8000`) |

`NEXT_PUBLIC_*` 값은 빌드 때 들어가므로 바꾼 뒤에는 다시 실행(빌드)해야 합니다.

백엔드 없이 SSE 모드를 시험하려면 목업 서버를 띄웁니다(Node 22.18 이상, 외부 의존성 없음).

```bash
npm run mock:server                                   # http://127.0.0.1:8000 (PORT=9000 으로 바꿈)
NEXT_PUBLIC_API_MODE=sse npm run dev                  # 다른 터미널
```

## 백엔드 계약 상태 (SSE 모드)
백엔드 `docs/contracts/openapi.yaml` 기준이다. 확정되지 않은 호출은 코드(`sseProvider.ts`)에 [가정]으로 적혀 있다.

| 호출 | 상태 |
| --- | --- |
| `POST /migrations`, `GET /migrations/{id}`, `GET …/events`, `POST …/cancel` | 학습용 뼈대로 존재 (SSE 이벤트 이름·형식은 미정) |
| `POST /provisioning/plans/{plan_id}/revisions/{revision}/approvals` | 확정 (승인·거절, Bearer 승인자 인증) |
| 계획 수정(`REJECT` 뒤 재계획), 사람 검토 재시도, 두 번째 승인, 트래픽 롤백·재시도 | 가정 (백엔드 미정) |

## 테스트

```bash
npm run typecheck
npm test                    # reducer 단위 테스트
BASE_URL=http://127.0.0.1:3000 npm run test:e2e:review   # ?review=1, ?digest=mismatch 시험
BASE_URL=http://127.0.0.1:3000 npm run test:e2e       # 핵심 흐름 브라우저 테스트(목업 모드의 앱, playwright 필요)
```

```bash
npm run contract:check      # 이벤트 계약(contract/*.schema.json) 검증: 목업 대본·목업 서버 이벤트가 스키마를 지키는지
```

계약 스키마는 `contract/events.schema.json`(이벤트), `contract/rest.schema.json`(요청·응답)입니다. 이벤트를 바꿀 때는 `src/lib/migration/events.ts`와 스키마를 같이 고칩니다(type 목록이 어긋나면 테스트가 실패합니다).

## CI

`.github/workflows/ci.yml`: push와 pull request마다 Node 22에서 `npm ci` → `npm run typecheck` → `npm test`(단위 + 계약) → `npm run build`를 돌립니다. 브라우저 테스트(`test:e2e`)는 느려서 기본으로는 돌지 않고, Actions 탭에서 **Run workflow**로 수동 실행할 때만 `e2e` job이 돕니다.

SSE 모드의 핵심 흐름과 연결 끊김·실패·취소 상태는 `NEXT_PUBLIC_API_MODE=sse` 앱과 `npm run mock:server`를 띄운 뒤 `npm run test:e2e`, `npm run test:e2e:sse`로 확인합니다.

## 주소 옵션

| 옵션 | 설명 |
| --- | --- |
| `?lang=ko\|en\|ja` | 화면 언어 (기본은 브라우저 설정, 마지막 선택은 저장됨) |
| `?stage=<단계>&target=gcp\|onprem` | 해당 단계 화면부터 시작 |
| `?aifix=1..4` | 샌드박스 검증에서 AI가 고치는 항목 수 (데모) |
| `?review=1` | 샌드박스가 3번 실패해 사람 검토 대기 화면이 나옴 (데모, 목업 서버에도 전달됨) |
| `?digest=mismatch` | 승인 화면의 이미지 대조가 불일치가 되어 승인이 막힘 (데모) |
| `?target=gcp\|onprem` | 설정 대상 |

## 구조

- `src/components` 단계별 화면과 공통 부품
- `src/lib/stages.ts` 단계 순서와 백엔드 `phase` 대응표
- `src/lib/migration` 데이터 계층: 이벤트 형식(`events.ts`) · reducer · 목업/SSE 공급자 · 공유 대본(`script.ts`, `trafficSim.ts`)
- `scripts/mock-sse-server.mjs` 목업 SSE 서버
- `src/lib/i18n` 한국어·영어·일본어 문구
- `src/app` 페이지와 스타일
