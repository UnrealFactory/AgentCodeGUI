#!/usr/bin/env node
/**
 * ★LSPIDLE R3 [B급 ①] — **죽을 때 하는 말이 사람 눈에 닿는가**(실화면).
 *
 * ## 크리틱이 판 자리 (확인 크리틱 R2 §4-A)
 *
 * R2는 `lsp:project-status`에 `error` 칸을 더해 「침묵을 닫았다」고 적었다. 크레이트 쪽은
 * 맞았지만 그 말이 **사용자에게 닿지 않았다.** 세 겹이 막고 있었다:
 *
 *   ① 계약 타입에 칸이 없다(`src/shared/protocol.ts` — 동결)
 *   ② 렌더러가 `state`·`percent` 말고는 전부 버린다
 *   ③ **결정적** — 그 세계에서는 아예 안 부른다. 폴링 게이트가
 *      `starting|installing|ready`일 때만 참이라, **서버가 죽어 `error`가 된 바로 그 상황**에서
 *      `projectStatus()`가 한 번도 안 불렸다.
 *
 * 그리고 R2의 증거 표는 PoC 하네스 바이너리에서 뜬 값이지 **화면에서 뜬 값이 아니었다.**
 * 그래서 이 계기는 하네스가 아니라 **실앱 화면**을 본다: 뷰어 머리의 칩을 DOM에서 읽고
 * 스크린샷까지 뜬다.
 *
 * ## 어떻게 죽이나 — 「조각 유실」 세계
 *
 * `NODE_OPTIONS`를 **없는 파일**을 가리키게 해서 앱을 띄운다. 엔진은 자기 프리로드 조각을
 * 그 값 **뒤에** 이어 붙이므로(`launch::node_options_with_preload`), node가 첫 `--require`에서
 * `MODULE_NOT_FOUND`로 즉사한다 — R2가 크레이트 층에서 쓴 것과 **같은 세계**이고,
 * 배포본에서 조각이 빠졌을 때 실제로 나는 모양이다.
 *
 * 두 팔을 돌린다:
 *   - `healthy` — 아무것도 안 건다(음성 대조). 사유 칩이 **뜨면 안 된다**.
 *   - `broken`  — 조각을 유실시킨다. 사유 칩이 **떠야 하고**, 그 안에 모듈 이름이 있어야 한다.
 *
 * ```
 * node scripts/poc-lspidle-r3-reason.mjs --exe <path-to-agentcodegui.exe>
 * ```
 *
 * 규율: `CCG_HOME`은 temp로 격리(실홈 무접촉) · CDP 11086 · 내가 띄운 PID만 트리째 접는다.
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
const WORK = path.join(os.tmpdir(), 'ccg-lspidle-r3-reason-work')
const PORT = 11086
const VERSION = '3.0.0-beta.1'
/** 절대 존재하지 않는 조각. 이 이름이 화면에 그대로 나와야 「말이 맞다」이다. */
const GHOST = 'C:/nope/ccg-lspidle-r3-missing-preload.cjs'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const EXE = flag('exe', '')
const OUT = flag('out', path.join(REPO, 'bench', 'results', 'poc-lspidle-r3-reason.json'))
const SHOT_DIR = flag('shots', path.join(REPO, 'bench', 'results'))

function killTree(pid) {
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 15000 })
  } catch {
    /* 이미 갔다 */
  }
}

function freshHome(tag) {
  const home = path.join(os.tmpdir(), `ccg-lspidle-r3-home-${tag}`)
  fs.rmSync(home, { recursive: true, force: true })
  makeFixtureHome(home, VERSION)
  const f = path.join(home, 'chats', `${FIX_ID}.json`)
  const chat = JSON.parse(fs.readFileSync(f, 'utf8'))
  chat.manualCwd = WORK
  if (chat.snapshot) chat.snapshot.cwd = WORK
  fs.writeFileSync(f, JSON.stringify(chat))
  return home
}

