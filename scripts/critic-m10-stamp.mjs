/* ============================================================================
 * critic-m10-stamp — **모든 M10 산출물에 박히는 도장**(라이브 하네스 넷의 공용부).
 *
 * ★왜 이 파일이 생겼나(R28h R7 · 실제 오염).
 *
 * R6 보고서의 간판 수치는 「`readonly`·워크트리 안 = 홉2 8/33(24%)」였다. 확인 크리틱 R2가
 * 그 33표본을 **어느 exe가 만들었나**로 쪼개 보니 17개가 그 라운드의 봉투 수정 세 개를
 * **문자열로 하나도 안 가진 바이너리**에서 나왔고(`grep -a -c` = 0), 갈라 보면
 * 6/17(35%) vs 1/16(6%)로 **방향이 반대**였다. 결정(정식 vs beta)이 그 평균 위에 서 있었다.
 *
 * 그 오염이 가능했던 뿌리는 하나다 — **산출물이 자기가 어느 코드에서 나왔는지 안 적었다.**
 * 유일한 문면 증거였던 `bEcho`는 정확히 300자에서 잘렸고, 그 라운드의 수정 세 개는 전부
 * 300자 뒤에 있었다. 즉 코퍼스만으로는 **영원히** 못 가른다.
 *
 * 그래서 수치를 재기 **전에** 도장을 박는다. 이 모듈이 남기는 칸:
 *
 *   exe   — 절대경로 · **sha256** · 크기 · mtime
 *   문면  — 앱이 스스로 조립한 봉투/안내 원문의 **sha256과 바이트 길이**
 *           (원문 자체는 `engine:debug`의 `talk.fingerprint`에 있다 → 재계산 가능)
 *   코드  — git HEAD · 브랜치 · `talk.rs`가 미커밋인가
 *   주행  — UTC 시각 · 호스트 · 작업 폴더(git 워크트리 안인가) · 권한 하한
 *
 * 그리고 **선점검**이 있다: 아래 `EXPECT`와 다른 문면이면 하네스는 표본을 하나도 만들지
 * 않고 멎는다. 도장만 있고 검사가 없으면 다음 사람이 같은 오염을 또 만든다 — 오염된
 * 표본은 「나중에 걸러내면 된다」가 아니라 **이미 쓴 실계정 할당량**이다.
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
export const sha256s = (s) => sha256(Buffer.from(String(s), 'utf8'))
/** 표에 싣는 짧은 꼴 — 12자. 대조는 전문으로, 눈으로 보는 것은 이쪽. */
export const short = (h) => (typeof h === 'string' ? h.slice(0, 12) : null)

/**
 * ★**기대 문면**(이 라운드가 출하한 값).
 *
 * `src-tauri/src/engine/talk.rs`의 문면을 한 글자라도 바꾸면 여기 해시도 같이 바뀌어야
 * 한다. 그 강제가 이 상수의 존재 이유다 — 문면을 고치고 하네스를 안 고치면 첫 주행에서
 * 멎는다(그리고 그 자리에서 새 값이 콘솔에 찍힌다: `--pin-print`).
 *
 * 값은 `node scripts/critic-m10-stamp.mjs --print --exe=<exe>` 로 뜬다.
 */
export const EXPECT = {
  // R28h R7 출하 문면(봉투 자체는 cade775 이후 **한 글자도 안 바뀌었다** — 이 라운드가
  // 더한 것은 도장뿐이다). UTF-8 바이트: 12198 / 11215 / 12364 / 1454 / 107 / 77.
  'envelope.plan': 'e8159c094511d0ff64ecaad6c8b5845ba838b981dfe397ea7b7deedb329ebf4d',
  'envelope.normal': '22562cabf0d3c72b6da8bed45df96cbac7780804c17adb1f50886d92e23b9b1e',
  'envelope.planSpoof': 'a16f59942f578cb84d66452d0fa7127eed255dc14dd87ef54f990d44d90154b7',
  guide: '960e226ee335ce8d7753b9466898bb5f7f3f53eb5ced7a145ad99136114c2f04',
  refusalReply: '297efb83336843275eb5389671486b1f4489169ad675d79caa4ed54f1cb3c169',
  declineReply: '8a570cd85e8a1ec54c39ecee63e05fccbffadd47180950aec7e4217fb29f001d'
}

