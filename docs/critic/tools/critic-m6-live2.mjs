// M6 크리틱 2차 라이브 — (a) 블로킹 격리 재측정(기저선 분리) (b) 한글 커밋 제대로 (c) 큰 트리 응답
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { electronProfile, tauriProfile, connectMainPage, killTree, sleep } from './lib.mjs'
import { makeFixtureHome, FIX_ID } from './fixture.mjs'

const KINDS = (process.argv[2] ?? 'both') === 'both' ? ['electron', 'tauri'] : [process.argv[2]]
const WORK = path.join(os.tmpdir(), 'ccg-m6c2-work')
const EXE = path.join(os.tmpdir(), 'ccg-m6-exe', 'agentcodegui.exe')
const g = (a, cwd = WORK) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function makeWork() {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })
  execFileSync('git', ['-C', WORK, 'init', '-q', '-b', 'main'])
  g(['config', 'user.name', 'Critic']); g(['config', 'user.email', 'critic@example.com'])
  fs.writeFileSync(path.join(WORK, 'normal.txt'), 'a\nb\nc\n')
  fs.writeFileSync(path.join(WORK, '한글 파일.txt'), '가\n나\n')
  g(['add', '-A']); g(['commit', '-qm', 'base'])
  fs.writeFileSync(path.join(WORK, 'normal.txt'), 'a\nB CHANGED\nc\n')
  fs.writeFileSync(path.join(WORK, '한글 파일.txt'), '가\n다 바뀜\n')
  g(['remote', 'add', 'origin', 'https://10.255.255.1/nope.git'])
  // 큰 트리 — 3만 개 파일 / 300 폴더
  const big = path.join(WORK, 'bigtree')
  for (let d = 0; d < 300; d++) {
    const dd = path.join(big, `dir${String(d).padStart(3, '0')}`)
    fs.mkdirSync(dd, { recursive: true })
    for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(dd, `f${i}_한글.txt`), 'x')
  }
}
function makeHome(kind, version) {
  const home = path.join(os.tmpdir(), `ccg-m6c2-home-${kind}`)
  fs.rmSync(home, { recursive: true, force: true })
  makeFixtureHome(home, version)
  const f = path.join(home, 'chats', `${FIX_ID}.json`)
  const c = JSON.parse(fs.readFileSync(f, 'utf8'))
  c.manualCwd = WORK
  if (c.snapshot) c.snapshot.cwd = WORK
  fs.writeFileSync(f, JSON.stringify(c))
  return home
}

async function run(kind) {
  const version = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
  const profile = kind === 'tauri' ? tauriProfile({ port: 9376, exe: EXE }) : electronProfile({ port: 9375 })
  const home = makeHome(kind, version)
  const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env, CCG_HOME: home }, cwd: profile.cwd, stdio: 'ignore' })
  const R = { app: kind }
  let cdp
  try {
    cdp = await connectMainPage(profile.port, { timeoutMs: 60000 })
    await cdp.send('Runtime.enable')
    for (let i = 0; i < 600; i++) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(100) }
    await sleep(1500)
    const W = JSON.stringify(WORK)

    // (0) 워밍업 — 첫 호출 비용을 격리 시험에서 뺀다
    await cdp.eval(`window.api.listDir(${W}, '')`, { awaitPromise: true, timeoutMs: 30000 })

    // (a) 기저선 지연 (git 작업 없음)
    R.baseline = await cdp.eval(
      `(async () => { const l = []
         for (let i=0;i<8;i++){ const a=performance.now(); await window.api.listDir(${W},''); l.push(Math.round(performance.now()-a)); await new Promise(r=>setTimeout(r,250)) }
         return { latencies:l, max:Math.max(...l) } })()`, { awaitPromise: true, timeoutMs: 60000 })

    // (b) 도달 불가 원격에 fetch를 걸어둔 동안의 지연
    R.duringFetch = await cdp.eval(
      `(async () => { const slow = window.api.git.fetch(${W}); const l = []
         for (let i=0;i<8;i++){ const a=performance.now(); await window.api.listDir(${W},''); l.push(Math.round(performance.now()-a)); await new Promise(r=>setTimeout(r,250)) }
         const pending = await Promise.race([slow.then(()=>false), new Promise(r=>setTimeout(()=>r(true),10))])
         return { latencies:l, max:Math.max(...l), stillPending:pending } })()`, { awaitPromise: true, timeoutMs: 60000 })

    // (c) 큰 트리 — 3만 파일 걷기·폴더 나열 응답 시간 + 그 동안 다른 채널
    R.bigTree = await cdp.eval(
      `(async () => {
         const t0=performance.now(); const files = await window.api.listFiles(${W}); const walkMs=Math.round(performance.now()-t0)
         const t1=performance.now(); const rows = await window.api.listDir(${W}, 'bigtree'); const dirMs=Math.round(performance.now()-t1)
         // 걷기 도중 다른 채널이 사나
         const p = window.api.listFiles(${W}); const lat=[]
         for (let i=0;i<5;i++){ const a=performance.now(); await window.api.getVersion?.(); lat.push(Math.round(performance.now()-a)) }
         await p
         return { files: files.length, walkMs, dirRows: rows.length, dirMs, duringWalk: lat } })()`,
      { awaitPromise: true, timeoutMs: 120000 })

    // (d) 한글 + 이모지 커밋 (실제 수정이 있는 파일)
    R.commitKo = await cdp.eval(
      `window.api.git.commit(${W}, ['normal.txt','한글 파일.txt'], '한글 커밋 제목 🎉 — 대시', '본문 첫 줄\\n본문 둘째 줄')`,
      { awaitPromise: true, timeoutMs: 30000 })
    R.onDisk = { subject: g(['log','-1','--pretty=%s']).trim(), body: g(['log','-1','--pretty=%b']).trim(),
                 files: g(['show','--name-only','--pretty=','HEAD']).trim().split('\n') }

    // (e) 커밋할 게 없을 때의 오류 문구
    R.commitNothing = await cdp.eval(`window.api.git.commit(${W}, ['normal.txt'], '없는 변경', '')`,
      { awaitPromise: true, timeoutMs: 30000 })
  } catch (e) { R.error = String(e?.message ?? e) }
  finally { try { cdp?.close() } catch {} ; killTree(child.pid); await sleep(800) }
  return R
}

makeWork()
const all = []
for (const k of KINDS) { const r = await run(k); all.push(r); console.log('=== ' + k + ' ==='); console.log(JSON.stringify(r, null, 1)); makeWork() }
fs.writeFileSync(path.join(os.tmpdir(), 'ccg-m6c2-live.json'), JSON.stringify(all, null, 2))
