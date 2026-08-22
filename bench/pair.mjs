// 교대 측정 — Electron과 Tauri를 A/B/A/B로 번갈아 재서 CPU 부하를 양쪽이 똑같이 받게 한다.
// 병렬로 다른 에이전트가 도는 환경에서 단독 측정은 "먼저 잰 쪽이 유리한" 편향이 생긴다.
// 사용: node bench/pair.mjs [runs=6]
// 산출: bench/results/pair-coldstart.json (양쪽 중앙값 + 개별 회차 + 비율)
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  electronProfile, tauriProfile, measureColdStart, connectMainPage,
  procTreeMem, killTree, median, sleep, envInfo, binInfo, REPO
} from './lib.mjs'
import { makeFixtureHome } from './fixture.mjs'

const runs = Number(process.argv[2] ?? 6)
const el = electronProfile({})
const ta = tauriProfile({})

if (!fs.existsSync(ta.cmd)) {
  console.error(`Tauri 릴리즈 exe가 없다: ${ta.cmd}\n먼저 npm run tauri:build 를 돌려라.`)
  process.exit(2)
}

// 두 홈을 같은 시드로 맞춘다 — 한쪽에만 긴 스레드 픽스처가 남아 있으면 그쪽이
// 부팅에 더 많은 일을 하게 돼 비교가 무너진다. (스크롤/스트리밍 측정이 .bench-home에
// 픽스처를 남기므로 실제로 일어나는 사고다.)
fs.rmSync(el.env.CCG_HOME, { recursive: true, force: true })
fs.rmSync(ta.env.CCG_HOME, { recursive: true, force: true })
makeFixtureHome(el.env.CCG_HOME, '2.6.2')
makeFixtureHome(ta.env.CCG_HOME, '3.0.0-beta.1')

const out = { env: envInfo(), bin: binInfo(ta.cmd), seeded: 'fixture(471) both', runs: [], at: new Date().toISOString() }

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
  console.log(
    `pair ${i + 1}/${runs}: electron win=${e.winMs} paint=${e.paintMs} root=${e.rootMs} [${e.winW}x${e.winH} "${e.winTitle}"]` +
    ` | tauri win=${t.winMs} paint=${t.paintMs} root=${t.rootMs} [${t.winW}x${t.winH} "${t.winTitle}"]`
  )
}

const pick = (app, key) => median(out.runs.map((r) => r[app][key]))
// ★ paintMs는 **두 앱이 같은 사건을 재는 유일한 지표**다(R3 크리틱 §4.3).
//   winMs는 Electron이 300×240 스플래시(이미 그려진 창), Tauri가 풀사이즈 메인 창
//   (아직 안 그려진 창)이라 애초에 비교가 성립하지 않는다. 그래서 여기서도
//   두 앱의 **첫 창 크기·제목을 같이 남긴다** — 비교가 성립하는지 파일만 보면 안다.
out.summary = {
  electron: { winMs: pick('electron', 'winMs'), paintMs: pick('electron', 'paintMs'), rootMs: pick('electron', 'rootMs') },
  tauri: { winMs: pick('tauri', 'winMs'), paintMs: pick('tauri', 'paintMs'), rootMs: pick('tauri', 'rootMs') }
}
out.summary.firstWindow = {
  electron: `${pick('electron', 'winW')}x${pick('electron', 'winH')} "${out.runs.find((r) => r.electron.winTitle)?.electron.winTitle ?? ''}"`,
  tauri: `${pick('tauri', 'winW')}x${pick('tauri', 'winH')} "${out.runs.find((r) => r.tauri.winTitle)?.tauri.winTitle ?? ''}"`,
  note: '두 값이 다르면 winMs 비교는 서로 다른 사건을 비교하는 것이다 — paintMs를 봐라.'
}
const ratio = (a, b) => (a && b ? Math.round((b / a) * 100) / 100 : null)
out.summary.ratio = {
  winMs: ratio(out.summary.electron.winMs, out.summary.tauri.winMs),
  paintMs: ratio(out.summary.electron.paintMs, out.summary.tauri.paintMs),
  rootMs: ratio(out.summary.electron.rootMs, out.summary.tauri.rootMs)
}
out.summary.pass = {
  // 목표: 절반 이하 = 비율 ≤ 0.5
  winMs: out.summary.ratio.winMs != null && out.summary.ratio.winMs <= 0.5,
  paintMs: out.summary.ratio.paintMs != null && out.summary.ratio.paintMs <= 0.5,
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
