// R28f SHIPBLOCK — 출하 차단 2건을 **눌러서** 재는 하네스.
//
//   node scripts/poc-shipblock.mjs tauri --exe=<경로> [--port=n] [--boot=single|multi] [--out=json]
//   node scripts/poc-shipblock.mjs electron        [--port=n] [--boot=single|multi] [--out=json]
//
// 재는 것 둘:
//   N1  Codex 계정 축 — 다섯 채널(login·logout·login-cancel·reorder·set-default)이
//       화면에서 **진짜로 도는가**. 목록이 빈 배열로 갈아끼워지지 않는가.
//   N2  렌더 예외 채팅을 골랐을 때 **거기서 나올 수 있는가**(사이드바 생존 · 새로고침 복구).
//
// ── 안전 규약(사용자 실홈 불가침) ────────────────────────────────────────────
//  · 픽스처 홈은 **아무것도 복사하지 않는다**. `bench/fixture.mjs`의 `makeFixtureHome`은
//    실홈의 `accounts.json`·`codex-accounts.json`을 복사하는데, 그 파일들이 복사된 홈에서
//    앱이 토큰을 리프레시하면 **실앱 토큰이 되싱크된다**(R28f 함정 5). 그래서 이 하네스는
//    자기 픽스처를 처음부터 만들고 계정은 **합성**(`@example.invalid`)만 쓴다.
//  · Codex 로그인은 **가짜 CLI 스텁**(`codex.cmd`)으로 왕복한다 — PATH 맨 앞에 스텁 폴더를
//    끼워 진짜 `codex`가 절대 안 잡히게 하고, 스텁이 `CODEX_HOME/auth.json`을 쓴다.
//    **실 OAuth 왕복은 하지 않는다**(브라우저를 열지 않는다).
//  · 이름 기반 kill 없음 — 내가 spawn한 PID 트리만 죽인다(`killTree`).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { electronProfile, tauriProfile, cdpTargets, Cdp, killTree, sleep, REPO } from '../bench/lib.mjs'

const kind = process.argv[2] ?? 'tauri'
const argv = process.argv.slice(3)
const arg = (k, d) => {
  const a = argv.find((x) => x.startsWith(`--${k}=`))
  return a ? a.slice(k.length + 3) : d
}
const PORT = Number(arg('port', kind === 'tauri' ? 10520 : 10521))
const BOOT = arg('boot', 'single') // single | multi(예외 패널 보드로 부팅)
const TAG = arg('tag', 'r1')
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'critic', `shipblock-${TAG}-${kind}-${BOOT}.json`)))
const APP_VERSION = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
const HOME = path.join('C:\\Temp', `ccg-r28f-ship`, `home-${kind}-${BOOT}-${TAG}`)
const STUB = path.join('C:\\Temp', `ccg-r28f-ship`, `stub-${kind}-${BOOT}-${TAG}`)

// ── 픽스처(자급자족) ────────────────────────────────────────────────────────
const CX_A = 'r28f-a@example.invalid'
const CX_B = 'r28f-b@example.invalid'
const NEW_EMAIL = 'r28f-new@example.invalid'

function snap(messages) {
  return {
    status: 'done', messages, todos: [], files: [], diffs: {}, subagents: [], bgTasks: [],
    session: null, result: null, spentUsd: 0, tokenTotals: {}, seq: messages.length + 1, shownNotices: []
  }
}

