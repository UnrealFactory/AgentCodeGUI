#!/usr/bin/env node
/**
 * 확인 크리틱 LSPIDLE R1 — **다이어트가 무엇을 잘랐는가**의 계기.
 *
 * 빌더의 주장은 두 개다: ① 걸러 낸 사본이 43.53 → 29.42MB(−14.12MB)이고
 * ② 그러고도 기능이 원본과 같다. 여기서는 그 둘을 **따로** 잰다.
 *
 *  - 크기: 두 모듈 뿌리를 실제로 걸어 파일 수·바이트를 세고, **빠진 파일 목록을 그대로 낸다**
 *    (「14MB 줄었다」가 아니라 「무엇이 빠졌다」를 봐야 필요한 파일이 섞였는지 알 수 있다).
 *  - 기능: 같은 프로브를 두 모듈 뿌리로 각각 돌려 호버·정의·시맨틱 토큰을 대조한다.
 *    ★대조 전에 **정말 그 뿌리를 물었는지**를 프로세스 명령줄로 확인한다 — 안 그러면
 *    양쪽이 같은 레포 모듈을 물고 동치가 공짜로 통과한다.
 *
 * ```
 * node docs/critic/tools/critic-lspidle-diet.mjs \
 *   --probe=C:/Temp/ccg-t-critic/debug/critic-idle.exe \
 *   --filtered=C:/Temp/ccg-sim-after --repo=C:/Temp/critic-lspidle \
 *   --fx=C:/Temp/critic-fx --home=C:/Temp/critic-home-diet --out=...json
 * ```
 */
import { execFileSync, spawn } from 'node:child_process'
import { readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const arg = (k, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}
const PROBE = arg('probe', 'C:/Temp/ccg-t-critic/debug/critic-idle.exe')
const FILTERED = arg('filtered', 'C:/Temp/ccg-sim-after')
const REPO = arg('repo', 'C:/Temp/critic-lspidle')
const FX = arg('fx', 'C:/Temp/critic-fx')
const HOME = arg('home', 'C:/Temp/critic-home-diet')
const OUT = arg('out', 'C:/Temp/critic-diet.json')

/** 매니페스트가 싣는 자리만 걷는다(레포 뿌리 전체를 세면 비교가 안 된다). */
const SHIPPED = [
  ['typescript-language-server', 'lib'],
  ['typescript-language-server', 'package.json'],
  ['typescript', 'lib'],
  ['typescript', 'package.json'],
  ['pyright']
]

function walk(root) {
  const out = new Map()
  const rec = (abs, base) => {
    let st
    try {
      st = statSync(abs)
    } catch {
      return
    }
    if (st.isDirectory()) {
      for (const n of readdirSync(abs)) rec(join(abs, n), base)
      return
    }
    out.set(relative(base, abs).replace(/\\/g, '/'), st.size)
  }
  for (const item of SHIPPED) rec(join(root, 'node_modules', ...item), join(root, 'node_modules'))
  return out
}

const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0)
const mb = (n) => +(n / 1048576).toFixed(2)

const filteredFiles = walk(FILTERED)
const repoFiles = walk(REPO)
const missing = [...repoFiles.keys()].filter((k) => !filteredFiles.has(k))
const extra = [...filteredFiles.keys()].filter((k) => !repoFiles.has(k))

const size = {
  repo: { files: repoFiles.size, mb: mb(sum(repoFiles)) },
  filtered: { files: filteredFiles.size, mb: mb(sum(filteredFiles)) },
  removedFiles: missing.length,
  removedMB: mb(missing.reduce((a, k) => a + repoFiles.get(k), 0)),
  removed: missing.map((k) => ({ path: k, mb: mb(repoFiles.get(k)) })).sort((a, b) => b.mb - a.mb),
  unexpectedExtras: extra
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function moduleCmdlines(pid) {
  const ps = `$all = Get-CimInstance Win32_Process
$out = @()
foreach ($c in $all) { if ($c.ParentProcessId -eq ${pid} -or ($all | Where-Object { $_.ProcessId -eq $c.ParentProcessId -and $_.ParentProcessId -eq ${pid} })) { if ($c.CommandLine) { $out += $c.CommandLine } } }
'[' + (($out | ForEach-Object { $_ | ConvertTo-Json -Compress }) -join ',') + ']'`
  try {
    return JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim() || '[]')
  } catch {
    return []
  }
}

