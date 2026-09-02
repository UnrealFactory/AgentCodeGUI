#!/usr/bin/env node
// 3.0 릴리스 — `npm run tauri:build` 산출물(NSIS exe + .sig)로 `latest.json`을 만들고,
// GitHub 릴리스(초안 → 자산 업로드 → 공개)까지 한 번에. 2.6.2의 `npm run release`
// (electron-builder --publish)에 해당하는 3.0의 한 명령.
//
//   node scripts/release-3.mjs [--notes <md>] [--extra <file>...] [--keep-draft] [--dry-run]
//
//   · 버전은 src-tauri/tauri.conf.json의 `version`이다(태그 `v<version>`).
//   · 태그는 미리 만들어 push해 둔다(이 스크립트는 태그를 만들지 않는다 — 릴리스 커밋이
//     main에 있어야 한다는 관례를 스크립트가 어기지 않게).
//   · `--extra`: 같이 실을 파일(예: 2.6.2 부랑자를 2.6.3으로 올려 보내는 브리지
//     `AgentCodeGUI-Setup-2.6.3.exe`·`.blockmap`·`latest.yml`). electron-updater는 latest
//     릴리스의 태그 경로에서 파일을 받으므로 세 파일이 이 릴리스 밑에 있어야 한다.
//
// ★ 왜 「초안 → 업로드 → 공개」인가: 공개 뒤에 올리면 그 사이 확인한 앱들이 404를
//   본다(3.0은 latest.json, 2.6.2는 latest.yml). 초안은 `releases/latest`에 안 잡힌다.
// ★ 프리릴리스 금지: 앱의 주소가 `…/releases/latest/download/latest.json`인데 GitHub의
//   latest는 프리릴리스를 제외한다(docs/parity-fix-updater-r1.md §8.2-4).
// ★ 서명(.sig)이 없으면 중단한다 — .sig 없는 latest.json은 플러그인이 거절하고, 깔린
//   앱들은 영원히 「최신입니다」만 본다.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GH_REPO = 'UnrealFactory/AgentCodeGUI'

const argv = process.argv.slice(2)
const flag = (k) => argv.includes(k)
const opt = (k) => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : undefined
}
const extras = []
for (let i = 0; i < argv.length; i++) if (argv[i] === '--extra' && argv[i + 1]) extras.push(resolve(argv[++i]))
const dry = flag('--dry-run')
const keepDraft = flag('--keep-draft')

const conf = JSON.parse(readFileSync(join(REPO_DIR, 'src-tauri', 'tauri.conf.json'), 'utf8'))
const version = conf.version
const product = conf.productName // AgentCodeGUI3
const tag = `v${version}`
if (/-/.test(version)) {
  console.error(`[release-3] 프리릴리스 꼬리가 붙은 버전(${version})은 올리지 않는다 — latest에서 제외돼 업데이터가 못 본다.`)
  process.exit(1)
}

const nsisDir = join(REPO_DIR, 'target', 'release', 'bundle', 'nsis')
const exeName = `${product}_${version}_x64-setup.exe`
const exe = join(nsisDir, exeName)
const sig = `${exe}.sig`
for (const p of [exe, sig]) {
  if (!existsSync(p)) {
    console.error(`[release-3] 없음: ${p}\n  먼저 npm run tauri:build (서명 키 필요 — .sig가 같이 나온다)`)
    process.exit(1)
  }
}
const sigText = readFileSync(sig, 'utf8').trim()
if (sigText.length < 100) {
  console.error('[release-3] .sig 내용이 너무 짧다 — 서명이 제대로 안 됐다')
  process.exit(1)
}

// latest.json — tauri-plugin-updater의 정적 형식(docs/parity-fix-updater-r1.md §8.2-3).
const notesFile = opt('--notes')
const notesText = notesFile ? readFileSync(resolve(notesFile), 'utf8') : `AgentCodeGUI3 ${version}`
const latest = {
  version,
  notes: notesText.split('\n').slice(0, 3).join(' ').slice(0, 300), // 카드용 한 줄 요약 — 본문은 릴리스 페이지
  pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  platforms: {
    'windows-x86_64': {
      signature: sigText,
      url: `https://github.com/${GH_REPO}/releases/download/${tag}/${exeName}`
    }
  }
}
const latestPath = join(nsisDir, 'latest.json')
writeFileSync(latestPath, JSON.stringify(latest, null, 2) + '\n')

const mb = (p) => (statSync(p).size / 1048576).toFixed(1) + 'MB'
console.log(`[release-3] ${tag} · ${exeName} ${mb(exe)} · .sig ${statSync(sig).size}B · latest.json 작성`)
for (const e of extras) {
  if (!existsSync(e)) {
    console.error(`[release-3] --extra 파일 없음: ${e}`)
    process.exit(1)
  }
  console.log(`[release-3]   + extra ${e} ${mb(e)}`)
}

const gh = (args, quiet = false) => {
  if (dry) {
    console.log('[dry-run] gh', args.join(' '))
    return ''
  }
  return execFileSync('gh', args, { encoding: 'utf8', stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
}

// 태그가 원격에 있어야 한다(릴리스 커밋 = main의 태그 커밋).
try {
  execFileSync('git', ['ls-remote', '--exit-code', '--tags', 'origin', tag], { cwd: REPO_DIR, stdio: 'ignore' })
} catch {
  console.error(`[release-3] 원격에 태그 ${tag}가 없다 — git tag -a ${tag} … && git push origin main ${tag} 먼저`)
  if (!dry) process.exit(1)
}

// 이미 있으면(재실행) 자산만 덮어쓴다.
let exists = false
try {
  gh(['release', 'view', tag, '--repo', GH_REPO, '--json', 'tagName'], true)
  exists = true
} catch {
  /* 없음 → 새로 만든다 */
}
if (!exists) {
  const args = ['release', 'create', tag, '--repo', GH_REPO, '--draft', '--title', `${product} ${version}`]
  if (notesFile) args.push('--notes-file', resolve(notesFile))
  else args.push('--notes', notesText)
  gh(args)
}
gh(['release', 'upload', tag, '--repo', GH_REPO, '--clobber', exe, sig, latestPath, ...extras])
if (!keepDraft) gh(['release', 'edit', tag, '--repo', GH_REPO, '--draft=false', '--latest'])

if (!dry) {
  const view = JSON.parse(gh(['release', 'view', tag, '--repo', GH_REPO, '--json', 'isDraft,isPrerelease,assets'], true))
  console.log(
    `[release-3] ${tag} draft=${view.isDraft} prerelease=${view.isPrerelease} assets: ${view.assets.map((a) => a.name).join(', ')}`
  )
  if (!keepDraft) {
    const need = [exeName, `${exeName}.sig`, 'latest.json']
    const have = new Set(view.assets.map((a) => a.name))
    const missing = need.filter((n) => !have.has(n))
    if (view.isDraft || view.isPrerelease || missing.length) {
      console.error(`[release-3] ✗ 공개 상태가 아니거나 자산이 빠졌다: ${missing.join(', ')}`)
      process.exit(1)
    }
    console.log(`[release-3] ✓ 공개됨 — https://github.com/${GH_REPO}/releases/latest/download/latest.json`)
  }
}
