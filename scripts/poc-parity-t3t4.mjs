#!/usr/bin/env node
/* ============================================================================
 * poc-parity-t3t4 — 최종 파리티 감사 R1의 **T3T4 갈래**를 실물로 잰다.
 *
 * 재는 것(전부 관측만 적는다. 주장은 안 적는다):
 *   T3  한도 조회      `usage:get` · `auth:accounts-usage` 가 **실값**을 내는가
 *                      + ★한도 자동 이어서의 2단 재검증이 「풀렸다」로 오판하던
 *                        조건(창 넷이 전부 null)이 사라졌는가
 *   T4  /btw 포크 창   `btw:open` → 창이 뜨고 · 시드가 hydrate로 내려가고
 *                      (읽으면 소비) · 닫으면 목록 줄이 `shown:false`(=알약이 뜬다)
 *   H5  닫기 flush     `session-wins:flush-request` 방출자 존재 + CloseRequested 악수
 *   H1  첨부 picker    컴포저 「＋」 **3표면**에서 네이티브 대화상자가 뜨는가
 *   H2  MCP·스킬       스크래치 프로젝트의 `.mcp.json`·`.claude/skills`를 세는가
 *   H4  Codex 모델     `codex:models`
 *   M1  Ctrl+W         주입 스크립트 → `shortcut:close` 왕복
 *   M3  API 설정 점프   `ui:open-api-settings` → `ui:api-settings-requested`
 *   M2  초기 폴더      argv 폴더 → `app:get-initial-dir`
 *
 * ── 안전 규칙 (사용자 실앱이 떠 있다) ───────────────────────────────────────
 *  · **이름 기반 kill 금지.** 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐이다.
 *  · 앱 홈은 `CCG_HOME`으로 격리한다(레포 안 `.poc-home-t3t4`).
 *  · ★**실계정 토큰 회전을 유발하지 않는다.** 자격증명은 **복사**하고, 복사 전에
 *    액세스 토큰의 남은 수명을 확인해 **살아 있을 때만** 실 HTTP를 켠다
 *    (`net::access_token`은 로컬 우선이라 살아 있으면 리프레시 교환이 안 돈다).
 *    남은 수명이 짧으면 그 계정은 아예 안 싣는다 = 실앱 토큰 되싱크 0.
 *  · 네이티브 대화상자는 **우리 PID의 `#32770` 최상위 창에만** WM_CLOSE를 보낸다.
 *
 *   node scripts/poc-parity-t3t4.mjs              # 전부(실 HTTP 포함)
 *   node scripts/poc-parity-t3t4.mjs --no-live    # 실 HTTP 없이(구조만)
 *   node scripts/poc-parity-t3t4.mjs --exe=…      # 고정 바이너리
 * ========================================================================== */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, cdpTargets, Cdp, killTree, sleep, REPO } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const NO_LIVE = args.includes('--no-live')
const KEEP = args.includes('--keep')
const only = (args.find((a) => a.startsWith('--only=')) ?? '').split('=')[1] || 'all'
const want = (id) => only === 'all' || only.split(',').includes(id)

// 갈래 이름을 홈·포트·산출물에 박는다(다른 갈래와 안 겹치게 — 병렬 규율 9).
const HOME = path.join(REPO, '.poc-home-t3t4')
const PORT = 9421
const SCRATCH = path.join(REPO, '.poc-scratch-t3t4')
// ★기준 결과 파일을 덮지 않는다(병렬 규율 6). 라운드마다 `--out=`으로 새 파일에 쓴다 —
// R1 주행의 산출물(`parity-t3t4-r1.json`)은 크리틱이 읽는 기준이라 불변이어야 한다.
const OUT = path.resolve(
  REPO,
  (args.find((a) => a.startsWith('--out=')) ?? '').split('=')[1] || 'docs/critic/parity-t3t4-r1.json'
)
const EXE =
  (args.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1] ||
  path.join(REPO, 'target-t3t4', 'release', 'agentcodegui.exe')

const REAL_HOME = path.join(os.homedir(), '.agentcodegui')
/** 액세스 토큰이 이만큼은 남아 있어야 싣는다 — 리프레시 교환이 돌 여지를 없앤다. */
const TOKEN_MARGIN_MS = 20 * 60 * 1000

const rep = { at: new Date().toISOString(), exe: EXE, live: !NO_LIVE, steps: {}, findings: [] }
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

