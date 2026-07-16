import { useEffect, useState } from 'react'
import { IconMessage, IconChevLeft } from './icons'

// 새 채팅 선택 카드 (PoC nccard) — 1단계: 일반/멀티 타일, 2단계(멀티): 패널 수 2~6을
// 배치 미리보기로 고른다. 베일 클릭/Esc = 닫기, 뒤로 = 1단계로 슬라이드백.
const COUNTS = [2, 3, 4, 5, 6] as const

export function NewChatModal({
  busy,
  onGeneral,
  onMulti,
  onClose
}: {
  busy: boolean // 일반 채팅이 실행 중 — 일반 타일만 잠근다 (멀티 생성은 무관)
  onGeneral: () => void
  onMulti: (count: number) => void
  onClose: () => void
}) {
  const [step, setStep] = useState<1 | 2>(1)
  // 단계 전환 방향 — 앞으로(qstep)/뒤로(qstep-b) 슬라이드 (질문 카드와 같은 모션)
  const [slide, setSlide] = useState<'' | 'fwd' | 'back'>('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="nc-veil" onMouseDown={onClose}>
      <div className="nccard" onMouseDown={(e) => e.stopPropagation()}>
        {step === 1 ? (
          <div className={'ncstep' + (slide === 'back' ? ' nc-slide-b' : '')}>
            <div className="nct">새 채팅</div>
            <div className="ncs">어떤 구성으로 시작할까요? 폴더는 채팅 안에서 언제든 바꿀 수 있어요.</div>
            <div className="nctiles">
              <button
                className={'nctile' + (busy ? ' off' : '')}
                onClick={() => {
                  if (busy) return
                  onClose()
                  onGeneral()
                }}
              >
                <span className="ncic">
                  <IconMessage size={15} />
                </span>
                <span className="ncl">일반 채팅</span>
                <span className="ncd">채팅 하나로 시작해요 — 기본 구성</span>
              </button>
              <button
                className="nctile"
                onClick={() => {
                  setStep(2)
                  setSlide('fwd')
                }}
              >
                <span className="ncic">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="M9 4v16M15 4v16" />
                  </svg>
                </span>
                <span className="ncl">멀티 채팅</span>
                <span className="ncd">패널 여러 개를 나란히 — 모델·계정을 패널마다 따로</span>
              </button>
            </div>
          </div>
        ) : (
          <div className={'ncstep' + (slide === 'fwd' ? ' nc-slide' : '')}>
            <button
              className="nc-back"
              onClick={() => {
                setStep(1)
                setSlide('back')
              }}
            >
              <IconChevLeft size={13} /> 뒤로
            </button>
            <div className="nct" style={{ marginTop: 10 }}>멀티 채팅</div>
            <div className="ncs">패널을 몇 개로 시작할까요?</div>
            <div className="nccnts">
              {COUNTS.map((n) => (
                <button
                  key={n}
                  className="ncnt"
                  onClick={() => {
                    onClose()
                    onMulti(n)
                  }}
                >
                  <span className={`ncprev n${n}`}>
                    {Array.from({ length: n }, (_, i) => (
                      <i key={i} />
                    ))}
                  </span>
                  <span className="ncn">{n}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
