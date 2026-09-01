/**
 * 확인 크리틱 LSPIDLE R3 — 빌더 표(E1~E5) **밖**의 회피를 찾는다.
 * 격리 사본에만 적용한다. 워크트리 제품 코드는 안 건드린다.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const TREE = 'C:/Temp/c4-mutx', TARGET = 'C:/Temp/c4-t-mutx'
const SPEC = 'crates/ccg-lsp/src/spec.rs', MGR = 'crates/ccg-lsp/src/manager.rs'
const LIB = 'crates/ccg-lsp/src/lib.rs'

const M = [
  { id: 'N1-stallInflated10x', zone: '★새 회피', file: SPEC,
    why: '멎음 유예를 10배로 부풀린다(값만) — 「말만 하는 서버」 수명이 25/60분 → 250/600분',
    expectRed: true, // 빌더 주석이 「값을 키워 놓고 통과」를 막았다고 주장한다
    reps: [['stall_grace_ms: 15 * 60_000,', 'stall_grace_ms: 150 * 60_000,'],
           ['stall_grace_ms: 30 * 60_000,', 'stall_grace_ms: 300 * 60_000,']], all: true },
  { id: 'N2-budgetForIgnoresSpec', zone: '★새 회피', file: MGR,
    why: '제품 경로(budget_for)만 옛 5분으로 되돌린다 — 못이 Budget::of만 본다면 안 걸린다',
    expectRed: true,
    reps: [['stall_ms: env_u64("CCG_LSP_STALL_MS").unwrap_or(spec.stall_grace_ms),', 'stall_ms: 5 * 60_000,']] },
  { id: 'N3-readyWaitInflated', zone: '★새 회피', file: SPEC,
    why: 'ready 예산을 100배로 — IPC 스레드가 그만큼 묶인다(위쪽 상한이 있나)',
    expectRed: true,
    reps: [['ready_wait_ms: 1_500,', 'ready_wait_ms: 150_000,'], ['ready_wait_ms: 5_000,', 'ready_wait_ms: 500_000,'],
           ['ready_wait_ms: 4_000,', 'ready_wait_ms: 400_000,']], all: true },
  { id: 'N4-pendingOnEveryAnswer', zone: '★새 회피', file: LIB,
    why: '진짜 답에도 「아직」 표를 단다 — 렌더러가 영원히 재장전한다',
    expectRed: true,
    reps: [['json!({ "data": t.data, "types": t.types, "mods": t.mods })', 'json!({ "data": t.data, "types": t.types, "mods": t.mods, "pending": true })']] }
]

const out = []
for (const m of M) {
  const p = join(TREE, m.file)
  const orig = readFileSync(p, 'utf8')
  const nl = orig.includes('\r\n') ? '\r\n' : '\n'
  let s = orig, applied = 0
  for (const [f, t] of m.reps) {
    const from = f.split('\n').join(nl), to = t.split('\n').join(nl)
    if (!s.includes(from)) continue
    if (m.all) { const n = s.split(from).length - 1; s = s.split(from).join(to); applied += n }
    else { s = s.replace(from, to); applied += 1 }
  }
  if (!applied) { console.log(`무효  ${m.id} — 앵커 없음`); out.push({ id: m.id, applied: false }); continue }
  writeFileSync(p, s)
  let red, txt = ''
  try { txt = execFileSync('cargo', ['test','-p','ccg-lsp','--','--test-threads=1'],
        { cwd: TREE, env: { ...process.env, CARGO_TARGET_DIR: TARGET }, encoding: 'utf8', maxBuffer: 64<<20 }); red = false }
  catch (e) { txt = `${e.stdout||''}${e.stderr||''}`; red = true }
  finally { writeFileSync(p, orig) }
  const passed = [...txt.matchAll(/(\d+) passed/g)].reduce((a,b)=>a+ +b[1],0)
  const failed = [...txt.matchAll(/^    (\w+::)*\w+$/gm)].map(x=>x[0].trim())
  const compileErr = /^error(\[|:)/m.test(txt) && !/test result:/.test(txt)
  console.log(`${red ? '붉음' : '★생존(초록)'}  ${m.id}  (${applied}곳) · ${passed}개 통과${compileErr ? ' ※컴파일오류' : ''}`)
  if (red && failed.length) console.log(`      문 못: ${[...new Set(failed)].slice(0,6).join(', ')}`)
  out.push({ id: m.id, zone: m.zone, why: m.why, applied, survived: !red, passed, compileErr,
             bit: [...new Set(failed)].slice(0,8), expectRed: m.expectRed, matchedExpectation: m.expectRed === red })
}
writeFileSync('C:/Temp/c4-evade.json', JSON.stringify(out, null, 1))
console.log('\nsaved')
