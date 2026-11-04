# cloud-migration-web

클라우드 마이그레이션 플랫폼의 웹 화면입니다. 분석 → 샌드박스 검증 → 계획 → 승인 → 프로비저닝 → 데이터 이전 → 트래픽 이전 → DB 전환·리포트 흐름을 보여 줍니다.

**기본(목업) 모드에서는 백엔드 없이 화면의 값이 모두 데모 데이터입니다.** 환경변수로 SSE 모드를 켜면 서버가 보내는 이벤트로 같은 화면이 움직입니다. 백엔드는 [cloud-migration-platform](https://github.com/SoftBank-Hackathon-2026-Team-Jackal/cloud-migration-platform)입니다.

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

## 테스트

```bash
npm run typecheck
npm test                    # reducer 단위 테스트
BASE_URL=http://127.0.0.1:3000 npm run test:e2e:review   # ?review=1, ?digest=mismatch 시험
BASE_URL=http://127.0.0.1:3000 npm run test:e2e       # 핵심 흐름 브라우저 테스트(목업 모드의 앱, playwright 필요)
```

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
