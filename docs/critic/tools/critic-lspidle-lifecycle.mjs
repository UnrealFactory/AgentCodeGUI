#!/usr/bin/env node
/**
 * 확인 크리틱 LSPIDLE R1 — **수명·회수·conhost의 계기**.
 *
 * 빌더의 `scripts/poc-lspidle-reclaim.mjs`는 이상적인 경로만 본다(「회수 중에는 아무것도
 * 안 묻는다」가 그 파일의 규약이다). 이 계기가 보는 것은 그 바깥이다:
 *
 *   ① 파일을 **열어 놓은 채** TTL이 지나면 무엇이 사라지고 무엇이 남는가
 *   ② 회수 **직후** 첫 호버/정의/토큰이 무엇을 돌려주는가(조용한 빈손인가)
 *   ③ 회수와 요청이 서로를 스칠 때(TTL·스윕을 밀리초로 주입) 답이 흔들리는가
 *   ④ 멀티 패널 모사 — 서로 다른 두 언어를 동시에 열면 자리가 몇 개인가
 *   ⑤ cwd를 바꾼 직후 열람
 *   ⑥ **conhost 프리로드 조각이 없는 판**에서 서버가 어떻게 죽는가(조용히 죽으면 결함)
 *
 * 짝이 되는 프로브는 격리 사본에만 있는 `crates/ccg-lsp/src/bin/critic_idle.rs`다
 * (제품 코드에는 안 넣는다 — 크리틱의 계기지 제품의 기능이 아니다).
 *
 * ## 규율
 * - **내가 스폰한 PID의 트리만** 죽인다(`taskkill /T /F /PID`). 이름 기반 kill 없음.
 * - `CCG_HOME`은 인자로 받은 격리 홈. 실홈은 읽지도 않는다.
 * - 제품 코드·기준 결과 파일은 안 건드린다.
 *
 * ```
 * node docs/critic/tools/critic-lspidle-lifecycle.mjs \
 *   --probe=C:/Temp/ccg-t-critic/debug/critic-idle.exe \
 *   --sim=C:/Temp/ccg-sim-after --fx=C:/Temp/critic-fx --home=C:/Temp/critic-home \
 *   --out=C:/Temp/critic-lifecycle.json
 * ```
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const arg = (k, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}

const PROBE = arg('probe', 'C:/Temp/ccg-t-critic/debug/critic-idle.exe')
const SIM = arg('sim', 'C:/Temp/ccg-sim-after')
const FX = arg('fx', 'C:/Temp/critic-fx')
const HOME = arg('home', 'C:/Temp/critic-home')
const OUT = arg('out', 'C:/Temp/critic-lifecycle.json')

const baseEnv = {
  CCG_HOME: HOME,
  CCG_LSP_NODE: join(SIM, 'node.exe'),
  CCG_LSP_MODULES: SIM
}

/** 이 PID의 **자손 트리**를 찍는다. 루트보다 나중에 태어난 것만 — PID 재사용 방어. */
function tree(rootPid) {
  const ps = `
$root = Get-CimInstance Win32_Process -Filter "ProcessId=${rootPid}"
if (-not $root) { '[]'; exit }
$all = Get-CimInstance Win32_Process
$seen = @{}; $q = New-Object System.Collections.Queue; $q.Enqueue($root) | Out-Null
$out = @()
while ($q.Count -gt 0) {
  $p = $q.Dequeue()
  foreach ($c in $all) {
    if ($c.ParentProcessId -eq $p.ProcessId -and -not $seen[[int]$c.ProcessId]) {
      if ($c.CreationDate -ge $root.CreationDate.AddSeconds(-2)) {
        $seen[[int]$c.ProcessId] = $true
        $out += [pscustomobject]@{ pid=[int]$c.ProcessId; ppid=[int]$c.ParentProcessId; name=$c.Name; ws=[math]::Round($c.WorkingSetSize/1MB,1); cmd=$c.CommandLine }
        $q.Enqueue($c) | Out-Null
      }
    }
  }
}
'[' + (($out | ForEach-Object { $_ | ConvertTo-Json -Compress }) -join ',') + ']'`
  // ★Windows PowerShell 5.1에는 \`-AsArray\`가 없다. 첫 판이 그걸 써서 **모든 트리가 조용히
  //   빈 배열**로 나왔고(=「자손 0」이 전부 거짓 초록), 그 상태로도 스크립트는 끝까지 돌았다.
  //   한 줄씩 직렬화해 손으로 배열을 만든다 — 원소가 하나여도 배열이다.
  // 실패를 **삼키지 않는다** — 조용한 빈 배열이 이 계기가 잡으려는 병 그 자체다.
  const raw = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true })
  return JSON.parse(raw.trim() || '[]')
}

