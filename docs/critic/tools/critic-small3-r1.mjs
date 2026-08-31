#!/usr/bin/env node
// critic-small3-r1 — SMALL3 R1(09b9bc7) 확인 크리틱의 계기.
//
// 빌더의 하네스(scripts/poc-small3-dialog-i18n.mjs)를 믿지 않고 **독립으로** 다시 잰다.
// 여기서 재는 것은 정적 동일성 셋뿐이다(런타임 언어 판정은 cargo 못이 자식 프로세스로 잰다):
//
//   A. 3.0 dialog.rs `labels()`의 (ko, en) 넷 == 2.6.2 `src/main/index.ts` pickAttachments의 넷
//      — 비교는 **UTF-8 바이트**로 한다(눈으로는 U+00B7 가운뎃점과 U+2027 등이 구분 안 된다).
//   B. 제품 호출부 `pick_attachments`가 정말 `labels()`를 먹는가(안 그러면 죽은 함수를 잰 셈).
//   C. 빌더 구간(set_title/add_filter)에 한국어 리터럴이 0인가.
//   D. 2.6.2 `t()`의 언어 판정 == 3.0 `is_en()`의 언어 판정(둘 다 ui-prefs `ui.lang`=='en').
//
// 동결 구역(src/)은 **읽기만** 한다. 산출물은 stdout + --json 경로에 쓰는 증거 json 한 장.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', '..', '..')
const REV = process.env.CCG_CRITIC_REV || '09b9bc7'
const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

const atRev = (p) =>
  execFileSync('git', ['show', `${REV}:${p}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1e8 })

const hex = (s) => Buffer.from(s, 'utf8').toString('hex')

// ── A/B/C: dialog.rs ────────────────────────────────────────────────────────
const rs = atRev('src-tauri/src/ipc/parity/dialog.rs')
const labStart = rs.indexOf('fn labels()')
const labBody = labStart < 0 ? '' : rs.slice(labStart, rs.indexOf('}', rs.indexOf('[', labStart)) + 1)
const rustRe = /ccg_fs::t\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/g
const rustPairs = [...labBody.matchAll(rustRe)].map((m) => [m[1], m[2]])

// 2.6.2 동결 원본 — 읽기 전용
const ts = fs.readFileSync(path.join(REPO, 'src', 'main', 'index.ts'), 'utf8')
const pStart = ts.indexOf('IPC.pickAttachments')
const pBlock = pStart < 0 ? '' : ts.slice(pStart, ts.indexOf('return r.canceled', pStart))
const tsRe = /\bt\(\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g
const tsPairs = [...pBlock.matchAll(tsRe)].map((m) => [m[1], m[2]])

ok('3.0 labels()의 t() 콜사이트 4', rustPairs.length === 4, `실제 ${rustPairs.length}`)
ok('2.6.2 pickAttachments의 t() 콜사이트 4', tsPairs.length === 4, `실제 ${tsPairs.length}`)

const pairDetail = []
let bytesEq = rustPairs.length === 4 && tsPairs.length === 4
for (let i = 0; i < 4; i++) {
  const r = rustPairs[i] || ['<none>', '<none>']
  const t = tsPairs[i] || ['<none>', '<none>']
  const koEq = hex(r[0]) === hex(t[0])
  const enEq = hex(r[1]) === hex(t[1])
  if (!koEq || !enEq) bytesEq = false
  pairDetail.push({ i, rust: r, ts: t, koEq, enEq, rustKoHex: hex(r[0]), tsKoHex: hex(t[0]), rustEnHex: hex(r[1]), tsEnHex: hex(t[1]) })
}
ok('넷이 (ko, en) 바이트까지 같다 · 순서까지', bytesEq,
  pairDetail.map((d) => `${d.i}:${d.koEq ? 'ko=' : 'ko≠'}${d.enEq ? 'en=' : 'en≠'}`).join(' '))

ok('en 인자에 한글이 없다', rustPairs.every(([, en]) => !/[가-힣]/.test(en)))
ok('ko와 en이 같은 칸이 없다', rustPairs.every(([ko, en]) => ko !== en))

const callStart = rs.indexOf('pub fn pick_attachments')
const callBody = callStart < 0 ? '' : rs.slice(callStart, rs.indexOf('#[cfg(test)]', callStart))
ok('pick_attachments가 labels()를 부른다', /=\s*labels\(\)\s*;/.test(callBody))
const builder = callBody.slice(callBody.indexOf('.set_title'), callBody.indexOf('.pick_files'))
ok('set_title/add_filter가 labels()의 값을 그대로 받는다',
  /\.set_title\(title\)/.test(builder) &&
  /\.add_filter\(f_all,/.test(builder) &&
  /\.add_filter\(f_img,/.test(builder) &&
  /\.add_filter\(f_txt,/.test(builder))
ok('빌더 구간에 한국어 리터럴 0', !/[가-힣]/.test(builder.replace(/\/\/[^\n]*/g, '')))
// 필터 첫 줄이 「첨부 가능한 파일」(2.6.2 규약)
ok('필터 첫 줄 = 첨부 가능한 파일(f_all)', builder.indexOf('.add_filter(f_all') < builder.indexOf('.add_filter(f_img'))

// ── D: 언어 판정 동치 ────────────────────────────────────────────────────────
const lang = fs.readFileSync(path.join(REPO, 'src', 'main', 'lang.ts'), 'utf8')
const fsrs = atRev('crates/ccg-fs/src/lib.rs')
const isEn = fsrs.slice(fsrs.indexOf('fn is_en()'), fsrs.indexOf('fn is_en()') + 900)
ok("2.6.2 t()는 ui.lang=='en'만 영어", /cur\s*=\s*v\s*===\s*'en'\s*\?\s*'en'\s*:\s*'ko'/.test(lang))
ok("3.0 is_en()도 ui.lang=='en'만 영어", /get\("ui\.lang"\)/.test(isEn) && /Some\("en"\)/.test(isEn))
ok('3.0 is_en() TTL은 2초 · 프로세스 전역 원자 캐시', /AtomicBool/.test(isEn) && /2000/.test(isEn))
ok('labels()는 const가 아니라 호출 시점 평가(fn)', /fn labels\(\)\s*->\s*\[String;\s*4\]/.test(rs))

const pass = results.every((r) => r.pass)
console.log(`\n${pass ? 'PASS' : 'FAIL'} — ${results.filter((r) => r.pass).length}/${results.length}`)
const jsonAt = process.argv.indexOf('--json')
if (jsonAt > 0 && process.argv[jsonAt + 1]) {
  fs.writeFileSync(process.argv[jsonAt + 1],
    JSON.stringify({ rev: REV, at: new Date().toISOString(), pass, results, pairs: pairDetail }, null, 2))
  console.log(`증거: ${process.argv[jsonAt + 1]}`)
}
process.exit(pass ? 0 : 1)
