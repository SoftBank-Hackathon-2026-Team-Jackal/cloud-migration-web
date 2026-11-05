// Jackal 위젯의 작은 선 아이콘(16px, currentColor). 꺼짐 상태는 사선으로 그어 모양만으로도 구분되게 한다.
const base = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }

export function MicIcon({ off }: { off?: boolean }) {
  return <svg {...base}>
    <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" />
    <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.25" />
    {off && <path d="M2.5 2.5l11 11" />}
  </svg>
}

export function SpeakerIcon({ off }: { off?: boolean }) {
  return <svg {...base}>
    <path d="M2.25 6v4h2.5L8.5 13V3L4.75 6z" />
    {off ? <path d="M11 6.25l3.5 3.5M14.5 6.25L11 9.75" /> : <path d="M10.75 5.75a3.2 3.2 0 0 1 0 4.5M12.75 3.75a6 6 0 0 1 0 8.5" />}
  </svg>
}

export function FoldIcon() {
  return <svg {...base}><path d="M4 8h8" /></svg>
}
