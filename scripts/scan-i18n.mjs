// i18n 잔여 점검 — 주석을 걷어낸 뒤, t()/isEn() 밖에 남은 한국어 표시 문자열을 찾는다.
// 번역 콘텐츠 파일(Verse/UE 문서·용어집)과 이중 언어 원본(PatchNotes·lang·i18n)은 제외.
// 사용: node scripts/scan-i18n.mjs
import { readFileSync } from 'fs'
import { execSync } from 'child_process'

const SKIP = /verseMemberDb|ueDocKo|langGlossary|verseKeywords|verseSyntax|PatchNotes|[/\\]lang\.ts|i18n\.ts/
const files = execSync('git ls-files "src/**/*.ts" "src/**/*.tsx"', { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !SKIP.test(f))

const BS = String.fromCharCode(92) // 백슬래시 — 소스에 직접 쓰면 이 파일 자체가 읽기 어려워진다

// 문자열 리터럴은 보존하고 주석만 공백으로 — 줄 번호가 어긋나지 않게 개행은 남긴다
function stripComments(s) {
  let out = ''
  let i = 0
  const n = s.length
  let quote = null
  while (i < n) {
    const c = s[i]
    const c2 = s[i + 1]
    if (quote) {
      if (c === BS) {
        out += '  '
        i += 2
        continue
      }
      if (c === quote) quote = null
      out += c
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      out += c
      i++
      continue
    }
    if (c === '/' && c2 === '/') {
      while (i < n && s[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    if (c === '/' && c2 === '*') {
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) {
        out += s[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

// isEn() 삼항의 한국어 가지 안인가 — 영어 가지가 길어 되돌아보기 창을 넘기므로
// 넉넉히(2500자) 보고, 그 사이에 삼항이 닫혔으면(다음 형제 요소) 무시한다.
function isEnBranch(code, idx) {
  const back = code.slice(Math.max(0, idx - 2500), idx)
  const at = back.lastIndexOf('isEn()')
  if (at < 0) return false
  // isEn() 이후 구간에 ') : (' 또는 ' : ' 가 있으면 한국어 가지에 들어와 있다는 뜻
  return /[?:]/.test(back.slice(at))
}

const hits = []
for (const f of files) {
  const code = stripComments(readFileSync(f, 'utf8'))
  const lineAt = (idx) => code.slice(0, idx).split('\n').length

  // 한국어가 든 문자열 리터럴 — 앞 400자에 t( 나 isEn() 이 열려 있으면 번역된 것으로 본다
  const reStr = new RegExp('([\'"`])((?:' + BS + BS + '.|(?!\\1)[^' + BS + BS + '])*)\\1', 'g')
  let m
  while ((m = reStr.exec(code))) {
    if (!/[가-힣]/.test(m[2])) continue
    const before = code.slice(Math.max(0, m.index - 400), m.index)
    if (/\bt\(\s*[^)]*$/.test(before)) continue
    if (isEnBranch(code, m.index)) continue
    hits.push(`${f}:${lineAt(m.index)}: ${m[0].slice(0, 90)}`)
  }

  // JSX 텍스트 노드(>한국어<) — 표현식({})이 아닌 생짜 한글
  const reJsx = />\s*([^<>{}\n]*[가-힣][^<>{}]*)</g
  while ((m = reJsx.exec(code))) {
    if (isEnBranch(code, m.index)) continue
    hits.push(`${f}:${lineAt(m.index)}: JSX «${m[1].trim().slice(0, 80)}»`)
  }
}

console.log(hits.join('\n'))
console.log('\nTOTAL ' + hits.length)
