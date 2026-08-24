#!/usr/bin/env node
/* ============================================================================
 * poc-t1t2 — 최종 파리티 **T1(계정 쓰기 5채널)·T2(엔진 관리 5채널)** 실증.
 *
 * 단위 테스트(`ccg-auth`·`ccg-engine`)는 도메인을, 이 스크립트는 **배선**을 잡는다:
 *   렌더러 `window.api.auth.*` / `window.api.engine.*`
 *      → 심(shim) → `ipc_call` 블로킹 팔 → `ipc/accounts.rs` / `engine/versions.rs`
 *      → 디스크(`accounts.json`·`config.json`)와 **화면**(EngineGate 카드)
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · 실계정 0건. 계정은 `ccg-auth-probe seed`가 만든 **합성**이고, 로그인은
 *    `ccg-fake-claude`(가짜 CLI)로 밟는다 — 진짜 OAuth·브라우저·토큰 해지 없음.
 *  · `CCG_NO_NET=1` — ccg-auth의 실 HTTP 실행기가 통째로 거절된다.
 *  · 이름 기반 kill 금지 — 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐.
 *  · 앱 홈은 `CCG_HOME`으로 격리(레포 안 `.poc-home-t1t2`). 실홈은 읽지도 않는다.
 *  · 엔진 **설치는 안 한다**(네트워크·수백 MB). 조회·활성·정리까지만.
 *
 * 준비:
 *   cargo build -p ccg-auth --features cli --bin ccg-auth-probe --bin ccg-fake-claude
 *   CARGO_TARGET_DIR=target-t1t2 cargo build --release --features custom-protocol   (src-tauri에서)
 *
 * 실행:
 *   node scripts/poc-t1t2.mjs --exe=target-t1t2/release/AgentCodeGUI3.exe
 *   node scripts/poc-t1t2.mjs --only=t1        # 계정만
 *   node scripts/poc-t1t2.mjs --only=t2        # 엔진만
 *   node scripts/poc-t1t2.mjs --keep           # 격리 홈 보존
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const only = (args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || 'all'
const KEEP = args.includes('--keep')
const EXE = resolveTauriExe((args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1])
const PROBE = path.join(REPO, 'target', 'debug', 'ccg-auth-probe.exe')
const FAKE_CLI = path.join(REPO, 'target', 'debug', 'ccg-fake-claude.exe')
// 다른 갈래(T3T4·M12R2)와 절대 안 겹치게 — 포트·홈 이름에 갈래 이름을 박는다.
const PORT = 9361
const HOME = path.join(REPO, '.poc-home-t1t2')
const OUT = path.join(REPO, 'docs', 'critic', 't1t2-r1.json')

const rep = { at: new Date().toISOString(), exe: EXE, scenarios: {}, findings: [] }
const fail = (id, why, extra) => {
  rep.findings.push({ id, why, ...(extra ?? {}) })
  console.error(`  ✗ ${id} — ${why}`)
}
const ok = (id, v) => console.log(`  ✓ ${id}${v === undefined ? '' : ' — ' + JSON.stringify(v)}`)
const eq = (id, got, want) => {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a === b) ok(id, got)
  else fail(id, `기대 ${b} · 실제 ${a}`)
  return a === b
}

const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* 없음 */ } }
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

/** `ccg_auth::account_slug` 미러 — 폴더 이름은 `<정제>-<utf16 해시 base36>`이다.
 *  단순 치환(`@.` → `_`)으로 짐작하면 **없는 경로를 보고 통과**한다(초판이 그랬다). */
function accountSlug(email) {
  let safe = ''
  let inRun = false
  for (const c of email.toLowerCase()) {
    if (/[a-z0-9._-]/.test(c)) { safe += c; inRun = false }
    else if (!inRun) { safe += '_'; inRun = true }
  }
  let h = 0
  for (let i = 0; i < email.length; i++) h = (Math.imul(h, 31) + email.charCodeAt(i)) >>> 0
  return `${safe}-${h.toString(36)}`
}
const acctDir = (email) => path.join(HOME, 'accounts', accountSlug(email))

