/**
 * 모델 없이도 대답하는 규칙 기반 응답기. 키가 없거나 서버 호출이 실패했을 때의 대체이자 시험용이다.
 * 질문에서 뜻(단계·문제·기록·다음 할 일)을 키워드로 가려 상태 요약(AgentFacts)으로 답한다.
 */
import type { AgentFacts } from './context'

export type AgentLang = 'ko' | 'en' | 'ja'
export type Intent = 'stage' | 'problem' | 'log' | 'next'

const KEYWORDS: Array<[Intent, RegExp]> = [
  ['log', /로그|기록|읊|읽어|log|history|ログ|履歴/i],
  ['problem', /문제|오류|에러|실패|이상|왜|막혔|problem|error|issue|fail|wrong|問題|エラー|失敗/i],
  ['next', /다음|뭐 해야|무엇을 해야|해야|next|what should|次|何をすれば/i],
  ['stage', /단계|어디|진행|상태|지금|stage|where|progress|status|今|段階|進行|状況/i],
]

export function intentOf(question: string): Intent {
  for (const [intent, pattern] of KEYWORDS) if (pattern.test(question)) return intent
  return 'stage'
}

const STATUS: Record<AgentLang, Record<string, string>> = {
  ko: { idle: '대기 중', running: '진행 중', waiting: '승인 또는 확인을 기다리는 중', done: '완료', failed: '실패', cancelled: '취소됨' },
  en: { idle: 'idle', running: 'in progress', waiting: 'waiting for an approval or review', done: 'done', failed: 'failed', cancelled: 'cancelled' },
  ja: { idle: '待機中', running: '進行中', waiting: '承認または確認の待機中', done: '完了', failed: '失敗', cancelled: '取り消し' },
}

function stageDetail(facts: AgentFacts, lang: AgentLang): string {
  const f = facts
  switch (f.stage) {
    case 'rehearsal':
      return { ko: `시도 ${f.sandbox.attempt ?? '-'}/${f.sandbox.maxAttempts ?? 3}${f.sandbox.reviewWaiting ? ', 3회를 넘겨 사람 검토를 기다려요' : ''}.`, en: `Attempt ${f.sandbox.attempt ?? '-'}/${f.sandbox.maxAttempts ?? 3}${f.sandbox.reviewWaiting ? ', over the limit, waiting for a human review' : ''}.`, ja: `試行 ${f.sandbox.attempt ?? '-'}/${f.sandbox.maxAttempts ?? 3}${f.sandbox.reviewWaiting ? '、上限を超えたため人の確認待ちです' : ''}。` }[lang]
    case 'planning':
      return { ko: `계획 항목 ${f.plan.steps}개를 ${f.plan.ready ? '모두 만들었어요' : '만드는 중이에요'}.`, en: `${f.plan.steps} plan items ${f.plan.ready ? 'are ready' : 'so far'}.`, ja: `計画項目 ${f.plan.steps} 件${f.plan.ready ? 'が揃いました' : 'を作成中です'}。` }[lang]
    case 'approval':
      return { ko: f.plan.digestMismatch ? '이미지가 달라서 승인이 막혀 있어요.' : '이전 계획 승인을 기다려요.', en: f.plan.digestMismatch ? 'Approval is blocked because the images differ.' : 'Waiting for you to approve the plan.', ja: f.plan.digestMismatch ? 'イメージが異なるため承認がブロックされています。' : '計画の承認を待っています。' }[lang]
    case 'provisioning':
      return { ko: `리소스 ${f.provision.resourcesDone}/${f.provision.resourcesTotal} 완료, 준비 검사 ${f.provision.checksDone}/${f.provision.checksTotal}.`, en: `Resources ${f.provision.resourcesDone}/${f.provision.resourcesTotal} done, readiness checks ${f.provision.checksDone}/${f.provision.checksTotal}.`, ja: `リソース ${f.provision.resourcesDone}/${f.provision.resourcesTotal} 完了、準備検査 ${f.provision.checksDone}/${f.provision.checksTotal}。` }[lang]
    case 'data':
      return { ko: `복제 단계 ${f.data.step ?? '-'}, ${f.data.rows}/${f.data.totalRows}행, 지연 ${f.data.lagMs ?? '-'}ms, 정합성 확인 ${f.data.verifyDone ? '완료' : '대기'}.`, en: `Replication step ${f.data.step ?? '-'}, ${f.data.rows}/${f.data.totalRows} rows, lag ${f.data.lagMs ?? '-'} ms, consistency check ${f.data.verifyDone ? 'done' : 'pending'}.`, ja: `複製ステップ ${f.data.step ?? '-'}、${f.data.rows}/${f.data.totalRows} 行、遅延 ${f.data.lagMs ?? '-'}ms、整合性確認 ${f.data.verifyDone ? '完了' : '待機'}。` }[lang]
    case 'traffic':
      return { ko: `대상 환경으로 ${f.traffic.targetWeight}% 옮겼고 실패 요청은 ${f.traffic.failedRequests}건이에요.`, en: `${f.traffic.targetWeight}% of traffic is on the target; ${f.traffic.failedRequests} failed requests.`, ja: `対象環境へ ${f.traffic.targetWeight}% 移行、失敗リクエストは ${f.traffic.failedRequests} 件です。` }[lang]
    case 'cutover':
      return { ko: `DB 전환 ${f.cutover.doneSteps}/6 단계, 측정 결과 ${f.cutover.results}/3.`, en: `DB switch ${f.cutover.doneSteps}/6 steps, measurements ${f.cutover.results}/3.`, ja: `DB 切替 ${f.cutover.doneSteps}/6 段階、測定結果 ${f.cutover.results}/3。` }[lang]
    default:
      return ''
  }
}

