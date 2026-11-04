# cloud-migration-web

클라우드 마이그레이션 플랫폼의 웹 화면입니다. 분석 → 샌드박스 검증 → 계획 → 승인 → 프로비저닝 → 데이터 이전 → 트래픽 이전 → DB 전환·리포트 흐름을 보여 줍니다.

**지금은 백엔드에 연결되어 있지 않고, 화면의 값은 모두 데모 데이터입니다.** 백엔드는 [cloud-migration-platform](https://github.com/SoftBank-Hackathon-2026-Team-Jackal/cloud-migration-platform)입니다.

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

## 주소 옵션

| 옵션 | 설명 |
| --- | --- |
| `?lang=ko\|en\|ja` | 화면 언어 (기본은 브라우저 설정, 마지막 선택은 저장됨) |
| `?stage=<단계>&target=gcp\|onprem` | 해당 단계 화면부터 시작 |
| `?aifix=1..4` | 샌드박스 검증에서 AI가 고치는 항목 수 (데모) |

## 구조

- `src/components` 단계별 화면과 공통 부품
- `src/lib/stages.ts` 단계 순서와 백엔드 `phase` 대응표
- `src/lib/events.ts` 백엔드 SSE 이벤트 형식(제안)
- `src/lib/i18n` 한국어·영어·일본어 문구
- `src/app` 페이지와 스타일
