#!/usr/bin/env node
/**
 * 확인 크리틱 LSPIDLE **R2** — READY_WAIT(1500ms) 창을 넘기는 서버가 무엇을 돌려주는가.
 *
 * 빌더가 이월하며 이름 붙인 위험: `ready_server`의 `READY_WAIT`는 1500ms 고정인데
 * Roslyn 재기동은 스펙 주석 기준 ~3.1s다 → 회수 뒤 첫 호버가 예산을 넘겨 **조용한 빈손**.
 * 그 위험이 실재하는지를 **실물 ts 서버**에 인위 지연을 물려 확인한다.
 *
 * ★격리 사본에만 돈다. 제품 코드도, 실홈(%USERPROFILE%\.agentcodegui)도 안 건드린다.
 *
 * 준비:
 *   1) git archive d01203b → C:/Temp/critic2-lspidle
 *   2) critic_idle.rs에 `readywait` 모드를 더하고(첫 요청을 곧바로 호버로 건다)
 *      CARGO_TARGET_DIR=C:/Temp/ccg-t-critic2 \
 *        cargo build -p ccg-lsp --bin critic-idle --features cli
 *   3) **지연 껍데기** — 스테이징된 node_modules를 복사한 뒤
 *      typescript-language-server/lib/cli.mjs 를 cli.real.mjs 로 옮기고 그 자리에:
 *
 *        const d = Number(process.env.CRITIC_LSP_DELAY_MS || '0')
 *        if (d > 0) await new Promise((r) => setTimeout(r, d))
 *        await import('./cli.real.mjs')
 *
 *      지연이 initialize 응답 **전에** 일어나야 status가 starting에 머문다.
 *
 * 읽는 법: `firstRequestWhileStarting.hoverHit === false`가 조용한 빈손이다.
 *   `tokens: 0`인데 `tokensWasSome: true`면 **성공한 빈 토큰** — 오류가 아니라 「결과 없음」이라
 *   렌더러가 「여기 심볼 없음」과 구분할 수 없다는 뜻이다.
 *
 * 결과: docs/critic/evidence/r2-readywait.json
 */
import { execFileSync, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const PROBE = 'C:/Temp/ccg-t-critic2/debug/critic-idle.exe'
const arms = [
  { id: 'control-0ms', delay: '0' },
  { id: 'slow-2500ms', delay: '2500' },
  { id: 'slow-3100ms', delay: '3100' } // Roslyn 재기동 ~3.1s(스펙 주석)
]

const out = []
for (const a of arms) {
  const home = `C:/Temp/c3-home-${a.id}`
  const rows = []
  const child = spawn(PROBE, ['readywait', 'C:/Temp/critic-fx/ts', 'src/a.ts', '3', '10'], {
    env: {
      ...process.env,
      CCG_HOME: home,
      CCG_LSP_NODE: 'C:/Temp/c3-slowts/node.exe',
      CCG_LSP_MODULES: 'C:/Temp/c3-slowts',
      CRITIC_LSP_DELAY_MS: a.delay
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!l) continue
      try {
        rows.push(JSON.parse(l))
      } catch {}
    }
  })
  // ★스폰한 PID만 트리째 접는다(이름 기반 kill 금지 — 실앱이 떠 있다).
  await new Promise((r) => {
    child.on('close', r)
    setTimeout(() => {
      try {
        execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' })
      } catch {}
    }, 120000)
  })
  const first = rows.find((x) => x.phase === 'firstRequestWhileStarting')
  const after = rows.find((x) => x.phase === 'afterReady')
  out.push({ arm: a.id, delayMs: +a.delay, first, after })
  console.log(
    `[${a.id}] 첫 호버: ${first?.hoverMs?.toFixed(0)}ms hit=${first?.hoverHit} · 토큰 ${first?.tokens}개(Some=${first?.tokensWasSome}) · status="${first?.statusNow}" · projectStatus=${JSON.stringify(first?.projectStatus)}`
  )
  console.log(`[${a.id}] ready까지 ${after?.readyAfterMs?.toFixed(0)}ms → 그 뒤 호버 hit=${after?.hoverHit}`)
}

writeFileSync(
  'C:/Code/AgentCodeGUI/docs/critic/evidence/r2-readywait.json',
  JSON.stringify({ at: new Date().toISOString(), note: 'READY_WAIT(1500ms) 창을 인위 지연 서버로 넘겨 본다', arms: out }, null, 1)
)
console.log('saved')
