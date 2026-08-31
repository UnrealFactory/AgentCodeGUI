#!/usr/bin/env node
// critic-hosti18n-scan-mutate — 훑기 못(③)의 **회피 형태**를 판다.
//
// 빌더의 H5는 `"error": "한국어"`를 **한 줄에** 새로 심는다 — 가장 순진한 형태다.
// 못이 줄 단위로 `"error"`를 찾고 그 뒤의 따옴표 안 한글을 보므로, 아래 형태들은
// 같은 제품 결함(en 사용자가 한국어를 본다)을 내면서 못을 빠져나갈 수 있다:
//
//   S1  `"error":` 뒤에 줄바꿈 — 한국어가 **다음 줄**에 있다
//   S2  변수 경유 — `let m = "한국어"; … "error": m`
//   S3  유니코드 이스케이프 — 소스에 연속 한글이 없다
//   S4  다른 키 — `"message"`/`"reason"`에 한국어(못은 `"error"`만 본다)
//   S5  format! 경유 — `"error": format!("한국어 {x}", …)`
//
// 대조군: S0 = 빌더의 H5와 같은 순진한 형태(반드시 붉어야 한다).
//
// 사용: node critic-hosti18n-scan-mutate.mjs <격리트리> <S0|S1|S2|S3|S4|S5|restore>
import fs from 'node:fs'
import path from 'node:path'

const [tree, which] = process.argv.slice(2)
if (!tree || !which) {
  console.error('사용: node critic-hosti18n-scan-mutate.mjs <격리트리> <S0|S1|S2|S3|S4|S5|restore>')
  process.exit(2)
}
if (path.resolve(tree).toLowerCase().startsWith(path.resolve('C:/Code/AgentCodeGUI').toLowerCase())) {
  console.error('거부: 실 워크트리에는 돌연변이를 넣지 않는다.')
  process.exit(2)
}

const RS = path.join(tree, 'src-tauri', 'src', 'ipc', 'lsp.rs')
const BAK = RS + '.critic-scan-orig'
if (!fs.existsSync(BAK)) fs.copyFileSync(RS, BAK)
const orig = fs.readFileSync(BAK, 'utf8').replace(/\r\n/g, '\n')

// 주입 지점 — 제품 구역의 dispatch 자리(`#[cfg(test)]` 앞).
const ANCHOR = '        LSP_CLEAR_VERSE_PATH => json!({ "ok": true }),'
const ESC = [...'설치에 실패했어요'].map((c) => `\\u{${c.codePointAt(0).toString(16)}}`).join('')

const FORMS = {
  // 대조군 — 빌더의 H5와 같은 모양
  S0: `        LSP_CLEAR_VERSE_PATH => json!({ "ok": true, "error": "설치에 실패했어요" }),`,
  // 한국어가 다음 줄
  S1: `        LSP_CLEAR_VERSE_PATH => json!({ "ok": true, "error":
            "설치에 실패했어요" }),`,
  // 변수 경유
  S2: `        LSP_CLEAR_VERSE_PATH => { let m = "설치에 실패했어요"; json!({ "ok": true, "error": m }) },`,
  // 유니코드 이스케이프
  S3: `        LSP_CLEAR_VERSE_PATH => json!({ "ok": true, "error": "${ESC}" }),`,
  // 다른 키
  S4: `        LSP_CLEAR_VERSE_PATH => json!({ "ok": true, "message": "설치에 실패했어요" }),`,
  // format! 경유
  S5: `        LSP_CLEAR_VERSE_PATH => json!({ "ok": true, "error": format!("{}", "설치에 실패했어요") }),`,
}

let out = orig
if (which !== 'restore') {
  const form = FORMS[which]
  if (!form) {
    console.error('알 수 없는 변이: ' + which)
    process.exit(2)
  }
  if (!out.includes(ANCHOR)) {
    console.error('앵커를 못 찾았다')
    process.exit(3)
  }
  out = out.replace(ANCHOR, form)
}
fs.writeFileSync(RS, out)
console.log(`${which} 적용`)
