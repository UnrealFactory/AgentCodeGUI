#!/usr/bin/env node
// poc-hosti18n-mutate — HOSTI18N R1의 못이 진짜 무는가. **격리 사본에서만** 돌린다.
//
// SMALL3(R1~R4)에서 세운 규율 그대로다: 유해 변이가 붉은 것만으로는 못이 좋은지 알 수
// 없다 — **무해한 편집에 안 걸리는 것**까지 봐야 한다. 그래서 두 무리를 같이 돌린다.
//
// 부러져야 하는 것:
//   H1  verse 헬퍼를 리터럴로 되돌린다        → 실측 못(ui.lang을 안 따른다)
//   H2  `.set_title(pick_directory_title())` 제거 → 배선 못(초판 상태 = 제목을 통째로 잃음)
//   H3  둘째 채팅 창 제목을 리터럴로 되돌린다  → 배선 못 + 출처 검사
//   H4  en 한 칸을 2.6.2와 다르게 표류시킨다   → 동결 원문 대조 못 + 실측 못
//   H5  셸이 생 한국어 `error`를 새로 보낸다   → 훑기 못
//
// 초록이어야 하는 것(과민하지 않음의 증명):
//   HOK1 헬퍼에 주석 한 줄 추가
//   HOK2 `session_window_title`의 if/else를 **조건까지 함께** 뒤집는다(동작 동일)
//
//   restore  원본 복구
//
// 사용: node scripts/poc-hosti18n-mutate.mjs <격리트리> <H1..H5|HOK1|HOK2|S0..S5|SOK|restore>

import fs from 'node:fs'
import path from 'node:path'

const [tree, which] = process.argv.slice(2)
if (!tree || !which) {
  console.error('사용: node scripts/poc-hosti18n-mutate.mjs <격리트리> <H1|H2|H3|H4|H5|HOK1|HOK2|restore>')
  process.exit(2)
}
// 안전장치 — 실 워크트리를 절대 안 건드린다.
if (path.resolve(tree).toLowerCase().startsWith(path.resolve('C:/Code/AgentCodeGUI').toLowerCase())) {
  console.error('거부: 실 워크트리에는 돌연변이를 넣지 않는다.')
  process.exit(2)
}

const F = {
  lsp: path.join(tree, 'src-tauri', 'src', 'ipc', 'lsp.rs'),
  sys: path.join(tree, 'src-tauri', 'src', 'ipc', 'system.rs'),
  win: path.join(tree, 'src-tauri', 'src', 'win.rs')
}
for (const p of Object.values(F)) {
  const bak = p + '.h-orig'
  if (!fs.existsSync(bak)) fs.copyFileSync(p, bak)
}
const orig = (k) => fs.readFileSync(F[k] + '.h-orig', 'utf8').replace(/\r\n/g, '\n')

/** 한 파일에 치환 하나. 앵커가 없으면 크게 죽는다(조용한 무변이 제일 나쁘다). */
function patch(k, before, after, tag) {
  const src = orig(k)
  if (!src.includes(before)) {
    console.error(`앵커를 못 찾았다 (${tag}) — 소스가 바뀌었으면 이 계기부터 고쳐라.`)
    process.exit(3)
  }
  fs.writeFileSync(F[k], src.replace(before, after))
}

const restoreAll = () => {
  for (const [k, p] of Object.entries(F)) fs.writeFileSync(p, orig(k))
}

const CLEAR_OK = `LSP_CLEAR_VERSE_PATH => json!({ "ok": true }),`

const VERSE_OK = `    ccg_fs::t(
        "Verse 서버 지정은 3.0에서 아직 제공하지 않아요",
        "Setting a Verse server isn't available in 3.0 yet",
    )`
const VERSE_LITERAL = `    "Verse 서버 지정은 3.0에서 아직 제공하지 않아요".to_string()`

const WIN_OK = `.title(session_window_title(btw_of.is_some()))`
const WIN_LITERAL = `.title(if btw_of.is_some() { "btw 질문 — AgentCodeGUI" } else { "추가 채팅 — AgentCodeGUI" })`

