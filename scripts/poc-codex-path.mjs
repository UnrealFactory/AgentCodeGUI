#!/usr/bin/env node
/* ============================================================================
 * poc-codex-path — ★R28c 「CPATH」. **전역 PATH로 codex를 쓰는 사용자**에게 한도
 * 재검증이 도는가를 잰다.
 *
 * R28b CRIT 확인 크리틱 R1 §3이 판 구멍(`bench/scratch/critr1b-codexpath.mjs`의 승격본):
 *
 *   > `codex_limit::can_ask()`의 첫 줄이 `codex_bin().is_file()`인데 `codex_bin()`은
 *   > 활성 설치본이 없으면 **맨 이름 `codex`**(= "PATH에서 찾아라")를 돌려준다. 턴을 띄우는
 *   > `hub.rs`와 계정 조회 `parity/codex.rs`에는 그 검사가 없어서 **턴은 돌고 한도만
 *   > `Unknown`**(= 물어볼 창구가 없다 = 옛 계약 = 눈감고 발사)이 된다.
 *
 * 크리틱의 A/B는 「이 컴퓨터에 전역 codex가 깔려 있다」에 기댔다(`where codex` →
 * `AppData\Roaming\npm\codex.cmd`). 승격본은 그 기대를 **씨앗으로 옮긴다** — 팔마다
 * PATH를 직접 세운다. 그래야 어느 컴퓨터에서 돌려도 같은 답이 나온다.
 *
 *   A · 전역 PATH   CCG_CODEX_BIN=codex + PATH 앞에 실물 `codex.exe`(가짜 app-server 사본)
 *                   → **안 쏴야 한다**(unavailable = 물어봤는데 못 얻었다 → 대기표 유지)
 *   E · 확장자 붙은 맨 이름  CCG_CODEX_BIN=codex.exe + **A와 똑같은 PATH**(실물 이름이
 *                   원래부터 `codex.exe`다) → A와 같은 답이어야 한다.
 *                   ★R28d EXTN — R28c CPATH 확인 크리틱 R1 §4가 판 팔이다. A팔의 철자만
 *                   `codex` → `codex.exe`로 바꿨더니 `resolve_bin`이 `codex.exe.COM`·
 *                   `codex.exe.EXE`만 뒤지고 정작 `codex.exe`를 안 봐서 그 라운드가 지운
 *                   사고가 되살아났다(`unknown:1 · t=90초 발사 · 표 소멸`). 크리틱의 말:
 *                   *"팔 하나를 더 두면 이 라운드가 세운 규칙이 코드와 어긋나는 순간
 *                   빨개진다 — 지금은 안 빨개진다."* 이 팔이 그 못이다.
 *                   **클로드 축이 여기 매달려 있다**: 클로드의 PATH 폴백 철자는 `claude.exe`다.
 *   B · 앱 설치본   CCG_CODEX_BIN=<ccg-fakecodex.exe>(절대 경로)
 *                   → 안 쏴야 한다(R28b에도 초록이던 대조군)
 *   C · 아무 데도    CCG_CODEX_BIN=codex + PATH에서 codex를 **걷어낸다**
 *                   → **쏴야 한다**(unknown = 창구가 진짜 없다 = 옛 계약). 이 팔이 빨강이면
 *                     A의 초록은 "전부 unavailable로 만들어" 얻은 가짜 초록이다.
 *   D · 진짜 전역    우회로도 가짜도 없다(CCG_CODEX_BIN 미설정 · PATH 그대로) — 이 컴퓨터에
 *                   전역 codex가 있을 때만 돈다. A와 같은 답이어야 크리틱이 지목한 인구가
 *                   **씨앗 없이도** 덮인다. (판정 계수는 재확인 사다리가 닿는 t≈90초에
 *                   처음 움직인다 — 첫 주행에서 20초만 보다가 `asks=0`으로 헛다리를 짚었다.)
 *
 * 세 팔의 나머지 씨앗은 완전히 같다: 클로드 계정 1 + **등록된 codex 계정 1** +
 * Codex 채팅 1 + 리셋이 2시간 전인 대기표 + 자동 재개 ON + `CCG_NO_NET=1`.
 *
 * 대조군(구멍이 살아 있는 exe)에서는 A1·A2가 빨강이어야 한다 — 판별력의 증거다:
 *   node scripts/poc-codex-path.mjs --exe=<옛 exe> --out=<레포 밖>
 *
 * ── 안전 규칙 ───────────────────────────────────────────────────────────────
 *  · 실계정 0건(합성) · `CCG_NO_NET=1`이라 HTTP 0건 = 토큰 회전 0.
 *  · **사용자의 실 codex는 한 번도 안 뜬다** — A팔이 PATH에서 찾는 것은 우리가 방금
 *    격리 홈에 놓은 가짜다(그리고 `CCG_NO_NET=1`이라 한도 조회는 스폰조차 안 한다).
 *  · 이름 기반 kill 금지 — 죽이는 것은 spawn한 PID 트리뿐.
 *
 *   node scripts/poc-codex-path.mjs [--exe=…] [--fakecodex=…] [--watch=120] [--out=…] [--keep]
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const argOf = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? '').split('=')[1] || d
const KEEP = args.includes('--keep')
const EXE = argOf('exe', path.join(REPO, 'target-cpath', 'release', 'agentcodegui.exe'))
const FAKECODEX = argOf('fakecodex', path.join(REPO, 'target-cpath', 'release', 'ccg-fakecodex.exe'))
const OUT = argOf('out', path.join(REPO, 'docs', 'critic', 'codex-path-cpath-r1.json'))
const PORT = Number(argOf('port', 9471))
const WATCH_S = Number(argOf('watch', 120))
// 격리 홈은 **이름을 바꿀 수 있어야** 한다 — 세 갈래가 같은 워킹트리에서 동시에 돌 때
// 같은 폴더를 파면 서로의 씨앗을 지운다(R28d EXTN에서 실제로 겹칠 뻔했다).
const HOME = path.join(REPO, argOf('home', '.poc-home-cpath'))
// 팔 고르기 — 대조군은 「고친 축」 하나만 돌리면 되고(11분 → 2분), 그동안 다른 팔의
// 기준 값을 헛되이 다시 굽지 않는다. `--only=e` · `--only=a,c` · 기본 `all`.
const ONLY = argOf('only', 'all')
const want = (id) => ONLY === 'all' || ONLY.split(',').map((x) => x.trim().toLowerCase()).includes(id)
const EMAIL = 'codexpath@cpath.test'
const CODEX_EMAIL = 'openai-user@cpath.test'
const CHAT = 'c-codexpath'

const rep = { at: new Date().toISOString(), exe: EXE, watchSec: WATCH_S, arms: {}, findings: [] }
let pass = 0
const ok = (id, detail) => {
  pass++
  console.log(`  ✓ ${id}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
}
const fail = (id, why, extra) => {
  rep.findings.push({ id, why, ...(extra ?? {}) })
  console.error(`  ✗ ${id} — ${why}${extra ? ` ${JSON.stringify(extra)}` : ''}`)
}
const check = (id, cond, why, extra) => (cond ? ok(id, extra) : fail(id, why, extra))

const rmrf = (p) => {
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
      return
    } catch {
      spawnSync('cmd', ['/c', 'ping', '127.0.0.1', '-n', '2'], { stdio: 'ignore' })
    }
  }
}
const write = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2))
}
/** `ccg_store::account_slug`와 같은 규칙(소문자 · 안전문자 · djb2 비슷한 31승 해시). */
function accountSlug(email) {
  const safe = email.toLowerCase().replace(/[^a-z0-9._-]+/g, '_')
  let h = 0
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0
  return `${safe}-${h.toString(36)}`
}

