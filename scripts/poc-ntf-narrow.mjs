/**
 * PoC — 알림 7종의 **좁은 폭(멀티 패널)** 실측 하네스.
 *
 * 사고: M-UI R1은 1440px 본채팅 폭에서 7승 0패였는데, 같은 문법을 420px(멀티 패널 폭)에
 * 넣으면 오류 +57.3px · 전환 +18.8 · 문답 +13으로 3패였다(크리틱 `docs/critic/mui-apply-r1.md`
 * §2.3). 이득(−13.2%)이 −4.0%로 무너지고, 압축 경계 선은 컨테이너를 61px 넘어갔다.
 *
 * 이 하네스는 크리틱의 `critic-mui-density.mjs`와 **같은 픽스처·같은 자**(`.thread`에
 * max-width 주입)를 쓰되, **CSS/JS를 라이브로 주입**해 재빌드 없이 후보안을 재는 데 쓴다.
 * 최종 수치는 크리틱 하네스로 다시 재는 게 규약이고, 이건 반복 실험용 자다.
 *
 * 실행:
 *   node scripts/poc-ntf-narrow.mjs                              # 3.0 현재 빌드 @420
 *   node scripts/poc-ntf-narrow.mjs --variant=a --electron       # 2.6.2 기준선 @420
 *   node scripts/poc-ntf-narrow.mjs --css=/tmp/try.css           # 후보 CSS 얹어서
 *   node scripts/poc-ntf-narrow.mjs --width=939                  # 본채팅 폭(무주입)
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const REPO = path.resolve(import.meta.dirname, '..')
const lib = await import(pathToFileURL(path.join(REPO, 'bench', 'lib.mjs')).href)
const fixture = await import(pathToFileURL(path.join(REPO, 'bench', 'fixture.mjs')).href)
const { Cdp, cdpTargets, killTree, sleep } = lib

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}
const ELECTRON = process.argv.includes('--electron')
const VARIANT = (arg('variant', ELECTRON ? 'a' : 'b') || 'b').toLowerCase()
const WIDTH = Number(arg('width', '420'))
const EXE = arg('exe', ELECTRON ? path.join(REPO, 'node_modules/electron/dist/electron.exe') : path.join(os.tmpdir(), 'mui-new', 'agentcodegui.exe'))
const CSSF = arg('css', '')
const JSF = arg('js', '')
const OUT = arg('out', '')
const SHOT = arg('shot', '')
const PORT = Number(arg('port', VARIANT === 'a' ? 9481 : 9482))
const HOME = path.join(os.tmpdir(), `ccg-ntfnarrow-${VARIANT}`)
// `--win=<px>`는 **창 자체**를 좁힌다(주입 자가 아니라 진짜 레이아웃). 크리틱과 비교하려면
// 1440 + `--width=420`(주입)을 쓰고, "실제로 좁은 창에서도 켜지나"는 이쪽으로 확인한다.
const VIEW = { width: Number(arg('win', '1440')), height: 900 }
const time = '오후 3:00'

// ── 크리틱/빌더와 **같은 사건 열** (docs/critic/tools/critic-mui-density.mjs) ────────
const surround = {
  u1: { kind: 'msg', id: 'u1', role: 'user', text: 'ipc.rs를 기능별로 쪼개고 테스트까지 붙여줘', animate: false, time },
  tg: {
    kind: 'toolgroup', id: 'tg1', time,
    tools: [
      { id: 'tg1-1', verb: 'Read', kind: 'read', target: 'src-tauri/src/ipc.rs', status: 'done', result: '612줄', durationMs: 12 },
      { id: 'tg1-2', verb: 'Write', kind: 'write', target: 'src-tauri/src/ipc/mod.rs', status: 'done', result: '+184', durationMs: 30 },
      { id: 'tg1-3', verb: 'Write', kind: 'write', target: 'src-tauri/src/ipc/stores.rs', status: 'done', result: '+201', durationMs: 30 }
    ]
  },
  a1: { kind: 'msg', id: 'a1', role: 'assistant', text: '디스패처를 6개 파일로 나눴어요. 채널 상수는 `mod.rs`에 그대로 뒀습니다.', animate: false, time },
  u2: { kind: 'msg', id: 'u2', role: 'user', text: '테스트는 나중에. 일단 빌드만', animate: false, time },
  worked: { kind: 'worked', id: 'w1', ms: 848000 }
}
const ERR_TEXT =
  '오류: 워크스페이스 매니페스트를 못 읽었어요\n' +
  'error: failed to load manifest for workspace member\n' +
  '  `C:\\Code\\AgentCodeGUI\\crates\\ccg-engine`\n' +
  'Caused by: no targets specified in the manifest'

const THREAD_A = [
  surround.u1,
  { kind: 'notice', id: 'n1', text: '이 대화는 API 크레딧으로 과금돼요 (구독이 아닙니다). 실수로 API를 골랐다면 하단 `과금`을 `구독`으로 바꾸세요.', time },
  { kind: 'qa', id: 'qa1', pairs: [{ q: '파일째 나눌까요, 한 파일 안에서 모듈로 나눌까요?', a: ['파일째 나눈다'] }] },
  surround.tg,
  { kind: 'notice', id: 'n2', text: 'Fable 5 이(가) 응답을 거부해 Opus 5 로 전환했어요', time },
  surround.a1,
  { kind: 'interrupted', id: 'stop1' },
  surround.u2,
  {
    kind: 'cmdresult', id: 'ac1', name: 'compact', running: false, time,
    title: '컨텍스트가 가득 차 대화를 자동으로 요약했어요',
    sub: '이전 대화를 핵심 요약으로 압축하고 이어서 진행합니다.',
    stats: '컨텍스트 95% → 24% 로 절약 · 토큰 114k 회수'
  },
  { kind: 'cmdresult', id: 'cr1', name: 'review', running: false, failed: true, time, title: '명령을 완료하지 못했어요', sub: '변경된 파일이 없어 검토할 대상이 없습니다.', stats: null },
  { kind: 'msg', id: 'err1', role: 'assistant', text: ERR_TEXT, animate: false, error: true, time },
  surround.worked
]
const THREAD_B = [
  surround.u1,
  { kind: 'notice', id: 'n1', text: '`API 크레딧`으로 과금 중이에요 — 구독 한도는 줄지 않습니다.', time, tone: 'notice', action: 'billing-off' },
  { kind: 'qa', id: 'qa1', time, pairs: [{ q: '파일째 나눌까요, 한 파일 안에서 모듈로 나눌까요?', a: ['파일째 나눈다'] }] },
  surround.tg,
  { kind: 'fallback', id: 'fb1', from: 'claude-fable-5', to: 'claude-opus-5', cause: 'refusal_frame', revertTo: 3, text: 'Fable 5 이(가) 응답을 거부해 Opus 5 로 전환했어요', time },
  surround.a1,
  { kind: 'interrupted', id: 'stop1', ms: 42000, tools: 3, time },
  surround.u2,
  { kind: 'boundary', id: 'ac1', glyph: 'compact', label: '여기까지 요약됨', num: '152k → 38k · 컨텍스트 95% → 24%', time },
  { kind: 'cmdresult', id: 'cr1', name: 'review', running: false, failed: true, time, title: '완료하지 못했어요', sub: '변경된 파일이 없어 검토할 대상이 없습니다.', stats: null },
  { kind: 'msg', id: 'err1', role: 'assistant', text: ERR_TEXT, animate: false, error: true, time },
  surround.worked
]
const LABELS = ['user', '안내', '문답', '도구', '전환', 'AI', '중단', 'user2', '압축', '명령', '오류', '작업함']

fs.rmSync(HOME, { recursive: true, force: true })
fixture.makeFixtureHome(HOME, ELECTRON ? '2.6.2' : '3.0.0-beta.1')
const chatFile = path.join(HOME, 'chats', 'fix-long-thread.json')
const chat = JSON.parse(fs.readFileSync(chatFile, 'utf8'))
chat.snapshot.messages = VARIANT === 'a' ? THREAD_A : THREAD_B
chat.snapshot.seq = 99
fs.writeFileSync(chatFile, JSON.stringify(chat))

const proc = ELECTRON
  ? spawn(EXE, ['.', `--remote-debugging-port=${PORT}`], { env: { ...process.env, CCG_HOME: HOME, NODE_ENV: 'production' }, cwd: REPO, stdio: 'ignore' })
  : spawn(EXE, [], { env: { ...process.env, CCG_HOME: HOME, CCG_CDP_PORT: String(PORT) }, cwd: REPO, stdio: 'ignore' })

async function connectMain() {
  const t0 = Date.now()
  for (;;) {
    try {
      const ts = await cdpTargets(PORT)
      const t = ts.find((x) => x.type === 'page' && !x.url.includes('#') && /index\.html|localhost/.test(x.url) && !/toast|tray/.test(x.url))
      if (t?.webSocketDebuggerUrl) return await Cdp.connect(t.webSocketDebuggerUrl)
    } catch { /* not up yet */ }
    if (Date.now() - t0 > 90000) throw new Error('main target not found')
    await sleep(120)
  }
}

