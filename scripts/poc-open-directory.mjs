#!/usr/bin/env node
/* ============================================================================
 * poc-open-directory — **「…으로 열기」가 화면에 착지하는가**(N3 · R28i).
 *
 * 설치기는 HKCU에 우클릭 항목을 쓴다(`nsis/hooks.nsh` → `"<exe>" "%V"`). 3.0은 X를
 * 눌러도 트레이로 숨는 것이 기본이라 **「이미 떠 있다」가 정상 상태**이고, R28h까지
 * 그 상태에서 그 메뉴를 누르면 창만 앞으로 오고 폴더는 **오류도 안내도 없이** 사라졌다
 * (최종 파리티 R5 §9.1 N3 · 높음).
 *
 * 확인 크리틱 R2가 남긴 D1~D3을 닫은 뒤, 그 셋이 **뜬 앱**에서도 사실인지 잰다.
 * 단위 못은 순수 함수를 지키고, 이 하네스는 사용자가 보는 자리를 지킨다.
 *
 *  A 콜드 착지      폴더 인자로 기동 → 활성 채팅 cwd가 그 폴더인가.
 *  B 한 번 쓰고 버림 같은 프로세스에서 `app:get-initial-dir`를 **두 번 더** 부른다.
 *                  2·3회차는 `null`이어야 한다(계약면 주석 "consumed once" · 2.6.2 동작).
 *                  R28i까지는 세 번 다 같은 폴더를 돌려줬고, 그래서 크래시 복구의
 *                  `reload_all()`이 **닫은 카드를 되돌리고** 사용자가 옮겨 놓은 폴더를 덮었다.
 *  C 경로 정규화    `<폴더>\..\<폴더이름>` 으로 기동해도 착지 문자열이 **다듬어진** 값인가
 *                  (2.6.2 `path.resolve` 파리티 — 안 다듬으면 같은 폴더가 두 벌 앉는다).
 *  D 못 여는 폴더    없는 경로로 기동하면 **사유를 말하는가**(조용히 사라지면 실패).
 *  E 웜 인계        떠 있는 앱에 **두 번째 인스턴스**를 폴더 인자로 띄운다 → 그 폴더가
 *                  도착하는가. 그리고 **인자 없는** 두 번째 실행은 아무것도 안 옮기는가
 *                  (R28i 확인 크리틱 R1 D2의 「인계 잔해가 재실행을 납치한다」).
 *
 *   node scripts/poc-open-directory.mjs --exe=… --port=… --out=…json
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · 이름 기반 kill 금지 — 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐이다.
 *  · 앱 홈은 `CCG_HOME`으로 격리하고 실 CLI·실계정을 아예 안 쓴다.
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe, quietHome } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const EXE = resolveTauriExe((args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1])
const TAG = (args.find((a) => a.startsWith('--tag=')) ?? '').split('=')[1] || 'r1'
const PORT = Number((args.find((a) => a.startsWith('--port=')) ?? '').split('=')[1] || 11400)
const KEEP = args.includes('--keep')
const OUT =
  (args.find((a) => a.startsWith('--out=')) ?? '').split('=')[1] ||
  path.join(REPO, 'docs', 'critic', `opendir-screen-${TAG}.json`)

// 앱이 방금 죽은 직후에는 핸들이 남아 EPERM이 난다 — 재시도를 준다.
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 })
const results = []
let failed = 0
function check(id, ok, detail) {
  results.push({ id, ok: !!ok, detail })
  if (!ok) failed++
  console.log(`  ${ok ? '✓' : '✗'} ${id} — ${JSON.stringify(detail)}`)
}

const HOME = path.join(os.tmpdir(), `ccg-opendir-${TAG}-${process.pid}`)
/** 착지 대상 폴더 둘 — 안이 비지 않게 파일을 하나씩 둔다(빈 폴더도 열려야 하지만
 *  「안을 못 본다」와 헷갈리지 않게 내용이 있는 쪽으로 잡는다). */
