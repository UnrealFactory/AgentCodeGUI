#!/usr/bin/env node
/* ============================================================================
 * poc-claude-path — ★R28d 「EXTN」 수정 R1. **claude 실행 파일을 어디서 찾는가**가
 * 게이트와 스폰에서 같은 답인가를 잰다. `poc-codex-path`의 클로드 축 짝이다.
 *
 * EXTN 확인 크리틱 R1 §2.1이 판 구멍:
 *
 *   > 게이트 `claude_exe()` = `resolve_bin(claude_bin())`은 **PATH만** 훑는데, 턴 스폰은
 *   > `hub.rs cli_path()` → `driver.rs Command::new(&spec.cli)`라 Rust std/CreateProcess
 *   > 순서대로 **실행 파일이 있는 폴더**를 PATH보다 먼저 본다. 그 한 칸 차이에서
 *   > 게이트는 "없다", 스폰은 "있다"가 되고 — 그 판의 **로그아웃은 토큰 해지를 조용히
 *   > 건너뛴다**(`ipc/accounts.rs`의 해지 갈래가 `claude_exe()`에 매달려 있다).
 *
 * 팔의 차이는 **「claude.exe가 어디 있나」 하나뿐**이다. 세 팔 다 앱 exe를 복사한 폴더에서
 * 띄우고 `CCG_CLAUDE_BIN`(하네스 우회로)은 지운다 = 진짜 폴백 사슬(`claude.exe`)을 밟는다.
 *
 *   X 실행 파일 옆   복사한 앱 exe 폴더에 claude.exe 동거 · PATH에는 claude 없음
 *                    → 세 얼굴이 **다 돌아야** 한다(이 라운드가 닫은 구멍)
 *   P 전역 PATH      claude.exe가 PATH 앞칸에만 (이 컴퓨터의 인구: ~/.local/bin/claude.exe)
 *                    → X와 같은 답 = 무회귀
 *   N 아무 데도      어디에도 없음 → **전부 막혀야** 한다(옛 계약 · 반대 방향의 거짓 금지)
 *
 * 세 얼굴 = 로그인(문구 · `auth:login-url`) · **로그아웃(토큰 해지 호출)** · AI 커밋 메시지.
 * 대조군(구멍이 살아 있는 exe)에서는 **X팔만** 빨갛다 — 그게 판별력의 증거다.
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · 실계정 0건 — 계정은 `ccg-auth-probe seed`가 만든 합성이고 CLI는 `ccg-fake-claude`다.
 *  · 이름 기반 kill 금지 — 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐.
 *  · 해지 갈래를 재야 하므로 `CCG_NO_NET`을 **끈다**. 대신 `HTTPS_PROXY=http://127.0.0.1:9`로
 *    밖으로 나가는 길을 막는다 → 실 HTTP 0건 · 토큰 회전 0.
 *  · 앱 홈·작업 폴더는 전부 `%TEMP%\ccg-claude-path-<tag>` — 레포와 실홈은 읽기만 한다.
 *
 * 준비:
 *   cargo build -p ccg-auth --features cli --bin ccg-auth-probe --bin ccg-fake-claude
 *   (src-tauri) cargo build --release --features custom-protocol
 *
 * 실행:
 *   node scripts/poc-claude-path.mjs --exe=<릴리스 exe> [--tag=fix] [--only=x,p,n]
 *        [--fake=…] [--probe=…] [--port=9741] [--out=…] [--keep]
 * ========================================================================== */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const argOf = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a === undefined ? d : a.slice(k.length + 3) }
