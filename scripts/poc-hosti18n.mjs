#!/usr/bin/env node
// poc-hosti18n — 호스트(Rust 셸)의 사용자 가시 문구가 `ui.lang`을 따르는가.
//
// 확인 크리틱 R1·R2가 두 라운드 연속 「남은 최대 격차」로 지목한 §3.4-A의 실물 자리들:
//   verse    `ipc/lsp.rs`   Verse 서버 지정 버튼의 사유 — 렌더러 `r.error ?? t(…)`가 여기 진다
//   pickdir  `ipc/system.rs` 폴더 선택 창 제목 — 3.0은 2.6.2의 제목을 **통째로 잃었다**
//   win_chat `win.rs`       둘째 채팅 창 제목 표시줄
//   win_btw  `win.rs`       btw 질문 창 제목 표시줄
//   panel    `popout.rs`    멀티 패널 팝아웃 창 제목 표시줄
//
// 재는 것 둘:
//   A. 정적 — en 문자열이 **동결 2.6.2 원문과 바이트 동일**한가(우리가 지어내지 않았나).
//      `verse`만 3.0 전용이라 대조할 원문이 없다 — 그 사실도 여기서 못 박는다.
//   B. 실측 — 격리 홈(`CCG_HOME`)에 `ui-prefs.json` 한 장만 놓고 **자식 테스트 프로세스**를
//      띄워 다섯 문구가 실제로 뭐라고 나오는지 받아 온다(en · ko · 설정 없음).
//
//      한 프로세스에서 두 언어를 못 본다 — `ccg_fs::t`의 언어 판정이 2초 TTL의 프로세스
//      전역 캐시라 첫 읽기로 굳는다. 그래서 언어마다 프로세스를 새로 띄운다(SMALL3와 같다).
//
// 안전: 사용자 실홈(`%USERPROFILE%\.agentcodegui`)을 읽지도 복사하지도 않는다.
//       홈은 `%TEMP%`에 새로 만들고 끝나면 지운다. 이름 기반 kill 0.
//
// 쓰기:
//   node scripts/poc-hosti18n.mjs [--exe=<...\agentcodegui-<hash>.exe>]
//   (exe를 안 주면 `src-tauri/target-small3/debug/deps`에서 가장 최근 것을 고른다.
//    없으면 `CARGO_TARGET_DIR=target-small3 cargo test -p agentcodegui --features
//    custom-protocol`을 한 번 돌려라 — 이 하네스는 빌드하지 않는다.)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_TS = path.join(REPO, 'src', 'main', 'index.ts')
const DEPS = path.join(REPO, 'src-tauri', 'target-small3', 'debug', 'deps')
const CHILD_TEST = 'ipc::system::hosti18n_tests::child_prints_the_host_strings'
const CHILD_ENV = 'CCG_HOSTI18N_CHILD'
const MARK = 'HOSTI18N>'

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
let fails = 0
const ok = (cond, label, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`)
}

/** 자리 → [ko, en]. 순서가 아니라 **이름**이 규약이다(SMALL3 R3에서 배운 것). */
const SITES = {
  verse: ['Verse 서버 지정은 3.0에서 아직 제공하지 않아요', "Setting a Verse server isn't available in 3.0 yet"],
  pickdir: ['작업할 프로젝트 폴더 선택', 'Choose a project folder to work in'],
  win_chat: ['추가 채팅 — AgentCodeGUI', 'Extra chat — AgentCodeGUI'],
  win_btw: ['btw 질문 — AgentCodeGUI', 'btw question — AgentCodeGUI'],
  panel: ['패널 — AgentCodeGUI', 'Panel — AgentCodeGUI']
}
const KEYS = Object.keys(SITES)

// ── A. 정적 — en을 우리가 지어냈나 ──────────────────────────────────────────
console.log('A. 정적 — en 문자열의 출처(동결 2.6.2 원문)')
const ts = fs.readFileSync(INDEX_TS, 'utf8')
for (const k of KEYS) {
  const [ko, en] = SITES[k]
  if (k === 'verse') {
    // 3.0 전용 — 2.6.2에 Verse 지정이 실재하므로 대응 문구가 없다. 우리가 정한 자리다.
    ok(!ts.includes(ko), `${k}: 3.0 전용(2.6.2에 대응 원문 없음 = 우리가 정했다)`)
    ok(!/[가-힣]/.test(en), `${k}: en에 한글이 없다`)
    continue
  }
  const want = `t('${ko}', '${en}')`
  ok(ts.includes(want), `${k}: 2.6.2 원문과 바이트 동일`, want)
}

// ── A2. 배선 — 호출부가 정말 그 헬퍼를 쓰는가 ───────────────────────────────
//
// ★SMALL3 R2의 D2가 가르친 자리다. B(실측)는 헬퍼를 **직접** 부르므로 헬퍼만 멀쩡하면
// 초록이다 — `set_title(...)` 한 줄을 지우거나 `.title(...)`을 리터럴로 되돌려도 B는
// 아무 말도 안 한다(그때 제품은 다시 깨져 있다). 초판 하네스가 실제로 그랬다:
// 변이 H2·H3에서 `cargo test`는 붉은데 하네스는 **exit 0**이었다.
console.log('\nA2. 배선 — 호출부가 헬퍼를 먹는가')
for (const [rel, wiring, what] of [
  ['src-tauri/src/ipc/lsp.rs', '"error": verse_out_of_scope()', 'Verse 지정 버튼의 사유'],
  ['src-tauri/src/ipc/system.rs', '.set_title(pick_directory_title())', '폴더 선택 창 제목'],
  ['src-tauri/src/win.rs', '.title(session_window_title(', '둘째 채팅 창 제목'],
  ['src-tauri/src/popout.rs', '.title(panel_window_title())', '패널 창 제목']
]) {
  const src = fs.readFileSync(path.join(REPO, rel), 'utf8')
  const prod = src.includes('#[cfg(test)]') ? src.slice(0, src.indexOf('#[cfg(test)]')) : src
  ok(prod.includes(wiring), `${what}가 헬퍼를 받는다`, wiring)
}

// ── B. 실측 — 격리 홈에서 실제로 뭐라고 나오나 ─────────────────────────────
function findExe() {
  const given = arg('exe')
  if (given) return given
  if (!fs.existsSync(DEPS)) return null
  const c = fs
    .readdirSync(DEPS)
    .filter((f) => /^agentcodegui-[0-9a-f]+\.exe$/.test(f))
    .map((f) => ({ f: path.join(DEPS, f), m: fs.statSync(path.join(DEPS, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  return c[0]?.f ?? null
}

function under(exe, tag, lang) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `ccg-hosti18n-${tag}-`))
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
  if (!line) return null
  const out = {}
  for (const kv of line.slice(MARK.length).split('\t')) {
    const i = kv.indexOf('=')
    out[kv.slice(0, i)] = kv.slice(i + 1)
  }
  return out
}

console.log('\nB. 실측 — 격리 홈에서 셸이 실제로 뱉는 것')
const exe = findExe()
if (!exe || !fs.existsSync(exe)) {
  fails++
  console.log('  FAIL 테스트 바이너리를 못 찾았다 — cargo test -p agentcodegui --features custom-protocol 을 먼저 돌려라')
} else {
  console.log(`  exe: ${exe}`)
  for (const [tag, lang, idx] of [
    ['en', 'en', 1],
    ['ko', 'ko', 0],
    ['기본(설정 없음)', null, 0]
  ]) {
    const got = under(exe, tag.replace(/[^a-z]/g, '') || 'def', lang)
    console.log(`\n  ui.lang=${String(lang)} (${tag})`)
    if (!got) {
      fails++
      console.log('    FAIL 자식이 문구를 안 찍었다')
      continue
    }
    for (const k of KEYS) console.log(`    ${k.padEnd(9)} ${got[k]}`)
    const bad = KEYS.filter((k) => got[k] !== SITES[k][idx])
    ok(bad.length === 0, `  ${tag} 다섯 자리 전부 기대와 일치`, bad.length ? `어긋난 자리: ${bad}` : '')
  }
}

console.log(`\n${fails === 0 ? '전부 통과' : `${fails}건 실패`}`)
process.exit(fails === 0 ? 0 : 1)
