#!/usr/bin/env node
// critic-small3-r3-mutate — R3의 「짝 못」에 **빌더가 안 시험한 변이**를 건다.
//
// 빌더의 열(`scripts/poc-small3-mutate.mjs`)은 M1·M2·M3·EPAIRF·E6 + 무해 둘(EPAIRI·EPAIRD)이다.
// 거기에 없는 축이 셋 있다:
//
//   EORDER   ★빌더의 `.add_filter` **줄 순서**만 바꾼다.
//            짝 못은 네 짝을 `contains`로 **존재만** 보므로 순서를 안 본다. 그런데 바로 그
//            줄 위의 주석이 "순서가 곧 대화상자의 기본 필터다"라고 적혀 있다 —
//            첫 필터가 「이미지」가 되면 사용자는 첨부 창에서 텍스트 파일을 못 본다.
//   ETWICE   `.set_title`을 **두 번** 부른다(뒤엣것이 이긴다). 네 짝이 다 존재하므로
//            `contains` 검사는 통과한다.
//   EKOEN    `t(ko, en)`의 **두 인자를 맞바꾼다**(문구는 그대로, 짝만 뒤집힘).
//   EXFIELD  `labels()` 안에서 **필드끼리 값을 맞바꾼다**(title ↔ filter_all).
//
// EKOEN·EXFIELD는 잡혀야 정상이다(대조군). EORDER·ETWICE가 이 라운드의 표적이다.
//
// 사용: node critic-small3-r3-mutate.mjs <격리트리> <변이|restore>
import fs from 'node:fs'
import path from 'node:path'

const [tree, which] = process.argv.slice(2)
if (!tree || !which) {
  console.error('사용: node critic-small3-r3-mutate.mjs <격리트리> <EORDER|ETWICE|EKOEN|EXFIELD|restore>')
  process.exit(2)
}
if (path.resolve(tree).toLowerCase().startsWith(path.resolve('C:/Code/AgentCodeGUI').toLowerCase())) {
  console.error('거부: 실 워크트리에는 돌연변이를 넣지 않는다.')
  process.exit(2)
}

const RS = path.join(tree, 'src-tauri', 'src', 'ipc', 'parity', 'dialog.rs')
const BAK = RS + '.critic-r3-orig'
if (!fs.existsSync(BAK)) fs.copyFileSync(RS, BAK)
const orig = fs.readFileSync(BAK, 'utf8').replace(/\r\n/g, '\n')

const F_ALL = '        .add_filter(l.filter_all, &all)'
const F_IMG = '        .add_filter(l.filter_images, &IMAGE)'
const TITLE_LINE = '        .set_title(l.title)'
const T_TITLE = '        title: ccg_fs::t("첨부할 파일 선택", "Choose files to attach"),'
const T_ALL = '        filter_all: ccg_fs::t("첨부 가능한 파일", "Attachable files"),'

function apply(kind) {
  let out = orig
  const must = (before, after, tag) => {
    if (!out.includes(before)) {
      console.error(`앵커를 못 찾았다 (${tag})`)
      process.exit(3)
    }
    out = out.replace(before, after)
  }
  switch (kind) {
    case 'restore':
      break
    case 'EORDER':
      // 이미지 필터를 첫 줄로 올린다 — 네 짝은 그대로 다 있다.
      must(F_ALL, '@@SWAP@@', 'EORDER a')
      must(F_IMG, F_ALL, 'EORDER b')
      must('@@SWAP@@', F_IMG, 'EORDER c')
      break
    case 'ETWICE':
      must(TITLE_LINE, `${TITLE_LINE}\n        .set_title(l.filter_all)`, 'ETWICE')
      break
    case 'EKOEN':
      must(T_TITLE, '        title: ccg_fs::t("Choose files to attach", "첨부할 파일 선택"),', 'EKOEN')
      break
    case 'EXFIELD':
      must(T_TITLE, '@@X@@', 'EXFIELD a')
      must(T_ALL, T_TITLE.replace('title:', 'filter_all:'), 'EXFIELD b')
      must('@@X@@', T_ALL.replace('filter_all:', 'title:'), 'EXFIELD c')
      break
    default:
      console.error('알 수 없는 변이: ' + kind)
      process.exit(2)
  }
  fs.writeFileSync(RS, out)
  console.log(`${kind} 적용`)
}
apply(which)
