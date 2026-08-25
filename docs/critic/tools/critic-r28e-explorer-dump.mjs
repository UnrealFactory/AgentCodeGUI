// 탐색기 연쇄 실패의 **상태 덤프** — `ab.mjs --keep`로 띄워 둔 앱에 붙어서 본다.
//
//   node docs/critic/tools/critic-r28e-explorer-dump.mjs --port=9637
//
// 왜 필요한가: 통짜 A/B에서 `explorer-blank` 다음 화면부터 `.fxs input`이 사라져
// 31화면이 연쇄로 죽는데(2/2 재현), 짧은 재주행(3/3)에서는 안 난다. 리포트에는
// "행이 안 보임"만 남아 원인을 못 짚는다 — 그 순간의 DOM·스토어를 직접 읽는다.
import { cdpTargets, Cdp } from '../../../bench/lib.mjs'

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const PORT = Number(arg('port', 9637))

const ts = await cdpTargets(PORT)
const t = ts.find((x) => x.type === 'page' && !x.url.includes('#') && /index\.html|localhost/.test(x.url))
if (!t) { console.log('메인 타깃 없음:', ts.map((x) => x.url)); process.exit(1) }
const cdp = await Cdp.connect(t.webSocketDebuggerUrl)

const dump = await cdp.eval(`(() => {
  const q = (s) => document.querySelector(s)
  const all = (s) => [...document.querySelectorAll(s)]
  const cls = (e) => e ? (e.className || '') : null
  return {
    lcol: !!q('.lcol'),
    explorer: !!q('.lcol .explorer'),
    expBlank: all('.explorer .exp-blank').length,
    expBlankText: (q('.explorer .exp-blank')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
    fxsInput: all('.fxs input').length,
    fxr: all('.explorer .fxtree .fxr').length,
    fxrFirst: all('.explorer .fxtree .fxr').slice(0, 6).map((r) => (r.textContent || '').trim()),
    gitStrip: all('.explorer .git-strip').length,
    sbItems: all('.sidebar .sb-item').length,
    sbTitles: all('.sidebar .sb-item').map((x) => (x.textContent || '').trim().slice(0, 24)),
    sbActive: all('.sidebar .sb-item.on, .sidebar .sb-item.active, .sidebar .sb-item.sel').map((x) => (x.textContent || '').trim().slice(0, 24)),
    chatHeadFolder: (q('.chat-head .fsel')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
    explorerHtmlHead: (q('.lcol .explorer')?.innerHTML || '').slice(0, 300),
    dirty: all('.set-modal, .ctx-menu, .chgm-overlay, .set-dialog-overlay, .q-overlay').map((e) => '.' + String(cls(e)).split(' ')[0])
  }
})()`)
console.log('── DOM ──')
console.log(JSON.stringify(dump, null, 1))

const store = await cdp.eval(
  `Promise.all([
     window.api.getChats(),
     window.api.getUiPrefs()
   ]).then(([c, p]) => ({
     activeChatId: c && c.activeChatId,
     chats: (c && c.chats || []).map(x => ({ id: x.id, title: x.title, manualCwd: x.manualCwd, cwd: x.cwd })),
     prefs: Object.fromEntries(Object.entries(p || {}).filter(([k]) => /explorer|sidebar|workspace/.test(k)))
   }))`,
  { awaitPromise: true, timeoutMs: 20000 }
).catch((e) => 'THROW ' + e.message)
console.log('── STORE ──')
console.log(JSON.stringify(store, null, 1))

// 탐색기가 보는 폴더로 직접 물어본다 — 셸의 `fs:list-dir`이 살아 있는가.
const fsProbe = await cdp.eval(
  `window.api.listDir(${JSON.stringify(process.cwd())}).then(l => ({ n: (l||[]).length, first: (l||[]).slice(0,5).map(e => e.name) }), e => 'REJECT ' + String(e && e.message || e))`,
  { awaitPromise: true, timeoutMs: 20000 }
).catch((e) => 'THROW ' + e.message)
console.log('── fs:list-dir ──')
console.log(JSON.stringify(fsProbe))

cdp.close()
