// ── M6 R3 실증 하네스 — ccg-page(HTML 미리보기) + 첨부 저장 ────────────────────
//
//   node bench/m6r3.mjs tauri        3.0.0 (target/release/agentcodegui.exe)
//   node bench/m6r3.mjs electron     2.6.2 기준
//   node bench/m6r3.mjs both         둘 다 (A/B)
//   node bench/m6r3.mjs both --keep  캡처 후 앱을 띄워 둔다
//
// 산출: bench/shots/m6r3-<kind>/*.png + bench/results/m6r3-<kind>.json
//
// [무엇을 재나]
//  A. HTML 미리보기: URL 발급 · 문서 바이트 · **입력 브리지가 붙었나** · 상대경로
//     리소스 · 루트 밖 404 · Ctrl+D/Esc 중계 · 디스크 수정 → HEAD 폴링 재로드
//  B. 첨부: 경로 없는 바이트(붙여넣기·브라우저 드래그) → 임시 파일 경로 →
//     컴포저 썸네일 → 라이트박스
//
// [격리 규약]
//  - 홈: %TEMP%/ccg-m6r3-home-<kind> (실홈은 읽기/복사만 — fixture.mjs 규약)
//  - 작업 폴더: %TEMP%/ccg-m6r3-work (레포 밖 · 매 실행 새로 만든다)
//  - exe는 target/release에서 **복사해** 쓴다(옆 에이전트의 재빌드에 안 흔들리게)
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { electronProfile, tauriProfile, connectMainPage, killTree, sleep, REPO, binInfo, resolveTauriExe } from './lib.mjs'
import { makeFixtureHome, FIX_ID } from './fixture.mjs'
import { HELPERS_JS, makeCtx } from './screens.mjs'

const which = process.argv[2] ?? 'tauri'
const KINDS = which === 'both' ? ['electron', 'tauri'] : [which]
const KEEP = process.argv.includes('--keep')
const VIEW = { width: 1440, height: 900 }
const WORK = path.join(os.tmpdir(), 'ccg-m6r3-work')
const OUTSIDE = path.join(os.tmpdir(), 'ccg-m6r3-outside')

// 1x1 투명 PNG — 붙여넣기/브라우저 드래그 첨부의 바이트원(경로가 없는 File)
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// 미리보기 문서. 부모(하네스)에게 자기가 본 것을 postMessage로 보고한다 —
// sandbox iframe은 오리진이 null이라 밖에서 그 안을 못 읽는다. 세 가지를 보고한다:
//   ① 문서 스크립트가 돌았나  ② 상대경로 <img>가 떴나(no-cors)  ③ fetch가 됐나(CORS)
const PAGE_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>m6r3 미리보기</title>
<link rel="stylesheet" href="./assets/style.css">
</head><body>
<h1 id="h">M6 R3 · ccg-page</h1>
<p class="tag">상대경로 리소스와 입력 브리지를 같이 재는 문서</p>
<img id="logo" src="./assets/logo.png" width="64" height="64" alt="logo">
<pre id="out">…</pre>
<script>
var say = function (m) { try { window.parent.postMessage({ m6r3: m }, '*') } catch (e) {} };
var logo = document.getElementById('logo');
var tell = function () { say({ img: logo.naturalWidth }) };
if (logo.complete) tell(); else { logo.addEventListener('load', tell); logo.addEventListener('error', tell); }
say({ script: 1, css: getComputedStyle(document.getElementById('h')).color, h: document.getElementById('h').textContent });
fetch('./assets/data.json')
  .then(function (r) { return r.json() })
  .then(function (j) { say({ fetch: 'ok', v: j.v }); document.getElementById('out').textContent = 'fetch ok' })
  .catch(function (e) { say({ fetch: 'blocked', why: String(e).slice(0, 60) }); document.getElementById('out').textContent = 'fetch blocked' });
