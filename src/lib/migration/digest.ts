/**
 * 이미지 Digest 대조: 빌드한 이미지 = 검증한 이미지 = 배포할 이미지.
 * 값이 둘 이상 있고 하나라도 다르면 mismatch(승인을 막는다), 모두 같으면 match, 비교할 값이 모자라면 unknown(막지 않는다).
 * 런타임 import 없음(Node 단위 테스트가 그대로 읽는다).
 */
export type DigestCheck = {
  status: 'match' | 'mismatch' | 'unknown'
  built: string | null
  verified: string | null
  deploy: string | null
}

export function checkDigests(input: { built?: string | null; verified?: string | null; deploy?: string | null }): DigestCheck {
  const built = input.built ?? null
  const verified = input.verified ?? null
  const deploy = input.deploy ?? null
  const present = [built, verified, deploy].filter((value): value is string => !!value)
  const status = present.length < 2 ? 'unknown' : present.every(value => value === present[0]) ? 'match' : 'mismatch'
  return { status, built, verified, deploy }
}
