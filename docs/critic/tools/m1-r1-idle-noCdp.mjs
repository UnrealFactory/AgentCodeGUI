// 크리틱 M1 R1 — CDP 포트 없는 유휴 메모리(두 앱 대칭). bench/idlemem.mjs는 마운트 감지에
// CDP가 필요해 --remote-debugging-port를 켠 채로 잰다. 디버깅 포트는 두 런타임 모두에서
// 추가 메모리를 쓰므로, "사용자가 실제로 쓰는 상태"의 수치를 따로 남긴다.
// 마운트 감지 대신 고정 유예(bootSec) 후 settleSec를 기다린다 — 두 앱 같은 값.
//
//   node docs/critic/tools/m1-r1-idle-noCdp.mjs [bootSec=12] [settleSec=60]
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { electronProfile, tauriProfile, procTreeMem, killTree, sleep, REPO } from '../../../bench/lib.mjs'

const bootSec = Number(process.argv[2] ?? 12)
const settleSec = Number(process.argv[3] ?? 60)
const out = { at: new Date().toISOString(), bootSec, settleSec, apps: {} }

for (const kind of ['tauri', 'electron']) {
  const p = kind === 'tauri' ? tauriProfile({}) : electronProfile({})
  // 디버깅 포트 제거
  const env = { ...p.env }
  delete env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
  const args = p.args.filter((a) => !a.startsWith('--remote-debugging-port'))
  const child = spawn(p.cmd, args, { env: { ...process.env, ...env }, cwd: p.cwd, stdio: 'ignore' })
  console.log(`[${kind}] pid ${child.pid} (no CDP) — boot ${bootSec}s + settle ${settleSec}s`)
  await sleep((bootSec + settleSec) * 1000)
  const mem = procTreeMem(child.pid)
  out.apps[kind] = mem
  console.log(`[${kind}] WS ${mem.totalWsMB}MB / Priv ${mem.totalPrivMB}MB / ${mem.procs?.length} procs`)
  killTree(child.pid)
  await sleep(3000)
}

fs.writeFileSync(path.join(REPO, 'docs', 'critic', 'm1-r1-idle-noCdp.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify({ tauri: { ws: out.apps.tauri.totalWsMB, priv: out.apps.tauri.totalPrivMB },
  electron: { ws: out.apps.electron.totalWsMB, priv: out.apps.electron.totalPrivMB } }, null, 2))
