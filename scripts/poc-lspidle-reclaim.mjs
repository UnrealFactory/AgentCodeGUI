#!/usr/bin/env node
/**
 * ★LSPIDLE R1 PoC ① — **수명 시나리오를 프로세스 수로 실증한다.**
 *
 * 무엇을 증명하나(넷 다 통과해야 초록):
 *   ① 프리웜(=프로젝트 열기)만으로는 언어 서버가 **안 뜬다** — 온디맨드.
 *   ② 파일을 열면 뜬다 — 「안 뜬다」가 「고장났다」와 다르다는 것.
 *   ③ TTL이 지나면 **프로세스가 사라진다** — 회수. (앱 안의 판정만이 아니라 OS의 트리로.)
 *   ④ 다시 물으면 **새 PID로** 돌아오고, 그 전에 이미 색은 캐시로 칠해져 있다 — 투명 재기동.
 *
 * 왜 앱이 아니라 크레이트 프로브인가: 앱 전체를 띄우면 유휴 트리에 웹뷰·GPU가 섞여
 * 「헬퍼 0」과 「측정이 헬퍼를 못 봤다」가 구분이 안 된다. 여기서는 프로브의 **자식이 곧
 * 언어 서버**라, 트리를 세는 것이 그대로 답이 된다. 앱 전체 눈금은 `bench/lsp.mjs`와
 * `bench/multi.mjs`가 따로 잰다.
 *
 * 실행:
 *   node scripts/poc-lspidle-reclaim.mjs [--ttl 6000] [--sweep 1000] [--keep]
 *
 * 사용자의 실앱을 절대 안 건드린다: CCG_HOME은 temp로 격리하고, 죽이는 것은 **이 스크립트가
 * 띄운 프로브 PID의 트리**뿐이다(이름으로 찾아 죽이는 경로가 없다).
 */

import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = path.join(REPO, 'target-lspidle')

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const TTL = Number(flag('ttl', '6000'))
const SWEEP = Number(flag('sweep', '1000'))
const KEEP = argv.includes('--keep')

const HOME = path.join(os.tmpdir(), 'ccg-lspidle-home')
const WORK = path.join(os.tmpdir(), 'ccg-lspidle-work')
const REL = 'src/big.ts'

/** 이 PID의 **자손** 전부(이름·부모 포함). 루트 자신은 뺀다 — 우리가 세는 것은 언어 서버다. */
function descendants(rootPid) {
  // ★ppid는 **재사용된다**. 죽은 프로세스의 자식은 ppid 칸에 옛 번호를 그대로 들고 있고,
  //   Windows가 그 번호를 새 프로세스에 물려주면 남의 고아가 우리 자식으로 보인다.
  //   실제로 이 하네스가 그 함정을 밟았다: 프리웜 직후(서버를 안 띄웠는데) 트리에
  //   node·node·conhost 셋이 잡혔고, 그건 **직전 실행이 남긴 고아**였다.
  //   `bench/lib.mjs::procTreeMem`이 쓰는 것과 같은 방어 — **루트보다 나중에 태어난 것만**
  //   자식으로 친다(2초 여유는 시계 해상도용).
  const ps = String.raw`
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate
$root = $all | Where-Object { $_.ProcessId -eq ${rootPid} }
if (-not $root) { '[]'; exit }
$kids = @{}
foreach ($p in $all) {
  $k = [uint32]$p.ParentProcessId
  if (-not $kids.ContainsKey($k)) { $kids[$k] = @() }
  $kids[$k] += $p
}
$out = @(); $q = New-Object System.Collections.Queue; $q.Enqueue([uint32]${rootPid})
while ($q.Count -gt 0) {
  $cur = $q.Dequeue()
  if ($kids.ContainsKey($cur)) {
    foreach ($c in $kids[$cur]) {
      if ($c.CreationDate -ge $root.CreationDate.AddSeconds(-2)) { $out += $c; $q.Enqueue([uint32]$c.ProcessId) }
    }
  }
}
@($out | ForEach-Object { @{ pid=[uint32]$_.ProcessId; ppid=[uint32]$_.ParentProcessId; name=$_.Name; cmd=$_.CommandLine } }) | ConvertTo-Json -Depth 3 -Compress
`
  try {
    const raw = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 30000 }).trim()
    if (!raw) return []
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : [v]
  } catch {
    return []
  }
}