function killTree(pid) {
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* 이미 죽었다 */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 프로브를 돌리고 JSON 줄들을 모은다. `sampleAt`에 이름이 있으면 그 단계 줄을 본 뒤
 * 트리를 한 번 찍는다(빌더가 밟은 「단계 이름과 표본 시각이 어긋난다」를 피하려고
 * **줄을 본 직후** 찍고, 프로브에는 그 사이 아무 일도 안 시키는 단계만 고른다).
 */
async function runProbe(mode, args, env, { sampleAt = [], timeoutMs = 180000 } = {}) {
  // ★stdin을 파이프로 연다 — 악수(`CRITIC_HANDSHAKE`)로 프로브를 세워 놓고 트리를 찍는다.
  const child = spawn(PROBE, [mode, ...args], {
    env: { ...process.env, ...baseEnv, CRITIC_HANDSHAKE: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const lines = []
  const samples = {}
  let buf = ''
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d))
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let o
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      lines.push(o)
      // 악수 규약: 이 단계를 재야 하면 **먼저 찍고** 그다음에 진행을 허락한다.
      if (sampleAt.includes(o.phase)) samples[o.phase] = tree(child.pid)
      try {
        child.stdin.write('\n')
      } catch {
        /* 이미 닫혔다 */
      }
    }
  })
  const done = new Promise((res) => child.on('close', (code) => res(code)))
  const timer = setTimeout(() => killTree(child.pid), timeoutMs)
  const code = await done
  clearTimeout(timer)
  killTree(child.pid) // 자기 자신은 이미 끝났지만 손자가 남았으면 여기서 걷는다
  return { code, lines, samples, stderr: stderr.slice(0, 800), rootPid: child.pid }
}

const phase = (r, name) => r.lines.find((l) => l.phase === name) || null
const conhosts = (t) => t.filter((p) => /conhost/i.test(p.name || '')).length

const evidence = { at: new Date().toISOString(), probe: PROBE, sim: SIM, home: HOME, scenarios: {} }

// ── ①②「열람 중 회수」와 그 직후 ─────────────────────────────────────────────
for (const [tag, cwd, rel, line, ch] of [
  ['ts', join(FX, 'ts'), 'src/a.ts', '3', '10'],
  ['py', join(FX, 'mix'), 'src/b.py', '2', '6']
]) {
  const r = await runProbe('viewing', [cwd, rel, line, ch], { CCG_LSP_IDLE_TTL_MS: '8000', CCG_LSP_SWEEP_MS: '1000' }, {
    sampleAt: ['prewarmed', 'firstUse', 'viewedThroughTtl']
  })
  evidence.scenarios[`viewing-${tag}`] = {
    prewarmDescendants: (r.samples.prewarmed || []).length,
    steadyDescendants: (r.samples.firstUse || []).length,
    steadyConhost: conhosts(r.samples.firstUse || []),
    afterReclaimDescendants: (r.samples.viewedThroughTtl || []).length,
    opened: phase(r, 'opened'),
    firstUse: phase(r, 'firstUse'),
    reclaimed: phase(r, 'viewedThroughTtl'),
    hoverRightAfter: phase(r, 'hoverRightAfterReclaim'),
    definitionRightAfter: phase(r, 'definitionRightAfter'),
    tokensRightAfter: phase(r, 'tokensRightAfter'),
    hoverSecondTry: phase(r, 'hoverSecondTry')
  }
  await sleep(1500)
}

// ── ③ 회수와 요청이 서로를 스친다 ────────────────────────────────────────────
for (const [tag, ttl, sweep] of [
  ['gentle', '400', '150'],
  ['brutal', '1', '30']
]) {
  const r = await runProbe('thrash', [join(FX, 'ts'), 'src/a.ts', '3', '10', '40'], {
    CCG_LSP_IDLE_TTL_MS: ttl,
    CCG_LSP_SWEEP_MS: sweep
  })
  evidence.scenarios[`thrash-${tag}`] = { ttlMs: +ttl, sweepMs: +sweep, result: phase(r, 'thrashed') || phase(r, 'abort') }
  await sleep(1500)
}

