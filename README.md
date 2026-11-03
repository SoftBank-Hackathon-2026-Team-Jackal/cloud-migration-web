# cloud-migration-web

클라우드 마이그레이션 플랫폼의 웹 화면입니다. 분석 → 샌드박스 검증 → 계획 → 승인 → 프로비저닝 → 데이터 이전 → 트래픽 이전 → DB 전환·리포트 흐름을 보여 줍니다.

**지금은 백엔드에 연결되어 있지 않고, 화면의 값은 모두 데모 데이터입니다.** 백엔드는 [cloud-migration-platform](https://github.com/SoftBank-Hackathon-2026-Team-Jackal/cloud-migration-platform)입니다.

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
