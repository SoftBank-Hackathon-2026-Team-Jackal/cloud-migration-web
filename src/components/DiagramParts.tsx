'use client'

import type { ReactNode } from 'react'
import * as Tabs from '@radix-ui/react-tabs'

/** 구성도 위쪽의 작은 탭(예: 구성도 | 변경 내용). 방향키 이동·포커스 관리는 Radix Tabs가 맡는다. */
export function ViewTabs<T extends string>({ items, value, onChange, label }: {
  items: Array<{ id: T; label: string }>
  value: T
  onChange: (next: T) => void
  label: string
}) {
  return <Tabs.Root className="view-tabs-root" value={value} onValueChange={next => onChange(next as T)} activationMode="manual">
    <Tabs.List className="view-tabs" aria-label={label}>
      {/* 탭 내용은 선택된 것만 화면에 있어서 Radix가 붙이는 aria-controls가 없는 요소를 가리킨다. 뺀다. */}
      {items.map(item => <Tabs.Trigger key={item.id} value={item.id} aria-controls={undefined} className={item.id === value ? 'is-selected' : ''}>{item.label}</Tabs.Trigger>)}
    </Tabs.List>
  </Tabs.Root>
}

/** 데이터베이스를 나타내는 원통 모양. */
export function Cylinder({ x, y, w, h, className = '', children }: { x: number; y: number; w: number; h: number; className?: string; children?: ReactNode }) {
  const ry = Math.min(9, h / 5)
  return <g className={'arch-node ' + className}>
    <path className="arch-box" d={`M${x} ${y + ry} v${h - ry * 2} a${w / 2} ${ry} 0 0 0 ${w} 0 v${-(h - ry * 2)}`} />
    <ellipse className="arch-box" cx={x + w / 2} cy={y + ry} rx={w / 2} ry={ry} />
    {children}
  </g>
}
