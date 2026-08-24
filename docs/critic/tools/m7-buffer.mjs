// ── M7 크리틱 공격 — 저장 안 된 편집 버퍼에서의 호버/정의 ─────────────────────
//
// 계약면(`@shared/api`)의 `lsp.hover(cwd, rel, pos, text?)` · `lsp.definition(cwd, rel, pos, text?)`
// 네 번째 인자는 **편집 중인 버퍼**다. `app/src/components/CmEditor.tsx:471·552·574`가
// 편집 모드(Ctrl+E)에서 실제로 `view.state.doc.toString()`을 넘긴다.
// 2.6.2 `manager.ts:1994`는 `text != null ? syncBuffer(...) : openDoc(...)`로 그 버퍼를 쓴다.
//
// 시험: 디스크 내용 앞에 빈 줄 K개를 끼운 버퍼를 만들고, **K줄 아래로 밀린 좌표**로 호버/정의를
// 묻는다. 버퍼를 쓰는 구현은 맞히고, 디스크를 보는 구현은 엉뚱한 곳을 본다.
//
//   node m7-buffer.mjs --kind tauri|electron [--exe ...] [--out f.json]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { resolveTauriExe } from '../../../bench/lib.mjs'
import { connectMainPage, killTree, sleep, electronProfile, tauriProfile } from '../../../bench/lib.mjs'
import { makeFixtureHome, FIX_ID } from '../../../bench/fixture.mjs'
import { FIXTURES } from '../../../bench/lspfix.mjs'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const KIND = flag('kind', 'tauri')
// M12 R2 — mainBinaryName 변경으로 exe 이름이 둘이다(구·신 모두 탐색·최신 mtime 우선)
// (격리 타깃 전용 — only:true라 공용 target/이 더 새것이어도 끌려가지 않는다)
const EXE = resolveTauriExe(flag('exe', ''), { targetDir: path.join(os.tmpdir(), 'ccg-m7c-tgt'), only: true })
const OUT = flag('out', '')
const PORT = Number(flag('port', KIND === 'tauri' ? 9411 : 9412))
const WORK = flag('work', path.join(os.tmpdir(), 'ccg-lsp-repo'))
const SHIFT = Number(flag('shift', '7'))

const fix = FIXTURES.ts.make(WORK, { blocks: 420 })
const REL = fix.bigRel
const disk = fs.readFileSync(path.join(WORK, REL), 'utf8')
const buffer = '\n'.repeat(SHIFT) + disk
// 표적: 크로스파일 심볼 makeConfig — 디스크 좌표 → 버퍼에서는 SHIFT줄 아래
const targets = fix.hoverAt.filter((h) => h.word === 'makeConfig').slice(0, 4)
  .concat(fix.defAt.filter((d) => d.word === 'summarize').slice(0, 2))

const PROBE = `(() => {
  if (window.__m7b) return 'already'
  const B = (window.__m7b = {})
  B.run = async (cwd, rel, text, targets, shift) => {
    const a = window.api.lsp
    const rows = []
    for (const t of targets) {
      const shifted = { line: t.line + shift, character: t.character }
      const hv = await a.hover(cwd, rel, shifted, text).catch(() => null)
      const df = await a.definition(cwd, rel, shifted, text).catch(() => null)
      // 대조군: 버퍼 없이 **원래** 좌표(디스크 좌표) — 이건 양쪽 다 맞아야 한다
      const hv0 = await a.hover(cwd, rel, { line: t.line, character: t.character }).catch(() => null)
      rows.push({
        word: t.word, diskLine: t.line, bufLine: shifted.line, ch: t.character,
        bufHover: hv && hv.contents ? hv.contents.replace(/\\s+/g, ' ').slice(0, 70) : null,
        bufDef: df && df[0] ? String(df[0].path).split(/[\\\\/]/).pop() + ':' + df[0].line : null,
        diskHover: hv0 && hv0.contents ? hv0.contents.replace(/\\s+/g, ' ').slice(0, 70) : null
      })
    }
    return rows
  }
  return 'armed'
})()`

function makeHome(kind, version) {
  const home = path.join(os.tmpdir(), `ccg-m7c-buf-${kind}`)
  fs.rmSync(home, { recursive: true, force: true })
  makeFixtureHome(home, version)
  const f = path.join(home, 'chats', `${FIX_ID}.json`)
  const chat = JSON.parse(fs.readFileSync(f, 'utf8'))
  chat.manualCwd = WORK
  if (chat.snapshot) chat.snapshot.cwd = WORK
  fs.writeFileSync(f, JSON.stringify(chat))
  return home
}

const version = KIND === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
const home = makeHome(KIND, version)
const profile = KIND === 'tauri' ? tauriProfile({ port: PORT, exe: EXE }) : electronProfile({ port: PORT })
const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env, CCG_HOME: home }, cwd: profile.cwd, stdio: 'ignore' })
const out = { kind: KIND, version, rel: REL, shift: SHIFT, at: new Date().toISOString() }
const S = (v) => JSON.stringify(v)
try {
  const cdp = await connectMainPage(PORT, { timeoutMs: 90000 })
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  const t0m = Date.now()
  while (Date.now() - t0m < 90000) {
    if (await cdp.eval(profile.mountExpr).catch(() => false)) break
    await sleep(120)
  }
  await sleep(400)
  for (let i = 0; i < 200; i++) {
    await cdp.eval(PROBE).catch(() => {})
    if (await cdp.eval(`!!(window.__m7b && window.api && window.api.lsp)`).catch(() => false)) break
    await sleep(200)
  }
  // ready + 첫 라이브 토큰까지 기다린다(서버가 문서를 아는 상태에서 시험해야 공정)
  for (let i = 0; i < 400; i++) {
    const st = await cdp.eval(`window.api.lsp.status(${S(WORK)}, ${S(REL)})`, { awaitPromise: true }).catch(() => null)
    if (st === 'ready') break
    await sleep(250)
  }
  for (let i = 0; i < 200; i++) {
    const t = await cdp.eval(`window.api.lsp.semanticTokens(${S(WORK)}, ${S(REL)}).then(x => x && x.data ? x.data.length : 0)`, { awaitPromise: true }).catch(() => 0)
    if (t > 0) break
    await sleep(300)
  }
  out.rows = await cdp.eval(`window.__m7b.run(${S(WORK)}, ${S(REL)}, ${S(buffer)}, ${S(targets)}, ${SHIFT})`, { awaitPromise: true, timeoutMs: 120000 })
  const ok = out.rows.filter((r) => r.bufHover && /makeConfig|summarize/.test(r.bufHover))
  out.verdict = {
    n: out.rows.length,
    bufferHoverHits: ok.length,
    bufferDefToLib: out.rows.filter((r) => r.bufDef && /^lib\.ts:/.test(r.bufDef)).length,
    diskControlHits: out.rows.filter((r) => r.diskHover && /makeConfig|summarize/.test(r.diskHover)).length
  }
  try { cdp.close() } catch { /* closed */ }
} catch (e) {
  out.error = String(e?.message ?? e)
} finally {
  killTree(child.pid)
  await sleep(1200)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 잠김 */ }
}
const text = JSON.stringify(out, null, 2)
if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, text) }
console.log(text)
