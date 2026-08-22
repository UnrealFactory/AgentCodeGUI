#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// critic-m2-tauri — **실제 Tauri 창으로 옵트인 플래그 경로 스모크**(빌더가 못 한 것,
// 보고서 §6-6). scripts/poc-tauri-stores.mjs 방식: 릴리즈 exe를 격리 홈으로 띄우고
// 렌더러(window.api)에서 계약면 채널을 실제로 부른다.
//
// 본다:
//   1. CCG_UNIFIED_STORE=1 로 뜬 창이 **마이그레이션을 실제로 돌리는가**(디스크 확인)
//   2. 옛 렌더러가 부르는 채널(chats:get/load, ma:get/load-session, talk:get)이
//      **옛 블롭 모양**으로 돌아오는가 / 대화가 다 보이는가
//   3. 마이그레이션된 **추가 채팅(origin=session)**을 3.0 UI가 어디로도 못 보는가
//   4. 플래그 **꺼짐** 대조군 — chats-v3를 만들지 않고 2.6.2 경로 그대로인가
//   5. api-config 키 쓰기 → **Electron safeStorage(2.6.2)가 그대로 읽는가**(포맷 호환)
//
// 안전: 사용자 실홈은 읽기/복사만. 스폰한 PID만 killTree.
//   node docs/critic/tools/critic-m2-tauri.mjs
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep } from '../../../bench/lib.mjs'
import { REPO, cloneReal, readJSON, rmrf, writeResult } from './critic-m2-lib.mjs'

const EXE = fs.existsSync(path.join(os.tmpdir(), 'ccg-critic-m2-app.exe'))
  ? path.join(os.tmpdir(), 'ccg-critic-m2-app.exe')
  : path.join(REPO, 'target', 'release', 'agentcodegui.exe')

async function boot(home, { flag, port }) {
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      CCG_HOME: home,
      ...(flag ? { CCG_UNIFIED_STORE: '1' } : {}),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d.toString()))
  child.stdout.on('data', (d) => (stderr += d.toString()))
  const cdp = await connectMainPage(port, { timeoutMs: 60_000 })
  for (let i = 0; i < 200; i++) {
    if (await cdp.eval(`!!document.getElementById('root')?.children.length`).catch(() => false)) break
    await sleep(100)
  }
  // ★ IPC 브리지가 설 때까지 기다린다 — 안 기다리면 shim의 call()이 폴백(null)을 돌려줘
  //   "채널이 빈 값을 줬다"로 오독한다(크리틱 1차 주행에서 실제로 겪은 오검출).
  for (let i = 0; i < 200; i++) {
    const ok = await cdp
      .eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true })
      .catch(() => false)
    if (ok) break
    await sleep(100)
  }
  const j = async (expr) => JSON.parse(await cdp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
  return { child, cdp, j, log: () => stderr }
}

const rep = { at: new Date().toISOString(), exe: EXE, findings: [] }
const F = (item, d) => rep.findings.push({ item, ...d })

