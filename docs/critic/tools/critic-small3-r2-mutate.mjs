#!/usr/bin/env node
// critic-small3-r2-mutate — R2가 세운 정적 못 둘에 **회피 변이**를 건다.
//
// R1의 M1/M2/M3은 "리터럴을 되박는" 순진한 회귀였다. R2의 못은 그것을 막는다고 주장한다.
// 크리틱이 물어야 하는 것은 **못을 알고 피하려는 손**과 **정상 리팩터가 내는 사고**다.
//
//   M1     labels()를 한국어 리터럴로            (R1 회귀 재현)
//   M2     빌더만 리터럴로                        (R1이 뚫은 구멍 — R2가 막았다고 주장)
//   M3     en 한 칸 표류                          (동결 대조 못의 자리)
//   E1     빌더 안에서 concat!                    (리터럴 검사 우회 시도 — 따옴표가 남는다)
//   E2     빌더 밖 const에 한국어 리터럴          (검사 ③이 잡아야 한다)
//   E3     빌더 밖 const에 \u{} 이스케이프        ★리터럴 한글이 소스에 없다
//   E6     빌더 밖 const에 concat!로 쪼갠 한글    ★연속 문자열이 소스에 없다
//   E4     labels() 안에서 `ccg_fs :: t(` 공백    (UPDATER R2의 전례)
//   EPAIR  구조분해 순서만 뒤바꾼다               ★리터럴 0 · 한글 0 · labels() 그대로
//   ESRC   동결 원문(src/main/index.ts)을 감춘다  (조용히 스킵되는가)
//
// 사용: node critic-small3-r2-mutate.mjs <격리트리> <변이|restore>
// 실 워크트리 경로는 거부한다.
import fs from 'node:fs'
import path from 'node:path'

const [tree, which] = process.argv.slice(2)
if (!tree || !which) {
  console.error('사용: node critic-small3-r2-mutate.mjs <격리트리> <M1|M2|M3|E1|E2|E3|E6|E4|EPAIR|ESRC|restore>')
  process.exit(2)
}
if (path.resolve(tree).toLowerCase().startsWith(path.resolve('C:/Code/AgentCodeGUI').toLowerCase())) {
  console.error('거부: 실 워크트리에는 돌연변이를 넣지 않는다.')
  process.exit(2)
}

const RS = path.join(tree, 'src-tauri', 'src', 'ipc', 'parity', 'dialog.rs')
const TS = path.join(tree, 'src', 'main', 'index.ts')
const TS_HIDDEN = TS + '.critic-hidden'
const BAK = RS + '.critic-orig'
if (!fs.existsSync(BAK)) fs.copyFileSync(RS, BAK)
const orig = fs.readFileSync(BAK, 'utf8').replace(/\r\n/g, '\n')

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
const DESTRUCT = '    let [title, f_all, f_img, f_txt] = labels();'
const SET_TITLE = '        .set_title(title)'

// "첨부할 파일 선택"을 소스에 **연속 한글로 남기지 않는** 두 형태.
const ESCAPED = [...'첨부할 파일 선택']
  .map((c) => (c === ' ' ? ' ' : `\\u{${c.codePointAt(0).toString(16)}}`))
  .join('')

function apply(kind) {
  let out = orig
  const must = (before, after, tag) => {
    if (!out.includes(before)) {
      console.error(`앵커를 못 찾았다 (${tag})`)
      process.exit(3)
    }
    out = out.replace(before, after)
  }
  // 기본은 동결 원문을 되돌려 둔다(ESRC 이후 잔재 방지).
  if (fs.existsSync(TS_HIDDEN)) fs.renameSync(TS_HIDDEN, TS)

  switch (kind) {
    case 'restore':
      break
    case 'M1':
      must(LABELS_OK, LABELS_LITERAL, 'M1')
      break
    case 'M2':
      must(DESTRUCT, '    let [_t, _a, _i, _x] = labels();', 'M2 destructure')
      must(SET_TITLE, '        .set_title("첨부할 파일 선택")', 'M2 title')
      must('.add_filter(f_all, &all)', '.add_filter("첨부 가능한 파일", &all)', 'M2 all')
      must('.add_filter(f_img, &IMAGE)', '.add_filter("이미지", &IMAGE)', 'M2 img')
      must('.add_filter(f_txt, &TEXT)', '.add_filter("텍스트·문서", &TEXT)', 'M2 txt')
      break
    case 'M3':
      must('"Text & documents"', '"Text and documents"', 'M3')
      break
    case 'E1':
      must(SET_TITLE, '        .set_title(concat!("첨부할 파일 ", "선택"))', 'E1')
      break
    case 'E2':
      must(DESTRUCT, `const SNEAK: &str = "첨부할 파일 선택";\n${DESTRUCT}`, 'E2 const')
      must(SET_TITLE, '        .set_title(SNEAK)', 'E2 title')
      break
    case 'E3':
      must(DESTRUCT, `const SNEAK: &str = "${ESCAPED}";\n${DESTRUCT}`, 'E3 const')
      must(SET_TITLE, '        .set_title(SNEAK)', 'E3 title')
      break
    case 'E6':
      must(DESTRUCT, `const SNEAK: &str = concat!("첨", "부할 파일 선택");\n${DESTRUCT}`, 'E6 const')
      must(SET_TITLE, '        .set_title(SNEAK)', 'E6 title')
      break
    case 'E4':
      must('ccg_fs::t("첨부할 파일 선택"', 'ccg_fs :: t("첨부할 파일 선택"', 'E4')
      break
    case 'EPAIR':
      // 구조분해 순서만 바꾼다 — 제품은 제목/첫 필터가 뒤바뀌지만 소스에는
      // 리터럴도 한글도 안 늘고 labels()도 그대로다.
      must(DESTRUCT, '    let [f_all, title, f_img, f_txt] = labels();', 'EPAIR')
      break
    case 'ESRC':
      if (fs.existsSync(TS)) fs.renameSync(TS, TS_HIDDEN)
      break
    default:
      console.error('알 수 없는 변이: ' + kind)
      process.exit(2)
  }
  fs.writeFileSync(RS, out)
  console.log(`${kind} 적용`)
  if (kind === 'E3') console.log(`  (const 내용 = "${ESCAPED}")`)
}
apply(which)
