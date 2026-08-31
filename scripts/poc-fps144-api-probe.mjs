// window.api를 감쌀 수 있나 — 합성 스트리밍 주입의 가능 여부를 두 앱에서 확인.
// 실엔진 팔은 3.0 격리 홈에서 "Not logged in"으로 즉사한다(진단 확인). 대안으로
// 엔진 이벤트 경계에 합성 델타를 넣으려면 그 경계가 **덮어쓸 수 있어야** 한다.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { electronProfile, tauriProfile, connectMainPage, killTree, sleep, REPO } from '../bench/lib.mjs'
import { makeMultiFixture } from '../bench/fixture.mjs'

const kind = process.argv[2] ?? 'tauri'
const SIM = path.join(process.env.LOCALAPPDATA, 'ccg-fps144')
const profile = kind === 'tauri'
  ? tauriProfile({ exe: path.join(SIM, 'AgentCodeGUI3.exe'), port: 11114 })
  : electronProfile({ port: 11115 })
profile.env.CCG_HOME = path.join(REPO, '.bench-home-fps144probe-' + kind)
if (kind === 'tauri') profile.cwd = SIM
fs.rmSync(profile.env.CCG_HOME, { recursive: true, force: true })
makeMultiFixture(profile.env.CCG_HOME, kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2', { panels: 4 })

const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore' })
const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
for (;;) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(100) }
await sleep(4000)

const r = await cdp.eval(`(() => {
  const d = Object.getOwnPropertyDescriptor(window, 'api')
  const out = {
    hasApi: typeof window.api,
    winDesc: d ? { configurable: d.configurable, writable: d.writable, hasGet: !!d.get } : null,
    apiFrozen: window.api ? Object.isFrozen(window.api) : null,
    apiExtensible: window.api ? Object.isExtensible(window.api) : null,
    onEngineEventDesc: null,
    multiOnEventDesc: null,
    canPatchTop: false,
    canPatchMulti: false
  }
  try {
    const de = Object.getOwnPropertyDescriptor(window.api, 'onEngineEvent')
    out.onEngineEventDesc = de ? { configurable: de.configurable, writable: de.writable } : 'absent'
  } catch (e) { out.onEngineEventDesc = 'err:' + e.message }
  try {
    const dm = window.api.multi ? Object.getOwnPropertyDescriptor(window.api.multi, 'onEvent') : null
    out.multiOnEventDesc = dm ? { configurable: dm.configurable, writable: dm.writable } : 'absent'
  } catch (e) { out.multiOnEventDesc = 'err:' + e.message }
  try { const o = window.api.onEngineEvent; window.api.onEngineEvent = o; out.canPatchTop = window.api.onEngineEvent === o } catch (e) { out.canPatchTop = 'err:' + e.message }
  try { const o = window.api.multi.onEvent; window.api.multi.onEvent = o; out.canPatchMulti = window.api.multi.onEvent === o } catch (e) { out.canPatchMulti = 'err:' + e.message }
  return out
})()`)
console.log(kind, JSON.stringify(r, null, 1))
cdp.close()
await sleep(400)
killTree(child.pid)