// ── 격리 홈 ─────────────────────────────────────────────────────────────────
function seedHome() {
  rmrf(HOME)
  fs.mkdirSync(path.join(HOME, 'work'), { recursive: true })
  fs.writeFileSync(path.join(HOME, 'profile.json'), JSON.stringify({ nickname: 'T1T2', color: '#0EA5E9' }))
  // 엔진 자동 업데이트를 **끈다** — 켜져 있으면 EngineGate가 아예 안 뜬다(EngineGate.tsx:30).
  fs.writeFileSync(path.join(HOME, 'engine-auto-update.json'), JSON.stringify({ enabled: false }))
  fs.writeFileSync(
    path.join(HOME, 'ui-prefs.json'),
    JSON.stringify({ 'workspace.mode': 'single', 'chat.zoom': 1, 'sidebar.autohide': false, 'ui.lang': 'ko', 'whatsnew.seenVersion': '99.0.0' })
  )
  // ★ engines 정션을 **안 만든다** = 엔진이 하나도 없는 홈(= A/B의 `no-engines` 부팅).
  //   Chromium OSCrypt 키를 격리 userData로 옮겨야 합성 계정의 credEnc가 풀린다.
  const ls = path.join(process.env.APPDATA ?? '', 'agent-code-gui', 'Local State')
  if (fs.existsSync(ls)) {
    const ud = path.join(HOME, 'userData')
    fs.mkdirSync(ud, { recursive: true })
    fs.copyFileSync(ls, path.join(ud, 'Local State'))
  }
}

