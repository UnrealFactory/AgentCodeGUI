// ── M6 실증 하네스 — 파일·Git·뷰어의 "IDE 크롬 세로 조각" ────────────────────
//
//   node bench/m6.mjs tauri        3.0.0 (target/release/agentcodegui.exe)
//   node bench/m6.mjs electron     2.6.2 기준
//   node bench/m6.mjs both         둘 다 (A/B)
//
// 산출: bench/shots/m6-<kind>/*.png + report.json
//
// [격리 규약]
//  - 홈: %TEMP%/ccg-m6-home-<kind>  (실홈은 읽기/복사만 — fixture.mjs 규약)
//  - 작업 폴더: %TEMP%/ccg-m6-repo  = **이 레포의 로컬 클론**.
//    실 레포를 절대 안 건드린다. 클론이라 히스토리·브랜치·원격이 진짜라서 log/status/
//    diff가 실물과 같은 모양으로 나오고, 커밋/되돌리기 같은 쓰기도 안전하게 눌러볼 수 있다.
//  - 클론에 **의도한 더티 상태**를 심는다: 수정 1 · 새 파일 1 · 삭제 1 ·
//    그리고 **수천 줄 diff 1개 + 1.5MB 초과 1개**(캡 동작 확인).
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { electronProfile, tauriProfile, connectMainPage, killTree, sleep, REPO } from './lib.mjs'
import { makeFixtureHome, FIX_ID } from './fixture.mjs'
import { HELPERS_JS, makeCtx } from './screens.mjs'

const which = process.argv[2] ?? 'tauri'
const KINDS = which === 'both' ? ['electron', 'tauri'] : [which]
const KEEP = process.argv.includes('--keep')
const VIEW = { width: 1440, height: 900 }
const WORK = path.join(os.tmpdir(), 'ccg-m6-repo')

const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// ── 휴지통 저울 ───────────────────────────────────────────────────────────────
//
// 크리틱 R1 §6이 지목한 **빠진 눈금**: R1의 `file-ops-write-path`는 deletePath를
// 부르고 "없어졌나"만 봤다. 그런데 삭제의 계약은 "없어졌다"가 아니라
// **"휴지통에 들어갔다"**다 — 그 눈금이 없어서 휴지통 없는 볼륨에서 조용히 영구
// 삭제하는 회귀(§S1)가 A/B를 통과했다. 여기서 두 저울을 같이 본다:
//   ① 휴지통 **항목 수 +1**(Shell.Application NameSpace(10))
//   ② 그 항목이 **바로 그 파일**인지 (`$Recycle.Bin`의 `$I` 메타에 원본 경로가 있다)
// ②는 뒷정리도 겸한다 — 시험 잔해를 사용자 휴지통에 남기지 않는다.
const ps = (cmd) => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return ''
  }
}
const recycleCount = () => {
  const n = Number(ps('@((New-Object -ComObject Shell.Application).NameSpace(10).Items()).Count'))
  return Number.isFinite(n) ? n : -1
}
/** 휴지통에서 이 절대 경로로 삭제된 항목의 `$R…` 실제 경로 (없으면 null) */
function recycleEntryFor(absPath) {
  const drive = absPath.slice(0, absPath.indexOf(':') + 1) || 'C:'
  const bin = path.join(drive + '\\', '$Recycle.Bin')
  const want = absPath.toLowerCase()
  let sids = []
  try { sids = fs.readdirSync(bin) } catch { return null }
  for (const sid of sids) {
    let names = []
    try { names = fs.readdirSync(path.join(bin, sid)) } catch { continue }
    for (const n of names) {
      if (!n.startsWith('$I')) continue
      let buf
      try { buf = fs.readFileSync(path.join(bin, sid, n)) } catch { continue }
      if (buf.length < 30) continue
      // $I 포맷 v2: 헤더8 · 원본크기8 · 삭제시각8 · 경로길이4 · UTF-16LE 경로
      const s = buf.subarray(28).toString('utf16le').split('\0')[0]
      if (s.toLowerCase() === want) return path.join(bin, sid, '$R' + n.slice(2))
    }
  }
  return null
}
/** 시험이 넣은 항목을 사용자 휴지통에서 되지운다(최선 노력) */
function recyclePurge(absPath) {
  const r = recycleEntryFor(absPath)
  if (!r) return false
  const base = path.basename(r)
  if (!r.includes('$Recycle.Bin') || !base.startsWith('$R')) return false
  try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* 잠김 */ }
  try { fs.rmSync(path.join(path.dirname(r), '$I' + base.slice(2)), { force: true }) } catch { /* 잠김 */ }
  return true
}

