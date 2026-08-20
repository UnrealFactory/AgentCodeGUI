/**
 * PoC — /btw(컨텍스트 포크 질문 창) 판정 로직 검증.
 *
 * 클로드 코드의 btw 패리티: 현재 대화의 세션을 포크(forkSession)해 별도 질문 창으로
 * 열되, 원본 대화에는 흔적을 남기지 않는다. 판정이 틀리면 두 방향의 사고가 난다 —
 * (1) 포크가 아니라 '이어쓰기'로 붙어 원본 세션이 오염되거나(최악),
 * (2) 폴더/엔진이 안 맞는 세션을 resume해 "No conversation found"로 죽는다.
 *
 * 검증 (전부 실 모듈 src/renderer/src/lib/btw.ts 구동 — 복사본 없음):
 *  A. parseBtw — '/btw'·'/btw 질문'(대소문자·개행·트림)은 hit, '/btwxyz'·중간 등장은 miss
 *  B. sameCwd — store/session에서 lib/btw로 이사한 함수의 회귀(구분자·트레일링·대소문자)
 *  C. btwForkOf — 세션 없음·폴더 불일치·Codex는 null(새 컨텍스트), 정상만 {fork, cwd}
 *  D. btwRunResume — 자기 세션 > 시드 포크(원본 폴더·claude 한정) > 새 대화,
 *     자기 세션이 있으면 절대 forkSession을 켜지 않는다(매 턴 재포크 = 세션 분열)
 *
 * 실행: node scripts/poc-btw-fork.mjs   (esbuild로 lib를 번들 후 인메모리 구동)
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const bundle = path.join(root, '.poc-btw-fork.mjs')

await esbuild.build({
  entryPoints: [path.join(root, 'src/renderer/src/lib/btw.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: bundle
})
const lib = await import(pathToFileURL(bundle).href)
fs.rmSync(bundle, { force: true })

let pass = 0
let fail = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else {
    fail++
    console.error(`  FAIL ${name}\n    want ${JSON.stringify(want)}\n    got  ${JSON.stringify(got)}`)
  }
}

// ── A. '/btw [질문]' 파싱 ────────────────────────────────────────────
console.log('A. parseBtw')
eq('맨몸 /btw', lib.parseBtw('/btw'), { prompt: '' })
eq('꼬리 공백', lib.parseBtw('/btw   '), { prompt: '' })
eq('앞뒤 공백 트림', lib.parseBtw('  /btw 이 함수 뭐 하는 거야?  '), { prompt: '이 함수 뭐 하는 거야?' })
eq('대문자 /BTW', lib.parseBtw('/BTW quick question'), { prompt: 'quick question' })
eq('개행으로 이어진 질문', lib.parseBtw('/btw\n여러 줄\n질문'), { prompt: '여러 줄\n질문' })
eq('질문 안 개행 보존', lib.parseBtw('/btw 첫 줄\n둘째 줄'), { prompt: '첫 줄\n둘째 줄' })
eq('접두 일치는 명령 아님 (/btwxyz)', lib.parseBtw('/btwxyz'), null)
eq('중간 등장은 명령 아님', lib.parseBtw('그런데 /btw 이건?'), null)
eq('다른 명령(/clear)', lib.parseBtw('/clear'), null)
eq('빈 문자열', lib.parseBtw(''), null)

// ── B. sameCwd 이사 회귀 (store/session → lib/btw) ───────────────────
console.log('B. sameCwd')
eq('구분자·대소문자·트레일링 무시', lib.sameCwd('C:\\Code\\App', 'c:/code/app/'), true)
eq('겹구분자 정규화', lib.sameCwd('C:\\\\Code//App', 'C:/Code/App'), true)
eq('다른 폴더', lib.sameCwd('C:/a', 'C:/b'), false)
eq('빈 값은 불일치', lib.sameCwd('', 'C:/a'), false)
eq('null 안전', lib.sameCwd(null, 'C:/a'), false)

// ── C. 원본 채팅에서의 포크 소스 판정 ────────────────────────────────
console.log('C. btwForkOf')
const SES = { sessionId: 'ses-123', cwd: 'C:\\Code\\App' }
eq('정상 — 세션 폴더 그대로', lib.btwForkOf(SES, 'c:/code/app'), { fork: 'ses-123', cwd: 'C:\\Code\\App' })
eq('세션 없음(첫 응답 전)', lib.btwForkOf(null, 'C:/Code/App'), null)
eq('빈 세션 id', lib.btwForkOf({ sessionId: '', cwd: 'C:/Code/App' }, 'C:/Code/App'), null)
eq('폴더 불일치(세션은 폴더 스코프)', lib.btwForkOf(SES, 'C:/Other'), null)
eq('Codex는 포크 미지원', lib.btwForkOf(SES, 'C:/Code/App', 'codex'), null)
eq('claude 명시', lib.btwForkOf(SES, 'C:/Code/App', 'claude'), { fork: 'ses-123', cwd: 'C:\\Code\\App' })

// ── D. btw 창의 실행 resume 결정 ─────────────────────────────────────
console.log('D. btwRunResume')
const SEED = { fork: 'ses-123', cwd: 'C:\\Code\\App' }
eq('첫 실행 = 시드 포크', lib.btwRunResume(undefined, SEED, 'c:/code/app'), { resume: 'ses-123', forkSession: true })
eq('자기 세션이 생기면 보통 resume (재포크 금지)', lib.btwRunResume('own-9', SEED, 'C:/Code/App'), { resume: 'own-9' })
eq('자기 세션 + Codex 전환(스레드 resume 경로 유지)', lib.btwRunResume('own-9', SEED, 'C:/Code/App', 'codex'), { resume: 'own-9' })
eq('폴더를 바꿨으면 시드 접기 → 새 대화', lib.btwRunResume(undefined, SEED, 'C:/Other'), {})
eq('Codex로 바꿨으면 시드 접기 → 새 대화', lib.btwRunResume(undefined, SEED, 'C:/Code/App', 'codex'), {})
eq('시드 없음(일반 추가 채팅 첫 실행)', lib.btwRunResume(undefined, null, 'C:/Code/App'), {})
eq('빈 cwd(바탕화면 폴백)는 시드와 불일치', lib.btwRunResume(undefined, SEED, ''), {})

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
