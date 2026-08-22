// 교대 측정 — Electron과 Tauri를 A/B/A/B로 번갈아 재서 CPU 부하를 양쪽이 똑같이 받게 한다.
// 병렬로 다른 에이전트가 도는 환경에서 단독 측정은 "먼저 잰 쪽이 유리한" 편향이 생긴다.
// 사용: node bench/pair.mjs [runs=6]
// 산출: bench/results/pair-coldstart.json (양쪽 중앙값 + 개별 회차 + 비율)
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  electronProfile, tauriProfile, measureColdStart, connectMainPage,
  procTreeMem, killTree, median, sleep, envInfo, REPO
} from './lib.mjs'

const runs = Number(process.argv[2] ?? 6)
const el = electronProfile({})
const ta = tauriProfile({})

if (!fs.existsSync(ta.cmd)) {
  console.error(`Tauri 릴리즈 exe가 없다: ${ta.cmd}\n먼저 npm run tauri:build 를 돌려라.`)
  process.exit(2)
}

const out = { env: envInfo(), runs: [], at: new Date().toISOString() }

// 웜업 1회씩 (OS 파일 캐시 — 첫 회는 항상 느리므로 대표값에서 제외)
console.log('warmup…')
await measureColdStart(el)
await sleep(1500)
await measureColdStart(ta)
await sleep(1500)

for (let i = 0; i < runs; i++) {
  const e = await measureColdStart(el)
  await sleep(1500)
  const t = await measureColdStart(ta)
  await sleep(1500)
  out.runs.push({ i: i + 1, electron: e, tauri: t })
  console.log(`pair ${i + 1}/${runs}: electron win=${e.winMs} root=${e.rootMs} | tauri win=${t.winMs} root=${t.rootMs}`)
}

const pick = (app, key) => median(out.runs.map((r) => r[app][key]))
out.summary = {
  electron: { winMs: pick('electron', 'winMs'), rootMs: pick('electron', 'rootMs') },
  tauri: { winMs: pick('tauri', 'winMs'), rootMs: pick('tauri', 'rootMs') }
}
const ratio = (a, b) => (a && b ? Math.round((b / a) * 100) / 100 : null)
out.summary.ratio = {
  winMs: ratio(out.summary.electron.winMs, out.summary.tauri.winMs),
  rootMs: ratio(out.summary.electron.rootMs, out.summary.tauri.rootMs)
}
out.summary.pass = {
  // 목표: 절반 이하 = 비율 ≤ 0.5
  winMs: out.summary.ratio.winMs != null && out.summary.ratio.winMs <= 0.5,
  rootMs: out.summary.ratio.rootMs != null && out.summary.ratio.rootMs <= 0.5
}

// ── 유휴 메모리도 교대로 (부팅 → 마운트 → 60초 정착 → 트리 합산) ──
async function idle(profile) {
  const child = spawn(profile.cmd, profile.args, {
    env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore'
  })
  try {
    const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
    for (;;) {
      if (await cdp.eval(profile.mountExpr).catch(() => false)) break
      await sleep(100)
    }
    cdp.close()
    await sleep(60000)
    return procTreeMem(child.pid)
  } finally {
    killTree(child.pid)
    await sleep(1500)
  }
}
console.log('idle memory (electron)…')
const elMem = await idle(el)
console.log('idle memory (tauri)…')
const taMem = await idle(ta)
out.idle = {
  electron: { totalWsMB: elMem.totalWsMB, totalPrivMB: elMem.totalPrivMB, procs: elMem.procs?.length },
  tauri: { totalWsMB: taMem.totalWsMB, totalPrivMB: taMem.totalPrivMB, procs: taMem.procs?.length },
  ratio: {
    wsMB: ratio(elMem.totalWsMB, taMem.totalWsMB),
    privMB: ratio(elMem.totalPrivMB, taMem.totalPrivMB)
  },
  procDetail: { electron: elMem.procs, tauri: taMem.procs }
}
out.idle.pass = { wsMB: out.idle.ratio.wsMB <= 0.5, privMB: out.idle.ratio.privMB <= 0.5 }

console.log(JSON.stringify({ summary: out.summary, idle: { ...out.idle, procDetail: undefined } }, null, 2))
fs.writeFileSync(path.join(REPO, 'bench', 'results', 'pair-coldstart.json'), JSON.stringify(out, null, 2))
console.log('saved: bench/results/pair-coldstart.json')
