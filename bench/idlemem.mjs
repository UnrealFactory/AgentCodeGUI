// 유휴 메모리: 부팅 → #root 마운트 → settleSec(기본 60초) 방치 → 프로세스 트리 합산.
// 사용: node bench/idlemem.mjs electron|tauri [settleSec=60] [--no-cdp]
//
// `--no-cdp` = **제품 실사용과 같은 조건**. 대표값(위 경로)은 CDP(--remote-debugging-port)를
// 켠 채로 재는데, 그건 마운트 시점을 알기 위한 계측 장치이고 제품에는 없다. Chromium은
// 그 포트가 열리면 DevTools 호스트를 세우므로 값이 달라질 수 있다 — 두 모드를 **양쪽 앱
// 모두** 재서 차이를 기록해 두면, 대표값 규약을 바꿀지 판단할 근거가 생긴다.
// CDP가 없으면 마운트를 못 보므로 기점은 '첫 가시 창'(Win32)이다 — 양쪽 같은 규칙.
// 산출: --no-cdp는 bench/results/idlemem-nocdp.json에 **앱별 키로 추가**한다
//       (2.6.2 기준 결과 파일 idlemem-electron-2.6.2.json은 건드리지 않는다).
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  electronProfile, tauriProfile, connectMainPage, procTreeMem,
  measureIdle, killTree, sleep, envInfo, REPO
} from './lib.mjs'
import { makeFixtureHome } from './fixture.mjs'

const kind = process.argv[2] ?? 'electron'
const settleSec = Number(process.argv[3] ?? 60)
const noCdp = process.argv.includes('--no-cdp')
const profile = kind === 'tauri' ? tauriProfile({ cdp: !noCdp }) : electronProfile({ cdp: !noCdp })

// coldstart.mjs와 같은 이유로 홈을 **같은 시드**(단일 채팅 픽스처)로 맞춘다.
// 실제로 밟은 사고: `.bench-home`에 multi.mjs가 남긴 멀티 그리드 4패널이 있어서
// Electron 유휴가 704.8MB/7프로세스로 찍혔다(기준값은 단일 채팅 428.1MB/5프로세스).
// 한쪽 홈만 무거우면 앱 간 비교가 통째로 무너진다.
if (!process.argv.includes('--keep-home')) {
  fs.rmSync(profile.env.CCG_HOME, { recursive: true, force: true })
  makeFixtureHome(profile.env.CCG_HOME, kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2')
}

if (noCdp) {
  console.log(`${profile.name}: CDP off · 첫 가시 창 기준 ${settleSec}s 정착…`)
  const mem = await measureIdle(profile, { settleSec, cdp: false, role: true })
  const out = path.join(REPO, 'bench', 'results', 'idlemem-nocdp.json')
  const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {}
  prev.what = '유휴 메모리 — CDP 없이(제품 실사용 조건). 기점은 첫 가시 창, 정착은 고정 시간.'
  prev.env ??= envInfo()
  prev[profile.name] = {
    settleSec,
    totalWsMB: mem.totalWsMB,
    totalPrivMB: mem.totalPrivMB,
    procs: mem.procs?.length,
    procDetail: mem.procs,
    at: new Date().toISOString()
  }
  fs.writeFileSync(out, JSON.stringify(prev, null, 2))
  console.log(JSON.stringify({ ws: mem.totalWsMB, priv: mem.totalPrivMB, procs: mem.procs?.length }))
  console.log('saved:', out)
} else {
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

  const mem = procTreeMem(child.pid, { role: true })
  const summary = { app: profile.name, settleSec, ...mem, at: new Date().toISOString() }
  console.log(JSON.stringify({ ws: mem.totalWsMB, priv: mem.totalPrivMB, procs: mem.procs?.length }))
  const out = path.join(REPO, 'bench', 'results', `idlemem-${profile.name}.json`)
  fs.writeFileSync(out, JSON.stringify(summary, null, 2))
  console.log('saved:', out)
  killTree(child.pid)
}