function makeHome() {
  try { fs.rmSync(HOME, { recursive: true, force: true }) } catch { /* 잠기면 덮어쓴다 */ }
  fs.mkdirSync(path.join(HOME, 'chats'), { recursive: true })
  fs.writeFileSync(path.join(HOME, 'profile.json'), JSON.stringify({ nickname: 'Bench', color: '#0EA5E9' }))
  fs.writeFileSync(path.join(HOME, 'engine-auto-update.json'), JSON.stringify({ enabled: false }))
  fs.writeFileSync(
    path.join(HOME, 'ui-prefs.json'),
    JSON.stringify({
      'workspace.mode': BOOT === 'multi' ? 'multi' : 'single',
      'explorer.swap': false,
      'chat.zoom': 1,
      'sidebar.autohide': false,
      'whatsnew.seenVersion': APP_VERSION,
      'ui.lang': 'ko'
    })
  )
  // 합성 Codex 계정 둘 — `authEnc`가 없으므로 **실행에는 못 쓰이고**(복호 실패) 목록·순서
  // 조작에만 쓰인다. 실홈 파일은 읽지도 복사하지도 않는다.
  fs.writeFileSync(
    path.join(HOME, 'codex-accounts.json'),
    JSON.stringify({ version: 1, accounts: [{ email: CX_A, plan: 'plus' }, { email: CX_B, plan: 'pro' }] }, null, 2)
  )

  const time = '오후 3:00'
  const line = (i, role) => ({ kind: 'msg', id: `${role}${i}`, role, text: `${role} ${i}: 캐시 무효화 규칙을 검토한다.`, animate: false, time })
  const msgs = []
  for (let i = 0; i < 12; i++) { msgs.push(line(i, 'user')); msgs.push(line(i, 'assistant')) }
  msgs.push({ kind: 'worked', id: 'w1', ms: 12000 })
  fs.writeFileSync(path.join(HOME, 'chats', 'fix-long-thread.json'), JSON.stringify({
    id: 'fix-long-thread', title: '벤치 긴 스레드', custom: true, manualCwd: REPO, updatedAt: Date.now(),
    picker: { model: 'haiku', effort: 'minimal', mode: 'bypass' }, snapshot: snap(msgs)
  }))
  fs.writeFileSync(path.join(HOME, 'chats', 'fix-empty.json'), JSON.stringify({
    id: 'fix-empty', title: '벤치 빈 채팅', custom: true, updatedAt: Date.now() - 1000,
    picker: { model: 'haiku', effort: 'minimal', mode: 'bypass' }, snapshot: snap([])
  }))
  // 렌더 예외 채팅 — text가 객체라 React가 자식 렌더에서 던진다(bench/screens.mjs와 같은 기전)
  fs.writeFileSync(path.join(HOME, 'chats', 'fix-boom.json'), JSON.stringify({
    id: 'fix-boom', title: '벤치 예외 채팅', custom: true, updatedAt: Date.now() - 2000, manualCwd: REPO,
    picker: { model: 'haiku', effort: 'minimal', mode: 'bypass' },
    snapshot: snap([{ kind: 'msg', id: 'boom1', role: 'assistant', text: { boom: true }, animate: false, time }])
  }))
  fs.writeFileSync(
    path.join(HOME, 'chats', 'index.json'),
    JSON.stringify({ version: 1, order: ['fix-long-thread', 'fix-empty', 'fix-boom'], activeChatId: 'fix-long-thread' })
  )

  if (BOOT === 'multi') {
    // 멀티 보드 — 0번 패널이 렌더 예외를 던진다(「다른 문」 확인).
    const dir = path.join(HOME, 'multi-agent')
    fs.mkdirSync(dir, { recursive: true })
    const panel = (title, messages) => ({
      title, custom: !!title, locked: false, color: '', cwd: REPO, refDirs: [],
      picker: { model: 'haiku', effort: 'minimal', mode: 'bypass' }, api: false,
      snapshot: messages ? snap(messages) : null
    })
    const session = {
      id: 'fix-multi-session', title: '벤치 멀티', custom: true, count: 2, panelOrder: [0, 1, 2, 3, 4, 5],
      panels: [
        panel('벤치 예외 패널', [{ kind: 'msg', id: 'pboom', role: 'assistant', text: { boom: true }, animate: false, time }]),
        panel('벤치 패널 2', [line(0, 'user'), line(0, 'assistant')]),
        panel('', null), panel('', null), panel('', null), panel('', null)
      ],
      updatedAt: Date.now()
    }
    fs.writeFileSync(path.join(dir, 'fix-multi-session.json'), JSON.stringify(session))
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ version: 2, activeSessionId: 'fix-multi-session', order: ['fix-multi-session'] }))
  }
}

/**
 * 가짜 `codex` CLI. PATH 맨 앞에 이 폴더를 끼우므로 앱이 찾는 codex는 **언제나 이것**이다
 * (진짜 `codex.cmd`는 `%APPDATA%\npm`에 있고 그 칸은 뒤에 온다 —
 *  `ccg_engine::codex::versions::scan_dirs`는 첫 히트를 쓴다).
 *
 *  login  : https URL 한 줄을 뱉고(폴백 링크 방출 확인) `%CODEX_HOME%\auth.json`을 쓴다
 *  logout : `%CODEX_HOME%\auth.json`을 지운다
 * 그리고 무슨 일이 있었는지 `%CCG_STUB_LOG%`에 한 줄씩 적는다(스폰 사실의 증거).
 */
