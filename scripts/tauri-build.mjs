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

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)

/** 개인키 기본 보관 자리. 레포 **밖**이다 — 안에 두면 커밋 사고가 시간문제다. */
const DEFAULT_KEY = join(homedir(), '.tauri', 'agentcodegui3-updater.key')

const argv = process.argv.slice(2)
const unsigned = argv.includes('--unsigned')
const rest = argv.filter((a) => a !== '--unsigned')
const sub = rest[0] === 'bundle' || rest[0] === 'build' ? rest.shift() : 'build'

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

if (unsigned) {
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

const cli = require.resolve('@tauri-apps/cli/tauri.js')
const child = spawn(process.execPath, [cli, sub, ...args], { stdio: 'inherit', env })
child.on('error', (e) => {
  console.error(`[tauri-build] tauri CLI를 띄우지 못했다: ${e.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)))
