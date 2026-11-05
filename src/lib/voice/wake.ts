/**
 * 호출어("헤이 자칼")와 자칼이 되묻는 말을 가르는 순수 함수. 런타임 import 없음(단위 테스트가 직접 읽는다).
 * 호출 흐름: "헤이 자칼" → 띠링 → "네, 말씀하세요" → 다음 한 마디를 명령이나 질문으로 받는다.
 */

const WAKE = /(?:헤이|해이|hey|hay|ヘイ)\s*(?:자칼|재칼|쟈칼|jackal|jackel|ジャッカル)\s*[,.!?、。]?\s*(.*)$/i

/** 호출어가 들어 있으면 woke과 그 뒤의 말(rest). 호출어가 없으면 woke=false, rest는 들은 말 그대로. */
export function parseWake(transcript: string): { woke: boolean; rest: string } {
  const heard = transcript.trim()
  const match = heard.match(WAKE)
  if (!match) return { woke: false, rest: heard }
  return { woke: true, rest: (match[1] ?? '').trim() }
}

const QUESTION = /[?？]|까요|나요\s*$|해\s*주세요|ますか|ですか|ください|please say|say ['"“‘]/i

/** 자칼이 사용자에게 되묻거나 말을 시키는 문장인지(이 말 뒤의 짧은 대답은 호출어 없이도 받는다) */
export function isQuestionLine(text: string): boolean {
  return QUESTION.test(text)
}
