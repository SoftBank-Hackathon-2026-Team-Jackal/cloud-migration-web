'use client'

import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../lib/i18n'
import { fitText, withPort } from '../lib/svgText'
import type { DataLsnData, DataPhase, PreflightCheck, PreflightNetwork, Target } from '../lib/migration/events'

/**
 * 이전 경로와 복제 상태: AWS VPC(앱 · PgBouncer · 원본 DB) ↔ 사설 터널 ↔ 대상(복제 실행 노드 · 대상 DB).
 * 사전 검사 중에는 검사 패킷이 터널을 오가고 시작 차단 막대가 서 있다(실패하면 빨갛게 남는다).
 * PASS면 터널이 WAL 테이프가 된다: 스키마 → 빗금(초기 복사) → 흐르는 블록(스트리밍).
 * 원본 쓰기 위치와 대상 재생 위치 표식 사이가 복제 지연이고, 0이면 대상 DB 테두리가 금색이 된다.
 * 큰 화면에서는 세로로 늘어나 카드 높이를 채운다(viewBox 높이를 카드 비율에 맞춘다).
 */
type Props = {
  target: Target
  network: PreflightNetwork | null
  verdict: 'RUNNING' | 'PASS' | 'FAIL' | 'UNKNOWN' | null
  route: PreflightCheck | null
  phase: DataPhase | null
  /** 초기 복사 진행(0~1) */
  copy: number
  tapeLabel: string
  lsn: DataLsnData | null
  synced: boolean
}

const W = 1000
const X0 = 300
const X1 = 700
const SPAN = X1 - X0
const LAG_SCALE_MS = 3400

function useViewHeight(ref: React.RefObject<HTMLDivElement | null>) {
  const [height, setHeight] = useState(380)
  useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height: h } = entry.contentRect
      if (width < 10 || h < 10) return
      // 좁은 화면에서는 구성도가 카드 안에서 가로로 넘어가므로(data.css) 기본 비율을 쓴다.
      if (width < 700) { setHeight(380); return }
      // 가로 1000 기준으로 카드 비율만큼 세로를 늘린다(320~640).
      const next = Math.round(Math.max(320, Math.min(640, (W * h) / width)))
      setHeight(prev => (Math.abs(prev - next) > 2 ? next : prev))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])
  return height
}