const PROJ_A = path.join(HOME, 'projA')
const PROJ_B = path.join(HOME, 'projB')
const GONE = path.join(HOME, 'no-such-folder-4b1c')

function seed() {
  rmrf(HOME)
  for (const d of [HOME, PROJ_A, PROJ_B]) fs.mkdirSync(d, { recursive: true })
  // ★부팅 엔진 자동 설치를 끈다 — 안 끄면 이 홈 하나가 CLI ~630MB를 내려받는다
  //   (R28j UPDATER 확인 크리틱 R2: 주행 16개가 ~10GB를 받아 C: 여유가 0이 됐다).
  quietHome(HOME)
  fs.writeFileSync(path.join(PROJ_A, 'a.txt'), 'a')
  fs.writeFileSync(path.join(PROJ_B, 'b.txt'), 'b')
  fs.writeFileSync(path.join(HOME, 'profile.json'), JSON.stringify({ nickname: 'poc' }))
}

async function boot(argv, port) {
  const child = spawn(EXE, argv, {
    env: { ...process.env, CCG_HOME: HOME, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  const cdp = await connectMainPage(port, { timeoutMs: 60_000 })
  let up = false
  for (let i = 0; i < 300; i++) {
    up = await cdp
      .eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true })
      .catch(() => false)
    if (up) break
    await sleep(100)
  }
  const j = async (expr) => JSON.parse(await cdp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
  return { child, cdp, j, up, log: () => log }
}

/** 두 번째 인스턴스 — 단일 인스턴스 관문에 걸려 곧 죽는다(그게 정상이다). */
function secondInstance(argv) {
  const c = spawn(EXE, argv, { env: { ...process.env, CCG_HOME: HOME }, stdio: 'ignore' })
  return c
}

const RAW = (channel, payload = []) =>
  `await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(channel)}, payload: ${JSON.stringify(payload)} })`

/** 활성 채팅의 작업 폴더 — **화면이 그리는 그 자리**를 읽는다.
 *
 *  초판은 `window.api.getChats()`의 `cwd` 칸을 읽으려 했는데 그 모양이 아니어서
 *  **네 칸이 전부 `null`로 나왔다**(= 제품이 멀쩡한데 계기가 거짓 실패를 냈다).
 *  `.chat-head`는 사용자가 실제로 보는 폴더 줄이고, 확인 크리틱들도 이 자리를 썼다. */
const CWD = `(await (async () => {
  const el = document.querySelector('.chat-head')
  const txt = (el && el.innerText || '').trim()
  const line = txt.split('\\n').map((s) => s.trim()).find((s) => /^[a-zA-Z]:\\\\|^\\\\\\\\/.test(s)) || null
  return { cwd: line, head: txt.slice(0, 200) }
})())`

/** 실패 카드가 화면에 있는가.
 *
 *  ★자리로 잡는다(`.fop-modal` = `NoticeModal`이 이 카드에 붙이는 클래스, `App.tsx:2588`).
 *  초판은 문구를 정규식으로 찾았는데 **실제 제목이 「폴더를 열지 못했어요」**라 하나도
 *  안 걸렸고, 제품이 멀쩡한데 계기가 거짓 실패를 냈다. 문구는 i18n이라 바뀔 수 있으니
 *  자리를 1순위로 두고 문구는 참고로만 싣는다. */
const CARD = `(await (async () => {
  const el = document.querySelector('.fop-modal')
  const txt = (el && el.innerText || '').trim()
  return {
    hasCard: !!el,
    text: txt.slice(0, 200),
    saysReason: /못했|없|아니|권한|Couldn't|not|denied|empty/i.test(txt)
  }
})())`

async function main() {
  console.log(`exe: ${EXE}`)
  seed()

  // ── A·B·C — 콜드 기동(정규화가 필요한 형태로 준다) ────────────────────────
  const dotted = path.join(PROJ_A, '..', 'projA')
  console.log(`\n[A·B·C] 콜드 기동 인자 = ${dotted}`)
  let app = await boot([dotted], PORT)
  if (!app.up) {
    killTree(app.child.pid)
    throw new Error('앱이 안 떴다\n' + app.log().slice(-2000))
  }
  await sleep(2500)

  const landed = await app.j(CWD)
  const landedOk = !!landed.cwd && landed.cwd.toLowerCase() === PROJ_A.toLowerCase()
  check('A-콜드 착지', landedOk, { want: PROJ_A, got: landed.cwd, head: landed.head })
  check('C-경로 정규화', !!landed.cwd && !landed.cwd.includes('..'), { got: landed.cwd, note: '2.6.2 path.resolve 파리티' })

  // ★ 렌더러가 이미 1회차를 소비했다(App.tsx의 `initDirApplied`). 여기 둘은 **2·3회차**다.
  //   `landedOk`를 AND로 묶는 이유: 폴더가 애초에 안 왔으면 `null` 둘은 아무것도 안 재는
  //   동어반복이 된다 — 이 라운드가 두 번이나 밟은 헛못 패턴이다.
  const q2 = await app.j(RAW('app:get-initial-dir'))
  const q3 = await app.j(RAW('app:get-initial-dir'))
  check('B-한 번 쓰고 버림', landedOk && q2 === null && q3 === null, {
    landed: landedOk,
    second: q2,
    third: q3,
    note: '계약면 "consumed once" · R28i까지 세 번 다 같은 폴더를 돌려줬다'
  })

  // ── E — 웜 인계: 인자 **없는** 재실행은 아무것도 안 옮긴다 ─────────────────
  const beforeArgless = (await app.j(CWD)).cwd
  secondInstance([])
  await sleep(3000)
  const afterArgless = (await app.j(CWD)).cwd
  check('E1-인자 없는 재실행은 안 옮긴다', beforeArgless === afterArgless, { before: beforeArgless, after: afterArgless })

  // ── E — 웜 인계: 폴더를 든 재실행은 **도착한다** ──────────────────────────
  secondInstance([PROJ_B])
  await sleep(4000)
  const afterHandoff = await app.j(CWD)
  check('E2-폴더를 든 재실행이 도착한다', afterHandoff.cwd && afterHandoff.cwd.toLowerCase() === PROJ_B.toLowerCase(), {
    want: PROJ_B,
    got: afterHandoff.cwd
  })

  killTree(app.child.pid)
  await sleep(1500)

  // ── D — 없는 폴더로 기동하면 사유를 말한다 ────────────────────────────────
  console.log(`\n[D] 없는 폴더로 콜드 기동 = ${GONE}`)
  const app2 = await boot([GONE], PORT + 1)
  if (!app2.up) {
    killTree(app2.child.pid)
    throw new Error('D 팔에서 앱이 안 떴다\n' + app2.log().slice(-2000))
  }
  await sleep(3000)
  const card = await app2.j(CARD)
  const cwd2 = await app2.j(CWD)
  check('D-없는 폴더는 사유를 말한다', card.hasCard && card.saysReason, { ...card, note: '조용히 사라지면 실패' })
  check('D-없는 폴더로 착지하지 않는다', !cwd2.cwd || !cwd2.cwd.includes('no-such-folder'), { got: cwd2.cwd })
  killTree(app2.child.pid)

  const report = {
    at: new Date().toISOString(),
    exe: EXE,
    home: HOME,
    pass: failed === 0,
    failed,
    total: results.length,
    results
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
  console.log(`\n리포트: ${OUT}`)
  console.log(failed === 0 ? `\nPASS — ${results.length} 통과, 0 실패` : `\nFAIL — ${failed} 실패 / ${results.length}`)
  if (!KEEP) rmrf(HOME)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  if (!KEEP) rmrf(HOME)
  process.exit(1)
})
