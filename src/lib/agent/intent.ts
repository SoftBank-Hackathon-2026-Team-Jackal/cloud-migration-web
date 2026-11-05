/**
 * 첫 화면에서 발표자가 말한 이전 의도("AWS에 있는 채팅 서비스를 우리 사무실 서버로 옮기고 싶어")에서 대상을 고른다.
 * 의도를 해석하는 에이전트 API가 아직 없어서 낱말로 맞춘다. 대상이 둘 다 나오거나 하나도 없으면 null(되묻기).
 * 이 파일은 단위 테스트(node --test)가 직접 읽으므로 런타임 import를 두지 않는다.
 */
export type IntentTarget = 'gcp' | 'onprem'

const normalize = (value: string) => value.toLowerCase().replace(/[\s.,!?~·'"“”‘’]/g, '')

const WORDS: Record<IntentTarget, RegExp> = {
  onprem: /(온프레미스|온프렘|사무실|사내|자체서버|우리서버|회사서버|우리회사|k3s|케이쓰리|onprem|onpremise|office|オンプレ|社内|自社)/,
  gcp: /(gcp|구글|google|gke|지씨피|지케이이|グーグル)/,
}

/** "서비스를 옮기고 싶다"처럼 이전을 바라는 말인지(호출어·잡담과 구분) */
const MOVE = /(옮기|이전|마이그레이션|migrat|move|移行|移し|移す|옮겨)/

export function targetFromUtterance(text: string): IntentTarget | null {
  const said = normalize(text)
  const hits = (Object.keys(WORDS) as IntentTarget[]).filter(target => WORDS[target].test(said))
  return hits.length === 1 ? hits[0] : null
}

export function isMoveIntent(text: string): boolean {
  const said = normalize(text)
  return MOVE.test(said) || targetFromUtterance(text) !== null
}

/** "추천해 줘 / 알아서 골라 줘"처럼 대상 선택을 자칼에게 맡기는 말 */
export function isRecommendRequest(text: string): boolean {
  return /(추천|골라줘|골라봐|알아서|아무거나|어디가좋|recommend|suggest|youchoose|yourpick|youdecide|おすすめ|お勧め|任せ|選んで)/.test(normalize(text))
}

/** 설정 화면에서 "좋아, 시작하자" */
export function isStartCommand(text: string): boolean {
  return /(시작하자|시작해|시작할게|진행하자|진행해|가자|start|go ahead|始め|開始)/.test(text.toLowerCase().replace(/[.,!?~]/g, ''))
}
