#!/usr/bin/env node
/**
 * `npm run tauri:build` · `npm run tauri:bundle`의 래퍼 (★R28j UPDATER 수정 R1).
 *
 * ── 왜 생겼나 ───────────────────────────────────────────────────────────────
 * R28j에서 `src-tauri/tauri.conf.json`에 `plugins.updater.pubkey`와
 * `bundle.createUpdaterArtifacts: true`가 들어갔다. 그 순간부터 tauri CLI는 번들
 * **마지막 단계에서 minisign 서명을 필수로** 돌고, 개인키가 없으면
 *   `A public key has been found, but no private key. Make sure to set `TAURI_SIGNING_PRIVATE_KEY` …`
 * 로 **종료 코드 1**을 낸다 — 설치기 자체는 이미 나온 뒤다(확인 크리틱 R1 §3.1의 실측:
 * 키 없음 → exit 1 · 키 있음 → exit 0 + `*-setup.exe.sig` 436 B).
 *
 * 그 조건을 아무도 안 적어 둔 채 문서는 「`npm run tauri:build`를 써라」라고만 시켰다. 결과:
 *   (a) 그 지시를 따르는 사람·스크립트는 **성공한 빌드를 실패로 읽고**,
 *   (b) 반대로 오류를 무시하고 올리면 `.sig` 없는 릴리스가 나가 `latest.json`을 쓸 수 없고,
 *       그러면 깔린 앱들은 영원히 「최신입니다」만 보는 **조용한 고장**이 된다.
 *
 * ── 그래서 이 래퍼가 하는 일 ────────────────────────────────────────────────
 * ① 개인키를 **찾아서 env로 실어 준다**(`TAURI_SIGNING_PRIVATE_KEY`). 찾는 순서는
 *    이미 설정된 env → `CCG_UPDATER_KEY`(경로) → 기본 경로 `~/.tauri/agentcodegui3-updater.key`.
 *    ★**키 내용은 읽지 않는다** — CLI가 경로도 받으므로 경로만 넘긴다(로그·화면 유출 0).
 * ② 키가 없으면 **cargo를 켜기 전에** 끝낸다. 10분을 태우고 마지막 줄에서 죽는 대신
 *    0초에 무엇을 해야 하는지 말한다. 조용한 성공(=서명 없는 릴리스)은 만들지 않는다.
 * ③ 서명 없이 설치기만 필요한 사람에게는 **명시적인 문**을 준다 —
 *    `npm run tauri:build:unsigned`. `createUpdaterArtifacts:false`를 얹어 업데이터
 *    아티팩트를 아예 안 만들고, 「이 설치기는 릴리스에 올리지 마라」를 찍는다.
 *
 * 개인키는 레포에 없다(있으면 안 된다). 보관 위치와 릴리스 절차는
 * `docs/parity-fix-updater-r1.md` §8 · 공개키만 `tauri.conf.json`에 들어간다.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 개인키 기본 보관 자리. 레포 **밖**이다 — 안에 두면 커밋 사고가 시간문제다. */
const DEFAULT_KEY = join(homedir(), '.tauri', 'agentcodegui3-updater.key')

const argv = process.argv.slice(2)
const unsigned = argv.includes('--unsigned')
const rest = argv.filter((a) => a !== '--unsigned')
const sub = rest[0] === 'bundle' || rest[0] === 'build' || rest[0] === 'stage' ? rest.shift() : 'build'
/** `stage` = 굽지 않고 LSP node 런타임만 준비한다(개발·하네스용). 서명 키를 안 묻는다. */
const stageOnly = sub === 'stage'

/** 서명 키를 어디서 찾았나 — 값이 아니라 **출처**만 돌려준다. */
function findKey() {
  const inEnv = (process.env.TAURI_SIGNING_PRIVATE_KEY ?? '').trim()
  if (inEnv) return { value: process.env.TAURI_SIGNING_PRIVATE_KEY, from: 'TAURI_SIGNING_PRIVATE_KEY(이미 설정됨)' }
  const override = (process.env.CCG_UPDATER_KEY ?? '').trim()
  if (override) {
    if (!existsSync(override)) return { missing: true, tried: override, why: 'CCG_UPDATER_KEY가 가리키는 파일이 없다' }
    return { value: override, from: `CCG_UPDATER_KEY=${override}` }
  }
  if (existsSync(DEFAULT_KEY)) return { value: DEFAULT_KEY, from: DEFAULT_KEY }
  return { missing: true, tried: DEFAULT_KEY, why: '기본 경로에 키가 없다' }
}

const args = [...rest]
const env = { ...process.env }

