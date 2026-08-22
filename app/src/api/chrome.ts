/* ============================================================
 * 창 껍데기 보조 — 심(shim)이 세우는 렌더러 쪽 배관.
 *
 * 1) 드래그 영역: 렌더러 CSS는 `-webkit-app-region:drag|no-drag`로 타이틀바·사이드바
 *    상단·채팅 헤더를 표시한다. 이건 Electron(Chromium 호스트)이 해석하는 문법이라
 *    WebView2에서는 아무도 안 본다. styles.css를 고치지 않고 살리기 위해, 여기서
 *    같은 의미를 JS로 재현한다 — mousedown이 drag 영역에서 나면 네이티브 창 드래그
 *    (startDragging = WM_NCLBUTTONDOWN/HTCAPTION)로 넘긴다. 그래야 Aero Snap·엣지
 *    스냅·더블클릭 최대화가 전부 OS 것 그대로 산다.
 *
 *    판정은 두 경로:
 *      (a) WebView2가 `-webkit-app-region`을 계산값으로 노출하면 그걸 그대로 읽는다.
 *      (b) 아니면 문서의 스타일시트 텍스트를 훑어 drag/no-drag 셀렉터 목록을 만들고
 *          element.closest()로 판정한다(같은 CSS, 같은 결과 — 사본 관리 없음).
 *
 * 2) 드래그 앤 드롭 경로: Electron은 webUtils.getPathForFile로 File→OS 경로를 동기
 *    해석했다. Tauri에는 대응물이 없고, 네이티브 drag-drop 이벤트를 켜면(dragDropEnabled)
 *    HTML5 drop 자체가 웹뷰에 안 온다 — 렌더러의 드롭 처리 전부가 죽는다. 그래서
 *    HTML5 경로를 살리고(창 설정 dragDropEnabled:false) pathForFile은 ''을 돌려준다.
 *    호출부(lib/images.ts)는 경로가 없으면 바이트를 메인에 넘겨 임시 파일로 만드는
 *    폴백이 이미 있어, saveAttachmentData가 구현되는 순간 모든 경우가 그 길로 산다.
 * ============================================================ */
import { getCurrentWindow } from '@tauri-apps/api/window'

const DRAG = 'drag'
const NO_DRAG = 'no-drag'

// (b) 경로용 셀렉터 목록 — 스타일시트에서 뽑는다
let dragSel = ''
let noDragSel = ''

/** 계산값으로 -webkit-app-region을 읽을 수 있는 런타임인가(Electron/일부 Chromium). */
function probeComputedSupport(): boolean {
  try {
    const el = document.createElement('div')
    el.style.setProperty('-webkit-app-region', DRAG)
    document.body.appendChild(el)
    const v = getComputedStyle(el).getPropertyValue('-webkit-app-region').trim()
    el.remove()
    return v === DRAG
  } catch {
    return false
  }
}

/** 문서의 CSS 텍스트에서 drag / no-drag 셀렉터를 모은다. */
function collectSelectors(css: string): void {
  const drags: string[] = []
  const noDrags: string[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css))) {
    const body = m[2]
    if (!body.includes('-webkit-app-region')) continue
    // @media/@supports 블록 안의 첫 규칙은 셀렉터 앞에 '@…{'가 붙어 잡힌다 — 마지막
    // '{' 뒤만 취해 순수 셀렉터로 만들고, 그래도 이상하면 검증에서 버린다
    const sel = m[1].slice(m[1].lastIndexOf('{') + 1).trim()
    if (!sel || sel.startsWith('@')) continue
    try {
      document.querySelector(sel) // 유효성 검증 (틀린 셀렉터는 throw)
    } catch {
      continue
    }
    if (/-webkit-app-region\s*:\s*no-drag/.test(body)) noDrags.push(sel)
    else if (/-webkit-app-region\s*:\s*drag/.test(body)) drags.push(sel)
  }
  dragSel = drags.join(',')
  noDragSel = noDrags.join(',')
}

async function buildSelectorIndex(): Promise<void> {
  let css = ''
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null
    try {
      rules = sheet.cssRules
    } catch {
      rules = null // cross-origin (폰트 CDN) — 우리 CSS가 아니다
    }
    if (rules) {
      let hasRegion = false
      for (const rule of Array.from(rules)) {
        const text = rule.cssText
        if (text.includes('-webkit-app-region')) {
          hasRegion = true
          css += text + '\n'
        }
      }
      // 규칙 텍스트에 남아 있으면 그걸로 충분하다. 파서가 미지원 속성을 버렸다면
      // (Chromium 빌드에 따라) 원문을 직접 받아 훑는다.
      if (hasRegion) continue
    }
    if (sheet.href && sheet.href.startsWith(location.origin)) {
      try {
        css += await (await fetch(sheet.href)).text()
      } catch {
        /* 못 읽으면 그 시트는 건너뛴다 */
      }
    }
  }
  collectSelectors(css)
}

/** 이 요소(또는 조상)가 드래그 영역인가. */
function isDragTarget(el: Element | null, useComputed: boolean): boolean {
  if (!el) return false
  if (useComputed) {
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      const v = getComputedStyle(cur).getPropertyValue('-webkit-app-region').trim()
      if (v === NO_DRAG) return false
      if (v === DRAG) return true
    }
    return false
  }
  if (!dragSel) return false
  const drag = el.closest(dragSel)
  if (!drag) return false
  const noDrag = noDragSel ? el.closest(noDragSel) : null
  // 더 가까운 쪽이 이긴다 — no-drag가 drag 안에 있으면(버튼 등) 드래그 아님
  return !(noDrag && drag.contains(noDrag))
}

/** 진단 카운터 — window.__ccgChrome로 노출(크리틱·회귀 확인용, 부작용 없음) */
const diag = { mode: 'computed', dragSel: 0, noDragSel: 0, seen: 0, drags: 0 }

export function initWindowChrome(): void {
  let useComputed = false
  ;(window as unknown as { __ccgChrome?: unknown }).__ccgChrome = diag

  // 리스너를 **먼저** 건다 — 아래 준비 작업이 어떤 이유로 throw해도 드래그 배관이
  // 통째로 사라지는 일이 없게(창을 못 움직이는 앱이 된다).
  // 캡처 단계에서 듣되 이벤트를 삼키지는 않는다 — 렌더러의 클릭/포커스 문법은 그대로.
  document.addEventListener(
    'mousedown',
    (e) => {
      diag.seen++
      if (e.button !== 0) return
      const target = e.target as Element | null
      if (!isDragTarget(target, useComputed)) return
      // 텍스트 입력 안에서는 드래그하지 않는다(선택·캐럿이 우선)
      const tag = (target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (target as HTMLElement)?.isContentEditable) return
      diag.drags++
      const win = getCurrentWindow()
      if (e.detail === 2) void win.toggleMaximize()
      else void win.startDragging()
    },
    true
  )

  const mark = (): void => {
    // 어떤 경로로 판정 중이고 셀렉터가 몇 개 잡혔는지
    diag.mode = useComputed ? 'computed' : 'selectors'
    diag.dragSel = dragSel.length
    diag.noDragSel = noDragSel.length
  }
  useComputed = probeComputedSupport()
  mark()
  if (!useComputed) void buildSelectorIndex().then(mark)
}
