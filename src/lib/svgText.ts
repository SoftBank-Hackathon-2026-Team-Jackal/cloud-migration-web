/**
 * SVG 글자는 상자를 넘어도 잘리지 않고 옆 글자와 겹친다. 글자 폭을 미리 잴 수 없으니 한글·한자·가나는 영문 약 1.8칸으로
 * 어림해 칸 수(units)를 넘으면 줄인다. 런타임 import가 없어 단위 시험이 직접 읽는다.
 */

const WIDE = /[ㄱ-힝぀-ヿ一-鿿]/
const WIDE_UNITS = 1.8

/** 글자 폭 어림: 영문·숫자 1칸, 한글 등 1.8칸. */
export function textUnits(text: string): number {
  let units = 0
  for (const char of text) units += WIDE.test(char) ? WIDE_UNITS : 1
  return units
}

/**
 * maxUnits칸 안에 들어오게 줄인다. 넘으면 앞부분 + "…" + 끝 keepEnd글자(예: 주소 끝의 `:5432`)를 남긴다.
 */
export function fitText(text: string, maxUnits: number, keepEnd = 0): string {
  if (textUnits(text) <= maxUnits) return text
  const tail = keepEnd > 0 ? text.slice(-keepEnd) : ''
  const body = text.slice(0, text.length - tail.length)
  let head = ''
  let used = textUnits(tail) + 1 // "…" 한 칸
  for (const char of body) {
    const width = WIDE.test(char) ? WIDE_UNITS : 1
    if (used + width > maxUnits) break
    head += char
    used += width
  }
  return head + '…' + tail
}

/** 가로 width(px) 안에 text가 한 줄로 들어오는 글자 크기(px). 영문 한 칸을 크기의 0.6배로 어림한다. */
export function fitSize(text: string, width: number, maxSize: number, minSize: number): number {
  const units = Math.max(1, textUnits(text))
  return Math.max(minSize, Math.min(maxSize, width / (units * 0.6)))
}

/** `host:port`에 포트가 이미 있으면 다시 붙이지 않는다. */
export function withPort(address: string, port: string | number): string {
  return /:\d+$/.test(address) ? address : address + ':' + port
}
