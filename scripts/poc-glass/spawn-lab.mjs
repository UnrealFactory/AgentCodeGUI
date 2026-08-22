// 실험대(electron-lab) 하나를 띄우고 PID만 남긴다. 이름 기반 kill 금지 —
// 사용자 실앱과 다른 에이전트의 벤치가 같은 이름으로 떠 있다.
//
//   node scripts/poc-glass/spawn-lab.mjs MAT=acrylic FIX=none TAG=A-acrylic-nofix X=120 Y=120 W=900 H=560
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const HERE = import.meta.dirname
const REPO = path.resolve(HERE, '..', '..')
const env = { ...process.env }
for (const a of process.argv.slice(2)) {
  const i = a.indexOf('=')
  if (i > 0) env['LAB_' + a.slice(0, i)] = a.slice(i + 1)
}
const exe = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!fs.existsSync(exe)) {
  console.error('없는 실행 파일:', exe)
  process.exit(2)
}
const child = spawn(exe, [path.join(HERE, 'electron-lab')], {
  cwd: REPO,
  env,
  detached: true,
  stdio: 'ignore'
})
child.unref()
fs.writeFileSync(path.join(HERE, '.pid-lab'), String(child.pid))
console.log(child.pid)
