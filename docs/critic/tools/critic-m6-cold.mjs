// 마운트 직후 **첫 fs/git IPC**의 비용 (워밍업 없이). 탐색기 첫 그림이 걸리는 자리.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { electronProfile, tauriProfile, connectMainPage, killTree, sleep } from './lib.mjs'
import { makeFixtureHome, FIX_ID } from './fixture.mjs'

const WORK = path.join(os.tmpdir(), 'ccg-m6c3-work')
const EXE = path.join(os.tmpdir(), 'ccg-m6-exe', 'agentcodegui.exe')
fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(WORK, { recursive: true })
execFileSync('git', ['-C', WORK, 'init', '-q', '-b', 'main'])
for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(WORK, `f${i}.txt`), 'x')
execFileSync('git', ['-C', WORK, 'add', '-A'])
execFileSync('git', ['-C', WORK, '-c', 'user.name=C', '-c', 'user.email=c@e.com', 'commit', '-qm', 'base'])

async function run(kind, round) {
  const version = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
  const profile = kind === 'tauri' ? tauriProfile({ port: 9386, exe: EXE }) : electronProfile({ port: 9385 })
  const home = path.join(os.tmpdir(), `ccg-m6c3-home-${kind}`)
  fs.rmSync(home, { recursive: true, force: true })
  makeFixtureHome(home, version)
  const f = path.join(home, 'chats', `${FIX_ID}.json`)
  const c = JSON.parse(fs.readFileSync(f, 'utf8')); c.manualCwd = WORK
  if (c.snapshot) c.snapshot.cwd = WORK
  fs.writeFileSync(f, JSON.stringify(c))
  const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env, CCG_HOME: home }, cwd: profile.cwd, stdio: 'ignore' })
  let r = null
  try {
    const cdp = await connectMainPage(profile.port, { timeoutMs: 60000 })
    await cdp.send('Runtime.enable')
    for (let i = 0; i < 600; i++) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(100) }
    await sleep(1200)
    r = await cdp.eval(
      `(async () => { const l=[]
         for (let i=0;i<5;i++){ const a=performance.now(); await window.api.listDir(${JSON.stringify(WORK)},''); l.push(Math.round(performance.now()-a)) }
         const b=performance.now(); const st=await window.api.git.status(${JSON.stringify(WORK)}); const gitMs=Math.round(performance.now()-b)
         return { listDir:l, gitStatusMs:gitMs, files:st.files.length } })()`,
      { awaitPromise: true, timeoutMs: 60000 })
    cdp.close()
  } catch (e) { r = { error: String(e?.message ?? e) } }
  killTree(child.pid); await sleep(700)
  return { kind, round, ...r }
}

const rows = []
for (const round of [1, 2, 3]) for (const k of ['electron', 'tauri']) rows.push(await run(k, round))
console.log(JSON.stringify(rows, null, 1))
