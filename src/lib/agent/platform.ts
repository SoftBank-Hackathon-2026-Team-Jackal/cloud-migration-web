/**
 * 에이전트 답을 플랫폼 서버(`POST {PLATFORM_AGENT_URL}/agent/ask`)에 묻는다. 웹 서버가 부르고, 브라우저는 모른다.
 * 플랫폼이 답을 못 주면(꺼짐·키 없음·비용 한도·긴급 중지·모델 오류·연결 실패) null: 호출하는 쪽이 예전 경로로 대신한다.
 * 진행 신호(status)는 오는 대로 `onStatus`로 넘긴다. 런타임 import가 없어 단위 시험이 직접 읽는다.
 */
import { readSse } from './sse.ts'

export type AgentInput = { question: string; context: string; lang: 'ko' | 'en' | 'ja'; captionLang: 'ko' | 'en' | 'ja' | null }
export type AgentResult = { answer: string; caption?: string; provider: string }
export type StatusStep = { step: string; [key: string]: unknown }

const TIMEOUT_MS = 50000

export async function askPlatform(
  base: string,
  input: AgentInput,
  onStatus: (status: StatusStep) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentResult | null> {
  let result: AgentResult | null = null
  try {
    const response = await fetchImpl(base.replace(/\/+$/, '') + '/agent/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ question: input.question, context: input.context, lang: input.lang, ...(input.captionLang ? { captionLang: input.captionLang } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok || !response.body) return null
    await readSse(response.body, ({ event, data }) => {
      const payload = (data ?? {}) as Record<string, unknown>
      if (event === 'status' && typeof payload.step === 'string') onStatus(payload as StatusStep)
      else if (event === 'answer' && typeof payload.answer === 'string' && payload.answer) {
        result = {
          answer: payload.answer,
          provider: typeof payload.provider === 'string' ? payload.provider : 'platform',
          ...(typeof payload.caption === 'string' && payload.caption ? { caption: payload.caption } : {}),
        }
      }
    })
  } catch {
    return null // 연결 실패·시간 초과: 예전 경로로
  }
  return result
}
