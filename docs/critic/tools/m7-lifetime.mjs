import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
const WT = path.join(os.tmpdir(), 'ccg-m7c-wt')
const PROBE = path.join(os.tmpdir(), 'ccg-m7c-tgt2', 'release', 'ccg-lspprobe.exe')
const BASE = path.join(os.tmpdir(), 'ccg-m7c-fakelsp')
const WORK = path.join(os.tmpdir(), 'ccg-lsp-repo') // 정규형(백슬래시) — C-3을 안 건드린다
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (p) => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', `if (Get-Process -Id ${p} -ErrorAction SilentlyContinue) {'1'} else {'0'}`], { encoding: 'utf8' }).trim() === '1'
  } catch { return false }
}
const out = { at: new Date().toISOString(), work: WORK }

// ① 유휴 회수 (TTL 4s · 스윕 1s 주입)
{
  const log = path.join(os.tmpdir(), 'ccg-m7c-flsp-idle2.jsonl'); fs.rmSync(log, { force: true })
  const home = path.join(os.tmpdir(), 'ccg-m7c-home-idle2'); fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true })
  const raw = execFileSync(PROBE, [WORK, 'lspbench/big.ts', '2'], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 32 << 20,
    env: { ...process.env, CCG_LSP_MODULES: BASE, CCG_HOME: home, FLSP_LOG: log, FLSP_SYNC: '2', CCG_LSP_IDLE_TTL_MS: '4000', CCG_LSP_SWEEP_MS: '1000' }
  })
  out.idleReclaim = JSON.parse(raw.trim().split('\n').pop()).idleReclaim
}

// ② 잡 안전망 — 서버를 띄운 채 프로브를 /T 없이 강제 종료
{
  const log = path.join(os.tmpdir(), 'ccg-m7c-flsp-job2.jsonl'); fs.rmSync(log, { force: true })
  const home = path.join(os.tmpdir(), 'ccg-m7c-home-job2'); fs.rmSync(home, { recursive: true, force: true }); fs.mkdirSync(home, { recursive: true })
  const child = spawn(PROBE, [WORK, 'lspbench/big.ts', '2'], {
    stdio: 'ignore',
    env: { ...process.env, CCG_LSP_MODULES: BASE, CCG_HOME: home, FLSP_LOG: log, FLSP_SYNC: '2', CCG_LSPPROBE_HOLD_MS: '25000' }
  })
  await sleep(8000)
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const pids = lines.filter((l) => l.ev === 'start').map((l) => l.pid)
  out.jobSafety = { probePid: child.pid, serverPidsSeen: pids, aliveBeforeKill: pids.filter(alive), method: 'Stop-Process -Force (트리 종료 아님)' }
  execFileSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${child.pid} -Force`], { stdio: 'ignore' })
  await sleep(4000)
  out.jobSafety.aliveAfter4s = pids.filter(alive)
  out.jobSafety.leaked = out.jobSafety.aliveAfter4s.length
}
fs.writeFileSync(path.join(WT, 'docs', 'critic', 'm7-r1-lifetime.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
