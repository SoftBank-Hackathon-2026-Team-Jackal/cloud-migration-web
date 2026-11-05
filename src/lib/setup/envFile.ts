/**
 * .env 파일을 브라우저 안에서만 읽어 "키 이름"만 꺼낸다. 값은 읽는 즉시 버리고 어디에도 담지 않는다
 * (화면·로그·상태·요청 어디에도 값이 남지 않게, 돌려주는 객체에 값 필드가 아예 없다).
 * 값은 나중에 플랫폼 Secret 참조로만 전달된다(백엔드 문서: .env 원문은 워크플로 입력·기록·로그에 남기지 않는다).
 * 이 파일은 단위 테스트(node --test)가 직접 읽으므로 런타임 import를 두지 않는다.
 */
export type EnvKind = 'config' | 'secret'
export type EnvKey = { name: string; kind: EnvKind; empty: boolean }

const KEY = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/
const SECRET = /(SECRET|TOKEN|PASSWORD|PASSWD|PWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|AUTH|SALT|SIGNING|_DSN$|DATABASE_URL|REDIS_URL|MONGO.*URL|AMQP.*URL|CONNECTION_STRING|WEBHOOK)/i

export function classifyKey(name: string): EnvKind {
  return SECRET.test(name) ? 'secret' : 'config'
}

/** 키 이름만 돌려준다. 같은 키가 여러 번 나오면 마지막 줄 기준(dotenv와 같다). */
export function parseEnvKeys(text: string): EnvKey[] {
  const found = new Map<string, EnvKey>()
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue
    const match = KEY.exec(line)
    if (!match) continue
    const name = match[1]
    // 값은 비었는지만 본다(따옴표만 있는 값도 빈 값). 값 자체는 이 함수 밖으로 나가지 않는다.
    const empty = match[2].replace(/\s+#.*$/, '').trim().replace(/^(['"])\1$/, '') === ''
    found.set(name, { name, kind: classifyKey(name), empty })
  }
  return [...found.values()]
}

export type EnvCheck = {
  /** 코드가 읽는 키(탐지 결과) 중 .env에 있는 것 */
  present: string[]
  /** 코드가 읽지만 .env에 없거나 값이 빈 것 → 기본값 */
  missing: string[]
  /** .env에만 있는 키 */
  extra: string[]
  expected: number
}

export function crossCheck(keys: EnvKey[], expected: string[]): EnvCheck {
  const filled = new Set(keys.filter(key => !key.empty).map(key => key.name))
  const wanted = new Set(expected)
  return {
    present: expected.filter(name => filled.has(name)),
    missing: expected.filter(name => !filled.has(name)),
    extra: keys.map(key => key.name).filter(name => !wanted.has(name)),
    expected: expected.length,
  }
}
