// ★TOOLROW(2026-09-02) — 도구 행 요약 토큰 · 검색 출력 · MCP 이름 해석기 실측.
// `app/src/lib/toolResult.tsx`를 esbuild로 묶어(i18n은 ko 스텁) 진짜 함수를 부른다.
// 엔진(wire.rs)이 내는 토큰 모양은 그쪽 단위 테스트가 잡고, 여기는 **렌더러가 그 토큰과
// Grep/Glob 원문을 어떻게 읽는가**만 본다.  실행: node scripts/poc-toolrow-helpers.mjs
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'

const r = await build({
  entryPoints: ['app/src/lib/toolResult.tsx'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  plugins: [
    {
      name: 'stub-i18n',
      setup(b) {
        b.onResolve({ filter: /\.\/i18n$/ }, () => ({ path: 'i18n', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const t = (ko) => ko' }))
      }
    }
  ]
})
// 저장소 안(node_modules/.cache)에 써야 번들의 react 임포트가 풀린다
const dir = join(process.cwd(), 'node_modules', '.cache', 'poc-toolrow')
mkdirSync(dir, { recursive: true })
const out = join(dir, 'toolResult.mjs')
writeFileSync(out, r.outputFiles[0].text)
const m = await import(pathToFileURL(out).href)

let fails = 0
const check = (label, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  ← ${JSON.stringify(got)}`}`)
  if (!ok) fails++
}
const html = (node) => (typeof node === 'string' ? node : renderToStaticMarkup(node))

// ── 요약 토큰 ────────────────────────────────────────────────────────────────
check("'145 lines' → 145줄", html(m.fmtToolResult('145 lines')) === '145줄', html(m.fmtToolResult('145 lines')))
check("'1 line' → 1줄", html(m.fmtToolResult('1 line')) === '1줄')
check("'12 hits' → 12건", html(m.fmtToolResult('12 hits')) === '12건')
check("'0 hits' → 0건", html(m.fmtToolResult('0 hits')) === '0건')
check("'2 results' → 2개 결과", html(m.fmtToolResult('2 results')) === '2개 결과')
check("'done' → 완료", html(m.fmtToolResult('done')) === '완료')
const pm = html(m.fmtToolResult('+3 −1'))
check("'+3 −1'(U+2212) → 색 입힌 +3 −1", pm.includes('class="add">+3') && pm.includes('class="del">−1'), pm)
const pm2 = html(m.fmtToolResult('+3 -1'))
check("'+3 -1'(ASCII) → 같은 결과", pm2 === pm, pm2)
const nw = html(m.fmtToolResult('new +42'))
check("'new +42' → 새 파일 · +42", nw.startsWith('새 파일') && nw.includes(' · ') && nw.includes('class="add">+42'), nw)
const mf = html(m.fmtToolResult('3 files +4 −2'))
check("'3 files +4 −2' → 파일 3개 · +4 −2", mf.startsWith('파일 3개') && mf.includes(' · ') && mf.includes('+4') && mf.includes('−2'), mf)

check('Skill 요약 문장은 그대로', html(m.fmtToolResult('Launching skill: code-review')) === 'Launching skill: code-review')
check('옛 채팅의 한국어 요약도 그대로', html(m.fmtToolResult('새 파일 +3')) === '새 파일 +3')
check('undefined → 빈 문자열', m.fmtToolResult(undefined) === '')

// ── 검색 출력 ────────────────────────────────────────────────────────────────
let s = m.parseSearchOutput('Found 2 files\nsrc\\a.h\nsrc/b.cpp\n')
check('files 모드: 머리말 빼고 파일 2', s.hits.length === 2 && s.hits[0].path === 'src\\a.h' && s.hits[1].path === 'src/b.cpp' && s.rest.length === 0, s)
s = m.parseSearchOutput('src\\a.h:44:static void Foo(\nsrc\\a.h:145:  Foo(x);\n(Results are truncated. Consider using a more specific path)')
check('content 모드: 줄번호·본문·잘림', s.hits.length === 2 && s.hits[0].line === '44' && s.hits[0].text === 'static void Foo(' && s.hits[1].line === '145' && s.truncated, s)
s = m.parseSearchOutput('C:\\other\\x.cpp:12:foo')
check('절대 경로(드라이브 콜론)도 경로:줄:본문', s.hits.length === 1 && s.hits[0].path === 'C:\\other\\x.cpp' && s.hits[0].line === '12' && s.hits[0].text === 'foo', s)
s = m.parseSearchOutput('src/a.h-43-  // context')
check('문맥 줄(path-NN-text)', s.hits.length === 1 && s.hits[0].line === '43', s)
s = m.parseSearchOutput('src/a.h:3')
check('count 모드(path:N)', s.hits.length === 1 && s.hits[0].line === '3' && s.hits[0].text === undefined, s)
s = m.parseSearchOutput('No files found')
check("'No files found' → 0건, 잔여 없음", s.hits.length === 0 && s.rest.length === 0, s)
s = m.parseSearchOutput('some random text\nsrc/a.h')
check('경로 아닌 줄은 rest로', s.hits.length === 1 && s.rest.length === 1 && s.rest[0] === 'some random text', s)
s = m.parseSearchOutput('Plugins\\UnrealNetCore\\Source\\Probe\\ProbeRegistryCore.h')
check('스크린샷의 Glob 한 줄', s.hits.length === 1, s)
s = m.parseSearchOutput('README.md\npackage.json')
check('확장자만 있는 파일명도 경로', s.hits.length === 2, s)
s = m.parseSearchOutput('src/foo-12-bar.h\nsrc/x-1.h')
check('하이픈 숫자가 든 파일명은 문맥 줄로 안 읽는다', s.hits.length === 2 && s.hits[0].path === 'src/foo-12-bar.h' && !s.hits[0].line && s.hits[1].path === 'src/x-1.h', s)

// ── 요청 인자 · MCP 이름 ─────────────────────────────────────────────────────
let a = m.parseToolArgs('{"pattern":"Foo","path":"src","nested":{"a":1}}')
check('인자 표: 문자열 그대로, 객체는 JSON', a.rows?.length === 3 && a.rows[0][1] === 'Foo' && a.rows[2][1].includes('"a": 1'), a)
a = m.parseToolArgs('{"a":1,"b":"…')
check('잘린 JSON → 표 없이 원문', a.rows === null && a.raw.startsWith('{"a"'), a)
check('빈 인자', m.parseToolArgs(undefined).rows === null)
const p = m.mcpParts('mcp__srv__dbl__ping')
check('mcpParts: 서버에 __ 있어도 뒤에서', p?.server === 'srv__dbl' && p?.tool === 'ping', p)
check('mcpParts: 일반 도구는 null', m.mcpParts('Read') === null)
check('mcpParts: agentmon status', JSON.stringify(m.mcpParts('mcp__agentmon__status')) === '{"server":"agentmon","tool":"status"}')

console.log(fails ? `\n${fails} FAIL` : '\nALL PASS')
process.exit(fails ? 1 : 0)
