'use client'

import { useEffect, useRef, useState } from 'react'
import { useT } from '../lib/i18n'

type Kind = 'old' | 'new' | 'queued' | 'fail'

const CELLS = 44
const TICK_MS = 250

type Props = {
  /** 새 환경으로 가는 요청 비율(0~100). 트래픽 단계는 가중치, 전환 단계는 100 */
  weightNew: number
  /** 새 환경에서 오류가 나는 중(장애 주입) */
  failing?: boolean
  /** DB 전환 중 쓰기가 잠깐 대기열에 쌓이는 중 */
  queued?: boolean
}

/**
 * 이전하는 내내 끊기지 않고 흘러가는 요청을 한 줄로 보여 준다("무중단"의 증거).
 * 요청 하나하나가 어느 환경으로 갔는지, 대기·실패가 있었는지를 칸으로 그린다. 데모용 값이다.
 */
export default function LiveRequests({ weightNew, failing = false, queued = false }: Props) {
  const t = useT()
  const [cells, setCells] = useState<Kind[]>(() => Array.from({ length: CELLS }, () => 'old'))
  const [failed, setFailed] = useState(0)
  const [waiting, setWaiting] = useState(0)
  const [rps, setRps] = useState(118)
  const live = useRef({ weightNew, failing, queued })
  useEffect(() => { live.current = { weightNew, failing, queued } }, [weightNew, failing, queued])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = live.current
      let kind: Kind
      if (now.queued) kind = 'queued'
      else if (now.failing && Math.random() < .55) kind = 'fail'
      else kind = Math.random() * 100 < now.weightNew ? 'new' : 'old'
      setCells(current => [...current.slice(1), kind])
      if (kind === 'fail') setFailed(count => count + 1)
      // 대기열은 쌓이다가, 연결이 재개되면 모두 처리되어 0으로 돌아온다(유실 없음).
      setWaiting(count => now.queued ? count + 7 : Math.max(0, count - 9))
      setRps(now.queued ? 0 : 118 + Math.round(Math.sin(performance.now() / 900) * 12))
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [])

  return <div className="live-req" role="img" aria-label={t('live.aria')}>
    <div className="live-req-head">
      <span className="live-req-dot" aria-hidden="true" />
      <strong>{t('live.title')}</strong>
      <em>{t('live.rps', { n: rps })}</em>
      <em className={failed > 0 ? 'is-bad' : ''}>{t('live.failed', { n: failed })}</em>
      <em>{waiting > 0 ? t('live.queued', { n: waiting }) : t('live.loss')}</em>
    </div>
    <div className="live-req-cells" aria-hidden="true">
      {cells.map((kind, index) => <i key={index} className={'is-' + kind} />)}
    </div>
    <div className="live-req-legend" aria-hidden="true">
      <span><i className="is-old" />{t('live.legend.old')}</span>
      <span><i className="is-new" />{t('live.legend.new')}</span>
      <span><i className="is-queued" />{t('live.legend.queued')}</span>
      <span><i className="is-fail" />{t('live.legend.fail')}</span>
    </div>
  </div>
}
