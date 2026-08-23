// ── M7 크리틱 — cwd 문자열 모양이 서버 인스턴스 수를 바꾼다 ───────────────────
//
// `manager::key_of`는 루트를 **소문자화만** 하고 정규화하지 않는다. 한편
//   prewarm  → `normalize(Path::new(cwd))`      (구분자·후행 슬래시 접힘)
//   status   → `RootRule::ProjectCwd => cwd.to_path_buf()`  (원문 그대로)
// 라서 같은 폴더인데 키가 갈릴 수 있다. 2.6.2는 `ensure`에서 `path.resolve(root)`로
// 정규화한 뒤 키를 만든다(manager.ts:2427) — 그쪽엔 이 구멍이 없다.
//
// 실앱에서 확인: 가짜 LSP 서버(CCG_LSP_MODULES)를 물려 **실제로 몇 벌 뜨는지** 센다.
//   node m7-cwdform.mjs --form back|fwd|trail [--out f.json]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, sleep, tauriProfile } from '../../../bench/lib.mjs'
import { makeFixtureHome, FIX_ID } from '../../../bench/fixture.mjs'

const argv = process.argv.slice(2)
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const FORM = flag('form', 'back')
const EXE = flag('exe', path.join(os.tmpdir(), 'ccg-m7c-tgt', 'release', 'agentcodegui.exe'))
const OUT = flag('out', '')
const PORT = Number(flag('port', '9441'))
const BASE = path.join(os.tmpdir(), 'ccg-lsp-repo')
const CWD = FORM === 'fwd' ? BASE.replace(/\\/g, '/') : FORM === 'trail' ? BASE + '\\' : BASE
const REL = 'lspbench/big.ts'
const MODS = path.join(os.tmpdir(), 'ccg-m7c-wt', 'docs', 'critic', 'tools', 'm7-fakelsp')
const LOG = path.join(os.tmpdir(), `ccg-m7c-flsp-app-${FORM}.jsonl`)
fs.rmSync(LOG, { force: true })

const home = path.join(os.tmpdir(), `ccg-m7c-cwd-${FORM}`)
fs.rmSync(home, { recursive: true, force: true })
makeFixtureHome(home, '3.0.0-beta.1')
{
  const f = path.join(home, 'chats', `${FIX_ID}.json`)
  const c = JSON.parse(fs.readFileSync(f, 'utf8'))
  c.manualCwd = CWD
  if (c.snapshot) c.snapshot.cwd = CWD
  fs.writeFileSync(f, JSON.stringify(c))
}
const profile = tauriProfile({ port: PORT, exe: EXE })
const child = spawn(profile.cmd, profile.args, {
  env: { ...process.env, ...profile.env, CCG_HOME: home, CCG_LSP_MODULES: MODS, FLSP_LOG: LOG, FLSP_SYNC: '2' },
  cwd: profile.cwd, stdio: 'ignore'
})
const out = { form: FORM, cwd: CWD, rel: REL, at: new Date().toISOString() }
const S = (v) => JSON.stringify(v)
try {
  const cdp = await connectMainPage(PORT, { timeoutMs: 90000 })
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable')
  const t0 = Date.now()
  while (Date.now() - t0 < 90000) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(120) }
  await sleep(500)
  // 뷰어가 파일을 여는 것과 같은 순서: status → cachedTokens → semanticTokens
  for (let i = 0; i < 100; i++) {
    const st = await cdp.eval(`window.api.lsp.status(${S(CWD)}, ${S(REL)})`, { awaitPromise: true }).catch(() => null)
    out.status = st
    if (st === 'ready') break
    await sleep(200)
  }
  out.tokens = await cdp.eval(`window.api.lsp.semanticTokens(${S(CWD)}, ${S(REL)}).then(t => t && t.data ? t.data.length/5 : 0)`, { awaitPromise: true }).catch(() => null)
  await sleep(2500)
  try { cdp.close() } catch { /* closed */ }
} catch (e) { out.error = String(e?.message ?? e) } finally {
  killTree(child.pid); await sleep(1500)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 잠김 */ }
}
const lines = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const starts = lines.filter((l) => l.ev === 'start')
const exits = lines.filter((l) => l.ev === 'exit')
const earlyExit = exits.filter((e) => e.t < 4000)
out.serverStarts = starts.length
out.serverPids = starts.map((s) => s.pid)
out.exitsWithin4s = earlyExit.length
out.survivedToShutdown = starts.length - earlyExit.length
out.roots = [...new Set(starts.map((s) => s.cwd))]
const text = JSON.stringify(out, null, 2)
if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, text) }
console.log(text)