// ── ④ 멀티 패널 모사 · ⑤ cwd 변경 ────────────────────────────────────────────
{
  const r = await runProbe('multi', [join(FX, 'mix'), 'src/a.ts', 'src/b.py'], {}, { sampleAt: ['prewarmed', 'bothTokens'] })
  evidence.scenarios.multiLanguage = {
    prewarmDescendants: (r.samples.prewarmed || []).length,
    bothOpenDescendants: (r.samples.bothTokens || []).length,
    bothOpenConhost: conhosts(r.samples.bothTokens || []),
    openedA: phase(r, 'openedA'),
    openedB: phase(r, 'openedB'),
    bothTokens: phase(r, 'bothTokens')
  }
  await sleep(1500)
}
{
  const r = await runProbe('cwdchange', [join(FX, 'ts'), join(FX, 'other'), 'src/a.ts'], {}, {
    sampleAt: ['afterPrewarmA', 'afterPrewarmB', 'tokensB']
  })
  evidence.scenarios.cwdChange = {
    afterPrewarmADescendants: (r.samples.afterPrewarmA || []).length,
    afterPrewarmBDescendants: (r.samples.afterPrewarmB || []).length,
    openDescendants: (r.samples.tokensB || []).length,
    openedB: phase(r, 'openedB'),
    tokensB: phase(r, 'tokensB')
  }
  await sleep(1500)
}

// ── ⑥ conhost 프리로드 조각이 **없는 판** ────────────────────────────────────
//
// 조각의 안전 규약은 「쓰고 실재를 확인한 뒤에만 건다」다. 그 규약이 진짜로 서는지 보려면
// 조각을 못 쓰게 만들어야 한다 — 파일 자리에 **폴더**를 놔서 쓰기를 막는다(삭제는 다음
// 기동이 다시 써서 자가 치유된다). 그리고 마지막 팔은 그 규약을 **우회**해서
// (밖에서 NODE_OPTIONS에 없는 파일을 건다) 「조각이 유실된 세계」의 대가를 직접 잰다.
const preloadDir = join(HOME, 'lsp')
const preloadFile = join(preloadDir, 'no-console-spawn.cjs')

async function conhostArm(name, prep, env) {
  prep()
  const r = await runProbe('viewing', [join(FX, 'ts'), 'src/a.ts', '3', '10'], {
    CCG_LSP_IDLE_TTL_MS: '600000',
    CCG_LSP_SWEEP_MS: '60000',
    ...env
  }, { sampleAt: ['firstUse'], timeoutMs: 120000 })
  const t = r.samples.firstUse || []
  return {
    descendants: t.length,
    conhost: conhosts(t),
    names: t.map((p) => p.name),
    // conhost가 **누구에게 붙었는가**가 이 팔의 요점이다. 프로브 자신(콘솔 앱)에게 하나가
    // 붙는 것은 하네스의 몫이고, 언어 서버 트리에 붙는 것이 이 라운드가 없앤 그 하나다.
    rows: t.map((p) => ({ pid: p.pid, ppid: p.ppid, name: p.name, probePid: r.rootPid })),
    opened: phase(r, 'opened'),
    firstUse: phase(r, 'firstUse'),
    abort: phase(r, 'abort'),
    stderrHead: r.stderr.split('\n')[0] || ''
  }
}

evidence.scenarios.conhostNormal = await conhostArm('normal', () => {
  rmSync(preloadFile, { recursive: true, force: true })
}, {})
await sleep(1500)

evidence.scenarios.conhostFragmentUnwritable = await conhostArm('unwritable', () => {
  rmSync(preloadFile, { recursive: true, force: true })
  mkdirSync(preloadFile, { recursive: true }) // 파일 자리에 폴더 — 쓰기가 실패한다
}, {})
await sleep(1500)
rmSync(preloadFile, { recursive: true, force: true })

evidence.scenarios.conhostFragmentMissingAtSpawn = await conhostArm('missing', () => {
  rmSync(preloadFile, { recursive: true, force: true })
}, { NODE_OPTIONS: '--require "C:/Temp/critic-does-not-exist.cjs"' })

writeFileSync(OUT, JSON.stringify(evidence, null, 1))
console.log(`saved: ${OUT}`)
for (const [k, v] of Object.entries(evidence.scenarios)) {
  console.log(`\n■ ${k}`)
  console.log(JSON.stringify(v))
}
if (!existsSync(OUT)) process.exit(1)