/**
 * ★**골격 해시** — 봉투에서 본문 한 줄(`│ …`)만 지운 나머지의 sha256.
 *
 * 진짜 봉투는 표본마다 본문 한 줄만 다르다(데이터 블록은 규약상 언제나 3줄이고 본문은
 * 정확히 한 줄 — `talk.rs`의 위생이 그것을 보증한다). 그 한 줄을 지우면 남는 것이
 * **문면 그 자체**다. 그래서 라이브 표본이 실제로 받은 봉투의 골격이 이 표의 한 칸과
 * 같으면, 「출하 문면에서 나왔다」는 주장이 아니라 **와이어의 사실**이 된다.
 *
 * 그리고 **어느 칸과 같은가**가 두 번째 증거다: 권한 하한 `readonly`는 `envelope.plan`을,
 * `ask`는 `envelope.normal`을 낳아야 한다. 다른 칸이 나오면 하한이 안 걸린 것이다.
 */
export const EXPECT_SKEL = {
  'envelope.plan': 'b6c9b9f553202d92875bb9d7bd7e291df8028f219709e32e6c28d0aed768c261',
  'envelope.normal': '3d09041667fa953c8905d23a4db2076916c34ece9f80c600f8f7947824befe5f',
  'envelope.planSpoof': '05f844e0012ccbfe0a8ec83d30c277a30fc0d4414ea9eb67e0fca196671aec3a'
}
/** 봉투에서 **본문 한 줄만** 지운 골격. */
export const envSkeleton = (t) => String(t).replace(/^│ .*$/m, '│ (body)')
/** 이 골격 해시가 출하 문면의 어느 판본인가 — 아니면 `null`(그 표본은 표에서 빼야 한다). */
export const variantOfSkeleton = (skel) => Object.entries(EXPECT_SKEL).find(([, v]) => v === skel)?.[0] ?? null
/** 권한 하한이 낳아야 하는 봉투 판본. */
export const variantForPolicy = (policy) => (String(policy) === 'ask' ? 'envelope.normal' : 'envelope.plan')

/** exe 한 자루의 신원 — 경로·해시·크기·mtime. 해시가 이 도장의 전부다. */
export function exeStamp(exe) {
  const p = path.resolve(exe)
  try {
    const st = fs.statSync(p)
    return {
      path: p,
      sha256: sha256(fs.readFileSync(p)),
      bytes: st.size,
      mtime: new Date(st.mtimeMs).toISOString()
    }
  } catch (e) {
    return { path: p, sha256: null, bytes: null, mtime: null, err: String(e?.message ?? e) }
  }
}

const git = (...a) => {
  const r = spawnSync('git', a, { encoding: 'utf8', cwd: path.resolve(new URL('..', import.meta.url).pathname.slice(1)) })
  return r.status === 0 ? r.stdout.trim() : null
}

/**
 * 코드의 신원. **미커밋 여부까지** 적는 것이 요점이다 — R6의 오염 절반은 「같은 커밋인데
 * 다른 바이너리」였고, 그 반대(같은 바이너리인데 소스가 이미 움직임)도 똑같이 위험하다.
 */