export default function ReplicationDiagram({ target, network, verdict, route, phase, copy, tapeLabel, lsn, synced }: Props) {
  const { t, lang } = useI18n()
  const locale = lang === 'ko' ? 'ko-KR' : lang === 'ja' ? 'ja-JP' : 'en-US'
  const box = useRef<HTMLDivElement>(null)
  const H = useViewHeight(box)

  const blocked = verdict === 'FAIL' || verdict === 'UNKNOWN'
  const passed = verdict === 'PASS'
  const replicating = phase === 'copy' || phase === 'catchup' || phase === 'streaming'
  const streaming = phase === 'catchup' || phase === 'streaming'
  const probing = !passed && !blocked && route !== null && route.status !== 'PENDING'

  // 세로 배치: 기본(높이 320)은 앱 40 + 10 + PgBouncer 34 + 10 + DB 130을 한 묶음으로 두고,
  // 카드가 세로로 길면 남는 높이(extra)를 위 여백 · 상자 사이 · DB 상자 높이에 나눠 준다(큰 화면에서 카드를 채운다).
  const zoneTop = 14
  const zoneBottom = H - 14
  const extra = Math.max(0, H - 320)
  const stackTop = Math.round(zoneTop + 40 + 6 + extra * 0.12)
  const gapA = Math.round(10 + extra * 0.24)
  const pgbTop = stackTop + 40 + gapA
  const dbTop = pgbTop + 34 + gapA
  const dbH = Math.round(130 + extra * 0.22)
  const nodeTop = pgbTop + 34 - 84 // 노드 상자 아래끝을 PgBouncer 아래끝에 맞춘다
  const ty = dbTop + 12 + Math.round(extra * 0.08) // 터널 가운데
  const sourceName = network ? network.source_db.split(/[.:]/)[0] : '—'
  const sourcePort = network?.source_db.split(':')[1] ?? '5432'
  const pathLabel = !network ? '' : network.path.kind === 'wireguard' ? 'WireGuard' : network.path.kind === 'cloud_vpn' ? 'Cloud VPN' : t('dmig.d.path')
  const pathDetail = !network ? '' : network.path.name + (network.path.kind === 'wireguard' && network.path.cidr ? ' · ' + network.path.cidr : network.path.kind === 'cloud_vpn' ? ' · IPsec' : '')

  // 경로 조회 결과(터널 위 한 줄)
  const routeShort = route?.evidence ? route.evidence.split(' src ')[0] : ''
  const routeText = !network ? '' : !route || route.status === 'PENDING' ? `ip route get ${network.source_addr} → ?`
    : route.status === 'RUNNING' ? `ip route get ${network.source_addr} …`
    : route.status === 'FAIL' ? `→ ${routeShort} (${t('dmig.d.notTunnel')})`
    : route.status === 'SKIPPED' ? '' : `→ ${route.evidence}`
  const routeShown = fitText(routeText, 40)

  // 원본 쓰기 · 대상 재생 표식
  const lag = lsn?.lag_ms ?? null
  const sx = X1 - 46
  const tx = sx - (lag === null ? 0 : Math.min(SPAN - 60, (lag / LAG_SCALE_MS) * (SPAN - 80)))
  const lagBytes = lsn?.lag_bytes ?? 0
  const gapText = !replicating || !lsn ? '' : synced ? t('dmig.d.synced') : `${(lagBytes / 1e6).toLocaleString(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} MB · ${(lag ?? 0).toLocaleString(locale)} ms`
  const gapSub = !replicating || !lsn ? '' : synced ? t('dmig.d.syncedSub') : t('dmig.d.gapSub')
  const targetZone = target === 'onprem' ? t('dmig.d.zone.onprem') : t('dmig.d.zone.gcp')
  const clipId = 'dm-tape-' + target

  return <div ref={box} className="dm-diagram">
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={t('dmig.d.aria')}
      className={'dm-svg' + (blocked ? ' is-blocked' : '') + (synced ? ' is-synced' : '')}>
      <defs>
        <pattern id="dm-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" stroke="#0a0a0a" strokeWidth="1.4" /></pattern>
        <pattern id="dm-dots" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r=".9" fill="#c9c9c9" /></pattern>
        <clipPath id={clipId}><rect x={X0} y={ty - 22} width={SPAN} height={44} /></clipPath>
        <clipPath id={clipId + '-pend'}><rect x={X0} y={ty - 22} width={Math.max(0, sx - 4 - X0)} height={44} /></clipPath>
        <clipPath id={clipId + '-done'}><rect className="dm-move" x={X0} y={ty - 22} width={Math.max(0, tx - X0)} height={44} /></clipPath>
      </defs>

      {/* AWS VPC (원본) */}
      <rect x="20" y={zoneTop} width="270" height={zoneBottom - zoneTop} rx="14" fill="url(#dm-dots)" stroke="#d6d6d6" />
      <text x="38" y={zoneTop + 26} className="dm-t-zone">AWS · VPC</text>
      <text x="272" y={zoneTop + 26} className="dm-t-zone dm-mono" textAnchor="end">{fitText(network?.source_cidr ?? '', 22)}</text>
      <rect x="38" y={stackTop} width="234" height="40" rx="8" fill="#fff" stroke="#d6d6d6" />
      <text x="54" y={stackTop + 25} className="dm-t-box">{t('dmig.d.srcApp')}</text>
      <text x="256" y={stackTop + 25} className="dm-t-small dm-mono" textAnchor="end">env-a</text>
      {/* 앱은 PgBouncer를 거쳐서만 DB에 붙는다 */}
      <line x1="155" y1={stackTop + 40} x2="155" y2={pgbTop} stroke="#bdbdbd" strokeDasharray="3 3" />
      <line x1="155" y1={pgbTop + 34} x2="155" y2={dbTop} stroke="#0a0a0a" strokeWidth="1.5" />
      <rect x="38" y={pgbTop} width="234" height="34" rx="8" fill="#0a0a0a" />
      <text x="54" y={pgbTop + 22} className="dm-t-box is-inv" fontWeight="600">PgBouncer</text>
      <text x="256" y={pgbTop + 22} className="dm-t-small is-inv-muted" textAnchor="end">→ {sourceName}{synced ? ' · ' + t('dmig.d.pgbWait') : ''}</text>
      <rect x="38" y={dbTop} width="234" height={dbH} rx="10" fill="#fff" stroke="#0a0a0a" strokeWidth="1.5" />
      <text x="56" y={dbTop + 26} className="dm-t-small">{t('dmig.d.srcDb')}</text>
      <text x="56" y={dbTop + 50} className="dm-t-name">{fitText(sourceName, 20)}</text>
      <text x="56" y={dbTop + dbH - 54} className="dm-t-small">{t('dmig.d.write')}</text>
      <text x="56" y={dbTop + dbH - 34} className="dm-t-lsn dm-mono">{lsn?.source_lsn ?? '—'}</text>
      <text x="56" y={dbTop + dbH - 12} className="dm-t-small dm-mono">{network ? fitText(withPort(network.source_addr, sourcePort), 30, 6) : ''}</text>

      {/* 대상 */}
      <rect x="710" y={zoneTop} width="270" height={zoneBottom - zoneTop} rx="14" fill="url(#dm-dots)" stroke="#d6d6d6" />
      <text x="728" y={zoneTop + 26} className="dm-t-zone">{targetZone}</text>
      <text x="962" y={zoneTop + 26} className="dm-t-zone dm-mono" textAnchor="end">{fitText(network?.target_cidr ?? '', 22)}</text>
      <rect x="728" y={nodeTop} width="234" height="84" rx="8" fill="#fff" stroke="#d6d6d6" />
      <text x="744" y={nodeTop + 22} className="dm-t-box">{fitText((network?.replication_node ?? '—') + ' · ' + t('dmig.d.runner'), 30)}</text>
      <rect x="744" y={nodeTop + 34} width="96" height="38" rx="6" fill="#fff" stroke="#0a0a0a" strokeDasharray="3 2" className={probing ? 'dm-probe-pod is-active' : 'dm-probe-pod'} />
      <text x="792" y={nodeTop + 57} className="dm-t-small is-ink" textAnchor="middle">{t('dmig.d.probe')}</text>
      <rect x="850" y={nodeTop + 34} width="96" height="38" rx="6" fill={replicating ? '#0a0a0a' : '#f3f3f3'} stroke={replicating ? '#0a0a0a' : '#d6d6d6'} />
      <text x="898" y={nodeTop + 57} className={'dm-t-small' + (replicating ? ' is-inv' : '')} textAnchor="middle">{replicating ? t('dmig.d.subOn') : t('dmig.d.subWait')}</text>
      <line x1="898" y1={nodeTop + 84} x2="898" y2={dbTop} stroke={replicating ? '#0a0a0a' : '#bdbdbd'} strokeWidth={replicating ? 1.5 : 1} strokeDasharray={replicating ? undefined : '3 3'} />
      <rect x="728" y={dbTop} width="234" height={dbH} rx="10" fill="#fff" stroke={synced ? '#b08a2e' : '#0a0a0a'} strokeWidth={synced ? 2.5 : 1.5} className="dm-target" />
      <text x="746" y={dbTop + 26} className="dm-t-small">{t('dmig.d.dstDb')}</text>
      <text x="746" y={dbTop + 50} className="dm-t-name">{fitText(network?.target_db ?? '—', 20)}</text>
      <text x="746" y={dbTop + dbH - 54} className="dm-t-small">{t('dmig.d.replay')}</text>
      <text x="746" y={dbTop + dbH - 34} className="dm-t-lsn dm-mono">{lsn?.target_lsn ?? '—'}</text>
      <text x="746" y={dbTop + dbH - 12} className="dm-t-small dm-mono">{fitText(network?.target_db_detail ?? '', 30, 6)}</text>

      {/* 터널 = WAL 테이프 */}
      <text x="500" y={ty - 70} textAnchor="middle" className="dm-t-box">{pathLabel} <tspan className="dm-mono">{pathDetail}</tspan></text>
      <text x="500" y={ty - 50} textAnchor="middle" className={'dm-t-small dm-mono' + (route?.status === 'FAIL' ? ' is-neg' : '')}>{routeShown}</text>
      <line x1="290" y1={ty - 24} x2="710" y2={ty - 24} stroke="#0a0a0a" strokeWidth="1.5" />
      <line x1="290" y1={ty + 24} x2="710" y2={ty + 24} stroke="#0a0a0a" strokeWidth="1.5" />
      <line x1="290" y1={ty - 30} x2="710" y2={ty - 30} stroke="#cfcfcf" />
      <line x1="290" y1={ty + 30} x2="710" y2={ty + 30} stroke="#cfcfcf" />
      <g clipPath={`url(#${clipId})`}>
        {phase !== 'tunnel' && phase !== 'preflight' && phase !== 'blocked' && phase !== 'schema' && phase !== null
          && <rect className="dm-copy" x={X0} y={ty - 21} width={SPAN * Math.max(0, Math.min(1, copy))} height="42" fill="url(#dm-hatch)" />}
        {streaming && <>
          <g clipPath={`url(#${clipId}-pend)`}><g className="dm-ticks">{Array.from({ length: 22 }, (_, index) => <rect key={index} x={X0 + index * 22 + 2} y={ty - 8} width="7" height="16" rx="1" fill="#b5b5b5" />)}</g></g>
          <g clipPath={`url(#${clipId}-done)`}><g className="dm-ticks">{Array.from({ length: 22 }, (_, index) => <rect key={index} x={X0 + index * 22 + 2} y={ty - 8} width="12" height="16" rx="1" fill="#0a0a0a" />)}</g></g>
        </>}
        {probing && <g className="dm-packets"><circle cx={X1} cy={ty} r="4" fill="#0a0a0a" /><circle cx={X1 + 18} cy={ty} r="2.5" fill="#9a9a9a" /></g>}
      </g>
      {tapeLabel && <text x="500" y={ty + 4} textAnchor="middle" className="dm-t-tape">{tapeLabel}</text>}

      {/* 시작 차단 막대: 판정 전에는 검사 중, 실패하면 빨갛게 남는다 */}
      {!passed && <g className="dm-barrier">
        <rect x="694" y={ty - 40} width="10" height="80" rx="2" fill={blocked ? '#c4242a' : '#0a0a0a'} />
        <text x="699" y={ty + 56} textAnchor="middle" className={'dm-t-tiny' + (blocked ? ' is-neg' : '')}>{blocked ? t('dmig.d.blocked') : t('dmig.d.checking')}</text>
      </g>}

      {/* 원본 쓰기 · 대상 재생 표식 */}
      {replicating && lsn && <>
        <g className="dm-move" style={{ transform: `translateX(${sx}px)` }}>
          <line x1="0" y1={ty - 38} x2="0" y2={ty + 38} stroke="#0a0a0a" strokeWidth="2.5" />
          <text x="0" y={ty - 44} textAnchor="middle" className="dm-t-small is-ink" fontWeight="600">{t('dmig.d.headWrite')}</text>
        </g>
        <g className="dm-move" style={{ transform: `translateX(${tx}px)` }}>
          <line x1="0" y1={ty - 38} x2="0" y2={ty + 38} stroke={synced ? '#b08a2e' : '#0a0a0a'} strokeWidth="2" strokeDasharray="4 3" />
          <text x="0" y={ty + 54} textAnchor="middle" className="dm-t-small">{t('dmig.d.headReplay')}</text>
        </g>
      </>}
      <text x="500" y={ty + 90} textAnchor="middle" className={'dm-t-gap dm-mono' + (synced ? ' is-gold' : '')}>{gapText}</text>
      <text x="500" y={ty + 112} textAnchor="middle" className="dm-t-small">{gapSub}</text>
    </svg>
  </div>
}
