'use client'

import { useRef, useState, type ReactNode } from 'react'
import ParticleReveal from './ParticleReveal'

type Props = {
  kicker: string
  title: string
  subtitle: string
  className?: string
  /** 본문 패널이 자기 제목을 가진 화면(승인·완료)에서는 큰 제목이 중복되므로 숨긴다 */
  hideHeader?: boolean
  children: (ready: boolean) => ReactNode
}

/** 분석·계획 화면과 같은 방식(입자가 글자로 모이는 등장)으로 시작하는 단계 화면의 공통 틀. */
export default function StageShell({ kicker, title, subtitle, className = '', hideHeader = false, children }: Props) {
  const ref = useRef<HTMLElement>(null)
  const [ready, setReady] = useState(false)
  return <section ref={ref} className={'flow-stage ' + className + (ready ? ' is-ready' : '')} aria-label={title}>
    <header className="plan-heading flow-head" hidden={hideHeader}>
      <small data-particle-target="text">{kicker}</small>
      <h1 data-particle-target="text">{title}</h1>
      <p className="flow-fade">{subtitle}</p>
      <div className="flow-rule" data-particle-target="line" />
    </header>
    <div className="flow-body flow-fade">{children(ready)}</div>
    {!ready && <ParticleReveal stage={ref} onComplete={() => setReady(true)} />}
  </section>
}
