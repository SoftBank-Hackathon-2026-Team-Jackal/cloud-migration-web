/**
 * 호출어("헤이 자칼")와 자칼이 되묻는 말을 가르는 순수 함수. 런타임 import 없음(단위 테스트가 직접 읽는다).
 * 호출 흐름: "헤이 자칼" → 띠링 → "네, 말씀하세요" → 다음 한 마디를 명령이나 질문으로 받는다.
 */

// 음성 인식(Chrome)은 "헤이 자칼"을 자주 다르게 받아 적는다(헤이 재칼, 에이 자칼, 헤이 자 칼, hey jackal …).
// 앞말(헤이)과 이름(자칼) 변형을 모두 받고, 글자 사이 공백도 허용한다. 이름만 있는 말("자칼이 뭐야")은 호출어가 아니다.
const spaced = (word: string) => [...word].join('\\s*')
// 실측(11/6, Chrome ko-KR): "헤이 자칼"이 헤이즈 칼 · 페이저 칼 · Hey 젓갈 · 헤이 저칼로도 적혔다.
// 그래서 한국어는 글자 목록 대신 소리 모양으로 받는다: 앞말 [헤해페패에케게체하]+이(+즈·저·스) / 이름 (자·재·쟈·저·조·잭·차)?+(칼·갈·깔·카·컬) 또는 젓갈.
const HEY_KO = '[헤해페패베에케게체하]\\s*이(?:\\s*[즈저스])?'
const NAME_KO = '(?:(?:[자재쟈저조잭차]\\s*)?[칼갈깔카컬걸]|젓\\s*갈)'
const HEY_OTHER = ['hey', 'hay', 'hei', 'hi', 'ヘイ', 'ヘー', 'へい', 'ハイ']
const NAME_OTHER = ['jackal', 'jackel', 'jackle', 'jakal', 'jackall', 'ジャッカル', 'ジャカル', 'ジャッカー', 'ジャカー', 'ジャッカ', 'じゃっかる']
const HEY = `(?:${HEY_KO}|${HEY_OTHER.map(spaced).join('|')})`
const NAME = `(?:${NAME_KO}|${NAME_OTHER.map(spaced).join('|')})`
const WAKE = new RegExp(`${HEY}\\s*[,、]?\\s*${NAME}(?![가-힣])\\s*[,.!?、。]?\\s*(.*)$`, 'i')

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