// M6 R2 회귀 — sandbox iframe(오리진 null)이 ccg-img 바이트를 JS로 읽으면 안 된다
fetch('__IMGURL__')
  .then(function (r) { return r.arrayBuffer() })
  .then(function (b) { say({ imgFetch: 'ok', bytes: b.byteLength }) })
  .catch(function (e) { say({ imgFetch: 'blocked', why: String(e).slice(0, 60) }) });
</script>
</body></html>
`
const PAGE_CSS = '#h{color:rgb(14,165,233);font:20px system-ui}body{background:#12141a;color:#e6e8ee;font:14px/1.6 system-ui;padding:24px}.tag{opacity:.75}'

/** 앱마다 `ccg-img` URL 모양이 다르다(2.6.2 `ccg-img://local/?p=` · 3.0 wry `http://…localhost/`) */
const imgUrlFor = (kind, abs) =>
  kind === 'tauri'
    ? `http://ccg-img.localhost/${encodeURIComponent(abs)}`
    : `ccg-img://local/?p=${encodeURIComponent(abs)}`

function makeWork(kind = 'tauri') {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.rmSync(OUTSIDE, { recursive: true, force: true })
  fs.mkdirSync(path.join(WORK, 'assets'), { recursive: true })
  fs.mkdirSync(OUTSIDE, { recursive: true })
  fs.writeFileSync(
    path.join(WORK, 'm6r3-page.html'),
    PAGE_HTML.replace('__IMGURL__', imgUrlFor(kind, path.join(WORK, 'assets', 'logo.png')))
  )
  fs.writeFileSync(path.join(WORK, 'assets', 'style.css'), PAGE_CSS)
  fs.writeFileSync(path.join(WORK, 'assets', 'logo.png'), Buffer.from(TINY_PNG, 'base64'))
  fs.writeFileSync(path.join(WORK, 'assets', 'data.json'), JSON.stringify({ v: 'm6r3' }))
  // 트리가 비면 탐색기 검색이 안 도니 곁들이 파일 몇 개
  fs.writeFileSync(path.join(WORK, 'README.md'), '# m6r3 작업 폴더\n\nHTML 미리보기 하네스 전용.\n')
  fs.writeFileSync(path.join(WORK, 'note.txt'), 'plain\n')
  // 루트 밖 — 미리보기가 절대 못 봐야 하는 파일
  fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'TOP SECRET · 미리보기가 이걸 읽으면 안 된다\n')
}

function makeHome(kind, version) {
  const home = path.join(os.tmpdir(), `ccg-m6r3-home-${kind}`)
  fs.rmSync(home, { recursive: true, force: true })
  makeFixtureHome(home, version)
  const f = path.join(home, 'chats', `${FIX_ID}.json`)
  const chat = JSON.parse(fs.readFileSync(f, 'utf8'))
  chat.manualCwd = WORK
  if (chat.snapshot) chat.snapshot.cwd = WORK
  fs.writeFileSync(f, JSON.stringify(chat))
  return home
}

// ── 2.6.2가 실홈에 흘리는 첨부 되치우기 ───────────────────────────────────────
// 2.6.2의 `attachmentsDir()`는 `os.homedir()/.agentcodegui/attachments`라 **CCG_HOME을
// 안 탄다** — 기준선 주행이 사용자 실홈에 파일을 남긴다(3.0은 앱 홈을 타서 격리된다).
// 주행 전후 목록을 견줘 **우리가 넣은 바이트와 똑같은 새 파일만** 지운다.
const REAL_ATTACH = path.join(os.homedir(), '.agentcodegui', 'attachments')
const OUR_BYTES = Buffer.from(TINY_PNG, 'base64')
const snapAttachments = () => {
  try {
    return new Set(fs.readdirSync(REAL_ATTACH))
  } catch {
    return new Set()
  }
}
function sweepAttachments(before) {
  let removed = 0
  let names = []
  try {
    names = fs.readdirSync(REAL_ATTACH)
  } catch {
    return 0
  }
  for (const n of names) {
    if (before.has(n)) continue
    const p = path.join(REAL_ATTACH, n)
    try {
      if (!fs.readFileSync(p).equals(OUR_BYTES)) continue // 사용자 파일은 절대 안 건드린다
      fs.rmSync(p)
      removed++
    } catch {
      /* 잠김 — 남긴다 */
    }
  }
  return removed
}

