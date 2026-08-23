// 2.6.2 기준면 — Electron 메인 프로세스에서 그대로 부른다(창 없음).
// 여기서 재는 것: shell.trashItem 의미론 · Dirent.isDirectory(정션) · protocol.handle 동기성.
const { app, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

const out = (k, v) => console.log('@@' + k + '\t' + JSON.stringify(v))
const recycleCount = () => {
  try {
    return parseInt(
      execFileSync('powershell', ['-NoProfile', '-Command',
        '@((New-Object -ComObject Shell.Application).NameSpace(10).Items()).Count'],
        { encoding: 'utf8' }).trim(), 10)
  } catch { return -1 }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const B = path.join(os.tmpdir(), 'ccg-m6-262')
  fs.rmSync(B, { recursive: true, force: true })
  fs.mkdirSync(B, { recursive: true })

  // ── 1. 휴지통 의미론: subst 드라이브(휴지통 없음) vs 보통 볼륨 ──────────────
  const cases = {}
  if (fs.existsSync('X:\\')) {
    const f = 'X:\\nuke-me-262.txt'
    fs.writeFileSync(f, '이 파일이 휴지통에 가야 한다\n')
    const before = recycleCount()
    let ok = true, err = null
    try { await shell.trashItem(f) } catch (e) { ok = false; err = String(e && e.message || e) }
    await sleep(500)
    const after = recycleCount()
    cases.subst = { op_ok: ok, op_err: err, file_gone: !fs.existsSync(f),
                    recycle_before: before, recycle_after: after, went_to_recycle_bin: after > before }
  } else cases.subst = { skipped: 'X: 없음' }

  const f2 = path.join(B, 'normal.txt')
  fs.writeFileSync(f2, 'normal\n')
  const b2 = recycleCount()
  let ok2 = true
  try { await shell.trashItem(f2) } catch { ok2 = false }
  await sleep(500)
  const a2 = recycleCount()
  cases.normal_c = { op_ok: ok2, file_gone: !fs.existsSync(f2), recycle_before: b2, recycle_after: a2, went_to_recycle_bin: a2 > b2 }
  out('trash_semantics_262', cases)

  // ── 2. 정션이 Dirent에서 폴더로 보이나 (2.6.2 listDir의 e.isDirectory()) ────
  const J = path.join(B, 'junc')
  fs.mkdirSync(path.join(J, 'target'), { recursive: true })
  fs.writeFileSync(path.join(J, 'target', 'in.txt'), 'x')
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', path.join(J, 'link'), path.join(J, 'target')], { stdio: 'ignore' })
  } catch { /* 권한 */ }
  const ents = fs.readdirSync(J, { withFileTypes: true })
  out('junction_262', {
    rows: ents.map((e) => ({ name: e.name, dir: e.isDirectory(), file: e.isFile(), link: e.isSymbolicLink() }))
  })

  // ── 3. 긴 경로(>260) trashItem ──────────────────────────────────────────────
  let deep = path.join(B, 'long')
  fs.mkdirSync(deep, { recursive: true })
  const seg = 'd'.repeat(40)
  let mkOk = true
  for (let i = 0; i < 7; i++) {
    deep = path.join(deep, seg)
    try { fs.mkdirSync(deep) } catch { mkOk = false; break }
  }
  const lf = path.join(deep, '긴이름파일.txt')
  let wrote = false
  try { fs.writeFileSync(lf, 'long\n'); wrote = true } catch { /* */ }
  const rb = recycleCount()
  let lok = true, lerr = null
  try { await shell.trashItem(lf) } catch (e) { lok = false; lerr = String(e && e.message || e) }
  await sleep(500)
  const ra = recycleCount()
  out('longpath_trash_262', { mkOk, len: lf.length, wrote, ok: lok, err: lerr, still: fs.existsSync(lf),
                              recycle_before: rb, recycle_after: ra, went_to_recycle_bin: ra > rb })

  // ── 4. 폴더 통째 trashItem — discard(미추적 폴더 행)의 반경 ─────────────────
  const D = path.join(B, 'newdir')
  fs.mkdirSync(path.join(D, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(D, 'a.txt'), 'a')
  fs.writeFileSync(path.join(D, 'nested', 'b.txt'), 'b')
  const drb = recycleCount()
  let dok = true
  try { await shell.trashItem(D) } catch { dok = false }
  await sleep(500)
  out('dir_trash_262', { ok: dok, gone: !fs.existsSync(D), recycle_before: drb, recycle_after: recycleCount() })

  fs.rmSync(B, { recursive: true, force: true })
  app.exit(0)
})
