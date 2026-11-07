/**
 * 에이전트 답을 플랫폼 서버(`POST {PLATFORM_AGENT_URL}/agent/ask`)에 묻는다. 웹 서버가 부르고, 브라우저는 모른다.
 * 플랫폼이 답을 못 주면(꺼짐·키 없음·비용 한도·긴급 중지·모델 오류·연결 실패) null: 호출하는 쪽이 예전 경로로 대신한다.
 * 진행 신호(status)는 오는 대로 `onStatus`로 넘긴다. 런타임 import가 없어 단위 시험이 직접 읽는다.
 */
import { readSse } from './sse.ts'

export type AgentInput = { question: string; context: string; lang: 'ko' | 'en' | 'ja'; captionLang: 'ko' | 'en' | 'ja' | null }
/** 판단 근거 한 줄: 관찰(observe) → 판단(judge) → 권고(recommend). 플랫폼 판단 루프만 보낸다. */
export type Thought = { kind: 'observe' | 'judge' | 'recommend'; text: string }
export type AgentResult = { answer: string; caption?: string; provider: string; reasoning?: Thought[]; skills?: string[] }

const KINDS = new Set(['observe', 'judge', 'recommend'])

/** 서버가 보낸 근거·skill 목록에서 모양이 맞는 것만 남긴다(최대 4개·6개). */
export function parseReasoning(value: unknown): Thought[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Thought => !!item && typeof item === 'object' && KINDS.has((item as Thought).kind) && typeof (item as Thought).text === 'string' && !!(item as Thought).text.trim())
    .slice(0, 4)
    .map(item => ({ kind: item.kind, text: item.text.trim().slice(0, 200) }))
}

export function parseSkills(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((name): name is string => typeof name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(name)).slice(0, 6)
}
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
        const reasoning = parseReasoning(payload.reasoning)
        const skills = parseSkills(payload.skills)
        if (reasoning.length) result.reasoning = reasoning
        if (skills.length) result.skills = skills
      }
    })
  } catch {
    return null // 연결 실패·시간 초과: 예전 경로로
  }
  return result
}