// ── 작업 폴더(클론) 준비 ───────────────────────────────────────────────────────
function makeWorkRepo() {
  fs.rmSync(WORK, { recursive: true, force: true })
  // --local: 같은 파일시스템이면 object를 하드링크로 — 큰 레포도 순식간이고 디스크도 안 먹는다
  execFileSync('git', ['clone', '--local', '--no-hardlinks', '--quiet', REPO, WORK], { stdio: 'ignore' })
  git(WORK, ['config', 'user.email', 'bench@example.com'])
  git(WORK, ['config', 'user.name', 'Bench'])
  // [함정] 여기서 core.autocrlf를 만지면 안 된다. Git for Windows는 **system** 설정에
  // autocrlf=true를 넣어두는데, 체크아웃은 그걸로 CRLF를 쓴 뒤였다 → 클론 로컬에
  // autocrlf=false를 박으면 그 순간 전 텍스트 파일이 '수정됨'이 된다(실측 641개).
  // 게다가 그 판정은 git의 racily-clean 규칙 탓에 실행마다 개수가 흔들려서 A/B가
  // 서로 다른 상태를 보게 된다. 체크아웃과 같은 설정을 그대로 둔다.
  // status를 두 번 불러 인덱스 stat 캐시를 확정한다(첫 호출이 refresh 후 되쓴다).
  git(WORK, ['status', '--porcelain'])
  git(WORK, ['status', '--porcelain'])

  // ① 평범한 수정 — 몇 줄만
  const readme = path.join(WORK, 'README.md')
  fs.writeFileSync(readme, '<!-- m6 bench edit -->\n' + fs.readFileSync(readme, 'utf8'))
  // ② 새 파일(미추적)
  fs.writeFileSync(path.join(WORK, 'M6-NEW.txt'), 'bench가 만든 새 파일\nsecond line\n')
  // ③ 삭제된 파일
  fs.rmSync(path.join(WORK, 'LICENSE'))
  // ④ 수천 줄 diff — 8000줄 파일에서 500곳을 바꾼다(D=1000 ≤ 상한 2000 → 정확한 diff)
  const base = Array.from({ length: 8000 }, (_, i) => `line ${i}`).join('\n') + '\n'
  fs.writeFileSync(path.join(WORK, 'M6-BIG.txt'), base)
  // ⑤ 1.5MB 초과 — diff를 접어야 하는 파일
  fs.writeFileSync(path.join(WORK, 'M6-HUGE.txt'), 'x'.repeat(1_600_000) + '\n')
  git(WORK, ['add', 'M6-BIG.txt', 'M6-HUGE.txt'])
  git(WORK, ['commit', '-qm', 'bench: 대형 파일 두 개 심기'])
  fs.writeFileSync(
    path.join(WORK, 'M6-BIG.txt'),
    Array.from({ length: 8000 }, (_, i) => (i % 16 === 0 ? `line ${i} CHANGED` : `line ${i}`)).join('\n') + '\n'
  )
  fs.writeFileSync(path.join(WORK, 'M6-HUGE.txt'), 'y'.repeat(1_600_000) + '\n')
  // ⑥ 목록이 길 때도 같은지 — 추적 파일 60개에 결정적으로 한 줄씩 붙인다
  //    (2.6.2에서 status 목록이 길면 스트립 배지·카드 목록이 실제로 쓰이는 자리다)
  const bulk = git(WORK, ['ls-files', 'app/src'])
    .split('\n')
    .filter((p) => p.endsWith('.ts') || p.endsWith('.tsx'))
    .sort()
    .slice(0, 60)
  for (const rel of bulk) fs.appendFileSync(path.join(WORK, rel), '\n// m6 bench touch\n')

  return {
    branch: git(WORK, ['rev-parse', '--abbrev-ref', 'HEAD']),
    commits: Number(git(WORK, ['rev-list', '--count', 'HEAD'])),
    dirty: git(WORK, ['status', '--porcelain']).split('\n').filter(Boolean).length
  }
}

