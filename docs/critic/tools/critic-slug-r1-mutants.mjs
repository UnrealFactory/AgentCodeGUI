#!/usr/bin/env node
/* ============================================================================
 * critic-slug-r1-mutants — 빌더의 M1~M3 재현 + 크리틱의 회피 E1~E3.
 *
 * **격리 사본에서만 돈다**(`--repo=`). 제품 워크트리는 건드리지 않는다.
 * 각 돌연변이마다 세 벌을 돌린다:
 *   · 엔진 못 4건   `ccg-engine --lib slug_r1_account_dir_tests`
 *   · 셸 못 7건     `agentcodegui engine::claude_account`
 *   · 크리틱 공격 8건 `ccg-engine --test critic_slug_r1_attack`
 *
 * 회피(E)는 「빌더의 못이 초록인 채로 결함을 되살릴 수 있는가」를 묻는다.
 * 초록으로 살아남으면 그 자리는 **못이 안 박힌 자리**다.
 *
 * 실행: node docs/critic/tools/critic-slug-r1-mutants.mjs --repo=<격리트리> [--only=M1,E2]
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const argOf = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? '').split('=')[1] || d
const REPO = path.resolve(argOf('repo', ''))
const ONLY = (argOf('only', '') || '').split(',').filter(Boolean)
const TARGET = argOf('target', 'C:/Code/.cargo-slugcrit')
const HERE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const OUT = path.join(HERE, 'evidence', `slug-r1-mutants${argOf('out', '')}.json`)
if (!REPO) throw new Error('--repo= 가 필요하다(격리 사본)')

const RT = path.join(REPO, 'crates', 'ccg-engine', 'src', 'runtime.rs')
const CA = path.join(REPO, 'src-tauri', 'src', 'engine', 'claude_account.rs')
const HUB = path.join(REPO, 'src-tauri', 'src', 'engine', 'hub.rs')

/** 옛 엔진의 조립 + 접두 스캔 — 돌연변이가 되살리는 코드 조각. */
const OLD_BODY = `        let slug = email.replace('@', "_").replace('+', "-");
        let root = self.home.join("accounts");
        if let Ok(rd) = std::fs::read_dir(&root) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n == slug || n.starts_with(&format!("{slug}-")) {
                    return Ok(root.join(n));
                }
            }
        }
        return Ok(root.join(slug));`

/** 셸 리졸버가 옛 규칙으로 폴더를 고르는 판(`ccg-auth`를 안 부른다). */
const OLD_RESOLVER = `pub fn resolver() -> ccg_engine::runtime::AccountResolver {
    Arc::new(|email: &str| {
        let slug = email.replace('@', "_").replace('+', "-");
        let root = ccg_store::app_home().join("accounts");
        if let Ok(rd) = std::fs::read_dir(&root) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n == slug || n.starts_with(&format!("{slug}-")) {
                    return Ok(root.join(n));
                }
            }
        }
        Ok(root.join(slug))
    })
}`

const REAL_RESOLVER = `pub fn resolver() -> ccg_engine::runtime::AccountResolver {
    Arc::new(|email: &str| ccg_auth::claude::account_run_dir(email).map_err(|e| why(&e)))
}`

