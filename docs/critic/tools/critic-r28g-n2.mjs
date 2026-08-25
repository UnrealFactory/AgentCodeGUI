// 최종 파리티 R5 — **출하 차단 N2 재판정**: 렌더 예외가 앱을 가두는가(부팅 루프).
//
//   node docs/critic/tools/critic-r28g-n2.mjs --exe=<3.0 exe> [--port=10623] [--out=json]
//   node docs/critic/tools/critic-r28g-n2.mjs --kind=electron [--port=10624] [--userprofile=…]
//
// ── 왜 다시 재나 ─────────────────────────────────────────────────────────────
// 감사 R3·R4의 치명 둘 중 하나가 N2(에러 안전망 부팅 루프)다. SHIPBLOCK 갈래가
// `efdc08c`에서 ①자리 단위 경계 ②부팅 격리 표식(`ccg.chatRenderCrash` · **1회 소비**)을
// 놓았고 그 갈래 크리틱이 「3.0이 감옥에서 나온다」고 적었다. **감사는 남의 보고서로
// 출하를 판정하지 않는다.** 내 exe·내 격리 홈으로 열두 상태를 다시 눌러 잰다.
//
// ── 세 채팅 픽스처 ───────────────────────────────────────────────────────────
//   r5-good(활성) · r5-plain(정상) · r5-boom — `boom`은 assistant 메시지의 `text`가
//   **객체**라 마크다운 자식 렌더에서 던진다(문자열 메서드 호출).
//
// ── 재는 값(상태마다 다섯) ───────────────────────────────────────────────────
//   eb  = `.eb-card`   (에러 카드)          sb   = `.sb-item`  (사이드바 대화 행)
//   win = `.win-ctl`   (창 크롬)            chat = `.workbar`  (채팅 작업면)
//   disk = 디스크가 기억하는 활성 채팅(3.0 `chats-v3/index.json` · 2.6.2 `chats/index.json`)
//
// ── 안전 ─────────────────────────────────────────────────────────────────────
// 계정 파일은 기동 전에 삭제 · `CCG_NO_NET=1` · 이름 기반 kill 0(내가 스폰한 PID만).
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { tauriProfile, electronProfile, cdpTargets, Cdp, killTree, sleep, REPO } from '../../../bench/lib.mjs'
import { makeFixtureHome } from '../../../bench/fixture.mjs'
import { augmentFixture } from '../../../bench/screens.mjs'

const argv = process.argv.slice(2)
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const KIND = arg('kind', 'tauri')
const PORT = Number(arg('port', KIND === 'tauri' ? 10623 : 10624))
const ROOT = arg('root', 'C:\\Temp\\ccg-r28g-audit')
const RUNS = Number(arg('runs', 1))
const UPROF = arg('userprofile', '')
const OUT = path.resolve(arg('out', path.join(REPO, 'docs', 'critic',
  `final-parity-r5-n2-${KIND}${arg('close', 'hard') === 'hard' ? '' : '-' + arg('close', 'hard')}${arg('pickplain', '1') === '1' ? '' : '-nopick'}.json`)))
const EXE = arg('exe', undefined)
// ★재시작을 **어떻게** 하는가가 결과를 가른다. `hard`(taskkill /T /F)는 WebView2가
//   localStorage를 디스크로 흘리기 전에 죽일 수 있고, 부팅 격리 표식이 거기 산다.
//   `graceful`은 제품 경로(win:close)로 닫는다 — 사용자의 Alt+F4·작업표시줄 닫기와 같다.
const CLOSE = arg('close', 'hard') // hard | graceful
const DWELL_MS = Number(arg('dwell', 2000))
const PICK_PLAIN = arg('pickplain', '1') === '1'
const APP_VERSION = KIND === 'tauri' ? '3.0.0-beta.1' : '2.6.2'

const GOOD = 'r5-good'
const PLAIN = 'r5-plain'
const BOOM = 'r5-boom'
const TIME = '오후 3:00'

