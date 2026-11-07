/**
 * 에이전트 질문 응답용 임시 백엔드. 브라우저에는 키를 두지 않고, 키는 서버 환경변수로만 읽는다.
 *   AGENT_PROVIDER = anthropic | gemini | gemini-live (없으면 키가 있는 쪽을 고른다. 둘 다 없으면 모델 없이 "none"을 돌려주고 화면이 규칙 기반 답을 쓴다)
 *   ANTHROPIC_API_KEY, AGENT_MODEL(기본 claude-haiku-5-5), ANTHROPIC_BASE_URL(시험용)
 *   GEMINI_API_KEY, AGENT_MODEL(기본 gemini-2.5-flash), GEMINI_BASE_URL(시험용)
 *   gemini-live: Gemini Live(웹소켓)로 묻고, 오디오는 버리고 "출력 전사"(말한 내용의 글)만 답으로 쓴다. 모델은 AGENT_MODEL(기본 gemini-3.8-live)
 * PLATFORM_AGENT_URL(예: http://api:8000)이 있으면 먼저 플랫폼 서버(POST /agent/ask, 비용 장부·긴급 중지 적용)에 묻고, 못 받으면 아래 직접 경로로 대신한다.
 * Accept: text/event-stream이면 진행 신호(status)와 함께 SSE로, 아니면 예전처럼 JSON 한 번으로 답한다.
 * 요청: { question, context, lang, captionLang? }. context는 화면이 만든 "현재 상태 요약"(비밀값 없음).
 * 자막: captionLang이 lang과 다르면(예: 음성 한국어, 화면 일본어) 답을 화면 언어로 한 번 더 옮겨 caption으로 돌려준다.
 *   번역은 같은 제공자의 일반(비 Live) 모델로 한다. gemini-live는 AGENT_CAPTION_MODEL(기본 gemini-2.5-flash)을 쓴다.
 *   번역이 실패하거나 AGENT_CAPTION_TIMEOUT_MS(기본 8000)를 넘으면 caption 없이 답만 돌려준다(답을 막지 않는다).
 */
import { NextResponse } from 'next/server'
import { askPlatform, type AgentInput } from '@/lib/agent/platform'
import { sseBlock } from '@/lib/agent/sse'

const MAX_QUESTION = 300
const MAX_CONTEXT = 6000
// 무료 모델은 느릴 수 있어(실측 13~25초) 넉넉히 둔다. AGENT_TIMEOUT_MS로 바꿀 수 있다.
const TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS) || 45000
// 자막 번역은 답을 읽기 전에 기다리므로 짧게 둔다.
const CAPTION_TIMEOUT_MS = Number(process.env.AGENT_CAPTION_TIMEOUT_MS) || 8000
const LANGUAGE = { ko: '한국어', en: 'English', ja: '日本語' } as const
type Lang = keyof typeof LANGUAGE
type CallOptions = { model?: string; timeoutMs?: number }

const asLang = (value: unknown): Lang | null => value === 'ko' || value === 'en' || value === 'ja' ? value : null

function systemPrompt(lang: Lang) {
  return [
    '너는 클라우드 마이그레이션 플랫폼의 음성 안내 에이전트 "자칼"이다.',
    '아래 "현재 상태"에 적힌 사실만 근거로 사용자의 질문에 답한다. 상태에 없는 것은 추측하지 말고 모른다고 말한다.',
    `답변 언어: ${LANGUAGE[lang]}. 말로 읽어 줄 것이므로 1~3문장, 목록·마크다운·이모지 없이 짧고 쉬운 말로 쓴다.`,
    '"로그를 읊어 줘"라고 하면 "최근 기록"을 순서대로 자연스러운 문장으로 읽어 준다.',
    '문제를 물으면 실패·사람 검토 대기·이미지 Digest 불일치·허용을 넘은 실패 요청 같은 것만 짚고, 없으면 없다고 말한다.',
  ].join('\n')
}

