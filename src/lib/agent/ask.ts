import { factsToText, type AgentFacts } from './context'
import { answerLocally, type AgentLang } from './mock'
import { parseReasoning, parseSkills, type StatusStep, type Thought } from './platform.ts'
import { readSse } from './sse.ts'

/** caption: 화면 언어 자막(음성 언어와 화면 언어가 다를 때만). */
/** reasoning·skills: 플랫폼 판단 루프가 답했을 때만(화면에 근거로 보인다. 소리로는 읽지 않는다). */
export type AgentAnswer = { answer: string; source: 'model' | 'local'; caption?: string; reasoning?: Thought[]; skills?: string[] }

// 서버(모델) 제한 시간보다 조금 길게 둔다.
const REQUEST_TIMEOUT_MS = 50000

/**
 * 질문을 임시 백엔드(/api/agent)에 보내고, 모델 답이 없거나 실패하면 규칙 기반 답(answerLocally)으로 대신한다.
 * 키는 서버에만 있고 브라우저는 질문과 상태 요약 글만 보낸다.
 * captionLang(화면 언어)이 lang(음성 언어)과 다르면 화면 언어 자막도 받는다. 모델 답은 서버가 옮기고,
 * 규칙 기반 답은 같은 규칙으로 화면 언어 문장을 한 번 더 만든다.
 */
export async function askAgent(question: string, facts: AgentFacts, lang: AgentLang, captionLang?: AgentLang, onStatus?: (status: StatusStep) => void): Promise<AgentAnswer> {
  const wantCaption = captionLang && captionLang !== lang ? captionLang : undefined
  try {
    const response = await fetch('/api/agent', {
      method: 'POST',
      // 진행 신호(분석 중… 같은 표시)를 받으려고 스트림을 요청한다. 서버가 예전 방식(JSON)으로 답해도 그대로 읽는다.
      headers: { 'content-type': 'application/json', accept: 'text/event-stream, application/json' },
      body: JSON.stringify({ question, context: factsToText(facts), lang, ...(wantCaption ? { captionLang: wantCaption } : {}) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.ok) {
      let data: { answer?: string | null; caption?: string | null; reasoning?: unknown; skills?: unknown } = {}
      if ((response.headers.get('content-type') ?? '').includes('text/event-stream') && response.body) {
        await readSse(response.body, ({ event, data: payload }) => {
          const body = (payload ?? {}) as { step?: unknown; answer?: unknown; caption?: unknown; reasoning?: unknown; skills?: unknown }
          if (event === 'status' && typeof body.step === 'string') onStatus?.(body as StatusStep)
          else if (event === 'answer') data = { answer: typeof body.answer === 'string' ? body.answer : null, caption: typeof body.caption === 'string' ? body.caption : null, reasoning: body.reasoning, skills: body.skills }
        })
      } else {
        data = await response.json() as typeof data
      }
      if (data.answer) {
        const reasoning = parseReasoning(data.reasoning)
        const skills = parseSkills(data.skills)
        return { answer: data.answer, source: 'model', ...(wantCaption && data.caption ? { caption: data.caption } : {}), ...(reasoning.length ? { reasoning } : {}), ...(skills.length ? { skills } : {}) }
      }
    }
  } catch { /* 네트워크 실패·시간 초과: 아래 규칙 기반 답으로 */ }
  return { answer: answerLocally(question, facts, lang), source: 'local', ...(wantCaption ? { caption: answerLocally(question, facts, wantCaption) } : {}) }
}
