#!/usr/bin/env node
/**
 * ★LSPIDLE R3 — **돌연변이 표**(확인 크리틱 R2 §4-B가 생존시킨 일곱을 붉히려는 라운드).
 *
 * ## 왜 R2 하네스를 그대로 못 쓰나
 *
 * 크리틱의 `docs/critic/tools/critic-lspidle-r2-mutants.mjs`는 13종을 심어
 * **6 붉음 / 7 생존**을 냈다. 그 파일의 앵커 중 셋(`GRACE_STALL_MS` 비교문·
 * `sweep_step(ttl_for(...))`·`step(now, ttl_ms, indexing)`)이 이 라운드에서 **문법째**
 * 바뀌었다(눈금이 스펙 필드로 내려가며 `Budget`이 됐다). 앵커를 못 찾은 돌연변이는
 * 「무효」로 떨어지고, 무효는 **초록도 붉음도 아니다** — 표가 그 자리에서 거짓말을 한다.
 *
 * 그래서 같은 13종을 **R3 문법으로 다시 적고**, R3이 새로 세운 것(스펙 필드 두 칸·
 * `pending` 표·렌더러 배선)을 겨누는 다섯을 더한다. 등급의 뜻은 R2와 같다:
 *
 *   expectRed: true  — 이 라운드가 「붉어야 한다」고 주장하는 것. 초록이면 **주장이 거짓**이다.
 *   expectRed: false — 붉을 이유가 없다고 보는 것(음성 대조). 붉으면 못이 과녁을 잘못 봤다.
 *
 * ★격리 사본에만 적용한다(`--tree`). 워크트리 제품 코드는 안 건드린다.
 * R1·R2 하네스가 밟은 두 함정(`--exact`로 0개 실행 · CRLF 앵커 불일치)은 여기서도 막고,
 * 「앵커를 못 찾았다」는 **실패로 센다**(무효를 조용히 지나가지 않는다).
 *
 * ```
 * node scripts/poc-lspidle-r3-mutants.mjs \
 *   --tree=C:/Temp/lspidle-r3-mut --target=C:/Temp/ccg-t-lspidle-r3mut \
 *   --out=bench/results/poc-lspidle-r3-mutants.json
 * ```
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const arg = (k, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}
const TREE = arg('tree', 'C:/Temp/lspidle-r3-mut')
const TARGET = arg('target', 'C:/Temp/ccg-t-lspidle-r3mut')
const OUT = arg('out', 'bench/results/poc-lspidle-r3-mutants.json')

const LIFE = 'crates/ccg-lsp/src/lifecycle.rs'
const SRV = 'crates/ccg-lsp/src/server.rs'
const MGR = 'crates/ccg-lsp/src/manager.rs'
const LIB = 'crates/ccg-lsp/src/lib.rs'
const SPEC = 'crates/ccg-lsp/src/spec.rs'
const FM = 'app/src/components/FileModal.tsx'

const MUTANTS = [
  // ── [묶음 안] R2가 붉히겠다고 설계한 것들 — R3 문법으로 옮겨 적었다 ──────────
  {
    id: 'A1-graceRemoved',
    zone: '묶음 안',
    why: '유예 자체를 제거(indexing을 안 본다)',
    file: LIFE,
    from: '        if indexing {\n            // ★상한',
    to: '        if false {\n            // ★상한',
    expectRed: true
  },
  {
    id: 'A2-stallCapRemoved',
    zone: '묶음 안',
    why: '멎음 상한 제거 — 「일한다」는 말을 증거 없이 믿는다',
    file: LIFE,
    from: 'if now.saturating_sub(self.last_work_ms) >= b.stall_ms {',
    to: 'if false {',
    expectRed: true
  },
  {
    id: 'A3-settleReclaims',
    zone: '묶음 안',
    why: '일이 끝나는 순간 접는다(Settle → Reclaim)',
    file: LIFE,
    from: '            return Sweep::Settle;',
    to: '            return Sweep::Reclaim;',
    expectRed: true
  },
  {
    id: 'A4-settleDoesNotResetIdle',
    zone: '묶음 안',
    why: 'Settle이 유휴 시계를 리셋하지 않는다',
    file: LIFE,
    from: '            self.grace_since_ms = 0;\n            self.last_used_ms = now;\n            return Sweep::Settle;',
    to: '            self.grace_since_ms = 0;\n            return Sweep::Settle;',
    expectRed: true
  },
  {
    id: 'A5-ttlIgnored',
    zone: '묶음 안',
    why: 'TTL 검사 삭제',
    file: LIFE,
    from: '        if self.idle_ms(now) < b.ttl_ms {',
    to: '        if false {',
    expectRed: true
  },
  {
    id: 'A6-neverStalls',
    zone: '묶음 안',
    why: '새 서버의 멎음 시계를 먼 미래로 — 영생',
    file: LIFE,
    from: 'Lifecycle { last_used_ms: now, grace_since_ms: 0, last_work_ms: now }',
    to: 'Lifecycle { last_used_ms: now, grace_since_ms: 0, last_work_ms: u64::MAX / 2 }',
    expectRed: true
  },

  // ── [묶음 밖] 크리틱이 **생존**시킨 셋 — R3의 새 못이 겨눈다 ─────────────────
  {
    id: 'B1-callerForgetsToReclaim',
    zone: '묶음 밖',
    why: '★호출부가 Reclaim을 실행하지 않는다(판정은 맞게 받고 아무것도 안 한다)',
    file: MGR,
    from: '                Sweep::Reclaim => {\n                    doomed.push((s.clone(), "유휴 서버 회수"));',
    to: '                Sweep::Reclaim => {\n                    if false { doomed.push((s.clone(), "유휴 서버 회수")); }',
    expectRed: true
  },
  {
    id: 'B2-callerNeverSteps',
    zone: '묶음 밖',
    why: '★호출부가 step을 아예 안 부른다(스윕이 살아 있는 서버를 건너뛴다)',
    file: MGR,
    from: '            match s.sweep_step(budget_for(s.spec)) {',
    to: '            match if true { Sweep::Keep } else { s.sweep_step(budget_for(s.spec)) } {',
    expectRed: true
  },
  {
    id: 'B3-sweeperNeverStarts',
    zone: '묶음 밖',
    why: '스윕 스레드를 아예 안 띄운다(회수가 영영 안 돈다)',
    file: MGR,
    from: 'fn start_sweeper() {\n    if SWEEPER.swap(true, Ordering::SeqCst) {\n        return;\n    }',
    to: 'fn start_sweeper() {\n    if true { return; }\n    if SWEEPER.swap(true, Ordering::SeqCst) {\n        return;\n    }',
    expectRed: true
  },

  // ── [시계 위조] 절대 시계가 정말 절대인가 — 크리틱의 C1·C2 ──────────────────
  {
    id: 'C1-sweepForgesWork',
    zone: '시계 위조',
    why: '★스윕이 스스로 「일한다는 증거」를 만든다(sweep_step이 saw_work를 부른다)',
    file: SRV,
    from: '    pub fn sweep_step(&self, b: Budget) -> Sweep {\n        let indexing = self.indexing();',
    to: '    pub fn sweep_step(&self, b: Budget) -> Sweep {\n        self.saw_work();\n        let indexing = self.indexing();',
    expectRed: true
  },
  {
    id: 'C2-statusPollForgesWork',
    zone: '시계 위조',
    why: '★상태 폴링이 멎음 시계를 되감는다(status가 saw_work를 부른다)',
    file: SRV,
    from: '    pub fn status(&self) -> Status {\n        let (st, pending) = {',
    to: '    pub fn status(&self) -> Status {\n        self.saw_work();\n        let (st, pending) = {',
    expectRed: true
  },

  // ── [B급 못] R2가 세운 관측점 — R3이 뒤늦게 못을 박은 자리 ──────────────────
  {
    id: 'D1-startCallsNotCounted',
    zone: '관측점',
    why: '「기동을 걸었는가」 관측점을 지운다',
    file: MGR,
    from: '    START_CALLS.fetch_add(1, Ordering::Relaxed);',
    to: '',
    expectRed: true
  },
  {
    id: 'D2-errorReasonDropped',
    zone: '관측점',
    why: '죽을 때 하는 말을 계약면에서 도로 뺀다',
    file: LIB,
    from: '    if let Some(e) = err {\n        o["error"] = json!(clip(&e, 320));\n    }',
    to: '',
    expectRed: true
  },

  // ── [R3이 새로 세운 것] 이 라운드의 주장을 그대로 공격한다 ──────────────────
  {
    id: 'E1-stallBackToFiveMinutes',
    zone: 'R3 A급',
    why: '★멎음 유예를 R2의 5분으로 되돌린다(스펙 값만 바꾼다 — 규칙은 그대로)',
    file: SPEC,
    from: '    stall_grace_ms: 30 * 60_000,\n    // Roslyn 재기동 ~3.1초',
    to: '    stall_grace_ms: 5 * 60_000,\n    // Roslyn 재기동 ~3.1초',
    expectRed: true
  },
  {
    id: 'E2-readyBudgetFlattened',
    zone: 'R3 B급③',
    why: '★느린 서버의 ready 예산을 옛 상수(1500ms)로 되돌린다',
    file: SPEC,
    from: '    ready_wait_ms: 5_000,',
    to: '    ready_wait_ms: 1_500,',
    expectRed: true
  },
  {
    id: 'E3-pendingMarkerDropped',
    zone: 'R3 B급③',
    why: '★「아직 못 물어봤다」 표를 뺀다 — 조용한 빈손으로 되돌아간다',
    file: LIB,
    from: '    json!({ "data": [], "types": [], "mods": [], "pending": true })',
    to: '    json!({ "data": [], "types": [], "mods": [] })',
    expectRed: true
  },
  {
    id: 'E4-graceDiagnosticDropped',
    zone: 'R3 C급',
    why: '진단에서 유예 칸을 뺀다(C-3에서 살린 죽은 코드가 도로 죽는다)',
    file: LIB,
    from: '        "grace": manager::grace_count(),',
    to: '',
    expectRed: true
  },
  {
    id: 'E5-errorWorldGateClosedAgain',
    zone: 'R3 B급①',
    why: '★렌더러가 에러 세계에서 다시 안 묻게 한다(크리틱이 지적한 그 게이트)',
    file: FM,
    from: "  const wantProjectStatus = (analyzing || lspStatus === 'error') && isCodeView",
    to: '  const wantProjectStatus = analyzing && isCodeView',
    // 러스트 못으로는 못 잡는다 — 렌더러 배선이라 `typecheck`도 안 문다.
    // 이 칸의 답은 **실화면 프로브**(poc-lspidle-reason.mjs)가 낸다. 그래서 여기서는
    // 「러스트가 못 잡는다」를 **기록**한다(모른 척하지 않는다).
    rust: false,
    expectRed: null
  }
]

function run(cmd, args, cwd, env) {
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024
    })
    return { red: false, out }
  } catch (e) {
    return { red: true, out: `${e.stdout || ''}\n${e.stderr || ''}` }
  }
}

function crateTests() {
  const r = run('cargo', ['test', '-p', 'ccg-lsp', '--', '--test-threads=1'], TREE, { CARGO_TARGET_DIR: TARGET })
  // ★0개가 돌았는데 초록이면 그건 통과가 아니라 필터가 아무것도 안 고른 것이다(R1에서 밟았다).
  const ran = [...r.out.matchAll(/(\d+) passed/g)].reduce((a, m) => a + +m[1], 0)
  const failed = [...r.out.matchAll(/^failures:\n\n((?:\s+\S+\n)+)/gm)].map((m) => m[1].trim().split(/\s+/)).flat()
  const compileErr = /^error(\[|:)/m.test(r.out) && !/test result:/.test(r.out)
  return { red: r.red, ranTests: ran, ranNothing: ran === 0, failed: [...new Set(failed)].slice(0, 8), compileErr }
}

const results = []
let invalid = 0
for (const m of MUTANTS) {
  const path = join(TREE, m.file)
  const orig = readFileSync(path, 'utf8')
  const nl = orig.includes('\r\n') ? '\r\n' : '\n'
  const from = m.from.replace(/\n/g, nl)
  const to = m.to.replace(/\n/g, nl)
  if (!orig.includes(from)) {
    invalid++
    results.push({ id: m.id, zone: m.zone, why: m.why, applied: false, error: '앵커를 못 찾았다 — 이 결과는 무효다' })
    console.log(`무효  ${m.id}  (앵커 없음)`)
    continue
  }
  writeFileSync(path, orig.replace(from, to))
  let verdict
  try {
    verdict = m.rust === false ? { red: null, note: '러스트 테스트 대상 아님 — 실화면 프로브가 답한다' } : crateTests()
  } finally {
    writeFileSync(path, orig)
  }
  const row = { id: m.id, zone: m.zone, why: m.why, applied: true, expectRed: m.expectRed, ...verdict }
  row.asExpected = m.expectRed == null ? null : verdict.red === m.expectRed
  results.push(row)
  const tag =
    verdict.red === null ? '해당없음' : verdict.red ? '붉음' : verdict.ranNothing ? '무효(0개 실행)' : '★초록(못이 없다)'
  console.log(`${tag}  [${m.zone}] ${m.id}  ${m.why}`)
  if (verdict.failed?.length) console.log(`        붉어진 못: ${verdict.failed.join(', ')}`)
}

const restored = crateTests()
const surprises = results.filter((r) => r.asExpected === false).map((r) => r.id)
const evidence = {
  harness: 'poc-lspidle-r3-mutants',
  at: new Date().toISOString(),
  tree: TREE,
  baselineRan: restored.ranTests,
  restoredGreen: !restored.red,
  invalidAnchors: invalid,
  surprises,
  results
}
writeFileSync(OUT, JSON.stringify(evidence, null, 1))
console.log(`\n복구 확인(초록이어야 한다): ${!restored.red} · ${restored.ranTests}개 통과`)
console.log(`앵커 무효: ${invalid} · 기대와 어긋난 칸: ${surprises.length ? surprises.join(', ') : '없다'}`)
console.log(`saved: ${OUT}`)
