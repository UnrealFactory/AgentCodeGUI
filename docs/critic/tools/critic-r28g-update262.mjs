// 최종 파리티 R5 수정 라운드 1 — **2.6.2 쪽 자동 업데이트 통로가 런타임에 있는가.**
//
//   node docs/critic/tools/critic-r28g-update262.mjs [--port=10634] [--runs=2] [--out=json]
//
// ── 왜 별도 계기인가 ─────────────────────────────────────────────────────────
// 「3.0에 없다」는 내 exe에서 눌러 쟀다(`critic-r28g-update.mjs`). 그런데 「2.6.2에는
// 있다」를 **소스 읽기로만** 적으면 그것은 내 규율(「남의/자기 문서가 아니라 화면에서
// 눌러 잰다」) 밖이다. 그래서 2.6.2도 띄워서 **핸들러 유무를 런타임으로** 가른다.
//
// ── 어떻게 가르나 (이 계기의 판별 원리) ──────────────────────────────────────
// Electron `ipcRenderer.invoke`는 **핸들러가 없으면 거절한다** —
//   `Error: No handler registered for 'app:update-check'`.
// 그래서 `window.api.app.checkForUpdate()`가 **resolve** 하면 메인에 핸들러가 있는
// 것이고, 「No handler registered」로 **reject** 하면 없는 것이다. 3.0의 같은 호출은
// 심이 `{__unimplemented:true}`를 삼키고 **조용히 undefined**를 돌려준다(`shim.ts:91`) —
// 두 앱의 같은 버튼이 서로 다른 이유로 아무 일도 안 하는지, 한쪽만 통로가 있는지가 갈린다.
//
// ★한계(정직하게): 개발 실행(`app.isPackaged=false`)에서는 `updater.ts`의 세 함수가
// 모두 **일찍 반환**한다(:57 · :146 · :230). 그러니 이 계기가 증명하는 것은
// 「**통로(IPC 핸들러)가 있다**」까지이고, 「실제로 새 버전을 받아 온다」가 아니다.
// 그 축은 패키징된 빌드 + GitHub Releases가 필요해 이 라운드 범위 밖이다.
// 같은 이유로 `installUpdate()`도 **개발 실행에서는 안전**하다(:230에서 즉시 반환 —
// 스플래시도 `quitAndInstall`도 안 탄다). 그래도 마지막에 부른다.
//
// ── 안전 ─────────────────────────────────────────────────────────────────────
// `USERPROFILE`·`CCG_HOME` 격리(실홈 무접촉 · 실홈 파일 복사 0) · `CCG_NO_NET=1` ·
// 이름 기반 kill 0 · `out/`는 읽기만(동결 구역).
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { cdpTargets, Cdp, killTree, sleep, REPO } from '../../../bench/lib.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const PORT = Number(arg('port', 10634))
const ROOT = arg('root', 'C:\\Temp\\ccg-r28g-audit')
const RUNS = Number(arg('runs', 2))
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'critic', 'final-parity-r5-update-262.json')))

function buildHome(tag) {
  const home = path.join(ROOT, `home-upd262-${tag}`)
  const uprof = path.join(ROOT, `uprof-upd262-${tag}`)
  for (const d of [home, uprof]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 잠기면 덮어쓴다 */ } }
  fs.mkdirSync(path.join(home, 'chats'), { recursive: true })
  fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify({ nickname: 'UpdAudit', color: '#0EA5E9' }))
  fs.writeFileSync(path.join(home, 'engine-auto-update.json'), JSON.stringify({ enabled: false }))
  fs.writeFileSync(path.join(home, 'ui-prefs.json'), JSON.stringify({
    'workspace.mode': 'single', 'explorer.swap': false, 'chat.zoom': 1,
    'sidebar.autohide': false, 'whatsnew.seenVersion': '2.6.2', 'ui.lang': 'ko'
  }))
  fs.writeFileSync(path.join(home, 'chats', 'index.json'), JSON.stringify({ version: 1, order: [], activeChatId: null }))
  // 2.6.2는 홈을 `USERPROFILE\.agentcodegui`로도 찾는 경로가 있다(codex/versions.ts) — 같이 만든다
  fs.mkdirSync(uprof, { recursive: true })
  fs.cpSync(home, path.join(uprof, '.agentcodegui'), { recursive: true })
  return { home, uprof }
}