/**
 * ★측정 함정 하나를 여기서 막는다 — **프로브 자신의 conhost를 언어 서버 몫으로 세지 않기.**
 *
 * 초판은 트리의 `conhost.exe`를 그냥 셌고 1이 나왔다. 그런데 그 conhost의 부모는 **프로브
 * 자신**이었다: node가 자식을 띄울 때 기본이 `windowsHide:true`(=CREATE_NO_WINDOW)라
 * 프로브가 자기 콘솔을 하나 받았고, 그 콘솔의 host가 트리에 들어온 것이다. 즉 재던 것이
 * 「언어 서버가 conhost를 부르는가」가 아니라 「하네스가 conhost를 부르는가」였다.
 *
 * 두 겹으로 막는다: 프로브를 `windowsHide:false`로 띄워 콘솔을 물려주고(=새 conhost 없음),
 * 그래도 남는 것이 있으면 **부모가 프로브 자신인 conhost는 빼고** 센다. 우리가 주장하는
 * 것은 「언어 서버 프로세스가 conhost를 달고 오지 않는다」다.
 */
const serverConhosts = (kids, rootPid) => kids.filter((k) => /conhost/i.test(k.name) && k.ppid !== rootPid)

function makeFixture() {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(path.join(WORK, 'src'), { recursive: true })
  fs.writeFileSync(path.join(WORK, 'package.json'), JSON.stringify({ name: 'ccg-lspidle-fixture', private: true }, null, 2))
  fs.writeFileSync(
    path.join(WORK, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true, noEmit: true }, include: ['src/*.ts'] }, null, 2)
  )
  // 토큰이 넉넉히 나오도록 적당히 크게(캐시 적중/미적중 차이가 보이게)
  const blocks = []
  blocks.push('export interface Cfg { id: number; name: string; on: boolean }')
  blocks.push('export function makeCfg(id: number, name: string): Cfg { return { id, name, on: id % 2 === 0 } }')
  for (let i = 0; i < 300; i++) {
    blocks.push(
      `export function step${i}(c: Cfg): number {`,
      `  const local${i} = makeCfg(c.id + ${i}, c.name + '${i}')`,
      `  return local${i}.on ? local${i}.id * 2 : local${i}.id + 1`,
      `}`
    )
  }
  fs.writeFileSync(path.join(WORK, REL.replace('/', path.sep)), blocks.join('\n') + '\n')
}

function build() {
  console.log('[poc] ccg-lspidle 빌드 중…')
  const r = spawn(
    'cargo',
    ['build', '--release', '-p', 'ccg-lsp', '--features', 'cli', '--bin', 'ccg-lspidle'],
    { cwd: REPO, env: { ...process.env, CARGO_TARGET_DIR: TARGET }, stdio: 'inherit' }
  )
  return new Promise((res, rej) => {
    r.on('exit', (c) => (c === 0 ? res() : rej(new Error(`cargo build 종료 코드 ${c}`))))
  })
}

