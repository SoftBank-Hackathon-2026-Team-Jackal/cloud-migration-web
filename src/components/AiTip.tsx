'use client'

import * as HoverCard from '@radix-ui/react-hover-card'
import { useT, type MsgKey } from '../lib/i18n'

export type TipLine = { kind: 'del' | 'add'; text: string }
export type TipFix = { id: string; lines: TipLine[] }

/**
 * "AI 수정" 칩. 마우스를 올리거나 키보드로 포커스하면 AI가 무엇을 왜 어떻게 고쳤는지 보여 준다.
 * - 수정이 하나면 그 수정의 상세(고친 줄·원인·근거), 여러 개면 수정마다 이름·고친 줄·원인을 압축해서 나열한다.
 * - 칩 글자는 수정이 하나면 "AI 수정", 여러 개면 "AI 수정 3"처럼 개수를 붙인다.
 * 팝업은 Radix HoverCard가 문서 맨 바깥(body)에 그리고, 칩 오른쪽에 놓되 화면 가장자리에서는 알아서 왼쪽으로 뒤집고 세로로 밀어 화면 안에 들어오게 한다.
 * 칩이 들어 있는 줄(변경 내용의 pre 등)의 글꼴·여백·취소선 규칙이 팝업에 새어 들어가지 않는다.
 */
export default function AiTip({ fixes }: { fixes: TipFix[] }) {
  const t = useT()
  const many = fixes.length > 1

  return <HoverCard.Root openDelay={60} closeDelay={160}>
    <HoverCard.Trigger asChild>
      <span className="ai-tip" tabIndex={0}>
        <small className="flow-pill ai-tag">{many ? t('rehearsal.aiTagN', { n: fixes.length }) : t('rehearsal.aiTag')}</small>
      </span>
    </HoverCard.Trigger>
    <HoverCard.Portal>
      <HoverCard.Content className="ai-tip-body" side="right" align="start" sideOffset={10} collisionPadding={8}>
        <strong>{many ? t('rehearsal.aiTip.titleN', { n: fixes.length }) : t('rehearsal.aiTip.title')}</strong>
        {fixes.map(fix => <span key={fix.id} className="ai-tip-fix">
          {many && <b>{t(('rehearsal.fixLabel.' + fix.id) as MsgKey)}</b>}
          {fix.lines.map(line => <code key={line.kind + line.text} className={'is-' + line.kind}>{line.text}</code>)}
          <span>{t(('rehearsal.aiTip.' + fix.id + '.why') as MsgKey)}</span>
          {!many && <span>{t(('rehearsal.aiTip.' + fix.id + '.evidence') as MsgKey)}</span>}
        </span>)}
        <span className="ai-tip-result">{t('rehearsal.aiTip.result')}</span>
      </HoverCard.Content>
    </HoverCard.Portal>
  </HoverCard.Root>
}