async function connectMain(port, timeoutMs = 90000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const ts = await cdpTargets(port)
      const t = ts.find((x) => x.type === 'page' && !x.url.startsWith('data:') && !/toast\.html|tray\.html/.test(x.url) && !x.url.includes('#') && /index\.html|localhost/.test(x.url))
      if (t?.webSocketDebuggerUrl) return await Cdp.connect(t.webSocketDebuggerUrl)
    } catch { /* 아직 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('main target not found')
    await sleep(80)
  }
}

const PROBE = (expr) => `${expr}.then((v) => 'RESOLVE:' + JSON.stringify(v === undefined ? null : v)).catch((e) => 'REJECT:' + String((e && e.message) || e))`
const SNAP = `(() => JSON.stringify({
  upd: document.querySelectorAll('.upd').length,
  updText: ((document.querySelector('.upd') || {}).textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
  rootKids: (document.getElementById('root') || { children: [] }).children.length
}))()`

const out = { at: new Date().toISOString(), app: '2.6.2(out/ · 개발 실행)', port: PORT, what: '2.6.2 자동 업데이트 IPC 핸들러 런타임 유무', runs: [] }

for (let i = 1; i <= RUNS; i++) {
  const { home, uprof } = buildHome(`j${i}`)
  const rec = { run: i, home, uprof, at: new Date().toISOString() }
  let child = null
  let cdp = null
  try {
    child = spawn(path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'),
      ['.', `--remote-debugging-port=${PORT}`],
      {
        env: {
          ...process.env, CCG_HOME: home, NODE_ENV: 'production', CCG_NO_NET: '1',
          USERPROFILE: uprof, HOMEPATH: uprof.slice(2), HOMEDRIVE: uprof.slice(0, 2)
        },
        cwd: REPO, stdio: 'ignore'
      })
    rec.pid = child.pid
    cdp = await connectMain(PORT)
    await cdp.send('Runtime.enable').catch(() => {})
    for (let k = 0; k < 400; k++) {
      const ok = await cdp.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`).catch(() => false)
      if (ok) break
      await sleep(150)
    }
    await sleep(4000)
    rec.screen = JSON.parse(await cdp.eval(SNAP))
    rec.version = await cdp.eval(PROBE(`window.api.app.getVersion()`), { awaitPromise: true, timeoutMs: 20000 }).catch((e) => 'THROW ' + e.message)
    rec.getStatus = await cdp.eval(PROBE(`window.api.app.getUpdateStatus()`), { awaitPromise: true, timeoutMs: 20000 }).catch((e) => 'THROW ' + e.message)
    rec.check = await cdp.eval(PROBE(`window.api.app.checkForUpdate()`), { awaitPromise: true, timeoutMs: 20000 }).catch((e) => 'THROW ' + e.message)
    // 음성 대조 — 어느 앱에도 없는 채널을 preload 밖에서 직접 부를 수는 없으므로,
    // 「핸들러 없음」이 어떤 문자열로 오는지는 3.0 쪽 `__unimplemented`와 대비해 읽는다.
    rec.install = await cdp.eval(PROBE(`window.api.app.installUpdate()`), { awaitPromise: true, timeoutMs: 20000 }).catch((e) => 'THROW ' + e.message)
    await sleep(2500)
    rec.aliveAfterInstall = (() => { try { process.kill(child.pid, 0); return true } catch { return false } })()
  } catch (e) {
    rec.fatal = String(e.stack ?? e).slice(0, 600)
  } finally {
    try { cdp?.close() } catch { /* 닫힘 */ }
    if (child?.pid) killTree(child.pid)
  }
  out.runs.push(rec)
  console.log(`[262 ${i}/${RUNS}] ver=${rec.version} upd=${rec.screen?.upd}`)
  console.log(`    getStatus=${rec.getStatus}`)
  console.log(`    check=${rec.check}  install=${rec.install}  alive=${rec.aliveAfterInstall}`)
  await sleep(1500)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(`\nsaved: ${OUT}`)
