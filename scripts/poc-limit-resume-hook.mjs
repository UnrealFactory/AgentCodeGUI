/**
 * PoC — 한도 자동 이어서 상태 머신(useLimitResume 훅) 실동작 검증.
 *
 * poc-limit-resume.mjs가 순수 판정(문구·창·지연)을 봤다면, 여기는 진짜 React 위에서
 * 진짜 훅 코드를 구동해 장전→정제→타이머→발화 재검증→ready→전송의 흐름과 가드를
 * 실측한다. 시간은 "한도 대기(≥15s)만 1/1000 축소"하는 setTimeout 심으로 재현
 * (React 내부 소형 타이머는 건드리지 않는다 — 스케줄러는 MessageChannel이라 무관).
 *
 * 시나리오:
 *  A. 한도 에러 턴 → 장전(ref 동기) → usage 정제로 리셋 시각 확보 → 타이머 발화 →
 *     재검증(풀림) → '이어서' 프롬프트 전송 → 대기표 해제
 *  B. 세션 없이 죽은 첫 턴 + 문구 꼬리 epoch → 원문 재전송 폴백
 *  C. busy를 거치지 않은 error(복원/전환) → 장전 안 함 (prev-busy 가드)
 *  D. 발화 재검증에서 아직 소진 → 새 시각으로 재장전(전송 보류) → 풀리면 전송
 *  E. 같은 키의 새 실행(busy 상승) → 해제 / 다른 키의 실행 → 보존
 *  F. 토글 꺼짐 → 발화 없음, 나중에 켜면 그 대기표로 이어서
 *  G. apiMode·중단 여파·비한도 에러 → 장전 안 함
 *  H. canSend 가드(스냅샷 미로드) → ready 보류, readyDep 갱신 후 전송
 *
 * 실행: npx electron scripts/poc-limit-resume-hook.mjs
 */
import { app, BrowserWindow } from 'electron'
import esbuild from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')

const ENTRY = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { useLimitResume } from './src/renderer/src/lib/useLimitResume'

// ── 타이머 축소 심 — 한도 대기(≥15s)만 1/1000로. 훅은 window.setTimeout을 쓴다.
const realSetTimeout = window.setTimeout.bind(window)
;(window as any).setTimeout = (fn: any, d?: number, ...a: any[]) =>
  realSetTimeout(fn, (d ?? 0) >= 15000 ? Math.ceil((d as number) / 1000) : d, ...a)

// ── window.api 스텁 — getUsage는 대본 큐(마지막 항목은 반복), 호출 수 계측
let usageQueue: any[] = []
let usageCalls = 0
;(window as any).api = {
  getUsage: async () => {
    usageCalls++
    return usageQueue.length > 1 ? usageQueue.shift() : usageQueue[0]
  },
  codexAuth: { accountsUsage: async () => [] }
}
const NOW = () => Math.floor(Date.now() / 1000)
const U = (pct: number, resetsAt: number | null) => ({
  fiveHour: { pct, resetsAt }, weekly: null, weeklyFable: null, extraCredit: null
})

// ── 호스트 — 훅 핸들을 밖으로 노출
let handle: any = null
function Host({ surf }: any) {
  handle = useLimitResume(surf)
  return null
}
const mountEl = document.createElement('div')
document.body.appendChild(mountEl)
let root = createRoot(mountEl)
const render = (surf: any) => root.render(React.createElement(Host, { surf }))
const remount = () => { root.unmount(); handle = null; root = createRoot(mountEl) }

const sleep = (ms: number) => new Promise((r) => realSetTimeout(r, ms))
const until = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now()
  while (!cond()) { if (Date.now() - t0 > ms) return false; await sleep(25) }
  return true
}
let pass = 0
const fails: string[] = []
const check = (name: string, ok: boolean, info = '') => {
  if (ok) { pass++; console.log('PASS ' + name) }
  else { fails.push(name); console.log('FAIL ' + name + (info ? ' — ' + info : '')) }
}

// ── 세션 상태 픽스처 — 훅이 읽는 필드만 (status·messages·interrupted·session)
const USER = { kind: 'msg', id: 'u1', role: 'user', text: '긴 작업 해줘' }
const ERR = (text: string) => ({ kind: 'msg', id: 'e1', role: 'assistant', error: true, text })
const SESS = { sessionId: 'sid1', cwd: 'C:/p', model: 'm' }
const stBusy = (sess: any) => ({ status: 'working', messages: [USER], interrupted: false, session: sess })
const stErr = (text: string, sess: any, interrupted = false) =>
  ({ status: 'error', messages: [USER, ERR(text)], interrupted, session: sess })

