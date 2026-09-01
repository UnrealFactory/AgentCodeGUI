#!/usr/bin/env node
/**
 * 확인 크리틱 LSPIDLE **R2** — 새 의미론(`Lifecycle::step`)을 우회할 수 있는가.
 *
 * R2의 주장은 「돌연변이를 잡는 대신 **쓸 수 없게** 만들었다」다(판정과 전이를 한 함수에 묶어
 * 호출부에 잊을 것을 안 남겼다). 그 주장을 그대로 공격한다 — 묶음 **바깥**에 남은 것이
 * 무엇인지, 그리고 그 바깥이 무너지면 붉어지는 못이 있는지.
 *
 * 세 갈래로 나눠 심는다:
 *   [묶음 안]  규칙 자체를 망가뜨린다 → 붉어야 한다(R2가 그렇게 설계했다)
 *   [묶음 밖]  호출부가 남은 일(회수 실행·step 호출)을 잊는다 → **여기가 진짜 시험이다**
 *   [시계 위조] 스윕·폴링이 「일한다는 증거」를 스스로 만든다 → 절대 시계가 절대가 아니게 된다
 *
 * ★격리 사본에만 적용한다(`--tree`). 워크트리 제품 코드는 안 건드린다.
 * R1 하네스가 밟은 두 함정(`--exact`로 0개 실행 · CRLF 앵커 불일치)은 여기서도 막는다.
 *
 * ```
 * node docs/critic/tools/critic-lspidle-r2-mutants.mjs \
 *   --tree=C:/Temp/critic2-lspidle --target=C:/Temp/ccg-t-critic2 --out=...json
 * ```
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const arg = (k, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}
const TREE = arg('tree', 'C:/Temp/critic2-lspidle')
const TARGET = arg('target', 'C:/Temp/ccg-t-critic2')
const OUT = arg('out', 'C:/Temp/critic2-mutants.json')

/** 전 스위트를 돌린다 — 「어느 못이 무는가」가 아니라 **「하나라도 무는가」**를 본다. */
const WHOLE_CRATE = '<crate>'