/** 지금 눈에 띄는 문제 목록(없으면 빈 배열). */
export function problemsOf(facts: AgentFacts, lang: AgentLang): string[] {
  const out: string[] = []
  for (const failure of facts.failures) out.push({ ko: `${failure.phase} 단계 실패: ${failure.code}${failure.message ? ' (' + failure.message + ')' : ''}`, en: `${failure.phase} failed: ${failure.code}${failure.message ? ' (' + failure.message + ')' : ''}`, ja: `${failure.phase} が失敗: ${failure.code}${failure.message ? '（' + failure.message + '）' : ''}` }[lang])
  if (facts.sandbox.reviewWaiting) out.push({ ko: '샌드박스가 3회를 넘어 사람 검토를 기다려요.', en: 'The sandbox exceeded its attempts and is waiting for a human review.', ja: 'サンドボックスが試行上限を超え、人の確認を待っています。' }[lang])
  else if (facts.sandbox.failedChecks.length > 0) out.push({ ko: `샌드박스 검증 중 고치는 항목: ${facts.sandbox.failedChecks.join(', ')}.`, en: `Sandbox checks being fixed: ${facts.sandbox.failedChecks.join(', ')}.`, ja: `サンドボックスで修正中の項目: ${facts.sandbox.failedChecks.join(', ')}。` }[lang])
  if (facts.plan.digestMismatch) out.push({ ko: '검증한 이미지와 배포할 이미지(Digest)가 달라 승인이 막혀 있어요.', en: 'The verified image and the image to deploy differ (digest), so approval is blocked.', ja: '検証したイメージとデプロイするイメージ（Digest）が異なり、承認がブロックされています。' }[lang])
  if (facts.provision.failed.length > 0) out.push({ ko: `실패한 리소스: ${facts.provision.failed.join(', ')}.`, en: `Failed resources: ${facts.provision.failed.join(', ')}.`, ja: `失敗したリソース: ${facts.provision.failed.join(', ')}。` }[lang])
  if (facts.traffic.failedRequests > facts.traffic.maxFailedRequests) out.push({ ko: `실패 요청이 허용(${facts.traffic.maxFailedRequests}건)을 넘었어요.`, en: `Failed requests exceed the allowance (${facts.traffic.maxFailedRequests}).`, ja: `失敗リクエストが許容（${facts.traffic.maxFailedRequests} 件）を超えました。` }[lang])
  if (facts.traffic.phase === 'rolledback') out.push({ ko: '트래픽을 원본으로 되돌린 상태예요.', en: 'Traffic has been rolled back to the origin.', ja: 'トラフィックを元環境へ戻した状態です。' }[lang])
  if (facts.connection === 'reconnecting') out.push({ ko: '서버와 연결이 끊겨 다시 연결하는 중이에요.', en: 'The connection to the server dropped and is reconnecting.', ja: 'サーバーとの接続が切れ、再接続中です。' }[lang])
  return out
}

export function answerLocally(question: string, facts: AgentFacts, lang: AgentLang = 'ko'): string {
  const intent = intentOf(question)
  const status = STATUS[lang][facts.status] ?? facts.status
  const detail = stageDetail(facts, lang)
  if (intent === 'problem') {
    const problems = problemsOf(facts, lang)
    if (problems.length === 0) return { ko: `지금 눈에 띄는 문제는 없어요. ${facts.stageLabel} 단계가 ${status}.`, en: `I don't see any problem right now. The ${facts.stageLabel} stage is ${status}.`, ja: `今のところ問題は見当たりません。${facts.stageLabel} 段階は${status}。` }[lang]
    return problems.slice(0, 3).join(' ')
  }
  if (intent === 'log') {
    if (facts.recent.length === 0) return { ko: '아직 읽어 드릴 기록이 없어요.', en: 'There are no records to read yet.', ja: 'まだお読みする記録がありません。' }[lang]
    const joined = facts.recent.slice(-4).join(lang === 'ja' ? '、' : ', ')
    return { ko: `최근 기록이에요. ${joined}.`, en: `Recent records: ${joined}.`, ja: `最近の記録です。${joined}。` }[lang]
  }
  if (intent === 'next') {
    const next = {
      ko: facts.approval.required && facts.stage === 'approval' ? '이전 계획을 확인하고 승인해 주세요.' : facts.sandbox.reviewWaiting ? '사람 검토를 마치고 샌드박스를 다시 시도해 주세요.' : facts.approval.cutoverRequired && facts.stage === 'cutover' ? 'DB 전환을 승인해 주세요.' : '지금은 기다리면 다음 단계로 넘어가요.',
      en: facts.approval.required && facts.stage === 'approval' ? 'Review and approve the migration plan.' : facts.sandbox.reviewWaiting ? 'Finish the human review and retry the sandbox.' : facts.approval.cutoverRequired && facts.stage === 'cutover' ? 'Approve the DB switch.' : 'Nothing to do right now; the next stage starts automatically.',
      ja: facts.approval.required && facts.stage === 'approval' ? '移行計画を確認して承認してください。' : facts.sandbox.reviewWaiting ? '人の確認を終えてサンドボックスを再試行してください。' : facts.approval.cutoverRequired && facts.stage === 'cutover' ? 'DB 切替を承認してください。' : '今は待てば次の段階へ進みます。',
    }[lang]
    return next
  }
  return { ko: `지금은 ${facts.stageLabel} 단계이고 ${status}. ${detail}`, en: `We're in the ${facts.stageLabel} stage, ${status}. ${detail}`, ja: `今は${facts.stageLabel}段階で${status}。${detail}` }[lang].trim()
}