if (stageOnly) {
  // `stage`는 굽지 않는다 — 서명 키를 물을 이유가 없다(하네스·개발자가 런타임만 받는 문).
  console.log('[tauri-build] stage — LSP node 런타임만 준비한다(빌드 없음 · 서명 없음).')
} else if (unsigned) {
  // 업데이터 아티팩트를 아예 만들지 않는다 = 서명 단계가 돌지 않는다.
  // (`--config`는 JSON 문자열을 그대로 받는다. 셸을 안 거치므로 따옴표 지옥이 없다.)
  args.push('--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } }))
  console.log('[tauri-build] ⚠ 서명 없는 빌드다(--unsigned).')
  console.log('[tauri-build]   `.sig`도 `latest.json`도 안 나온다 — 이 설치기를 릴리스에 올리면')
  console.log('[tauri-build]   깔린 앱들이 영원히 「최신입니다」만 본다. 로컬 확인용으로만 써라.')
} else {
  const key = findKey()
  if (key.missing) {
    console.error('[tauri-build] ✖ 업데이트 서명 개인키를 못 찾았다 — 빌드를 시작하지 않는다.')
    console.error(`[tauri-build]   ${key.why}: ${key.tried}`)
    console.error('[tauri-build]')
    console.error('[tauri-build]   왜 필수인가: tauri.conf.json에 `plugins.updater.pubkey`와')
    console.error('[tauri-build]   `bundle.createUpdaterArtifacts:true`가 있어 tauri CLI가 번들 끝에서')
    console.error('[tauri-build]   설치기를 minisign으로 서명한다. 키가 없으면 그 단계에서 exit 1이고,')
    console.error('[tauri-build]   서명(.sig)이 없으면 `latest.json`을 쓸 수 없어 자동 업데이트가 통째로 멈춘다.')
    console.error('[tauri-build]')
    console.error('[tauri-build]   셋 중 하나를 해라:')
    console.error(`[tauri-build]   1) 키를 그 자리에 둔다        → ${DEFAULT_KEY}`)
    console.error('[tauri-build]   2) 다른 자리면 경로를 준다    → set CCG_UPDATER_KEY=<키 경로>')
    console.error('[tauri-build]      (또는 TAURI_SIGNING_PRIVATE_KEY에 경로/내용을 직접)')
    console.error('[tauri-build]   3) 서명 없이 설치기만 필요하다 → npm run tauri:build:unsigned')
    console.error('[tauri-build]')
    console.error('[tauri-build]   키를 새로 만들려면: npx tauri signer generate -w "%USERPROFILE%\\.tauri\\agentcodegui3-updater.key"')
    console.error('[tauri-build]   ★새 키를 만들면 공개키(.pub)를 tauri.conf.json에 갈아 끼워야 하고,')
    console.error('[tauri-build]    그 순간 **옛 키로 서명된 설치본을 깔고 있는 사용자**는 업데이트가 끊긴다.')
    process.exit(1)
  }
  env.TAURI_SIGNING_PRIVATE_KEY = key.value
  // 비밀번호 env가 **없으면** CLI가 대화형으로 물어보고 그 자리에서 멈춘다(스크립트는 영원히 대기).
  // 빈 문자열이라도 넣어 두면 그 프롬프트가 안 뜬다. 암호를 건 키라면 호출자가 직접 채운다.
  if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
  console.log(`[tauri-build] 서명 키: ${key.from}`)
}

// ── ★LSPDIST R2 — LSP용 Node 런타임을 **판 고정 + sha256 검증**으로 스테이징한다 ─────
//
// 왜 여기인가: `bundle.resources`가 `src-tauri/lsp-runtime/node.exe`를 가리키는데, 그 파일은
// 레포에 없다(93MB짜리 바이너리를 커밋할 수는 없다). 그래서 **설치기를 굽기 직전에** 만든다.
//
// 왜 「빌더 PC의 node.exe 복사」가 아닌가(R1이 이걸 이유로 미뤘다): 그러면 설치기가 **빌드한
// 사람의 node 판**에 따라 달라진다. 여기서는 판과 해시를 레포에 박고 공식 dist에서만 받는다 —
// 누가 어디서 구워도 같은 바이트가 실린다.
//
// 규약은 서명 키와 같다: **일찍, 사유를 말하고 실패한다.** 해시가 어긋나거나 못 받으면
// cargo를 켜기 전에 끝낸다. 10분을 태우고 마지막 줄에서 죽거나, 더 나쁘게는 **검증 안 된
// 바이너리를 사용자 PC에 싣는** 일이 없어야 한다.
const NODE_PIN = {
  version: 'v24.20.0', // LTS(Krypton). tsls는 node>=20, pyright는 그 이하도 되지만 하나로 맞춘다
  // https://nodejs.org/dist/v24.20.0/SHASUMS256.txt 의 `win-x64/node.exe` 줄
  sha256: '5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5',
  bytes: 93381448
}
/// `crates/ccg-lsp/src/launch.rs::STAGED_RUNTIME_DIR`와 **같은 이름**이어야 한다 —
/// 개발 실행(③ 칸)이 레포 안의 이 파일을 그대로 물기 때문이다.
const STAGE_DIR = join(REPO, 'src-tauri', 'lsp-runtime')
const STAGE_EXE = join(STAGE_DIR, 'node.exe')
const STAGE_PIN = join(STAGE_DIR, 'node.exe.pin.json')

function sha256File(p) {
  return new Promise((res, rej) => {
    const h = createHash('sha256')
    createReadStream(p).on('error', rej).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex')))
  })
}

/** curl(Win10+ 기본 탑재) → 없으면 PowerShell. `install.rs`와 같은 순서·같은 이유. */
function download(url, dest) {
  const sys32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'curl.exe')
  if (existsSync(sys32)) {
    const r = spawnSync(sys32, ['-sSL', '--fail', '-A', 'AgentCodeGUI', '-o', dest, url], { stdio: 'inherit' })
    if (r.status === 0) return
    throw new Error(`curl 종료 코드 ${r.status}`)
  }
  const ps = `Invoke-WebRequest -UseBasicParsing -Uri '${url}' -OutFile '${dest}' -UserAgent 'AgentCodeGUI'`
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`PowerShell 종료 코드 ${r.status}`)
}