// ── 홈 준비 (작업 폴더를 클론으로 갈아끼운다) ─────────────────────────────────
function makeHome(kind, version) {
  const home = path.join(os.tmpdir(), `ccg-m6-home-${kind}`)
  fs.rmSync(home, { recursive: true, force: true })
  makeFixtureHome(home, version)
  const f = path.join(home, 'chats', `${FIX_ID}.json`)
  const chat = JSON.parse(fs.readFileSync(f, 'utf8'))
  chat.manualCwd = WORK
  if (chat.snapshot) chat.snapshot.cwd = WORK
  fs.writeFileSync(f, JSON.stringify(chat))
  return home
}

// ── 검사 ──────────────────────────────────────────────────────────────────────
/** target/release의 exe를 **내 폴더로 복사해** 쓴다.
 *  같은 레포에서 다른 빌더가 동시에 `rm -f target/release/agentcodegui.exe` 후 재빌드를
 *  돌리므로(os error 5 회피 관례), 그 순간에 스폰하면 ENOENT로 실행이 통째로 죽는다.
 *  복사본을 잡아두면 하네스가 남의 빌드에 안 흔들린다. */
async function snapshotExe() {
  const src = path.join(REPO, 'target', 'release', 'agentcodegui.exe')
  const dir = path.join(os.tmpdir(), 'ccg-m6-exe')
  fs.mkdirSync(dir, { recursive: true })
  const dst = path.join(dir, 'agentcodegui.exe')
  // 남의 재빌드 구간이면 파일이 잠깐 사라진다 — 나타날 때까지 기다렸다 한 번만 뜬다
  for (let i = 0; i < 80; i++) {
    try {
      fs.copyFileSync(src, dst)
      console.log(`[m6] exe 스냅샷 → ${dst} (${fs.statSync(dst).size}B)`)
      return dst
    } catch {
      if (i === 0) console.log('[m6] target/release/agentcodegui.exe 없음 — 다른 빌더의 재빌드 대기')
      await sleep(5000)
    }
  }
  throw new Error('exe 스냅샷 실패 — target/release/agentcodegui.exe가 끝내 안 나타남')
}
let EXE = null

