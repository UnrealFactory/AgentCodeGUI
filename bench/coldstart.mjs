// 콜드 스타트: 스폰 → 첫 가시 창(winMs), 스폰 → 첫 픽셀(paintMs), 스폰 → #root 마운트(rootMs).
// 사용: node bench/coldstart.mjs electron|tauri [runs=6] [--out=이름]
// 첫 회는 OS 캐시 웜업으로 별도 기록하고, 나머지의 중앙값을 대표값으로 삼는다.
//
// ## 대표 지표는 paintMs다 (R3 크리틱 §4.3 · §9-5)
// `winMs`끼리의 비교는 **서로 다른 사건을 비교한다.**
//   2.6.2 : 첫 가시 창 = 300×240 스플래시 BrowserWindow, `ready-to-show`(이미 그려진 뒤)
//   3.0   : 첫 가시 창 = 풀사이즈 메인 창, "렌더 차단 CSS 준비"(아직 한 프레임도 안 올라감)
// 감시자의 200×200 필터는 둘을 같은 것으로 취급한다. 그래서 이제 잡은 창의 크기·제목을
// 회차마다 남기고(winW/winH/winTitle), **두 앱 모두 paintMs를 항상 기록한다.**
// R3 보고서에는 Electron의 paintMs가 아예 없었다 — 그게 3.0의 유일한 ≤0.5 승점이었는데도.
import fs from 'node:fs'
import path from 'node:path'
import { electronProfile, tauriProfile, measureColdStart, median, sleep, provenance, envInfo, REPO } from './lib.mjs'
import { makeFixtureHome } from './fixture.mjs'

const kind = process.argv[2] ?? 'electron'
const runsArg = process.argv[3]
const runs = Number(runsArg && !runsArg.startsWith('--') ? runsArg : 6)
const outName = (process.argv.find((a) => a.startsWith('--out=')) ?? '').split('=')[1] || null
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
  console.log(`run ${i + 1}/${runs}: win=${r.winMs}ms paint=${r.paintMs}ms root=${r.rootMs}ms  [첫 창 ${r.winW}x${r.winH} "${r.winTitle}"]`)
  await sleep(2000)
}

const rest = results.slice(1)
const prov = provenance(profile)
const summary = {
  app: profile.name,
  ...prov,
  runs: results,
  firstRun: results[0],
  medianWinMs: median(rest.map((r) => r.winMs)),
  medianRootMs: median(rest.map((r) => r.rootMs)),
  // 웹 콘텐츠의 첫 픽셀 — **대표 비교 지표**(두 앱이 같은 사건을 잰다)
  medianPaintMs: median(rest.map((r) => r.paintMs)),
  // winMs가 무슨 창을 쟀는지 (§9-5). 두 앱의 이 값이 다르면 winMs 비교는 무효다.
  firstWindow: {
    w: median(rest.map((r) => r.winW)),
    h: median(rest.map((r) => r.winH)),
    title: rest.find((r) => r.winTitle)?.winTitle ?? null
  },
  env: envInfo(),
  at: new Date().toISOString()
}
console.log(JSON.stringify({ ...summary, runs: undefined }, null, 2))
// 박제 기준 파일(coldstart-<app>.json)은 갱신하지 않는다 — `--out=`으로 새 파일에 쓴다.
const base = outName ?? `coldstart-${profile.name}`
const out = path.join(REPO, 'bench', 'results', `${base}.json`)
fs.writeFileSync(out, JSON.stringify(summary, null, 2))
console.log('saved:', path.relative(REPO, out))