const MUTANTS = [
  // ── [묶음 안] R2가 붉히겠다고 설계한 것들 ────────────────────────────────
  {
    id: 'A1-graceRemoved',
    zone: '묶음 안',
    why: '유예 자체를 제거(indexing을 안 본다)',
    file: 'crates/ccg-lsp/src/lifecycle.rs',
    from: '        if indexing {\n            // ★상한',
    to: '        if false {\n            // ★상한',
    expectRed: true
  },
  {
    id: 'A2-stallCapRemoved',
    zone: '묶음 안',
    why: '멎음 상한 제거 — 「일한다」는 말을 증거 없이 믿는다',
    file: 'crates/ccg-lsp/src/lifecycle.rs',
    from: 'if now.saturating_sub(self.last_work_ms) >= GRACE_STALL_MS {',
    to: 'if false {',
    expectRed: true
  },
  {
    id: 'A3-settleReclaims',
    zone: '묶음 안',
    why: '일이 끝나는 순간 접는다(Settle → Reclaim)',
    file: 'crates/ccg-lsp/src/lifecycle.rs',
    from: '            return Sweep::Settle;',
    to: '            return Sweep::Reclaim;',
    expectRed: true
  },
  {
    id: 'A4-settleDoesNotResetIdle',
    zone: '묶음 안',
    why: 'Settle이 유휴 시계를 리셋하지 않는다(전이를 잊는다 — 묶음 안 버전)',
    file: 'crates/ccg-lsp/src/lifecycle.rs',
    from: '            self.grace_since_ms = 0;\n            self.last_used_ms = now;\n            return Sweep::Settle;',
    to: '            self.grace_since_ms = 0;\n            return Sweep::Settle;',
    expectRed: true
  },
  {
    id: 'A5-ttlIgnored',
    zone: '묶음 안',
    why: 'TTL 검사 삭제',
    file: 'crates/ccg-lsp/src/lifecycle.rs',
    from: '        if self.idle_ms(now) < ttl_ms {',
    to: '        if false {',
    expectRed: true
  },
  {
    id: 'A6-neverStalls',
    zone: '묶음 안',
    why: '새 서버의 멎음 시계를 먼 미래로 — 영생',
    file: 'crates/ccg-lsp/src/lifecycle.rs',
    from: 'Lifecycle { last_used_ms: now, grace_since_ms: 0, last_work_ms: now }',
    to: 'Lifecycle { last_used_ms: now, grace_since_ms: 0, last_work_ms: u64::MAX / 2 }',
    expectRed: true
  },

  // ── [묶음 밖] 호출부에 아직 남아 있는 일 ─────────────────────────────────
  {
    id: 'B1-callerForgetsToReclaim',
    zone: '묶음 밖',
    why: '★호출부가 Reclaim을 실행하지 않는다(판정은 맞게 받고 아무것도 안 한다)',
    file: 'crates/ccg-lsp/src/manager.rs',
    from: '                Sweep::Reclaim => {\n                    doomed.push((s.clone(), "유휴 서버 회수"));',
    to: '                Sweep::Reclaim => {\n                    if false { doomed.push((s.clone(), "유휴 서버 회수")); }',
    expectRed: null // 모름 — 이 하네스가 답을 낸다
  },
  {
    id: 'B2-callerNeverSteps',
    zone: '묶음 밖',
    why: '★호출부가 step을 아예 안 부른다(스윕이 살아 있는 서버를 건너뛴다)',
    file: 'crates/ccg-lsp/src/manager.rs',
    from: '            match s.sweep_step(ttl_for(s.spec)) {',
    to: '            match if true { Sweep::Keep } else { s.sweep_step(ttl_for(s.spec)) } {',
    expectRed: null
  },
  {
    id: 'B3-sweeperNeverStarts',
    zone: '묶음 밖',
    why: '스윕 스레드를 아예 안 띄운다(회수가 영영 안 돈다)',
    file: 'crates/ccg-lsp/src/manager.rs',
    from: 'fn start_sweeper() {\n    if SWEEPER.swap(true, Ordering::SeqCst) {\n        return;\n    }',
    to: 'fn start_sweeper() {\n    if true { return; }\n    if SWEEPER.swap(true, Ordering::SeqCst) {\n        return;\n    }',
    expectRed: null
  },

  // ── [시계 위조] 절대 시계가 정말 절대인가 ────────────────────────────────
  {
    id: 'C1-sweepForgesWork',
    zone: '시계 위조',
    why: '★스윕이 스스로 「일한다는 증거」를 만든다(sweep_step이 saw_work를 부른다)',
    file: 'crates/ccg-lsp/src/server.rs',
    from: '    pub fn sweep_step(&self, ttl_ms: u64) -> Sweep {\n        let indexing = self.indexing();',
    to: '    pub fn sweep_step(&self, ttl_ms: u64) -> Sweep {\n        self.saw_work();\n        let indexing = self.indexing();',
    expectRed: null
  },
  {
    id: 'C2-statusPollForgesWork',
    zone: '시계 위조',
    why: '★상태 폴링이 멎음 시계를 되감는다(status가 saw_work를 부른다)',
    file: 'crates/ccg-lsp/src/server.rs',
    from: '    pub fn status(&self) -> Status {\n        let (st, pending) = {',
    to: '    pub fn status(&self) -> Status {\n        self.saw_work();\n        let (st, pending) = {',
    expectRed: null
  },

  // ── [B급 못] R2가 새로 세운 관측점 ───────────────────────────────────────
  {
    id: 'D1-startCallsNotCounted',
    zone: 'B급 ①',
    why: '「기동을 걸었는가」 관측점을 지운다',
    file: 'crates/ccg-lsp/src/manager.rs',
    from: '    START_CALLS.fetch_add(1, Ordering::Relaxed);',
    to: '',
    expectRed: null
  },
  {
    id: 'D2-errorReasonDropped',
    zone: 'B급 ②',
    why: '죽을 때 하는 말을 계약면에서 도로 뺀다',
    file: 'crates/ccg-lsp/src/lib.rs',
    from: '    if let Some(e) = err {\n        o["error"] = json!(clip(&e, 320));\n    }',
    to: '',
    expectRed: null
  },
  {
    id: 'D3-pollBackoffReverted',
    zone: '폴링 격자',
    why: '백오프를 고정 400ms로 되돌린다(R2가 산 −183ms를 도로 판다)',
    file: 'app/src/components/FileModal.tsx',
    from: 'setTimeout(tick, WARMUP_POLL_MS[warm++] ?? LSP_POLL_STEADY_MS)',
    to: 'setTimeout(tick, LSP_POLL_STEADY_MS)',
    expectRed: null,
    rust: false // 러스트 테스트로는 못 잡는다 — typecheck만 돌린다
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
  // ★`--skip critic_` — 격리 사본에 내가 심은 못은 빼고 **빌더의 못만** 돌린다.
  //   묻는 것이 「내 못이 잡는가」가 아니라 「이 라운드가 세운 못이 잡는가」이기 때문이다.
  const r = run('cargo', ['test', '-p', 'ccg-lsp', '--', '--test-threads=1', '--skip', 'critic_'], TREE, {
    CARGO_TARGET_DIR: TARGET
  })
  // ★0개가 돌았는데 초록이면 그건 통과가 아니라 필터가 아무것도 안 고른 것이다(R1에서 밟았다).
  const ran = [...r.out.matchAll(/(\d+) passed/g)].reduce((a, m) => a + +m[1], 0)
  const failed = [...r.out.matchAll(/^failures:\n\n((?:\s+\S+\n)+)/gm)].map((m) => m[1].trim().split(/\s+/)).flat()
  const compileErr = /^error(\[|:)/m.test(r.out) && !/test result:/.test(r.out)
  return { red: r.red, ranTests: ran, ranNothing: ran === 0, failed: [...new Set(failed)].slice(0, 8), compileErr }
}

const results = []
for (const m of MUTANTS) {
  const path = join(TREE, m.file)
  const orig = readFileSync(path, 'utf8')
  const nl = orig.includes('\r\n') ? '\r\n' : '\n'
  const from = m.from.replace(/\n/g, nl)
  const to = m.to.replace(/\n/g, nl)
  if (!orig.includes(from)) {
    results.push({ id: m.id, zone: m.zone, why: m.why, applied: false, error: '앵커를 못 찾았다 — 이 결과는 무효다' })
    console.log(`무효  ${m.id}  (앵커 없음)`)
    continue
  }
  writeFileSync(path, orig.replace(from, to))
  let verdict
  try {
    verdict = m.rust === false ? { red: null, note: '러스트 테스트 대상 아님(§폴링 격자는 실측으로 본다)' } : crateTests()
  } finally {
    writeFileSync(path, orig)
  }
  const row = { id: m.id, zone: m.zone, why: m.why, applied: true, expectRed: m.expectRed, ...verdict }
  results.push(row)
  const tag = verdict.red === null ? '해당없음' : verdict.red ? '붉음' : verdict.ranNothing ? '무효(0개 실행)' : '★초록(못이 없다)'
  console.log(`${tag}  [${m.zone}] ${m.id}  ${m.why}`)
  if (verdict.failed?.length) console.log(`        붉어진 못: ${verdict.failed.join(', ')}`)
}

const restored = crateTests()
const evidence = { at: new Date().toISOString(), tree: TREE, results, restoredGreen: !restored.red, restoredRan: restored.ranTests }
writeFileSync(OUT, JSON.stringify(evidence, null, 1))
console.log(`\n복구 확인(초록이어야 한다): ${!restored.red} · ${restored.ranTests}개 통과`)
console.log(`saved: ${OUT}`)