function makeStub() {
  try { fs.rmSync(STUB, { recursive: true, force: true }) } catch { /* ignore */ }
  fs.mkdirSync(STUB, { recursive: true })
  // 페이로드가 `{"email":..., "https://api.openai.com/auth":{"chatgpt_plan_type":"plus"}}`인
  // 서명 없는 JWT — `ccg_auth::codex::parse_auth`는 표시용으로만 디코드한다.
  const payload = Buffer.from(JSON.stringify({
    email: NEW_EMAIL, 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' }
  })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const authJson = JSON.stringify({
    tokens: { id_token: `h.${payload}.s`, access_token: 'stub-access', refresh_token: 'stub-refresh' },
    last_refresh: new Date().toISOString()
  })
  fs.writeFileSync(path.join(STUB, 'auth.json.tpl'), authJson)
  const cmd = [
    '@echo off',
    'echo %1 %CODEX_HOME% >> "%CCG_STUB_LOG%"',
    'if /I "%1"=="login" (',
    '  echo Opening browser to sign in...',
    '  echo https://auth.openai.com/r28f-stub-login',
    `  copy /y "${path.join(STUB, 'auth.json.tpl')}" "%CODEX_HOME%\\auth.json" >nul`,
    '  exit /b 0',
    ')',
    'if /I "%1"=="logout" (',
    '  del /q "%CODEX_HOME%\\auth.json" 2>nul',
    '  exit /b 0',
    ')',
    'exit /b 0',
    ''
  ].join('\r\n')
  fs.writeFileSync(path.join(STUB, 'codex.cmd'), cmd)
  return path.join(STUB, 'stub.log')
}

const stubLog = makeStub()
makeHome()
fs.writeFileSync(stubLog, '')

/**
 * `--nocli=1` — codex를 **찾을 수 없는** PATH를 만든다(스텁도 안 끼운다).
 * 「띄울 CLI가 없다」를 사용자에게 말하는가를 재는 주행용. 진짜 codex가 사는 칸
 * (`%APPDATA%\npm` 등)만 정확히 빼고 나머지는 그대로 둔다 — PATH를 통째로 갈면
 * WebView2·시스템 DLL 경로까지 흔들려 다른 것을 재게 된다.
 */
function pathWithoutCodex() {
  return (process.env.PATH ?? '')
    .split(';')
    .filter((d) => {
      if (!d) return false
      try { return !fs.readdirSync(d).some((f) => /^codex(\.|$)/i.test(f)) } catch { return true }
    })
    .join(';')
}
const NO_CLI = arg('nocli', '0') === '1'

const profile = kind === 'tauri' ? tauriProfile({ port: PORT, exe: arg('exe', undefined) }) : electronProfile({ port: PORT })
if (kind !== 'tauri') profile.args = ['.', `--remote-debugging-port=${PORT}`]

const child = spawn(profile.cmd, profile.args, {
  env: {
    ...process.env,
    ...profile.env,
    CCG_HOME: HOME,
    CCG_STUB_LOG: stubLog,
    // 진짜 codex/claude가 절대 안 잡히게 스텁 폴더를 맨 앞에 둔다
    PATH: NO_CLI ? pathWithoutCodex() : `${STUB};${process.env.PATH}`,
    // 한도 HTTP·토큰 해지 왕복 차단(합성 계정이라 어차피 못 가지만 이중 안전핀).
    // `--nonet=0`으로만 끈다 — 그때도 codex는 **PATH 스텁**이라 진짜 CLI는 안 뜬다
    // (`codex logout`이 실제로 스폰되는지를 재는 주행용).
    ...(arg('nonet', '1') === '0' ? {} : { CCG_NO_NET: '1' })
  },
  cwd: profile.cwd,
  stdio: 'ignore'
})

const out = { app: profile.name, kind, boot: BOOT, at: new Date().toISOString(), exe: profile.cmd, home: HOME, pid: child.pid, cases: {} }
const record = (id, v) => { out.cases[id] = v; console.log(`\n[${id}] ${JSON.stringify(v).slice(0, 1200)}`) }

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

const HELP = `(() => {
  window.__all = (s) => [...document.querySelectorAll(s)]
  window.__txt = (s) => (document.querySelector(s)?.textContent || '').replace(/\\s+/g, ' ').trim()
  window.__clickText = (sel, txt) => {
    const el = [...document.querySelectorAll(sel)].find((x) => (x.textContent || '').includes(txt))
    if (!el) return false
    el.click(); return true
  }
  window.__openSettings = async (label) => {
    if (!document.querySelector('.set-modal')) {
      document.querySelector('.sb-foot')?.click()
      await new Promise((r) => setTimeout(r, 800))
    }
    const b = [...document.querySelectorAll('.set-nav .set-ni')].find((x) => (x.textContent || '').trim() === label)
    if (!b) return '레일에 ' + label + ' 없음'
    b.click()
    await new Promise((r) => setTimeout(r, 900))
    return (document.querySelector('.set-nav .set-ni.on')?.textContent || '').trim()
  }
  // 로그인 폴백 링크(auth:login-url)가 codex 축에서도 렌더러에 닿는가.
  // 카드는 로그인이 끝나면 사라지므로(스텁은 1초 안에 끝난다) 구독으로 잡아 둔다.
  window.__loginUrls = []
  try { window.api.auth.onLoginUrl((u) => window.__loginUrls.push(u)) } catch (e) { window.__loginUrls.push('SUB-FAIL ' + e) }
  return true
})()`

const readStore = () => {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'codex-accounts.json'), 'utf8')) } catch { return null }
}
const emailsOnDisk = () => (readStore()?.accounts ?? []).map((a) => a.email)
const activeOnDisk = () => {
  for (const rel of ['chats-v3/index.json', 'chats/index.json']) {
    try { return { file: rel, ...JSON.parse(fs.readFileSync(path.join(HOME, rel), 'utf8')) } } catch { /* 다음 */ }
  }
  return null
}