const IFELSE_OK = `    if is_btw {
        ccg_fs::t("btw 질문 — AgentCodeGUI", "btw question — AgentCodeGUI")
    } else {
        ccg_fs::t("추가 채팅 — AgentCodeGUI", "Extra chat — AgentCodeGUI")
    }`
// 조건과 가지를 **함께** 뒤집는다 → 동작 동일(무해).
const IFELSE_FLIPPED = `    if !is_btw {
        ccg_fs::t("추가 채팅 — AgentCodeGUI", "Extra chat — AgentCodeGUI")
    } else {
        ccg_fs::t("btw 질문 — AgentCodeGUI", "btw question — AgentCodeGUI")
    }`

restoreAll()
switch (which) {
  case 'H1':
    patch('lsp', VERSE_OK, VERSE_LITERAL, 'H1 verse 리터럴')
    break
  case 'H2':
    patch('sys', '.set_title(pick_directory_title())', '', 'H2 제목 제거')
    break
  case 'H3':
    patch('win', WIN_OK, WIN_LITERAL, 'H3 창 제목 리터럴')
    break
  case 'H4':
    patch('sys', '"Choose a project folder to work in"', '"Choose a folder"', 'H4 en 표류')
    break
  case 'H5':
    patch(
      'lsp',
      'LSP_CLEAR_VERSE_PATH => json!({ "ok": true }),',
      'LSP_CLEAR_VERSE_PATH => json!({ "ok": false, "error": "지우지 못했어요" }),',
      'H5 생 한국어 error'
    )
    break
  case 'HOK1':
    patch(
      'sys',
      'pub(crate) fn pick_directory_title() -> String {',
      '// 무해한 주석 한 줄(HOK1).\npub(crate) fn pick_directory_title() -> String {',
      'HOK1 주석'
    )
    break
  case 'HOK2':
    patch('win', IFELSE_OK, IFELSE_FLIPPED, 'HOK2 if/else 뒤집기')
    break
  // ── ★HOSTI18N R2 — 크리틱 R1-D4의 회피 다섯. R1의 못은 S0만 잡고 넷을 놓쳤다.
  // 앵커는 전부 `lsp.rs`의 `LSP_CLEAR_VERSE_PATH` 한 줄(원래 `{ "ok": true }`)이다.
  case 'S0': // 한 줄 — R1도 잡던 형태(대조군)
    patch('lsp', CLEAR_OK, `LSP_CLEAR_VERSE_PATH => json!({ "ok": false, "error": "지우지 못했어요" }),`, 'S0')
    break
  case 'S1': // 줄바꿈 — rustfmt만으로도 나는 형태
    patch('lsp', CLEAR_OK, `LSP_CLEAR_VERSE_PATH => json!({ "ok": false, "error":\n            "지우지 못했어요" }),`, 'S1')
    break
  case 'S2': // 변수 경유 — `NO_CODEX_BIN`이 실물이었다
    patch('lsp', CLEAR_OK, `LSP_CLEAR_VERSE_PATH => { let m = "지우지 못했어요"; json!({ "ok": false, "error": m }) },`, 'S2')
    break
  case 'S3': // 유니코드 이스케이프
    patch('lsp', CLEAR_OK, `LSP_CLEAR_VERSE_PATH => json!({ "ok": false, "error": "\\u{c9c0}\\u{c6b0}\\u{c9c0} \\u{BABB}\\u{d588}\\u{c5b4}\\u{c694}" }),`, 'S3')
    break
  case 'S4': // 다른 키
    patch('lsp', CLEAR_OK, `LSP_CLEAR_VERSE_PATH => json!({ "ok": false, "message": "지우지 못했어요" }),`, 'S4')
    break
  case 'S5': // format! 경유
    patch('lsp', CLEAR_OK, `LSP_CLEAR_VERSE_PATH => json!({ "ok": false, "error": format!("{} 못했어요", "지우지") }),`, 'S5')
    break
  case 'SOK': // 무해 대조군 — **영어** error는 걸리면 안 된다
    patch('lsp', CLEAR_OK, `LSP_CLEAR_VERSE_PATH => json!({ "ok": false, "error": "could not clear" }),`, 'SOK')
    break
  case 'restore':
    break
  default:
    console.error('알 수 없는 변이: ' + which)
    process.exit(2)
}
console.log(`${which} 적용`)
