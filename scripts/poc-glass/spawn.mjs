// 실험용 앱을 격리 홈으로 띄우고 PID만 남긴다. 사용자의 실앱(설치본)은 건드리지 않는다 —
// 이름 기반 kill 금지, 여기서 뱉은 PID만 정리한다.
//
//   node scripts/poc-glass/spawn.mjs electron
//   node scripts/poc-glass/spawn.mjs tauri
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..', '..')
const which = process.argv[2] ?? 'electron'
const pidFile = path.join(import.meta.dirname, `.pid-${which}`)

const profiles = {
  electron: {
    cmd: path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'),
    args: ['.'],
    env: { CCG_HOME: path.join(REPO, '.bench-home'), NODE_ENV: 'production' }
  },
  tauri: {
    cmd: path.join(REPO, 'target', 'release', 'agentcodegui.exe'),
    args: [],
    env: { CCG_HOME: path.join(REPO, '.bench-home-tauri') }
  }
}
const p = profiles[which]
if (!fs.existsSync(p.cmd)) {
  console.error('없는 실행 파일:', p.cmd)
  process.exit(2)
}
const child = spawn(p.cmd, p.args, {
  cwd: REPO,
  env: { ...process.env, ...p.env },
  stdio: 'ignore'
})
fs.writeFileSync(pidFile, String(child.pid))
console.log('pid', child.pid)
child.on('exit', (c) => {
  try { fs.unlinkSync(pidFile) } catch {}
  console.log('exited', c)
  process.exit(0)
})
