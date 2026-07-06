import { useEffect, useRef, useState } from 'react'
import { imageSrc, imageName } from '../lib/images'
import { IconClose, IconChevLeft, IconChevRight, IconEye } from './icons'

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
  const stripRef = useRef<HTMLDivElement>(null)
  // a backdrop click closes — but only if the press also started on the backdrop, so a
  // drag that ends outside the image doesn't accidentally dismiss it
  const downOnBackdrop = useRef(false)

  const go = (delta: number): void => {
    if (!multi) return
    onIndexChange((index + delta + images.length) % images.length)
  }

  // reset zoom whenever the shown image changes
  useEffect(() => setZoom(false), [index])

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
  const path = images[Math.min(Math.max(0, index), images.length - 1)]

  return (
    <div
      className="iv-overlay"
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
        <div className={'iv-imgwrap' + (zoom ? ' zoom scroll' : '')}>
          <img
            key={path}
            src={imageSrc(path)}
            alt={imageName(path)}
            className={'iv-img' + (zoom ? ' zoomed' : '')}
            draggable={false}
            decoding="async"
            onClick={() => setZoom((z) => !z)}
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
    </div>
  )
}
