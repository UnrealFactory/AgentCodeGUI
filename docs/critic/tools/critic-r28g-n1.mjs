// 최종 파리티 R5 — **출하 차단 N1 재판정**: Codex 계정 축 다섯 채널을 화면에서 다시 누른다.
//
//   node docs/critic/tools/critic-r28g-n1.mjs --exe=<3.0 exe> [--port=10622] [--out=json]
//
// ── 왜 다시 재나 ─────────────────────────────────────────────────────────────
// 감사 R3·R4는 「치명 2 · 출하 불가」로 닫았고 그중 하나가 N1(Codex 계정 축 5채널이
// `{__unimplemented:true}`)이었다. 그 뒤 SHIPBLOCK 갈래가 `efdc08c`·`521221d`·`1e47a06`·
// `8dd4678`로 배선을 넣었고, 그 갈래의 확인 크리틱 R2가 「닫혔다」고 적었다.
// **감사는 남의 보고서로 출하를 판정하지 않는다.** 내 exe·내 격리 홈으로 화면에서 다시 누른다.
//
// ── 무엇을 재나 ──────────────────────────────────────────────────────────────
//  ① 「맨 위로」 해피패스 — 목록이 **안 증발**하는가 · 디스크 순서가 진짜로 뒤집히는가
//  ② 「계정 추가」 해피패스 — 가짜 codex CLI(.cmd 셰임)로 새 행이 붙는가
//  ③ 원시 다섯 채널(`__TAURI_INTERNALS__.invoke('ipc_call', …)`) — `__unimplemented` 인가
//  ④ ★구조 처방 대조군 — **셸 응답만** `{__unimplemented:true}`로 위조해
//     (`__TAURI_INTERNALS__.invoke`를 감싼다) 심(`callStrict`)과 렌더러가 **제품 코드 그대로**
//     목록을 지키고 문구를 세우는지 본다. 재빌드 없이 「그 채널만 미구현」을 만드는 판이다.
//  ⑤ 「띄울 codex가 없다」 — `CCG_CODEX_BIN`을 없는 경로로 두고 「계정 추가」를 눌러
//     화면이 **사유를 말하는가**(2.6.2는 목록을 그대로 돌려줘 「눌렀는데 아무 일도 없다」였다)
//
// ── 안전 ─────────────────────────────────────────────────────────────────────
// 계정은 전부 합성(`@example.invalid`)이고 실홈은 읽지도 복사하지도 않는다(픽스처가 복사한
// 것은 기동 **전에** 삭제). `CCG_NO_NET=1`. 이름 기반 kill 0 — 내가 스폰한 PID만.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { tauriProfile, cdpTargets, Cdp, killTree, sleep, REPO } from '../../../bench/lib.mjs'
import { makeFixtureHome } from '../../../bench/fixture.mjs'
import { augmentFixture } from '../../../bench/screens.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const PORT = Number(arg('port', 10622))
const ROOT = arg('root', 'C:\\Temp\\ccg-r28g-audit')
const RUNS = Number(arg('runs', 1))
const ARM = arg('arm', 'main') // main | nocli
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'critic', `final-parity-r5-n1${ARM === 'main' ? '' : '-' + ARM}.json`)))
const EXE = arg('exe', undefined)

const ONE = 'r5-one@example.invalid'
const TWO = 'r5-two@example.invalid'

const b64u = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const idToken = (email, plan) => `${b64u('{"alg":"none"}')}.${b64u(JSON.stringify({ email, 'https://api.openai.com/auth': { chatgpt_plan_type: plan } }))}.sig`
const authJson = (email, plan) => JSON.stringify({ tokens: { id_token: idToken(email, plan), access_token: 'synthetic-r5', refresh_token: 'synthetic-r5' }, last_refresh: new Date().toISOString() })