// 행 높이 + 오른쪽 오버플로 + (진단용) 밴드 안 조각들의 실폭
const MEASURE = `(() => {
  const px = (n) => Math.round(n * 10) / 10
  const th = document.querySelector('.chat-scroll .thread') || document.querySelector('.thread')
  if (!th) return { err: 'no thread' }
  const strip = (s) => (s || '').replace(/[\\s\\u00a0]/g, '')
  const rows = [...th.children].map((el) => ({
    h: px(el.getBoundingClientRect().height),
    glyphs: strip(el.innerText).length,
    over: px(el.scrollWidth - el.clientWidth),
    act: el.querySelectorAll('button, [role=button]').length
  }))
  // 진단: 조각별 실폭(문장 한 줄 폭·트레이 폭 등)
  const w = (sel) => { const e = th.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { w: px(r.width), h: px(r.height) } }
  const range = (sel) => {
    const e = th.querySelector(sel); if (!e) return null
    const r = document.createRange(); r.selectNodeContents(e)
    const rects = [...r.getClientRects()]
    return { lines: rects.length, ink: px(rects.reduce((s, x) => s + x.width, 0)) }
  }
  // 한 줄로 펴면 몇 px인가(= 문장의 총 잉크). 줄 수 판정의 분자다.
  const inkOf = (el) => {
    if (!el) return null
    const cs = getComputedStyle(el)
    const d = document.createElement('div')
    d.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:nowrap;visibility:hidden'
    d.style.font = cs.font
    d.style.letterSpacing = cs.letterSpacing
    d.innerHTML = el.innerHTML
    document.body.appendChild(d)
    const w = px(d.getBoundingClientRect().width)
    d.remove()
    return w
  }
  return {
    thread: px(th.getBoundingClientRect().height),
    inner: px(th.getBoundingClientRect().height - parseFloat(getComputedStyle(th).paddingTop) - parseFloat(getComputedStyle(th).paddingBottom)),
    width: px(th.getBoundingClientRect().width),
    cw: px(th.clientWidth - parseFloat(getComputedStyle(th).paddingLeft) - parseFloat(getComputedStyle(th).paddingRight)),
    rows,
    probe: {
      fbBand: w('.ntf-band.ntf-t-notice:nth-of-type(1)'),
      fbTx: range('.thread > .ntf-band.ntf-t-notice ~ .ntf-band .ntf-tx') || range('.ntf-band .ntf-tx'),
      trays: [...th.querySelectorAll('.ntf-tray')].map((e) => px(e.getBoundingClientRect().width)),
      // R2 진단 — 트레이를 띄운 뒤 **누가 band 높이를 정하는가**(문장 줄 vs 알약)
      trayBox: [...th.querySelectorAll('.ntf-band .ntf-tray')].map((e) => {
        const r = e.getBoundingClientRect()
        const p = e.parentElement.getBoundingClientRect()
        const cs = getComputedStyle(e)
        return { h: px(r.height), top: px(r.top - p.top), float: cs.float, mb: cs.marginBottom }
      }),
      bdBox: [...th.querySelectorAll('.ntf-band .ntf-bd')].map((e) => ({ h: px(e.getBoundingClientRect().height), disp: getComputedStyle(e).display })),
      txInk: [...th.querySelectorAll('.ntf-band .ntf-tx')].map((e) => { const r = document.createRange(); r.selectNodeContents(e); const rr = [...r.getClientRects()]; return { lines: rr.length, ink: px(rr.reduce((s, x) => s + x.width, 0)) } }),
      raw: w('.ntf-raw'),
      qa: w('.ntf-card.ntf-bare'),
      rawLine: (() => {
        const e = th.querySelector('.ntf-raw'); if (!e) return null
        const cs = getComputedStyle(e)
        const d = document.createElement('div')
        d.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:pre;visibility:hidden'
        d.style.font = cs.font
        const longest = (e.textContent || '').split('\\n').sort((a, b) => b.length - a.length)[0] || ''
        d.textContent = longest
        document.body.appendChild(d)
        const wd = px(d.getBoundingClientRect().width)
        d.remove()
        return { chars: longest.length, w: wd, per: px(wd / Math.max(1, longest.length)), box: px(e.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) }
      })(),
      ink: [...th.querySelectorAll('.ntf-band .ntf-tx')].map(inkOf),
      qaInk: { q: inkOf(th.querySelector('.ntf-qa .ntf-qt')), a: inkOf(th.querySelector('.ntf-qa .ntf-a')) },
      qaParts: { tile: w('.ntf-card.ntf-bare .ntf-tile'), bd: w('.ntf-card.ntf-bare .ntf-bd'), q: w('.ntf-qa .ntf-q'), a: w('.ntf-qa .ntf-a') },
      band: [...th.querySelectorAll('.ntf-band')].map((e) => ({ w: px(e.getBoundingClientRect().width), h: px(e.getBoundingClientRect().height) })),
      bd: [...th.querySelectorAll('.ntf-band .ntf-bd')].map((e) => px(e.getBoundingClientRect().width))
    }
  }
})()`