/** PATH에서 codex로 **해석되는** 항목을 걷어낸다(C팔). 나머지 항목은 손대지 않는다. */
function pathWithoutCodex() {
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e.startsWith('.'))
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((d) => d && !exts.some((e) => fs.existsSync(path.join(d, `codex${e}`))))
    .join(path.delimiter)
}

/** 진단용(판정에는 안 쓴다) — 이 컴퓨터가 크리틱이 말한 그 인구인가. */
function whereCodex() {
  const r = spawnSync('where', ['codex'], { encoding: 'utf8' })
  return (r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean)
}

function seedHome() {
  rmrf(HOME)
  const work = path.join(HOME, 'work')
  fs.mkdirSync(work, { recursive: true })
  write(path.join(HOME, 'accounts.json'), {
    version: 3,
    defaultEmail: EMAIL,
    accounts: [{ email: EMAIL, subscriptionType: 'max' }]
  })
  write(path.join(HOME, 'accounts', accountSlug(EMAIL), '.credentials.json'), {
    claudeAiOauth: { accessToken: 'A-cpath', expiresAt: Date.now() + 3600_000, scopes: ['user:inference'] }
  })
  // ★ 이 판의 핵심 씨앗 — codex 계정이 **등록돼 있다**(`email`은 평문 필드다: `codex::email_of`).
  write(path.join(HOME, 'codex-accounts.json'), {
    version: 1,
    defaultEmail: CODEX_EMAIL,
    accounts: [{ email: CODEX_EMAIL, plan: 'plus', authEnc: 'ZmFrZQ==' }]
  })
  write(path.join(HOME, 'fakecodex.jsonl'), JSON.stringify({ await: 'initialize', result: { userAgent: 'fake' } }))
  // A팔이 PATH에서 찾을 실물. **사용자의 실 codex가 아니라 우리 가짜의 사본**이다.
  const shim = path.join(HOME, 'pathshim')
  fs.mkdirSync(shim, { recursive: true })
  fs.copyFileSync(FAKECODEX, path.join(shim, process.platform === 'win32' ? 'codex.exe' : 'codex'))
  const resetsAt = Math.floor(Date.now() / 1000) - 7200
  write(path.join(HOME, 'chats-v3', 'index.json'), { version: 1, order: [CHAT], activeChatId: CHAT })
  write(path.join(HOME, 'chats-v3', `${CHAT}.json`), {
    id: CHAT,
    title: 'Codex 한도 대기표(전역 PATH)',
    identity: {
      engine: { kind: 'codex', model: 'gpt-5.6-codex', effort: 'medium', codexAccount: null },
      billing: { kind: 'subscription', account: EMAIL, dropEnvKey: false },
      cwd: work,
      addDirs: [],
      mode: 'auto',
      systemPrompt: null,
      outputStyle: null,
      tools: { skillOverrides: {}, deniedMcp: [] }
    },
    hold: { resetsAt, ready: false },
    draft: '',
    draftImages: [],
    updatedAt: Date.now(),
    snapshot: { messages: [], session: 'T0' }
  })
  write(path.join(HOME, 'ui-prefs.json'), { 'limitResume.on': true })
  return shim
}

