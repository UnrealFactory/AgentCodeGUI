// 특정 CDP 타깃(추가 채팅 창 등)에 붙어 유리 폴백 상태를 읽는다.
//   node docs/critic/tools/mui-cdp-target.mjs <port> <urlSubstring>
import { Cdp, cdpTargets } from '../../../bench/lib.mjs'

const port = Number(process.argv[2])
const match = process.argv[3] ?? '#session'
const targets = await cdpTargets(port)
const t = targets.find((x) => x.type === 'page' && x.url.includes(match))
if (!t) {
  console.log(JSON.stringify({ error: 'no target', targets: targets.map((x) => x.url) }))
  process.exit(1)
}
const cdp = await Cdp.connect(t.webSocketDebuggerUrl, { timeoutMs: 8000 })
const out = await cdp.eval(`(() => {
  const de = document.documentElement, cs = getComputedStyle(de)
  const g = window.__ccgGlass || null
  return JSON.stringify({
    url: location.href,
    htmlClass: de.className,
    hasFallbackStyle: !!document.getElementById('ccg-glass-fallback'),
    rootPanel: cs.getPropertyValue('--panel').trim(),
    glass: g ? { state: g.state, events: g.events } : null
  })
})()`)
console.log(out)
cdp.close()