// ── 격리 홈 준비 ────────────────────────────────────────────────────────────
/** 실홈에서 **읽기만** 한다. 자격증명은 복사(정션 금지 — 쓰기가 실홈에 닿으면 안 된다). */
function seedHome() {
  rmrf(HOME)
  fs.mkdirSync(path.join(HOME, 'accounts'), { recursive: true })
  const live = []
  if (NO_LIVE) return live
  let store
  try {
    store = JSON.parse(fs.readFileSync(path.join(REAL_HOME, 'accounts.json'), 'utf8'))
  } catch {
    return live
  }
  const dirs = fs.existsSync(path.join(REAL_HOME, 'accounts')) ? fs.readdirSync(path.join(REAL_HOME, 'accounts')) : []
  const keep = []
  for (const a of store.accounts ?? []) {
    const slug = dirs.find((d) => d.startsWith(String(a.email).replace(/[@]/g, '_').replace(/[^A-Za-z0-9._-]/g, '_')))
    if (!slug) continue
    const src = path.join(REAL_HOME, 'accounts', slug, '.credentials.json')
    let expiresAt = 0
    try {
      expiresAt = JSON.parse(fs.readFileSync(src, 'utf8')).claudeAiOauth?.expiresAt ?? 0
    } catch {
      continue
    }
    // ★토큰 회전 방지 — 만료가 가까운 계정은 아예 안 싣는다(리프레시가 돌 여지 0).
    if (expiresAt - Date.now() < TOKEN_MARGIN_MS) continue
    fs.mkdirSync(path.join(HOME, 'accounts', slug), { recursive: true })
    fs.copyFileSync(src, path.join(HOME, 'accounts', slug, '.credentials.json'))
    keep.push(a)
    live.push({ email: a.email, aliveMin: Math.round((expiresAt - Date.now()) / 60000) })
  }
  if (keep.length) {
    const def = keep.some((k) => k.email === store.defaultEmail) ? store.defaultEmail : keep[0].email
    fs.writeFileSync(
      path.join(HOME, 'accounts.json'),
      JSON.stringify({ version: 3, accounts: keep, defaultEmail: def })
    )
  }
  return live
}

/** MCP·스킬 실측용 스크래치 프로젝트(감사가 쓴 것과 같은 모양). */
function seedScratch() {
  rmrf(SCRATCH)
  const sk = path.join(SCRATCH, '.claude', 'skills', 'bench-skill')
  fs.mkdirSync(sk, { recursive: true })
  fs.writeFileSync(
    path.join(SCRATCH, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'bench-mcp': { command: 'node', args: ['stub.js'] } } }, null, 2)
  )
  fs.writeFileSync(
    path.join(sk, 'SKILL.md'),
    '---\nname: bench-skill\ndescription: 파리티 실측용 스킬\n---\n본문\n'
  )
}

// ── 네이티브 대화상자 (우리 PID의 #32770만) ─────────────────────────────────
// `EnumWindows`로 훑는다. `FindWindowEx(IntPtr.Zero, prev, "#32770", null)` 사슬은
// PowerShell에서 첫 바퀴부터 0을 물고 와 **언제나 0건**이었다(첫 주행의 거짓 실패).
// 제품 쪽 `close_orphan_dialogs`는 Rust에서 그 사슬을 쓰고 거기서는 돈다 — 여기서
// 굳이 같은 수법을 흉내 낼 이유가 없으므로 관측이 확실한 쪽으로 바꾼다.
const PS_DIALOG = `
Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;using System.Text;
public class T3T4{
 public delegate bool EnumProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
}
"@
$target=[int]$env:T3T4_PID
$doClose=$env:T3T4_CLOSE -eq "1"
$script:n=0
$cb=[T3T4+EnumProc]{ param($h,$l)
  $p=0
  [void][T3T4]::GetWindowThreadProcessId($h,[ref]$p)
  if($p -eq $target -and [T3T4]::IsWindowVisible($h)){
    $c=New-Object System.Text.StringBuilder 256
    [void][T3T4]::GetClassName($h,$c,256)
    if($c.ToString() -eq "#32770"){
      $script:n++
      if($doClose){ [void][T3T4]::PostMessage($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) }
    }
  }
  return $true }
[void][T3T4]::EnumWindows($cb,[IntPtr]::Zero)
Write-Output $script:n
`
function countDialogs(pid, close = false) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_DIALOG], {
    env: { ...process.env, T3T4_PID: String(pid), T3T4_CLOSE: close ? '1' : '0' },
    encoding: 'utf8'
  })
  return Number.parseInt((r.stdout ?? '').trim(), 10) || 0
}
async function waitDialog(pid, ms = 6000) {
  const t0 = Date.now()
  for (;;) {
    if (countDialogs(pid) > 0) return true
    if (Date.now() - t0 > ms) return false
    await sleep(200)
  }
}

