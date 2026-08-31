#!/usr/bin/env node
// critic-hosti18n-r2-mutate — R2가 강화한 훑기 못에 **빌더가 안 시험한 두 축**을 건다.
//
// R2는 내 S1~S5(줄바꿈·변수·이스케이프·다른 키·format!)를 전부 막았다. 남은 축 둘:
//
//   N1  값이 **함수 호출**을 거친다 — `fn sneak() -> String { "한국어".into() }` + `"error": sneak()`
//       (빌더가 못 주석에 **스스로 한계로 적어 둔** 자리다. 실제로 조용한지 확인한다.)
//   N2  감시 **키 목록 밖**의 키 — 못은 `"error"`·`"message"`·`"reason"` 셋만 본다.
//       크리틱 R1-D3이 잡은 실물(`requires`)이 바로 목록 밖 키였다는 점이 이 축의 값어치다.
//
// 사용: node critic-hosti18n-r2-mutate.mjs <격리트리> <N1|N2|restore>
import fs from 'node:fs'
import path from 'node:path'

const [tree, which] = process.argv.slice(2)
if (!tree || !which) {
  console.error('사용: node critic-hosti18n-r2-mutate.mjs <격리트리> <N1|N2|restore>')
  process.exit(2)
}
if (path.resolve(tree).toLowerCase().startsWith(path.resolve('C:/Code/AgentCodeGUI').toLowerCase())) {
  console.error('거부: 실 워크트리에는 돌연변이를 넣지 않는다.')
  process.exit(2)
}

const RS = path.join(tree, 'src-tauri', 'src', 'ipc', 'lsp.rs')
const BAK = RS + '.critic-r2-orig'
if (!fs.existsSync(BAK)) fs.copyFileSync(RS, BAK)
const orig = fs.readFileSync(BAK, 'utf8').replace(/\r\n/g, '\n')
const ANCHOR = '        LSP_CLEAR_VERSE_PATH => json!({ "ok": true }),'

const FORMS = {
  // 함수 경유 — 못이 심볼까지만 따라간다고 스스로 적은 자리
  N1: `        LSP_CLEAR_VERSE_PATH => json!({ "ok": false, "error": sneak_reason() }),`,
  // 감시 목록 밖의 키
  N2: `        LSP_CLEAR_VERSE_PATH => json!({ "ok": false, "detail": "지우지 못했어요" }),`,
}
// N1은 헬퍼도 같이 심는다(제품 구역에).
const HELPER = `\nfn sneak_reason() -> String {\n    "지우지 못했어요".to_string()\n}\n`

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
  if (which === 'N1') {
    const at = out.indexOf('#[cfg(test)]')
    out = out.slice(0, at) + HELPER + '\n' + out.slice(at)
  }
}
fs.writeFileSync(RS, out)
console.log(`${which} 적용`)
