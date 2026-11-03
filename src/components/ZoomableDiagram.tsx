'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useT } from '../lib/i18n'

/** 렌즈 지름. 구성도 칸을 벗어나는 부분은 잘려 나간다. */
const LENS = 380
const MAGNIFY = 1.5
/** 렌즈가 커서를 따라오는 부드러움(프레임마다 남은 거리의 이 비율만큼 따라간다) */
const FOLLOW = 0.2
/**
 * 칸 뒤에 실제로 깔린 배경색. 반투명한 배경(패널 등)은 그 뒤 배경들과 섞어 불투명한 색 하나로 만든다.
 * 렌즈 바탕을 이 색으로 채워야 렌즈 뒤의 원본이 비쳐 보이지 않는다.
 */
function backdropOf(element: HTMLElement) {
  const layers: number[][] = []
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const found = getComputedStyle(node).backgroundColor.match(/[\d.]+/g)
    if (!found || found.length < 3) continue
    const [r, g, b, alpha = 1] = found.map(Number)
    if (alpha === 0) continue
    layers.push([r, g, b, alpha])
    if (alpha >= 1) break
  }
  let color = [255, 255, 255]
  for (const [r, g, b, alpha] of layers.reverse()) {
    color = [r, g, b].map((channel, index) => channel * alpha + color[index] * (1 - alpha))
  }
  return `rgb(${color.map(Math.round).join(',')})`
}

/**
 * 좁은 패널 안의 구성도에 두 가지 확대를 달아 준다.
 * - 마우스를 올리면 커서를 따라다니는 돋보기가 부드럽게 떠서 그 부분만 1.5배로 확대해 보여 준다. 커서가 항상 원의 중심이고, 칸 밖으로 나간 부분은 잘리며, 테두리 선 없이 옅은 그림자만 둔다.
 * - "크게 보기" 버튼을 누르면 화면 가운데에 큼직하게 띄운다. 창 동작(Esc·바깥 클릭·포커스 가두기·스크롤 잠금·스크린리더 안내)은 Radix Dialog가 맡고, 모양은 우리 CSS다.
 */
export default function ZoomableDiagram({ children }: { children: ReactNode }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [lensOn, setLensOn] = useState(false)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [backdrop, setBackdrop] = useState('#fff')
  const hostRef = useRef<HTMLDivElement>(null)
  const lensRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const target = useRef({ x: 0, y: 0 })
  const current = useRef({ x: 0, y: 0 })
  const frame = useRef(0)
  const fresh = useRef(true)

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  useEffect(() => {
    if (hostRef.current) setBackdrop(backdropOf(hostRef.current))
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = () => setBox({ w: host.clientWidth, h: host.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const place = () => {
    const lens = lensRef.current
    const inner = innerRef.current
    if (!lens || !inner) return
    const { x, y } = current.current
    // 커서가 항상 렌즈의 중심에 오고, 칸 밖으로 나간 부분은 칸(overflow:hidden)이 잘라 낸다.
    lens.style.transform = `translate3d(${x - LENS / 2}px, ${y - LENS / 2}px, 0)`
    inner.style.transform = `translate3d(${LENS / 2 - x * MAGNIFY}px, ${LENS / 2 - y * MAGNIFY}px, 0) scale(${MAGNIFY})`
  }

  const tick = () => {
    const dx = target.current.x - current.current.x
    const dy = target.current.y - current.current.y
    if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) {
      current.current = { ...target.current }
      place()
      frame.current = 0
      return
    }
    current.current = { x: current.current.x + dx * FOLLOW, y: current.current.y + dy * FOLLOW }
    place()
    frame.current = requestAnimationFrame(tick)
  }

  const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || open) return
    const host = hostRef.current
    if (!host) return
    // 버튼 위에서는 렌즈를 숨겨 버튼이 가려지지 않게 한다.
    if ((event.target as HTMLElement).closest('.diagram-zoom-btn')) { setLensOn(false); return }
    const rect = host.getBoundingClientRect()
    target.current = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    if (fresh.current) {
      // 처음 들어올 때는 날아오지 않고 커서 자리에서 바로 떠오른다.
      current.current = { ...target.current }
      fresh.current = false
      place()
    }
    setLensOn(true)
    if (!frame.current) frame.current = requestAnimationFrame(tick)
  }

  const onLeave = () => { setLensOn(false); fresh.current = true }

  return <div ref={hostRef} className="diagram-zoom" onPointerMove={onMove} onPointerLeave={onLeave}>
    {children}
    {!open && box.w > 0 && <div ref={lensRef} className={'diagram-lens' + (lensOn ? ' is-on' : '')} style={{ width: LENS, height: LENS }} aria-hidden="true">
      <div className="diagram-lens-scale" style={{ background: backdrop }}>
        <div ref={innerRef} className="diagram-lens-inner" style={{ width: box.w, height: box.h }}>{children}</div>
      </div>
    </div>}
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="diagram-zoom-btn" onClick={() => setLensOn(false)} aria-label={t('diagram.zoom')} title={t('diagram.zoom')}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2H14v4.5M6.5 14H2V9.5M14 2L9.2 6.8M2 14l4.8-4.8" /></svg>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="diagram-lightbox" />
        <Dialog.Content className="diagram-lightbox-card" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">{t('diagram.aria')}</Dialog.Title>
          <Dialog.Close className="diagram-lightbox-close" aria-label={t('diagram.close')} title={t('diagram.close')}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
          </Dialog.Close>
          <div className="diagram-lightbox-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>
}
