/**
 * 에이전트 질문 응답용 임시 백엔드. 브라우저에는 키를 두지 않고, 키는 서버 환경변수로만 읽는다.
 *   AGENT_PROVIDER = anthropic | gemini (없으면 키가 있는 쪽을 고른다. 둘 다 없으면 모델 없이 "none"을 돌려주고 화면이 규칙 기반 답을 쓴다)
 *   ANTHROPIC_API_KEY, AGENT_MODEL(기본 claude-haiku-5-5), ANTHROPIC_BASE_URL(시험용)
 *   GEMINI_API_KEY, AGENT_MODEL(기본 gemini-2.5-flash), GEMINI_BASE_URL(시험용)
 * 요청: { question, context, lang }. context는 화면이 만든 "현재 상태 요약"(비밀값 없음).
 */
import { NextResponse } from 'next/server'

const MAX_QUESTION = 300
const MAX_CONTEXT = 6000
const TIMEOUT_MS = 15000
const LANGUAGE = { ko: '한국어', en: 'English', ja: '日本語' } as const
type Lang = keyof typeof LANGUAGE

function systemPrompt(lang: Lang) {
  return [
    '너는 클라우드 마이그레이션 플랫폼의 음성 안내 에이전트 "자칼"이다.',
    '아래 "현재 상태"에 적힌 사실만 근거로 사용자의 질문에 답한다. 상태에 없는 것은 추측하지 말고 모른다고 말한다.',
    `답변 언어: ${LANGUAGE[lang]}. 말로 읽어 줄 것이므로 1~3문장, 목록·마크다운·이모지 없이 짧고 쉬운 말로 쓴다.`,
    '"로그를 읊어 줘"라고 하면 "최근 기록"을 순서대로 자연스러운 문장으로 읽어 준다.',
    '문제를 물으면 실패·사람 검토 대기·이미지 Digest 불일치·허용을 넘은 실패 요청 같은 것만 짚고, 없으면 없다고 말한다.',
  ].join('\n')
}

async function callAnthropic(system: string, user: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('no_key')
  const base = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
  const response = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.AGENT_MODEL || 'claude-haiku-5-5', max_tokens: 300, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error('upstream_' + response.status)
  const data = await response.json() as { content?: Array<{ type: string; text?: string }> }
  return (data.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('').trim()
}

async function callGemini(system: string, user: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('no_key')
  const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com'
  const model = process.env.AGENT_MODEL || 'gemini-2.5-flash'
  const response = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { maxOutputTokens: 300 } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error('upstream_' + response.status)
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  return (data.candidates?.[0]?.content?.parts ?? []).map(part => part.text ?? '').join('').trim()
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { question?: unknown; context?: unknown; lang?: unknown } | null
  const question = String(body?.question ?? '').trim().slice(0, MAX_QUESTION)
  const context = String(body?.context ?? '').slice(0, MAX_CONTEXT)
  const lang: Lang = body?.lang === 'en' || body?.lang === 'ja' ? body.lang : 'ko'
  if (!question) return NextResponse.json({ error: 'empty_question' }, { status: 400 })

  const provider = process.env.AGENT_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.GEMINI_API_KEY ? 'gemini' : 'none')
  if (provider !== 'anthropic' && provider !== 'gemini') return NextResponse.json({ answer: null, provider: 'none' })

  const user = `현재 상태:\n${context || '(없음)'}\n\n질문: ${question}`
  try {
    const answer = provider === 'anthropic' ? await callAnthropic(systemPrompt(lang), user) : await callGemini(systemPrompt(lang), user)
    if (!answer) return NextResponse.json({ answer: null, provider, error: 'empty_answer' })
    return NextResponse.json({ answer, provider })
  } catch (error) {
    // 키·상위 응답 본문은 돌려주지 않는다. 화면은 규칙 기반 답으로 대신한다.
    return NextResponse.json({ answer: null, provider, error: error instanceof Error ? error.message : 'failed' }, { status: 502 })
  }
}
