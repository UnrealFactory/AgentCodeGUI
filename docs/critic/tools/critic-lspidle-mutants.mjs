#!/usr/bin/env node
/**
 * 확인 크리틱 LSPIDLE R1 — **못이 진짜 무는가**(돌연변이 확인).
 *
 * 빌더가 여섯 종을 붉혔다고 적었다. 그 여섯을 내 손으로 다시 붉히고, **빌더가 안 적은
 * 한 종**을 더 넣는다 — 「유예가 되감기를 실제로 하는가」(`Sweep::Rewind => s.touch()`를
 * 무효로 만든다). 순수 함수만 못 박혀 있고 **호출부가 안 박혀 있으면** 그 돌연변이는
 * 초록으로 지나간다. 그것이 초록이면 그건 통과가 아니라 **못이 없는 자리**다.
 *
 * ★**격리 사본에만** 적용한다(`--tree`). 워크트리 제품 코드는 안 건드린다.
 *
 * ```
 * node docs/critic/tools/critic-lspidle-mutants.mjs \
 *   --tree=C:/Temp/critic-lspidle --target=C:/Temp/ccg-t-critic --out=...json
 * ```
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const arg = (k, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.slice(k.length + 3) : d
}
const TREE = arg('tree', 'C:/Temp/critic-lspidle')
const TARGET = arg('target', 'C:/Temp/ccg-t-critic')
const OUT = arg('out', 'C:/Temp/critic-mutants.json')

/** `file`의 `from`을 `to`로 한 번만 바꾼다. 못 찾으면 **멈춘다**(조용한 무돌연변이 방지). */
const MUTANTS = [
  {
    id: 'onDemandRevert',
    why: '온디맨드 되돌림 — ts 스펙을 Eager로',
    file: 'crates/ccg-lsp/src/spec.rs',
    // SPECS 배열의 첫 항목이 ts라, 첫 occurrence 치환이 곧 ts 스펙이다.
    from: 'prewarm: Prewarm::Prepare,',
    to: 'prewarm: Prewarm::Eager,',
    tests: ['every_shipped_spec_is_on_demand', 'prewarm_prepares_without_spawning_a_single_process'],
    claimedByBuilder: true
  },
  {
    id: 'reclaimTimerIgnored',
    why: '회수 타이머 무시 — TTL 검사 삭제',
    file: 'crates/ccg-lsp/src/manager.rs',
    from: '    if idle_ms < ttl_ms {\n        return Sweep::Keep;\n    }\n',
    to: '',
    tests: ['the_reclaim_rule_honours_the_timer_the_grace_and_the_cap'],
    claimedByBuilder: true
  },
  {
    id: 'graceCapRemoved',
    why: '유예 상한(안전망) 제거',
    file: 'crates/ccg-lsp/src/manager.rs',
    from: 'if indexing && idle_ms < IDLE_GRACE_CAP_MS {',
    to: 'if indexing {',
    tests: ['the_reclaim_rule_honours_the_timer_the_grace_and_the_cap'],
    claimedByBuilder: true
  },
  {
    id: 'dietEatsContract',
    why: '다이어트가 계약 파일을 먹는다 — typescript/lib/ 통째로 제외',
    file: 'scripts/tauri-build.mjs',
    from: "  'typescript/lib/_tsc.js',",
    to: "  'typescript/lib/',",
    tests: ['the_diet_never_eats_a_file_the_contract_promises'],
    claimedByBuilder: true
  },
  {
    id: 'manifestBypassesDiet',
    why: '매니페스트가 레포 node_modules를 직접 가리킨다',
    file: 'src-tauri/tauri.conf.json',
    from: '"lsp-modules/node_modules/typescript/lib"',
    to: '"../node_modules/typescript/lib"',
    tests: ['every_bundled_file_is_covered_by_the_installer_manifest'],
    claimedByBuilder: true
  },
  {
    id: 'safetyNetKillsNothing',
    why: '좀비 안전망이 아무것도 안 죽인다',
    file: 'crates/ccg-lsp/src/zombie.rs',
    from: '        if owned || now.saturating_sub(t.born_ms) < max_age_ms {',
    to: '        if true {',
    tests: ['a_real_orphan_is_actually_killed'],
    claimedByBuilder: true
  },
  {
    // ★빌더가 안 적은 종. 순수 함수는 그대로 두고 **호출부만** 무효로 만든다.
    id: 'rewindDoesNotActuallyRewind',
    why: '유예가 되감기를 안 한다 — Sweep::Rewind가 touch()를 안 부른다(순수 함수는 그대로)',
    file: 'crates/ccg-lsp/src/manager.rs',
    from: 'Sweep::Rewind => s.touch(),',
    to: 'Sweep::Rewind => {}',
    tests: ['the_reclaim_rule_honours_the_timer_the_grace_and_the_cap', 'the_timers_stay_injectable_for_the_bench'],
    claimedByBuilder: false
  }
]