const KEEP = args.includes('--keep')
const EXE = resolveTauriExe(argOf('exe', ''))
const TAG = argOf('tag', 'r1')
const ONLY = argOf('only', 'x,p,n').split(',').map((s) => s.trim()).filter(Boolean)
const FAKE = path.resolve(argOf('fake', path.join(REPO, 'target', 'debug', 'ccg-fake-claude.exe')))
const PROBE = path.resolve(argOf('probe', path.join(REPO, 'target', 'debug', 'ccg-auth-probe.exe')))
const OUT = path.resolve(argOf('out', path.join(REPO, 'docs', 'critic', `claude-path-${TAG}.json`)))
// 포트·작업 폴더에 태그를 박는다 — 세 갈래가 같은 워킹트리에서 동시에 돈다.
const PORT = Number(argOf('port', '9741'))
const WORK = path.resolve(argOf('work', path.join(os.tmpdir(), `ccg-claude-path-${TAG}`)))
const EMAIL = `seed-${TAG}@claudepath.test`

const rep = { at: new Date().toISOString(), tag: TAG, exe: EXE, arms: {}, findings: [] }
const fail = (id, why, extra) => { rep.findings.push({ id, why, ...(extra ?? {}) }); console.error(`  x ${id} — ${why}`) }
const ok = (id, v) => console.log(`  o ${id}${v === undefined ? '' : ' — ' + JSON.stringify(v)}`)
const eq = (id, got, want) => {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  if (a === b) ok(id, got)
  else fail(id, `기대 ${b} · 실제 ${a}`)
  return a === b
}
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* 없음 */ } }

/** claude로 **해석되는 칸만** 걷어낸다 — PATH를 통째로 비우면 git·npm이 같이 죽는다
 *  (`engine/versions.rs`의 테스트 `path_without_claude`와 같은 규칙). */
function pathWithoutClaude() {
  const exts = (process.env.PATHEXT ?? '').split(';').map((s) => s.trim()).filter((s) => s.startsWith('.')).concat([''])
  return (process.env.PATH ?? '')
    .split(';')
    .filter(Boolean)
    .filter((d) => !exts.some((e) => { try { return fs.statSync(path.join(d, `claude${e}`)).isFile() } catch { return false } }))
    .join(';')
}