/** 합성 codex 스토어 — v1 · 두 계정. `authEnc`는 목록·재정렬 경로가 안 읽는다(복호 불필요). */
function plantCodexStore(home) {
  fs.writeFileSync(path.join(home, 'codex-accounts.json'), JSON.stringify({
    version: 1,
    defaultEmail: ONE,
    accounts: [
      { email: ONE, plan: 'plus', authEnc: Buffer.from(authJson(ONE, 'plus')).toString('base64') },
      { email: TWO, plan: 'pro', authEnc: Buffer.from(authJson(TWO, 'pro')).toString('base64') }
    ]
  }, null, 2))
}

/**
 * 가짜 codex CLI — `login`이면 `%CODEX_HOME%\auth.json`을 떨구고 즉시 exit 0.
 * **호출마다 다른 이메일**을 쓴다(`slot1.json`·`slot2.json`…) — 같은 이메일이면 두 번째
 * 로그인이 새 행을 안 만들어(같은 계정 갱신) 「추가됐다」를 못 잰다.
 */
function makeFakeCli(dir, emails) {
  fs.mkdirSync(dir, { recursive: true })
  emails.forEach((e, i) => fs.writeFileSync(path.join(dir, `slot${i + 1}.json`), authJson(e, 'pro')))
  const cmd = path.join(dir, 'codex.cmd')
  fs.writeFileSync(cmd, [
    '@echo off',
    'echo [r5-fake-codex] %* >> "%~dp0cli.log"',
    'if /I not "%~1"=="login" exit /b 0',
    'set N=1',
    'if exist "%~dp0n.txt" set /p N=<"%~dp0n.txt"',
    'if not exist "%CODEX_HOME%" mkdir "%CODEX_HOME%"',
    'copy /Y "%~dp0slot%N%.json" "%CODEX_HOME%\\auth.json" >nul',
    'echo https://auth.openai.com/r5-fake',
    'set /a N=%N%+1',
    '> "%~dp0n.txt" echo %N%',
    'exit /b 0',
    ''
  ].join('\r\n'))
  return cmd
}

function buildHome(tag) {
  const home = path.join(ROOT, `home-n1-${tag}`)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 잠기면 덮어쓴다 */ }
  makeFixtureHome(home, '3.0.0-beta.1')
  augmentFixture(home, { repo: REPO })
  for (const f of ['accounts.json', 'codex-accounts.json']) { try { fs.rmSync(path.join(home, f), { force: true }) } catch { /* 없음 */ } }
  try { fs.rmSync(path.join(home, 'accounts'), { recursive: true, force: true }) } catch { /* 없음 */ }
  try { fs.rmSync(path.join(home, 'codex'), { recursive: true, force: true }) } catch { /* 없음 */ }
  plantCodexStore(home)
  return home
}

async function connectMain(port, timeoutMs = 90000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const ts = await cdpTargets(port)
      const t = ts.find((x) => x.type === 'page' && !x.url.startsWith('data:') && !/toast\.html|tray\.html/.test(x.url) && !x.url.includes('#') && /index\.html|localhost/.test(x.url))
      if (t?.webSocketDebuggerUrl) return await Cdp.connect(t.webSocketDebuggerUrl)
    } catch { /* 아직 */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('main target not found')
    await sleep(80)
  }
}

