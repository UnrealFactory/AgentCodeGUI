import { createRoot } from 'react-dom/client'
import App from './App'
import { SessionWindow } from './components/SessionWindow'
import { PanelWindow } from './components/PanelWindow'
import { loadPrefs } from './lib/prefs'
import { initGlass } from './lib/glass'
import { initLang } from './lib/i18n'
import './styles.css'

// a session window ("추가 세션") loads the same bundle with a #session hash — render the
// standalone independent chat instead of the full app (no explorer/sidebar/custom chrome).
// #mapanel = 멀티 패널 팝아웃 창 — 패널 하나(PanelView)를 독립 OS 창으로 그린다.
const hash = window.location.hash.replace(/^#/, '')
const isSessionWindow = hash === 'session'
const isPanelWindow = hash === 'mapanel'

// load saved UI prefs (viewer size/zoom, chat zoom) before first paint so the
// hooks read the persisted values synchronously and the UI doesn't flash a default
loadPrefs().finally(() => {
  initGlass() // 저장된 유리(벽지 비침) 값도 첫 페인트 전에 — 기본 틴트가 번쩍이지 않게
  initLang() // 저장된 UI 언어도 첫 렌더 전에 — 모든 t()가 처음부터 맞는 언어를 준다
  createRoot(document.getElementById('root')!).render(isSessionWindow ? <SessionWindow /> : isPanelWindow ? <PanelWindow /> : <App />)
})