/** target/release의 exe를 내 폴더로 복사해 쓴다(옆 에이전트의 재빌드 대비 — m6.mjs와 같은 관례) */
async function snapshotExe() {
  // CCG_EXE=… 로 격리 CARGO_TARGET_DIR의 exe를 바로 지목할 수 있다(공용 exe가 잠겼을 때)
  // ★ M12 R2 — 이름이 둘이다(AgentCodeGUI3.exe / agentcodegui.exe). 대기 루프 안에서 매번 찾는다.
  const dir = path.join(os.tmpdir(), 'ccg-m6r3-exe')
  fs.mkdirSync(dir, { recursive: true })
  const dst = path.join(dir, 'agentcodegui.exe') // 사본 이름은 옛 이름 유지(귀속 정규식 호환)
  let src = null
  for (let i = 0; i < 80; i++) {
    src = resolveTauriExe(null, { quiet: i > 0 })
    try {
      fs.copyFileSync(src, dst)
      return dst
    } catch {
      if (i === 0) console.log(`[m6r3] ${src} 없음/잠김 — 대기`)
      await sleep(5000)
    }
  }
  throw new Error(`exe 스냅샷 실패 (마지막 후보 ${src})`)
}
let EXE = null

// 미리보기 URL에서 이웃 리소스 URL을 만든다 (두 앱의 URL 모양이 달라도 같은 규칙)
const sibling = (url, rel) => url.replace(/m6r3-page\.html$/, rel)