// OpenAI 섹션의 계정 행만 — `.set-sec`가 'OpenAI'인 자리 **뒤**의 `.sc2.acct` 형제들.
const CX_ROWS = `(() => {
  const secs = [...document.querySelectorAll('.set-inner .set-sec')]
  const oa = secs.find((s) => (s.textContent || '').trim() === 'OpenAI')
  if (!oa) return JSON.stringify({ err: 'no-openai-sec', secs: secs.map((s) => (s.textContent||'').trim()) })
  const rows = []
  for (let n = oa.nextElementSibling; n; n = n.nextElementSibling) {
    if (n.classList.contains('set-sec')) break
    if (n.classList.contains('sc2') && n.classList.contains('acct')) {
      rows.push({
        email: (n.querySelector('.emt') || {}).textContent || '',
        badge: !!n.querySelector('.set-badge'),
        acts: [...n.querySelectorAll('.acts button')].map((b) => (b.textContent||'').trim())
      })
    }
  }
  // .set-note2 는 여러 자리에 쓰인다(실패 문구 · 로그인 URL · 상시 DPAPI 안내).
  // **전부** 담고, 실패 문구는 따로 뽑는다 — 하나만 집으면 상시 안내를 실패로 오독한다.
  const notes = [...document.querySelectorAll('.set-inner .set-note2')].map((n) => (n.textContent||'').replace(/\\s+/g,' ').trim().slice(0,180))
  const fail = notes.find((s) => /못했어요|실패했어요|찾지 못했어요|Could not|failed/.test(s)) ?? null
  return JSON.stringify({ rows, notes, failNote: fail, addRow: !!document.querySelector('.set-addrow') })
})()`

const OPEN_SETTINGS = `(async () => {
  const sl = (ms) => new Promise((r) => setTimeout(r, ms))
  if (!document.querySelector('.set-modal')) {
    const f = document.querySelector('.sb-foot'); if (!f) return 'no-foot'
    f.click(); await sl(800)
  }
  const b = [...document.querySelectorAll('.set-nav .set-ni')].find((x) => (x.textContent||'').trim() === 'Account')
  if (!b) return 'no-account-tab:' + [...document.querySelectorAll('.set-nav .set-ni')].map((x)=>(x.textContent||'').trim()).join('|')
  b.click(); await sl(900)
  return document.querySelector('.set-inner .sc2.acct') ? 'ok' : 'no-acct-rows'
})()`

const out = { at: new Date().toISOString(), exe: EXE, what: 'N1(Codex 계정 축) 출하 재판정 — 감사 R5', runs: [] }

