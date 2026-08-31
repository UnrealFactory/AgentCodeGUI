#!/usr/bin/env node
/**
 * 확인 크리틱 LSPIDLE R1 — **교환(+499ms)의 크레이트 층 A/B**.
 *
 * 보고서 §3.3의 후퇴는 `bench/lsp.mjs`(앱 전체)에서 잰 값이다. 앱 층에는 렌더러의
 * **400ms status 폴링 격자**가 섞여 있어서, 「기동을 미뤄서 늦어진 몫」과 「늦어진 것을
 * 렌더러가 늦게 알아채는 몫」이 한 숫자에 뭉쳐 있다. 그 둘을 가르려고 여기서는
 * **25ms로 촘촘히** 폴링해 기동 자체의 값만 잰다.
 *
 * 두 팔을 같은 계기로 돌린다:
 *   - `after`  = 지금 코드(`Prewarm::Prepare`)
 *   - `before` = `spec.rs`의 ts를 `Prewarm::Eager`로 되돌린 격리 사본(= R1 이전 동작)
 * 그리고 **부팅 겹침**을 `CRITIC_BOOT_MS`로 흉내 낸다 — 겹칠 시간이 없으면(0ms) 두 팔이
 * 같아야 하고, 겹칠 시간이 있으면(800ms) 그만큼 갈려야 한다. 그 모양이 안 나오면
 * 이 라운드의 인과 설명(「기동이 부팅과 더 이상 안 겹친다」)이 틀린 것이다.
 *
 * ```
 * node docs/critic/tools/critic-lspidle-coldopen.mjs --probe=... --sim=... --fx=... \
 *   --arm=after --n=3 --out=...json
 * ```
 * `before` 팔은 격리 사본에서 한 줄 돌연변이 뒤 다시 굽고 `--arm=before`로 돈다
 * (`crates/ccg-lsp/src/spec.rs`의 첫 `prewarm: Prewarm::Prepare,` → `Eager`).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const arg = (k, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}
const PROBE = arg('probe', 'C:/Temp/ccg-t-critic/debug/critic-idle.exe')
const SIM = arg('sim', 'C:/Temp/ccg-sim-after')
const FX = arg('fx', 'C:/Temp/critic-fx')
const ARM = arg('arm', 'after')
const N = +arg('n', '3')
const OUT = arg('out', `C:/Temp/critic-coldopen-${ARM}.json`)
const HOME = arg('home', 'C:/Temp/critic-home-cold')

function once(bootMs) {
  // ★홈을 매번 지운다 — 토큰 디스크 캐시가 남으면 「캐시 미적중 첫 색칠」이 아니다.
  rmSync(HOME, { recursive: true, force: true })
  const out = execFileSync(PROBE, ['coldopen', join(FX, 'ts'), 'src/a.ts'], {
    env: {
      ...process.env,
      CCG_HOME: HOME,
      CCG_LSP_NODE: join(SIM, 'node.exe'),
      CCG_LSP_MODULES: SIM,
      CRITIC_BOOT_MS: String(bootMs)
    },
    encoding: 'utf8',
    windowsHide: true
  })
  const line = out.split('\n').find((l) => l.includes('"coldOpen"'))
  return line ? JSON.parse(line) : null
}

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? +s[(s.length - 1) >> 1].toFixed(1) : null
}

const runs = {}
for (const boot of [0, 800]) {
  const rows = []
  for (let i = 0; i < N; i++) rows.push(once(boot))
  const ok = rows.filter(Boolean)
  runs[`boot${boot}`] = {
    n: ok.length,
    // 사용자가 **실제로 기다리는 시간** = 파일을 연 순간부터 첫 실토큰까지.
    waitAfterOpenMs: med(ok.map((r) => r.readyMs + r.firstLiveTokensMs)),
    readyMs: med(ok.map((r) => r.readyMs)),
    firstLiveTokensMs: med(ok.map((r) => r.firstLiveTokensMs)),
    sinceStartToTokensMs: med(ok.map((r) => r.sinceStartToTokensMs)),
    cacheHit: ok.every((r) => r.cacheHit === false) ? 'all-miss(의도)' : 'mixed',
    tokens: ok.map((r) => r.tokens),
    raw: ok
  }
}

const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {}
writeFileSync(OUT, JSON.stringify({ ...prev, at: new Date().toISOString(), arm: ARM, probe: PROBE, runs }, null, 1))
console.log(`saved: ${OUT} (arm=${ARM})`)
for (const [k, v] of Object.entries(runs)) {
  console.log(` ${k}: 열람→첫 실토큰 중앙값 ${v.waitAfterOpenMs}ms (ready ${v.readyMs} + tokens ${v.firstLiveTokensMs}) · n=${v.n}`)
}