const IPC = (channel, payload = []) =>
  `await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(channel)}, payload: ${JSON.stringify(payload)} })`

/** 팔 하나 — 씨앗을 새로 깔고 앱을 띄워 `watch`초(또는 발사까지) 지켜본다. */
async function arm(label, { codexBin, pathEnv, watch = WATCH_S }) {
  const shim = seedHome()
  const env = {
    ...process.env,
    PATH: typeof pathEnv === 'function' ? pathEnv(shim) : pathEnv,
    CCG_HOME: HOME,
    CCG_CDP_PORT: String(PORT),
    CCG_NO_NET: '1',
    CCG_CODEX_BIN: codexBin,
    CCG_FAKECODEX_SCRIPT: path.join(HOME, 'fakecodex.jsonl'),
    CCG_FAKECODEX_IN: path.join(HOME, 'codex-stdin.log'),
    CCG_NO_BOOT_ENGINE_UPDATE: '1'
  }
  // `codexBin: null` = 우회로를 **아예 안 꽂는다**(= 앱이 진짜 폴백 사슬을 탄다 — D팔).
  if (codexBin == null) delete env.CCG_CODEX_BIN
  const child = spawn(EXE, [], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  const samples = []
  const cdp = await connectMainPage(PORT, { timeoutMs: 60_000 })
  try {
    for (let i = 0; i < 400; i++) {
      const up = await cdp
        .eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, {
          awaitPromise: true
        })
        .catch(() => false)
      if (up) break
      await sleep(100)
    }
    const j = async (expr) =>
      JSON.parse(await cdp.eval(`(async () => JSON.stringify(await (${expr})) ?? 'null')()`, { awaitPromise: true }))
    // 채팅 목록을 한 번 읽어 엔진에 대기표를 재장전시킨다(부팅 라이트 페이로드).
    await j(IPC('chats:get', [{ light: true }])).catch(() => null)
    await sleep(2500)
    const t0 = Date.now()
    while ((Date.now() - t0) / 1000 < watch) {
      await sleep(5000)
      const dbg = await j(IPC('engine:debug')).catch(() => null)
      const row = (dbg?.chats ?? []).find((c) => c.chatId === CHAT) ?? null
      const s = {
        t: Math.round((Date.now() - t0) / 1000),
        spawns: row?.spawns ?? -1,
        hold: row?.hold ?? null,
        probe: dbg?.limitProbe ?? null
      }
      samples.push(s)
      process.stdout.write(
        `   [${label}] t=${String(s.t).padStart(3)}s spawns=${s.spawns} hold=${s.hold ? 'yes' : 'no'} ` +
          `asks=${s.probe?.asks ?? '-'} unknown=${s.probe?.unknown ?? '-'} ` +
          `unavailable=${s.probe?.unavailable ?? '-'} blocked=${s.probe?.blocked ?? '-'}\n`
      )
      if (s.spawns > 0) break // 발사했다 — 더 볼 것이 없다
    }
  } finally {
    try {
      cdp.close?.()
    } catch {
      /* ignore */
    }
    killTree(child.pid)
    await sleep(700)
  }
  const last = samples[samples.length - 1] ?? {}
  const out = {
    label,
    codexBin: codexBin ?? '(우회로 없음 — 앱의 폴백 사슬)',
    watchSec: watch,
    fired: samples.some((s) => s.spawns > 0),
    firedAt: samples.find((s) => s.spawns > 0)?.t ?? null,
    finalProbe: last.probe ?? null,
    holdAlive: !!last.hold,
    samples,
    tailLog: log.slice(-1200)
  }
  if (!KEEP) rmrf(HOME)
  return out
}

