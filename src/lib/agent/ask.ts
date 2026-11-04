import { factsToText, type AgentFacts } from './context'
import { answerLocally, type AgentLang } from './mock'

export type AgentAnswer = { answer: string; source: 'model' | 'local' }

const REQUEST_TIMEOUT_MS = 12000

/**
 * 질문을 임시 백엔드(/api/agent)에 보내고, 모델 답이 없거나 실패하면 규칙 기반 답(answerLocally)으로 대신한다.
 * 키는 서버에만 있고 브라우저는 질문과 상태 요약 글만 보낸다.
 */
export async function askAgent(question: string, facts: AgentFacts, lang: AgentLang): Promise<AgentAnswer> {
  try {
    const response = await fetch('/api/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, context: factsToText(facts), lang }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.ok) {
      const data = await response.json() as { answer?: string | null }
      if (data.answer) return { answer: data.answer, source: 'model' }
    }
  } catch { /* 네트워크 실패·시간 초과: 아래 규칙 기반 답으로 */ }
  return { answer: answerLocally(question, facts, lang), source: 'local' }
}