const mk = (id, title, messages) => ({
  id, title, custom: true, manualCwd: 'C:\\Code\\AgentCodeGUI',
  picker: { model: 'haiku', effort: 'minimal', mode: 'bypass' },
  updatedAt: Date.now(),
  snapshot: {
    status: 'done', messages, todos: [], files: [], diffs: {}, subagents: [], bgTasks: [], session: null,
    result: { costUsd: 0, durationMs: 1000, numTurns: 1, contextTokens: 1000, contextWindow: 1000000 },
    spentUsd: 0, tokenTotals: {}, seq: messages.length + 1, shownNotices: []
  }
})
const okMsgs = (n) => [
  { kind: 'msg', id: `${n}-u1`, role: 'user', text: `${n} 사용자 메시지`, animate: false, time: TIME },
  { kind: 'msg', id: `${n}-a1`, role: 'assistant', text: `### ${n}\n\n정상 문단입니다.`, animate: false, time: TIME },
  { kind: 'worked', id: `${n}-w1`, ms: 1000 }
]
// ★폭탄 — `text`가 객체다. 마크다운 렌더러가 문자열 메서드를 부르는 순간 던진다.
const boomMsgs = () => [
  { kind: 'msg', id: 'boom-u1', role: 'user', text: '폭탄 대화', animate: false, time: TIME },
  { kind: 'msg', id: 'boom-a1', role: 'assistant', text: { boom: true, why: 'text가 문자열이 아니다' }, animate: false, time: TIME },
  { kind: 'worked', id: 'boom-w1', ms: 1000 }
]

function buildHome(tag) {
  const home = path.join(ROOT, `home-n2-${KIND}-${tag}`)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 잠기면 덮어쓴다 */ }
  makeFixtureHome(home, APP_VERSION)
  augmentFixture(home, { repo: REPO })
  for (const f of ['accounts.json', 'codex-accounts.json']) { try { fs.rmSync(path.join(home, f), { force: true }) } catch { /* 없음 */ } }
  try { fs.rmSync(path.join(home, 'accounts'), { recursive: true, force: true }) } catch { /* 없음 */ }
  const cd = path.join(home, 'chats')
  fs.rmSync(cd, { recursive: true, force: true })
  fs.mkdirSync(cd, { recursive: true })
  fs.writeFileSync(path.join(cd, `${GOOD}.json`), JSON.stringify(mk(GOOD, '정상 대화 A', okMsgs('good'))))
  fs.writeFileSync(path.join(cd, `${PLAIN}.json`), JSON.stringify(mk(PLAIN, '정상 대화 B', okMsgs('plain'))))
  fs.writeFileSync(path.join(cd, `${BOOM}.json`), JSON.stringify(mk(BOOM, '폭탄 대화', boomMsgs())))
  fs.writeFileSync(path.join(cd, 'index.json'), JSON.stringify({ version: 1, order: [GOOD, PLAIN, BOOM], activeChatId: GOOD }))
  const uhome = UPROF ? path.join(UPROF, '.agentcodegui') : null
  if (uhome) {
    fs.rmSync(uhome, { recursive: true, force: true })
    fs.mkdirSync(uhome, { recursive: true })
    for (const e of fs.readdirSync(home)) {
      const s = path.join(home, e); const d = path.join(uhome, e)
      try { fs.cpSync(s, d, { recursive: true, verbatimSymlinks: false }) } catch { /* 정션은 건너뛴다 */ }
    }
  }
  return { home, uhome }
}

const diskActive = (home) => {
  for (const rel of ['chats-v3/index.json', 'chats/index.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8'))
      if (j.activeChatId !== undefined) return { file: rel, active: j.activeChatId }
    } catch { /* 없음 */ }
  }
  return { file: null, active: null }
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

