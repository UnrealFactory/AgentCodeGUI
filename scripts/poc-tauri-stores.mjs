/**
 * PoC — 3.0 M1의 IPC 왕복과 앱 홈 호환을 실측한다. 릴리즈 exe를 격리 홈으로 띄우고
 * 렌더러(window.api) 쪽에서 계약면 채널을 실제로 불러 2.6.2가 저장한 파일이 그대로
 * 읽히는지, 미구현 채널이 안전값으로 떨어지는지, 메인 화면이 떴는지를 본다.
 *
 *   node scripts/poc-tauri-stores.mjs [CCG_HOME=.bench-home-tauri]
 *
 * 창을 움직이거나 최대화하지 않는다 — 홈의 window-state.json을 오염시키지 않기 위해서다.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { connectMainPage, sleep, killTree, REPO, resolveTauriExe } from '../bench/lib.mjs'

const HOME = path.resolve(process.argv[2] ?? path.join(REPO, '.bench-home-tauri'))
// M12 R2 — mainBinaryName 변경으로 exe 이름이 둘이다(구·신 모두 탐색·최신 mtime 우선)
const EXE = resolveTauriExe()
const PORT = 9347

if (!fs.existsSync(EXE)) {
  console.error('릴리즈 exe가 없다 — npm run tauri:build 먼저')
  process.exit(1)
}

const child = spawn(EXE, [], {
  env: { ...process.env, CCG_HOME: HOME, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: 'ignore'
})

const out = { home: HOME }
try {
  const cdp = await connectMainPage(PORT, { timeoutMs: 45000 })
  const warns = []
  cdp.listeners.push((m) => {
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning')
      warns.push(m.params.args.map((a) => a.value ?? '').join(' '))
  })
  await cdp.send('Runtime.enable')
  for (let i = 0; i < 120; i++) {
    if (await cdp.eval(`!!document.getElementById('root')?.children.length`).catch(() => false)) break
    await sleep(100)
  }
  const j = async (expr) => JSON.parse(await cdp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))

  // 릴리즈 exe는 번들 자산을 커스텀 프로토콜로 서빙해야 한다. localhost가 보이면
  // custom-protocol 피처 없이 빌드된 것(=dev 모드) — 벤치가 dev 서버를 재는 사고의 신호.
  out.href = await cdp.eval('location.href')
  if (!/^http:\/\/tauri\.localhost/.test(String(out.href))) {
    out.warning = 'dev 빌드로 보인다 — npm run tauri:build 로 다시 빌드할 것'
  }
  out.version = await j('await window.api.app.getVersion()')
  out.profile = await j('await window.api.getProfile()')
  out.uiPrefs = await j('await window.api.getUiPrefs()')
  const chats = await j(
    '((c) => c && { version: c.version, activeChatId: c.activeChatId, ids: c.chats.map(x => x.id), unloaded: c.chats.filter(x => x.unloaded).length, msgs: c.chats.map(x => x.snapshot?.messages?.length ?? null) })(await window.api.getChats())'
  )
  out.chats = chats
  out.chatLoad = await j(
    `((c) => c && { id: c.id, msgs: c.snapshot?.messages?.length ?? null })(await window.api.loadChat(${JSON.stringify(
      String((await j('(await window.api.getChats())?.chats?.[0]?.id ?? ""')) || '')
    )}))`
  )
  out.accounts = await j('(await window.api.auth.listAccounts()).map(a => ({ e: a.email.slice(0, 3) + "…", d: a.isDefault, s: a.subscriptionType }))')
  out.codexAccounts = await j('(await window.api.codexAuth.listAccounts()).map(a => ({ e: a.email.slice(0, 3) + "…", d: a.isDefault, p: a.plan }))')
  out.engineState = await j('await window.api.engine.state()')
  out.codexEngineState = await j('await window.api.codexEngine.state()')
  out.engineAutoUpdate = await j('await window.api.engineAutoUpdate()')
  out.engineUpdateStatus = await j('await window.api.engineUpdate.status()')
  out.updateStatus = await j('await window.api.app.getUpdateStatus()')
  out.isMaximized = await j('await window.api.win.isMaximized()')
  out.dirExists = await j('[await window.api.dirExists(String.raw`' + REPO + '`), await window.api.dirExists("Z:/nope")]')
  out.initialDir = await j('await window.api.app.getInitialDirectory()')
  // 미구현 채널의 안전값 (크래시 없이 시그니처에 맞는 값이 오는가)
  out.unimplementedSafe = await j(
    '({ usage: await window.api.getUsage(), sessionWins: await window.api.sessionWindows.list(), skills: await window.api.skill.list(""), git: (await window.api.git.status("")).repo, talk: await window.api.talk.getState(), lspStatus: await window.api.lsp.status("", "") })'
  )
  // 화면 상태
  out.ui = await j(
    '({ rootChildren: document.getElementById("root").children.length, hasWin: !!document.querySelector(".win"), sidebarChats: document.querySelectorAll(".sb-list .sb-item, .sb-list button").length, chrome: window.__ccgChrome })'
  )
  out.consoleWarnings = [...new Set(warns)]
  cdp.close()
} catch (e) {
  out.error = String(e?.message ?? e)
} finally {
  killTree(child.pid)
}
console.log(JSON.stringify(out, null, 2))