async function run(kind) {
  const version = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
  const profile = kind === 'tauri' ? tauriProfile({ port: 9362, exe: EXE }) : electronProfile({ port: 9361 })
  const home = makeHome(kind, version)
  const out = path.join(REPO, 'bench', 'shots', `m6r3-${kind}`)
  fs.mkdirSync(out, { recursive: true })

  const attachBefore = snapAttachments()
  const child = spawn(profile.cmd, profile.args, {
    env: { ...process.env, ...profile.env, CCG_HOME: home },
    cwd: profile.cwd,
    stdio: 'ignore'
  })
  const checks = []
  const shot = async (cdp, id) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
    if (r?.data) fs.writeFileSync(path.join(out, `${id}.png`), Buffer.from(r.data, 'base64'))
  }
  const check = async (id, fn) => {
    const t0 = Date.now()
    try {
      const detail = await fn()
      checks.push({ id, ok: true, ms: Date.now() - t0, detail })
      console.log(`  [ok]   ${id} — ${JSON.stringify(detail)}`)
      return detail
    } catch (e) {
      checks.push({ id, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e) })
      console.log(`  [FAIL] ${id} — ${e?.message ?? e}`)
      return null
    }
  }

  let cdp
  let previewUrl = ''
  let saved = null
  try {
    cdp = await connectMainPage(profile.port, { timeoutMs: 60000 })
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    const navs = []
    cdp.listeners.push((msg) => {
      if (msg.method === 'Page.frameNavigated') navs.push(msg.params?.frame?.url ?? '')
    })
    const { windowId } = await cdp.send('Browser.getWindowForTarget').catch(() => ({}))
    if (windowId)
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { ...VIEW, windowState: 'normal' } }).catch(() => {})
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 17, g: 18, b: 22, a: 1 } }).catch(() => {})
    for (let i = 0; i < 600; i++) {
      if (await cdp.eval(profile.mountExpr).catch(() => false)) break
      await sleep(100)
    }
    await sleep(1200)
    await cdp.eval(HELPERS_JS)
    const ctx = makeCtx(cdp)

    // 미리보기 문서가 부모로 쏘는 보고를 모은다 (문서를 열기 **전에** 붙인다)
    await cdp.eval(`(() => {
      window.__m6r3 = []
      window.addEventListener('message', (e) => { if (e.data && e.data.m6r3) window.__m6r3.push(e.data.m6r3) })
      return true
    })()`)

    // ── A1. 채널 — URL 발급 ────────────────────────────────────────────────
    await check('html-preview-url', async () => {
      const url = await cdp.eval(
        `window.api.htmlPreviewUrl(${JSON.stringify(WORK)}, 'm6r3-page.html')`,
        { awaitPromise: true, timeoutMs: 20000 }
      )
      if (!url) throw new Error('빈 문자열 — 채널이 미구현이다')
      if (!/m6r3-page\.html$/.test(url)) throw new Error(`URL 끝이 문서가 아니다: ${url}`)
      if (/%5C|%2F/i.test(url)) throw new Error(`구분자가 인코딩됐다(상대 참조가 깨진다): ${url}`)
      previewUrl = url
      return { url }
    })

    // ── A2. 문서 바이트 + 입력 브리지가 붙었나 ──────────────────────────────
    await check('page-bytes-and-bridge', async () => {
      const r = await cdp.eval(
        `(async () => {
           const res = await fetch(${JSON.stringify(previewUrl)})
           const t = await res.text()
           return { status: res.status, type: res.headers.get('content-type'),
                    lastMod: res.headers.get('last-modified'), len: t.length,
                    doc: t.includes('M6 R3 · ccg-page'),
                    bridge: t.includes('ccgPageKey') && t.includes('ccgPagePtr') && t.includes('ccgPageScroll') }
         })()`,
        { awaitPromise: true, timeoutMs: 20000 }
      )
      if (r.status !== 200) throw new Error(`status ${r.status}`)
      if (!r.doc) throw new Error('문서 본문이 안 왔다')
      if (!r.bridge) throw new Error('입력 브리지(PAGE_KEY_BRIDGE)가 안 붙었다')
      if (!/^text\/html/.test(r.type ?? '')) throw new Error(`content-type=${r.type}`)
      if (!r.lastMod) throw new Error('last-modified가 없다 — 변경 감시가 못 돈다')
      return r
    })

    // ── A3. HEAD (뷰어의 변경 감시가 쓰는 메서드) ───────────────────────────
    await check('page-head-probe', async () => {
      const r = await cdp.eval(
        `(async () => {
           const res = await fetch(${JSON.stringify(previewUrl)}, { method: 'HEAD' })
           return { status: res.status, lastMod: res.headers.get('last-modified') }
         })()`,
        { awaitPromise: true, timeoutMs: 20000 }
      )
      if (r.status !== 200 || !r.lastMod) throw new Error(JSON.stringify(r))
      return r
    })

    // ── A4. 상대경로 리소스 ─────────────────────────────────────────────────
    await check('page-sibling-resources', async () => {
      const css = sibling(previewUrl, 'assets/style.css')
      const png = sibling(previewUrl, 'assets/logo.png')
      const r = await cdp.eval(
        `(async () => {
           const c = await fetch(${JSON.stringify(css)})
           const ct = await c.text()
           const img = await new Promise((res) => {
             const i = new Image()
             i.onload = () => res(i.naturalWidth); i.onerror = () => res(0)
             i.src = ${JSON.stringify(png)}
             setTimeout(() => res(-1), 6000)
           })
           return { cssStatus: c.status, cssType: c.headers.get('content-type'), cssBody: ct.includes('#h{color'), img }
         })()`,
        { awaitPromise: true, timeoutMs: 20000 }
      )
      if (r.cssStatus !== 200 || !r.cssBody) throw new Error(`css: ${JSON.stringify(r)}`)
      if (r.img !== 1) throw new Error(`이웃 이미지가 안 떴다: ${JSON.stringify(r)}`)
      return r
    })

    // ── A5. 루트 밖은 404 ───────────────────────────────────────────────────
    await check('page-root-escape-404', async () => {
      const esc = sibling(previewUrl, '../ccg-m6r3-outside/secret.txt')
      const abs = previewUrl.replace(
        /\/[^/]*\/m6r3-page\.html$/,
        ''
      ) // 스킴+호스트+드라이브까지
      const win = `${abs}/Windows/win.ini`
      const r = await cdp.eval(
        `(async () => {
           const one = async (u) => { try { const r = await fetch(u); return r.status } catch (e) { return 'threw' } }
           return { escape: await one(${JSON.stringify(esc)}), absolute: await one(${JSON.stringify(win)}) }
         })()`,
        { awaitPromise: true, timeoutMs: 20000 }
      )
      if (r.escape === 200) throw new Error(`\`..\` 탈출이 서빙됐다: ${esc}`)
      if (r.absolute === 200) throw new Error(`루트 밖 절대 경로가 서빙됐다: ${win}`)
      return { ...r, escUrl: esc, absUrl: win }
    })

    // ── A6. 뷰어에서 실제로 뜨나 (렌더 기본) ────────────────────────────────
    await check('viewer-html-preview-mounts', async () => {
      await ctx.openFile('m6r3-page.html')
      await ctx.waitFor('.fv-body iframe.fv-htmlframe', 15000)
      await sleep(1800)
      const src = await cdp.eval(`document.querySelector('iframe.fv-htmlframe')?.getAttribute('src') ?? ''`)
      const seen = await cdp.eval(`JSON.stringify(window.__m6r3)`)
      const rect = await cdp.eval(`(() => { const f = document.querySelector('iframe.fv-htmlframe')
        if (!f) return null; const b = f.getBoundingClientRect()
        return { w: Math.round(b.width), h: Math.round(b.height) } })()`)
      if (!src) throw new Error('iframe src가 비어 있다')
      if (!rect || rect.w < 100) throw new Error(`iframe 크기가 이상하다: ${JSON.stringify(rect)}`)
      let rep = JSON.parse(seen)
      for (let i = 0; i < 25 && !rep.some((m) => 'img' in m); i++) {
        await sleep(200)
        rep = JSON.parse(await cdp.eval(`JSON.stringify(window.__m6r3)`))
      }
      const scripted = rep.find((m) => m.script)
      if (!scripted) throw new Error(`문서 스크립트가 안 돌았다(=문서가 안 떴다): ${JSON.stringify(rep)}`)
      // CSS가 실제로 먹었나 — 문서가 `./assets/style.css`를 못 받으면 기본 검정이다
      if (scripted.css !== 'rgb(14, 165, 233)') throw new Error(`상대경로 CSS가 안 먹었다: ${scripted.css}`)
      const img = rep.find((m) => 'img' in m)
      if (!img || img.img !== 1) throw new Error(`상대경로 <img>가 안 떴다: ${JSON.stringify(img)}`)
      return { src, rect, scriptRan: true, css: scripted.css, imgWidth: img.img, reports: rep }
    })
    await shot(cdp, '01-html-preview')

    // ── A7. 문서 안에서의 fetch (CORS) — A/B에서 갈리는 자리 ────────────────
    await check('page-inner-fetch-cors', async () => {
      for (let i = 0; i < 40; i++) {
        const rep = JSON.parse(await cdp.eval(`JSON.stringify(window.__m6r3)`))
        const f = rep.find((m) => m.fetch)
        if (f) return f
        await sleep(200)
      }
      throw new Error('문서가 fetch 결과를 보고하지 않았다')
    })

    // ── A7b. M6 R2 회귀 — sandbox iframe(오리진 null)이 ccg-img를 JS로 읽나 ──
    //     R2가 `ACAO: *`를 회수하며 막은 바로 그 청중이다. **두 앱 다 blocked**여야 한다
    //     (2.6.2의 ccg-img 응답에는 ACAO가 아예 없다).
    await check('r2-regression-ccg-img-blocked-from-sandbox', async () => {
      for (let i = 0; i < 40; i++) {
        const rep = JSON.parse(await cdp.eval(`JSON.stringify(window.__m6r3)`))
        const f = rep.find((m) => m.imgFetch)
        if (f) {
          if (f.imgFetch !== 'blocked') throw new Error(`sandbox가 ccg-img 바이트를 읽었다: ${JSON.stringify(f)}`)
          return f
        }
        await sleep(200)
      }
      throw new Error('문서가 ccg-img fetch 결과를 보고하지 않았다')
    })

    // ── A8. 입력 브리지 — iframe 안에서 Ctrl+D가 코드 보기로 넘어가나 ───────
    await check('bridge-ctrl-d-toggles-code', async () => {
      const b = await cdp.eval(`(() => { const f = document.querySelector('iframe.fv-htmlframe')
        if (!f) return null; const r = f.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
      if (!b) throw new Error('iframe이 없다')
      // iframe 안을 실제로 클릭해 포커스를 넘긴다(브리지가 없으면 여기서 Ctrl+D가 죽는다)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none', buttons: 0 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 })
      await sleep(300)
      await ctx.key('d', { ctrl: true })
      await ctx.waitFor('.vtool button[aria-label="코드 보기"].on', 6000)
      const gone = await ctx.count('iframe.fv-htmlframe')
      return { codeViewOn: true, iframeGone: gone === 0 }
    })
    await shot(cdp, '02-html-code-after-bridge')

    // 다시 렌더 보기로
    await ctx.click('.vtool button[aria-label="페이지 미리보기"]').catch(async () => {
      await ctx.key('d', { ctrl: true })
    })
    await ctx.waitFor('.fv-body iframe.fv-htmlframe', 10000)
    await sleep(1200)

    // ── A9. 디스크 수정 → HEAD 폴링이 재로드하나 ────────────────────────────
    await check('head-poll-reloads-on-disk-change', async () => {
      const before = navs.length
      await cdp.eval(`(() => { window.__m6r3 = []
        const f = document.querySelector('iframe.fv-htmlframe'); if (f) f.__m6r3mark = 1; return !!f })()`)
      await sleep(1800) // 첫 폴링이 lastMod 기준선을 잡게 (주기 1.5s)
      fs.writeFileSync(
        path.join(WORK, 'm6r3-page.html'),
        PAGE_HTML.replace('__IMGURL__', imgUrlFor(kind, path.join(WORK, 'assets', 'logo.png'))).replace(
          'M6 R3 · ccg-page',
          'M6 R3 · 다시 읽음'
        )
      )
      for (let i = 0; i < 60; i++) {
        const still = await cdp.eval(`(() => { const f = document.querySelector('iframe.fv-htmlframe'); return !!(f && f.__m6r3mark) })()`)
        if (!still) {
          // 새 문서가 **새 내용**을 들고 왔나 (재마운트만으로는 부족하다)
          for (let j = 0; j < 30; j++) {
            const rep = JSON.parse(await cdp.eval(`JSON.stringify(window.__m6r3)`))
            const s = rep.find((m) => m.script)
            if (s) {
              if (!String(s.h).includes('다시 읽음')) throw new Error(`옛 내용이 다시 왔다: ${s.h}`)
              return { remounted: true, waitedMs: i * 200, newHeading: s.h, frameNavigated: navs.length - before }
            }
            await sleep(200)
          }
          throw new Error('다시 뜬 문서가 보고를 안 했다')
        }
        await sleep(200)
      }
      throw new Error('12초 동안 iframe이 다시 안 떴다 — HEAD 폴링 재로드 실패')
    })
    await shot(cdp, '03-html-reloaded')

    // ── A10. Esc 중계 — iframe 안에서 뷰어가 닫히나 ─────────────────────────
    await check('bridge-escape-closes-viewer', async () => {
      const b = await cdp.eval(`(() => { const f = document.querySelector('iframe.fv-htmlframe')
        if (!f) return null; const r = f.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
      if (!b) throw new Error('iframe이 없다')
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 })
      await sleep(300)
      await ctx.key('Escape')
      await ctx.waitGone('.fv-overlay', 6000)
      return { viewerClosed: true }
    })
    await ctx.closeViewer()
    await ctx.clearSearch()

    // ── B1. 첨부 저장 — 경로 없는 바이트가 파일이 되나 ──────────────────────
    saved = await check('attachment-save-data', async () => {
      const p = await cdp.eval(
        `(async () => {
           const bin = atob(${JSON.stringify(TINY_PNG)})
           const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i)
           try { return { path: await window.api.saveAttachmentData(a.buffer, 'png') } }
           catch (e) { return { err: String(e).slice(0, 120) } }
         })()`,
        { awaitPromise: true, timeoutMs: 30000 }
      )
      if (p.err) throw new Error(p.err)
      if (!p.path) throw new Error('빈 경로')
      if (!fs.existsSync(p.path)) throw new Error(`디스크에 없다: ${p.path}`)
      const bytes = fs.readFileSync(p.path)
      if (bytes.length !== 70 || bytes.subarray(0, 8).toString('latin1') !== '\x89PNG\r\n\x1a\n')
        throw new Error(`바이트가 다르다: ${bytes.length}B`)
      const underHome = p.path.toLowerCase().startsWith(home.toLowerCase() + path.sep)
      return { path: p.path, bytes: bytes.length, underIsolatedHome: underHome }
    })

    // ── B2. 컴포저 드롭(경로 없는 File) → 썸네일 ────────────────────────────
    await check('composer-attachments', async () => {
      const ok = await cdp.eval(`(async () => {
        const el = document.querySelector('.composer'); if (!el) return false
        const bin = atob(${JSON.stringify(TINY_PNG)})
        const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
        const dt = new DataTransfer()
        for (let i = 0; i < 2; i++) dt.items.add(new File([arr], 'm6r3-' + (i + 1) + '.png', { type: 'image/png' }))
        el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
        el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
        el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
        return true
      })()`, { awaitPromise: true, timeoutMs: 20000 })
      if (!ok) throw new Error('.composer가 없다')
      const n = await ctx.waitFor('.composer .img-tray .img-thumb', 12000, 2)
      // 썸네일이 진짜 그림을 그렸나 (ccg-img 스킴 왕복)
      const drawn = await cdp.eval(`(() => {
        const im = [...document.querySelectorAll('.composer .img-tray img')]
        return im.map((i) => ({ w: i.naturalWidth, complete: i.complete }))
      })()`)
      return { thumbs: n, imgs: drawn }
    })
    await shot(cdp, '04-composer-attachments')

    // ── B3. 라이트박스 ──────────────────────────────────────────────────────
    await check('image-lightbox', async () => {
      await ctx.click('.img-thumb-open')
      await ctx.waitFor('.iv-overlay .iv-stage', 8000)
      const strip = await ctx.count('.iv-overlay .iv-strip')
      const shown = await cdp.eval(`(() => { const i = document.querySelector('.iv-overlay .iv-stage img')
        return i ? { w: i.naturalWidth, h: i.naturalHeight, src: (i.getAttribute('src') || '').slice(0, 40) } : null })()`)
      if (!shown || !shown.w) throw new Error(`라이트박스가 그림을 못 그렸다: ${JSON.stringify(shown)}`)
      return { strip, shown }
    })
    await shot(cdp, '05-image-lightbox')
    await ctx.esc(1)
    await ctx.waitGone('.iv-overlay', 4000)

    // ── B4. 채널 감사 — 이 라운드가 연 둘이 실제로 구현됐나 (3.0 전용) ──────
    if (kind === 'tauri')
      await check('channel-audit-r3', async () => {
        const probes = [
          ['fs:html-preview-url', [{ cwd: WORK, relPath: 'm6r3-page.html' }]],
          ['attachment:save-data', [{ b64: TINY_PNG, ext: 'png' }]]
        ]
        const r = await cdp.eval(
          `(async () => {
             const out = {}
             for (const [channel, payload] of ${JSON.stringify(probes)}) {
               try {
                 const v = await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel, payload })
                 out[channel] = (v && typeof v === 'object' && v.__unimplemented) ? 'unimplemented' : (v ? 'ok' : 'empty')
               } catch (e) { out[channel] = 'threw:' + String(e).slice(0, 60) }
             }
             return out
           })()`,
          { awaitPromise: true, timeoutMs: 30000 }
        )
        const bad = Object.entries(r).filter(([, v]) => v !== 'ok')
        if (bad.length) throw new Error(`미구현/실패: ${JSON.stringify(bad)}`)
        return r
      })

    // ── B5. 앱이 살아 있나 ──────────────────────────────────────────────────
    await check('alive-at-the-end', async () => {
      const rows = await ctx.count('.explorer .fxtree .fxr')
      const title = await cdp.eval(`document.title`)
      return { treeRows: rows, title }
    })
  } catch (e) {
    checks.push({ id: '__harness', ok: false, error: String(e?.message ?? e) })
    console.log(`  [FAIL] __harness — ${e?.message ?? e}`)
  } finally {
    if (!KEEP) {
      cdp?.close()
      killTree(child.pid)
      await sleep(600)
    }
  }
  const passed = checks.filter((c) => c.ok).length
  const sweptRealHome = sweepAttachments(attachBefore)
  if (sweptRealHome) console.log(`[m6r3:${kind}] 실홈 첨부 되치움: ${sweptRealHome}개 (2.6.2는 CCG_HOME을 안 탄다)`)
  console.log(`[m6r3:${kind}] ${passed}/${checks.length} 통과`)
  const report = {
    kind,
    version,
    at: new Date().toISOString(),
    bin: kind === 'tauri' ? binInfo(EXE) : { exe: 'electron 2.6.2 (out/)' },
    work: WORK,
    home,
    previewUrl,
    saved,
    sweptRealHome,
    passed,
    total: checks.length,
    checks
  }
  const rdir = path.join(REPO, 'bench', 'results')
  fs.mkdirSync(rdir, { recursive: true })
  fs.writeFileSync(path.join(rdir, `m6r3-${kind}.json`), JSON.stringify(report, null, 2))
  return report
}