async function run() {
  const exe = path.join(TARGET, 'release', 'ccg-lspidle.exe')
  if (!fs.existsSync(exe)) throw new Error(`프로브가 없다: ${exe}`)
  fs.rmSync(HOME, { recursive: true, force: true })

  const child = spawn(exe, [WORK, REL], {
    cwd: REPO,
    env: {
      ...process.env,
      CCG_HOME: HOME,
      CCG_LSP_IDLE_TTL_MS: String(TTL),
      CCG_LSP_SWEEP_MS: String(SWEEP),
      // 단계마다 표본을 다 찍을 때까지 프로브를 세운다 — 아래 ack 참고
      CCG_LSPIDLE_HANDSHAKE: '1'
    },
    // 콘솔을 물려준다 — 프로브가 자기 conhost를 새로 만들지 않게(위 `serverConhosts` 주석).
    windowsHide: false,
    stdio: ['pipe', 'pipe', 'inherit']
  })

  const phases = []
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line.startsWith('{')) continue
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      // 그 줄이 나온 **바로 그 순간**의 OS 트리를 찍는다 — 앱 안의 판정과 맞대기 위해서.
      let kids = descendants(child.pid)
      // ★회수·종료는 **비동기다**: 앱 안의 자리는 즉시 비지만 `shutdown`(taskkill 왕복)은
      //   잠금 밖에서 수십~수백 ms 더 돈다. 그 순간을 그대로 찍으면 「live=0인데 자손=3」이
      //   나오고, 그건 회수가 안 됐다는 뜻이 아니라 **아직 안 끝났다**는 뜻이다.
      //   그래서 이 두 단계에서는 트리가 빌 때까지 기다리고, 그 기다린 시간을 값으로 남긴다
      //   (숨기는 게 아니라 「판정 → 실제 소멸」이 얼마인지를 재는 것이다).
      if ((rec.phase === 'reclaimed' || rec.phase === 'disposed') && kids.length > 0) {
        // `descendants()` 한 번이 PowerShell 왕복(수백 ms)이라 그 자체가 간격 노릇을 한다.
        const t0 = Date.now()
        while (kids.length > 0 && Date.now() - t0 < 10000) kids = descendants(child.pid)
        rec.procGoneMs = Date.now() - t0
      }
      rec.procs = kids.map((k) => k.name)
      rec.procCount = kids.length
      const ch = serverConhosts(kids, child.pid)
      rec.conhost = ch.length
      rec.conhostOwners = ch.map((c) => c.ppid)
      rec.tree = kids.map((k) => ({ pid: k.pid, ppid: k.ppid, name: k.name, cmd: (k.cmd || '').slice(0, 120) }))
      phases.push(rec)
      // 표본을 다 찍었다 — 프로브를 다음 단계로 보낸다(악수).
      try {
        child.stdin.write('ok\n')
      } catch {
        /* 이미 갔다 */
      }
      console.log(
        `[poc] ${String(rec.phase).padEnd(18)} live=${rec.lifecycle.live} pids=${JSON.stringify(rec.lifecycle.pids)} ` +
          `자손=${rec.procCount}${rec.procCount ? ` (${rec.procs.join(',')})` : ''}` +
          (rec.ms != null ? ` ms=${rec.ms}` : '') +
          (rec.readyMs != null ? ` readyMs=${rec.readyMs}` : '')
      )
    }
  })

  // ★`exit`만 기다리면 **마지막 단계를 놓친다**: 종료 이벤트가 stdout의 마지막 청크보다
  //   먼저 오는 일이 있고(실제로 `disposed`가 통째로 사라졌다), 그러면 「원장이 비었는가」를
  //   묻는 못이 조용히 undefined로 통과/실패한다. 스트림이 닫히는 것까지 같이 기다린다.
  const code = await new Promise((res) => {
    let ended = false
    let exited = null
    const done = () => ended && exited != null && res(exited)
    child.stdout.on('end', () => { ended = true; done() })
    child.on('exit', (c) => { exited = c ?? 0; done() })
  })
  // 남은 것이 있으면 **이 프로브의 트리만** 접는다(이름 기반 kill 금지 — 사용자 앱이 떠 있다)
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
  } catch {
    /* 이미 갔다 */
  }
  return { code, phases }
}

const at = (phases, name) => phases.find((p) => p.phase === name)