function captionPrompt(from: Lang, to: Lang) {
  return [
    `다음 ${LANGUAGE[from]} 문장을 화면 자막으로 쓸 ${LANGUAGE[to]}로 옮긴다.`,
    '뜻을 더하거나 빼지 않는다. 숫자·단위·제품명·코드(예: GKE, PgBouncer, Digest)는 그대로 둔다.',
    '번역문만 출력한다. 설명·따옴표·마크다운은 쓰지 않는다.',
  ].join('\n')
}

async function callAnthropic(system: string, user: string, options: CallOptions = {}): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('no_key')
  const base = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
  const response = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: options.model || process.env.AGENT_MODEL || 'claude-haiku-5-5', max_tokens: 300, system, messages: [{ role: 'user', content: user }] }),
    signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
  })
  if (!response.ok) throw new Error('upstream_' + response.status)
  const data = await response.json() as { content?: Array<{ type: string; text?: string }> }
  return (data.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('').trim()
}

async function callGemini(system: string, user: string, options: CallOptions = {}): Promise<string> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('no_key')
  const base = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com'
  const model = options.model || process.env.AGENT_MODEL || 'gemini-2.5-flash'
  // Gemma 계열은 시스템 지침 필드를 받지 않으므로 지침을 사용자 글 앞에 붙인다.
  const body = model.startsWith('gemma')
    ? { contents: [{ role: 'user', parts: [{ text: `${system}\n\n${user}` }] }], generationConfig: { maxOutputTokens: 300 } }
    : { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { maxOutputTokens: 300 } }
  const response = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
  })
  if (!response.ok) throw new Error('upstream_' + response.status)
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
  return (data.candidates?.[0]?.content?.parts ?? []).map(part => part.text ?? '').join('').trim()
}

/** Gemini Live: 오디오 출력이 필수라서 소리는 받아서 버리고, 같이 오는 전사 글만 모은다(첫 글자는 약 1.5초, 전체는 말하는 길이만큼). */
async function callGeminiLive(system: string, user: string): Promise<string> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('no_key')
  const base = process.env.GEMINI_LIVE_URL || 'wss://generativelanguage.googleapis.com'
  const model = process.env.AGENT_MODEL || 'gemini-3.8-live'
  return await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(`${base}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(key)}`)
    let text = ''
    let settled = false
    const settle = (error: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.close() } catch { /* 이미 닫힘 */ }
      if (error) reject(error); else resolve(text.trim())
    }
    const timer = setTimeout(() => settle(new Error('live_timeout')), TIMEOUT_MS)
    socket.onopen = () => socket.send(JSON.stringify({ setup: { model: 'models/' + model, generationConfig: { responseModalities: ['AUDIO'] }, systemInstruction: { parts: [{ text: system }] }, outputAudioTranscription: {} } }))
    socket.onmessage = async event => {
      const raw = typeof event.data === 'string' ? event.data : Buffer.from(await (event.data as Blob).arrayBuffer()).toString('utf8')
      let message: { setupComplete?: unknown; serverContent?: { outputTranscription?: { text?: string }; turnComplete?: boolean } }
      try { message = JSON.parse(raw) } catch { return }
      if (message.setupComplete) {
        socket.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: user }] }], turnComplete: true } }))
        return
      }
      if (message.serverContent?.outputTranscription?.text) text += message.serverContent.outputTranscription.text
      if (message.serverContent?.turnComplete) settle(null)
    }
    socket.onerror = () => settle(new Error('live_error'))
    socket.onclose = event => settle(new Error('live_closed_' + event.code))
  })
}

/** 답을 화면 언어 자막으로 옮긴다. 실패하면 null(자막만 빠지고 답은 그대로 간다). */
async function translateCaption(provider: string, answer: string, from: Lang, to: Lang): Promise<string | null> {
  const system = captionPrompt(from, to)
  const options: CallOptions = { timeoutMs: CAPTION_TIMEOUT_MS }
  try {
    const caption = provider === 'anthropic'
      ? await callAnthropic(system, answer, { ...options, model: process.env.AGENT_CAPTION_MODEL })
      // Live 모델은 일반 호출을 받지 않으므로 일반 모델로 옮긴다.
      : await callGemini(system, answer, { ...options, model: process.env.AGENT_CAPTION_MODEL || (provider === 'gemini-live' ? 'gemini-2.5-flash' : undefined) })
    return caption || null
  } catch {
    return null
  }
}

