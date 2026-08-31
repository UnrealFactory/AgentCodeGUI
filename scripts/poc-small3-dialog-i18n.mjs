#!/usr/bin/env node
// poc-small3-dialog-i18n — 첨부 대화상자 문구 넷이 `ui.lang`을 따르는가.
//
// SMALL3 R1의 못. `docs/decisions-3.0.md` §3.4-B가 잡은 회귀:
//   3.0 `src-tauri/src/ipc/parity/dialog.rs`가 제목·필터 이름 넷을 한국어 리터럴로
//   박아 두어, UI 언어를 en으로 둬도 **네이티브 파일 선택 창만 한국어**로 남았다.
//   2.6.2(`src/main/index.ts:1355-1360`)는 넷 다 `t(ko, en)`으로 감싼다.
//
// 이 하네스가 재는 것 둘:
//   A. 정적 — dialog.rs의 `labels()`가 내는 (ko, en) 넷이 2.6.2의 넷과 **글자까지** 같은가.
//      그리고 `pick_attachments` 빌더에 한국어 리터럴이 남아 있지 않은가.
//   B. 실측 — 격리 홈(`CCG_HOME`)에 `ui-prefs.json` 한 장만 놓고 **테스트 바이너리의
//      자식 테스트**를 띄워 `labels()`가 실제로 뱉는 문자열 넷을 받아 온다.
//      홈 셋: `ui.lang=en` · `ui.lang=ko` · 설정 없음(갓 설치).
//
//      한 프로세스에서 두 언어를 못 본다 — `ccg_fs::t`의 언어 판정이 2초 TTL의
//      프로세스 전역 캐시라 첫 읽기로 굳는다. 그래서 언어마다 프로세스를 새로 띄운다.
//
// 안전: 사용자 실홈(`%USERPROFILE%\.agentcodegui`)을 **읽지도 복사하지도 않는다**.
//       홈은 `%TEMP%` 아래 새로 만들고 끝나면 지운다. 이름 기반 kill 0.
//
// 쓰기:
//   node scripts/poc-small3-dialog-i18n.mjs
//   node scripts/poc-small3-dialog-i18n.mjs --exe=<...\agentcodegui-<hash>.exe>
//   (exe를 안 주면 `src-tauri/target-small3/debug/deps`에서 가장 최근 것을 고른다.
//    없으면 `CARGO_TARGET_DIR=target-small3 cargo test -p agentcodegui
//    --features custom-protocol`을 한 번 돌려 만들어라 — 이 하네스는 빌드하지 않는다.)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIALOG_RS = path.join(REPO, 'src-tauri', 'src', 'ipc', 'parity', 'dialog.rs')
const INDEX_TS = path.join(REPO, 'src', 'main', 'index.ts')
const DEPS = path.join(REPO, 'src-tauri', 'target-small3', 'debug', 'deps')
const CHILD_TEST = 'ipc::parity::dialog::tests::child_prints_the_dialog_labels'
const CHILD_ENV = 'CCG_SMALL3_DIALOG_LANG_CHILD'
const MARK = 'SMALL3-LABELS>'

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
let fails = 0
const ok = (cond, label, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`)
}

// ── A. 정적 대조 ────────────────────────────────────────────────────────────

/** `ccg_fs::t("ko", "en")` 호출을 순서대로 뽑는다. */
function rustPairs(src) {
  const body = src.slice(src.indexOf('fn labels()'), src.indexOf('fn labels()') + 600)
  return [...body.matchAll(/ccg_fs::t\("([^"]*)",\s*"([^"]*)"\)/g)].map((m) => [m[1], m[2]])
}

/** 2.6.2 `pickAttachments` 핸들러 안의 `t('ko', 'en')`을 순서대로 뽑는다. */
function tsPairs(src) {
  const head = src.indexOf('IPC.pickAttachments')
  const body = src.slice(head, src.indexOf('return r.canceled', head))
  return [...body.matchAll(/\bt\('([^']*)',\s*'([^']*)'\)/g)].map((m) => [m[1], m[2]])
}

const rs = fs.readFileSync(DIALOG_RS, 'utf8')
const ts = fs.readFileSync(INDEX_TS, 'utf8')
const rsPairs = rustPairs(rs)
const refPairs = tsPairs(ts)

console.log('A. 정적 — dialog.rs vs 2.6.2 index.ts')
ok(rsPairs.length === 4, `3.0 labels()의 t() 콜사이트 4개`, `실제 ${rsPairs.length}`)
ok(refPairs.length === 4, `2.6.2 pickAttachments의 t() 콜사이트 4개`, `실제 ${refPairs.length}`)
ok(
  JSON.stringify(rsPairs) === JSON.stringify(refPairs),
  '넷이 (ko, en) 글자까지 같다',
  JSON.stringify(rsPairs) === JSON.stringify(refPairs) ? '' : `\n    3.0  : ${JSON.stringify(rsPairs)}\n    2.6.2: ${JSON.stringify(refPairs)}`
)
ok(!rsPairs.some(([, en]) => /[가-힣]/.test(en)), 'en 인자에 한글이 없다')
ok(!rsPairs.some(([ko, en]) => ko === en), 'ko와 en이 같은 칸이 없다')

// 빌더가 정말 `labels()`를 먹는가 + 한국어 리터럴이 되살아나지 않았는가(회귀 방지).
// ★이 둘이 없으면 A의 대조는 「아무도 안 쓰는 함수」를 재는 셈이 된다.
const call = rs.slice(rs.indexOf('pub fn pick_attachments'), rs.indexOf('.pick_files('))
ok(/=\s*labels\(\)\s*;/.test(call), 'pick_attachments가 labels()를 부른다')
ok(
  /\.set_title\(title\)/.test(call) && /\.add_filter\(f_all,/.test(call) && /\.add_filter\(f_img,/.test(call) && /\.add_filter\(f_txt,/.test(call),
  'set_title/add_filter 넷이 labels()의 값을 그대로 받는다'
)
ok(!/[가-힣]/.test(call.replace(/\/\/.*$/gm, '')), '빌더 구간에 한국어 리터럴 0')

// ── B. 실측 — 격리 홈 셋에서 labels()를 직접 받아 온다 ──────────────────────

function findExe() {
  const given = arg('exe')
  if (given) return given
  if (!fs.existsSync(DEPS)) return null
  const cands = fs
    .readdirSync(DEPS)
    .filter((f) => /^agentcodegui-[0-9a-f]+\.exe$/.test(f))
    .map((f) => ({ f: path.join(DEPS, f), m: fs.statSync(path.join(DEPS, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  return cands[0]?.f ?? null
}

function labelsUnder(exe, tag, lang) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `ccg-small3-dlg-${tag}-`))
  if (lang) fs.writeFileSync(path.join(home, 'ui-prefs.json'), JSON.stringify({ 'ui.lang': lang }))
  const r = spawnSync(exe, ['--exact', CHILD_TEST, '--nocapture', '--include-ignored'], {
    env: { ...process.env, [CHILD_ENV]: '1', CCG_HOME: home },
    encoding: 'utf8',
    timeout: 60_000
  })
  fs.rmSync(home, { recursive: true, force: true })
  const line = String(r.stdout || '')
    .split(/\r?\n/)
    .find((l) => l.startsWith(MARK))
  return line ? line.slice(MARK.length).split('\t') : null
}

console.log('\nB. 실측 — 격리 홈에서 labels()가 실제로 뱉는 것')
const exe = findExe()
if (!exe || !fs.existsSync(exe)) {
  fails++
  console.log(`  FAIL 테스트 바이너리를 못 찾았다 — CARGO_TARGET_DIR=target-small3 cargo test -p agentcodegui --features custom-protocol 을 먼저 돌려라`)
} else {
  console.log(`  exe: ${exe}`)
  const KO = ['첨부할 파일 선택', '첨부 가능한 파일', '이미지', '텍스트·문서']
  const EN = ['Choose files to attach', 'Attachable files', 'Images', 'Text & documents']
  for (const [tag, lang, want] of [['en', 'en', EN], ['ko', 'ko', KO], ['기본(설정 없음)', null, KO]]) {
    const got = labelsUnder(exe, tag.replace(/[^a-z]/g, '') || 'def', lang)
    console.log(`  ui.lang=${String(lang)} (${tag})`)
    console.log(`    ${got ? got.join(' | ') : '(자식이 라벨을 안 찍었다)'}`)
    ok(got != null && JSON.stringify(got) === JSON.stringify(want), `  ${tag} 기대와 일치`)
  }
}

console.log(`\n${fails === 0 ? '전부 통과' : `${fails}건 실패`}`)
process.exit(fails === 0 ? 0 : 1)
