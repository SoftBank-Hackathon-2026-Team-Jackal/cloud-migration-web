import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSse, readSse, sseBlock } from '../../src/lib/agent/sse.ts'
import { askPlatform } from '../../src/lib/agent/platform.ts'

const input = { question: '지금 단계?', context: 'stage: analysis', lang: 'ko' as const, captionLang: null }
const streamOf = (...chunks: string[]) => new Response(new ReadableStream({
  start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close() },
}), { headers: { 'content-type': 'text/event-stream' } })

test('parseSse keeps an unfinished block as the rest and skips comments', () => {
  const { events, rest } = parseSse(': ping\n\nevent: status\ndata: {"step":"a"}\n\nevent: answ')
  assert.deepEqual(events, [{ event: 'status', data: { step: 'a' } }])
  assert.equal(rest, 'event: answ')
})

test('readSse joins chunks split in the middle of a block and handles CRLF', async () => {
  const seen: string[] = []
  const block = sseBlock('status', { step: '가나' })
  const response = streamOf(block.slice(0, 12), block.slice(12).replace(/\n/g, '\r\n'), sseBlock('done', {}))
  await readSse(response.body!, e => seen.push(e.event))
  assert.deepEqual(seen, ['status', 'done'])
})

test('askPlatform forwards status and returns the answer with caption', async () => {
  const steps: string[] = []
  let sent: { url: string; body: Record<string, unknown> } | null = null
  const result = await askPlatform('http://api:8000/', { ...input, captionLang: 'ja' }, s => steps.push(s.step), (async (url: string, init: RequestInit) => {
    sent = { url, body: JSON.parse(String(init.body)) }
    return streamOf(sseBlock('status', { step: 'reading_state' }), sseBlock('status', { step: 'asking_model' }), sseBlock('answer', { answer: '문제 없습니다.', caption: '問題ありません。', provider: 'platform' }), sseBlock('done', {}))
  }) as unknown as typeof fetch)
  assert.deepEqual(steps, ['reading_state', 'asking_model'])
  assert.deepEqual(result, { answer: '문제 없습니다.', caption: '問題ありません。', provider: 'platform' })
  assert.equal(sent!.url, 'http://api:8000/agent/ask')
  assert.equal(sent!.body.captionLang, 'ja')
})

test('askPlatform returns null for an error event, a bad status and a network failure', async () => {
  const run = (f: () => Promise<Response>) => askPlatform('http://api', input, () => {}, f as unknown as typeof fetch)
  assert.equal(await run(async () => streamOf(sseBlock('error', { code: 'AGENT_DISABLED' }))), null)
  assert.equal(await run(async () => new Response('x', { status: 500 })), null)
  assert.equal(await run(async () => { throw new Error('connect') }), null)
})
