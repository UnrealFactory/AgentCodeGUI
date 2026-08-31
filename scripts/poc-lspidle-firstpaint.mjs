#!/usr/bin/env node
/**
 * ★LSPIDLE R2 PoC ③ — **뷰어가 실제로 색을 칠하기까지**(캐시 미적중, 콜드).
 *
 * ## 왜 `bench/lsp.mjs`로는 이걸 못 재나 (이 라운드가 발견한 것)
 *
 * 확인 크리틱은 R1의 +499ms 중 **기동 몫은 224ms뿐**이고 나머지는 렌더러의 400ms status
 * 폴링 격자라고 짚었다. 그 처방(첫 몇 발만 촘촘한 백오프)을 넣고 `bench/lsp.mjs`로 A/B를
 * 돌렸더니 **두 팔이 구분되지 않았다.** 이유는 계기에 있었다:
 *
 *   `bench/lsp.mjs`의 「prewarm ready」와 「첫 색칠」은 페이지에 심은 **프로브가 자기 손으로**
 *   `lsp.status`(100ms 간격)와 `lsp.semanticTokens`를 부른 값이다. 즉 그 두 눈금은
 *   **`FileModal`의 폴링 격자를 지나가지 않는다.** 렌더러를 고쳐도 움직일 수가 없다.
 *
 * 그런데 사용자가 겪는 경로는 프로브가 아니라 `FileModal`이다: 라이브 토큰 이펙트는
 * `lspStatus !== 'ready'`면 시작조차 안 하고, 그 `ready`를 400ms 격자로 알게 된다.
 * 그래서 **제품 경로를 직접 재는 계기**가 따로 필요하다 — 이 파일이 그것이다.
 *
 * 재는 것: 「탐색기에서 파일을 클릭한 순간」 → 「뷰어 본문에 시맨틱 스팬이 20개 넘게 뜬 순간」.
 * 홈을 매번 지워 **토큰 디스크 캐시를 비우고**(캐시 미적중), 서버는 온디맨드라 그 클릭이
 * 곧 기동의 방아쇠다. 측정 폴링은 25ms라 계기 자신의 격자가 답을 가리지 않는다.
 *
 * 실행:
 *   node scripts/poc-lspidle-firstpaint.mjs --a <exe> --b <exe> [--runs 3]
 *
 * 규율: CCG_HOME은 temp로 격리, CDP는 11084, 내가 띄운 PID만 접는다.
 */

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeFixtureHome, FIX_ID } from '../bench/fixture.mjs'
import { FIXTURES } from '../bench/lspfix.mjs'
import { connectMainPage, tauriProfile, sleep } from '../bench/lib.mjs'
import { makeCtx, HELPERS_JS } from '../bench/screens.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORK = path.join(os.tmpdir(), 'ccg-lspidle-fp-work')
const PORT = 11084
const VERSION = '3.0.0-beta.1'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const RUNS = Number(flag('runs', '3'))
/**
 * 세 팔. `eager`는 **비교용**이지 후보가 아니다 — 프리웜이 기동하던 R1 이전 동작이고,
 * 그 팔의 값이 「온디맨드가 제품 경로에서 실제로 얼마를 무는가」를 말해 준다
 * (`bench/lsp.mjs`의 +499ms는 프로브 경로라 그 답이 아니다 — 파일 머리말 참고).
 * `--c ''`로 끄면 두 팔만 돈다.
 */
const ARMS = Object.fromEntries(
  [
    ['fixed400', flag('a', path.join(os.tmpdir(), 'lspidle-arms', 'fixed400.exe'))],
    ['backoff', flag('b', path.join(os.tmpdir(), 'lspidle-arms', 'backoff.exe'))],
    ['eager', flag('c', path.join(os.tmpdir(), 'lspidle-arms', 'eager.exe'))]
  ].filter(([, p]) => p && fs.existsSync(p))
)

function killTree(pid) {
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 15000 })
  } catch {
    /* 이미 갔다 */
  }
}

/** 캐시가 **비어 있는** 홈을 매번 새로 만든다 — 그래야 「캐시 미적중」이다. */
function freshHome(tag) {
  const home = path.join(os.tmpdir(), `ccg-lspidle-fp-home-${tag}`)
  fs.rmSync(home, { recursive: true, force: true })
  makeFixtureHome(home, VERSION)
  const f = path.join(home, 'chats', `${FIX_ID}.json`)
  const chat = JSON.parse(fs.readFileSync(f, 'utf8'))
  chat.manualCwd = WORK
  if (chat.snapshot) chat.snapshot.cwd = WORK
  fs.writeFileSync(f, JSON.stringify(chat))
  return home
}

