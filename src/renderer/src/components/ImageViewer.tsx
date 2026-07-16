import { useEffect, useRef, useState } from 'react'
import { imageSrc, imageName } from '../lib/images'
import { IconClose, IconChevLeft, IconChevRight, IconEye } from './icons'
import { MouseGestureLayer, scrollGestures, type GestureAction } from './mouseGesture'

/**
 * A modern, self-contained image lightbox. One image → a clean centered view; two or
 * more → a multi-viewer with prev/next, a counter and a thumbnail filmstrip. The index
 * is controlled by the parent so it can open the viewer at the clicked image.
 */
export function ImageViewer({
  images,
  index,
  onIndexChange,
  onClose
}: {
  images: string[]
  index: number
  onIndexChange: (i: number) => void
  onClose: () => void
}) {
  const multi = images.length > 1
  const [zoom, setZoom] = useState(false)
  // 원본이 fit 표시보다 실제로 큰가 — fit이 이미 원본 크기(작은 이미지)면 "확대"는 자리
  // 이동 말고는 아무 일도 안 해서 zoom-in 커서가 거짓말이 된다. 그런 이미지는 확대 자체를
  // 막고 커서도 평범하게 둔다.
  const [zoomable, setZoomable] = useState(false)
  const [rootEl, setRootEl] = useState<HTMLElement | null>(null) // 마우스 제스처 대상
  const stripRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  // a backdrop click closes — but only if the press also started on the backdrop, so a
  // drag that ends outside the image doesn't accidentally dismiss it
  const downOnBackdrop = useRef(false)

  const go = (delta: number): void => {
    if (!multi) return
    onIndexChange((index + delta + images.length) % images.length)
  }

  const path = images.length ? images[Math.min(Math.max(0, index), images.length - 1)] : ''

  // reset zoom whenever the shown image changes
  useEffect(() => {
    setZoom(false)
    setZoomable(false)
  }, [path])

  // zoomable 판정 — 로드 때와 창 크기가 바뀔 때(fit 크기가 변한다) 다시 잰다. contain은
  // 두 축을 같은 비율로 줄이므로 폭 비교 하나로 충분하지만 반올림 여유로 양 축을 본다.
  // 확대 중엔 렌더 크기 = 원본 크기라 잴 수 없으니 건너뛴다(돌아오면 RO가 다시 잰다).
  const measure = (): void => {
    const img = imgRef.current
    if (!img || !img.naturalWidth || zoomRef.current) return
    setZoomable(img.naturalWidth > img.clientWidth + 1 || img.naturalHeight > img.clientHeight + 1)
  }
  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    const ro = new ResizeObserver(measure)
    ro.observe(img)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]) // img는 key={path}로 리마운트 — 새 엘리먼트를 다시 관찰

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, images.length])

  // keep the active filmstrip thumbnail in view as you navigate
  useEffect(() => {
    stripRef.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [index])

  if (!images.length) return null

  // 우클릭 드래그 제스처 — ←/→는 이전/다음 사진(키보드 화살표와 동일), ↑/↓는 확대 스크롤,
  // ↓→(L자)는 닫기. 갈 곳이 없으면 라벨로 정직하게 알리고 실행은 no-op(코드 카드와 같은 규칙).
  const gestureActions: GestureAction[] = [
    { pattern: 'L', label: multi ? '이전 사진' : '다른 사진 없음', run: () => go(-1) },
    { pattern: 'R', label: multi ? '다음 사진' : '다른 사진 없음', run: () => go(1) },
    ...scrollGestures(() => rootEl?.querySelector('.iv-imgwrap')),
    { pattern: 'DR', label: '닫기', run: onClose }
  ]

  return (
    <div
      className="iv-overlay"
      ref={setRootEl}
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose()
      }}
    >
      <div className="iv-top">
        <div className="iv-name htip" data-tip={path}>
          {imageName(path)}
        </div>
        {multi && (
          <div className="iv-count">
            {index + 1} <span>/</span> {images.length}
          </div>
        )}
        <span className="iv-spacer" />
        <button
          className="iv-tbtn htip"
          data-tip="기본 앱으로 열기"
          aria-label="기본 앱으로 열기"
          onClick={() => window.api.openPath('', path).catch(() => {})}
        >
          <IconEye size={16} />
        </button>
        <button className="iv-tbtn htip" data-tip="닫기 (Esc)" aria-label="닫기" onClick={onClose}>
          <IconClose size={17} />
        </button>
      </div>

      <div className="iv-stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
        {multi && (
          <button className="iv-nav prev" aria-label="이전" onClick={() => go(-1)}>
            <IconChevLeft size={26} />
          </button>
        )}
        <div
          className={'iv-imgwrap' + (zoom ? ' zoom scroll' : '')}
          // 확대 중엔 랩이 무대 전체를 덮는다 — 이미지 옆 여백 클릭은 확대 해제로
          onClick={(e) => e.target === e.currentTarget && setZoom(false)}
        >
          <img
            key={path}
            ref={imgRef}
            src={imageSrc(path)}
            alt={imageName(path)}
            className={'iv-img' + (zoom ? ' zoomed' : '') + (zoomable ? '' : ' nozoom')}
            draggable={false}
            decoding="async"
            onLoad={measure}
            onClick={() => zoomable && setZoom((z) => !z)}
          />
        </div>
        {multi && (
          <button className="iv-nav next" aria-label="다음" onClick={() => go(1)}>
            <IconChevRight size={26} />
          </button>
        )}
      </div>

      {multi && (
        <div className="iv-strip scroll" ref={stripRef}>
          {images.map((p, i) => (
            <button
              key={p + i}
              data-i={i}
              className={'iv-thumb' + (i === index ? ' on' : '')}
              onClick={() => onIndexChange(i)}
              aria-label={imageName(p)}
              aria-current={i === index}
            >
              {/* 화면 밖 썸네일은 디코드를 미룬다 — 첨부 이미지가 많아도 스트립 전체를
                  한 번에 풀해상도로 디코드하지 않게(보이는 것만 디코드). 원본 파일을 그대로
                  쓰되 스크롤로 들어올 때 로드된다. */}
              <img src={imageSrc(p)} alt={imageName(p)} draggable={false} loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      )}
      <MouseGestureLayer target={rootEl} actions={gestureActions} />
    </div>
  )
}
