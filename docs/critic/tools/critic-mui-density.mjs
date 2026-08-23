// [크리틱 사본] M-UI 밀도 자가 계측 — 목업(ui-notify.js)의 계측기를 **실렌더러**에 얹는다.
//
//   node mui-density.mjs <exe> <variant:a|b> <outJson>
//
// 목업 시트 0(7종이 한 스레드에)과 **같은 사건 열**을 실앱 스냅샷으로 심고, 부팅 후
// `.thread`의 실제 렌더 높이와 항목별 높이를 CDP로 잰다. A = 2.6.2 문법(현행 항목 모양),
// B = 3.0 문법(새 항목 모양). 같은 창 크기·같은 홈·같은 폰트에서 재야 비교가 성립한다.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const REPO = 'C:/Code/AgentCodeGUI'
const lib = await import(pathToFileURL(path.join(REPO, 'bench', 'lib.mjs')).href)
const fixture = await import(pathToFileURL(path.join(REPO, 'bench', 'fixture.mjs')).href)
const { Cdp, cdpTargets, killTree, sleep } = lib

const EXE = process.argv[2]
const VARIANT = (process.argv[3] || 'b').toLowerCase()
const OUT = process.argv[4] || path.join(os.tmpdir(), `mui-density-${VARIANT}.json`)
const SHOT = process.argv[5] || '' // 있으면 그 경로로 PNG도 남긴다
const ELECTRON = process.argv.includes('--electron')
const HOME = path.join(os.tmpdir(), `ccg-muicrit-density-${VARIANT}`)
const PORT = VARIANT === 'a' ? 9391 : VARIANT === 'c' ? 9393 : 9392
const VIEW = { width: 1440, height: 900 }
const time = '오후 3:00'

// ── 목업 시트 0과 같은 사건 열 ────────────────────────────────────────────────
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

// A = 2.6.2 항목 모양 (현행 리듀서가 만드는 것 그대로)
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

// B = 3.0 항목 모양 (같은 사건 · 새 문법)
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

// C = 모델 전환 변형 시트 (cause 3경로 · 되돌린 뒤 · 한 턴 2배너)
const fb = (id, from, to, cause, revertTo, extra = {}) => ({
  kind: 'fallback', id, from, to, cause, revertTo, time,
  text: `${from} 이(가) 응답을 거부해 ${to} 로 전환했어요`, ...extra
})
const THREAD_C = [
  { kind: 'msg', id: 'u1', role: 'user', text: '이 크래시 덤프 읽고 원인 짚어줘', animate: false, time },
  fb('f1', 'claude-fable-5', 'claude-opus-5', 'dialog', 3),
  fb('f2', 'claude-fable-5', 'claude-opus-5', 'refusal_frame', 4),
  fb('f3', 'claude-fable-5', 'claude-sonnet-4-6', 'model_delta', 5),
  { kind: 'msg', id: 'a1', role: 'assistant', text: '위 셋은 같은 형태(band·notice·revert)에 문장만 셋이다.', animate: false, time },
  { kind: 'msg', id: 'u2', role: 'user', text: '한 턴에 두 번 전환되면?', animate: false, time },
  fb('f4', 'claude-fable-5', 'claude-opus-5', 'refusal_frame', 6, { reverted: true }),
  fb('f5', 'claude-opus-5', 'claude-sonnet-4-6', 'refusal_frame', 7),
  { kind: 'boundary', id: 'b1', glyph: 'resume', label: '이어서 대화 (resume)', num: '2일 전 대화', time },
  { kind: 'notice', id: 'n9', text: '모델 자동 전환(으)로 새 프로세스에서 시작했어요', time, tone: 'neutral' },
  { kind: 'worked', id: 'w1', ms: 31000 }
]

fs.rmSync(HOME, { recursive: true, force: true })
fixture.makeFixtureHome(HOME, ELECTRON ? '2.6.2' : '3.0.0-beta.1')
const chatFile = path.join(HOME, 'chats', 'fix-long-thread.json')
const chat = JSON.parse(fs.readFileSync(chatFile, 'utf8'))
chat.snapshot.messages = VARIANT === 'a' ? THREAD_A : VARIANT === 'c' ? THREAD_C : THREAD_B
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