async function main() {
  for (const p of [EXE, FAKECODEX]) if (!fs.existsSync(p)) throw new Error(`없다: ${p} (cargo build 먼저)`)
  rep.machine = { whereCodex: whereCodex() }
  console.log(`exe: ${EXE}`)
  console.log(`이 컴퓨터의 전역 codex: ${rep.machine.whereCodex.join(' · ') || '(없음 — 판정과 무관하다)'}\n`)

  if (want('a')) {
    console.log('A. 전역 PATH 판 — CCG_CODEX_BIN=codex · PATH 앞에 실물 codex')
    rep.arms.pathCodex = await arm('A/PATH', {
      codexBin: 'codex',
      pathEnv: (shim) => `${shim}${path.delimiter}${process.env.PATH ?? ''}`
    })
    await sleep(1500)
  }
  if (want('b')) {
    console.log('\nB. 앱 설치본 판 — CCG_CODEX_BIN=<실물 파일>')
    rep.arms.appManaged = await arm('B/APP', { codexBin: FAKECODEX, pathEnv: pathWithoutCodex() })
    await sleep(1500)
  }
  if (want('c')) {
    console.log('\nC. 아무 데도 없는 판 — CCG_CODEX_BIN=codex · PATH에서 codex를 걷어냈다')
    rep.arms.nowhere = await arm('C/NONE', { codexBin: 'codex', pathEnv: pathWithoutCodex() })
    await sleep(1500)
  }
  // ★R28d EXTN — A와 씨앗이 **글자 하나만** 다르다(`codex` → `codex.exe`). PATH 앞칸에
  // 놓이는 실물 파일 이름이 원래부터 `codex.exe`이므로 「PATH에서 찾을 수 있어야 정상」인 판이다.
  if (want('e')) {
    console.log('\nE. 확장자 붙은 맨 이름 — CCG_CODEX_BIN=codex.exe · PATH는 A팔과 동일')
    rep.arms.extName = await arm('E/EXT', {
      codexBin: process.platform === 'win32' ? 'codex.exe' : 'codex',
      pathEnv: (shim) => `${shim}${path.delimiter}${process.env.PATH ?? ''}`
    })
  }

  // D. **이 컴퓨터의 진짜 전역 codex.** 우회로도 가짜도 없다 — 크리틱이 말한 그 인구를
  //    그대로 태운다. 고쳐진 판에서는 t≈90초의 재확인이 `unavailable`로 착지해 **발사하지
  //    않으므로** 사용자의 실 codex 프로세스는 뜨지 않는다(A팔이 그 사실을 먼저 잠근다).
  if (want('d') && rep.machine.whereCodex.length) {
    console.log('\nD. 이 컴퓨터의 진짜 전역 codex — 우회로 없음 · PATH 그대로')
    rep.arms.realGlobal = await arm('D/REAL', { codexBin: null, pathEnv: process.env.PATH })
  } else {
    console.log(
      want('d')
        ? '\nD. 건너뜀 — 이 컴퓨터에는 전역 codex가 없다(A팔이 그 인구를 씨앗으로 재현한다)'
        : `\nD. 건너뜀 — --only=${ONLY}가 안 골랐다`
    )
    rep.arms.realGlobal = null
  }

  const a = rep.arms.pathCodex
  const b = rep.arms.appManaged
  const c = rep.arms.nowhere
  const e = rep.arms.extName
  const d = rep.arms.realGlobal
  console.log('\n판정 — 전역 PATH codex도 「물어볼 창구」인가')
  if (a) {
    check('A1 ★★ 전역 PATH 판이 발사하지 않았다', !a.fired, `t=${a.firedAt}초에 쐈다 = 한도를 안 묻고 발사했다`, {
      firedAt: a.firedAt,
      probe: a.finalProbe
    })
    check(
      'A2 ★★ 「물어봤는데 못 얻었다」로 판정했다(unavailable)',
      (a.finalProbe?.unavailable ?? 0) > 0 && (a.finalProbe?.unknown ?? 0) === 0,
      `unknown=${a.finalProbe?.unknown} unavailable=${a.finalProbe?.unavailable} — unknown이면 창구가 없다고 본 것이다`,
      { probe: a.finalProbe }
    )
    check('A3 ★ 대기표가 살아 있다', a.holdAlive, '표가 사라졌다 = 재검증 없이 풀렸다', { hold: a.holdAlive })
  }
  if (b) {
    check('B1 앱 설치본 판은 그대로 안 쏜다', !b.fired, `t=${b.firedAt}초에 쐈다`, { probe: b.finalProbe })
    check('B2 앱 설치본 판도 unavailable이다', (b.finalProbe?.unavailable ?? 0) > 0, JSON.stringify(b.finalProbe), {
      probe: b.finalProbe
    })
  }
  if (c) {
    check(
      'C1 ★ 창구가 진짜 없으면 옛 계약대로 발사한다',
      c.fired && (c.finalProbe?.unknown ?? 0) > 0,
      `fired=${c.fired} unknown=${c.finalProbe?.unknown} — 이 팔이 빨강이면 A의 초록은 가짜다(전부 unavailable)`,
      { firedAt: c.firedAt, probe: c.finalProbe }
    )
  }
  check(
    'C2 클로드 창으로 「막혔다」 판정을 한 팔이 없다',
    [a, b, c, e, d].filter(Boolean).every((x) => (x.finalProbe?.blocked ?? 0) === 0),
    '엔진 축이 클로드 창을 봤다',
    { blocked: [a, b, c, e, d].map((x) => x?.finalProbe?.blocked ?? null) }
  )
  // ★R28d EXTN — 철자 하나로 규칙이 갈리면 안 된다. E팔은 A팔과 **같은 값**이어야 한다.
  if (e) {
    check('E1 ★★ 확장자 붙은 맨 이름도 창구다(발사하지 않았다)', !e.fired, `t=${e.firedAt}초에 쐈다`, {
      firedAt: e.firedAt,
      probe: e.finalProbe
    })
    check(
      'E2 ★★ unavailable로 판정했다(unknown 0)',
      (e.finalProbe?.unavailable ?? 0) > 0 && (e.finalProbe?.unknown ?? 0) === 0,
      `unknown=${e.finalProbe?.unknown} unavailable=${e.finalProbe?.unavailable}` +
        ' — `codex.exe`를 PATH에서 못 찾았다(= 클로드의 claude.exe도 못 찾는다)',
      { probe: e.finalProbe }
    )
    check('E3 ★ 대기표가 살아 있다', e.holdAlive, '표가 사라졌다 = 재검증 없이 풀렸다', { hold: e.holdAlive })
  }
  if (d) {
    check(
      'D1 ★★ 이 컴퓨터의 **진짜** 전역 codex도 창구다',
      (d.finalProbe?.asks ?? 0) > 0 && (d.finalProbe?.unavailable ?? 0) > 0 && (d.finalProbe?.unknown ?? 0) === 0,
      `asks=${d.finalProbe?.asks} unknown=${d.finalProbe?.unknown} unavailable=${d.finalProbe?.unavailable}` +
        ' — 우회로 없이도 같은 답이 나와야 크리틱이 지목한 인구가 덮인다',
      { probe: d.finalProbe, whereCodex: rep.machine.whereCodex }
    )
    check('D2 ★ 그래서 발사도 안 했다(사용자의 실 codex 프로세스 0개)', !d.fired, `t=${d.firedAt}초에 쐈다`, {
      firedAt: d.firedAt
    })
  }

  const holed = (x) => !!x && (x.finalProbe?.unknown ?? 0) > 0 && x.fired
  rep.verdict = {
    only: ONLY,
    'A.fired': a?.fired ?? null,
    'A.unknown': a?.finalProbe?.unknown ?? null,
    'A.unavailable': a?.finalProbe?.unavailable ?? null,
    'B.fired': b?.fired ?? null,
    'C.fired': c?.fired ?? null,
    'C.unknown': c?.finalProbe?.unknown ?? null,
    'E.fired': e?.fired ?? null,
    'E.unknown': e?.finalProbe?.unknown ?? null,
    'E.unavailable': e?.finalProbe?.unavailable ?? null,
    'D.unknown': d?.finalProbe?.unknown ?? null,
    'D.unavailable': d?.finalProbe?.unavailable ?? null,
    // 크리틱의 `hole:true`가 뒤집혔는가 — A(또는 E)가 unknown으로 발사하면 구멍이 살아 있다.
    hole: holed(a) || holed(e)
  }
  rep.pass = pass
  rep.fail = rep.findings.length
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
  console.log(`\n판정: ${JSON.stringify(rep.verdict)}`)
  console.log(`${rep.findings.length === 0 ? 'PASS' : 'FAIL'} — ${pass} 통과, ${rep.findings.length} 실패`)
  console.log(`리포트: ${OUT}`)
  process.exit(rep.findings.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('치명:', e)
  process.exit(2)
})
