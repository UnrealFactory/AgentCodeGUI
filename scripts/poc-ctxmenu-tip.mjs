#!/usr/bin/env node
/* ============================================================================
 * poc-ctxmenu-tip — 2026-09-01 사용자 보고 두 건의 실측.
 *
 *  A. 네이티브 우클릭 메뉴 억제(main.tsx 전역 preventDefault):
 *     · 채팅 빈 영역 우클릭 → defaultPrevented === true (브라우저 메뉴 안 뜸)
 *     · 컴포저 textarea 우클릭 → false (붙여넣기 메뉴는 남긴다)
 *  B. 사이드바 「전체 삭제」 툴팁: .sb-scroll 위 경계에서 잘리던 위쪽 툴팁을
 *     아래로 뒤집었다 → ::after가 bottom:auto(아래 방향)이고 호버에 opacity 1.
 *
 *   node scripts/poc-ctxmenu-tip.mjs [--exe=…] [--port=11045] [--keep]
 *
 * 안전 규칙: 이름 기반 kill 금지(스폰한 PID 트리만) · CCG_HOME 격리 · 실계정 없음.
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const EXE = resolveTauriExe((args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1])
const PORT = Number((args.find((a) => a.startsWith('--port=')) ?? '').split('=')[1] || 11045)
const KEEP = args.includes('--keep')

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true })
function write(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v))
}

function seed() {
  const HOME = path.join(REPO, '.poc-home-ctxmenu-tip')
  const WORK = path.join(HOME, 'work')
  rmrf(HOME)
  fs.mkdirSync(WORK, { recursive: true })
  // 엔진 턴이 필요 없다 — 설치 판정 마커만 심어 EngineGate 모달을 잠재운다
  write(path.join(HOME, 'config.json'), { activeVersion: 'fake' })
  write(path.join(HOME, 'engine-auto-update.json'), { enabled: false })
  const sdkdir = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
  fs.mkdirSync(sdkdir, { recursive: true })
  write(path.join(sdkdir, 'package.json'), { name: '@anthropic-ai/claude-agent-sdk', version: 'fake' })
  const bindir = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(bindir, { recursive: true })
  write(path.join(bindir, 'claude.exe'), 'stub')
  write(path.join(HOME, 'accounts.json'), { defaultEmail: 'a@fake.test', accounts: [{ email: 'a@fake.test' }] })
  fs.mkdirSync(path.join(HOME, 'accounts', 'a_fake.test'), { recursive: true })
  write(path.join(HOME, 'chats', 'index.json'), { version: 1, order: ['c-a'], activeChatId: 'c-a' })
  write(path.join(HOME, 'chats', 'c-a.json'), {
    id: 'c-a', title: 'd', custom: true, manualCwd: WORK,
    picker: { model: 'haiku', effort: 'minimal', mode: 'normal', account: 'a@fake.test' },
    refDirs: [], snapshot: { messages: [] }, updatedAt: Date.now()
  })
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko', 'whatsnew.seenVersion': '99.0.0' })
  write(path.join(HOME, 'profile.json'), { nickname: 'poc' })
  return HOME
}

async function main() {
  const HOME = seed()
  const child = spawn(EXE, [], {
    env: { ...process.env, CCG_HOME: HOME, CCG_NO_NET: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: ['ignore', 'ignore', 'ignore']
  })
  const out = {}
  try {
    const cdp = await connectMainPage(PORT, { timeoutMs: 60_000 })
    const ev = async (expr) => JSON.parse(await cdp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
    for (let i = 0; i < 300; i++) {
      const up = await cdp.eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true }).catch(() => false)
      if (up) break
      await sleep(100)
    }
    await sleep(1500)
    // 첫 부팅 안내(업데이트 소식 등)가 떠 있으면 닫는다
    await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /시작하기|Get started/.test(x.textContent || '')); if (b) { b.click(); return true } return false })()`)
    await sleep(400)

    // ── A. 우클릭 — 등록 순서상 전역 억제 리스너 **뒤에** 프로브를 달아 판정을 줍는다 ──
    await ev(`(window.__cm = [], document.addEventListener('contextmenu', (e) => window.__cm.push({ tag: (e.target.tagName || '') + '.' + (e.target.className || ''), prevented: e.defaultPrevented })), true)`)
    const rightClick = async (x, y) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 })
      await sleep(250)
    }
    // 빈 채팅 본문 한가운데
    const body = await ev(`(() => { const el = document.querySelector('.chat-scroll, .ma-p-thread, .win-body'); const r = el.getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } })()`)
    await rightClick(Math.round(body.x), Math.round(body.y))
    // 컴포저 textarea — 여긴 네이티브 메뉴가 남아야 한다
    const ta = await ev(`(() => { const el = document.querySelector('.composer textarea'); const r = el.getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } })()`)
    // ★ 네이티브 메뉴가 실제로 뜨면 다음 입력을 막으므로 Esc로 닫고 진행
    await rightClick(Math.round(ta.x), Math.round(ta.y))
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await sleep(200)
    out.contextmenu = await ev(`window.__cm`)

    // ── B. 「전체 삭제」 툴팁 — 아래로 뒤집혔고 호버에 보인다 ────────────────────
    const del = await ev(`(() => { const el = [...document.querySelectorAll('.sb-label .slb.has-tip')].find((b) => /전체 삭제|Delete all/.test(b.dataset.tip || b.getAttribute('aria-label') || '')); if (!el) return null; const r = el.getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } })()`)
    if (del) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(del.x), y: Math.round(del.y), button: 'none', buttons: 0 })
      await sleep(800)
      out.tooltip = await ev(`(() => { const el = [...document.querySelectorAll('.sb-label .slb.has-tip')].find((b) => /전체 삭제|Delete all/.test(b.dataset.tip || b.getAttribute('aria-label') || '')); const cs = getComputedStyle(el, '::after'); const r = el.getBoundingClientRect(); const sc = document.querySelector('.sb-scroll').getBoundingClientRect(); return { opacity: cs.opacity, top: cs.top, bottom: cs.bottom, hover: el.matches(':hover'), btnBottom: +r.bottom.toFixed(1), scrollTop: +sc.top.toFixed(1) } })()`)
      try {
        const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
        fs.writeFileSync(path.join(REPO, '.poc-tip-hover.png'), Buffer.from(r.data, 'base64'))
      } catch { /* 참고용 */ }
    } else {
      out.tooltip = { err: 'delete-all button not found' }
    }
  } finally {
    if (!KEEP) {
      killTree(child.pid)
      await sleep(600)
      rmrf(path.join(REPO, '.poc-home-ctxmenu-tip'))
    }
  }
  console.log(JSON.stringify(out, null, 2))
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
