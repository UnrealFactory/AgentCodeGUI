// 잔여 불일치의 **분류** — 어떤 문자 종류가 원인인가.
import { execFileSync } from 'node:child_process'
const RUST = process.argv[2]
const rs = (n) => JSON.parse(execFileSync(RUST, [], { input: JSON.stringify(n), encoding: 'utf8' }))
const ns = (n) => [...n].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
const pairs = {
  '한자↔한글': [['漢字문서.md', '한글파일.md'], ['中文.txt', '가나.txt'], ['字.md', '자.md']],
  '전각 라틴': [['ＦＵＬＬ.txt', 'full2.txt'], ['ＡＢＣ.md', 'abd.md'], ['Ｚ.txt', 'a.txt']],
  '가나 상호': [['ひらがな.txt', 'カタカナ.txt'], ['さくら.txt', 'サクラ.txt']],
  '가나↔라틴': [['ひらがな.txt', 'zoo.txt'], ['カタカナ.txt', 'apple.txt']],
  '2글자 확장(æ/ß)': [['æther.txt', 'adz.txt'], ['ß.txt', 'sz.txt'], ['straße.txt', 'strasset.txt']],
  '그리스·키릴': [['Ω.txt', 'Ж.txt'], ['Ω.txt', 'zoo.txt']],
  '이모지↔부호': [['😀.txt', '_a.txt'], ['🎉.txt', '1.txt'], ['😀.txt', 'a.txt']],
  '대소문자만': [['App', 'app'], ['README.md', 'readme.md']],
  '숫자 문자열': [['file2', 'file10'], ['2x', '10x']],
  '한글 내부': [['가나', '나가'], ['ㄱ자', '가나'], ['각', '갃']],
  '문장부호 순서': [['_a', '-a'], ['.a', '(a'], ['#a', '+a'], ['~a', 'a']],
  'Latin-1 접기': [['Ábc', 'abd'], ['ø.txt', 'oa.txt'], ['ð.txt', 'da.txt'], ['þ.txt', 'tz.txt']]
}
const rows = []
for (const [k, ps] of Object.entries(pairs)) {
  let bad = 0, ex = []
  for (const p of ps) {
    const a = rs(p).join('|'), b = ns(p).join('|')
    if (a !== b) { bad++; ex.push({ pair: p, rust: rs(p), node: ns(p) }) }
  }
  rows.push({ class: k, pairs: ps.length, mismatch: bad, examples: ex })
}
console.log(JSON.stringify(rows, null, 1))