// ── 1~3. 플래그 켜짐 ────────────────────────────────────────────────────────
{
  const home = cloneReal('tauri-on')
  const before = {
    chats: fs.readdirSync(path.join(home, 'chats')).length,
    ma: fs.readdirSync(path.join(home, 'multi-agent')).length
  }
  // 마이그레이션이 어떤 대화를 옮겨야 하는지 미리 센다
  const srcChatIds = fs.readdirSync(path.join(home, 'chats')).filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => f.slice(0, -5))
  const boot1 = await boot(home, { flag: true, port: 9401 })
  try {
    const out = {}
    out.href = await boot1.cdp.eval('location.href')
    out.chats = await boot1.j(
      '((c) => c && { keys: Object.keys(c), activeChatId: c.activeChatId, n: c.chats.length, ids: c.chats.map(x=>x.id), unloaded: c.chats.filter(x=>x.unloaded).length, msgs: c.chats.map(x=>x.snapshot?.messages?.length ?? null), pickers: c.chats.map(x=>x.picker), hasStatuses: !!c.statuses })(await window.api.getChats())'
    )
    const firstId = out.chats?.ids?.[0] ?? ''
    out.chatLoad = await boot1.j(`((c) => c && { id: c.id, msgs: c.snapshot?.messages?.length ?? null, picker: c.picker, manualCwd: c.manualCwd })(await window.api.loadChat(${JSON.stringify(firstId)}))`)
    out.multi = await boot1.j(
      '((m) => m && { version: m.version, activeSessionId: m.activeSessionId, sessions: m.sessions.map(s => ({ id: s.id, count: s.count, unloaded: !!s.unloaded, panels: (s.panels??[]).length, msgs: (s.panels??[]).map(p=>p.snapshot?.messages?.length ?? null), titles: (s.panels??[]).map(p=>p.title) })) })(await window.api.multi.getState())'
    )
    const sid = out.multi?.sessions?.[0]?.id ?? ''
    out.loadSession = await boot1.j(`((s) => s && { id: s.id, panels: (s.panels??[]).length, msgs: (s.panels??[]).map(p=>p.snapshot?.messages?.length ?? null) })(await window.api.multi.loadSession(${JSON.stringify(sid)}))`)
    out.talk = await boot1.j('((t) => t && { chats: (t.chats??[]).length })(await window.api.talk.getState())')
    out.sessionWins = await boot1.j('(await window.api.sessionWindows.list()).length')
    out.apiConfig = await boot1.j('await window.api.apiConfig.get()')
    out.uiPrefs = await boot1.j('Object.keys(await window.api.getUiPrefs()).length')

    // 디스크 — 마이그레이션이 실제로 돌았는가
    out.disk = {
      chatsV3: fs.existsSync(path.join(home, 'chats-v3')) ? fs.readdirSync(path.join(home, 'chats-v3')).length : 0,
      boards: fs.existsSync(path.join(home, 'boards')) ? fs.readdirSync(path.join(home, 'boards')).length : 0,
      backup: fs.readdirSync(home).filter((f) => f.startsWith('backup-2.6.2-')),
      oldChats: fs.readdirSync(path.join(home, 'chats')).length,
      oldMa: fs.readdirSync(path.join(home, 'multi-agent')).length,
      migratedAt: readJSON(path.join(home, 'chats-v3', 'index.json'))?.migratedAt ?? null,
      statusJson: fs.existsSync(path.join(home, 'chats-v3', 'status.json'))
    }
    // 마이그레이션된 채팅 중 origin별
    const v3 = fs.existsSync(path.join(home, 'chats-v3'))
      ? fs.readdirSync(path.join(home, 'chats-v3'))
          .filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'status.json')
          .map((f) => readJSON(path.join(home, 'chats-v3', f)))
          .filter(Boolean)
      : []
    out.byOrigin = v3.reduce((m, c) => ((m[c.origin ?? 'null'] = (m[c.origin ?? 'null'] ?? 0) + 1), m), {})
    out.panelChatsVisibleInMainList = (out.chats?.ids ?? []).filter((i) => String(i).startsWith('ma-')).length
    out.sessionChatsReachable = {
      inMainList: (out.chats?.ids ?? []).filter((i) => v3.find((c) => c.id === i && c.origin === 'session')).length,
      inSessionWinList: out.sessionWins,
      count: out.byOrigin.session ?? 0
    }

    // 옛 렌더러가 실제로 저장을 한 번 하게 만든다(자동 저장 경로) — 대화가 남는가
    await boot1.j('(async () => { const c = await window.api.getChats(); await window.api.saveChats(c); return true })()')
    await sleep(400)
    out.afterRendererSave = {
      chatsV3Files: fs.readdirSync(path.join(home, 'chats-v3')).length,
      byOrigin: fs.readdirSync(path.join(home, 'chats-v3'))
        .filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'status.json')
        .map((f) => readJSON(path.join(home, 'chats-v3', f)))
        .filter(Boolean)
        .reduce((m, c) => ((m[c.origin ?? 'null'] = (m[c.origin ?? 'null'] ?? 0) + 1), m), {})
    }

    // ── 5. api-config 키 쓰기 → Electron safeStorage 호환 ──────────────────
    const TESTKEY = 'sk-ant-critic-m2-0000-TEST-9999'
    out.apiSetKey = await boot1.j(`await window.api.apiConfig.setKey(${JSON.stringify(TESTKEY)})`)
    await sleep(200)
    const cfg = readJSON(path.join(home, 'api-config.json')) ?? {}
    const b64 = typeof cfg.key === 'string' ? cfg.key : ''
    const bytes = Buffer.from(b64, 'base64')
    out.apiKeyOnDisk = {
      enc: cfg.enc,
      keyTail: cfg.keyTail,
      prefixV10: bytes.subarray(0, 3).toString() === 'v10',
      prefixDpapi: bytes.subarray(0, 4).toString('hex'), // DPAPI blob = 01 00 00 00 d0 8c...
      len: bytes.length,
      twoSpaceIndent: fs.readFileSync(path.join(home, 'api-config.json'), 'utf8').includes('\n  "')
    }
    fs.writeFileSync(path.join(os.tmpdir(), 'ccg-critic-m2-key.txt'), b64)
    rep.flagOn = out
    if (!out.disk.migratedAt) F('플래그를 켜도 마이그레이션이 안 돌았다', out.disk)
    if ((out.chats?.n ?? 0) === 0) F('플래그 경로에서 chats:get이 빈 목록', out.chats)
    if (out.sessionChatsReachable.count > 0 && out.sessionChatsReachable.inMainList === 0 && out.sessionChatsReachable.inSessionWinList === 0) {
      F('마이그레이션된 추가 채팅이 3.0 UI에서 도달 불가', out.sessionChatsReachable)
    }
  } finally {
    killTree(boot1.child.pid)
    await sleep(600)
  }
  rep.flagOn.home = home
  rep.flagOn.before = before
  rep.flagOn.srcChatIds = srcChatIds
}

