import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getPref } from '../lib/prefs'

// ── 우클릭 드래그 마우스 제스처 (브라우저 제스처 확장 문법) ──
// target 안에서 우버튼을 누른 채 시작 거리(px)를 넘게 움직이면 제스처 모드: 전체 화면 포털에
// 궤적을 그리고, 이동을 4방향 획 연쇄('L'·'R'·'DR'…)로 양자화해 버튼을 뗄 때 실행한다.
// 임계값 미만이면 평범한 우클릭 — 기존 contextmenu 소비자(선택 툴바·헤더 메뉴)가 그대로
// 동작하므로 그쪽 코드는 한 줄도 건드리지 않는다.

export interface GestureAction {
  pattern: string // 방향 획 연쇄: 'L' | 'R' | 'U' | 'D'를 이어붙임 (예: 'DR' = ↓→)
  label: string // 인식 버블에 띄울 동작 이름
  run: () => void
}

// 설정(Gestures 탭)과 공유하는 prefs 키·기본값. 값은 제스처를 시작하는 순간(getPref)에
// 읽어서, 설정을 바꾸면 구독 배선 없이도 다음 제스처부터 바로 적용된다.
export const GESTURE_DEFAULTS = { start: 14, stroke: 24 }
const prefEnabled = (): boolean => getPref('gesture.enabled', true)
const prefStart = (): number => getPref('gesture.start', GESTURE_DEFAULTS.start)
const prefStroke = (): number => getPref('gesture.stroke', GESTURE_DEFAULTS.stroke)

// 제스처 실행 직후 따라오는 contextmenu 한 발을 삼키는 전역 스위치. Windows는 contextmenu가
// 우버튼 mouseup '뒤에' 온다(PoC 실측). 리스너를 컴포넌트 effect에 두면 '창 닫기' 제스처가
// 모달을 언마운트해 contextmenu 도착 전에 리스너가 사라질 수 있어서, 모듈 수명의 캡처
// 리스너 하나로 고정한다 — 평소엔 시한(300ms) 지난 플래그만 보고 즉시 통과.
let swallowUntil = 0
if (typeof window !== 'undefined') {
  window.addEventListener(
    'contextmenu',
    (e) => {
      if (performance.now() >= swallowUntil) return
      swallowUntil = 0
      e.preventDefault()
      e.stopImmediatePropagation()
    },
    true
  )
}

