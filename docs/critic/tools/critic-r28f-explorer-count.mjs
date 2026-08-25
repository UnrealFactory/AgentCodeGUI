// 최종 파리티 R3 — `explorer-tree`의 `found` **103 vs 105**를 같은 시각·같은 트리로 확인.
//
//   node docs/critic/tools/critic-r28f-explorer-count.mjs --exe=<3.0 exe> \
//        [--porta=10532] [--portb=10533] [--rounds=2] [--out=json]
//
// ── 왜 ────────────────────────────────────────────────────────────────────────
// R2의 A/B는 3.0(05:51Z)과 2.6.2(05:55Z)를 **4분 떨어뜨려** 돌았다. 그 4분 사이에 옆
// 갈래들이 레포 루트에 `target-*` 디렉터리를 만든다(측정 시점 루트에 61개가 있었다).
// 그러면 탐색기 행 수가 달라지고, 그건 **앱 차이가 아니라 픽스처 노이즈**다.
// 이 도구는 두 앱을 **동시에** 띄워 같은 순간의 루트를 재고, 측정 전후로 루트 목록을
// 스냅샷해 「그 사이에 트리가 변했는가」를 같이 남긴다. 행 라벨도 전부 남겨 차집합을 뜬다.
//
// 안전 규약: 픽스처가 복사한 `accounts.json`은 기동 전에 지운다. 2.6.2는 `auth.ts:76`이
// `os.homedir()`를 하드코딩해 `CCG_HOME`을 무시하므로 `USERPROFILE`도 같이 돌린다
// (`--userprofile=`). 그래야 실계정에 손이 안 간다.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { electronProfile, tauriProfile, cdpTargets, Cdp, killTree, sleep, REPO } from '../../../bench/lib.mjs'
import { makeFixtureHome } from '../../../bench/fixture.mjs'
import { augmentFixture } from '../../../bench/screens.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const PORT_T = Number(arg('porta', 10532))
const PORT_E = Number(arg('portb', 10533))
const ROUNDS = Number(arg('rounds', 2))
const HOMEROOT = arg('homeroot', 'C:\\Temp\\ccg-r28f-audit')
const UPROF = arg('userprofile', 'C:\\Temp\\ccg-r28f-audit\\uprof-ex')
const TREE = path.resolve(arg('tree', REPO)) // 탐색기가 그릴 폴더 = 픽스처 채팅의 cwd
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'critic', 'final-parity-r3-explorer.json')))

const rootSnap = () => {
  const names = fs.readdirSync(TREE).sort()
  return { n: names.length, dot: names.filter((x) => x.startsWith('.')).length, targets: names.filter((x) => x.startsWith('target')).length, names }
}

async function connectMain(port, timeoutMs = 90000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const ts = await cdpTargets(port)
      const t = ts.find((x) => x.type === 'page' && !x.url.startsWith('data:') && !/toast\.html|tray\.html/.test(x.url) && !x.url.includes('#') && /index\.html|localhost/.test(x.url))
      if (t?.webSocketDebuggerUrl) return await Cdp.connect(t.webSocketDebuggerUrl)
    } catch { /* 아직 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('main target not found')
    await sleep(80)
  }
}

function launch(kind, round) {
  const home = path.join(HOMEROOT, `home-ex-${kind}-${round}`)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 잠기면 덮어쓴다 */ }
  makeFixtureHome(home, kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2')
  augmentFixture(home, { repo: TREE })
  for (const f of ['accounts.json', 'codex-accounts.json']) {
    const p = path.join(home, f)
    if (fs.existsSync(p)) fs.rmSync(p)
  }
  const port = kind === 'tauri' ? PORT_T : PORT_E
  const profile = kind === 'tauri' ? tauriProfile({ port, exe: arg('exe', undefined) }) : electronProfile({ port })
  if (kind !== 'tauri') profile.args = ['.', `--remote-debugging-port=${port}`]
  const extra = {}
  if (kind !== 'tauri') {
    fs.mkdirSync(path.join(UPROF, '.agentcodegui'), { recursive: true })
    for (const f of ['accounts.json', 'codex-accounts.json']) { try { fs.rmSync(path.join(UPROF, '.agentcodegui', f)) } catch { /* 없으면 그만 */ } }
    extra.USERPROFILE = UPROF
    extra.HOMEDRIVE = UPROF.slice(0, 2)
    extra.HOMEPATH = UPROF.slice(2)
  }
  const child = spawn(profile.cmd, profile.args, {
    env: { ...process.env, ...profile.env, ...extra, CCG_HOME: home },
    cwd: profile.cwd,
    stdio: 'ignore'
  })
  return { kind, home, port, pid: child.pid, child }
}