// 목업 ui-notify.js와 같은 계측: 렌더 높이(소수 1자리) + 종별 합계
const MEASURE = `(() => {
  const px = (n) => Math.round(n * 10) / 10
  const th = document.querySelector('.chat-scroll .thread') || document.querySelector('.thread')
  if (!th) return { err: 'no thread' }
  const kids = [...th.children]
  const rows = kids.map((el) => ({
    cls: el.className,
    h: px(el.getBoundingClientRect().height),
    mt: px(parseFloat(getComputedStyle(el).marginTop) || 0),
    txt: (el.textContent || '').slice(0, 34).replace(/\\s+/g, ' ')
  }))
  const cs = getComputedStyle(th)
  return {
    thread: px(th.getBoundingClientRect().height),
    inner: px(th.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)),
    width: px(th.getBoundingClientRect().width),
    n: kids.length,
    rows
  }
})()`


// ★ 크리틱 추가 계측 — '정보 밀도'를 픽셀 말고도 센다.
//   glyphs   보이는 글자 수(공백 제외)            → 글자/px
//   digits   숫자 문자 수                          → 수치가 실제로 남았나
//   numTok   '숫자+단위' 토큰 수(152k · 95% · 42초) → 수치 항목 수
//   actions  누를 수 있는 것(button/[role=button])  → 행동 수
//   lines    렌더된 줄 수 추정(높이/줄높이)
const EXTRA = `(() => {
  const th = document.querySelector('.chat-scroll .thread') || document.querySelector('.thread')
  if (!th) return { err: 'no thread' }
  const strip = (s) => (s || '').replace(/[\\s\\u00a0]/g, '')
  const txt = th.innerText || ''
  const rows = [...th.children].map((el) => {
    const t = el.innerText || ''
    return {
      cls: el.className,
      h: Math.round(el.getBoundingClientRect().height * 10) / 10,
      glyphs: strip(t).length,
      digits: (t.match(/[0-9]/g) || []).length,
      actions: el.querySelectorAll('button, [role=button]').length,
      overflowRight: Math.round((el.scrollWidth - el.clientWidth) * 10) / 10
    }
  })
  return {
    glyphs: strip(txt).length,
    digits: (txt.match(/[0-9]/g) || []).length,
    numTok: (txt.match(/[0-9][0-9.,]*/g) || []).length,
    actions: th.querySelectorAll('button, [role=button]').length,
    rows
  }
})()`

try {
  const cdp = await connectMain()
  await cdp.send('Page.enable').catch(() => {})
  await cdp.send('Runtime.enable').catch(() => {})
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 14, g: 16, b: 22, a: 1 } }).catch(() => {})
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget', {})
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 40, top: 40, width: VIEW.width, height: VIEW.height } })
  } catch { /* 미지원이면 기본 크기 */ }
  const t0 = Date.now()
  for (;;) {
    const ok = await cdp.eval(`!!document.querySelector('.thread') && document.querySelectorAll('.thread > *').length >= 10`).catch(() => false)
    if (ok) break
    if (Date.now() - t0 > 60000) throw new Error('thread never rendered')
    await sleep(200)
  }
  await sleep(2500) // 웹폰트 + rise 애니메이션 정착 (애니메이션 중엔 높이가 거짓)
  if (process.argv.includes('--narrow')) { await cdp.eval("(() => { const st=document.createElement('style'); st.textContent='.thread{max-width:420px !important;margin:0 !important}'; document.head.appendChild(st); return true })()"); await sleep(900) }
  const m = await cdp.eval(MEASURE)
  const x = await cdp.eval(EXTRA)
  if (SHOT) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.mkdirSync(path.dirname(SHOT), { recursive: true })
    fs.writeFileSync(SHOT, Buffer.from(r.data, 'base64'))
  }
  fs.writeFileSync(OUT, JSON.stringify({ variant: VARIANT, exe: EXE, view: VIEW, at: new Date().toISOString(), ...m, extra: x }, null, 1))
  console.log(JSON.stringify({ variant: VARIANT, thread: m.thread, inner: m.inner, width: m.width, n: m.n, glyphs: x.glyphs, digits: x.digits, actions: x.actions }))
  cdp.close()
} finally {
  killTree(proc.pid)
}