async function run(kind) {
  const version = kind === 'tauri' ? '3.0.0-beta.1' : '2.6.2'
  const profile = kind === 'tauri' ? tauriProfile({ port: 9356, exe: EXE }) : electronProfile({ port: 9355 })
  const home = makeHome(kind, version)
  const out = path.join(REPO, 'bench', 'shots', `m6-${kind}`)
  fs.mkdirSync(out, { recursive: true })

  const child = spawn(profile.cmd, profile.args, {
    env: { ...process.env, ...profile.env, CCG_HOME: home },
    cwd: profile.cwd,
    stdio: 'ignore'
  })
  const checks = []
  const shot = async (cdp, id) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
    if (r?.data) fs.writeFileSync(path.join(out, `${id}.png`), Buffer.from(r.data, 'base64'))
  }
  const check = async (id, fn) => {
    const t0 = Date.now()
    try {
      const detail = await fn()
      checks.push({ id, ok: true, ms: Date.now() - t0, detail })
      console.log(`  [ok]   ${id} — ${JSON.stringify(detail)}`)
    } catch (e) {
      checks.push({ id, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e) })
      console.log(`  [FAIL] ${id} — ${e?.message ?? e}`)
    }
  }

  let cdp
  try {
    cdp = await connectMainPage(profile.port, { timeoutMs: 60000 })
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    // 창 크기·배경을 두 앱에 똑같이 (아크릴은 CDP 캡처에 안 담긴다 — 가짜 차이 방지)
    const { windowId } = await cdp.send('Browser.getWindowForTarget').catch(() => ({}))
    if (windowId) await cdp.send('Browser.setWindowBounds', { windowId, bounds: { ...VIEW, windowState: 'normal' } }).catch(() => {})
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 17, g: 18, b: 22, a: 1 } }).catch(() => {})
    // 마운트 대기
    for (let i = 0; i < 600; i++) {
      if (await cdp.eval(profile.mountExpr).catch(() => false)) break
      await sleep(100)
    }
    await sleep(1200)
    await cdp.eval(HELPERS_JS)
    const ctx = makeCtx(cdp)

    // ── 1. 탐색기 트리 ─────────────────────────────────────────────────────
    await check('explorer-tree', async () => {
      await ctx.openExplorer()
      await ctx.waitFor('.lcol .explorer .fxtree .fxr', 12000)
      const rows = await ctx.count('.explorer .fxtree .fxr')
      const names = await cdp.eval(
        `[...document.querySelectorAll('.explorer .fxtree .fxr')].slice(0,8).map(r=>r.textContent.trim())`
      )
      if (rows < 5) throw new Error(`트리 행이 ${rows}개뿐`)
      // 폴더 먼저 · 이름순 — 클론 루트의 첫 항목은 '.github'(폴더)여야 한다
      return { rows, first: names }
    })
    await shot(cdp, '01-explorer-tree')

    // ── 2. Git 스트립 (ab.mjs의 explorer-git-strip과 같은 assert) ──────────
    await check('explorer-git-strip', async () => {
      await ctx.waitFor('.explorer .git-strip .br', 15000)
      const info = await cdp.eval(`(() => {
        const s = document.querySelector('.explorer .git-strip'); if (!s) return null
        return { branch: s.querySelector('.br')?.textContent ?? '', pills: [...s.querySelectorAll('.pill')].map(p=>p.textContent.trim()) }
      })()`)
      if (!info?.branch) throw new Error('브랜치 라벨이 비어 있다')
      return info
    })
    await shot(cdp, '02-git-strip')

    // ── 3. 코드 뷰어 — 진짜 파일 내용 ───────────────────────────────────────
    await check('viewer-code-read', async () => {
      await ctx.openFile('package.json')
      // 줄번호 거터를 빼고 **본문만** 본다 — 디스크의 그 파일과 같은 줄이 떠야 통과다
      const body = await cdp.eval(`(document.querySelector('.fv-body .cm-content')?.innerText ?? '')`)
      const lines = await ctx.count('.fv-body .cm-line')
      const disk = fs.readFileSync(path.join(WORK, 'package.json'), 'utf8')
      const firstDisk = disk.split(/\r?\n/).slice(0, 6).map((l) => l.trim()).filter(Boolean)
      for (const l of firstDisk)
        if (!body.includes(l)) throw new Error(`뷰어에 디스크 줄이 없다: ${JSON.stringify(l)}`)
      return { cmLines: lines, head: body.split('\n').slice(0, 3).map((s) => s.trim()) }
    })
    await shot(cdp, '03-viewer-code')
    await ctx.closeViewer()
    await ctx.clearSearch()

    // ── 4. 마크다운 렌더 ────────────────────────────────────────────────────
    await check('viewer-markdown', async () => {
      await ctx.openFile('README.md')
      await ctx.waitFor('.fv-body .fv-md .content', 8000)
      const chars = await cdp.eval(`(document.querySelector('.fv-body .fv-md .content')?.innerText ?? '').length`)
      if (chars < 200) throw new Error(`렌더된 글자가 ${chars}자뿐`)
      return { chars }
    })
    await shot(cdp, '04-viewer-markdown')
    await ctx.closeViewer()
    await ctx.clearSearch()

    // ── 5. Git 카드 — 변경 목록 ─────────────────────────────────────────────
    await check('git-changes', async () => {
      await ctx.click('.explorer .git-strip')
      await ctx.waitFor('.gitm-overlay .gitm-modal', 8000)
      await ctx.waitFor('.gitm-modal .gitm-list', 8000)
      await sleep(600)
      const files = await cdp.eval(
        `[...document.querySelectorAll('.gitm-list .gitm-row, .gitm-list .f-row, .gitm-list .gm-row')].map(r=>r.textContent.trim()).slice(0,20)`
      )
      const txt = await cdp.eval(`document.querySelector('.gitm-modal')?.innerText ?? ''`)
      for (const need of ['README.md', 'M6-NEW.txt', 'LICENSE', 'M6-BIG.txt'])
        if (!txt.includes(need)) throw new Error(`변경 목록에 ${need}가 없다`)
        return { rows: files.length, sample: txt.split('\n').filter(Boolean).slice(0, 12) }
    })
    await shot(cdp, '05-git-changes')

    // ── 6. 히스토리 + 커밋 상세 ─────────────────────────────────────────────
    await check('git-history', async () => {
      await ctx.clickText('.gitm-nav .gitm-item, .gitm-nav button', '히스토리')
      await ctx.waitFor('.gitm-modal .gitm-list .c-line', 12000)
      const n = await ctx.count('.gitm-modal .gitm-list .c-line')
      if (n < 3) throw new Error(`커밋 줄이 ${n}개뿐`)
      return { commits: n }
    })
    await shot(cdp, '06-git-history')

    await check('git-commit-detail', async () => {
      await ctx.click('.gitm-modal .gitm-list .c-line', 1)
      await ctx.waitFor('.gitm-detail .gd-msg', 8000)
      const txt = await cdp.eval(`document.querySelector('.gitm-detail')?.innerText ?? ''`)
      if (txt.trim().length < 10) throw new Error('상세가 비어 있다')
      return { chars: txt.length, head: txt.split('\n').filter(Boolean)[0]?.slice(0, 60) }
    })
    await shot(cdp, '07-git-commit-detail')
    await ctx.esc(2)
    await ctx.waitGone('.gitm-overlay', 4000)

    // ── 7. 큰 diff — 수천 줄에서 크래시 없음 ────────────────────────────────
    await check('big-diff-thousands', async () => {
      const t0 = Date.now()
      const r = await cdp.eval(`window.api.git.fileDiff(${JSON.stringify(WORK)}, 'M6-BIG.txt')`, {
        awaitPromise: true,
        timeoutMs: 60000
      })
      const ms = Date.now() - t0
      if (!r?.diff) throw new Error(`diff가 없다: ${r?.error}`)
      if (r.diff.add !== 500 || r.diff.del !== 500)
        throw new Error(`add/del=${r.diff.add}/${r.diff.del} (기대 500/500)`)
      return { add: r.diff.add, del: r.diff.del, lines: r.diff.lines.length, ms }
    })

    // ── 8. 1.5MB 초과 — diff를 접고 사유를 준다 ─────────────────────────────
    await check('big-diff-cap-folds', async () => {
      const r = await cdp.eval(`window.api.git.fileDiff(${JSON.stringify(WORK)}, 'M6-HUGE.txt')`, {
        awaitPromise: true,
        timeoutMs: 60000
      })
      if (r?.diff) throw new Error('1.5MB 초과인데 diff를 그렸다(캡 미작동)')
      if (!r?.error) throw new Error('사유가 없다')
      return { error: r.error }
    })

    // ── 9. 앱이 살아 있나 (캡 검사 뒤 크래시 확인) ──────────────────────────
    await check('alive-after-big-diff', async () => {
      const rows = await ctx.count('.explorer .fxtree .fxr')
      if (!rows) throw new Error('탐색기가 사라졌다 = 렌더러 사망 의심')
      return { treeRows: rows }
    })
    await shot(cdp, '08-alive')

    // ── 10. 채널 면 직접 호출 (화면을 안 거치는 계약 확인) ──────────────────
    await check('channel-surface', async () => {
      const r = await cdp.eval(
        `(async () => {
          const cwd = ${JSON.stringify(WORK)}
          const [dir, files, read, st, repos, branches, log] = await Promise.all([
            window.api.listDir(cwd, ''),
            window.api.listFiles(cwd),
            window.api.readFile(cwd, 'package.json'),
            window.api.git.status(cwd),
            window.api.git.repos(cwd),
            window.api.git.branches(cwd),
            window.api.git.log(cwd, 5, 0)
          ])
          return {
            listDir: dir.length, dirsFirst: dir.length ? dir[0].dir : null,
            listFiles: files.length,
            readChars: (read.content || '').length, readErr: read.error ?? null,
            repo: st.repo, branch: st.branch, changed: st.files.length, hasRemote: st.hasRemote,
            repos: repos.length, branches: branches.length, logCommits: log.commits.length, logMore: log.hasMore
          }
        })()`,
        { awaitPromise: true, timeoutMs: 60000 }
      )
      for (const [k, v] of Object.entries({
        listDir: r.listDir > 0, listFiles: r.listFiles > 100, readChars: r.readChars > 100,
        repo: r.repo === true, branch: !!r.branch, changed: r.changed >= 4,
        repos: r.repos === 1, branches: r.branches >= 1, logCommits: r.logCommits === 5, logMore: r.logMore === true
      }))
        if (!v) throw new Error(`${k} 실패: ${JSON.stringify(r)}`)
      return r
    })

    // ── 11. 탐색기 파일 작업 (클론이라 안전하게 쓴다) ───────────────────────
    await check('file-ops-write-path', async () => {
      const r = await cdp.eval(
        `(async () => {
          const cwd = ${JSON.stringify(WORK)}
          const made = await window.api.createPath(cwd, 'm6-ops/hello.txt', false)
          const wrote = await window.api.writeFile(cwd, 'm6-ops/hello.txt', 'hello\\nworld\\n')
          const back = await window.api.readFile(cwd, 'm6-ops/hello.txt')
          const renamed = await window.api.renamePath(cwd, 'm6-ops/hello.txt', 'bye.txt')
          const dup = await window.api.createPath(cwd, 'm6-ops/bye.txt', false)
          const moved = await window.api.movePath(cwd, 'm6-ops/bye.txt', 'm6-ops/../m6-moved.txt')
          const escaped = await window.api.movePath(cwd, 'm6-moved.txt', '../outside.txt')
          const gone = await window.api.deletePath(cwd, 'm6-moved.txt')
          // 뒷정리 — 남기면 다음 앱의 트리 행 수가 달라져 A/B가 어긋난다
          const swept = await window.api.deletePath(cwd, 'm6-ops')
          return { made: made.ok, wrote: wrote.ok, back: back.content, renamed: renamed.ok,
                   dupRefused: dup.ok === false, moved: moved.ok, escapeRefused: escaped.ok === false,
                   gone: gone.ok, swept: swept.ok }
        })()`,
        { awaitPromise: true, timeoutMs: 30000 }
      )
      for (const k of ['made', 'wrote', 'renamed', 'moved', 'gone', 'swept', 'dupRefused', 'escapeRefused'])
        if (!r[k]) throw new Error(`${k} 실패: ${JSON.stringify(r)}`)
      if (r.back !== 'hello\nworld\n') throw new Error(`읽기 왕복 불일치: ${JSON.stringify(r.back)}`)
      if (fs.existsSync(path.join(WORK, 'm6-moved.txt'))) throw new Error('삭제됐어야 할 파일이 남아 있다')
      return r
    })

    // ── 11b. 삭제의 **행선지** — 파일이 휴지통에 들어가나 (크리틱 R1 §S1·§6) ──
    //     "없어졌다"만 재던 눈금에 하나를 더한다. 2.6.2(shell.trashItem)와 3.0이
    //     같은 답을 내야 한다: 항목 수 +1 · 그 항목이 바로 그 파일.
    await check('delete-goes-to-recycle-bin', async () => {
      const name = `m6-trash-${kind}-${Date.now()}.txt`
      const abs = path.join(WORK, name)
      fs.writeFileSync(abs, '휴지통으로 가야 한다\n')
      const before = recycleCount()
      const r = await cdp.eval(
        `window.api.deletePath(${JSON.stringify(WORK)}, ${JSON.stringify(name)})`,
        { awaitPromise: true, timeoutMs: 30000 }
      )
      await sleep(800)
      const after = recycleCount()
      const entry = recycleEntryFor(abs)
      const cleaned = recyclePurge(abs) // 사용자 휴지통에 시험 잔해를 남기지 않는다
      if (!r?.ok) throw new Error(`삭제가 실패했다: ${JSON.stringify(r)}`)
      if (fs.existsSync(abs)) throw new Error('파일이 그대로 있다')
      if (before < 0 || after < 0) throw new Error('휴지통 항목 수를 못 셌다(PowerShell)')
      if (after <= before) throw new Error(`휴지통 항목이 안 늘었다 = 영구 삭제 (${before} → ${after})`)
      if (!entry) throw new Error(`휴지통에 그 파일이 없다: ${abs}`)
      return { before, after, delta: after - before, foundInBin: true, cleaned }
    })

    // ── 12a. 채널 면 감사 — fs/shell/git 상수를 **하나씩** 때려 미구현을 센다.
    //     심의 안전값에 가려 "화면은 뜨는데 채널은 죽어 있는" 상태를 못 보게 되므로,
    //     여기서는 `__unimplemented` 마커를 직접 본다(3.0 전용 — 2.6.2엔 이 규약이 없다).
    if (kind === 'tauri')
      await check('channel-audit', async () => {
        const cwd = WORK
        const probes = {
          'fs:list-dir': [{ cwd, rel: '' }],
          'fs:list-files': [cwd],
          'fs:read-file': [{ cwd, relPath: 'package.json' }],
          'fs:write-file': [{ cwd, relPath: 'm6-probe.txt', content: 'x' }],
          'fs:create': [{ cwd, relPath: 'm6-probe2.txt', dir: false }],
          'fs:rename': [{ cwd, relPath: 'm6-probe2.txt', newName: 'm6-probe3.txt' }],
          'fs:move': [{ cwd, srcRel: 'm6-probe3.txt', destRel: 'm6-probe4.txt' }],
          'fs:delete': [{ cwd, relPath: 'm6-probe4.txt' }],
          'fs:dir-exists': [cwd],
          'shell:open-path': null, // 실제로 앱을 띄우므로 감사에서 뺀다(구현은 코드로 확인)
          'shell:reveal-path': null,
          'git:repos': [cwd],
          'git:status': [cwd],
          'git:log': [{ cwd, limit: 3, skip: 0 }],
          'git:file-diff': [{ cwd, rel: 'README.md' }],
          'git:commit-detail': [{ cwd, hash: 'HEADHEAD' }],
          'git:commit-file-diff': [{ cwd, hash: 'HEADHEAD', rel: 'README.md' }],
          'git:commit': [{ cwd, files: [], subject: '', body: '' }], // 파일 0 → 거절(쓰기 없음)
          'git:push': null, // 네트워크 — 감사에서 뺀다
          'git:pull': null,
          'git:fetch': null,
          'git:discard': [{ cwd, rel: 'no-such-file-m6', untracked: false }],
          'git:branches': [cwd],
          'git:switch-branch': [{ cwd, name: 'no-such-branch-m6' }],
          'git:create-branch': [{ cwd, name: '' }], // 빈 이름 → 거절(브랜치 안 만듦)
          'fs:html-preview-url': [{ cwd, relPath: 'app/toast.html' }],
          'git:ai-message': [{ cwd, files: [] }]
        }
        const asked = Object.entries(probes).filter(([, a]) => a !== null)
        const r = await cdp.eval(
          `(async () => {
             const out = {}
             for (const [channel, payload] of ${JSON.stringify(asked)}) {
               try {
                 const v = await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel, payload })
                 out[channel] = !!(v && typeof v === 'object' && v.__unimplemented) ? 'unimplemented' : 'ok'
               } catch (e) { out[channel] = 'threw:' + String(e).slice(0, 60) }
             }
             return out
           })()`,
          { awaitPromise: true, timeoutMs: 60000 }
        )
        const missing = Object.entries(r).filter(([, v]) => v !== 'ok').map(([k, v]) => `${k}=${v}`)
        // 이번 라운드가 의도적으로 남긴 둘만 미구현이어야 한다
        const expected = ['fs:html-preview-url=unimplemented', 'git:ai-message=unimplemented']
        if (missing.sort().join(',') !== expected.sort().join(','))
          throw new Error(`미구현 목록이 예상과 다르다: ${JSON.stringify(missing)}`)
        return { probed: asked.length, ok: asked.length - missing.length, unimplemented: missing }
      })

    // ── 12b. 로컬 이미지 스킴 — 셸이 바이트를 내주나 (렌더러 배선은 별건, 리포트 §미구현)
    //     2.6.2는 ccg-img://local/?p=…, 3.0(Windows/WebView2)은 http://ccg-img.localhost/….
    //     둘 다 "그 앱에서 실제로 그려지는" 모양이라 앱별로 URL을 갈라 넣는다.
    await check('local-image-scheme', async () => {
      const abs = path.join(WORK, 'docs', 'chat.png')
      if (!fs.existsSync(abs)) throw new Error(`픽스처 이미지가 없다: ${abs}`)
      const url =
        kind === 'tauri'
          ? `http://ccg-img.localhost/${encodeURIComponent(abs)}`
          : `ccg-img://local/?p=${encodeURIComponent(abs)}`
      const r = await cdp.eval(
        `new Promise((res) => {
           const img = new Image()
           img.onload = () => res({ ok: true, w: img.naturalWidth, h: img.naturalHeight })
           img.onerror = () => res({ ok: false })
           img.src = ${JSON.stringify(url)}
           setTimeout(() => res({ ok: false, why: 'timeout' }), 8000)
         })`,
        { awaitPromise: true, timeoutMs: 15000 }
      )
      if (!r?.ok || !r.w) throw new Error(`이미지를 못 받았다: ${JSON.stringify(r)}`)
      return r
    })

    // ── 12. lsp:status — 3.0은 M7 전까지 'unsupported'가 **정답**이다.
    //    2.6.2는 실제 서버가 붙어 'ready'가 나온다 → A/B의 유일한 의도된 차이.
    await check('lsp-status-m7-boundary', async () => {
      const s = await cdp.eval(
        `window.api.lsp.status(${JSON.stringify(WORK)}, 'app/src/App.tsx')`,
        { awaitPromise: true }
      )
      const want = kind === 'tauri' ? 'unsupported' : 'ready'
      if (s !== want) throw new Error(`lsp.status=${s} (기대 ${want})`)
      return { status: s, note: kind === 'tauri' ? 'M7까지 의도된 미지원' : '2.6.2 기준' }
    })
  } finally {
    try { cdp?.close() } catch { /* closed */ }
    if (!KEEP) {
      killTree(child.pid)
      await sleep(800)
    }
  }
  const ok = checks.filter((c) => c.ok).length
  const report = { app: kind, version, at: new Date().toISOString(), work: WORK, checks, summary: { total: checks.length, ok, failed: checks.length - ok } }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`[m6:${kind}] ${ok}/${checks.length} 통과 → ${out}`)
  return report
}

// ── main ──────────────────────────────────────────────────────────────────────
if (KINDS.includes('tauri')) EXE = await snapshotExe()
const seeded = makeWorkRepo()
console.log(`[m6] 작업 폴더(클론) ${WORK} — 브랜치 ${seeded.branch} · 커밋 ${seeded.commits} · 더티 ${seeded.dirty}`)
const reports = []
for (const kind of KINDS) {
  console.log(`\n[m6:${kind}] 시작`)
  reports.push(await run(kind))
}
const bad = reports.filter((r) => r.summary.failed > 0)
console.log(`\n[m6] ${reports.map((r) => `${r.app} ${r.summary.ok}/${r.summary.total}`).join(' · ')}`)
process.exit(bad.length ? 1 : 0)