function runTest(name) {
  try {
    const out = execFileSync(
      'cargo',
      // ★`--exact`를 쓰면 안 된다 — 테스트의 진짜 이름은 `manager::tests::<이름>`이라
      //   짧은 이름과는 절대 안 맞고, **0개가 돌면서 종료 코드는 0**이다. 첫 판이 그 함정에
      //   빠져 일곱 종이 전부 「초록」으로 나왔다. 부분 일치로 고르고, 아래에서 «몇 개가
      //   실제로 돌았는지»를 같이 적는다.
      ['test', '-p', 'ccg-lsp', '--', name, '--test-threads=1'],
      { cwd: TREE, env: { ...process.env, CARGO_TARGET_DIR: TARGET }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const ran = [...out.matchAll(/(\d+) passed/g)].reduce((a, m) => a + +m[1], 0)
    return { red: false, ranTests: ran, ranNothing: ran === 0, tail: out.split('\n').slice(-4).join(' ').trim().slice(0, 200) }
  } catch (e) {
    const txt = `${e.stdout || ''}\n${e.stderr || ''}`
    return { red: true, tail: (txt.match(/^.*(FAILED|panicked at).*$/m) || [''])[0].trim().slice(0, 220) }
  }
}

const results = []
for (const m of MUTANTS) {
  const path = join(TREE, m.file)
  const orig = readFileSync(path, 'utf8')
  // ★줄바꿈을 파일에 맞춘다. 레포는 CRLF라, `\n`으로 적은 여러 줄 앵커는 **조용히 안 맞고**
  //   그 돌연변이는 「적용 안 됨」이 된다(첫 판이 그렇게 한 종을 통째로 놓쳤다).
  const nl = orig.includes('\r\n') ? '\r\n' : '\n'
  m.from = m.from.replace(/\n/g, nl)
  m.to = m.to.replace(/\n/g, nl)
  if (!orig.includes(m.from)) {
    results.push({ ...m, applied: false, error: '돌연변이 자리를 못 찾았다 — 이 결과는 무효다' })
    continue
  }
  writeFileSync(path, orig.replace(m.from, m.to))
  const per = {}
  try {
    for (const t of m.tests) per[t] = runTest(t)
  } finally {
    writeFileSync(path, orig) // ★언제나 되돌린다
  }
  const anyRed = Object.values(per).some((r) => r.red)
  const ranNothing = Object.values(per).some((r) => r.ranNothing)
  results.push({ id: m.id, why: m.why, file: m.file, claimedByBuilder: m.claimedByBuilder, applied: true, anyRed, ranNothing, per })
  console.log(`${anyRed ? '붉음' : ranNothing ? '무효(테스트가 0개 돌았다)' : '★초록(못이 없다)'}  ${m.id}  ${m.why}`)
}

// 되돌린 뒤 초록으로 복귀하는지 확인 — 그래야 위 붉음이 돌연변이 때문이라고 말할 수 있다.
const restored = runTest('the_reclaim_rule_honours_the_timer_the_grace_and_the_cap')
const evidence = { at: new Date().toISOString(), tree: TREE, results, restoredGreen: !restored.red }
writeFileSync(OUT, JSON.stringify(evidence, null, 1))
console.log(`\n복구 확인(초록이어야 한다): ${!restored.red}`)
console.log(`saved: ${OUT}`)