async function arm(name, breakPreload) {
  const home = freshHome(name)
  const profile = tauriProfile({ port: PORT, exe: EXE })
  const child = spawn(profile.cmd, profile.args, {
    env: {
      ...process.env,
      ...profile.env,
      CCG_HOME: home,
      CCG_LSP_MODULES: REPO,
      CCG_LSP_NODE: path.join(REPO, 'src-tauri', 'lsp-runtime', 'node.exe'),
      // ★이 한 줄이 「조각 유실」 세계다. 엔진이 자기 조각을 **뒤에** 이어 붙이므로
      //   node는 첫 --require에서 죽는다.
      ...(breakPreload ? { NODE_OPTIONS: `--require "${GHOST}"` } : {})
    },
    cwd: profile.cwd,
    stdio: 'ignore'
  })
  try {
    const cdp = await connectMainPage(PORT, { timeoutMs: 90000 })
    await cdp.send('Runtime.enable')
    await cdp.eval(HELPERS_JS).catch(() => {})
    const ctx = makeCtx(cdp)
    const t0 = Date.now()
    while (Date.now() - t0 < 90000) {
      if (await cdp.eval(profile.mountExpr).catch(() => false)) break
      await sleep(60)
    }
    await sleep(1200)
    await ctx.openFile('big.ts')

    // 칩이 뜰 때까지 본다. 죽는 세계에서도 status→error→projectStatus 3초 주기를 한두 번
    // 돌아야 하므로 넉넉히 준다(재스폰 쿨다운 30초보다는 짧다).
    let seen = null
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      seen = await cdp.eval(`(() => {
        const err = document.querySelector('.fv-lsp.error')
        const chip = document.querySelector('.fv-lsp')
        return {
          errText: err ? (err.textContent || '').trim() : null,
          errTip: err ? (err.getAttribute('data-tip') || '') : null,
          anyChip: chip ? chip.className + ' :: ' + (chip.textContent || '').trim() : null
        }
      })()`)
      if (seen && seen.errText) break
      await sleep(500)
    }
    // 화면 증거 — 뷰어 머리 근처만 잘라 뜬다(전체 창은 무겁고 볼 것이 적다).
    const shot = path.join(SHOT_DIR, `poc-lspidle-r3-reason-${name}.png`)
    try {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
      if (r?.data) fs.writeFileSync(shot, Buffer.from(r.data, 'base64'))
    } catch {
      /* 스크린샷은 부수 증거다 — 없다고 판정이 바뀌지 않는다 */
    }
    return { arm: name, ...seen, shot: fs.existsSync(shot) ? shot : null }
  } finally {
    killTree(child.pid)
    await sleep(1200)
  }
}

async function main() {
  if (!EXE || !fs.existsSync(EXE)) {
    console.error(`[poc] --exe 가 필요하다(없거나 못 찾음): ${EXE}`)
    process.exit(1)
  }
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })
  FIXTURES.ts.make(WORK, { blocks: 40 })
  console.log(`[poc] 픽스처: ${WORK}\\lspbench\\big.ts`)

  const healthy = await arm('healthy', false)
  console.log(`[poc] healthy  사유칩=${healthy.errText ?? '없음(기대대로)'} · 칩=${healthy.anyChip ?? '없음'}`)
  const broken = await arm('broken', true)
  console.log(`[poc] broken   사유칩=${broken.errText ?? '★없음(닫히지 않았다)'}`)
  if (broken.errTip) console.log(`[poc] broken   툴팁 전문=${broken.errTip}`)

  const namesGhost = !!(broken.errTip || '').includes('missing-preload') || !!(broken.errText || '').includes('missing-preload')
  const evidence = {
    harness: 'poc-lspidle-r3-reason',
    at: new Date().toISOString(),
    exe: EXE,
    measures: '실앱 뷰어 머리의 `.fv-lsp.error` 칩 — 텍스트와 툴팁 전문',
    ghostModule: GHOST,
    healthy,
    broken,
    verdict: {
      chipShownWhenDead: !!broken.errText,
      chipHiddenWhenHealthy: !healthy.errText,
      reasonNamesTheMissingModule: namesGhost
    }
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(evidence, null, 2) + '\n')
  console.log(`\n판정: 죽으면 보인다=${evidence.verdict.chipShownWhenDead} · 멀쩡하면 안 보인다=${evidence.verdict.chipHiddenWhenHealthy} · 모듈 이름을 댄다=${namesGhost}`)
  console.log(`saved: ${OUT}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