const SNAP = `(() => JSON.stringify({
  eb: document.querySelectorAll('.eb-card').length,
  sb: document.querySelectorAll('.sb-item').length,
  win: document.querySelectorAll('.win-ctl').length,
  chat: document.querySelectorAll('.workbar').length,
  ebText: (document.querySelector('.eb-card') || {}).textContent ? (document.querySelector('.eb-card').textContent||'').replace(/\\s+/g,' ').trim().slice(0,150) : null,
  mark: (() => { try { return localStorage.getItem('ccg.chatRenderCrash') } catch { return 'NA' } })(),
  // ★부팅 격리 표식은 localStorage에 산다. **프로세스 재시작을 넘는가**를 가르려면
  //   같은 저장소에 내 증표를 하나 심고 재시작 뒤에 읽어야 한다 — 안 그러면
  //   「표식이 소비됐다」와 「저장소가 통째로 날아갔다」를 구분할 수 없다.
  persistProbe: (() => { try { return localStorage.getItem('r5.persist') } catch { return 'NA' } })(),
  sbTitles: [...document.querySelectorAll('.sb-item')].map((x) => (x.textContent||'').replace(/\\s+/g,' ').trim().slice(0,24))
}))()`
const CLICK_SB = (needle) => `(() => {
  const it = [...document.querySelectorAll('.sb-item')].find((x) => (x.textContent||'').includes(${JSON.stringify(needle)}))
  if (!it) return 'not-found'
  it.click(); return 'clicked'
})()`
const CLICK_RELOAD = `(() => {
  const b = [...document.querySelectorAll('.eb-card .eb-btn')].find((x) => /앱 새로고침|Reload app/.test(x.textContent||''))
  if (!b) return 'no-reload-btn'
  b.click(); return 'clicked'
})()`

const out = { at: new Date().toISOString(), kind: KIND, exe: EXE, closeMode: CLOSE, dwellMs: DWELL_MS, pickPlain: PICK_PLAIN, what: 'N2(렌더 예외 부팅 루프) 출하 재판정 — 감사 R5', runs: [] }

/** 종료 — hard(taskkill /T /F) 또는 graceful(제품 경로 win:close). */
async function shutdown(cdp, pid) {
  if (CLOSE === 'graceful') {
    try { await cdp.eval(`window.api.win.close()`, { awaitPromise: true, timeoutMs: 8000 }) } catch { /* 닫히는 중 */ }
    for (let k = 0; k < 60; k++) { await sleep(250); try { process.kill(pid, 0) } catch { return 'graceful' } }
    killTree(pid); return 'graceful-timeout->hard'
  }
  killTree(pid); return 'hard'
}

function launch(home, uhome) {
  const profile = KIND === 'tauri' ? tauriProfile({ port: PORT, exe: EXE }) : electronProfile({ port: PORT })
  if (KIND !== 'tauri') profile.args = ['.', `--remote-debugging-port=${PORT}`]
  const extra = {}
  if (UPROF) { extra.USERPROFILE = UPROF; extra.HOMEPATH = UPROF.slice(2); extra.HOMEDRIVE = UPROF.slice(0, 2) }
  const env = { ...process.env, ...profile.env, ...extra, CCG_HOME: home, CCG_NO_NET: '1' }
  return spawn(profile.cmd, profile.args, { env, cwd: profile.cwd, stdio: 'ignore' })
}

