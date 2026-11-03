'use client'

import { useT } from '../lib/i18n'

/** 팀이 아직 합의하지 않은(상헌 제안) 동작에 붙이는 작은 표시. 합의가 끝나면 이 컴포넌트를 쓰는 곳에서만 지우면 된다. */
export default function ProposalTag() {
  const t = useT()
  return <small className="flow-pill proposal-tag" title={t('tag.proposalNote')}>{t('tag.proposal')}</small>
}
