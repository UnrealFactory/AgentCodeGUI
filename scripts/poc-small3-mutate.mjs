#!/usr/bin/env node
// poc-small3-mutate — SMALL3 R3의 못이 진짜 무는가. **격리 사본에서만** 돌린다.
//
// 왜 새로 만드나: 크리틱 R2의 계기(`docs/critic/tools/critic-small3-r2-mutate.mjs`)는
// R2 소스에 앵커를 박아 뒀다(`fn labels() -> [String; 4]` · `let [title, f_all, …]`).
// R3가 `labels()`를 **이름 있는 구조체**로 바꾸면서 그 앵커 둘이 소스에서 사라졌다 —
// 특히 **EPAIR(구조분해 순서 뒤바꿈)은 앵커가 없어진 게 아니라 문법이 사라진 것**이다.
// 그래서 R3 모양에 맞춘 변이 열을 여기 새로 둔다. 크리틱 도구는 그대로 보존한다.
//
// 변이 — **부러져야 하는 것**(제품이 실제로 깨진다):
//   M1      labels() 안 t()를 리터럴로            → 런타임 못 + 2.6.2 대조 못
//   M2      빌더를 리터럴로                        → 배선 못(R1의 구멍, R2가 닫음)
//   M3      en 한 칸 표류                          → 2.6.2 대조 못 + 런타임 못
//   EPAIRF  ★필드 바꿔치기(.set_title(l.filter_all)) → 짝 못. 크리틱 EPAIR의 R3 상응물
//   E6      빌더 밖 const + concat!으로 한국어 밀반입 → 짝 못(크리틱 R2-D2의 구멍)
//
// 변이 — **초록이어야 하는 것**(제품이 안 깨진다. "표현 불가능"의 증명):
//   EPAIRI  labels()의 **초기화 줄 순서**만 뒤바꿈  → 구조체 리터럴은 이름으로 짝지으므로 무해
//   EPAIRD  구조체 **선언 필드 순서**만 뒤바꿈      → 〃
//
//   restore 원본 복구
//
// 사용: node scripts/poc-small3-mutate.mjs <격리트리> <M1|M2|M3|EPAIRF|E6|EPAIRI|EPAIRD|restore>
// 워크트리에 대고 쓰지 마라 — 아래 거부 장치가 막는다.

import fs from 'node:fs'
import path from 'node:path'

const [tree, which] = process.argv.slice(2)
if (!tree || !which) {
  console.error('사용: node scripts/poc-small3-mutate.mjs <격리트리> <M1|M2|M3|EPAIRF|E6|EPAIRI|EPAIRD|restore>')
  process.exit(2)
}

// 안전장치 — 실 워크트리를 절대 안 건드린다(크리틱 계기와 같은 규율).
if (path.resolve(tree).toLowerCase().startsWith(path.resolve('C:/Code/AgentCodeGUI').toLowerCase())) {
  console.error('거부: 실 워크트리에는 돌연변이를 넣지 않는다.')
  process.exit(2)
}

const RS = path.join(tree, 'src-tauri', 'src', 'ipc', 'parity', 'dialog.rs')
const BAK = RS + '.r3-orig'
if (!fs.existsSync(BAK)) fs.copyFileSync(RS, BAK)
const orig = fs.readFileSync(BAK, 'utf8').replace(/\r\n/g, '\n')

const LABELS_OK = `        title: ccg_fs::t("첨부할 파일 선택", "Choose files to attach"),
        filter_all: ccg_fs::t("첨부 가능한 파일", "Attachable files"),
        filter_images: ccg_fs::t("이미지", "Images"),
        filter_docs: ccg_fs::t("텍스트·문서", "Text & documents"),`

const LABELS_LITERAL = `        title: "첨부할 파일 선택".to_string(),
        filter_all: "첨부 가능한 파일".to_string(),
        filter_images: "이미지".to_string(),
        filter_docs: "텍스트·문서".to_string(),`

// 초기화 줄 순서만 뒤바꿈 — 제품 무해(필드 이름으로 짝지어진다).
const LABELS_SHUFFLED = `        filter_all: ccg_fs::t("첨부 가능한 파일", "Attachable files"),
        title: ccg_fs::t("첨부할 파일 선택", "Choose files to attach"),
        filter_docs: ccg_fs::t("텍스트·문서", "Text & documents"),
        filter_images: ccg_fs::t("이미지", "Images"),`

// 선언 필드 순서만 뒤바꿈 — 제품 무해(초기화도 접근도 전부 이름으로 한다).
const DECL_OK = `    /// 창 제목.
    title: String,
    /// **첫** 필터 — 이미지+텍스트 전부. 첫 줄인 것이 2.6.2와의 규약이다.
    filter_all: String,`
const DECL_SWAPPED = `    /// **첫** 필터 — 이미지+텍스트 전부. 첫 줄인 것이 2.6.2와의 규약이다.
    filter_all: String,
    /// 창 제목.
    title: String,`

const BUILDER_OK = `        .set_title(l.title)`
const BUILDER_LITERAL = `        .set_title("첨부할 파일 선택")`

// 크리틱 EPAIR의 R3 상응물 — 제목과 첫 필터를 서로 바꿔 끼운다.
const PAIR_OK = `        .set_title(l.title)
        // 순서가 곧 대화상자의 기본 필터다 — 2.6.2와 같이 「첨부 가능한 파일」이 첫 줄.
        .add_filter(l.filter_all, &all)`
const PAIR_SWAPPED = `        .set_title(l.filter_all)
        // 순서가 곧 대화상자의 기본 필터다 — 2.6.2와 같이 「첨부 가능한 파일」이 첫 줄.
        .add_filter(l.title, &all)`

// 크리틱 R2-D2의 밀반입 — 빌더 구간에 따옴표도 연속 한글도 안 남긴다.
const SNEAK_CONST = `const SNEAK: &str = concat!("첨", "부할 파일 선택");\n\nfn labels()`

let out = orig
const must = (before, after, tag) => {
  if (!out.includes(before)) {
    console.error(`앵커를 못 찾았다 (${tag}) — 소스가 바뀌었으면 이 계기부터 고쳐라.`)
    process.exit(3)
  }
  out = out.replace(before, after)
}

switch (which) {
  case 'M1':
    must(LABELS_OK, LABELS_LITERAL, 'M1 labels')
    break
  case 'M2':
    must(BUILDER_OK, BUILDER_LITERAL, 'M2 builder set_title')
    must('.add_filter(l.filter_all, &all)', '.add_filter("첨부 가능한 파일", &all)', 'M2 f_all')
    break
  case 'M3':
    must('"Text & documents"', '"Text and documents"', 'M3 en drift')
    break
  case 'EPAIRF':
    must(PAIR_OK, PAIR_SWAPPED, 'EPAIRF 필드 바꿔치기')
    break
  case 'E6':
    must('fn labels()', SNEAK_CONST, 'E6 const 심기')
    must(BUILDER_OK, '        .set_title(SNEAK)', 'E6 빌더 우회')
    break
  case 'EPAIRI':
    must(LABELS_OK, LABELS_SHUFFLED, 'EPAIRI 초기화 순서')
    break
  case 'EPAIRD':
    must(DECL_OK, DECL_SWAPPED, 'EPAIRD 선언 순서')
    break
  case 'restore':
    out = orig
    break
  default:
    console.error('알 수 없는 변이: ' + which)
    process.exit(2)
}

fs.writeFileSync(RS, out)
console.log(`${which} 적용 — ${RS}`)
