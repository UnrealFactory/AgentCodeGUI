import { createRoot } from 'react-dom/client'
import App from './App'
import { SessionWindow } from './components/SessionWindow'
import { loadPrefs } from './lib/prefs'
import { applyTheme } from './lib/theme'
import './styles.css'

// a session window ("추가 세션") loads the same bundle with a #session hash — render the
// standalone independent chat instead of the full app (no explorer/sidebar/custom chrome).
const isSessionWindow = window.location.hash.replace(/^#/, '') === 'session'

// load saved UI prefs (viewer size/zoom, chat zoom, theme) before first paint so the
// hooks read the persisted values synchronously and the UI doesn't flash a default —
// applyTheme() in particular must run before render so dark users don't flash light
loadPrefs().finally(() => {
  applyTheme()
  createRoot(document.getElementById('root')!).render(isSessionWindow ? <SessionWindow /> : <App />)
})
