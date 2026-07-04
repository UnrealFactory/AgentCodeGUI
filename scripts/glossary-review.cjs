/* 호버 용어집 검토 HTML 생성기 — src/shared/langGlossary.ts의 사전을 그대로 읽어
 * 바탕화면에 검토용 HTML을 만든다(수기 복사로 어긋나지 않게 소스가 유일한 출처).
 *
 *   node scripts/glossary-review.cjs          → C/C++ 페이지 (기본)
 *   node scripts/glossary-review.cjs all      → 전체 언어 페이지
 *
 * 동작: 공유 TS 파일의 `export `만 벗겨 임시 파일로 tsc 트랜스파일 → require → 렌더.
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src', 'shared', 'langGlossary.ts')
const DESKTOP = path.join(os.homedir(), 'Desktop')

// ── 공유 사전 로드 (export 제거 → tsc → require) ─────────────────────────────
function loadGlossary() {
  const tmpTs = path.join(ROOT, '.tmp-glossary-review.ts')
  const tmpJs = path.join(ROOT, '.tmp-glossary-review.cjs')
  const body = fs.readFileSync(SRC, 'utf8').replace(/^export /gm, '')
  fs.writeFileSync(
    tmpTs,
    body +
      '\ndeclare const module: any\nmodule.exports = { C_CORE, C_GLOSSARY, CPP_GLOSSARY, CS_GLOSSARY, PY_GLOSSARY, TS_GLOSSARY, JS_GLOSSARY, UE_CPP_TYPES, UE_CPP_MACROS, UE_SPECIFIERS }\n'
  )
  try {
    execSync(`npx tsc "${tmpTs}" --outFile "${tmpJs}" --target es2020 --ignoreConfig --ignoreDeprecations 6.0`, {
      cwd: ROOT,
      stdio: 'pipe'
    })
    return require(tmpJs)
  } finally {
    fs.rmSync(tmpTs, { force: true })
    fs.rmSync(tmpJs, { force: true })
  }
}

// ── HTML 렌더 ────────────────────────────────────────────────────────────────
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// `백틱` → 코드 칩, ~물결~ → 흐린 보조 텍스트 (UE 지정자의 소속 매크로 표기), ¶ → 줄바꿈
const rich = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/~([^~]+)~/g, '<span class="dim">$1</span>')
    .replace(/¶/g, '<br>')
const row = ([k, v]) =>
  `<div class="row"><span class="kw"><code>${esc(k)}</code></span><span class="desc">${rich(v)}</span></div>`
const section = (title, entries) =>
  `<section><h2>${esc(title)} <span class="cnt">${entries.length}개</span></h2>\n${entries.map(row).join('\n')}</section>`

function page(title, sections) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root {
    --bg: #17181c; --card: #1e2026; --line: #2c2f38; --text: #e8eaf0; --sub: #9aa0ae;
    --kw: #6cb6ff; --code-bg: #262a33; --code: #7ee2b8; --accent: #e6b450;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 48px 20px 96px; background: var(--bg); color: var(--text);
    font: 15px/1.7 "Segoe UI", "Malgun Gothic", sans-serif;
  }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 26px; margin: 0 0 8px; letter-spacing: -0.3px; }
  .note { color: var(--sub); font-size: 13.5px; margin: 0 0 36px; }
  .note code { font-size: 12.5px; }
  h2 {
    font-size: 16px; margin: 44px 0 14px; padding-bottom: 10px;
    border-bottom: 1px solid var(--line); color: var(--accent); letter-spacing: -0.2px;
  }
  .cnt { color: var(--sub); font-weight: 400; font-size: 13px; margin-left: 6px; }
  .row { display: flex; gap: 18px; padding: 10px 14px; border-radius: 10px; align-items: baseline; }
  .row:nth-child(even) { background: var(--card); }
  .row:hover { background: #262a33; }
  .kw { flex: 0 0 150px; }
  .kw code { color: var(--kw); background: none; font-weight: 600; font-size: 14px; padding: 0; }
  .desc { flex: 1; color: var(--text); }
  code {
    font-family: Consolas, "Cascadia Mono", monospace; font-size: 13px;
    background: var(--code-bg); color: var(--code); padding: 1.5px 6px; border-radius: 5px;
  }
  .dim { color: var(--sub); font-size: 12.5px; }
</style>
</head>
<body>
<main>
  <h1>${esc(title)}</h1>
  <p class="note">앱에서 코드의 키워드·내장 타입에 마우스를 올리면 뜨는 설명 전체 목록입니다.<br>
  <code>이런 부분</code>은 앱 카드에서 코드 색으로 칠해져 보입니다. 어색한 문장을 알려주시면 반영됩니다.</p>
  ${sections.join('\n')}
</main>
</body>
</html>`
}

const g = loadGlossary()
const not = (base) => ([k]) => !Object.prototype.hasOwnProperty.call(base, k)
const cppOnly = Object.entries(g.CPP_GLOSSARY).filter(not(g.C_CORE))
const cOnly = Object.entries(g.C_GLOSSARY).filter(not(g.C_CORE))
const tsOnly = Object.entries(g.TS_GLOSSARY).filter(not(g.JS_GLOSSARY))

// UE 지정자 행 — 설명 뒤에 어느 매크로에서 쓰는지 흐리게 붙인다
const ueSpecRows = g.UE_SPECIFIERS.map((s) => [
  s.name,
  s.doc + ' ~(' + s.macros.join(' · ') + ')~'
])

// UE 공식 주석 번역 팩 — 추출본(en)과 팩(ko)을 심볼별로 짝지어 검토 행으로.
// (엔진을 안 뽑은 환경에서도 스크립트가 돌게, 추출본이 없으면 섹션을 비운다)
function ueDocRows() {
  let extracted, ko
  try {
    extracted = JSON.parse(fs.readFileSync(path.join(__dirname, 'ue-doc-extracted.json'), 'utf8'))
    ko = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'main', 'lsp', 'ue-doc-ko.json'), 'utf8'))
  } catch {
    return []
  }
  const rows = []
  for (const s of extracted) {
    if (!s.paragraphs) continue
    // 문단이 여러 개인 심볼은 한 행으로 합친다 — 문단마다 행을 만들면 같은 이름이
    // 연달아 반복돼 중복처럼 보인다 (번역·매칭 자체는 문단 단위 그대로)
    const parts = s.paragraphs.filter((p) => ko[p.key]).map((p) => ko[p.key].replace(/\n/g, ' '))
    if (parts.length) rows.push([s.symbol, parts.join('¶¶')])
  }
  return rows
}

const mode = process.argv[2] === 'all' ? 'all' : 'cpp'
if (mode === 'cpp') {
  const html = page('C / C++ 호버 용어집 — 리뉴얼 검토용', [
    section('C · C++ 공통', Object.entries(g.C_CORE)),
    section('C++ 전용', cppOnly),
    section('C 전용', cOnly),
    section('Unreal Engine — 타입', Object.entries(g.UE_CPP_TYPES)),
    section('Unreal Engine — 매크로', Object.entries(g.UE_CPP_MACROS)),
    section('Unreal Engine — 매크로 지정자', ueSpecRows),
    section('Unreal Engine — 공식 주석 번역 (clangd 호버)', ueDocRows())
  ])
  const out = path.join(DESKTOP, 'C++ 호버 용어집 검토.html')
  fs.writeFileSync(out, html)
  console.log('생성:', out)
} else {
  const html = page('호버 용어집 — 전체 언어 검토용', [
    section('C · C++ 공통', Object.entries(g.C_CORE)),
    section('C++ 전용', cppOnly),
    section('C 전용', cOnly),
    section('JavaScript (TS 공통)', Object.entries(g.JS_GLOSSARY)),
    section('TypeScript 전용', tsOnly),
    section('Python', Object.entries(g.PY_GLOSSARY)),
    section('C#', Object.entries(g.CS_GLOSSARY))
  ])
  const out = path.join(DESKTOP, '호버 용어집 검토 (전체).html')
  fs.writeFileSync(out, html)
  console.log('생성:', out)
}