// ── 4. 대조군 — 플래그 꺼짐 ────────────────────────────────────────────────
{
  const home = cloneReal('tauri-off')
  const b = await boot(home, { flag: false, port: 9402 })
  try {
    const out = {}
    out.chats = await b.j('((c) => c && { n: c.chats.length, ids: c.chats.map(x=>x.id), unloaded: c.chats.filter(x=>x.unloaded).length, hasStatuses: !!c.statuses })(await window.api.getChats())')
    out.multi = await b.j('((m) => m && { sessions: m.sessions.length })(await window.api.multi.getState())')
    out.disk = { chatsV3: fs.existsSync(path.join(home, 'chats-v3')), boards: fs.existsSync(path.join(home, 'boards')) }
    rep.flagOff = out
    if (out.disk.chatsV3 || out.disk.boards) F('플래그가 꺼졌는데 통합 스토어가 생겼다', out.disk)
  } finally {
    killTree(b.child.pid)
    await sleep(400)
  }
  rmrf(home)
}

// ── 6. 합성 홈(추가 채팅 2개 포함) — 마이그레이션된 추가 채팅에 UI가 닿는가 ──
{
  const home = path.join(os.tmpdir(), `ccg-critic-m2-tauri-sc-${Date.now()}`)
  for (const d of ['chats', 'multi-agent', 'session-chats']) fs.mkdirSync(path.join(home, d), { recursive: true })
  const snap = (n, sid) => ({
    status: 'idle', messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `줄 ${i}`, animate: false })),
    todos: [], files: [], diffs: {}, terminal: [], subagents: [], bgTasks: [], workflows: [], pendingPermission: null, pendingQuestion: null,
    session: sid ? { sessionId: sid, model: 'opus', cwd: 'C:\\Code' } : null, result: null, spentUsd: 0, tokenTotals: {}, streaming: false, seq: n, shownNotices: []
  })
  fs.writeFileSync(path.join(home, 'ui-prefs.json'), JSON.stringify({ 'workspace.mode': 'single' }))
  fs.writeFileSync(path.join(home, 'chats', 'main-1.json'), JSON.stringify({ id: 'main-1', title: '본채팅', custom: false, snapshot: snap(4, 's1'), manualCwd: 'C:\\Code', picker: {} }))
  fs.writeFileSync(path.join(home, 'chats', 'index.json'), JSON.stringify({ version: 1, order: ['main-1'], activeChatId: 'main-1' }))
  fs.writeFileSync(path.join(home, 'multi-agent', 'index.json'), JSON.stringify({ version: 2, order: [], activeSessionId: '' }))
  for (const [i, id] of ['sc-alpha', 'sc-beta'].entries()) {
    fs.writeFileSync(path.join(home, 'session-chats', `${id}.json`), JSON.stringify({ id, title: `추가 채팅 ${i}`, status: 'done', cwd: 'C:\\Code', snapshot: snap(11 + i, `ss${i}`), picker: {}, updatedAt: 7 }))
  }
  fs.writeFileSync(path.join(home, 'session-chats', 'index.json'), JSON.stringify({ version: 1, order: ['sc-alpha', 'sc-beta'] }))
  const b = await boot(home, { flag: true, port: 9403 })
  try {
    const out = {}
    out.chats = await b.j('((c) => c && { ids: c.chats.map(x=>x.id), n: c.chats.length })(await window.api.getChats())')
    out.sessionWins = await b.j('await window.api.sessionWindows.list()')
    out.multi = await b.j('((m)=> m && { sessions: m.sessions.length })(await window.api.multi.getState())')
    // 옛 렌더러의 자동 저장 1회 — 추가 채팅 파일이 살아남는가(prune 방어)
    await b.j('(async () => { const c = await window.api.getChats(); await window.api.saveChats(c); return true })()')
    await sleep(400)
    const files = fs.readdirSync(path.join(home, 'chats-v3')).filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'status.json')
    out.v3Files = files
    out.sessionChatFilesSurvived = files.filter((f) => f.startsWith('sc-')).length
    out.reachableInUi = (out.chats?.ids ?? []).filter((i) => String(i).startsWith('sc-')).length + (out.sessionWins?.length ?? 0)
    rep.syntheticSessionChats = out
    if (out.sessionChatFilesSurvived !== 2) F('6. 추가 채팅 파일이 렌더러 저장에 지워졌다', out)
    if (out.reachableInUi === 0) F('6. 마이그레이션된 추가 채팅에 3.0 UI가 전혀 닿지 않는다(사이드바·창 목록 모두 없음)', out)
  } finally {
    killTree(b.child.pid)
    await sleep(400)
  }
  rmrf(home)
}

