// poc-dash-path.mjs — 이름이 `-`로 시작하는 경로에서 **실앱**이 무엇이라 답하나.
//
// 크레이트 테스트(`ccg-fs`)는 함수를 직접 부른다. 이 하네스가 재는 것은 그 위 두 층이다:
// Tauri IPC(`ipc/git.rs`) → 렌더러 shim(`window.api.git.*`). R28b GIT 확인 크리틱 R5는
// 이 층에서 `fileDiff('-notes.txt') → {"tag":"new"}`를 실측해 불합격을 냈다 — 같은 층에서
// 재야 「고쳤다」가 선다.
//
// 규율(이 저장소의 함정 목록):
//   · 이름 기반 kill 금지 — 자기가 스폰한 PID만 `killTree`로 걷는다.
//   · 항상 격리 `CCG_HOME`. 사용자 실앱의 홈·설정을 한 글자도 안 만진다.
//   · 픽스처 레포는 `os.tmpdir()` 아래에 새로 만든다(사용자 레포 불가침).
//   · CDP 포트는 인자로 받아 다른 갈래와 안 겹치게 한다(기본 9941).
//
// 사용:
//   node scripts/poc-dash-path.mjs --exe=<...>/release/AgentCodeGUI3.exe [--port=9941] [--json=<경로>]
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connectMainPage, killTree, sleep, REPO } from '../bench/lib.mjs'

const argOf = (k, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}
const PORT = Number(argOf('port', '9941'))
const EXE = path.resolve(argOf('exe', path.join(REPO, 'target-gdash', 'release', 'AgentCodeGUI3.exe')))
const OUT = argOf('json', '')

const stamp = `${process.pid}-${Date.now()}`
const HOME = path.join(os.tmpdir(), `ccg-gdash-home-${stamp}`)
const FIX = path.join(os.tmpdir(), `ccg-gdash-fix-${stamp}`)

const git = (args, cwd = FIX) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function fixture() {
  fs.mkdirSync(FIX, { recursive: true })
  git(['init', '-q'])
  git(['config', 'user.email', 't@example.com'])
  git(['config', 'user.name', 'T'])
  git(['config', 'commit.gpgsign', 'false'])
  git(['config', 'core.autocrlf', 'false'])
  const w = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(FIX, rel)), { recursive: true })
    fs.writeFileSync(path.join(FIX, rel), body)
  }
  // `-` 최상위 파일 · `-` 최상위 폴더 안쪽 · 대조군
  w('-notes.txt', '원본\n둘째 줄\n')
  w('-old/노트.txt', '원본\n둘째 줄\n')
  w('보통/노트.txt', '원본\n둘째 줄\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'init'])
  const head = git(['rev-parse', 'HEAD']).trim()
  w('-notes.txt', '원본\n고친 줄\n')
  w('-old/노트.txt', '원본\n고친 줄\n')
  w('보통/노트.txt', '원본\n고친 줄\n')
  return head
}

const main = async () => {
  if (!fs.existsSync(EXE)) {
    console.error(`[poc] exe 없음: ${EXE} — --exe=로 지정하거나 먼저 빌드해라`)
    process.exit(2)
  }
  const head = fixture()
  fs.mkdirSync(HOME, { recursive: true })
  console.error(`[poc] exe=${EXE}`)
  console.error(`[poc] home=${HOME}`)
  console.error(`[poc] fixture=${FIX} head=${head.slice(0, 8)}`)

  const child = spawn(EXE, [], {
    env: { ...process.env, CCG_HOME: HOME, CCG_CDP_PORT: String(PORT) },
    cwd: REPO,
    stdio: 'ignore'
  })
  const report = { exe: EXE, head: head.slice(0, 12), rows: [], discard: [], ok: false }
  let cdp = null
  try {
    cdp = await connectMainPage(PORT, { timeoutMs: 60000 })
    // 렌더러가 붙기 전에 부르면 shim이 폴백을 준다 — #root 마운트까지 기다린다
    for (let i = 0; i < 400; i++) {
      if (await cdp.eval(`!!document.getElementById('root')?.children.length && !!window.api?.git`)) break
      await sleep(50)
    }
    const cwd = JSON.stringify(FIX)
    const st = await cdp.eval(`window.api.git.status(${cwd}).then(r => r.files.map(f => f.status + ' ' + f.path))`, {
      awaitPromise: true
    })
    report.status = st
    for (const rel of ['-notes.txt', '-old/노트.txt', '보통/노트.txt']) {
      const r = JSON.stringify(rel)
      const fd = await cdp.eval(
        `window.api.git.fileDiff(${cwd}, ${r}).then(d => ({tag: d.diff?.tag ?? null, add: d.diff?.add ?? null, del: d.diff?.del ?? null, error: d.error ?? null}))`,
        { awaitPromise: true }
      )
      const cf = await cdp.eval(
        `window.api.git.commitFileDiff(${cwd}, ${JSON.stringify(head)}, ${r}).then(d => ({tag: d.diff?.tag ?? null, bytes: (d.content ?? '').length, error: d.error ?? null}))`,
        { awaitPromise: true }
      )
      report.rows.push({ rel, fileDiff: fd, commitFileDiff: cf })
    }
    // `.git/index.lock`을 놔둔 판 — checkout만 실패시켜 「실패했다고 말하면서 지우는지」를 본다
    const lock = path.join(FIX, '.git', 'index.lock')
    fs.writeFileSync(lock, '')
    for (const rel of ['보통/노트.txt', '-old/노트.txt']) {
      const r = JSON.stringify(rel)
      const res = await cdp.eval(`window.api.git.discard(${cwd}, ${r}, false).then(x => ({ok: x.ok, error: x.error ?? null}))`, {
        awaitPromise: true
      })
      report.discard.push({ rel, ...res, stillThere: fs.existsSync(path.join(FIX, rel)) })
    }
    fs.rmSync(lock, { force: true })
    const edits = report.rows.every((x) => x.fileDiff.tag === 'edit')
    const contents = report.rows.every((x) => x.commitFileDiff.bytes > 0)
    const kept = report.discard.every((x) => x.ok === false && x.stillThere === true)
    report.ok = edits && contents && kept
    report.checks = { allEdit: edits, allContent: contents, lockedDiscardKeptFiles: kept }
  } finally {
    if (cdp) cdp.close()
    try {
      killTree(child.pid) // ★ 이름 기반 kill 금지 — 내가 띄운 PID만
    } catch { /* 이미 죽음 */ }
    await sleep(300)
    for (const d of [HOME, FIX]) {
      try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 잠긴 조각은 둔다 */ }
    }
  }
  const text = JSON.stringify(report, null, 2)
  if (OUT) fs.writeFileSync(OUT, text)
  console.log(text)
  process.exit(report.ok ? 0 : 1)
}

main().catch((e) => {
  console.error('[poc] 실패:', e?.message ?? e)
  process.exit(3)
})
