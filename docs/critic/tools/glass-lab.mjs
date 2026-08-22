// 유리(아크릴) 버그 실험실 — "사이드바 유리가 갑자기 진한 회색으로 바뀐다"의 원인을
// OS 레벨 캡처로 확정한다. CDP 스크린샷은 DWM 합성 결과(아크릴)를 담지 못하므로
// 캡처는 전부 GDI CopyFromScreen이다.
//
//   node docs/critic/tools/glass-lab.mjs electron
//   node docs/critic/tools/glass-lab.mjs tauri
//
// 방법: 창 뒤에 **밝은 마젠타 판**을 깔고(비침이 살아 있으면 사이드바가 물든다)
// 상태를 하나씩 만들며 창 사각형을 통째로 찍어 같은 CSS 좌표의 평균 RGB를 비교한다.
//
// [함정] 사용자의 실앱이 보조 모니터에 최대화로 떠 있다 — 그 위에서 찍으면 남의 창을
// 찍는다. 그래서 주 모니터에서 돌리고, 매 캡처마다 WindowFromPoint로 "지금 그 점의
// 최상위 창이 내 창인가"를 검사해 아니면 invalid로 기록한다.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { electronProfile, tauriProfile, connectMainPage, killTree, sleep, REPO } from '../../../bench/lib.mjs'

const TOOLS = path.join(REPO, 'docs', 'critic', 'tools')
const SHOTS = path.join(REPO, 'docs', 'design', 'glass-shots')
fs.mkdirSync(SHOTS, { recursive: true })

const which = process.argv[2] ?? 'electron'

// 주 모니터(DISPLAY2: 0..2560). 사용자의 실앱은 보조(2560..5120)에 최대화되어 있다.
const MON = { x: 0, y: 0, w: 2560, h: 1440 }
const WIN = { x: 140, y: 90, w: 1400, h: 920 }

// 창 좌상단 기준 CSS px — 사이드바/본문의 **평탄한** 면 (2.6.2 레이아웃 실측)
const SIDEBAR_BOX = { x: 20, y: 360, w: 210, h: 440 }
const CHAT_BOX = { x: 600, y: 400, w: 600, h: 360 }

const spawned = []
const nat = (...args) =>
  execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TOOLS, 'glass-native.ps1'), ...args.map(String)],
    { encoding: 'utf8', timeout: 60000 }
  ).trim()
const natJson = (...args) => JSON.parse(nat(...args))

function form(kind, opts) {
  const a = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(TOOLS, 'glass-form.ps1'), '-Kind', kind]
  for (const [k, v] of Object.entries(opts)) a.push('-' + k, String(v))
  const c = spawn('powershell', a, { stdio: 'ignore' })
  spawned.push(c.pid)
  return c
}

async function boot(profile, label) {
  const child = spawn(profile.cmd, profile.args, {
    env: { ...process.env, ...profile.env },
    cwd: profile.cwd,
    stdio: 'ignore'
  })
  spawned.push(child.pid)
  const cdp = await connectMainPage(profile.port, { timeoutMs: 90000 })
  for (;;) {
    const ok = await cdp.eval(profile.mountExpr).catch(() => false)
    if (ok) break
    await sleep(60)
  }
  console.log(`[${label}] pid ${child.pid} mounted`)
  return { child, cdp }
}

const TRANSP_KEY = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
const psCmd = (c) => execFileSync('powershell', ['-NoProfile', '-Command', c], { encoding: 'utf8', timeout: 25000 })
const setTransparency = (on) =>
  psCmd(`Set-ItemProperty '${TRANSP_KEY}' -Name EnableTransparency -Value ${on ? 1 : 0} -Type DWord`)
const getTransparency = () => Number(psCmd(`(Get-ItemProperty '${TRANSP_KEY}').EnableTransparency`).trim())

let transparencyTouched = false
const OUT = { at: new Date().toISOString(), app: which, states: [] }