try {
  const cdp = await connectMain()
  await cdp.send('Page.enable').catch(() => {})
  await cdp.send('Runtime.enable').catch(() => {})
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 14, g: 16, b: 22, a: 1 } }).catch(() => {})
  const setBounds = async () => {
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget', {})
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 40, top: 40, width: VIEW.width, height: VIEW.height } })
    } catch { /* 미지원이면 기본 크기 */ }
  }
  await setBounds()
  const t0 = Date.now()
  for (;;) {
    const ok = await cdp.eval(`!!document.querySelector('.thread') && document.querySelectorAll('.thread > *').length >= 10`).catch(() => false)
    if (ok) break
    if (Date.now() - t0 > 60000) throw new Error('thread never rendered')
    await sleep(200)
  }
  await sleep(2500) // 웹폰트 + rise 애니메이션 정착
  // 창 기하 재확정 — 앱이 마운트 뒤 자기 기하를 다시 얹어 1320×880 / 1440×900로 갈린다.
  // 그러면 `--width=0`(무주입) 계측의 칼럼 폭이 실행마다 883 / 989로 튄다(M-UI R1 §3 함정①).
  for (let i = 0; i < 12; i++) {
    const w = await cdp.eval('window.innerWidth').catch(() => null)
    if (w === VIEW.width) break
    await setBounds()
    await sleep(500)
  }
  await sleep(400)
  if (WIDTH > 0 && WIDTH < 1400) {
    await cdp.eval(
      `(() => { const st=document.createElement('style'); st.id='ntf-narrow-ruler'; st.textContent='.thread{max-width:${WIDTH}px !important;margin:0 !important}'; document.head.appendChild(st); return true })()`
    )
    await sleep(700)
  }
  if (CSSF) {
    const css = fs.readFileSync(CSSF, 'utf8')
    await cdp.eval(
      `(() => { const st=document.createElement('style'); st.id='ntf-candidate'; st.textContent=${JSON.stringify(css)}; document.head.appendChild(st); return true })()`
    )
    await sleep(900)
  }
  if (JSF) {
    // 후보 마크업(트레이를 본문 앞으로 옮기는 등)을 재빌드 없이 흉내 내는 자리
    await cdp.eval(`(() => { ${fs.readFileSync(JSF, 'utf8')} ; return true })()`)
    await sleep(700)
  }
  const m = await cdp.eval(MEASURE)
  if (SHOT) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.mkdirSync(path.dirname(SHOT), { recursive: true })
    fs.writeFileSync(SHOT, Buffer.from(r.data, 'base64'))
  }
  const table = m.rows.map((r, i) => ({ item: LABELS[i] ?? `#${i}`, h: r.h, glyphs: r.glyphs, over: r.over, act: r.act }))
  const res = { variant: VARIANT, width: WIDTH, css: CSSF || null, thread: m.thread, inner: m.inner, threadW: m.width, contentW: m.cw, rows: table, probe: m.probe }
  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true })
    fs.writeFileSync(OUT, JSON.stringify(res, null, 1))
  }
  console.log(`variant=${VARIANT} ruler=${WIDTH} thread=${m.thread} inner=${m.inner} content=${m.cw}`)
  for (const r of table) console.log(`  ${r.item.padEnd(7)} h=${String(r.h).padStart(6)}  glyphs=${String(r.glyphs).padStart(4)}  over=${r.over}`)
  console.log('probe', JSON.stringify(m.probe))
  cdp.close()
} finally {
  killTree(proc.pid)
}
