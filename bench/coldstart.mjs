// 콜드 스타트: 스폰 → 첫 가시 창(winMs), 스폰 → #root 마운트(rootMs).
// 사용: node bench/coldstart.mjs electron|tauri [runs=6]
// 첫 회는 OS 캐시 웜업으로 별도 기록하고, 나머지의 중앙값을 대표값으로 삼는다.
import fs from 'node:fs'
import path from 'node:path'
import { electronProfile, tauriProfile, measureColdStart, median, sleep, REPO } from './lib.mjs'
import { makeFixtureHome } from './fixture.mjs'

const kind = process.argv[2] ?? 'electron'
const runs = Number(process.argv[3] ?? 6)
const profile = kind === 'tauri' ? tauriProfile({}) : electronProfile({})

// 홈을 pair.mjs와 **같은 시드**(단일 채팅 픽스처)로 맞춘다. 안 맞추면 직전에 돌린
// multi.mjs가 남긴 멀티 그리드 4패널 홈에서 재게 되고, 부팅이 하는 일이 통째로 달라져
// 회차 간·앱 간 비교가 무너진다(R3에서 실제로 밟았다 — R2의 243ms는 재현되지 않았다).
// 첫 회차는 원래 웜업으로 대표값에서 빠지므로, 프로필 재생성 비용도 거기서 흡수된다.
if (!process.argv.includes('--keep-home')) {
  fs.rmSync(profile.env.CCG_HOME, { recursive: true, force: true })
  makeFixtureHome(profile.env.CCG_HOME, kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2')
}

const results = []
for (let i = 0; i < runs; i++) {
  const r = await measureColdStart(profile)
  results.push(r)
  console.log(`run ${i + 1}/${runs}: win=${r.winMs}ms paint=${r.paintMs}ms root=${r.rootMs}ms`)
  await sleep(2000)
}

const rest = results.slice(1)
const summary = {
  app: profile.name,
  runs: results,
  firstRun: results[0],
  medianWinMs: median(rest.map((r) => r.winMs)),
  medianRootMs: median(rest.map((r) => r.rootMs)),
  // 웹 콘텐츠의 첫 픽셀 — winMs가 '빈 창'을 세고 있지 않은지 보이게 하는 숫자(lib.mjs)
  medianPaintMs: median(rest.map((r) => r.paintMs)),
  at: new Date().toISOString()
}
console.log(JSON.stringify(summary, null, 2))
const out = path.join(REPO, 'bench', 'results', `coldstart-${profile.name}.json`)
fs.writeFileSync(out, JSON.stringify(summary, null, 2))
console.log('saved:', out)