async function arm(modulesRoot, cwd, rel, line, ch) {
  const child = spawn(PROBE, ['viewing', cwd, rel, String(line), String(ch)], {
    env: {
      ...process.env,
      CCG_HOME: HOME + '-' + (modulesRoot === FILTERED ? 'filtered' : 'repo'),
      CCG_LSP_NODE: join(FILTERED, 'node.exe'),
      CCG_LSP_MODULES: modulesRoot,
      CCG_LSP_IDLE_TTL_MS: '8000',
      CCG_LSP_SWEEP_MS: '1000',
      CRITIC_HANDSHAKE: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const lines = []
  let buf = ''
  let cmdlines = []
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const s = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!s) continue
      try {
        const o = JSON.parse(s)
        lines.push(o)
        // ★「정말 그 뿌리를 물었는가」 — 동치를 보기 전에 이걸 먼저 본다.
        if (o.phase === 'firstUse') cmdlines = moduleCmdlines(child.pid)
      } catch {
        /* 무시 */
      }
      try {
        child.stdin.write('\n')
      } catch {
        /* 닫혔다 */
      }
    }
  })
  await new Promise((res) => child.on('close', res))
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* 이미 죽었다 */
  }
  const p = (n) => lines.find((l) => l.phase === n) || null
  const want = modulesRoot.replace(/\\/g, '/').toLowerCase()
  return {
    modulesRoot,
    boundToThisRoot: cmdlines.some((c) => c.replace(/\\/g, '/').toLowerCase().includes(want)),
    cmdlineSample: cmdlines.map((c) => c.slice(0, 150)),
    opened: p('opened'),
    firstUse: p('firstUse'),
    hoverAfterReclaim: p('hoverRightAfterReclaim'),
    tokensAfterReclaim: p('tokensRightAfter')
  }
}

mkdirSync(HOME + '-filtered', { recursive: true })
mkdirSync(HOME + '-repo', { recursive: true })

const equivalence = {}
for (const [tag, cwd, rel, line, ch] of [
  ['ts', join(FX, 'ts'), 'src/a.ts', 3, 10],
  ['py', join(FX, 'mix'), 'src/b.py', 2, 6]
]) {
  equivalence[tag] = { filtered: await arm(FILTERED, cwd, rel, line, ch) }
  await sleep(1500)
  equivalence[tag].repo = await arm(REPO, cwd, rel, line, ch)
  await sleep(1500)
  const f = equivalence[tag].filtered
  const r = equivalence[tag].repo
  equivalence[tag].verdict = {
    bothBoundToOwnRoot: f.boundToThisRoot && r.boundToThisRoot,
    sameStatus: f.opened?.status === r.opened?.status,
    sameHover: f.firstUse?.hover === r.firstUse?.hover,
    sameHoverHit: f.firstUse?.hoverHit === r.firstUse?.hoverHit,
    sameDefs: f.firstUse?.defs === r.firstUse?.defs,
    sameTokens: f.firstUse?.tokens === r.firstUse?.tokens,
    tokens: [f.firstUse?.tokens, r.firstUse?.tokens]
  }
}

const evidence = { at: new Date().toISOString(), size, equivalence }
writeFileSync(OUT, JSON.stringify(evidence, null, 1))
console.log(`saved: ${OUT}`)
console.log(JSON.stringify({ size: { ...size, removed: size.removed.slice(0, 8) } }, null, 1))
for (const [k, v] of Object.entries(equivalence)) console.log(`\n■ ${k}`, JSON.stringify(v.verdict))