// ── 5b. Electron safeStorage로 복호(2.6.2가 읽을 수 있는가) ─────────────────
{
  const b64 = fs.readFileSync(path.join(os.tmpdir(), 'ccg-critic-m2-key.txt'), 'utf8')
  const dir = path.join(os.tmpdir(), `ccg-critic-m2-electron-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  const main = path.join(dir, 'main.js')
  fs.writeFileSync(
    main,
    `const { app, safeStorage } = require('electron')
const fs = require('fs')
app.setPath('userData', ${JSON.stringify(path.join(dir, 'ud'))})
app.whenReady().then(() => {
  const out = { available: safeStorage.isEncryptionAvailable() }
  try { out.decrypted = safeStorage.decryptString(Buffer.from(${JSON.stringify(b64)}, 'base64')) } catch (e) { out.error = String(e && e.message) }
  try { out.reencrypted = safeStorage.encryptString('sk-ant-electron-side').toString('base64') } catch (e) { out.encError = String(e && e.message) }
  fs.writeFileSync(${JSON.stringify(path.join(dir, 'out.json').replace(/\\/g, '\\\\'))}, JSON.stringify(out))
  app.exit(0)
})
`
  )
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'ccg-critic-safestorage', main: 'main.js' }))
  const eexe = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
  const r = spawnSync(eexe, [dir], { encoding: 'utf8', timeout: 90_000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } })
  const res = readJSON(path.join(dir, 'out.json')) ?? { error: `electron 실행 실패: ${r.status} ${r.stderr?.slice(0, 300)}` }
  rep.electronCompat = {
    available: res.available ?? null,
    decryptsTo: res.decrypted ? `${res.decrypted.slice(0, 12)}…${res.decrypted.slice(-4)}` : null,
    matches: res.decrypted === 'sk-ant-critic-m2-0000-TEST-9999',
    error: res.error ?? null,
    electronWroteV10: res.reencrypted ? Buffer.from(res.reencrypted, 'base64').subarray(0, 3).toString() === 'v10' : null
  }
  if (!rep.electronCompat.matches) F('3.0이 쓴 API 키를 2.6.2(Electron safeStorage)가 못 읽는다', rep.electronCompat)
  rmrf(dir)
}

rep.ok = rep.findings.length === 0
const out = writeResult('m2-r1-tauri.json', rep)
console.log(JSON.stringify({ ok: rep.ok, findings: rep.findings.map((f) => f.item) }, null, 2), out)
process.exit(0)