type Outcome =
  | { kind: 'ok'; answer: string; caption?: string; provider: string }
  | { kind: 'none' }
  | { kind: 'failed'; provider: string; error: string; status: number }

/** 예전 경로: 웹 서버가 제공자에게 직접 묻는다(플랫폼이 못 답할 때의 대비이기도 하다). */
async function askDirect(question: string, context: string, lang: Lang, captionLang: Lang | null, onStatus: (step: string) => void): Promise<Outcome> {
  const provider = process.env.AGENT_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.GEMINI_API_KEY ? 'gemini' : 'none')
  if (provider !== 'anthropic' && provider !== 'gemini' && provider !== 'gemini-live') return { kind: 'none' }
  const user = `현재 상태:
${context || '(없음)'}

질문: ${question}`
  try {
    const system = systemPrompt(lang)
    onStatus('asking_model')
    const answer = provider === 'anthropic' ? await callAnthropic(system, user) : provider === 'gemini-live' ? await callGeminiLive(system, user) : await callGemini(system, user)
    if (!answer) return { kind: 'failed', provider, error: 'empty_answer', status: 200 }
    if (!captionLang || captionLang === lang) return { kind: 'ok', answer, provider }
    onStatus('translating')
    const caption = await translateCaption(provider, answer, lang, captionLang)
    return { kind: 'ok', answer, provider, ...(caption ? { caption } : {}) }
  } catch (error) {
    // 키·상위 응답 본문은 돌려주지 않는다. 화면은 규칙 기반 답으로 대신한다.
    return { kind: 'failed', provider, error: error instanceof Error ? error.message : 'failed', status: 502 }
  }
}

/** 플랫폼 서버가 설정돼 있으면 먼저 거기에 묻고(비용 장부·긴급 중지 적용), 못 받으면 예전 경로로 대신한다. */
async function answer(input: AgentInput, onStatus: (step: string) => void): Promise<Outcome> {
  const base = process.env.PLATFORM_AGENT_URL
  if (base) {
    const result = await askPlatform(base, input, status => onStatus(status.step))
    if (result) return { kind: 'ok', ...result }
    onStatus('fallback')
  }
  return askDirect(input.question, input.context, input.lang, input.captionLang, onStatus)
}

const jsonOf = (outcome: Outcome) => {
  if (outcome.kind === 'none') return NextResponse.json({ answer: null, provider: 'none' })
  if (outcome.kind === 'failed') return NextResponse.json({ answer: null, provider: outcome.provider, error: outcome.error }, { status: outcome.status === 200 ? 200 : outcome.status })
  return NextResponse.json({ answer: outcome.answer, provider: outcome.provider, ...(outcome.caption ? { caption: outcome.caption } : {}) })
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { question?: unknown; context?: unknown; lang?: unknown; captionLang?: unknown } | null
  const question = String(body?.question ?? '').trim().slice(0, MAX_QUESTION)
  const context = String(body?.context ?? '').slice(0, MAX_CONTEXT)
  const lang: Lang = asLang(body?.lang) ?? 'ko'
  const captionLang = asLang(body?.captionLang)
  if (!question) return NextResponse.json({ error: 'empty_question' }, { status: 400 })
  const input: AgentInput = { question, context, lang, captionLang: captionLang && captionLang !== lang ? captionLang : null }

  // 진행 신호(분석 중…)를 받겠다는 요청이면 SSE로, 아니면 예전처럼 JSON 한 번.
  if (!(request.headers.get('accept') ?? '').includes('text/event-stream')) return jsonOf(await answer(input, () => {}))

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, payload: unknown) => controller.enqueue(encoder.encode(sseBlock(event, payload)))
      send('status', { step: 'reading_state' })
      try {
        const outcome = await answer(input, step => send('status', { step }))
        if (outcome.kind === 'ok') send('answer', { answer: outcome.answer, provider: outcome.provider, ...(outcome.caption ? { caption: outcome.caption } : {}) })
        else send('answer', { answer: null, provider: outcome.kind === 'none' ? 'none' : outcome.provider })
      } finally {
        send('done', {})
        controller.close()
      }
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' } })
}
