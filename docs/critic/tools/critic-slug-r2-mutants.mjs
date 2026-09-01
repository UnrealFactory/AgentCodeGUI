#!/usr/bin/env node
/* ============================================================================
 * critic-slug-r2-mutants — R2가 세웠다는 못이 **진짜로 무엇을 지키는지**.
 *
 * 재현: M4(빌더의 되돌림) · E2 · E3(R1에서 살아남았던 회피 둘).
 * 새로: **E1′** — 빌더가 「크리틱의 E1보다 얇은 회피」라고 주장한 그 형태다.
 *       R1의 내 E1은 스캔이 빈손이어도 `Ok(root.join(slug))`을 냈고, 그래서
 *       `unregistered_…` 못이 잡았다(내 실측 1 red). 빌더는 **스캔이 빈손이면 원래
 *       Err를 그대로 올리는** 형태를 썼고 그러면 커버리지가 0이라고 했다.
 *       그 주장을 R1 커밋과 R2 커밋 **양쪽에서** 재서 판정한다.
 *
 * 실행:
 *   node docs/critic/tools/critic-slug-r2-mutants.mjs --repo=<격리트리> --target=<타깃>
 *   node ... --only=E1P --suites=shell
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const argOf = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? '').split('=')[1] || d
const REPO = path.resolve(argOf('repo', ''))
const TARGET = argOf('target', 'C:/Code/.cargo-slugr2')
const ONLY = (argOf('only', '') || '').split(',').filter(Boolean)
const PICK = (argOf('suites', '') || '').split(',').filter(Boolean)
const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const OUT = path.join(HERE, 'evidence', `slug-r2-mutants${argOf('out', '')}.json`)
if (!REPO) throw new Error('--repo= 가 필요하다(격리 사본)')

const AUTH = path.join(REPO, 'crates', 'ccg-auth', 'src', 'claude.rs')
const CA = path.join(REPO, 'src-tauri', 'src', 'engine', 'claude_account.rs')

/** 실물 리졸버 한 줄(R1·R2 공통). */
const REAL_RESOLVER = `pub fn resolver() -> ccg_engine::runtime::AccountResolver {
    Arc::new(|email: &str| ccg_auth::claude::account_run_dir(email).map_err(|e| why(&e)))
}`

const MUTANTS = [
  {
    id: 'M4',
    what: '★R2의 한 줄을 되돌린다 — `snapshot_of`가 다시 단발 읽기',
    edits: [
      {
        file: AUTH,
        find: 'pub fn snapshot_of(email: &str) -> Result<Snapshot, AuthError> {\n    let f = read_store_settled();',
        to: 'pub fn snapshot_of(email: &str) -> Result<Snapshot, AuthError> {\n    let f = read_store_quiet();'
      }
    ]
  },
  {
    id: 'E1P',
    what: "E1′ — 실패했을 때만 옛 스캔으로 때우되, **스캔이 빈손이면 Err를 그대로 올린다**(빌더 주장의 형태)",
    edits: [
      {
        file: CA,
        find: REAL_RESOLVER,
        to: `pub fn resolver() -> ccg_engine::runtime::AccountResolver {
    Arc::new(|email: &str| {
        let first = ccg_auth::claude::account_run_dir(email);
        let Err(e) = first else { return first.map_err(|e| why(&e)) };
        // 회피: 그럴듯한 폴더가 **있으면** 그것으로 때운다. 없으면 정직하게 사유를 올린다.
        let slug = email.replace('@', "_").replace('+', "-");
        let root = ccg_store::app_home().join("accounts");
        if let Ok(rd) = std::fs::read_dir(&root) {
            for ent in rd.flatten() {
                let n = ent.file_name().to_string_lossy().to_string();
                if n == slug || n.starts_with(&format!("{slug}-")) {
                    return Ok(root.join(n));
                }
            }
        }
        Err(why(&e))
    })
}`
      }
    ]
  },
  {
    id: 'E2',
    what: '리졸버가 이메일별로 한 번만 진짜를 부르고 이후 캐시(물질화 부작용이 사라진다)',
    edits: [
      {
        file: CA,
        find: REAL_RESOLVER,
        to: `pub fn resolver() -> ccg_engine::runtime::AccountResolver {
    let seen: std::sync::Mutex<std::collections::HashMap<String, std::path::PathBuf>> =
        std::sync::Mutex::new(std::collections::HashMap::new());
    Arc::new(move |email: &str| {
        if let Some(p) = seen.lock().unwrap().get(email) {
            return Ok(p.clone());
        }
        let d = ccg_auth::claude::account_run_dir(email).map_err(|e| why(&e))?;
        seen.lock().unwrap().insert(email.to_string(), d.clone());
        Ok(d)
    })
}`
      }
    ]
  },
  {
    id: 'E3',
    what: '`why()`가 `NotRegistered` 외 넷을 같은 한 줄로 뭉갠다',
    edits: [
      {
        file: CA,
        find: `        E::Undecryptable(_) => {
            "저장된 자격증명을 풀지 못했어요 — 다른 사용자·다른 PC의 홈을 옮겨 온 경우예요(다시 로그인해 주세요)".into()
        }`,
        to: `        E::Undecryptable(_) => "문제가 생겼어요".into(),`
      },
      {
        file: CA,
        find: `        E::CorruptSnapshot(_) => "저장된 계정 정보가 깨졌어요(다시 로그인해 주세요)".into(),`,
        to: `        E::CorruptSnapshot(_) => "문제가 생겼어요".into(),`
      }
    ]
  }
]

