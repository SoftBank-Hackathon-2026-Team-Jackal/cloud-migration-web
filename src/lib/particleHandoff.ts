/**
 * 화면이 바뀔 때, 떠나는 화면을 입자 좌표로 기록해 두었다가 새 화면의 등장 애니메이션(ParticleReveal)이
 * 그 자리에서 출발하게 한다. 그러면 새 화면이 중앙에서 솟는 대신 "이전 화면이 흩어져 새 화면이 된다"로 보인다.
 */
export type HandoffPoint = { x: number; y: number }

const MAX_POINTS = 12000
const FRESH_MS = 2500
const SKIP = '.screen-fx,.particle-field,.stage-rail,.demo-controls,.lang-switch,canvas,script,style,.analysis-particle-reveal'

let saved: { at: number; points: HandoffPoint[] } = { at: 0, points: [] }

/** 화면(root) 안의 글자·테두리 위치를 입자 좌표로 뽑는다. */
export function samplePoints(root: Element | null): HandoffPoint[] {
  const points: HandoffPoint[] = []
  if (root) {
    const width = window.innerWidth
    const height = window.innerHeight
    for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      if (element.closest(SKIP)) continue
      const rect = element.getBoundingClientRect()
      if (rect.width < 2 || rect.height < 2 || rect.bottom < 0 || rect.top > height || rect.right < 0 || rect.left > width) continue
      const style = window.getComputedStyle(element)
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < 0.05) continue

      const hasText = Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
      if (hasText) {
        // 글자는 칸 안에서 점을 흩뿌려 "글자 먼지"로 보이게 한다.
        const count = Math.min(260, Math.round(rect.width * rect.height / 55))
        for (let i = 0; i < count; i++) points.push({ x: rect.left + Math.random() * rect.width, y: rect.top + Math.random() * rect.height })
      }
      const bordered = parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none'
      if (bordered && rect.width > 12 && rect.height > 12) {
        const perimeter = (rect.width + rect.height) * 2
        const count = Math.min(420, Math.round(perimeter / 4))
        for (let i = 0; i < count; i++) {
          const along = Math.random() * perimeter
          if (along < rect.width) points.push({ x: rect.left + along, y: rect.top })
          else if (along < rect.width + rect.height) points.push({ x: rect.right, y: rect.top + along - rect.width })
          else if (along < rect.width * 2 + rect.height) points.push({ x: rect.right - (along - rect.width - rect.height), y: rect.bottom })
          else points.push({ x: rect.left, y: rect.bottom - (along - rect.width * 2 - rect.height) })
        }
      }
    }
  }
  if (points.length > MAX_POINTS) {
    for (let i = points.length - 1; i > 0 && points.length > MAX_POINTS; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[points[i], points[j]] = [points[j], points[i]]
      points.pop()
    }
  }
  return points
}

/** 떠나는 화면의 입자 좌표를 기록해 둔다. 상태를 바꾸기 직전(옛 화면이 아직 보일 때)에 부른다. */
export function captureScreen(root: Element | null) {
  saved = { at: Date.now(), points: samplePoints(root) }
}

/** 방금 떠난 화면의 입자 좌표. 일정 시간이 지나면 비어 있다(처음 진입·새로고침은 기존처럼 중앙에서 시작). 개발 모드의 effect 중복 실행을 견디도록 읽어도 지우지 않는다. */
export function recentHandoff(): HandoffPoint[] {
  return Date.now() - saved.at < FRESH_MS ? saved.points : []
}

/** 화면 전환 입자 층(ScreenFx의 TransitionLayer)이 등록하는 조작면. 화면 컴포넌트는 이것만 안다. */
export type Layer = {
  /** 입자가 떠다니며 도착지를 기다리는 중이거나 이동 중인가 */
  active: () => boolean
  /** 떠나는 화면의 위치에서 입자를 풀어 준다 */
  start: (points: HandoffPoint[]) => void
  /** 새 화면의 도착지를 알려 준다. 받아들이면 true */
  accept: (targets: HandoffPoint[]) => boolean
  /** 도착지가 없는 화면(시작 화면 등)으로 가면 입자를 서서히 거둔다 */
  release: () => void
}

let layer: Layer | null = null
export function registerLayer(next: Layer | null) { layer = next }
export const fx = {
  active: () => layer?.active() ?? false,
  start: (points: HandoffPoint[]) => layer?.start(points),
  accept: (targets: HandoffPoint[]) => layer?.accept(targets) ?? false,
  release: () => layer?.release(),
}

/**
 * 같은 단계 화면 안에서 내용이 통째로 바뀔 때(예: DB 전환의 승인 → 진행 → 리포트)도 화면 전환과 같은 연출을 쓰기 위한 연결점.
 * FlowApp이 전환 실행기를 등록하고, 화면은 runTransition으로 부른다. 등록이 없으면 그냥 바로 실행한다.
 */
let runner: ((apply: () => void) => void) | null = null
export function registerTransition(next: ((apply: () => void) => void) | null) { runner = next }
export function runTransition(apply: () => void) { if (runner) runner(apply); else apply() }