// ── 부팅 ────────────────────────────────────────────────────────────────────
async function boot(extraArgv = []) {
  if (!fs.existsSync(EXE)) throw new Error(`빌드된 exe가 없다: ${EXE}\n  cargo build --release --features custom-protocol`)
  const child = spawn(EXE, extraArgv, {
    cwd: REPO,
    env: { ...process.env, CCG_HOME: HOME, CCG_CDP_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  const cdp = await connectMainPage(PORT, { timeoutMs: 60_000 })
  for (let i = 0; i < 400; i++) {
    const up = await cdp
      .eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, {
        awaitPromise: true
      })
      .catch(() => false)
    if (up) break
    await sleep(100)
  }
  // `await`를 빠뜨리면 `JSON.stringify(Promise)`가 `{}`가 되어 **모든 단언이 조용히
  // 거짓**이 된다(이 하네스가 첫 주행에서 밟은 함정 — 값이 없는 게 아니라 안 기다렸다).
  const j = async (expr, page = cdp) =>
    JSON.parse(await page.eval(`(async () => JSON.stringify(await (${expr})) ?? 'null')()`, { awaitPromise: true }))
  return { child, cdp, j, log: () => log }
}
/** 계약면 밖의 채널을 직접 부르는 식(withGlobalTauri=false라 내부 브리지를 쓴다). */
const IPC = (channel, payload = []) =>
  `await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(channel)}, payload: ${JSON.stringify(payload)} })`

const unimplemented = (v) => !!v && typeof v === 'object' && v.__unimplemented === true

async function main() {
  const liveAccounts = seedHome()
  seedScratch()
  rep.steps.seed = { accounts: liveAccounts.length, live: liveAccounts, scratch: SCRATCH }
  console.log(`홈: ${HOME}  계정 ${liveAccounts.length}개(토큰 살아 있는 것만)`)

  // M2는 argv에 폴더를 실어 띄워야 잰다 — 첫 부팅에 함께 건다.
  const app = await boot([SCRATCH])
  const pid = app.child.pid
  try {
    // ── M2. 초기 폴더 ────────────────────────────────────────────────────
    if (want('m2')) {
      console.log('\nM2. app:get-initial-dir')
      const dir = await app.j(`window.api.app.getInitialDirectory()`)
      rep.steps.m2 = { argv: SCRATCH, got: dir }
      check(
        'M2 argv 폴더가 초기 폴더로 내려온다',
        typeof dir === 'string' && dir.replace(/\\/g, '/').toLowerCase() === SCRATCH.replace(/\\/g, '/').toLowerCase(),
        `기대 ${SCRATCH} · 실제 ${JSON.stringify(dir)}`,
        { got: dir }
      )
    }

    // ── T3. 한도 조회 ────────────────────────────────────────────────────
    if (want('t3')) {
      console.log('\nT3. usage:get · auth:accounts-usage')
      const t0 = Date.now()
      const usage = await app.j(`window.api.getUsage(true)`)
      const ms = Date.now() - t0
      const wins = ['fiveHour', 'weekly', 'weeklyFable', 'extraCredit']
      const live = wins.filter((k) => usage && usage[k])
      rep.steps.t3 = { usage, ms, liveWindows: live }
      check('T3-1 usage:get이 미구현이 아니다', !unimplemented(usage), '심 안전값이 그대로 왔다', { usage })
      if (!NO_LIVE && liveAccounts.length) {
        check('T3-2 창 넷이 전부 null이 아니다 (실값)', live.length > 0, '전부 null — 게이지는 여전히 「데이터 없음」', { usage })
        // ★한도 자동 이어서의 2단 재검증(`useLimitResume.ts:144` → `limitResume.ts:62-71`)
        //   그쪽 판정은 창이 전부 없으면 `!w` continue로 "막는 창 없음"에 착지한다.
        //   여기서 같은 규칙을 그대로 돌려 **오판 조건이 사라졌는지**만 본다.
        const verdict = wins
          .map((k) => usage?.[k])
          .filter((w) => w && typeof w.resetsAt === 'number' && w.pct >= 100)
          .map((w) => w.resetsAt)
        rep.steps.t3.blockedResetsAtInputs = wins.map((k) => (usage?.[k] ? { k, pct: usage[k].pct, resetsAt: usage[k].resetsAt } : { k, w: null }))
        rep.steps.t3.wouldBeBlocked = verdict.length ? Math.max(...verdict) : null
        check(
          'T3-3 재검증이 판정 근거를 갖는다(창 객체가 실제로 실린다)',
          live.length > 0 && live.every((k) => typeof usage[k].pct === 'number'),
          '창은 있는데 pct가 없다 — blockedResetsAt이 여전히 못 센다',
          { windows: rep.steps.t3.blockedResetsAtInputs }
        )
        const accts = await app.j(`window.api.auth.accountsUsage()`)
        rep.steps.t3.accounts = accts
        check('T3-4 auth:accounts-usage가 계정 수만큼 돌려준다', Array.isArray(accts) && accts.length === liveAccounts.length, `기대 ${liveAccounts.length} · 실제 ${Array.isArray(accts) ? accts.length : accts}`, { n: Array.isArray(accts) ? accts.length : null })
        // 계약면은 **평평한** `AccountUsage`다(`protocol.ts:753` — `fiveHourPct`…).
        // 설정 ▸ Account의 「한도 적게 남은순」이 정확히 이 세 필드로 정렬한다
        // (`Settings.tsx:318` `[fiveHourPct, fablePct, weeklyPct]`).
        const withData = (accts ?? []).filter(
          (a) => a && [a.fiveHourPct, a.weeklyPct, a.fablePct].some((x) => typeof x === 'number')
        )
        check('T3-5 정렬 근거가 되는 세 필드가 실값이다', withData.length === (accts ?? []).length && withData.length > 0, `실값 행 ${withData.length}/${(accts ?? []).length} — 빈 행이면 「한도 적게 남은순」이 근거 없이 돈다`, { withData: withData.length, of: (accts ?? []).length })
        const sortable = withData.map((a) => ({ email: a.email, left: Math.min(...[a.fiveHourPct, a.fablePct, a.weeklyPct].filter((x) => x != null).map((p) => 100 - p)) }))
        rep.steps.t3.sortKey = sortable
        check('T3-6 계정마다 「남은 %」가 갈린다(정렬이 의미를 갖는다)', new Set(sortable.map((s) => s.left)).size > 1, `전부 같은 값: ${JSON.stringify(sortable)}`, { sortable })
        // TTL — 두 번째 호출은 캐시라 훨씬 빨라야 한다(전역 1200ms 게이트를 안 탄다).
        const t1 = Date.now()
        await app.j(`window.api.getUsage(false)`)
        const ms2 = Date.now() - t1
        rep.steps.t3.msFirst = ms
        rep.steps.t3.msCached = ms2
        check('T3-7 두 번째 조회는 캐시(첫 조회보다 빠르다)', ms2 < Math.max(ms, 200), `첫 ${ms}ms · 두 번째 ${ms2}ms`, { ms, ms2 })
      } else {
        console.log('  (실 HTTP 생략 — --no-live 또는 살아 있는 계정 없음)')
      }
    }

    // ── T4. /btw 포크 질문 창 ────────────────────────────────────────────
    if (want('t4')) {
      console.log('\nT4. btw:open')
      // **추가 채팅 창만** 센다. 창 전체를 세면 턴이 실패할 때 뜨는 알림 토스트 창까지
      // 딸려 들어와 "창이 둘 늘었다"로 읽힌다(첫 주행의 거짓 실패: 1→3 = main+session+toast).
      const sessionWins = (dbg) => (dbg?.windows ?? []).filter((l) => /^session-/.test(l))
      const before = await app.j(IPC('win:surface-debug'))
      const winsBefore = sessionWins(before).length
      await app.j(
        IPC('btw:open', [
          {
            origin: 'chat-origin-1',
            originTitle: 'BTW - 원본 제목',
            cwd: SCRATCH,
            refDirs: [SCRATCH],
            picker: { engine: 'claude', model: 'sonnet' },
            fork: 'ses-fork-1',
            forkCwd: SCRATCH,
            prompt: '이 함수 왜 이렇게 짰어?'
          }
        ])
      )
      await sleep(1800)
      const after = await app.j(IPC('win:surface-debug'))
      const winsAfter = sessionWins(after).length
      rep.steps.t4 = { winsBefore, winsAfter, windows: after?.windows }
      check('T4-1 추가 채팅 창이 하나 늘었다', winsAfter === winsBefore + 1, `${winsBefore} → ${winsAfter} (전체: ${JSON.stringify(after?.windows)})`, { winsBefore, winsAfter })

      const list = await app.j(`window.api.sessionWindows.list()`)
      const row = (list ?? []).find((w) => w.btwOf === 'chat-origin-1')
      rep.steps.t4.listRow = row ?? null
      check('T4-2 목록에 btwOf가 실린다(알약이 붙을 원본 간선)', !!row, '목록에 btwOf가 없다 — 어느 화면도 알약을 못 그린다', { row })
      check('T4-3 접두가 한 번만 남는다', row?.title === 'BTW - 원본 제목', `제목: ${JSON.stringify(row?.title)}`, { title: row?.title })
      check('T4-4 창이 떠 있는 동안은 shown:true(알약은 숨는다)', row?.shown === true, `shown=${row?.shown}`, { shown: row?.shown })

      // 그 창의 페이지에서 hydrate를 받아 시드를 확인한다(읽으면 소비까지).
      const targets = (await cdpTargets(PORT)).filter((t) => t.type === 'page' && /#session/.test(t.url))
      rep.steps.t4.sessionPages = targets.length
      if (targets.length) {
        const page = await Cdp.connect(targets[targets.length - 1].webSocketDebuggerUrl, { timeoutMs: 8000 })
        const h1 = await app.j(IPC('session-wins:hydrate', [{}]), page)
        const h2 = await app.j(IPC('session-wins:hydrate', [{}]), page)
        rep.steps.t4.hydrate = { first: h1, second: h2 }
        check('T4-5 포크 시드가 hydrate로 내려간다', h1?.btwFork === 'ses-fork-1', `btwFork=${JSON.stringify(h1?.btwFork)} — 없으면 첫 실행이 새 대화가 된다`, { h1 })
        check('T4-6 btw 창 정체(btw:true)와 폴더 가드(btwForkCwd)', h1?.btw === true && typeof h1?.btwForkCwd === 'string', `btw=${h1?.btw} cwd=${JSON.stringify(h1?.btwForkCwd)}`, { btw: h1?.btw })
        // ★시드가 **엔진까지** 갔는가 — 첫 실행이 `--resume <시드>`로 나갔다는 증거를
        //   스레드에서 직접 읽는다. 합성 시드('ses-fork-1')는 UUID가 아니라 CLI가
        //   거절하는데, **그 거절문이 시드를 인용한다** = 포크 인자가 실제로 실렸다.
        //   (진짜 세션 id로 재려면 턴을 한 번 돌려야 하고, 그건 이 계정 한도로 불가능하다.)
        const texts = (h1?.snapshot?.messages ?? []).map((m) => String(m?.text ?? '')).join('\n')
        rep.steps.t4.resumeEcho = /ses-fork-1/.test(texts)
        check(
          'T4-6b 첫 실행이 시드를 resume 대상으로 들고 나갔다(엔진 응답이 시드를 인용)',
          /ses-fork-1/.test(texts),
          '시드가 실행에 안 실렸다 — 포크가 아니라 새 대화로 나간 것',
          { echo: texts.slice(0, 160) }
        )
        // ★인라인 질문은 이 시점에 **이미 소비돼 있다** — 창이 뜨자마자 자기 hydrate로
        //   읽어 자동 전송했기 때문이다(그게 이 기능의 계약이다). 그래서 여기서 재는 것은
        //   "내려왔는가"가 아니라 **한 번만 내려왔는가**다: 스냅샷에 그 질문이 사용자
        //   말풍선으로 서 있고, 레코드에는 더 이상 남아 있지 않다(재열람 시 자동 재전송 0).
        const msgs = h1?.snapshot?.messages ?? []
        const asked = msgs.filter((m) => m?.role === 'user' && m?.text === '이 함수 왜 이렇게 짰어?')
        rep.steps.t4.autoSent = asked.length
        check('T4-7 인라인 질문이 창에서 자동 전송됐다', asked.length === 1, `사용자 말풍선 ${asked.length}개 — 0이면 질문이 사라졌고, 2 이상이면 중복 전송이다`, { asked: asked.length })
        check('T4-8 그리고 레코드에서 소비됐다(재열람 자동 재전송 0)', h1?.btwPrompt === undefined && h2?.btwPrompt === undefined, `1차=${JSON.stringify(h1?.btwPrompt)} 2차=${JSON.stringify(h2?.btwPrompt)}`, { first: h1?.btwPrompt, second: h2?.btwPrompt })
        check('T4-8b 시드는 소비되지 않는다(창이 폴더 가드로 접는다)', h2?.btwFork === 'ses-fork-1', `2차 btwFork=${JSON.stringify(h2?.btwFork)}`, {})
        page.close?.()
      } else {
        fail('T4-5..8 btw 창의 페이지를 못 찾았다', 'CDP 타깃에 #session 페이지가 없다')
      }

      // 닫으면 → 알약이 뜨는 조건(open:false · shown:false)
      if (row) {
        await app.j(IPC('win:chat-close', [{ chatId: row.id }]))
        await sleep(2200)
        const list2 = await app.j(`window.api.sessionWindows.list()`)
        const row2 = (list2 ?? []).find((w) => w.id === row.id)
        rep.steps.t4.afterClose = row2 ?? null
        check('T4-9 닫아도 목록에 남는다(대화가 사라지지 않는다)', !!row2, '닫으니 목록에서 사라졌다 = 알약도 없다', { row2 })
        check('T4-10 닫힌 줄은 shown:false — 이때 알약이 뜬다', row2?.shown === false, `shown=${row2?.shown} (true면 알약이 영원히 숨는다)`, { shown: row2?.shown })
        check('T4-11 닫힌 줄도 btwOf를 유지한다', row2?.btwOf === 'chat-origin-1', `btwOf=${JSON.stringify(row2?.btwOf)}`, {})
      }
    }

    // ── H2. MCP·스킬 ─────────────────────────────────────────────────────
    if (want('h2')) {
      console.log('\nH2. mcp:list · skill:list · set-enabled')
      const mcp = await app.j(`window.api.mcp.list(${JSON.stringify(SCRATCH)})`)
      const skills = await app.j(`window.api.skill.list(${JSON.stringify(SCRATCH)})`)
      const projMcp = (mcp ?? []).filter((m) => m.origin === 'project')
      const projSkill = (skills ?? []).filter((s) => s.scope === 'local')
      rep.steps.h2 = { mcpTotal: (mcp ?? []).length, skillTotal: (skills ?? []).length, projMcp, projSkill }
      check('H2-1 프로젝트 MCP 서버를 센다(감사 기준 2.6.2=1건)', projMcp.length === 1 && projMcp[0].name === 'bench-mcp', `실제 ${projMcp.length}건 ${JSON.stringify(projMcp.map((m) => m.name))}`, { n: projMcp.length })
      check('H2-2 stdio 요약이 명령줄이다', projMcp[0]?.transport === 'stdio' && projMcp[0]?.detail === 'node stub.js', `${JSON.stringify(projMcp[0])}`, {})
      check('H2-3 프로젝트 스킬을 센다(감사 기준 2.6.2=1건)', projSkill.length === 1 && projSkill[0].name === 'bench-skill', `실제 ${projSkill.length}건 ${JSON.stringify(projSkill.map((s) => s.name))}`, { n: projSkill.length })
      check('H2-4 프론트매터 설명이 실린다', projSkill[0]?.description === '파리티 실측용 스킬', JSON.stringify(projSkill[0]?.description), {})
      // 토글 — 앱 홈에 남고 목록에 반영되는가
      await app.j(`window.api.mcp.setEnabled('bench-mcp', false)`)
      await app.j(`window.api.skill.setEnabled('bench-skill', false)`)
      const mcp2 = await app.j(`window.api.mcp.list(${JSON.stringify(SCRATCH)})`)
      const sk2 = await app.j(`window.api.skill.list(${JSON.stringify(SCRATCH)})`)
      const offM = (mcp2 ?? []).find((m) => m.name === 'bench-mcp')
      const offS = (sk2 ?? []).find((s) => s.name === 'bench-skill')
      const diskM = fs.existsSync(path.join(HOME, 'mcp.json')) ? JSON.parse(fs.readFileSync(path.join(HOME, 'mcp.json'), 'utf8')) : null
      const diskS = fs.existsSync(path.join(HOME, 'skills.json')) ? JSON.parse(fs.readFileSync(path.join(HOME, 'skills.json'), 'utf8')) : null
      rep.steps.h2.toggled = { mcp: offM, skill: offS, diskM, diskS }
      check('H2-5 끄면 목록에 enabled:false로 남는다', offM?.enabled === false && offS?.enabled === false, `mcp=${offM?.enabled} skill=${offS?.enabled}`, {})
      check('H2-6 끔 목록이 **앱 홈**에 남는다(사용자 ~/.claude 불가침)', diskM?.disabled?.includes('bench-mcp') && diskS?.disabled?.includes('bench-skill'), `${JSON.stringify({ diskM, diskS })}`, { diskM, diskS })
    }

    // ── M1. Ctrl+W + ★창 경계 (확인 크리틱 R1 실패2) ─────────────────────
    if (want('m1')) {
      console.log('\nM1. shortcut:close (Ctrl+W) — 왕복 + 창 경계')
      // 크리틱이 잡은 것: 심의 `listen()`이 **전역 대상**이라 셸의 `emit_to(창)` 필터가
      // 무력화됐다 → 메인에서 1회 부르면 메인 1 + 추가 채팅 창 1. `FileModal.tsx:2998`이
      // 이 채널로 뷰어를 닫으므로 **다른 창의 Ctrl+W가 열린 파일 뷰어를 같이 닫는다**.
      // 그래서 창 둘에 계수기를 달고 양방향으로 잰다.
      const pagesBefore = new Set((await cdpTargets(PORT)).filter((t) => t.type === 'page').map((t) => t.id))
      await app.j(IPC('win:open-session'))
      await sleep(2200)
      const fresh = (await cdpTargets(PORT)).find((t) => t.type === 'page' && /#session/.test(t.url) && !pagesBefore.has(t.id))
      const other = fresh ? await Cdp.connect(fresh.webSocketDebuggerUrl, { timeoutMs: 8000 }) : null
      // 계수기 둘: 닫기 단축키(창 한정이어야 한다) · 추가 채팅 목록(전 창이어야 한다)
      const arm = (page) =>
        page.eval(
          `window.__t3t4_close = 0; window.api.onCloseShortcut(() => { window.__t3t4_close++ });
           window.__t3t4_wins = 0; window.api.sessionWindows.onChanged(() => { window.__t3t4_wins++ }); 0`
        )
      await arm(app.cdp)
      if (other) await arm(other)
      await sleep(600) // listen() 등록은 비동기다(심 §3.3)
      const press = async (page) =>
        page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true }))`)
      const counts = async () => ({
        main: await app.j(`window.__t3t4_close`),
        other: other ? await app.j(`window.__t3t4_close`, other) : null
      })

      await press(app.cdp)
      await sleep(600)
      const a = await counts()
      rep.steps.m1 = { afterMainPress: a, hadSecondWindow: !!other }
      check('M1-1 Ctrl+W가 렌더러까지 왕복한다', a.main >= 1, `수신 ${a.main}회 — 0이면 방출자가 여전히 없다`, a)
      if (other) {
        check('M1-2 ★메인의 Ctrl+W가 다른 창을 건드리지 않는다', a.other === 0, `추가 채팅 창이 ${a.other}회 받았다 — 그 창의 파일 뷰어가 같이 닫힌다`, a)
        await press(other)
        await sleep(600)
        const b = await counts()
        rep.steps.m1.afterOtherPress = b
        check('M1-3 ★반대 방향도 창 경계를 지킨다', b.other === 1 && b.main === a.main, `메인 ${a.main}→${b.main} · 추가 ${a.other}→${b.other}`, b)
        // 대상 필터를 살리면서 **브로드캐스트까지 죽이지 않았는가**. 목록 변경은 전 창이
        // 받아야 한다(2.6.2 `broadcastSessionWins`가 `getAllWindows()`를 도는 자리 —
        // 팝아웃·추가 채팅 창의 btw 알약이 이 신호로 뜬다).
        const w0 = { main: await app.j(`window.__t3t4_wins`), other: await app.j(`window.__t3t4_wins`, other) }
        await app.j(IPC('win:open-session'))
        await sleep(2000)
        const w1 = { main: await app.j(`window.__t3t4_wins`), other: await app.j(`window.__t3t4_wins`, other) }
        rep.steps.m1.sessionWinsChanged = { before: w0, after: w1 }
        check('M1-4 목록 브로드캐스트는 여전히 **전 창**에 닿는다', w1.main > w0.main && w1.other > w0.other, `메인 ${w0.main}→${w1.main} · 추가 ${w0.other}→${w1.other}`, { w0, w1 })
      } else {
        fail('M1-2..4', '두 번째 창을 못 열어 창 경계를 못 쟀다')
      }
    }

    // ── M3. API 설정 점프 ────────────────────────────────────────────────
    if (want('m3')) {
      console.log('\nM3. ui:open-api-settings')
      await app.cdp.eval(`window.__t3t4_api = 0; window.api.onApiSettingsRequested(() => { window.__t3t4_api++ })`)
      await app.j(`window.api.openApiSettings()`)
      await sleep(500)
      const n = await app.j(`window.__t3t4_api`)
      rep.steps.m3 = { received: n }
      check('M3 요청이 메인 창의 설정 모달까지 닿는다', n >= 1, `수신 ${n}회`, { received: n })
    }

    // ── H4. Codex 모델 ───────────────────────────────────────────────────
    if (want('h4')) {
      console.log('\nH4. codex:models')
      const t0 = Date.now()
      const models = await app.j(`window.api.codexModels()`)
      rep.steps.h4 = { models, ms: Date.now() - t0, codexAccounts: fs.existsSync(path.join(REAL_HOME, 'codex-accounts.json')) }
      check('H4-1 미구현이 아니다(배열이 온다)', Array.isArray(models), `${JSON.stringify(models)}`, {})
      if (Array.isArray(models) && models.length === 0) {
        console.log('  (빈 목록 — 이 홈에 Codex 계정이 없다. 렌더러는 codexFallback()으로 착지한다)')
      }
    }

    // ── H1. 첨부 picker 3표면 ────────────────────────────────────────────
    if (want('h1')) {
      console.log('\nH1. dialog:pick-attachments (3표면)')
      rep.steps.h1 = {}
      // 표면별로 그 창의 페이지에서 채널을 부른다 — 셸의 구현은 하나지만,
      // "그 표면의 버튼이 이 채널을 부르는가"는 렌더러 코드로 확인한다(아래 static).
      const surfaces = [
        ['본채팅(App.tsx)', app.cdp],
        ['추가 채팅 창(SessionWindow.tsx)', null], // 아래에서 새 창을 열어 붙인다
        ['멀티 패널(MultiAgent.tsx)', app.cdp] // 같은 메인 창 문서
      ]
      // 추가 채팅 창 하나를 연다(닫힌 btw 창 말고 새 창).
      await app.j(IPC('win:open-session'))
      await sleep(1800)
      const sess = (await cdpTargets(PORT)).filter((t) => t.type === 'page' && /#session/.test(t.url))
      if (sess.length) surfaces[1][1] = await Cdp.connect(sess[sess.length - 1].webSocketDebuggerUrl, { timeoutMs: 8000 })

      for (const [name, page] of surfaces) {
        if (!page) {
          fail(`H1 ${name}`, '그 표면의 페이지를 못 찾았다')
          continue
        }
        // 블로킹 채널이라 **await 하지 않고** 던진다(대화상자가 닫힐 때까지 안 돌아온다).
        await page.eval(`window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'dialog:pick-attachments', payload: [] }); 0`)
        const opened = await waitDialog(pid, 8000)
        const closed = opened ? countDialogs(pid, true) : 0
        rep.steps.h1[name] = { opened, closed }
        check(`H1 ${name}에서 네이티브 대화상자가 뜬다`, opened, '대화상자가 안 떴다', { opened })
        await sleep(600)
      }
      // 렌더러 3표면이 정말 같은 채널을 부르는가 — 이식본 소스 대조(정적 근거).
      const srcs = {
        'App.tsx': 'app/src/App.tsx',
        'MultiAgent.tsx': 'app/src/components/MultiAgent.tsx',
        'SessionWindow.tsx': 'app/src/components/SessionWindow.tsx'
      }
      const wired = Object.fromEntries(
        Object.entries(srcs).map(([k, p]) => [k, /pickAttachments\s*\(/.test(fs.readFileSync(path.join(REPO, p), 'utf8'))])
      )
      rep.steps.h1.wired = wired
      check('H1 세 표면 모두 pickAttachments를 부른다(이식본 소스)', Object.values(wired).every(Boolean), JSON.stringify(wired), wired)
    }

    // ── H5. 닫기 flush 악수 ──────────────────────────────────────────────
    if (want('h5')) {
      console.log('\nH5. session-wins:flush-request + CloseRequested')
      // ★앞 단계들이 창을 여러 개 열어 뒀다 — "마지막 CDP 타깃"과 "마지막 자리"는 같은
      //   창이 아니다(첫 주행이 밟은 함정: 엉뚱한 창을 닫고 다른 창이 살아 있는 걸 보고
      //   "안 닫혔다"고 적었다). **새로 생긴 것만** 골라 짝을 맞춘다.
      const slotsBefore = await app.j(IPC('win:chat-list'))
      const pagesBefore = new Set((await cdpTargets(PORT)).filter((t) => t.type === 'page').map((t) => t.id))
      await app.j(IPC('win:open-session'))
      await sleep(2000)
      const slotsAfter = await app.j(IPC('win:chat-list'))
      const chatId = (slotsAfter ?? []).find((w) => !(slotsBefore ?? []).some((b) => b.chatId === w.chatId))?.chatId
      const fresh = (await cdpTargets(PORT)).find((t) => t.type === 'page' && /#session/.test(t.url) && !pagesBefore.has(t.id))
      const page = fresh ? await Cdp.connect(fresh.webSocketDebuggerUrl, { timeoutMs: 8000 }) : null
      if (!page || !chatId) {
        fail('H5', `새 추가 채팅 창을 못 짚었다 (page=${!!page} chatId=${chatId})`)
      } else {
        // ★증거를 **디스크의 파일 마커**로 남긴다. 창은 flush 뒤 곧바로 파기되므로
        //   페이지 안의 카운터는 읽어 낼 창이 없다.
        //
        //   R1은 여기서 `session.persist({title:'FLUSH-OK'})`를 썼는데, 그건 **컴포넌트
        //   자신의 persist와 같은 그릇에 쓴다**(SessionWindow.tsx:351이 같은 요청에
        //   자기 스냅샷을 저장한다) — 마지막에 쓴 쪽이 이긴다. 확인 크리틱이 같은 exe로
        //   4회 중 1회만 통과한 이유가 이것이고, 기능이 아니라 **검사가 거짓 실패**였다.
        //   경합 없는 그릇(스크래치 폴더의 파일)으로 바꾼다.
        const MARKER = 'flush-marker.txt'
        try {
          fs.rmSync(path.join(SCRATCH, MARKER), { force: true })
        } catch {
          /* 없으면 그만 */
        }
        await page.eval(`
          window.api.session.onFlushRequest(() => {
            window.api.writeFile(${JSON.stringify(SCRATCH)}, ${JSON.stringify(MARKER)}, String(Date.now()))
          })
        `)
        await sleep(400)
        // 창 컨트롤 X와 같은 경로(`win:close`) = `CloseRequested`가 도는 경로.
        await page.eval(`window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'win:close', payload: [] }); 0`)
        await sleep(3000)
        const slots = await app.j(IPC('win:chat-list'))
        const stillOpen = (slots ?? []).some((w) => w.chatId === chatId)
        const list = await app.j(`window.api.sessionWindows.list()`)
        const marker = fs.existsSync(path.join(SCRATCH, MARKER))
        const kept = (list ?? []).find((w) => w.id === chatId)
        rep.steps.h5 = { chatId, stillOpen, marker, kept: kept ?? null }
        check('H5-1 X로 닫으면 창이 실제로 닫힌다(악수가 창을 붙잡아 두지 않는다)', !stillOpen, '창이 안 닫혔다 = 유예가 안 풀린다', { stillOpen })
        check(
          'H5-2 닫기 직전 저장 요청이 **실제로 도착**한다(옛 채널로 — 경합 없는 파일 마커)',
          marker,
          '요청이 안 왔다 — 디바운스 안 내려간 마지막 편집이 창과 함께 사라진다',
          { marker }
        )
        check('H5-2b 그 대화는 닫힌 뒤에도 목록에 남는다', !!kept, '창을 닫자 대화가 증발했다', { kept: kept ?? null })
        try {
          page.close?.()
        } catch {
          /* 창이 이미 죽었다 */
        }
      }
      // 두 이름이 **같은 원천**에서 나가는지는 소스로 못 박는다(런타임은 한 쪽만 본다).
      const winsrc = fs.readFileSync(path.join(REPO, 'src-tauri/src/ipc/windows.rs'), 'utf8')
      const emits =
        /emit_to\(label\.as_str\(\), CHAT_FLUSH_REQ/.test(winsrc) &&
        /emit_to\(label\.as_str\(\), SESSION_FLUSH_REQUEST/.test(winsrc)
      rep.steps.h5 = { ...(rep.steps.h5 ?? {}), bothNamesInSource: emits }
      check('H5-3 셸이 두 이름을 같은 자리에서 쏜다(원천 하나, 이름 둘)', emits, '한쪽만 쏜다', {})
    }

    rep.pass = pass
    rep.fail = rep.findings.length
  } finally {
    try {
      app.cdp.close?.()
    } catch {
      /* ignore */
    }
    // ★우리가 spawn한 PID 트리만 죽인다(이름 기반 kill 금지).
    countDialogs(pid, true)
    killTree(pid)
    await sleep(600)
    if (!KEEP) {
      rmrf(HOME)
      rmrf(SCRATCH)
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
  console.log(`\n${rep.findings.length === 0 ? 'PASS' : 'FAIL'} — ${pass} 통과, ${rep.findings.length} 실패`)
  console.log(`리포트: ${OUT}`)
  process.exit(rep.findings.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
