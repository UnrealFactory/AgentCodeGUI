// 목업 HTML을 화면 밖에서 렌더해 PNG로 뜬다 + 페이지 안의 자가 계측값을 뽑아 온다.
//
// 왜 브라우저를 안 띄우는가: 사용자 데스크톱에 창을 열지 않기 위해서다(실앱이 떠 있다).
// 창은 **가상 화면 밖 좌표**(x=-4200)에 비활성으로 뜬다 — 눈에 안 보이고 포커스도 안 뺏는다.
//
// 왜 필요한가: 목업은 "실물급 밀도"를 주장하는데, 렌더해 보지 않으면 CSS 오타 하나로
// 레이아웃이 무너진 채 커밋된다. 그리고 ui-notify.js가 재는 A/B 높이는 **실제 렌더**
// 에서만 나온다 — 그 숫자를 회수해 콘솔에 찍는다.
//
// 실측으로 밟은 함정 둘(shot-html-main.cjs 헤더에 자세히):
//   1) `webPreferences.offscreen:true` + `capturePage()`는 멈춘다 → 화면 밖 실창을 쓴다.
//   2) electron.exe는 GUI 서브시스템이라 main의 stdout이 파이프로 안 온다 → 결과는 파일로.
//
//   node scripts/poc-glass/shot-html.mjs docs/design/mockups/ui-notify-0-system.html [out.png]
//   node scripts/poc-glass/shot-html.mjs --all docs/design/mockups/ui-notify-*.html
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HERE = import.meta.dirname
const REPO = path.resolve(HERE, '..', '..')
const exe = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe')

const args = process.argv.slice(2)
const all = args[0] === '--all'
const files = (all ? args.slice(1) : [args[0]]).filter(Boolean)
if (!files.length) {
  console.error('사용법: node scripts/poc-glass/shot-html.mjs <html> [out.png] | --all <html...>')
  process.exit(2)
}
if (!fs.existsSync(exe)) {
  console.error('없는 실행 파일:', exe)
  process.exit(2)
}

const jobs = files.map((f) => {
  const src = path.resolve(REPO, f)
  const out =
    !all && args[1]
      ? path.resolve(REPO, args[1])
      : path.join(REPO, 'docs', 'design', 'mockups', 'shots', path.basename(src).replace(/\.html?$/i, '.png'))
  return { src, out }
})
for (const j of jobs) {
  if (!fs.existsSync(j.src)) {
    console.error('없는 파일:', j.src)
    process.exit(2)
  }
}

const resultFile = path.join(os.tmpdir(), `ccg-shot-${process.pid}.json`)
const env = { ...process.env, SHOT_JOBS: JSON.stringify(jobs), SHOT_RESULT_FILE: resultFile }
if (args[2]) env.SHOT_W = args[2]
if (args[3]) env.SHOT_H = args[3]

const child = spawn(exe, [path.join(HERE, 'shot-html-main.cjs')], { cwd: REPO, env, stdio: 'ignore' })
child.on('exit', (code) => {
  if (!fs.existsSync(resultFile)) {
    console.error(`결과 파일이 없다 (electron exit ${code}). 추적: ${resultFile}.trace`)
    process.exit(1)
  }
  const rows = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  fs.rmSync(resultFile, { force: true })
  fs.rmSync(resultFile + '.trace', { force: true })
  if (!rows.length) {
    console.error(`찍힌 게 없다 (electron exit ${code})`)
    process.exit(1)
  }
  for (const r of rows) {
    const s = Object.entries(r.sums)
      .map(([k, v]) => `${k}=${v}`)
      .join('  ')
    console.log(`${path.relative(REPO, r.out)}\n   ${r.title}\n   ${s}${r.verdict ? '  →  ' + r.verdict : ''}`)
  }
  process.exit(code === 0 ? 0 : 1)
})
