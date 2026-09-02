import { createRoot } from 'react-dom/client'
import App from './App'
import { SessionWindow } from './components/SessionWindow'
import { PanelWindow } from './components/PanelWindow'
import { ViewerWindow } from './components/ViewerWindow'
import { loadPrefs } from './lib/prefs'
import { initViewerWindow } from './lib/viewerWindow'
import { initGlass } from './lib/glass'
import { initLang } from './lib/i18n'
import './styles.css'

// a session window ("추가 세션") loads the same bundle with a #session hash — render the
// standalone independent chat instead of the full app (no explorer/sidebar/custom chrome).
// #mapanel = 멀티 패널 팝아웃 창 — 패널 하나(PanelView)를 독립 OS 창으로 그린다.
const hash = window.location.hash.replace(/^#/, '')
const isSessionWindow = hash === 'session'
const isPanelWindow = hash === 'mapanel'
// #viewer = 파일 뷰어 독립 창 — 코드 뷰어 카드 하나를 별도 OS 창으로 그린다.
const isViewerWindow = hash === 'viewer'

// 네이티브(WebView2) 우클릭 메뉴 억제 — 데스크톱 앱 화면에 「뒤로/새로 고침/인쇄/검사」는
// 이물질이다(2026-09-01 사용자 보고: 채팅 빈 영역 우클릭에 브라우저 메뉴). 모든 창이 이
// 번들을 지나므로 여기 한 곳이면 전 표면이 덮인다. 입력 필드만 예외 — 붙여넣기/맞춤법
// 메뉴는 남긴다. 커스텀 메뉴(.ctx-menu·선택 툴바·마우스 제스처)는 default와 무관하게
// 자기 UI를 그리니 영향이 없다.
document.addEventListener('contextmenu', (e) => {
  const el = e.target instanceof HTMLElement ? e.target : null
  if (el && (el.closest('input, textarea') || el.isContentEditable)) return
  e.preventDefault()
})

// load saved UI prefs (viewer size/zoom, chat zoom) before first paint so the
// hooks read the persisted values synchronously and the UI doesn't flash a default
// 뷰어 창 모드도 같은 자리에서 — 둘 다 부팅 페이로드(window.__CCG_BOOT)라 왕복이 없다.
Promise.all([loadPrefs(), initViewerWindow()]).finally(() => {
  initGlass() // 저장된 유리(벽지 비침) 값도 첫 페인트 전에 — 기본 틴트가 번쩍이지 않게
  initLang() // 저장된 UI 언어도 첫 렌더 전에 — 모든 t()가 처음부터 맞는 언어를 준다
  createRoot(document.getElementById('root')!).render(
    isSessionWindow ? <SessionWindow /> : isPanelWindow ? <PanelWindow /> : isViewerWindow ? <ViewerWindow /> : <App />
  )
})