function seedHome(home) {
  rmrf(home)
  fs.mkdirSync(path.join(home, 'work'), { recursive: true })
  fs.writeFileSync(path.join(home, 'profile.json'), JSON.stringify({ nickname: 'CLAUDEPATH', color: '#0EA5E9' }))
  // 엔진 자동 업데이트를 끈다 — 켜져 있으면 부팅 직후 다른 왕복이 낀다.
  fs.writeFileSync(path.join(home, 'engine-auto-update.json'), JSON.stringify({ enabled: false }))
  fs.writeFileSync(
    path.join(home, 'ui-prefs.json'),
    JSON.stringify({ 'workspace.mode': 'single', 'chat.zoom': 1, 'sidebar.autohide': false, 'ui.lang': 'ko', 'whatsnew.seenVersion': '99.0.0' })
  )
  // safeStorage 키는 **userData별**이다 — 합성 계정의 credEnc를 풀려면 그 키를 옮겨 와야
  // 하고, 그래야 로그아웃이 계정 폴더를 물질화해 해지 명령까지 간다(poc-t1t2와 같은 규약).
  const ls = path.join(process.env.APPDATA ?? '', 'agent-code-gui', 'Local State')
  if (fs.existsSync(ls)) {
    fs.mkdirSync(path.join(home, 'userData'), { recursive: true })
    fs.copyFileSync(ls, path.join(home, 'userData', 'Local State'))
  }
  const r = spawnSync(PROBE, ['seed', EMAIL], { env: { ...process.env, CCG_HOME: home, CCG_NO_NET: '1' }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ccg-auth-probe seed 실패: ${r.stderr || r.stdout}`)
}

/** AI 커밋 메시지는 「Git 저장소가 아니에요」로 **먼저** 죽는다 — 진짜 저장소를 하나 만든다. */
function seedRepo(dir) {
  rmrf(dir)
  fs.mkdirSync(dir, { recursive: true })
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 'x@claudepath.test')
  git('config', 'user.name', 'claudepath')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'seed')
  fs.appendFileSync(path.join(dir, 'a.txt'), 'more\n')
  return dir
}

async function boot(exe, home, env) {
  const child = spawn(exe, [], {
    cwd: REPO,
    env: { ...env, CCG_HOME: home, CCG_CDP_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const log = []
  child.stdout.on('data', (b) => log.push(String(b)))
  child.stderr.on('data', (b) => log.push(String(b)))
  // 첫 문서는 셸이 주입한 스플래시라 곧 네비게이션이 일어난다 — 끊기면 다시 붙는다.
  let cdp = null
  for (let attempt = 0; attempt < 6; attempt++) {
    cdp = await connectMainPage(PORT, { timeoutMs: 45000 })
    try {
      const ready = await cdp.eval(
        `(async()=>{for(let i=0;i<160;i++){if(window.api&&document.querySelector('#root')?.children.length)return 1;await new Promise(r=>setTimeout(r,50))}return 0})()`,
        { awaitPromise: true, timeoutMs: 25000 }
      )
      if (ready) return { child, cdp, log }
    } catch { /* 네비게이션 — 다시 붙는다 */ }
    try { cdp.close() } catch { /* 이미 닫힘 */ }
    await sleep(400)
  }
  killTree(child.pid)
  throw new Error('앱이 준비되지 않았다(window.api·#root)')
}

const call = (cdp, expr, ms = 40000) =>
  cdp.eval(`(async()=>{try{return {v: await (${expr})}}catch(e){return {err:String(e&&e.message||e)}}})()`, { awaitPromise: true, timeoutMs: ms })
const unwrap = (id, r) => { if (!r || r.err) { fail(id, `호출 실패: ${r?.err ?? 'no result'}`); return null } return r.v }

/** 팔 하나. `where` = 가짜 claude.exe를 어디에 두는가('exe' · 'path' · 'none'). */
async function arm(id, where) {
  console.log(`\n── 팔 ${id.toUpperCase()} · claude.exe = ${where} ───────────────────────`)
  const base = path.join(WORK, id)
  const home = path.join(base, 'home')
  const exeDir = path.join(base, 'app')
  const binDir = path.join(base, 'bin')
  const repoDir = path.join(base, 'repo')
  rmrf(base)
  fs.mkdirSync(exeDir, { recursive: true })
  fs.mkdirSync(binDir, { recursive: true })
  // 앱 exe는 **언제나 복사본**으로 띄운다 — 세 팔의 차이가 「옆에 무엇이 있나」 하나뿐이게.
  const exe = path.join(exeDir, path.basename(EXE))
  fs.copyFileSync(EXE, exe)
  fs.utimesSync(exe, new Date(), new Date()) // copyFileSync는 mtime을 보존한다(옛 함정)
  if (where === 'exe') fs.copyFileSync(FAKE, path.join(exeDir, 'claude.exe'))
  if (where === 'path') fs.copyFileSync(FAKE, path.join(binDir, 'claude.exe'))
  seedHome(home)
  seedRepo(repoDir)

  const env = { ...process.env }
  delete env.CCG_CLAUDE_BIN // 하네스 우회로 없음 = 진짜 폴백 사슬(claude.exe)
  env.PATH = (where === 'path' ? binDir + ';' : '') + pathWithoutClaude()
  env.CCG_NO_NET = '0' // 해지 갈래를 재야 한다(밖으로 나가는 길은 프록시로 막았다)
  env.HTTPS_PROXY = 'http://127.0.0.1:9'
  env.HTTP_PROXY = 'http://127.0.0.1:9'
  env.CCG_FAKE_LOGIN_WAIT_MS = '20000'

  const a = (rep.arms[id] = { where, exeDir, pathHead: env.PATH.split(';')[0] })
  const app = await boot(exe, home, env)
  try {
    const { cdp } = app
    // ① 로그인 — 문구와 `auth:login-url` 도착(폴백 링크)
    await cdp.eval(`window.__u=null; window.api.auth.onLoginUrl(u=>{window.__u=u})`)
    await cdp.eval(`window.__login = window.api.auth.login(false)`)
    let url = null
    for (let i = 0; i < 100 && !url; i++) { await sleep(100); url = await cdp.eval(`window.__u`) }
    a.loginUrl = url
    await call(cdp, `window.api.auth.cancelLogin()`, 20000)
    const lr = unwrap(`${id}.login`, await call(cdp, `window.__login`, 40000))
    a.loginError = lr?.error ?? null
    a.loginNoBin = (lr?.error ?? '').includes('실행 파일을 찾지 못했')

    // ② AI 커밋 메시지 — 「설치된 엔진이 없어요」 게이트에 막히는가
    const am = unwrap(`${id}.aimsg`, await call(cdp, `window.api.git.aiMessage(${JSON.stringify(repoDir)}, ['a.txt'], {})`, 60000))
    a.aimsgError = am?.error ?? null
    a.aimsgBlocked = (am?.error ?? '').includes('설치된 엔진이 없어요')

    // ③ 로그아웃 — **토큰 해지 호출이 진짜 나갔는가**(가짜 CLI가 표식을 남긴다)
    const mark = path.join(home, '.fake-logout-called')
    const before = fs.existsSync(mark)
    const lo = unwrap(`${id}.logout`, await call(cdp, `window.api.auth.logout(${JSON.stringify(EMAIL)})`, 60000))
    a.logoutList = (lo ?? []).map((x) => x.email)
    a.logoutCalled = !before && fs.existsSync(mark)
    // 표식의 내용 = 그때의 CLAUDE_CONFIG_DIR. 실홈을 향했으면 여기서 드러난다.
    a.logoutWith = a.logoutCalled ? fs.readFileSync(mark, 'utf8') : null
  } finally {
    try { app.cdp.close() } catch { /* 이미 닫힘 */ }
    killTree(app.child.pid)
    await sleep(700)
  }

  if (id === 'n') {
    eq('n.login→「찾지 못했어요」', a.loginNoBin, true)
    eq('n.aimsg→엔진 없음에 막힘', a.aimsgBlocked, true)
    eq('n.logout→해지 호출 0회', a.logoutCalled, false)
  } else {
    eq(`${id}.login→NO_BIN 아님`, a.loginNoBin, false)
    eq(`${id}.login→login-url 도착`, /^https:\/\//.test(a.loginUrl ?? ''), true)
    eq(`${id}.aimsg→엔진 게이트 통과`, a.aimsgBlocked, false)
    eq(`${id}.logout→★토큰 해지 호출이 나갔다`, a.logoutCalled, true)
    const acct = path.join(home, 'accounts')
    eq(`${id}.logout→격리 계정 폴더로`, (a.logoutWith ?? '').replace(/\//g, '\\').startsWith(acct.replace(/\//g, '\\')), true)
  }
  eq(`${id}.logout→목록에서 빠짐`, (a.logoutList ?? []).includes(EMAIL), false)
}

const ARMS = { x: 'exe', p: 'path', n: 'none' }
;(async () => {
  if (!fs.existsSync(EXE)) throw new Error(`exe가 없다: ${EXE}`)
  for (const bin of [FAKE, PROBE]) {
    if (!fs.existsSync(bin)) throw new Error(`하네스 바이너리가 없다: ${bin}\n  cargo build -p ccg-auth --features cli --bin ccg-auth-probe --bin ccg-fake-claude`)
  }
  console.log(`exe  = ${EXE}\nwork = ${WORK}`)
  for (const id of ONLY) {
    if (!ARMS[id]) throw new Error(`모르는 팔: ${id}(x·p·n)`)
    await arm(id, ARMS[id])
  }
  rep.pass = rep.findings.length === 0
  // ★ 이 라운드의 헤드라인 한 줄 — 실행 파일 옆에만 CLI가 있는 판에서 해지가 나갔는가.
  rep.headline = { armX_logoutCalled: rep.arms.x?.logoutCalled ?? null, armX_loginNoBin: rep.arms.x?.loginNoBin ?? null }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
  if (!KEEP) rmrf(WORK)
  console.log(`\n${rep.pass ? `PASS ${ONLY.length}팔` : `FAIL ${rep.findings.length}`} · ${OUT}`)
  process.exit(rep.pass ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(2) })