/** 탐색기를 열고 `.fxr` 행 전부의 라벨을 뜬다(A/B 하네스의 `explorer-tree`와 같은 셀렉터). */
const MEASURE = `(async () => {
  const q = (s) => document.querySelector(s)
  const all = (s) => [...document.querySelectorAll(s)]
  if (!q('.lcol .explorer')) {
    document.activeElement?.blur?.()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '\`', bubbles: true }))
  }
  for (let i = 0; i < 120; i++) {
    if (all('.lcol .explorer .fxtree .fxr').length) break
    await new Promise((r) => setTimeout(r, 150))
  }
  await new Promise((r) => setTimeout(r, 1200))
  const rows = all('.lcol .explorer .fxtree .fxr')
  return JSON.stringify({
    found: rows.length,
    head: (q('.chat-head') || {}).textContent?.replace(/\\s+/g, ' ').trim().slice(0, 120) ?? null,
    labels: rows.map((r) => (r.textContent || '').replace(/\\s+/g, ' ').trim()).slice(0, 400)
  })
})()`

const out = { at: new Date().toISOString(), tree: TREE, rounds: [] }

for (let r = 1; r <= ROUNDS; r++) {
  const order = r % 2 === 1 ? ['tauri', 'electron'] : ['electron', 'tauri']
  const before = rootSnap()
  const procs = order.map((k) => launch(k, r))
  const rec = { round: r, launchOrder: order, rootBefore: { n: before.n, dot: before.dot, targets: before.targets }, apps: {} }
  try {
    for (const p of procs) {
      const cdp = await connectMain(p.port)
      await cdp.send('Runtime.enable').catch(() => {})
      for (let k = 0; k < 400; k++) {
        const ok = await cdp.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`).catch(() => false)
        if (ok) break
        await sleep(150)
      }
      p.cdp = cdp
    }
    await sleep(9000) // 두 앱에 같은 정착 시간
    // ★같은 순간에 잰다 — 두 eval을 동시에 던진다
    const t0 = Date.now()
    const res = await Promise.all(procs.map((p) => p.cdp.eval(MEASURE, { awaitPromise: true, timeoutMs: 60000 }).catch((e) => 'THROW ' + e.message)))
    rec.measuredWithinMs = Date.now() - t0
    procs.forEach((p, i) => {
      let v = res[i]
      try { v = JSON.parse(v) } catch { /* THROW 문자열 */ }
      rec.apps[p.kind] = { pid: p.pid, home: p.home, ...(typeof v === 'object' ? v : { raw: v }) }
    })
  } catch (e) {
    rec.fatal = String(e.stack ?? e).slice(0, 500)
  } finally {
    for (const p of procs) { try { p.cdp?.close() } catch { /* 닫힘 */ } killTree(p.pid) }
  }
  const after = rootSnap()
  rec.rootAfter = { n: after.n, dot: after.dot, targets: after.targets }
  rec.rootChangedDuringRound = before.n !== after.n
  const T = rec.apps.tauri?.labels ?? []
  const E = rec.apps.electron?.labels ?? []
  rec.found = { tauri: rec.apps.tauri?.found ?? null, electron: rec.apps.electron?.found ?? null }
  rec.onlyInTauri = T.filter((x) => !E.includes(x))
  rec.onlyInElectron = E.filter((x) => !T.includes(x))
  out.rounds.push(rec)
  console.log(`[round ${r}] order=${order.join('>')} found T=${rec.found.tauri} E=${rec.found.electron} · Δ내부시간 ${rec.measuredWithinMs}ms · 루트 ${rec.rootBefore.n}→${rec.rootAfter.n} · onlyT=${JSON.stringify(rec.onlyInTauri)} onlyE=${JSON.stringify(rec.onlyInElectron)}`)
  await sleep(2500)
}

out.verdict = out.rounds.every((r) => r.found.tauri === r.found.electron)
  ? '같은 시각·같은 트리에서 두 앱의 행 수가 **같다** — R2의 103 vs 105는 측정 시각 차이(픽스처 노이즈)다'
  : '같은 시각에도 다르다 — 앱 차이 후보'
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(`\n${out.verdict}\nsaved: ${OUT}`)