let sent: string[] = []
const base = (over: any = {}) => ({
  state: stBusy(SESS), busy: false, enabled: true, apiMode: false,
  engine: 'claude', account: undefined, fable: false, holdKey: 'A',
  send: (p: string) => sent.push(p), ...over
})

async function run() {
  // A. 정상 자동 재개 — 리셋 시각은 usage 정제로
  sent = []; usageCalls = 0
  usageQueue = [U(100, NOW() + 3600), U(5, NOW() + 3600)] // 정제: 소진 / 재검증: 풀림
  render(base({ state: stBusy(SESS), busy: true }))
  await sleep(50)
  render(base({ state: stErr('Claude AI usage limit reached', SESS), busy: false }))
  check('A1 장전', await until(() => !!handle?.holdRef.current, 3000))
  check('A2 정제로 리셋 시각 확보', await until(() => handle?.holdRef.current?.resetsAt != null, 3000))
  check('A3 자동 재개 전송', await until(() => sent.length === 1, 9000), 'sent=' + sent.length)
  check('A4 이어서 프롬프트', !!sent[0] && sent[0].includes('이어서'), sent[0])
  check('A5 재개 후 대기표 해제', handle?.holdRef.current == null)
  check('A6 usage 정제+재검증 호출', usageCalls >= 2, String(usageCalls))
  remount()

  // B. 세션 없는 첫 턴 + epoch 꼬리 → 원문 재전송
  sent = []
  const ep = NOW() + 20
  usageQueue = [U(0, null)] // 정제: 막는 창 없음(파싱 시각 유지) / 재검증: 풀림
  render(base({ state: stBusy(null), busy: true }))
  await sleep(50)
  render(base({ state: stErr('Claude AI usage limit reached|' + ep, null), busy: false }))
  check('B1 epoch 파싱', await until(() => handle?.holdRef.current?.resetsAt === ep, 3000))
  check('B2 원문 재전송', (await until(() => sent.length === 1, 6000)) && sent[0] === '긴 작업 해줘', sent[0])
  remount()

  // C. prev-busy 가드 — idle→error(복원·전환 모양)는 장전 안 함
  sent = []; usageQueue = [U(100, NOW() + 3600)]
  render(base({ state: { status: 'idle', messages: [], interrupted: false, session: null }, busy: false }))
  await sleep(50)
  render(base({ state: stErr('Claude AI usage limit reached', SESS), busy: false }))
  await sleep(300)
  check('C1 복원 에러로는 장전 안 함', handle?.holdRef.current == null)
  remount()

  // D. 발화 재검증 재장전 — 아직 소진이면 전송 보류, 새 시각으로 다시
  sent = []; usageCalls = 0
  const ep2 = NOW() + 20
  usageQueue = [U(0, null), U(100, NOW() + 3600), U(5, null)] // 정제:유지 / 발화1:아직 / 발화2:풀림
  render(base({ state: stBusy(SESS), busy: true }))
  await sleep(50)
  render(base({ state: stErr('5-hour limit reached|' + ep2, SESS), busy: false }))
  check('D1 재장전(전송 보류)', await until(() => {
    const h = handle?.holdRef.current
    return !!h && h.resetsAt != null && h.resetsAt > ep2 && sent.length === 0
  }, 5000))
  check('D2 재장전 후 풀리면 전송', await until(() => sent.length === 1, 9000), 'sent=' + sent.length)
  remount()

  // E. busy 상승 에지 — 같은 키는 해제, 다른 키는 보존 (enabled=false로 타이머 배제)
  sent = []; usageQueue = [U(0, null)]
  render(base({ enabled: false, state: stBusy(SESS), busy: true }))
  await sleep(50)
  render(base({ enabled: false, state: stErr('usage limit reached', SESS), busy: false }))
  check('E1 토글 꺼짐에도 장전', await until(() => !!handle?.holdRef.current, 3000))
  render(base({ enabled: false, state: stBusy(SESS), busy: true }))
  check('E2 같은 키 새 실행 → 해제', await until(() => handle?.holdRef.current == null, 3000))
  remount()
  usageQueue = [U(0, null)]
  render(base({ enabled: false, state: stBusy(SESS), busy: true }))
  await sleep(50)
  render(base({ enabled: false, state: stErr('usage limit reached', SESS), busy: false }))
  await until(() => !!handle?.holdRef.current, 3000)
  render(base({ enabled: false, holdKey: 'B', state: stBusy(SESS), busy: true }))
  await sleep(300)
  check('E3 다른 채팅 실행 → 보존', handle?.holdRef.current?.key === 'A')
  remount()

  // F. 토글 꺼짐 → 발화 없음, 켜면 그 대기표로 이어서
  sent = []
  const ep3 = NOW() + 20
  usageQueue = [U(0, null)]
  render(base({ enabled: false, state: stBusy(SESS), busy: true }))
  await sleep(50)
  const errS = stErr('usage limit reached|' + ep3, SESS)
  render(base({ enabled: false, state: errS, busy: false }))
  await until(() => !!handle?.holdRef.current, 3000)
  await sleep(600) // 축소된 발화 시각(110ms)을 훌쩍 지나도
  check('F1 꺼짐 — 전송 없음', sent.length === 0)
  render(base({ enabled: true, state: errS, busy: false }))
  check('F2 켜면 이어서', await until(() => sent.length === 1, 6000))
  remount()

  // G. 장전 가드 3종
  sent = []; usageQueue = [U(100, NOW() + 60)]
  render(base({ apiMode: true, state: stBusy(SESS), busy: true }))
  await sleep(50)
  render(base({ apiMode: true, state: stErr('usage limit reached', SESS), busy: false }))
  await sleep(300)
  check('G1 API 과금 — 장전 안 함', handle?.holdRef.current == null)
  remount()
  render(base({ state: stBusy(SESS), busy: true }))
  await sleep(50)
  render(base({ state: stErr('usage limit reached', SESS, true), busy: false }))
  await sleep(300)
  check('G2 중단 턴 — 장전 안 함', handle?.holdRef.current == null)
  remount()
  render(base({ state: stBusy(SESS), busy: true }))
  await sleep(50)
  render(base({ state: stErr('Invalid API key · Please run /login', SESS), busy: false }))
  await sleep(300)
  check('G3 비한도 에러 — 장전 안 함', handle?.holdRef.current == null)
  remount()

  // H. canSend 가드 — ready 보류 → readyDep 갱신 + 로드 완료 → 전송
  sent = []
  const ep4 = NOW() + 20
  usageQueue = [U(0, null)]
  let loaded = false
  const mk = (dep: number, st: any, busy: boolean) =>
    base({ state: st, busy, canSend: () => loaded, readyDep: dep })
  render(mk(0, stBusy(SESS), true))
  await sleep(50)
  const errH = stErr('usage limit reached|' + ep4, SESS)
  render(mk(0, errH, false))
  check('H1 ready 도달·전송 보류', (await until(() => !!handle?.holdRef.current?.ready, 6000)) && sent.length === 0, 'sent=' + sent.length)
  loaded = true
  render(mk(1, errH, false)) // readyDep 갱신 — 소진 effect 재평가
  check('H2 로드 완료 → 전송', await until(() => sent.length === 1, 3000))
  remount()

  console.log('POC-DONE ' + (fails.length ? 'FAIL ' + fails.length : 'ALL-PASS') + ' (' + pass + ' 통과)')
}
run()
`

// ── 번들 — 진짜 훅 + 진짜 React. i18n만 스텁(localStorage 등 렌더러 전제 차단)
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-limit-hook-'))
await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: root, loader: 'tsx' },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: path.join(workDir, 'bundle.js'),
  plugins: [
    {
      name: 'stub-i18n',
      setup(b) {
        b.onResolve({ filter: /^\.\/i18n$/ }, (a) =>
          a.resolveDir.replace(/\\/g, '/').endsWith('renderer/src/lib') ? { path: 'i18n', namespace: 'stub' } : undefined
        )
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `export const t = (ko) => ko\nexport const useLang = () => 'ko'`,
          loader: 'js'
        }))
      }
    }
  ]
})
fs.writeFileSync(
  path.join(workDir, 'index.html'),
  '<!doctype html><meta charset="utf-8"><body><script src="./bundle.js"></script>'
)

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: { backgroundThrottling: false } // 숨김 창에서도 타이머가 제때 돈다
  })
  let done = false
  const finish = (code) => {
    done = true
    try { fs.rmSync(workDir, { recursive: true, force: true }) } catch { /* 임시 폴더 — 무해 */ }
    app.exit(code)
  }
  win.webContents.on('console-message', (_e, _lv, msg) => {
    console.log('[page]', msg)
    if (msg.startsWith('POC-DONE')) finish(msg.includes('ALL-PASS') ? 0 : 1)
  })
  win.loadFile(path.join(workDir, 'index.html'))
  setTimeout(() => {
    if (!done) {
      console.log('[poc] TIMEOUT — 시나리오가 90s 안에 끝나지 않음')
      finish(2)
    }
  }, 90000)
})