export function gitStamp() {
  return {
    head: git('rev-parse', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    // 이 도장이 지키려는 파일 셋만 본다(남의 미커밋 변경은 이 수치와 무관하다).
    dirty: (git('status', '--porcelain', '--', 'src-tauri/src/engine/talk.rs', 'scripts/poc-talk.mjs', 'scripts/critic-m10-stamp.mjs') || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  }
}

/** 그 폴더가 git 워크트리 **안**인가 — 주장이 아니라 값으로 남긴다(R6의 격차가 이 축이었다). */
export function gitWorktreeOf(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

/**
 * `engine:debug`가 실은 `talk.fingerprint` → 해시 표.
 * 원문은 앱이 주고 **해시는 여기서 뜬다** — 앱이 자기 채점을 하지 않는다.
 */
export function fingerprintHashes(fp) {
  const out = {}
  for (const [k, v] of Object.entries(fp ?? {})) {
    const text = typeof v?.text === 'string' ? v.text : null
    out[k] = { sha256: text === null ? null : sha256s(text), bytes: v?.bytes ?? null }
  }
  return out
}

/**
 * **선점검** — 기대와 다르면 던진다(주행 전에 멎는다).
 * `allowMismatch`면 던지지 않고 사실만 남긴다(`bypassed:true`가 산출물에 박힌다).
 */
export function checkFingerprint(fp, { allowMismatch = false } = {}) {
  const got = fingerprintHashes(fp)
  const mismatch = []
  for (const [k, want] of Object.entries(EXPECT)) {
    const have = got[k]?.sha256 ?? null
    if (have !== want) mismatch.push({ key: k, want: short(want), got: short(have), bytes: got[k]?.bytes ?? null })
  }
  const missing = Object.keys(EXPECT).filter((k) => !(k in got))
  // 골격도 함께 검사한다 — 라이브 표본의 와이어 대조가 이 표를 쓴다.
  const skeletons = {}
  for (const [k, v] of Object.entries(fp ?? {})) {
    if (k.startsWith('envelope.') && typeof v?.text === 'string') skeletons[k] = sha256s(envSkeleton(v.text))
  }
  for (const [k, want] of Object.entries(EXPECT_SKEL)) {
    if (skeletons[k] !== want) mismatch.push({ key: `${k}#골격`, want: short(want), got: short(skeletons[k] ?? null), bytes: null })
  }
  const res = { ok: mismatch.length === 0 && missing.length === 0, hashes: got, skeletons, mismatch, missing, bypassed: false }
  if (!res.ok) {
    const lines = [
      '★문면 선점검 실패 — 이 exe가 조립하는 문면이 기대와 다르다. **표본을 만들지 않고 멎는다.**',
      ...mismatch.map((m) => `  · ${m.key}: 기대 ${m.want}… · 실제 ${m.got}… (${m.bytes}B)`),
      ...missing.map((k) => `  · ${k}: 이 빌드의 진단에 없다(옛 exe이거나 도장 이전 코드다)`),
      '  고친 문면이 맞다면 scripts/critic-m10-stamp.mjs의 EXPECT를 갱신해라:',
      '    node scripts/critic-m10-stamp.mjs --print --exe=<exe>'
    ]
    if (allowMismatch) {
      res.bypassed = true
      console.error(lines.join('\n') + '\n  (--no-pin — 검사를 건너뛴다. 이 주행의 표본에는 bypassed:true가 박힌다.)')
      return res
    }
    throw new Error(lines.join('\n'))
  }
  return res
}

/**
 * 산출물 머리에 박는 도장 한 벌. `fp`(=`engine:debug`의 `talk.fingerprint`)는 앱이 뜬 뒤에야
 * 나오므로 나중에 [`checkFingerprint`]로 덧붙인다.
 */
export function runStamp(exe, extra = {}) {
  return {
    at: new Date().toISOString(),
    host: os.hostname(),
    exe: exeStamp(exe),
    git: gitStamp(),
    ...extra
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// `--print` — 살아 있는 exe를 띄워 문면 해시를 찍는다(EXPECT 갱신용).
// `--selftest` — 이 모듈 자신의 계약 넷($0 · 앱 무접촉).
// ═════════════════════════════════════════════════════════════════════════════
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.slice(1))
if (isMain && process.argv.includes('--selftest')) {
  let bad = 0
  const t = (id, cond, extra) => {
    if (cond) console.log(`  o ${id}${extra ? ' — ' + extra : ''}`)
    else {
      bad++
      console.error(`  x ${id}${extra ? ' — ' + extra : ''}`)
    }
  }
  // T1 해시는 원문에서 재계산 가능하다(앱이 자기 채점을 안 한다는 성질).
  const fp = { a: { text: 'hello', bytes: 5 } }
  t('T1 원문→해시 재계산', fingerprintHashes(fp).a.sha256 === sha256s('hello'), sha256s('hello').slice(0, 12))
  // T2 기대와 다르면 **던진다**(조용히 넘어가면 도장이 없는 것과 같다).
  let threw = false
  try {
    checkFingerprint({ 'envelope.plan': { text: 'nope', bytes: 4 } })
  } catch {
    threw = true
  }
  t('T2 문면 불일치 = 예외', threw)
  // T3 `--no-pin`은 던지지 않되 **표식을 남긴다**.
  const by = checkFingerprint({ 'envelope.plan': { text: 'nope', bytes: 4 } }, { allowMismatch: true })
  t('T3 우회는 표식을 남긴다', by.bypassed === true && by.ok === false)
  // T4 exe 도장은 실제 바이트의 해시다.
  const tmp = path.join(os.tmpdir(), `m10-stamp-${process.pid}.bin`)
  fs.writeFileSync(tmp, 'abc')
  const st = exeStamp(tmp)
  t('T4 exe 해시=파일 해시', st.sha256 === sha256(Buffer.from('abc')) && st.bytes === 3, st.sha256.slice(0, 12))
  fs.rmSync(tmp, { force: true })
  // T5 git 도장이 HEAD를 실제로 읽는다.
  const g = gitStamp()
  t('T5 git HEAD', /^[0-9a-f]{40}$/.test(g.head || ''), `${g.branch} ${short(g.head)}`)
  console.log(bad === 0 ? 'PASS — 0건' : `FAIL — ${bad}건`)
  process.exit(bad === 0 ? 0 : 1)
}

if (isMain && process.argv.includes('--print')) {
  const { connectMainPage, killTree, sleep, resolveTauriExe } = await import('../bench/lib.mjs')
  const { spawn } = await import('node:child_process')
  const exe = resolveTauriExe((process.argv.find((a) => a.startsWith('--exe=')) ?? '').split('=')[1])
  const port = Number((process.argv.find((a) => a.startsWith('--port=')) ?? '').split('=')[1] || 10749)
  const home = path.join(os.tmpdir(), `m10-stamp-home-${process.pid}`)
  fs.mkdirSync(home, { recursive: true })
  const child = spawn(exe, [], {
    env: { ...process.env, CCG_HOME: home, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  try {
    const cdp = await connectMainPage(port, { timeoutMs: 60_000 })
    for (let i = 0; i < 300; i++) {
      const up = await cdp
        .eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true })
        .catch(() => false)
      if (up) break
      await sleep(100)
    }
    const dbg = JSON.parse(
      await cdp.eval(
        `(async () => JSON.stringify(await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: 'engine:debug', payload: [] })))()`,
        { awaitPromise: true }
      )
    )
    const fp = dbg?.talk?.fingerprint
    if (!fp) throw new Error('이 exe의 engine:debug에 talk.fingerprint가 없다 — 도장 이전 빌드다')
    console.log(JSON.stringify({ exe: exeStamp(exe), git: gitStamp(), hashes: fingerprintHashes(fp) }, null, 2))
    console.log('\n// EXPECT 붙여넣기용:')
    console.log(
      'export const EXPECT = ' +
        JSON.stringify(Object.fromEntries(Object.entries(fingerprintHashes(fp)).map(([k, v]) => [k, v.sha256])), null, 2)
    )
  } finally {
    killTree(child.pid)
  }
  // 앱이 핸들을 놓기 전이면 지워지지 않는다 — 임시 폴더 하나가 남는 것은 실패가 아니다.
  await sleep(800)
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 })
  } catch {}
}
