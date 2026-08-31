#!/usr/bin/env node
// critic-hosti18n-r1 — HOSTI18N R1(026c00d) 확인 크리틱의 정적 계기.
//
// 빌더의 못을 믿지 않고 **독립으로** 다시 잰다:
//   A. 3.0의 en 넷이 2.6.2 원문과 **UTF-8 바이트까지** 같은가(동결 src/는 읽기만).
//      verse는 3.0 전용이라 대조 대상이 아니다 — 그 사실 자체를 확인한다.
//   B. 다섯 자리의 배선(호출부가 헬퍼를 부르는가) · 헬퍼가 `const`가 아니라 `fn`인가
//      (모듈 스코프 t() 금지 — const면 프로세스 첫 언어로 박제된다).
//   C. 헬퍼 밖에 같은 한국어가 되살아나지 않았는가.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO = 'C:/Code/AgentCodeGUI'
const REV = process.env.CCG_CRITIC_REV || '026c00d'
const results = []
const ok = (n, p, d) => {
  results.push({ name: n, pass: p, detail: d })
  console.log(`${p ? '  ok  ' : ' FAIL '} ${n}${d ? ' — ' + d : ''}`)
}
const atRev = (p) => execFileSync('git', ['show', `${REV}:${p}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1e8 })
const hex = (s) => Buffer.from(s, 'utf8').toString('hex')

// 동결 2.6.2 — 읽기 전용
const ts = fs.readFileSync(path.join(REPO, 'src', 'main', 'index.ts'), 'utf8')

// ── A. en 바이트 대조 ────────────────────────────────────────────────────────
// (파일, ko) — en은 우리 소스에서 뽑아 2.6.2에서 같은 ko의 짝과 맞춘다.
const SITES = [
  ['src-tauri/src/ipc/system.rs', '작업할 프로젝트 폴더 선택'],
  ['src-tauri/src/win.rs', '추가 채팅 — AgentCodeGUI'],
  ['src-tauri/src/win.rs', 'btw 질문 — AgentCodeGUI'],
  ['src-tauri/src/popout.rs', '패널 — AgentCodeGUI'],
]
const pairs = []
for (const [rel, ko] of SITES) {
  const src = atRev(rel)
  const needle = `ccg_fs::t("${ko}", "`
  const at = src.indexOf(needle)
  if (at < 0) {
    ok(`${ko} — 3.0 소스에 t() 콜사이트`, false, `${rel}에 없다`)
    continue
  }
  const rest = src.slice(at + needle.length)
  const ourEn = rest.slice(0, rest.indexOf('"'))
  // 2.6.2에서 같은 ko의 en을 뽑는다
  const tn = `t('${ko}', '`
  const tat = ts.indexOf(tn)
  const theirEn = tat < 0 ? null : ts.slice(tat + tn.length, tat + tn.length + 400).split("'")[0]
  const same = theirEn !== null && hex(ourEn) === hex(theirEn)
  pairs.push({ rel, ko, ourEn, theirEn, same, ourHex: hex(ourEn), theirHex: theirEn === null ? null : hex(theirEn) })
  ok(`en 바이트 일치 — ${ko}`, same, same ? `"${ourEn}"` : `ours="${ourEn}" vs 2.6.2="${theirEn}"`)
}
ok('en 인자에 한글이 없다', pairs.every((p) => !/[가-힣]/.test(p.ourEn)))

// verse는 3.0 전용 — 2.6.2에 대응 원문이 없어야 한다
ok('verse 문구는 2.6.2에 없다(3.0 전용이라는 주장의 확인)', !ts.includes('Verse 서버 지정은 3.0에서'))

// ── B. 배선 + fn(=호출 시점 평가) ────────────────────────────────────────────
const lsp = atRev('src-tauri/src/ipc/lsp.rs')
const sys = atRev('src-tauri/src/ipc/system.rs')
const win = atRev('src-tauri/src/win.rs')
const pop = atRev('src-tauri/src/popout.rs')
const prodOf = (s) => (s.includes('#[cfg(test)]') ? s.slice(0, s.indexOf('#[cfg(test)]')) : s)

ok('verse: const가 아니라 fn', /pub\(crate\) fn verse_out_of_scope\(\)/.test(lsp) && !/const VERSE_OUT_OF_SCOPE/.test(lsp))
ok('verse 배선', prodOf(lsp).includes('"error": verse_out_of_scope()'))
ok('설치 대상 없음도 t()로', prodOf(lsp).includes('"error": ccg_fs::t('))
ok('pickdir: fn + 배선', /pub\(crate\) fn pick_directory_title\(\)/.test(sys) && prodOf(sys).includes('.set_title(pick_directory_title())'))
ok('win: fn + 배선', /pub\(crate\) fn session_window_title\(/.test(win) && prodOf(win).includes('.title(session_window_title('))
ok('popout: fn + 배선', /pub\(crate\) fn panel_window_title\(\)/.test(pop) && prodOf(pop).includes('.title(panel_window_title())'))

// ── C. 헬퍼 밖에 한국어 부활 없음(주석 제외) ─────────────────────────────────
const bare = (s) =>
  prodOf(s)
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n')
for (const [rel, s, helper, ko] of [
  ['win.rs', win, 'pub(crate) fn session_window_title', '추가 채팅 — AgentCodeGUI'],
  ['popout.rs', pop, 'pub(crate) fn panel_window_title', '패널 — AgentCodeGUI'],
  ['system.rs', sys, 'pub(crate) fn pick_directory_title', '작업할 프로젝트 폴더 선택'],
]) {
  const b = bare(s)
  const h = b.indexOf(helper)
  const end = h < 0 ? -1 : b.indexOf('\n}', h)
  const outside = h < 0 ? b : b.slice(0, h) + b.slice(end)
  ok(`${rel}: 「${ko}」가 헬퍼 밖에 없다`, !outside.includes(ko))
}

const pass = results.every((r) => r.pass)
console.log(`\n${pass ? 'PASS' : 'FAIL'} — ${results.filter((r) => r.pass).length}/${results.length}`)
const j = process.argv.indexOf('--json')
if (j > 0 && process.argv[j + 1]) {
  fs.writeFileSync(process.argv[j + 1], JSON.stringify({ rev: REV, at: new Date().toISOString(), pass, results, pairs }, null, 2))
  console.log(`증거: ${process.argv[j + 1]}`)
}
process.exit(pass ? 0 : 1)
