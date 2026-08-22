// 콜드 스타트: 스폰 → 첫 가시 창(winMs), 스폰 → #root 마운트(rootMs).
// 사용: node bench/coldstart.mjs electron|tauri [runs=6]
// 첫 회는 OS 캐시 웜업으로 별도 기록하고, 나머지의 중앙값을 대표값으로 삼는다.
import fs from 'node:fs'
import path from 'node:path'
import { electronProfile, tauriProfile, measureColdStart, median, sleep, REPO } from './lib.mjs'

const kind = process.argv[2] ?? 'electron'
const runs = Number(process.argv[3] ?? 6)
const profile = kind === 'tauri' ? tauriProfile({}) : electronProfile({})

const results = []
for (let i = 0; i < runs; i++) {
  const r = await measureColdStart(profile)
  results.push(r)
  console.log(`run ${i + 1}/${runs}: win=${r.winMs}ms root=${r.rootMs}ms`)
  await sleep(2000)
}

const rest = results.slice(1)
const summary = {
  app: profile.name,
  runs: results,
  firstRun: results[0],
  medianWinMs: median(rest.map((r) => r.winMs)),
  medianRootMs: median(rest.map((r) => r.rootMs)),
  at: new Date().toISOString()
}
console.log(JSON.stringify(summary, null, 2))
const out = path.join(REPO, 'bench', 'results', `coldstart-${profile.name}.json`)
fs.writeFileSync(out, JSON.stringify(summary, null, 2))
console.log('saved:', out)