const MUTANTS = [
  {
    id: 'M1',
    what: '엔진 `account_dir`이 리졸버를 무시하고 옛 조립+스캔으로 되돌아간다',
    edits: [
      {
        file: RT,
        find: `        match &self.account_resolver {
            Some(r) => r(email),
            None => Ok(self.unresolved_account_dir(email)),
        }`,
        to: OLD_BODY
      }
    ]
  },
  {
    id: 'M2',
    what: '셸 리졸버 안에서 옛 조립+스캔이 부활한다(`ccg-auth`를 안 부른다)',
    edits: [{ file: CA, find: REAL_RESOLVER, to: OLD_RESOLVER }]
  },
  {
    id: 'M3',
    what: '`hub.rs`의 `.with_account_resolver(…)` 한 줄이 사라진다(배선만 제거)',
    edits: [
      {
        file: HUB,
        find: '                .with_account_resolver(super::claude_account::resolver())\n',
        to: ''
      }
    ]
  },
  // ── 크리틱의 회피 ────────────────────────────────────────────────────────
  {
    id: 'E1',
    what: '리졸버가 **실패했을 때만** 옛 스캔으로 슬그머니 되돌아간다(사유를 삼킨다)',
    edits: [
      {
        file: CA,
        find: REAL_RESOLVER,
        to: `pub fn resolver() -> ccg_engine::runtime::AccountResolver {
    Arc::new(|email: &str| {
        if let Ok(d) = ccg_auth::claude::account_run_dir(email) {
            return Ok(d);
        }
        // 회피: 실패를 사유로 올리지 않고 옛 추측으로 때운다.
        let slug = email.replace('@', "_").replace('+', "-");
        let root = ccg_store::app_home().join("accounts");
        if let Ok(rd) = std::fs::read_dir(&root) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n == slug || n.starts_with(&format!("{slug}-")) {
                    return Ok(root.join(n));
                }
            }
        }
        Ok(root.join(slug))
    })
}`
      }
    ]
  },
  {
    id: 'E2',
    what: '리졸버가 이메일별로 **한 번만** 진짜를 부르고 그 뒤로는 캐시를 낸다(물질화가 사라진다)',
    edits: [
      {
        file: CA,
        find: REAL_RESOLVER,
        to: `pub fn resolver() -> ccg_engine::runtime::AccountResolver {
    // 회피: 경로는 언제나 맞다(이메일→폴더는 결정적) — 사라지는 것은 **부작용**이다.
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
    what: '`why()`가 `NotRegistered` 말고는 전부 같은 뭉뚱그린 한 줄을 낸다(사유가 사라진다)',
    edits: [
      {
        file: CA,
        find: `        E::Undecryptable(_) => {
            "저장된 자격증명을 풀지 못했어요 — 다른 사용자·다른 PC의 홈을 옮겨 온 경우예요(다시 로그인해 주세요)".into()
        }
        E::CorruptSnapshot(_) => "저장된 계정 정보가 깨졌어요(다시 로그인해 주세요)".into(),
        E::TokenCollision(other) => {
            format!("같은 토큰이 {other} 계정으로도 저장돼 있어요(한쪽을 로그아웃해 주세요)")
        }
        E::Io(m) => format!("계정 폴더를 준비하지 못했어요 ({m})"),`,
        to: `        E::Undecryptable(_) => "문제가 생겼어요".into(),
        E::CorruptSnapshot(_) => "문제가 생겼어요".into(),
        E::TokenCollision(_) => "문제가 생겼어요".into(),
        E::Io(_) => "문제가 생겼어요".into(),`
      }
    ]
  }
]

// ── 주행 ────────────────────────────────────────────────────────────────────
const env = { ...process.env, CARGO_TARGET_DIR: TARGET }
function cargo(argv, label) {
  const r = spawnSync('cargo', argv, { cwd: REPO, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const m = out.match(/test result: (ok|FAILED)\. (\d+) passed; (\d+) failed/)
  const compiled = !/error(\[E\d+\])?:/.test(out) || !!m
  return {
    label,
    compiled,
    pass: m ? Number(m[2]) : 0,
    fail: m ? Number(m[3]) : null,
    red: m ? Number(m[3]) : compiled ? null : 'compile-error',
    firstError: compiled ? null : (out.match(/error(\[E\d+\])?: .*/) ?? [null])[0]
  }
}

const SUITES = [
  ['engine', ['test', '-p', 'ccg-engine', '--lib', 'slug_r1_account_dir_tests', '--', '--test-threads=1']],
  ['shell', ['test', '-p', 'agentcodegui', 'engine::claude_account', '--', '--test-threads=1']],
  ['attack', ['test', '-p', 'ccg-engine', '--test', 'critic_slug_r1_attack', '--', '--test-threads=1']]
]

const rep = { at: new Date().toISOString(), repo: REPO, baseline: null, mutants: [] }

function runSuites(tag) {
  const out = {}
  for (const [name, argv] of SUITES) {
    out[name] = cargo(argv, name)
    console.log(`    ${tag}/${name}: ${JSON.stringify(out[name])}`)
  }
  return out
}

const backup = new Map()
const CRLF = new RegExp(String.fromCharCode(13) + String.fromCharCode(10), 'g')
function apply(m) {
  for (const e of m.edits) {
    const raw = fs.readFileSync(e.file, 'utf8')
    // 되돌릴 때는 **원본 바이트**로 되돌린다(줄끝까지 그대로).
    if (!backup.has(e.file)) backup.set(e.file, raw)
    const src = raw.replace(CRLF, '\n')
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
    rep.mutants.push({ id: m.id, what: m.what, suites: res, killedBy, survived: killedBy.length === 0 })
    console.log(`  → ${killedBy.length ? `죽었다(${killedBy.join(',')})` : '★ 살아남았다 — 못이 안 박힌 자리'}`)
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