async function main() {
  makeFixture()
  await build()
  const { code, phases } = await run()

  const boot = at(phases, 'boot')
  const pre = at(phases, 'prewarmed')
  const cachedCold = at(phases, 'cachedBeforeOpen')
  const opened = at(phases, 'opened')
  const liveTok = at(phases, 'liveTokens')
  const recl = at(phases, 'reclaimed')
  const repaint = at(phases, 'repaintFromCache')
  const revived = at(phases, 'revived')

  const checks = []
  const nail = (name, ok, detail) => checks.push({ name, ok: !!ok, detail })

  nail('프로브가 정상 종료', code === 0, `exit=${code}`)
  nail('시작 시 서버 0', boot && boot.lifecycle.live === 0 && boot.procCount === 0, JSON.stringify(boot?.lifecycle))
  // ① 온디맨드 — 프리웜은 프로세스를 안 만든다
  nail(
    '★프리웜이 서버를 안 띄운다(온디맨드)',
    pre && pre.lifecycle.live === 0 && pre.procCount === 0,
    `live=${pre?.lifecycle.live} 자손=${pre?.procCount} (${pre?.procs?.join(',') ?? ''})`
  )
  // ② 열람이 방아쇠 — 「안 뜬다」가 「고장」이 아니라는 증명
  nail(
    '열람하면 뜬다',
    opened && opened.lifecycle.live >= 1 && opened.procCount >= 1,
    `status=${opened?.status} readyMs=${opened?.readyMs} 자손=${opened?.procCount}`
  )
  // ③ conhost — 창 없는 스폰(DETACHED_PROCESS + node 프리로드 조각)
  //
  //   **정상 상태로 본다.** `opened` 순간에는 tsserver가 typingsInstaller를 잠깐 띄우고
  //   그 손자에는 아직 conhost가 붙는데(1초 안에 사라진다), 그 한 순간으로 판정하면
  //   「유휴·정상 사용 중의 프로세스 수」라는 우리가 실제로 주장하는 값이 안 보인다.
  //   전이 프로세스는 아래 `transientConhost`로 **숨기지 않고 따로 적는다**.
  const steady = [liveTok, revived].filter(Boolean)
  nail(
    '★정상 상태에 conhost가 없다',
    steady.length === 2 && steady.every((p) => p.conhost === 0),
    steady.map((p) => `${p.phase}: 자손 ${p.procCount}(${p.procs.join(',')})`).join(' · ')
  )
  nail(
    '★서버 세트가 프로세스 2개다(node 2 · conhost 0)',
    steady.every((p) => p.procCount === 2),
    steady.map((p) => `${p.phase}=${p.procCount}`).join(' · ')
  )
  // ③ 회수 — OS 트리에서 사라진다
  nail(
    '★TTL 뒤 서버 프로세스 0',
    recl && recl.lifecycle.live === 0 && recl.procCount === 0 && recl.ms != null,
    `회수 판정 ${recl?.ms}ms · 프로세스 소멸까지 +${recl?.procGoneMs ?? 0}ms · live=${recl?.lifecycle.live} 자손=${recl?.procCount}`
  )
  nail('회수가 「회수됨」으로 기록된다', recl && recl.lifecycle.reclaimed >= 1, `reclaimed=${recl?.lifecycle.reclaimed}`)
  // ④ 투명 재기동 — 캐시가 먼저 칠하고, 서버는 새 PID로 돌아온다
  nail(
    '★회수 뒤에도 캐시로 즉시 칠한다',
    repaint && repaint.hit === true && repaint.n > 0 && repaint.lifecycle.live === 0,
    `캐시 ${repaint?.ms}ms · n=${repaint?.n} · 그 순간 서버 live=${repaint?.lifecycle.live}`
  )
  nail(
    '★재열람이 새 PID로 되살린다',
    revived &&
      revived.lifecycle.revivals >= 1 &&
      revived.n > 0 &&
      JSON.stringify(revived.lifecycle.pids) !== JSON.stringify(opened?.lifecycle.pids),
    `revivals=${revived?.lifecycle.revivals} 전 pids=${JSON.stringify(opened?.lifecycle.pids)} 후 pids=${JSON.stringify(revived?.lifecycle.pids)}`
  )
  nail(
    '되살아난 토큰이 처음과 같은 양',
    revived && liveTok && Math.abs(revived.n - liveTok.n) <= Math.max(2, liveTok.n * 0.02),
    `처음 ${liveTok?.n} → 되살림 ${revived?.n}`
  )
  // 좀비 원장이 새지 않는다 — 접은 뒤에는 들고 있는 핸들이 없어야 한다
  const disposed = at(phases, 'disposed')
  nail(
    '접은 뒤 좀비 원장이 비었다',
    disposed && disposed.lifecycle.tracked === 0 && disposed.procCount === 0,
    `tracked=${disposed?.lifecycle.tracked} 자손=${disposed?.procCount}`
  )

  const out = {
    harness: 'poc-lspidle-reclaim',
    at: new Date().toISOString(),
    ttlMs: TTL,
    sweepMs: SWEEP,
    home: HOME,
    work: WORK,
    numbers: {
      prewarmMs: pre?.prewarmMs ?? null,
      cachedBeforeOpen: { ms: cachedCold?.ms ?? null, hit: cachedCold?.hit ?? null, n: cachedCold?.n ?? null },
      readyMs: opened?.readyMs ?? null,
      liveTokensMs: liveTok?.ms ?? null,
      reclaimMs: recl?.ms ?? null,
      procGoneAfterReclaimMs: recl?.procGoneMs ?? 0,
      repaintFromCacheMs: repaint?.ms ?? null,
      repaintHit: repaint?.hit ?? null,
      reviveMs: revived?.ms ?? null,
      procsWhileOpen: opened?.procCount ?? null,
      procsAfterReclaim: recl?.procCount ?? null,
      conhostSteady: [liveTok?.conhost ?? null, revived?.conhost ?? null],
      procsSteady: [liveTok?.procCount ?? null, revived?.procCount ?? null],
      // 정직하게 남긴다: 파일을 여는 그 한순간 tsserver가 띄우는 typingsInstaller에는
      // 아직 conhost가 붙는다(1초 안에 사라진다 — 정상 상태 수에는 안 들어간다).
      transientConhostAtOpen: opened?.conhost ?? null,
      transientProcsAtOpen: opened?.procCount ?? null
    },
    checks,
    phases
  }
  const dest = path.join(REPO, 'bench', 'results', 'poc-lspidle-reclaim.json')
  fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n')

  console.log('')
  for (const c of checks) console.log(`  ${c.ok ? '✔' : '✖'} ${c.name} — ${c.detail}`)
  const bad = checks.filter((c) => !c.ok)
  console.log(`\n[poc] ${checks.length - bad.length}/${checks.length} 통과 · 결과: ${dest}`)
  if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true })
  process.exit(bad.length ? 1 : 0)
}

main().catch((e) => {
  console.error('[poc] 실패:', e.message)
  process.exit(1)
})
