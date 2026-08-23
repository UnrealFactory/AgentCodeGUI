// ── M7 크리틱 — "ready 격차 ~290ms = 첫 ipc_call 워밍업" 귀속 시험 ─────────────
//
// 보고서 §8-1은 원인을 "첫 ipc_call의 워밍업(blocking 풀 기동/채널 초기화 의심)"으로
// 적고 규명을 R2로 미뤘다. 그 문장은 두 갈래로 갈린다:
//   (a) Tauri invoke 다리 자체의 첫 호출  → 채널 종류와 무관하게 첫 호출만 비싸다
//   (b) spawn_blocking 풀의 첫 기동      → lsp/fs/git 채널의 첫 호출만 비싸다
// 두 갈래는 처방이 다르다. (a)면 아무 채널이나 한 번 부르면 되고, (b)면 blocking 팔을
// 한 번 깨워야 한다.
//
// 시험: 문서 시작(addScriptToEvaluateOnNewDocument)에 팔 두 개를 **순서를 바꿔 가며**
// 직렬로 돌린다.
//   arm A = app:get-version   (비블로킹 async 워커 경로)
//   arm N = zzz:critic-none   (비블로킹 + 미구현 — 디스패처만 탄다)
//   arm B = lsp:cached-tokens (blocking 풀 경로. cwd/rel 빈 문자열 → 즉시 null)
//
//   node m7-ipcwarm.mjs --exe <path> [--order AB|BA] [--out file.json]
//
// 격리: CCG_HOME은 %TEMP%/ccg-m7c-warm-<order>. 실홈/실앱 무접촉. 죽이는 것은 내 PID 트리뿐.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, sleep } from '../../../bench/lib.mjs'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const EXE = flag('exe', path.join(os.tmpdir(), 'ccg-m7c-tgt', 'release', 'agentcodegui.exe'))
const ORDER = flag('order', 'AB')
const OUT = flag('out', '')
const N = Number(flag('n', '8'))
const PORT = Number(flag('port', '9381'))

const ARMS = {
  A: { tag: 'A', channel: 'app:get-version', payload: [] },
  N: { tag: 'N', channel: 'zzz:critic-none', payload: [] },
  B: { tag: 'B', channel: 'lsp:cached-tokens', payload: [{ cwd: '', relPath: '' }] }
}
const seq = ORDER.split('').map((c) => ARMS[c]).filter(Boolean)

const SRC = `(() => {
  if (window.__m7warm) return 'already'
  const W = (window.__m7warm = { t0: performance.now(), rows: [], done: false, err: null, invokeAvailAt: null })
  const ARMS = ${JSON.stringify(seq)}
  const N = ${N}
  ;(async () => {
    try {
      let inv = null
      for (let i = 0; i < 60000; i++) {
        inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke
        if (inv) break
        await new Promise((r) => setTimeout(r, 1))
      }
      W.invokeAvailAt = Math.round((performance.now() - W.t0) * 100) / 100
      if (!inv) { W.err = 'invoke 없음'; W.done = true; return }
      for (const arm of ARMS) {
        for (let i = 0; i < N; i++) {
          const t = performance.now()
          let ok = true
          try { await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: arm.channel, payload: arm.payload }) }
          catch (e) { ok = false }
          W.rows.push({ arm: arm.tag, i, ch: arm.channel, ms: Math.round((performance.now() - t) * 1000) / 1000,
                        at: Math.round((performance.now() - W.t0) * 100) / 100, ok })
        }
      }
      W.done = true
    } catch (e) { W.err = String(e && e.message || e); W.done = true }
  })()
  return 'armed'
})()`

const home = path.join(os.tmpdir(), `ccg-m7c-warm-${ORDER}`)
fs.rmSync(home, { recursive: true, force: true })
fs.mkdirSync(home, { recursive: true })

const child = spawn(EXE, [], {
  env: { ...process.env, CCG_HOME: home, CCG_CDP_PORT: String(PORT) },
  cwd: path.dirname(EXE),
  stdio: 'ignore'
})
let out = { order: ORDER, exe: EXE, pid: child.pid, at: new Date().toISOString() }
try {
  const cdp = await connectMainPage(PORT, { timeoutMs: 90000 })
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: SRC }).catch(() => {})
  await cdp.eval(SRC).catch(() => {})
  const t0 = Date.now()
  let w = null
  for (;;) {
    w = await cdp.eval(`window.__m7warm ? JSON.parse(JSON.stringify(window.__m7warm)) : null`).catch(() => null)
    if (w && w.done) break
    if (Date.now() - t0 > 60000) break
    await sleep(200)
  }
  out.probe = w
  if (w && w.rows) {
    const by = {}
    for (const r of w.rows) (by[r.arm] ??= []).push(r.ms)
    out.summary = Object.fromEntries(
      Object.entries(by).map(([k, v]) => {
        const rest = v.slice(1).sort((a, b) => a - b)
        return [k, { first: v[0], restMed: rest.length ? rest[Math.floor(rest.length / 2)] : null, restMax: rest.length ? rest[rest.length - 1] : null, n: v.length }]
      })
    )
  }
  try { cdp.close() } catch { /* closed */ }
} catch (e) {
  out.error = String(e?.message ?? e)
} finally {
  killTree(child.pid)
  await sleep(1200)
  fs.rmSync(home, { recursive: true, force: true })
}
const text = JSON.stringify(out, null, 2)
if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, text) }
console.log(text)
