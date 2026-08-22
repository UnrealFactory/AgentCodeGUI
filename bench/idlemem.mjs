// 유휴 메모리: 부팅 → #root 마운트 → settleSec(기본 60초) 방치 → 프로세스 트리 합산.
// 사용: node bench/idlemem.mjs electron|tauri [settleSec=60]
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { electronProfile, tauriProfile, connectMainPage, procTreeMem, killTree, sleep, REPO } from './lib.mjs'

const kind = process.argv[2] ?? 'electron'
const settleSec = Number(process.argv[3] ?? 60)
const profile = kind === 'tauri' ? tauriProfile({}) : electronProfile({})

const child = spawn(profile.cmd, profile.args, {
  env: { ...process.env, ...profile.env },
  cwd: profile.cwd,
  stdio: 'ignore'
})
console.log('spawned pid', child.pid)

const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
for (;;) {
  const ok = await cdp.eval(profile.mountExpr).catch(() => false)
  if (ok) break
  await sleep(100)
}
cdp.close()
console.log(`mounted — settling ${settleSec}s…`)
await sleep(settleSec * 1000)

const mem = procTreeMem(child.pid)
const summary = { app: profile.name, settleSec, ...mem, at: new Date().toISOString() }
console.log(JSON.stringify(summary, null, 2))
const out = path.join(REPO, 'bench', 'results', `idlemem-${profile.name}.json`)
fs.writeFileSync(out, JSON.stringify(summary, null, 2))
console.log('saved:', out)
killTree(child.pid)
