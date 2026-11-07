# syntax=docker/dockerfile:1
# Jackal 웹(Next.js) 컨테이너.
# 서버 TTS(onnxruntime-node)가 glibc용 바이너리를 쓰므로 alpine이 아니라 slim을 쓴다.
#
#   docker build -t jackal-web .
#   docker run --rm -p 3000:3000 --env-file .env -v jackal-models:/models jackal-web
#
# 음성 모델(약 400MB)은 이미지에 넣지 않는다: 처음 한 번 `npm run tts:download`로 /models에 받는다
# (SUPERTONIC_DIR=/models/supertonic-3). 모델이 없으면 /api/tts가 503을 돌려주고 화면은 브라우저 음성으로 읽는다.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* 값은 빌드할 때 화면 코드에 들어간다(기본: 목업 모드). 서버에서만 쓰는 값(AUTH_*, PLATFORM_*, GEMINI_API_KEY 등)은 실행할 때 넣는다.
ARG NEXT_PUBLIC_API_MODE=mock
ARG NEXT_PUBLIC_API_BASE=
ARG NEXT_PUBLIC_SSE_START=wait
# 실제(SSE) 모드에서 켤 동작(쉼표 구분, src/lib/migration/capabilities.ts). 예: report,traffic.rollback,traffic.retry
ARG NEXT_PUBLIC_SSE_CAPABILITIES=
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_API_MODE=$NEXT_PUBLIC_API_MODE NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE NEXT_PUBLIC_SSE_START=$NEXT_PUBLIC_SSE_START NEXT_PUBLIC_SSE_CAPABILITIES=$NEXT_PUBLIC_SSE_CAPABILITIES
RUN npm run build

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 SUPERTONIC_DIR=/models/supertonic-3 TTS_CACHE_DIR=/cache/tts
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
  && mkdir -p /models /cache/tts && chown -R node:node /models /cache /app
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/next.config.ts ./next.config.ts
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_modules/next/dist/bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