const ALL_SUITES = [
  ['authR2', ['test', '-p', 'ccg-auth', '--test', 'slug_r2_store_settled', '--', '--test-threads=1']],
  ['engine', ['test', '-p', 'ccg-engine', '--lib', 'slug_r1_account_dir_tests', '--', '--test-threads=1']],
  ['shell', ['test', '-p', 'agentcodegui', 'engine::claude_account', '--', '--test-threads=1']],
  ['attack', ['test', '-p', 'ccg-engine', '--test', 'critic_slug_r1_attack', '--', '--test-threads=1']]
]
const SUITES = PICK.length ? ALL_SUITES.filter(([n]) => PICK.includes(n)) : ALL_SUITES

const env = { ...process.env, CARGO_TARGET_DIR: TARGET }
function cargo(argv) {
  const r = spawnSync('cargo', argv, { cwd: REPO, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const m = out.match(/test result: (ok|FAILED)\. (\d+) passed; (\d+) failed/)
  const names = [...out.matchAll(/^test (\S+) \.\.\. FAILED$/gm)].map((x) => x[1])
  const compiled = !!m
  return {
    compiled,
    pass: m ? Number(m[2]) : 0,
    fail: m ? Number(m[3]) : null,
    failed: names,
    firstError: compiled ? null : (out.match(/error(\[E\d+\])?: .*/) ?? [null])[0]
  }
}

const rep = { at: new Date().toISOString(), repo: REPO, baseline: null, mutants: [] }
function runSuites(tag) {
  const out = {}
  for (const [name, argv] of SUITES) {
    out[name] = cargo(argv)
    console.log(`    ${tag}/${name}: ${out[name].pass}p/${out[name].fail}f ${out[name].failed.length ? JSON.stringify(out[name].failed) : ''}`)
  }
  return out
}

const backup = new Map()
const CRLF = new RegExp(String.fromCharCode(13) + String.fromCharCode(10), 'g')
function apply(m) {
  for (const e of m.edits) {
    const raw = fs.readFileSync(e.file, 'utf8')
    if (!backup.has(e.file)) backup.set(e.file, raw)
    const src = fs.readFileSync(e.file, 'utf8').replace(CRLF, '\n')
    if (!src.includes(e.find)) throw new Error(`${m.id}: 찾을 조각이 없다 — ${path.basename(e.file)}`)
    fs.writeFileSync(e.file, src.replace(e.find, e.to))
  }
}
function restore() {
  for (const [f, s] of backup) fs.writeFileSync(f, s)
  backup.clear()
}

console.log('[baseline]')
rep.baseline = runSuites('base')
for (const m of MUTANTS) {
  if (ONLY.length && !ONLY.includes(m.id)) continue
  console.log(`\n[${m.id}] ${m.what}`)
  try {
    apply(m)
    const res = runSuites(m.id)
    const killedBy = Object.entries(res)
      .filter(([, v]) => v.fail === null || v.fail > 0)
      .map(([k]) => k)
    const allFailed = Object.values(res).flatMap((v) => v.failed)
    rep.mutants.push({ id: m.id, what: m.what, suites: res, killedBy, failedTests: allFailed, survived: killedBy.length === 0 })
    console.log(`  → ${killedBy.length ? `죽었다(${killedBy.join(',')}) — ${JSON.stringify(allFailed)}` : '★ 살아남았다'}`)
  } catch (e) {
    rep.mutants.push({ id: m.id, what: m.what, error: String(e.message ?? e) })
    console.error(`  ! ${e.message ?? e}`)
  } finally {
    restore()
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
console.log(`\n보고서 → ${OUT}`)