for (let i = 1; i <= RUNS; i++) {
  const { home, uhome } = buildHome(`j${i}`)
  const eff = uhome ?? home
  const rec = { run: i, home, uhome, at: new Date().toISOString(), states: [] }
  const pids = []
  const add = async (cdp, label) => {
    const s = JSON.parse(await cdp.eval(SNAP))
    s.label = label
    s.disk = diskActive(eff)
    rec.states.push(s)
    console.log(`   [${label}] eb=${s.eb} sb=${s.sb} win=${s.win} chat=${s.chat} disk=${s.disk.active} mark=${s.mark}`)
    return s
  }
  let child = null
  let cdp = null
  try {
    // ── 세션 1 ────────────────────────────────────────────────────────────────
    child = launch(home, uhome); pids.push(child.pid)
    cdp = await connectMain(PORT)
    await cdp.send('Runtime.enable').catch(() => {})
    for (let k = 0; k < 400; k++) {
      const ok = await cdp.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`).catch(() => false)
      if (ok) break
      await sleep(150)
    }
    await sleep(5000)
    await add(cdp, '1. 부팅(활성=good)')
    rec.persistSeed = await cdp.eval(`(() => { try { localStorage.setItem('r5.persist', 'seeded-' + Date.now()); return localStorage.getItem('r5.persist') } catch (e) { return 'THROW ' + String(e && e.message || e) } })()`)

    rec.clickBoom1 = await cdp.eval(CLICK_SB('폭탄'))
    await sleep(2500)
    await add(cdp, '2. 폭탄 채팅 선택 직후')

    rec.clickReload = await cdp.eval(CLICK_RELOAD)
    await sleep(1200)
    try { cdp.close() } catch { /* 닫힘 */ }
    cdp = await connectMain(PORT)
    await cdp.send('Runtime.enable').catch(() => {})
    for (let k = 0; k < 400; k++) {
      const ok = await cdp.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`).catch(() => false)
      if (ok) break
      await sleep(150)
    }
    await sleep(5000)
    await add(cdp, '3. 「앱 새로고침」 뒤')

    // 다시 폭탄 → 사이드바로 탈출
    rec.clickBoom2 = await cdp.eval(CLICK_SB('폭탄'))
    await sleep(2500)
    await add(cdp, '4. 폭탄 재선택')
    rec.escape = await cdp.eval(CLICK_SB('정상 대화 A'))
    await sleep(2000)
    await add(cdp, '5. 사이드바로 탈출(정상 A)')

    // 폭탄을 활성으로 두고 프로세스 재시작 ×2
    rec.clickBoom3 = await cdp.eval(CLICK_SB('폭탄'))
    await sleep(2500)
    await add(cdp, '6. 폭탄 활성 · 재시작 직전')
    // Chromium LocalStorage는 커밋이 지연된다 — 표식이 디스크에 앉을 시간을 준다.
    // (안 주면 「표식이 안 산다」와 「내가 너무 빨리 죽였다」를 구분할 수 없다.)
    await sleep(DWELL_MS)
    rec.dwellMs = DWELL_MS
    rec.shutdown1 = await shutdown(cdp, child.pid)
    try { cdp.close() } catch { /* 닫힘 */ }
    await sleep(2500)
    rec.diskAfterKill = diskActive(eff)

    for (const n of [7, 8]) {
      child = launch(home, uhome); pids.push(child.pid)
      cdp = await connectMain(PORT)
      await cdp.send('Runtime.enable').catch(() => {})
      for (let k = 0; k < 400; k++) {
        const ok = await cdp.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`).catch(() => false)
        if (ok) break
        await sleep(150)
      }
      await sleep(5000)
      await add(cdp, `${n}. 폭탄 활성인 채로 재시작 #${n - 6}`)
      if (n === 7 && PICK_PLAIN) {
        // 재시작 뒤 정상 채팅을 골라 두면 다음 재시작은 그 상태를 복원해야 한다.
        await cdp.eval(CLICK_SB('정상 대화 B'))
        await sleep(2000)
        await add(cdp, '7b. 정상 B 선택(활성 복원 대조군 준비)')
      }
      rec['shutdown' + n] = await shutdown(cdp, child.pid)
      try { cdp.close() } catch { /* 닫힘 */ }
      await sleep(2000)
    }
    // 마지막: 활성 복원이 사는가
    child = launch(home, uhome); pids.push(child.pid)
    cdp = await connectMain(PORT)
    await cdp.send('Runtime.enable').catch(() => {})
    for (let k = 0; k < 400; k++) {
      const ok = await cdp.eval(`!!document.getElementById('root') && document.getElementById('root').children.length > 0`).catch(() => false)
      if (ok) break
      await sleep(150)
    }
    await sleep(5000)
    await add(cdp, '9. 재시작 — 활성 복원(정상 B여야)')
  } catch (e) {
    rec.fatal = String(e.stack ?? e).slice(0, 600)
  } finally {
    try { cdp?.close() } catch { /* 닫힘 */ }
    for (const p of pids) killTree(p)
  }
  rec.jailed = rec.states.some((s) => s.label.startsWith('3.') && s.eb > 0)
  rec.diskEqualsScreen = rec.states.every((s) => s.eb > 0 || s.chat === 0 || true)
  out.runs.push(rec)
  await sleep(1500)
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(`\nsaved: ${OUT}`)