/** 패턴('DR' 등)을 획 모양 그대로 그린 화살표 글리프 — 인식 버블·설정의 제스처 목록이 공유. */
export function GestureGlyph({ pattern, size = 26 }: { pattern: string; size?: number }) {
  const U = 10 // 획 하나의 길이 (viewBox 단위)
  const AH = 3.4 // 화살촉 날개 길이
  let x = 0
  let y = 0
  let ldx = 1
  let ldy = 0
  const pts: number[][] = [[0, 0]]
  for (const d of pattern) {
    const [dx, dy] = d === 'L' ? [-1, 0] : d === 'R' ? [1, 0] : d === 'U' ? [0, -1] : [0, 1]
    x += dx * U
    y += dy * U
    pts.push([x, y])
    ldx = dx
    ldy = dy
  }
  // 화살촉: 마지막 진행 방향의 반대쪽으로 ±35° 벌린 날개 두 줄
  const a = Math.atan2(ldy, ldx) + Math.PI
  const wing = (off: number): number[] => [x + AH * Math.cos(a + off), y + AH * Math.sin(a + off)]
  const [w1, w2] = [wing(0.62), wing(-0.62)]
  // viewBox는 패턴 bbox를 감싸는 정사각형 — 획 수와 무관하게 선 굵기가 같아 보이게
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const side = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) + 9
  return (
    <svg
      width={size}
      height={size}
      viewBox={`${cx - side / 2} ${cy - side / 2} ${side} ${side}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points={pts.map((p) => p.join(',')).join(' ')} />
      <polyline points={`${w1.join(',')} ${x},${y} ${w2.join(',')}`} />
    </svg>
  )
}

/** 스크롤러 하나짜리 화면의 ↑/↓ 제스처 한 벌 — 대상은 실행 시점에 찾는다(재마운트 안전). */
export function scrollGestures(el: () => Element | null | undefined): GestureAction[] {
  const go = (top: boolean): void => {
    const s = el()
    if (s) s.scrollTo({ top: top ? 0 : s.scrollHeight, behavior: 'smooth' })
  }
  return [
    { pattern: 'U', label: '맨 위로', run: () => go(true) },
    { pattern: 'D', label: '맨 아래로', run: () => go(false) }
  ]
}

interface TrailState {
  pts: number[] // [x0,y0, x1,y1, …] — SVG polyline용 플랫 배열
  pattern: string
  cx: number // 인식 버블 자리(대상 카드 중앙, 제스처 시작 시점에 고정)
  cy: number
  out?: boolean // 실행 직후 퇴장 페이드 중
}

/**
 * 우클릭 드래그 제스처 레이어. `target`(카드 루트 엘리먼트)에서 시작한 제스처만 받고,
 * 궤적·버블은 body 포털로 그린다(pointer-events: none — 카드 위 어디서든 안전).
 * `actions`는 렌더마다 새로 만들어도 된다 — 이벤트 시점에 ref로 최신 값을 읽는다.
 */
export function MouseGestureLayer({
  target,
  actions,
  disabled
}: {
  target: HTMLElement | null
  actions: GestureAction[]
  disabled?: boolean
}) {
  const [trail, setTrail] = useState<TrailState | null>(null)
  // 핸들러는 target에만 재구독하고 나머지는 ref로 최신값을 본다
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const disabledRef = useRef(!!disabled)
  disabledRef.current = !!disabled

  useEffect(() => {
    if (!target) return
    let armed = false // 우버튼 down이 target 안에서 시작됨
    let active = false // 시작 거리를 넘어 제스처 모드 진입
    let startPx = GESTURE_DEFAULTS.start
    let strokePx = GESTURE_DEFAULTS.stroke
    let sx = 0
    let sy = 0 // 시작점 (시작 거리 판정)
    let ax = 0
    let ay = 0 // 방향 앵커 (획 판정)
    let dirs = ''
    let pts: number[] = []
    let cx = 0
    let cy = 0
    let raf = 0
    let fadeTimer = 0

    const flush = (): void => {
      raf = 0
      setTrail({ pts: pts.slice(), pattern: dirs, cx, cy })
    }
    // 제스처 종료 — 실행했으면 궤적·버블을 잠깐 남겨 페이드로 보내고, 취소면 즉시 지운다
    const finish = (fade: boolean): void => {
      armed = false
      active = false
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      if (fade) {
        setTrail((t) => (t ? { ...t, out: true } : t))
        window.clearTimeout(fadeTimer)
        fadeTimer = window.setTimeout(() => setTrail(null), 240)
      } else {
        setTrail(null)
      }
    }

    const onDown = (e: PointerEvent): void => {
      if (e.button !== 2 || e.pointerType !== 'mouse' || disabledRef.current || !prefEnabled()) return
      window.clearTimeout(fadeTimer)
      setTrail(null) // 직전 제스처의 퇴장 페이드가 남아 있으면 걷어낸다
      armed = true
      active = false
      dirs = ''
      startPx = prefStart()
      strokePx = prefStroke()
      sx = ax = e.clientX
      sy = ay = e.clientY
      pts = [e.clientX, e.clientY]
    }
    const onMove = (e: PointerEvent): void => {
      if (!armed) return
      // PoC 실측: 우버튼이 실제로 눌린(buttons&2) move만 신뢰한다 — 다른 출처의 move가
      // 끼어들면 방향이 튄다. 우버튼이 풀렸는데 up을 못 받은 경우(창 밖 릴리즈 등)도
      // 여기서 armed까지 리셋해, 낡은 시작점으로 카드 밖 드래그가 제스처가 되는 걸 막는다.
      if (!(e.buttons & 2)) {
        finish(false)
        return
      }
      if (!active) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) <= startPx) return
        active = true
        // 창 밖으로 나가도 up을 받도록 포인터를 붙잡는다 (실패해도 치명적이지 않음)
        try {
          target.setPointerCapture(e.pointerId)
        } catch {
          /* 이미 사라진 포인터 등 — 무시 */
        }
        const r = target.getBoundingClientRect()
        cx = r.left + r.width / 2
        cy = r.top + r.height / 2
      }
      // 궤적 샘플링(2px 미만 이동은 버림) — 포인트 수와 리렌더를 함께 아낀다
      const lx = pts[pts.length - 2]
      const ly = pts[pts.length - 1]
      if (Math.hypot(e.clientX - lx, e.clientY - ly) >= 2) pts.push(e.clientX, e.clientY)
      // 방향 획: 앵커에서 획 길이 이상 벗어나면 지배축으로 양자화, 직전 획과 다를 때만 추가
      const dx = e.clientX - ax
      const dy = e.clientY - ay
      if (Math.hypot(dx, dy) >= strokePx) {
        const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : dy > 0 ? 'D' : 'U'
        if (dirs[dirs.length - 1] !== dir) dirs += dir
        ax = e.clientX
        ay = e.clientY
      }
      if (!raf) raf = requestAnimationFrame(flush)
    }
    const onUp = (e: PointerEvent): void => {
      if (e.button !== 2 || !armed) return
      const wasActive = active
      const pattern = dirs
      finish(wasActive)
      if (!wasActive) return // 평범한 우클릭 — 기존 메뉴에 양보
      // 뭔가 그렸으면(인식 실패 포함) 메뉴는 띄우지 않는다 — 제스처 확장들의 관례
      swallowUntil = performance.now() + 300
      actionsRef.current.find((a) => a.pattern === pattern)?.run()
    }
    const onCancel = (): void => finish(false)

    // down은 target에서(카드 안에서 시작한 제스처만), move/up은 window에서(카드 밖까지 추적).
    // down을 캡처로 받아 자식이 pointerdown 전파를 막아도 제스처는 시작되게 한다.
    target.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
    return () => {
      target.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
      if (raf) cancelAnimationFrame(raf)
      window.clearTimeout(fadeTimer)
    }
  }, [target])

  if (!trail) return null
  const match = actions.find((a) => a.pattern === trail.pattern)
  return createPortal(
    <div className={'mg-layer' + (trail.out ? ' out' : '')} aria-hidden="true">
      <svg className="mg-trail">
        <polyline points={trail.pts.join(' ')} />
      </svg>
      {match && (
        // key로 동작이 바뀔 때마다 버블 팝인을 다시 재생
        <div key={match.pattern} className="mg-label" style={{ left: trail.cx, top: trail.cy }}>
          <GestureGlyph pattern={trail.pattern} size={30} />
          <span className="mg-name">{match.label}</span>
        </div>
      )}
    </div>,
    document.body
  )
}
