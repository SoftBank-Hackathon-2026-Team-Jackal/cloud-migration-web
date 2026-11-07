/**
 * SSE(`text/event-stream`) 읽기. 에이전트 답을 진행 신호와 함께 받을 때 쓴다(브라우저의 fetch 스트림, 웹 서버의 플랫폼 호출 둘 다).
 * 순수 함수만 둔다(런타임 import 없음): 단위 시험이 직접 읽는다.
 */
export type SseEvent = { event: string; data: unknown }

/** 버퍼에서 끝난 블록(빈 줄로 끝남)을 모두 꺼내고, 아직 끝나지 않은 나머지를 돌려준다. */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = []
  const normalized = buffer.replace(/\r\n/g, '\n')
  const blocks = normalized.split('\n\n')
  const rest = blocks.pop() ?? ''
  for (const block of blocks) {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue // 주석(하트비트)
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
    if (data.length === 0) continue
    try { events.push({ event, data: JSON.parse(data.join('\n')) }) } catch { /* 깨진 블록은 건너뛴다 */ }
  }
  return { events, rest }
}

/** 응답 본문을 읽으며 블록이 끝날 때마다 `onEvent`를 부른다. 스트림이 끝나면 돌아온다. */
export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (event: SseEvent) => void): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (value) buffer += decoder.decode(value, { stream: true })
    const parsed = parseSse(done ? buffer + '\n\n' : buffer)
    buffer = parsed.rest
    for (const event of parsed.events) onEvent(event)
    if (done) return
  }
}

export const sseBlock = (event: string, payload: unknown) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