for (let i = 1; i <= RUNS; i++) {
  const home = buildHome(`j${i}`)
  const cliDir = path.join(ROOT, `cli-n1-j${i}`)
  try { fs.rmSync(cliDir, { recursive: true, force: true }) } catch { /* 없음 */ }
  const cli = makeFakeCli(cliDir, ['r5-three@example.invalid', 'r5-four@example.invalid', 'r5-five@example.invalid'])
  // ⑤ `--arm=nocli` — 「띄울 codex가 없다」. 존재하지 않는 경로를 물린다.
  const binForRun = ARM === 'nocli' ? path.join(cliDir, 'there-is-no-codex-here.cmd') : cli
  const profile = tauriProfile({ port: PORT, exe: EXE })
  const env = { ...process.env, ...profile.env, CCG_HOME: home, CCG_NO_NET: '1', CCG_CODEX_BIN: binForRun }
  const child = spawn(profile.cmd, profile.args, { env, cwd: profile.cwd, stdio: 'ignore' })
  const rec = { run: i, home, cli, pid: child.pid, at: new Date().toISOString() }
  const disk = () => { try { const s = fs.readFileSync(path.join(home, 'codex-accounts.json'), 'utf8'); const j = JSON.parse(s); return { bytes: Buffer.byteLength(s), order: j.accounts.map((a) => a.email), defaultEmail: j.defaultEmail } } catch (e) { return { err: String(e.message) } } }
  let cdp = null
  try {
    cdp = await connectMain(PORT)
    await cdp.send('Runtime.enable').catch(() => {})
    for (let k = 0; k < 400; k++) {
      const ok = await cdp.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`).catch(() => false)
      if (ok) break
      await sleep(150)
    }
    await sleep(4000)
    rec.openSettings = await cdp.eval(OPEN_SETTINGS, { awaitPromise: true, timeoutMs: 20000 })
    await sleep(700)
    rec.before = JSON.parse(await cdp.eval(CX_ROWS))
    rec.diskBefore = disk()

    // ── ① 「맨 위로」 해피패스 ────────────────────────────────────────────────
    rec.moveTop = JSON.parse(await cdp.eval(`(async () => {
      const sl = (ms) => new Promise((r) => setTimeout(r, ms))
      const secs = [...document.querySelectorAll('.set-inner .set-sec')]
      const oa = secs.find((s) => (s.textContent || '').trim() === 'OpenAI')
      let target = null
      for (let n = oa.nextElementSibling; n; n = n.nextElementSibling) {
        if (n.classList.contains('set-sec')) break
        if (n.classList.contains('sc2') && n.classList.contains('acct')) {
          const b = [...n.querySelectorAll('.acts button')].find((x) => (x.textContent||'').trim() === '맨 위로')
          if (b) { target = { email: (n.querySelector('.emt')||{}).textContent, btn: b }; break }
        }
      }
      if (!target) return JSON.stringify({ err: 'no-movetop-button' })
      const t0 = Date.now(); target.btn.click()
      let settledMs = null
      for (let k = 0; k < 200; k++) {
        await sl(20)
        const first = document.querySelector('.set-inner .set-sec') && (() => {
          const secs2 = [...document.querySelectorAll('.set-inner .set-sec')]
          const o2 = secs2.find((s) => (s.textContent || '').trim() === 'OpenAI')
          for (let n = o2.nextElementSibling; n; n = n.nextElementSibling) {
            if (n.classList.contains('set-sec')) break
            if (n.classList.contains('sc2') && n.classList.contains('acct')) return (n.querySelector('.emt')||{}).textContent
          }
          return null
        })()
        if (first === target.email) { settledMs = Date.now() - t0; break }
      }
      return JSON.stringify({ clickedEmail: target.email, settledMs })
    })()`, { awaitPromise: true, timeoutMs: 30000 }))
    await sleep(900)
    rec.afterMoveTop = JSON.parse(await cdp.eval(CX_ROWS))
    rec.diskAfterMoveTop = disk()

    // ── ② 「계정 추가」 해피패스 (가짜 CLI) ──────────────────────────────────
    //     ★원시 `codex-auth:login`보다 **먼저** 눌러야 한다 — 원시 호출이 먼저 돌면
    //     셰임의 다음 슬롯이 소비돼 「새 행이 생겼다」의 기준선이 흔들린다.
    rec.diskBeforeAdd = disk()
    rec.add = JSON.parse(await cdp.eval(`(async () => {
      const sl = (ms) => new Promise((r) => setTimeout(r, ms))
      const cnt = () => {
        const secs = [...document.querySelectorAll('.set-inner .set-sec')]
        const oa = secs.find((s) => (s.textContent || '').trim() === 'OpenAI')
        if (!oa) return -1
        let n2 = 0
        for (let n = oa.nextElementSibling; n; n = n.nextElementSibling) {
          if (n.classList.contains('set-sec')) break
          if (n.classList.contains('sc2') && n.classList.contains('acct') && n.querySelector('.emt')) n2++
        }
        return n2
      }
      const before = cnt()
      const btns = [...document.querySelectorAll('.set-inner .set-addrow')]
      const b = btns[btns.length - 1]
      if (!b) return JSON.stringify({ err: 'no-addrow' })
      const t0 = Date.now(); b.click()
      let ms = null, spin = 0
      for (let k = 0; k < 600; k++) {
        await sl(50)
        if (document.querySelector('.set-inner .set-spin')) spin++
        if (cnt() > before) { ms = Date.now() - t0; break }
      }
      const notes = [...document.querySelectorAll('.set-inner .set-note2')].map((n) => (n.textContent||'').replace(/\\s+/g,' ').trim().slice(0,180))
      return JSON.stringify({ before, after: cnt(), ms, spinTicks: spin,
        failNote: notes.find((s) => /못했어요|실패했어요|찾지 못했어요|Could not|failed/.test(s)) ?? null, notes })
    })()`, { awaitPromise: true, timeoutMs: 90000 }))
    await sleep(900)
    rec.afterAdd = JSON.parse(await cdp.eval(CX_ROWS))
    rec.diskAfterAdd = disk()

    // ── ③ 원시 다섯 채널 ─────────────────────────────────────────────────────
    const raw = async (ch, payload = []) => cdp.eval(
      `window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(ch)}, payload: ${JSON.stringify(payload)} }).then(r => JSON.stringify(r) ?? 'undefined').catch(e => 'REJECT ' + String(e))`,
      { awaitPromise: true, timeoutMs: 30000 }
    ).catch((e) => 'THROW ' + e.message)
    rec.rawChannels = {}
    rec.rawChannels['codex-auth:login-cancel'] = await raw('codex-auth:login-cancel', [])
    rec.rawChannels['codex-auth:list-accounts'] = await raw('codex-auth:list-accounts', [])
    rec.rawChannels['codex-auth:reorder-accounts'] = await raw('codex-auth:reorder-accounts', [[TWO, ONE]])
    rec.rawChannels['codex-auth:set-default-account'] = await raw('codex-auth:set-default-account', [ONE])
    // `codex-auth:login`은 내 셰임이 즉시 exit 하므로 원시로도 안전하다(실 CLI 없음).
    rec.rawChannels['codex-auth:login'] = await raw('codex-auth:login', [])
    rec.diskAfterRaw = disk()

    // ── ④ 구조 처방 대조군은 **위조로는 못 만든다** ────────────────────────────
    //   window.__TAURI_INTERNALS__.invoke 는 **non-configurable**이다 — 감쌀 수 없다
    //   (실측: Object.defineProperty → "Cannot redefine property: invoke". 게다가 단순
    //    대입은 sloppy mode에서 **조용히 실패**해 위약 대조군이 된다 — 그래서 확인한다).
    //   그러니 「그 채널만 미구현」 판은 **exe를 따로 구워서** 만든다:
    //     C:\\Temp\\ccg-r28g-audit\\sabd (CODEX_SET_DEFAULT_ACCOUNT 팔 하나만 제거 ·
    //     새 CARGO_TARGET_DIR target-sabd — 함정 11) → 같은 도구를 --exe= 로 물린다.
    rec.forgeProbe = await cdp.eval(`(() => {
      const I = window.__TAURI_INTERNALS__
      const d = Object.getOwnPropertyDescriptor(I, 'invoke')
      let why = null
      try { Object.defineProperty(I, 'invoke', { value: I.invoke, configurable: true }) } catch (e) { why = String(e && e.message || e) }
      return JSON.stringify({ configurable: d ? d.configurable : null, writable: d ? d.writable : null, defineErr: why })
    })()`)
    rec.cliLog = (() => { try { return fs.readFileSync(path.join(cliDir, 'cli.log'), 'utf8').trim().split(/\r?\n/) } catch { return [] } })()
    rec.diskEnd = disk()
  } catch (e) {
    rec.fatal = String(e.stack ?? e).slice(0, 600)
  } finally {
    try { cdp?.close() } catch { /* 닫힘 */ }
    killTree(child.pid)
  }
  out.runs.push(rec)
  console.log(`[n1 ${i}/${RUNS}] settings=${rec.openSettings} moveTop=${JSON.stringify(rec.moveTop)} rowsAfter=${rec.afterMoveTop?.rows?.length} disk=${JSON.stringify(rec.diskAfterMoveTop)}`)
  console.log(`   raw=${JSON.stringify(Object.fromEntries(Object.entries(rec.rawChannels ?? {}).map(([k, v]) => [k, String(v).slice(0, 60)])))}`)
  console.log(`   forgeProbe=${rec.forgeProbe}`)
  console.log(`   add: before=${rec.add?.before} after=${rec.add?.after} ms=${rec.add?.ms} failNote=${JSON.stringify(rec.add?.failNote)} disk ${rec.diskBeforeAdd?.bytes} -> ${rec.diskAfterAdd?.bytes} cli=${JSON.stringify(rec.cliLog)}`)
  await sleep(1500)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(`\nsaved: ${OUT}`)