/** 합성 계정 심기 — 토큰은 probe가 이 자리에서 만든 문자열이다(실계정 0건). */
function seedAccounts(emails) {
  const r = spawnSync(PROBE, ['seed', ...emails], { env: { ...process.env, CCG_HOME: HOME, CCG_NO_NET: '1' }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ccg-auth-probe seed 실패: ${r.stderr || r.stdout}`)
}

// ── 앱 기동 ─────────────────────────────────────────────────────────────────
async function boot(extraEnv = {}) {
  const child = spawn(EXE, [], {
    cwd: REPO,
    env: { ...process.env, CCG_HOME: HOME, CCG_CDP_PORT: String(PORT), CCG_NO_NET: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const log = []
  child.stdout.on('data', (b) => log.push(String(b)))
  child.stderr.on('data', (b) => log.push(String(b)))
  // 첫 문서는 셸이 주입한 스플래시라 곧 **네비게이션**이 일어난다 — 그 순간에 붙어 있던
  // 평가는 `Execution context was destroyed`로 죽는다. 붙었다 끊기면 다시 붙는다.
  let cdp = null
  for (let attempt = 0; attempt < 6; attempt++) {
    cdp = await connectMainPage(PORT, { timeoutMs: 45000 })
    try {
      const ready = await cdp.eval(
        `(async()=>{for(let i=0;i<120;i++){if(window.api&&document.querySelector('#root')?.children.length)return 1;await new Promise(r=>setTimeout(r,50))}return 0})()`,
        { awaitPromise: true, timeoutMs: 20000 }
      )
      if (ready) return { child, cdp, log }
    } catch { /* 네비게이션 — 다시 붙는다 */ }
    try { cdp.close() } catch { /* 이미 닫힘 */ }
    await sleep(400)
  }
  throw new Error('앱이 준비되지 않았다(window.api·#root)')
}

const call = (cdp, expr, ms = 40000) =>
  cdp.eval(`(async()=>{try{return {v: await (${expr})}}catch(e){return {err:String(e&&e.message||e)}}})()`, { awaitPromise: true, timeoutMs: ms })

const unwrap = (id, r) => {
  if (!r || r.err) {
    fail(id, `호출 실패: ${r?.err ?? 'no result'}`)
    return null
  }
  return r.v
}

// ── T1: 계정 쓰기 5채널 ─────────────────────────────────────────────────────
async function scenT1() {
  console.log('\n── T1 · 계정 쓰기 5채널 ───────────────────────────────────')
  seedHome()
  const emails = ['a@t1t2.test', 'b@t1t2.test', 'c@t1t2.test']
  seedAccounts(emails)
  const s = (rep.scenarios.t1 = {})

  // 가짜 CLI를 꽂는다 — `auth login/status/logout`이 그리로 간다(실 OAuth 없음).
  const app = await boot({ CCG_CLAUDE_BIN: FAKE_CLI, CCG_FAKE_LOGIN_WAIT_MS: '20000' })
  try {
    const { cdp } = app
    // 로그인 URL 이벤트를 미리 잡아 둔다(auth:login-url — 폴백 링크).
    await cdp.eval(`window.__t1url=null; window.api.auth.onLoginUrl(u=>{window.__t1url=u})`)

    s.list0 = unwrap('t1.list', await call(cdp, `window.api.auth.listAccounts()`))
    eq('t1.list-3', (s.list0 ?? []).map((a) => a.email), emails)
    eq('t1.default-first', (s.list0 ?? []).find((a) => a.isDefault)?.email, emails[0])

    // ① 기본 계정 지정
    s.setDefault = unwrap('t1.set-default', await call(cdp, `window.api.auth.setDefaultAccount(${JSON.stringify(emails[1])})`))
    eq('t1.set-default→배지 이동', (s.setDefault ?? []).find((a) => a.isDefault)?.email, emails[1])
    eq('t1.set-default→디스크', readJson(path.join(HOME, 'accounts.json'))?.defaultEmail, emails[1])

    // ② 순서 변경(꾹-드래그가 저장하는 그 경로)
    const rev = [...emails].reverse()
    s.reorder = unwrap('t1.reorder', await call(cdp, `window.api.auth.reorderAccounts(${JSON.stringify(rev)})`))
    eq('t1.reorder→반환 순서', (s.reorder ?? []).map((a) => a.email), rev)
    eq('t1.reorder→디스크 순서', (readJson(path.join(HOME, 'accounts.json'))?.accounts ?? []).map((a) => a.email), rev)

    // ③ 목록에서만 제거(토큰 해지 없음)
    s.remove = unwrap('t1.remove', await call(cdp, `window.api.auth.removeAccount(${JSON.stringify(emails[2])})`))
    eq('t1.remove→2건', (s.remove ?? []).map((a) => a.email), rev.filter((e) => e !== emails[2]))
    eq('t1.remove→폴더 삭제', fs.existsSync(acctDir(emails[2])), false)

    // ④ 로그아웃 = 해지 시도 + 제거. `CCG_NO_NET=1`이라 **해지는 건너뛴다**(안전핀).
    s.logout = unwrap('t1.logout', await call(cdp, `window.api.auth.logout(${JSON.stringify(emails[1])})`))
    eq('t1.logout→1건', (s.logout ?? []).map((a) => a.email), [emails[0]])
    eq('t1.logout→기본이 남은 계정으로', (s.logout ?? [])[0]?.isDefault, true)
    s.revokeSkipped = !fs.existsSync(path.join(acctDir(emails[1]), '.logout-called'))
    eq('t1.logout→CCG_NO_NET에서 해지 생략', s.revokeSkipped, true)

    // ⑤ 로그인 — URL 방출 → 취소. **실 OAuth 없음**(가짜 CLI가 URL만 뱉고 기다린다).
    const started = Date.now()
    await cdp.eval(`window.__t1login = window.api.auth.login(false)`)
    let url = null
    for (let i = 0; i < 120 && !url; i++) {
      await sleep(100)
      url = await cdp.eval(`window.__t1url`)
    }
    s.loginUrl = url
    s.loginUrlMs = Date.now() - started
    if (url && /^https:\/\//.test(url)) ok('t1.login→auth:login-url 도착', { url, ms: s.loginUrlMs })
    else fail('t1.login→auth:login-url 도착', `URL이 안 왔다(${s.loginUrlMs}ms 대기)`, { url })

    await call(cdp, `window.api.auth.cancelLogin()`)
    s.loginCancelled = unwrap('t1.login-cancel', await call(cdp, `window.__t1login`, 30000))
    eq('t1.login-cancel→ok:false', s.loginCancelled?.ok, false)
    eq('t1.login-cancel→목록 불변', (unwrap('t1.list2', await call(cdp, `window.api.auth.listAccounts()`)) ?? []).length, 1)
    eq('t1.login-cancel→임시 폴더 청소', fs.existsSync(path.join(HOME, 'login')), false)

    // (로그인 **성공** 왕복은 가짜 CLI의 성공 분기가 앱 프로세스의 env라 두 번째 기동에서 — ⑥')
  } finally {
    app.cdp.close()
    killTree(app.child.pid)
    await sleep(600)
  }

  // ⑥' 로그인 성공 분기는 `CCG_FAKE_LOGIN_OK=1`로 앱을 다시 띄워 확인한다.
  const app2 = await boot({ CCG_CLAUDE_BIN: FAKE_CLI, CCG_FAKE_LOGIN_OK: '1', CCG_FAKE_LOGIN_EMAIL: 'new@t1t2.test' })
  try {
    const { cdp } = app2
    const before = unwrap('t1.list-before-login', await call(cdp, `window.api.auth.listAccounts()`)) ?? []
    const t0 = Date.now()
    const r = unwrap('t1.login-success', await call(cdp, `window.api.auth.login(false)`, 60000))
    s.loginSuccess = r
    s.loginSuccessMs = Date.now() - t0
    eq('t1.login-success→ok', r?.ok, true)
    eq('t1.login-success→email', r?.email, 'new@t1t2.test')
    const after = unwrap('t1.list-after-login', await call(cdp, `window.api.auth.listAccounts()`)) ?? []
    s.after = after.map((a) => a.email)
    eq('t1.login-success→목록 편입', after.length, before.length + 1)
    eq('t1.login-success→디스크', (readJson(path.join(HOME, 'accounts.json'))?.accounts ?? []).some((a) => a.email === 'new@t1t2.test'), true)
    eq('t1.login-success→계정 폴더 물질화', fs.existsSync(path.join(acctDir('new@t1t2.test'), '.credentials.json')), true)
    eq('t1.login-success→임시 폴더 청소(평문 토큰 잔류 금지)', fs.existsSync(path.join(HOME, 'login')), false)
    eq('t1.login-success→credEnc 저장', (readJson(path.join(HOME, 'accounts.json'))?.accounts ?? []).find((a) => a.email === 'new@t1t2.test')?.credEnc?.length > 20, true)
  } finally {
    app2.cdp.close()
    killTree(app2.child.pid)
    await sleep(600)
  }

  // ⑦ 로그아웃의 **해지** 반쪽 — 안전핀(`CCG_NO_NET`)을 내리고 확인한다.
  //    해지 명령이 가는 상대는 여전히 **가짜 CLI**라 실토큰은 어디서도 안 죽는다.
  const app3 = await boot({ CCG_CLAUDE_BIN: FAKE_CLI, CCG_NO_NET: '0' })
  try {
    const { cdp } = app3
    const target = 'new@t1t2.test'
    const r = unwrap('t1.logout-revoke', await call(cdp, `window.api.auth.logout(${JSON.stringify(target)})`, 40000))
    s.logoutRevoke = r
    eq('t1.logout-revoke→목록에서 빠짐', (r ?? []).some((a) => a.email === target), false)
    eq('t1.logout-revoke→계정 폴더 삭제', fs.existsSync(acctDir(target)), false)
    // 가짜 CLI가 남긴 표식 = **해지 명령이 실제로 나갔다**. 내용은 그때의 CLAUDE_CONFIG_DIR —
    // 그 경로가 앱 홈 밖이면(=사용자 실홈) 여기서 드러난다.
    const mark = path.join(HOME, '.fake-logout-called')
    s.revokeConfigDir = fs.existsSync(mark) ? fs.readFileSync(mark, 'utf8') : null
    eq('t1.logout-revoke→해지 명령이 나갔다', s.revokeConfigDir != null, true)
    eq('t1.logout-revoke→격리 CONFIG_DIR(앱 홈 안)', (s.revokeConfigDir ?? '').startsWith(path.join(HOME, 'accounts')), true)
  } finally {
    app3.cdp.close()
    killTree(app3.child.pid)
    await sleep(600)
  }
}

// ── T2: 엔진 관리 5채널 + 미설치 안내 게이트 ────────────────────────────────
async function scenT2() {
  console.log('\n── T2 · 엔진 관리 5채널 + 게이트 ─────────────────────────')
  seedHome()
  seedAccounts(['a@t1t2.test'])
  const s = (rep.scenarios.t2 = {})
  // 엔진이 없는 홈 + PATH에 claude 없음 = A/B `engine-gate-prompt`의 그 판.
  const app = await boot({ CCG_CLAUDE_BIN: '' })
  try {
    const { cdp } = app
    s.state = unwrap('t2.state', await call(cdp, `window.api.engine.state()`))
    eq('t2.state→active 없음', s.state?.active, null)
    eq('t2.state→installed 0', (s.state?.installed ?? []).length, 0)

    const t0 = Date.now()
    s.avail = unwrap('t2.list-available', await call(cdp, `window.api.engine.listAvailable()`, 30000))
    s.availMs = Date.now() - t0
    if (s.avail?.latest) ok('t2.list-available→latest', { latest: s.avail.latest, versions: s.avail.versions.length, ms: s.availMs })
    else fail('t2.list-available→latest', `latest가 null이다(${s.avail?.error ?? '사유 없음'})`, { ms: s.availMs })
    eq('t2.list-available→최신 배지', s.avail?.versions?.find((v) => v.latest)?.version, s.avail?.latest)

    // ★ 그 값이 곧 미설치 안내 카드의 조건이다(EngineGate.tsx:32-37).
    for (let i = 0; i < 60; i++) {
      s.gate = await cdp.eval(`(()=>{const e=document.querySelector('.set-dialog-overlay .set-dialog .sd-title');return e?e.textContent:null})()`)
      if (s.gate) break
      await sleep(250)
    }
    if (s.gate) ok('t2.engine-gate-prompt→카드가 떴다', s.gate)
    else fail('t2.engine-gate-prompt→카드가 떴다', '.set-dialog-overlay .set-dialog .sd-title 없음(0/1)')

    // 설치 안 된 버전을 활성화하려 하면 거절(설치 자체는 안 한다 — 네트워크·수백 MB).
    // 렌더러 계약이 `callVoid`라 반환값이 없다 — **디스크의 표식**으로 판정한다.
    await call(cdp, `window.api.engine.setActive('0.0.1-nope')`)
    eq('t2.set-active→미설치 버전 거절(config.json 안 생김)', fs.existsSync(path.join(HOME, 'config.json')), false)
    s.cleanup = unwrap('t2.cleanup', await call(cdp, `window.api.engine.cleanup()`, 30000))
    eq('t2.cleanup→빈 홈에서 removed 0', (s.cleanup?.removed ?? []).length, 0)
    eq('t2.cleanup→kept null', s.cleanup?.kept, null)

    // 심(shim)이 「미구현」으로 갈음한 것이 아니라 **진짜 핸들러**가 답했는지.
    s.warned = await cdp.eval(`(window.__ccgWarned??[]).length`)
    s.codexAvail = unwrap('t2.codex-list-available', await call(cdp, `window.api.codexEngine.listAvailable()`, 30000))
    if (s.codexAvail?.latest) ok('t2.codex 대칭 유지', { latest: s.codexAvail.latest })
    else fail('t2.codex 대칭 유지', `codex latest가 null(${s.codexAvail?.error ?? '사유 없음'})`)
  } finally {
    app.cdp.close()
    killTree(app.child.pid)
    await sleep(600)
  }
}

// ── 주행 ────────────────────────────────────────────────────────────────────
;(async () => {
  for (const f of [PROBE, FAKE_CLI, EXE]) {
    if (!fs.existsSync(f)) throw new Error(`없음: ${f}`)
  }
  console.log(`[poc-t1t2] exe=${EXE}`)
  if (only === 'all' || only === 't1') await scenT1()
  if (only === 'all' || only === 't2') await scenT2()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
  if (!KEEP) rmrf(HOME)
  console.log(`\n[poc-t1t2] 결함 ${rep.findings.length}건 → ${path.relative(REPO, OUT)}`)
  process.exit(rep.findings.length ? 1 : 0)
})().catch((e) => {
  console.error('[poc-t1t2] 치명:', e)
  process.exit(2)
})