async function stageNodeRuntime() {
  const url = `https://nodejs.org/dist/${NODE_PIN.version}/win-x64/node.exe`
  // ① 이미 있고 핀이 맞으면 그대로 쓴다. **해시는 매번 다시 센다** — 캐시가 조용히 상하는
  //    경우(백신 수정·부분 복사·다른 판 덮어쓰기)를 파일 크기로만 걸러선 안 된다.
  if (existsSync(STAGE_EXE)) {
    const sz = statSync(STAGE_EXE).size
    const got = await sha256File(STAGE_EXE)
    if (got === NODE_PIN.sha256 && sz === NODE_PIN.bytes) {
      console.log(`[tauri-build] LSP node 런타임: 캐시 적중 ${NODE_PIN.version} (${(sz / 1048576).toFixed(2)}MB · sha256 확인)`)
      return
    }
    console.log(`[tauri-build] LSP node 런타임: 캐시가 핀과 다르다 — 다시 받는다(있던 sha256=${got.slice(0, 16)}…)`)
    rmSync(STAGE_EXE, { force: true })
  }
  // ② 받는다 → 임시 파일에 → 해시 검증 → **검증한 뒤에만** 제자리로 옮긴다.
  //    (검증 전 파일이 목적지에 있으면, 다음 빌드가 그 반쯤 받은 것을 캐시로 착각한다.)
  mkdirSync(STAGE_DIR, { recursive: true })
  const tmp = `${STAGE_EXE}.part`
  rmSync(tmp, { force: true })
  console.log(`[tauri-build] LSP node 런타임 내려받는 중: ${url}`)
  try {
    download(url, tmp)
  } catch (e) {
    rmSync(tmp, { force: true })
    fatalRuntime(`내려받기 실패 — ${e.message}`, url)
  }
  const got = await sha256File(tmp)
  const sz = statSync(tmp).size
  if (got !== NODE_PIN.sha256 || sz !== NODE_PIN.bytes) {
    rmSync(tmp, { force: true })
    fatalRuntime(`sha256/크기 불일치 — 받은 것 ${got} (${sz} B) · 핀 ${NODE_PIN.sha256} (${NODE_PIN.bytes} B)`, url)
  }
  renameSync(tmp, STAGE_EXE)
  writeFileSync(STAGE_PIN, JSON.stringify({ ...NODE_PIN, url, stagedAt: new Date().toISOString() }, null, 2) + '\n')
  console.log(`[tauri-build] LSP node 런타임 준비 완료: ${NODE_PIN.version} (${(sz / 1048576).toFixed(2)}MB · sha256 검증됨)`)
}

function fatalRuntime(why, url) {
  console.error('[tauri-build] ✖ LSP용 Node 런타임을 준비하지 못했다 — 빌드를 시작하지 않는다.')
  console.error(`[tauri-build]   ${why}`)
  console.error('[tauri-build]')
  console.error('[tauri-build]   왜 필수인가: TypeScript·Python 언어 서버는 순수 JS라 node가 있어야 뜬다.')
  console.error('[tauri-build]   3.0은 그 런타임을 설치기에 실어 사용자 PATH에 안 기댄다(확인 크리틱 R1 §1.2:')
  console.error('[tauri-build]   PATH에 node가 없으면 두 언어 × 두 cwd 네 팔이 전부 죽었다).')
  console.error('[tauri-build]   이 파일이 없으면 설치기는 그 상태로 나간다 — 그래서 여기서 멈춘다.')
  console.error('[tauri-build]')
  console.error(`[tauri-build]   주소: ${url}`)
  console.error(`[tauri-build]   자리: ${STAGE_EXE}`)
  console.error('[tauri-build]   오프라인이라면 위 주소의 파일을 직접 그 자리에 두면 된다(해시를 다시 검증한다).')
  console.error(`[tauri-build]   핀을 올리려면 scripts/tauri-build.mjs의 NODE_PIN과 nodejs.org의 SHASUMS256.txt를 같이 고쳐라.`)
  process.exit(1)
}

await stageNodeRuntime()
if (stageOnly) {
  console.log('[tauri-build] 스테이징만 하고 끝낸다(stage) — 굽지 않는다.')
  process.exit(0)
}

const cli = require.resolve('@tauri-apps/cli/tauri.js')
const child = spawn(process.execPath, [cli, sub, ...args], { stdio: 'inherit', env })
child.on('error', (e) => {
  console.error(`[tauri-build] tauri CLI를 띄우지 못했다: ${e.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))