try {
  const profile = which === 'tauri' ? tauriProfile({ port: 9354 }) : electronProfile({ port: 9353 })

  // 1) 밝은 판 — 창 뒤 (주 모니터 전체)
  form('backdrop', { X: MON.x, Y: MON.y, W: MON.w, H: MON.h, R: 255, G: 0, B: 220, Seconds: 900, Title: 'glass-backdrop' })
  await sleep(2600)
  const bdPid = spawned[spawned.length - 1]
  const bdHwnd = Number(nat('hwnd', bdPid))
  // 2) 포커스 도둑 — 우하단 구석(창 밖)
  form('thief', { X: 2100, Y: 1150, W: 380, H: 190, R: 24, G: 24, B: 24, Seconds: 900, Title: 'glass-thief' })
  await sleep(2200)
  const thiefHwnd = Number(nat('hwnd', spawned[spawned.length - 1]))
  console.log('backdrop', bdHwnd, 'thief', thiefHwnd)

  // 3) 앱
  const app = await boot(profile, which)
  await sleep(2800)
  const hwnd = Number(nat('hwnd', app.child.pid))
  const title = nat('title', hwnd)
  console.log('app hwnd', hwnd, JSON.stringify(title), 'style', nat('style', hwnd))
  OUT.app_hwnd = hwnd
  OUT.app_title = title
  OUT.style = natJson('style', hwnd)

  const dpr = await app.cdp.eval('devicePixelRatio')
  OUT.dpr = dpr

  const place = (x = WIN.x, y = WIN.y, w = WIN.w, h = WIN.h) => {
    nat('place', hwnd, x, y, w, h)
    nat('bottom', bdHwnd)
  }
  const focusApp = () => nat('focus', hwnd)
  const focusThief = () => nat('focus', thiefHwnd)

  async function record(name, note) {
    await sleep(1000)
    const r = natJson('rect', hwnd)
    const gx = Math.max(0, r.l)
    const gy = Math.max(0, r.t)
    const gw = Math.min(r.r, MON.w) - gx
    const gh = Math.min(r.b, MON.h) - gy
    // 샘플 지점의 최상위 창이 내 창인가 (남의 창을 찍고 있지 않은지)
    const sx = r.l + Math.round(SIDEBAR_BOX.x + SIDEBAR_BOX.w / 2)
    const sy = r.t + Math.round(SIDEBAR_BOX.y + SIDEBAR_BOX.h / 2)
    const owner = Number(nat('at', sx, sy))
    const file = path.join(SHOTS, `${which}-${name}.png`)
    nat('grab', file, gx, gy, gw, gh)
    const off = (b) => ({ x: r.l + b.x - gx, y: r.t + b.y - gy, w: b.w, h: b.h })
    const sb = off(SIDEBAR_BOX)
    const cb = off(CHAT_BOX)
    const s = natJson('avg', file, sb.x, sb.y, sb.w, sb.h)
    const c = natJson('avg', file, cb.x, cb.y, cb.w, cb.h)
    const bd = natJson('dwmget', hwnd, 38)
    const fg = Number(nat('fg'))
    const row = {
      name,
      note,
      rect: r,
      sidebar: s,
      chat: c,
      backdropAttr: bd.val,
      focused: fg === hwnd,
      topAtSample: owner === hwnd,
      file: path.basename(file)
    }
    OUT.states.push(row)
    console.log(
      `${name.padEnd(26)} sb=(${s.r},${s.g},${s.b}) chat=(${c.r},${c.g},${c.b}) attr=${bd.val} focus=${row.focused ? 'Y' : 'n'} mine=${row.topAtSample ? 'Y' : 'N'}`
    )
    return row
  }

  // ── 상태별 ────────────────────────────────────────────────────────────────
  place(); focusApp()
  await record('01-normal-focused', '창 모드 · 포커스 있음')

  focusThief(); nat('bottom', bdHwnd)
  await record('02-normal-blurred', '창 모드 · 다른 앱 클릭(포커스 상실)')

  focusApp()
  await record('03-refocused', '다시 포커스')

  nat('show', hwnd, 3); await sleep(700); focusApp()
  await record('04-maximized-focused', '최대화 · 포커스')
  focusThief()
  await record('05-maximized-blurred', '최대화 · 포커스 상실')
  nat('show', hwnd, 9); await sleep(700); place(); focusApp()
  await record('06-restored', '복원')

  nat('show', hwnd, 6); await sleep(1400); nat('show', hwnd, 9); await sleep(900); place(); focusApp()
  await record('07-min-restore', '최소화 → 복원')

  place(MON.x, 0, Math.round(MON.w / 2), 1392); focusApp()
  await record('08-snap-left', '좌측 절반(스냅과 같은 형상)')
  place(); focusApp(); await sleep(400)

  // 앱 위를 다른 창이 완전히 덮었다가 걷힘(Chromium occlusion)
  nat('place', thiefHwnd, WIN.x - 40, WIN.y - 40, WIN.w + 80, WIN.h + 80); nat('top', thiefHwnd)
  await sleep(2500)
  nat('place', thiefHwnd, 2100, 1150, 380, 190)
  await sleep(800); focusApp()
  await record('09-after-full-occlusion', '다른 창이 전부 덮었다가 걷힘')

  // 다른 창이 일부만 겹침 (포커스는 그 창)
  nat('place', thiefHwnd, WIN.x + 900, WIN.y + 500, 380, 190); nat('top', thiefHwnd); focusThief()
  await record('10-partial-overlap', '다른 창이 일부 겹침 · 포커스도 그쪽')
  nat('place', thiefHwnd, 2100, 1150, 380, 190); focusApp(); await sleep(400)

  // 투명 효과 끄기 (= 배터리 절약/에너지 세이버가 자동으로 하는 것과 같은 스위치)
  const before = getTransparency()
  transparencyTouched = true
  setTransparency(false)
  await sleep(2600); place(); focusApp()
  await record('11-transparency-off', '설정 › 색 › 투명 효과 끔 · 포커스')
  focusThief()
  await record('12-transparency-off-blurred', '투명 효과 끔 · 포커스 상실')
  setTransparency(before !== 0)
  transparencyTouched = false
  await sleep(2600); place(); focusApp()
  await record('13-transparency-back', '투명 효과 복구(앱 재시작 없이)')

  // 창을 모니터 전체 크기로(전체화면과 같은 형상)
  place(0, 0, MON.w, MON.h); focusApp()
  await record('14-fullscreen-shape', '모니터 전체 크기(전체화면 형상)')
  place(); focusApp()
  await record('15-final', '원상 복귀')
} catch (e) {
  OUT.error = String(e?.stack ?? e)
  console.error(e)
} finally {
  if (transparencyTouched) { try { setTransparency(true) } catch { /* best effort */ } }
  for (const pid of spawned) killTree(pid)
  fs.writeFileSync(path.join(REPO, 'docs', 'critic', `glass-lab-${which}.json`), JSON.stringify(OUT, null, 2))
  console.log('cleaned pids:', spawned.join(', '))
}