let cdp = null
try {
  cdp = await connectMain(PORT)
  await cdp.send('Runtime.enable').catch(() => {})
  out.shimWarns = []
  cdp.listeners.push((msg) => {
    if (msg.method !== 'Runtime.consoleAPICalled') return
    const txt = (msg.params?.args ?? []).map((a) => a.value ?? '').join(' ')
    if (/\[shim\]/.test(txt)) out.shimWarns.push(txt.slice(0, 200))
  })
  for (let i = 0; i < 400; i++) {
    const ok = await cdp.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`).catch(() => false)
    if (ok) break
    await sleep(150)
  }
  await sleep(4000)
  await cdp.eval(HELP)

  if (BOOT === 'multi') {
    // ── 「다른 문」 — 예외를 던지는 것이 **멀티 보드**일 때도 같은 감옥인가 ──────────
    const r = {}
    r.eb = await cdp.eval(`__all('.eb-card').length`)
    r.sbItems = await cdp.eval(`__all('.sidebar .sb-item').length`)
    r.win = await cdp.eval(`__all('.win').length`)
    r.panels = await cdp.eval(`__all('.ma-panel, .mapanel').length`)
    // 사이드바에서 본채팅으로 빠져나갈 수 있는가
    r.escaped = await cdp.eval(
      `(async () => {
        const it = [...document.querySelectorAll('.sidebar .sb-item')].find((x) => (x.textContent || '').includes('벤치 긴 스레드'))
        if (!it) return 'no-item'
        it.click()
        await new Promise((x) => setTimeout(x, 2500))
        return { eb: document.querySelectorAll('.eb-card').length, chat: document.querySelectorAll('.chat').length }
      })()`, { awaitPromise: true, timeoutMs: 30000 }
    )
    r.stuck = !!(r.eb > 0 && r.sbItems === 0)
    record('multi-boom', r)
  } else {
    // ── 1. N1 — Codex 계정 축 ───────────────────────────────────────────────
    //
    // ★2.6.2에서는 **한 칸도 누르지 않는다.** 그쪽 `src/main/codex/auth.ts:20`은
    // `APP_HOME = os.homedir()/.agentcodegui`를 하드코딩해 `CCG_HOME`을 무시한다 —
    // 격리 홈에서 돌려도 순서 변경·삭제가 **사용자 실홈의 `codex-accounts.json`을 쓴다**.
    // (설정 탭도 안 연다: 그 탭이 `codex-auth:accounts-usage`를 쏘면 실계정 토큰이
    //  리프레시될 수 있다.) 이 축의 2.6.2 대조는 감사 R2 §N1이 이미 적어 뒀다.
    if (kind === 'tauri') {
      const r = { diskBefore: emailsOnDisk() }
      r.tab = await cdp.eval(`__openSettings('Account')`, { awaitPromise: true, timeoutMs: 25000 })
      await sleep(2500)
      r.cxBefore = await cdp.eval(`window.api.codexAuth.listAccounts().then(l => l.map(a => a.email + (a.isDefault ? '*' : '')))`, { awaitPromise: true, timeoutMs: 25000 })
      // 렌더러가 실제로 부르는 그 호출 그대로 — 결과가 화면 상태(setCxAccounts)에 앉는 값이다
      r.reorderReturns = await cdp.eval(
        `window.api.codexAuth.listAccounts().then(l => window.api.codexAuth.reorderAccounts(l.map(a => a.email)))
           .then(r => ({ ok: true, isArray: Array.isArray(r), n: (r||[]).length, emails: (r||[]).map(a=>a.email) }))
           .catch(e => ({ ok: false, err: String(e && e.message || e) }))`,
        { awaitPromise: true, timeoutMs: 25000 }
      )
      // 원시 채널 — `{__unimplemented:true}`가 아닌가(감사가 잡은 그 모양)
      r.raw = await cdp.eval(
        `(async () => {
           const inv = window.__TAURI_INTERNALS__ ? window.__TAURI_INTERNALS__.invoke : null
           if (!inv) return 'no-invoke(2.6.2)'
           const one = async (channel, payload) => {
             try { const v = await inv('ipc_call', { channel, payload }); return (v && v.__unimplemented) ? '__unimplemented' : (Array.isArray(v) ? 'array:' + v.length : JSON.stringify(v)) }
             catch (e) { return 'THROW ' + String(e) }
           }
           return {
             cancel: await one('codex-auth:login-cancel', []),
             setDefault: await one('codex-auth:set-default-account', ['${CX_A}']),
             reorder: await one('codex-auth:reorder-accounts', [['${CX_A}', '${CX_B}']])
           }
         })()`, { awaitPromise: true, timeoutMs: 30000 }
      )
      record('codex-channels', r)
    }

    // ── 2. 「맨 위로」를 **화면에서 누른다** → 목록이 살아 있고 디스크가 바뀌는가 ────
    if (kind === 'tauri') {
      const r = { diskBefore: emailsOnDisk() }
      r.pressed = await cdp.eval(
        `(async () => {
           const btns = [...document.querySelectorAll('.set-inner .sc2.acct .acts .set-chipbtn')].filter(b => /맨 위로|기본으로|Move to top|Set default|Make default/.test(b.textContent||''))
           const b = btns[btns.length - 1]   // OpenAI 섹션이 마지막
           if (!b) return 'no-button'
           b.click()
           await new Promise((x) => setTimeout(x, 3000))
           return true
         })()`, { awaitPromise: true, timeoutMs: 30000 }
      )
      r.rowsAfter = await cdp.eval(`__all('.set-inner .sc2.acct').length`)
      r.cxAfter = await cdp.eval(`window.api.codexAuth.listAccounts().then(l => l.map(a => a.email + (a.isDefault ? '*' : '')))`, { awaitPromise: true, timeoutMs: 25000 })
      r.emailsOnScreen = await cdp.eval(`__all('.set-inner .sc2.acct .emt').map(x => x.textContent.trim())`)
      r.notes = await cdp.eval(`__all('.set-note2').map(x => (x.textContent||'').replace(/\\s+/g,' ').trim()).filter(s => /실패|Could not|failed/.test(s))`)
      r.diskAfter = emailsOnDisk()
      record('codex-move-top', r)
    }

    // ── 3. 「계정 추가」 — 스텁 CLI로 **왕복 전체**를 돈다(실 OAuth 아님) ─────────
    //
    // ★2.6.2에서는 누르지 않는다. 그쪽 `codexBin()`은 `os.homedir()`를 하드코딩해
    // (`src/main/codex/versions.ts`) 내 PATH 스텁을 **안 본다** — 실홈에 설치된 진짜
    // codex가 떠서 브라우저 OAuth가 시작된다. 그 축의 파리티는 감사 R2가 이미 확인했다.
    if (kind === 'tauri') {
      const r = { diskBefore: emailsOnDisk() }
      const t0 = Date.now()
      r.pressed = await cdp.eval(`(() => { const rows = __all('.set-inner .set-addrow'); const b = rows[rows.length - 1]; if (!b) return false; b.click(); return true })()`)
      await sleep(1200)
      r.busySpinner = await cdp.eval(`__all('.set-inner .set-spin').length`)
      r.loginCard = await cdp.eval(`__all('.set-inner .sc2.acct').map(x => (x.textContent||'').replace(/\\s+/g,' ').trim()).filter(s => /로그인 진행 중|Signing in/.test(s)).length`)
      for (let i = 0; i < 40; i++) {
        const n = await cdp.eval(`window.api.codexAuth.listAccounts().then(l => l.length)`, { awaitPromise: true, timeoutMs: 20000 }).catch(() => 0)
        if (n > 2) break
        await sleep(500)
      }
      r.ms = Date.now() - t0
      r.cxAfter = await cdp.eval(`window.api.codexAuth.listAccounts().then(l => l.map(a => a.email))`, { awaitPromise: true, timeoutMs: 25000 })
      r.emailsOnScreen = await cdp.eval(`__all('.set-inner .sc2.acct .emt').map(x => x.textContent.trim())`)
      r.loginUrls = await cdp.eval(`window.__loginUrls || 'no-hook'`)
      r.diskAfter = emailsOnDisk()
      r.stubLog = fs.readFileSync(stubLog, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      // 「띄울 CLI가 없다」를 **사용자에게 말하는가**(`--nocli=1` 주행에서만 의미 있다)
      r.notes = await cdp.eval(`__all('.set-note2').map(x => (x.textContent||'').replace(/\\s+/g,' ').trim()).filter(s => /찾지 못|실패|Could not|failed|not find/.test(s))`)
      r.noCli = NO_CLI
      record('codex-login', r)
    }

    // ── 4. 「삭제」 — 방금 만든 합성 계정만 지운다 ─────────────────────────────
    if (kind === 'tauri') {
      const r = { diskBefore: emailsOnDisk() }
      // 레코드에 authEnc가 있는지 = `codex logout`을 띄울 조건이 되는지(격리 홈 물질화)
      r.recBefore = (readStore()?.accounts ?? []).map((a) => `${a.email}:${Object.keys(a).sort().join('+')}`)
      r.authFiles = (() => {
        const base = path.join(HOME, 'codex', 'accounts')
        try { return fs.readdirSync(base).map((d) => `${d}/${fs.existsSync(path.join(base, d, 'auth.json')) ? 'auth' : '-'}`) } catch { return [] }
      })()
      r.pressed = await cdp.eval(
        `(async () => {
           const card = [...document.querySelectorAll('.set-inner .sc2.acct')].find(c => (c.textContent||'').includes('${NEW_EMAIL}'))
           if (!card) return 'no-card'
           const b = [...card.querySelectorAll('.set-chipbtn.danger')][0]
           if (!b) return 'no-delete'
           b.click()
           await new Promise((x) => setTimeout(x, 3500))
           return true
         })()`, { awaitPromise: true, timeoutMs: 30000 }
      )
      r.cxAfter = await cdp.eval(`window.api.codexAuth.listAccounts().then(l => l.map(a => a.email))`, { awaitPromise: true, timeoutMs: 25000 })
      r.diskAfter = emailsOnDisk()
      r.notes = await cdp.eval(`__all('.set-note2').map(x => (x.textContent||'').replace(/\\s+/g,' ').trim()).filter(s => /실패|Could not|failed/.test(s))`)
      // `codex logout`이 실제로 떴는가(스텁 로그의 마지막 줄들). `--nonet=0`일 때만 뜬다.
      r.stubLog = fs.readFileSync(stubLog, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      record('codex-delete', r)
    }

    if (kind === 'tauri') {
      await cdp.eval(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`).catch(() => {})
      await sleep(1200)
    }

    // ── 5. N2 — 렌더 예외 채팅에서 **나올 수 있는가** ──────────────────────────
    {
      const r = {}
      // 왼쪽 칼럼은 탐색기와 사이드바가 자리를 나눠 쓴다 — 먼저 탐색기를 닫는다
      r.explorerClosed = await cdp.eval(
        `(async () => {
          if (document.querySelector('.lcol .explorer')) { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '\`', bubbles: true })); await new Promise((x) => setTimeout(x, 1200)) }
          return !document.querySelector('.lcol .explorer')
        })()`, { awaitPromise: true, timeoutMs: 20000 }
      )
      r.sbItemsPre = await cdp.eval(`__all('.sidebar .sb-item').length`)
      r.selected = await cdp.eval(
        `(async () => {
          const it = [...document.querySelectorAll('.sidebar .sb-item')].find((x) => (x.textContent || '').includes('벤치 예외 채팅'))
          if (!it) return 'no-item'
          it.click()
          await new Promise((x) => setTimeout(x, 2500))
          return document.querySelectorAll('.eb-card').length
        })()`, { awaitPromise: true, timeoutMs: 30000 }
      )
      await sleep(1500)
      r.beforeReload = await cdp.eval(`({ eb: __all('.eb-card').length, sbItems: __all('.sidebar .sb-item').length, win: __all('.win').length, chat: __all('.chat').length })`)
      r.activeBeforeReload = activeOnDisk()?.activeChatId ?? null
      // ★탈출구 ① — 카드가 떠 있는 채로 **사이드바에서 다른 대화**로 갈 수 있는가
      r.escapeBySidebar = await cdp.eval(
        `(async () => {
          const it = [...document.querySelectorAll('.sidebar .sb-item')].find((x) => (x.textContent || '').includes('벤치 긴 스레드'))
          if (!it) return 'no-item'
          it.click()
          await new Promise((x) => setTimeout(x, 2500))
          return { eb: document.querySelectorAll('.eb-card').length, chat: document.querySelectorAll('.chat').length }
        })()`, { awaitPromise: true, timeoutMs: 30000 }
      )
      // 다시 예외 채팅으로 들어가 **새로고침 경로**를 잰다(감사 R2 §N2의 표와 같은 순서)
      r.reselected = await cdp.eval(
        `(async () => {
          const it = [...document.querySelectorAll('.sidebar .sb-item')].find((x) => (x.textContent || '').includes('벤치 예외 채팅'))
          if (!it) return 'no-item'
          it.click()
          await new Promise((x) => setTimeout(x, 2500))
          return document.querySelectorAll('.eb-card').length
        })()`, { awaitPromise: true, timeoutMs: 30000 }
      )
      await sleep(1200)
      r.activeBeforeReload2 = activeOnDisk()?.activeChatId ?? null
      await cdp.eval(`__clickText('.eb-actions .eb-btn', '새로고침') || __clickText('.eb-actions .eb-btn', 'Reload')`).catch(() => {})
      try { cdp.close() } catch { /* 닫힘 */ }
      await sleep(6000)
      cdp = await connectMain(PORT)
      await cdp.send('Runtime.enable').catch(() => {})
      for (let i = 0; i < 200; i++) {
        const ok = await cdp.eval(`document.readyState === 'complete'`).catch(() => false)
        if (ok) break
        await sleep(150)
      }
      await sleep(5000)
      await cdp.eval(HELP).catch(() => {})
      r.afterReload = await cdp.eval(`({ eb: __all('.eb-card').length, sbItems: __all('.sidebar .sb-item').length, win: __all('.win').length, chat: __all('.chat').length })`).catch((e) => 'THROW ' + e.message)
      r.activeAfterReload = activeOnDisk()?.activeChatId ?? null
      r.titleAfterReload = await cdp.eval(`__txt('.chat-head .hfold')`).catch(() => '')
      r.stuck = !!(r.afterReload && r.afterReload.eb > 0 && r.afterReload.sbItems === 0)
      record('error-boundary', r)
    }
  }
} catch (e) {
  out.fatal = String(e.stack ?? e).slice(0, 900)
  console.log('FATAL', out.fatal.split('\n')[0])
} finally {
  try { cdp?.close() } catch { /* 닫힘 */ }
  killTree(child.pid)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(`\nsaved: ${OUT}`)