async function once(armName, exe, seq) {
  const home = freshHome(`${armName}-${seq}`)
  const profile = tauriProfile({ port: PORT, exe })
  const child = spawn(profile.cmd, profile.args, {
    env: {
      ...process.env,
      ...profile.env,
      CCG_HOME: home,
      // 배포본과 같은 사슬을 쓰도록 못박는다(스냅샷 exe 옆에는 모듈도 런타임도 없다)
      CCG_LSP_MODULES: REPO,
      CCG_LSP_NODE: path.join(REPO, 'src-tauri', 'lsp-runtime', 'node.exe')
    },
    cwd: profile.cwd,
    stdio: 'ignore'
  })
  try {
    const cdp = await connectMainPage(PORT, { timeoutMs: 90000 })
    await cdp.send('Runtime.enable')
    await cdp.eval(HELPERS_JS).catch(() => {})
    const ctx = makeCtx(cdp)
    // 마운트 대기
    const t0 = Date.now()
    while (Date.now() - t0 < 90000) {
      if (await cdp.eval(profile.mountExpr).catch(() => false)) break
      await sleep(60)
    }
    await sleep(1200) // 부팅 잔여 작업이 가라앉게(두 팔에 똑같이 준다)

    // 탐색기를 열고 파일을 **찾아 두는** 데까지는 측정 밖이다.
    //
    // `screens.mjs::openFile`을 그대로 쓰면 그 안의 고정 대기(탐색기 300 + 검색 400 +
    // 모달 700ms)가 측정 구간에 들어와 답을 1.4초쯤 부풀리고 분산도 키운다. 두 팔에 똑같이
    // 실리므로 **차이**는 살아남지만, 「첫 색칠이 몇 ms인가」라는 절댓값이 계기의 sleep이
    // 된다. 그래서 클릭 직전까지를 밖으로 뺀다 — 시계는 **사용자가 누르는 순간**부터다.
    await ctx.openExplorer()
    await ctx.type('.fxs input', 'big.ts')
    await ctx.waitFor('.explorer .fxtree .fxr', 8000)
    await sleep(500) // 검색 결과가 안정될 때까지(측정 밖)

    const openAt = Date.now()
    const clicked = await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('.explorer .fxtree .fxr')]
      const hit = rows.find((r) => (r.textContent || '').includes('big.ts'))
      if (!hit) return false
      hit.click(); return true
    })()`)
    if (!clicked) throw new Error('탐색기 검색 결과에 big.ts가 없다')
    // 시맨틱 스팬이 뜰 때까지 **25ms로** 본다(계기의 격자가 답을 가리지 않게).
    const sel = '.fv-body [class*="sem-"]'
    let paintMs = null
    let spans = 0
    while (Date.now() - openAt < 60000) {
      spans = await cdp.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`).catch(() => 0)
      if (spans > 20) {
        paintMs = Date.now() - openAt
        break
      }
      await sleep(25)
    }
    return { arm: armName, seq, paintMs, spans }
  } finally {
    killTree(child.pid)
    await sleep(1200)
  }
}

const median = (a) => {
  const b = a.filter((x) => x != null).sort((x, y) => x - y)
  return b.length ? b[Math.floor(b.length / 2)] : null
}

async function main() {
  for (const [name, exe] of Object.entries(ARMS)) {
    if (!fs.existsSync(exe)) {
      console.error(`[poc] 팔 '${name}'의 exe가 없다: ${exe}`)
      process.exit(1)
    }
  }
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })
  FIXTURES.ts.make(WORK, { blocks: 420 })
  // `openFile('big.ts')`가 탐색기 검색으로 찾는 그 파일이다
  console.log(`[poc] 픽스처: ${WORK}\\lspbench\\big.ts`)

  const rows = []
  // **교차 주행** — 기계 상태가 한쪽 팔에만 실리지 않게
  for (let i = 1; i <= RUNS; i++) {
    for (const [name, exe] of Object.entries(ARMS)) {
      const r = await once(name, exe, i)
      rows.push(r)
      console.log(`[poc] ${name.padEnd(9)} #${i}  첫 색칠 ${r.paintMs ?? '실패'}ms (스팬 ${r.spans})`)
    }
  }

  const byArm = {}
  for (const name of Object.keys(ARMS)) {
    const v = rows.filter((r) => r.arm === name).map((r) => r.paintMs)
    byArm[name] = { runs: v, median: median(v) }
  }
  const a = byArm.fixed400?.median
  const b = byArm.backoff?.median
  const c = byArm.eager?.median
  const out = {
    harness: 'poc-lspidle-firstpaint',
    at: new Date().toISOString(),
    measures: '탐색기 클릭 → 뷰어 시맨틱 스팬>20 (캐시 미적중 · 온디맨드 기동 포함)',
    note: 'bench/lsp.mjs의 「첫 색칠」은 프로브가 직접 부른 값이라 FileModal 폴링 격자를 안 지난다 — 그래서 이 계기가 따로 있다',
    runs: RUNS,
    arms: byArm,
    // 되찾은 값 = 폴링 격자 개선분. 남은 값 = 온디맨드가 제품 경로에서 무는 진짜 비용.
    recoveredByBackoffMs: a != null && b != null ? a - b : null,
    remainingOnDemandCostMs: b != null && c != null ? b - c : null,
    rows
  }
  fs.writeFileSync(path.join(REPO, 'bench', 'results', 'poc-lspidle-firstpaint.json'), JSON.stringify(out, null, 2) + '\n')
  console.log('')
  for (const [n, v] of Object.entries(byArm)) console.log(`[poc] ${n.padEnd(9)} 중앙값 ${v.median}ms   (${v.runs.join(", ")})`)
  console.log(`[poc] 폴링 격자로 되찾은 시간: ${out.recoveredByBackoffMs}ms`)
  if (out.remainingOnDemandCostMs != null)
    console.log(`[poc] 온디맨드가 남긴 비용  : ${out.remainingOnDemandCostMs}ms (eager 대비 · 음수면 온디맨드가 더 빠르다)`)
  fs.rmSync(WORK, { recursive: true, force: true })
}

main().catch((e) => {
  console.error('[poc] 실패:', e.message)
  process.exit(1)
})