const main = async () => {
  makeWork(KINDS[0])
  if (KINDS.includes('tauri')) EXE = await snapshotExe()
  const reports = []
  for (let i = 0; i < KINDS.length; i++) {
    console.log(`\n── ${KINDS[i]} ──────────────────────────────────────────────`)
    reports.push(await run(KINDS[i]))
    makeWork(KINDS[i + 1] ?? KINDS[i]) // 다음 앱은 같은 출발선 + 그 앱의 URL 모양으로
  }
  if (reports.length === 2) {
    console.log('\n── A/B ────────────────────────────────────────────────')
    const ids = [...new Set(reports.flatMap((r) => r.checks.map((c) => c.id)))]
    for (const id of ids) {
      const cells = reports.map((r) => {
        const c = r.checks.find((x) => x.id === id)
        return c ? (c.ok ? 'ok' : 'FAIL') : '—'
      })
      console.log(`  ${id.padEnd(34)} ${cells[0].padEnd(8)} ${cells[1]}`)
    }
    // 값이 갈리는 자리는 표에 안 보인다 — 의도한 발산을 따로 적는다
    const inner = reports.map((r) => r.checks.find((c) => c.id === 'page-inner-fetch-cors')?.detail?.fetch ?? '—')
    console.log(`\n  [의도한 발산] 문서 안 fetch(CORS): 2.6.2=${inner[0]} · 3.0=${inner[1]}`)
    const homes = reports.map((r) => r.checks.find((c) => c.id === 'attachment-save-data')?.detail?.path ?? '—')
    console.log(`  [의도한 발산] 첨부 저장 위치: 2.6.2=${homes[0]} · 3.0=${homes[1]}`)
  }
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
