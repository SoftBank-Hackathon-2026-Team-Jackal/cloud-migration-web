/**
 * .env 파일을 브라우저 안에서만 읽어 "키 이름"만 꺼낸다. 값은 읽는 즉시 버리고 어디에도 담지 않는다
 * (화면·로그·상태·요청 어디에도 값이 남지 않게, 돌려주는 객체에 값 필드가 아예 없다).
 * 값은 나중에 플랫폼 Secret 참조로만 전달된다(백엔드 문서: .env 원문은 워크플로 입력·기록·로그에 남기지 않는다).
 * 이 파일은 단위 테스트(node --test)가 직접 읽으므로 런타임 import를 두지 않는다.
 */
export type EnvKey = { name: string; empty: boolean }

const KEY = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/

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
    found.set(name, { name, empty })
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

/*
 * .env 키 분류 [가정: 백엔드 분석(cmp_contracts.analysis.EnvExceptions)이 나중에 준다. 지금은 목업 값].
 * 화면은 키 이름으로 분류를 짐작하지 않는다: 받은 분류만 그대로 보인다.
 * - excluded: 원본 환경에 묶여 대상으로 옮기지 않는 키
 * - replaced: 대상 DB의 출력에 묶이는 키. 값은 바인딩 참조 이름(예: 대상 DB URL Secret 참조) — 비어 있으면 아직 모른다
 * - missing: 코드가 읽지만 .env에 선언되지 않은 키
 * - others: 그 밖의 키를 어떻게 다루는지(예: COPY = 그대로 사용) [확인 대기]. 없으면 화면은 '분류 대기'로 보인다
 */
export type EnvExceptions = {
  excluded: string[]
  replaced: Record<string, string>
  missing: string[]
  others?: 'COPY' | (string & {})
}
export type EnvTreatment = 'excluded' | 'replaced' | 'missing' | 'others' | 'pending'
/** 화면 한 줄. ref는 replaced의 바인딩 참조 이름(있을 때만), others는 그 밖의 키 처리 값 그대로 */
export type EnvRow = { name: string; treatment: EnvTreatment; empty: boolean; ref?: string; others?: string }

/** 받은 분류로 줄을 만든다: .env 키(파일 순서) → .env에 없는 missing 키. 분류가 없으면 모두 '분류 대기'. */
export function classifyEnv(keys: EnvKey[], exceptions: EnvExceptions | null | undefined): EnvRow[] {
  if (!exceptions) return keys.map(key => ({ name: key.name, treatment: 'pending', empty: key.empty }))
  const excluded = new Set(exceptions.excluded)
  const missing = new Set(exceptions.missing)
  const declared = new Set(keys.map(key => key.name))
  const rows: EnvRow[] = keys.map(key => {
    if (excluded.has(key.name)) return { name: key.name, treatment: 'excluded', empty: key.empty }
    if (key.name in exceptions.replaced) {
      const ref = exceptions.replaced[key.name]
      return { name: key.name, treatment: 'replaced', empty: key.empty, ...(ref ? { ref } : {}) }
    }
    if (missing.has(key.name)) return { name: key.name, treatment: 'missing', empty: key.empty }
    return exceptions.others
      ? { name: key.name, treatment: 'others', empty: key.empty, others: exceptions.others }
      : { name: key.name, treatment: 'pending', empty: key.empty }
  })
  for (const name of exceptions.missing) if (!declared.has(name)) rows.push({ name, treatment: 'missing', empty: true })
  return rows
}

/** 분류별 개수(요약 한 줄용) */
export function envCounts(rows: EnvRow[]): Record<EnvTreatment, number> {
  const counts: Record<EnvTreatment, number> = { excluded: 0, replaced: 0, missing: 0, others: 0, pending: 0 }
  for (const row of rows) counts[row.treatment]++
  return counts
}
