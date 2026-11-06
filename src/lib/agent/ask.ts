import { factsToText, type AgentFacts } from './context'
import { answerLocally, type AgentLang } from './mock'

/** caption: 화면 언어 자막(음성 언어와 화면 언어가 다를 때만). */
export type AgentAnswer = { answer: string; source: 'model' | 'local'; caption?: string }

// 서버(모델) 제한 시간보다 조금 길게 둔다.
const REQUEST_TIMEOUT_MS = 50000

/**
 * 질문을 임시 백엔드(/api/agent)에 보내고, 모델 답이 없거나 실패하면 규칙 기반 답(answerLocally)으로 대신한다.
 * 키는 서버에만 있고 브라우저는 질문과 상태 요약 글만 보낸다.
 * captionLang(화면 언어)이 lang(음성 언어)과 다르면 화면 언어 자막도 받는다. 모델 답은 서버가 옮기고,
 * 규칙 기반 답은 같은 규칙으로 화면 언어 문장을 한 번 더 만든다.
 */
export async function askAgent(question: string, facts: AgentFacts, lang: AgentLang, captionLang?: AgentLang): Promise<AgentAnswer> {
  const wantCaption = captionLang && captionLang !== lang ? captionLang : undefined
  try {
    const response = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, context: factsToText(facts), lang, ...(wantCaption ? { captionLang: wantCaption } : {}) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.ok) {
      const data = await response.json() as { answer?: string | null; caption?: string | null }
      if (data.answer) return { answer: data.answer, source: 'model', ...(wantCaption && data.caption ? { caption: data.caption } : {}) }
    }
  } catch { /* 네트워크 실패·시간 초과: 아래 규칙 기반 답으로 */ }
  return { answer: answerLocally(question, facts, lang), source: 'local', ...(wantCaption ? { caption: answerLocally(question, facts, wantCaption) } : {}) }
}
