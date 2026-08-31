#!/usr/bin/env node
// critic-small3-mutate — 못이 진짜 무는가. **격리 사본에서만** 돌린다.
//
// 빌더는 M1(labels()를 리터럴로 되돌리기) 하나만 시험했다. 크리틱은 셋을 문다:
//
//   M1  labels()를 한국어 리터럴로 되돌린다            → cargo 못이 붉어져야 한다
//   M2  labels()는 그대로 두고 **호출부**만 리터럴로   → cargo 못은? (커버리지 구멍 시험)
//   M3  en 문자열 한 칸을 2.6.2와 다르게 바꾼다        → 못/하네스가 표류를 잡는가
//
// 사용: node critic-small3-mutate.mjs <격리트리> <테스트exe> [M1|M2|M3|restore]
// 워크트리에 대고 쓰지 마라 — 인자로 받은 트리의 dialog.rs를 고쳤다가 되돌린다.
import fs from 'node:fs'
import path from 'node:path'

const [tree, , which] = process.argv.slice(2)
if (!tree) {
  console.error('사용: node critic-small3-mutate.mjs <격리트리> <exe> <M1|M2|M3|restore>')
  process.exit(2)
}
const RS = path.join(tree, 'src-tauri', 'src', 'ipc', 'parity', 'dialog.rs')
const BAK = RS + '.critic-orig'
if (!fs.existsSync(BAK)) fs.copyFileSync(RS, BAK)
// git archive가 CRLF로 풀 수 있다 — 앵커 비교 전에 개행을 LF로 통일한다(되돌릴 때도 이 사본).
const orig = fs.readFileSync(BAK, 'utf8').replace(/\r\n/g, '\n')

// 안전장치 — 실 워크트리를 절대 안 건드린다.
if (path.resolve(tree).toLowerCase().startsWith(path.resolve('C:/Code/AgentCodeGUI').toLowerCase())) {
  console.error('거부: 실 워크트리에는 돌연변이를 넣지 않는다.')
  process.exit(2)
}

const LABELS_OK = `fn labels() -> [String; 4] {
    [
        ccg_fs::t("첨부할 파일 선택", "Choose files to attach"),
        ccg_fs::t("첨부 가능한 파일", "Attachable files"),
        ccg_fs::t("이미지", "Images"),
        ccg_fs::t("텍스트·문서", "Text & documents"),
    ]
}`
const LABELS_LITERAL = `fn labels() -> [String; 4] {
    [
        "첨부할 파일 선택".to_string(),
        "첨부 가능한 파일".to_string(),
        "이미지".to_string(),
        "텍스트·문서".to_string(),
    ]
}`
const CALL_OK = `    let [title, f_all, f_img, f_txt] = labels();
    app.dialog()
        .file()
        .set_title(title)`
const CALL_LITERAL = `    let [_t, _a, _i, _x] = labels();
    app.dialog()
        .file()
        .set_title("첨부할 파일 선택")`

function apply(kind) {
  let out = orig
  const must = (before, after, tag) => {
    if (!out.includes(before)) {
      console.error(`앵커를 못 찾았다 (${tag})`)
      process.exit(3)
    }
    out = out.replace(before, after)
  }
  if (kind === 'M1') must(LABELS_OK, LABELS_LITERAL, 'M1 labels')
  else if (kind === 'M2') {
    must(CALL_OK, CALL_LITERAL, 'M2 call set_title')
    must('.add_filter(f_all, &all)', '.add_filter("첨부 가능한 파일", &all)', 'M2 f_all')
    must('.add_filter(f_img, &IMAGE)', '.add_filter("이미지", &IMAGE)', 'M2 f_img')
    must('.add_filter(f_txt, &TEXT)', '.add_filter("텍스트·문서", &TEXT)', 'M2 f_txt')
  } else if (kind === 'M3') must('"Text & documents"', '"Text and documents"', 'M3 en drift')
  else if (kind === 'restore') out = orig
  else {
    console.error('알 수 없는 돌연변이: ' + kind)
    process.exit(2)
  }
  fs.writeFileSync(RS, out)
  console.log(`${kind} 적용 — ${RS}`)
}
apply(which)
