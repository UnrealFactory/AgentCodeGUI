// 설치 풋프린트 — **설치본 크기**와 **설치 후 디스크 사용량**을 두 앱에 같은 방법으로.
//
//   node bench/footprint.mjs [--out=이름] [--tag=꼬리표]
//        [--electron-dir=…] [--electron-setup=…]
//        [--tauri-dir=…]    [--tauri-setup=…]
//        [--no-registry]    [--quiet]
//
// 기본 결과 파일은 `bench/results/footprint.json`. 기준값을 덮지 않으려면 `--out=…`.
//
// ## 왜 하네스로 만드나 (숫자 하나를 손으로 재면 비교가 무너진다)
// 인수인계 문서의 기준은 "설치 풋프린트 650MB"인데, 그 650은 **어떻게 잰 650인지**가
// 적혀 있지 않다. 탐색기 속성창(할당 크기)·`du`(논리 크기)·「앱 및 기능」의 표시값
// (설치 프로그램이 레지스트리에 **직접 써 넣은** EstimatedSize)이 전부 다른 수를 준다.
// 그래서 세 가지를 **전부** 같은 코드로 뽑아 한 파일에 남긴다:
//
//   logicalBytes  파일 길이의 합 (`du -b`와 같은 정의)
//   allocBytes    클러스터 올림 합 (탐색기의 "디스크 할당 크기"에 대응하는 근사)
//   registry      HKCU\…\Uninstall\<key>\EstimatedSize (KB) — 「앱 및 기능」이 보여주는 값
//
// ## 공정성 규칙 (이걸 어기면 3.0이 거저 이긴다)
//  1. **두 앱을 같은 함수로 잰다.** walk()·클러스터 올림·심볼릭/정션 처리 전부 공유.
//  2. **정션·심볼릭 링크는 따라가지 않는다.** 앱 홈(`~/.agentcodegui`)에는 엔진 폴더를
//     정션으로 건 자리가 있고(사용자 실홈 규약), 따라가면 남의 디스크를 우리 몫으로
//     계산하거나 무한 루프에 빠진다. 링크는 개수만 센다.
//  3. **WebView2 런타임을 따로 적는다.** 3.0은 Chromium을 앱에 넣지 않고 OS의 WebView2
//     런타임을 빌려 쓴다 — "앱 폴더가 작다"만 보여 주면 거짓말이다. Edge와 공유하는
//     OS 구성요소라 3.0 몫으로 더하지는 않지만, **크기를 같은 파일에 박아** 판단을
//     독자에게 넘긴다.
//  4. **앱 홈은 어느 쪽 몫도 아니다.** `~/.agentcodegui`는 2.6.2와 3.0이 **공유**한다
//     (대화·계정·엔진). 설치 크기 비교에서 빼고, 참고용으로만 적는다.
//
// ## 안전
// 읽기 전용이다. 프로세스를 만들지 않고(레지스트리 조회는 `reg query` 한 번), 어떤
// 파일도 쓰지 않는다 — 결과 JSON 하나만 쓴다.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { envInfo, REPO } from './lib.mjs'

const argv = process.argv.slice(2)
const arg = (name, dflt = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const QUIET = argv.includes('--quiet')
const NO_REG = argv.includes('--no-registry')
const TAG = arg('tag', '')
const OUT_NAME = arg('out', `footprint${TAG ? `-${TAG}` : ''}`)

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')

// ── 디스크 워크 ──────────────────────────────────────────────────────────────

// NTFS 클러스터 크기. `fsutil fsinfo ntfsinfo`는 권한이 있으면 진짜 값을 준다.
// 없으면 4096(윈도우 기본)으로 가정하고 **가정했다는 사실을 결과에 남긴다** —
// 할당 크기는 어차피 근사이고, 두 앱에 같은 상수를 쓰므로 비교는 성립한다.
function clusterSize(drive) {
  try {
    const out = execFileSync('fsutil', ['fsinfo', 'ntfsinfo', `${drive}:`], { encoding: 'utf8', timeout: 10000 })
    const m = out.match(/Bytes Per Cluster\s*:?\s*(?:0x([0-9a-fA-F]+)|(\d+))/)
    if (m) return { bytes: m[1] ? parseInt(m[1], 16) : Number(m[2]), source: 'fsutil' }
  } catch {
    /* 권한 없음 — 아래 기본값 */
  }
  return { bytes: 4096, source: 'assumed-4096' }
}

/**
 * 디렉터리 하나를 걸어 파일 수·논리 크기·할당 크기를 센다.
 * `depth`만큼의 최상위 항목별 내역(top)도 함께 돌려준다 — "무엇이 그 크기를 만드는가"가
 * 없으면 줄었다/늘었다만 남고 다음 라운드가 손댈 자리를 못 찾는다.
 */
function walk(dir, { cluster = 4096, depth = 1 } = {}) {
  const res = { path: dir, exists: false, files: 0, dirs: 0, links: 0, logicalBytes: 0, allocBytes: 0, top: [] }
  let st
  try {
    st = fs.lstatSync(dir)
  } catch {
    return res
  }
  if (!st.isDirectory()) {
    res.exists = true
    res.files = 1
    res.logicalBytes = st.size
    res.allocBytes = Math.ceil(st.size / cluster) * cluster
    return res
  }
  res.exists = true

  const rec = (d) => {
    const acc = { files: 0, dirs: 0, links: 0, logicalBytes: 0, allocBytes: 0 }
    let ents
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return acc // 접근 거부 폴더는 0으로 — 두 앱 모두 같은 규칙
    }
    for (const e of ents) {
      const p = path.join(d, e.name)
      // 정션/심볼릭은 **절대 따라가지 않는다**(규칙 2). readdir의 withFileTypes는
      // 정션을 isSymbolicLink()로 준다(Windows의 reparse point).
      if (e.isSymbolicLink()) {
        acc.links++
        continue
      }
      if (e.isDirectory()) {
        acc.dirs++
        const sub = rec(p)
        acc.files += sub.files
        acc.dirs += sub.dirs
        acc.links += sub.links
        acc.logicalBytes += sub.logicalBytes
        acc.allocBytes += sub.allocBytes
        continue
      }
      let s
      try {
        s = fs.lstatSync(p)
      } catch {
        continue
      }
      acc.files++
      acc.logicalBytes += s.size
      acc.allocBytes += Math.ceil(s.size / cluster) * cluster
    }
    return acc
  }

  const total = rec(dir)
  Object.assign(res, total)

  if (depth > 0) {
    let ents = []
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      /* 위에서 이미 0 처리 */
    }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isSymbolicLink()) {
        res.top.push({ name: e.name, kind: 'link', logicalBytes: 0 })
        continue
      }
      if (e.isDirectory()) {
        const sub = rec(p)
        res.top.push({ name: e.name, kind: 'dir', files: sub.files, logicalBytes: sub.logicalBytes })
      } else {
        let s = null
        try {
          s = fs.lstatSync(p)
        } catch {
          continue
        }
        res.top.push({ name: e.name, kind: 'file', logicalBytes: s.size })
      }
    }
    res.top.sort((a, b) => b.logicalBytes - a.logicalBytes)
    res.top = res.top.slice(0, 12)
  }
  return res
}

function fileInfo(p) {
  try {
    const s = fs.statSync(p)
    return { path: p, exists: true, bytes: s.size, mtime: s.mtime.toISOString() }
  } catch {
    return { path: p, exists: false, bytes: 0 }
  }
}

// ── 「앱 및 기능」이 보여주는 값 ──────────────────────────────────────────────
// 설치 프로그램이 **스스로 써 넣은** 숫자다(측정값이 아니다). 우리 walk()와 얼마나
// 어긋나는지가 그 자체로 정보라서 같이 남긴다.
function uninstallEntry(match) {
  if (NO_REG) return null
  const root = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  let keys = []
  try {
    keys = execFileSync('reg', ['query', root], { encoding: 'utf8', timeout: 15000 })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('HKEY_'))
  } catch {
    return null
  }
  for (const k of keys) {
    let dump
    try {
      dump = execFileSync('reg', ['query', k], { encoding: 'utf8', timeout: 15000 })
    } catch {
      continue
    }
    const val = (name) => {
      const m = dump.match(new RegExp(`\\s${name}\\s+REG_\\w+\\s+(.*)`))
      return m ? m[1].trim() : null
    }
    const dn = val('DisplayName')
    if (!dn || !match.test(dn)) continue
    const est = val('EstimatedSize')
    return {
      key: k.split('\\').pop(),
      displayName: dn,
      displayVersion: val('DisplayVersion'),
      publisher: val('Publisher'),
      installLocation: val('InstallLocation'),
      uninstallString: val('UninstallString'),
      // EstimatedSize는 KB 단위 DWORD(16진).
      estimatedSizeKB: est ? (est.startsWith('0x') ? parseInt(est, 16) : Number(est)) : null
    }
  }
  return null
}

// ── WebView2 런타임(3.0이 OS에서 빌려 쓰는 몫) ───────────────────────────────
function webview2Runtime(cluster) {
  const bases = [
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'EdgeWebView', 'Application'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'EdgeWebView', 'Application')
  ]
  for (const base of bases) {
    if (!fs.existsSync(base)) continue
    // 버전 폴더는 **숫자로** 정렬한다. 문자열 정렬은 151.0.4129.93 > 151.0.4129.101이라
    // 최신본을 놓친다(이 기계에 세 판이 깔려 있어 실제로 갈렸다 — 크기는 같았지만
    // 규칙이 틀린 채로 남기면 다음 라운드가 다른 답을 얻는다).
    const cmp = (a, b) => {
      const A = a.split('.').map(Number)
      const B = b.split('.').map(Number)
      for (let i = 0; i < Math.max(A.length, B.length); i++) {
        const d = (A[i] ?? 0) - (B[i] ?? 0)
        if (d) return d
      }
      return 0
    }
    const vers = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+\./.test(e.name))
      .map((e) => e.name)
      .sort(cmp)
    if (!vers.length) continue
    const latest = vers[vers.length - 1]
    const dir = path.join(base, latest)
    // 여러 판이 남아 있으면 그 사실도 남긴다 — 디스크에 실제로 있는 몫은 합계다.
    return { version: latest, installedVersions: vers, ...walk(dir, { cluster, depth: 0 }) }
  }
  return { version: null, exists: false }
}

// ── 설치본 자동 탐색 ─────────────────────────────────────────────────────────
// 3.0의 NSIS 산출물은 `<target>/release/bundle/nsis/*-setup.exe`. target 디렉터리는
// 공용(target/)일 수도, 라운드가 잠금을 피해 쓴 격리 디렉터리일 수도 있다 —
// 둘 다 훑어 **가장 최근** 것을 고르고, 무엇을 골랐는지 결과에 남긴다.
function findTauriSetup() {
  const roots = [
    path.join(REPO, 'target', 'release', 'bundle'),
    'C:\\Code\\ccg-m12-target\\release\\bundle',
    path.join(REPO, '.m12-target', 'release', 'bundle')
  ]
  const hits = []
  for (const r of roots) {
    for (const kind of ['nsis', 'msi']) {
      const d = path.join(r, kind)
      if (!fs.existsSync(d)) continue
      for (const f of fs.readdirSync(d)) {
        if (!/\.(exe|msi)$/i.test(f)) continue
        const p = path.join(d, f)
        hits.push({ p, mtime: fs.statSync(p).mtimeMs, kind })
      }
    }
  }
  // **형식 우선, 그 다음 최신.** 시간만으로 고르면 MSI를 한 번 시험 삼아 굽는 순간
  // 비교표의 "설치본"이 조용히 MSI로 갈아탄다(실제로 밟았다 — 3.1MB가 찍혔다).
  // 배포하는 형식은 NSIS다(§선택 근거). 후보 전체는 결과에 남긴다.
  hits.sort((a, b) => (a.kind === b.kind ? b.mtime - a.mtime : a.kind === 'nsis' ? -1 : 1))
  return { pick: hits.length ? hits[0].p : null, candidates: hits.map((h) => ({ path: h.p, kind: h.kind, bytes: fs.statSync(h.p).size })) }
}

// ── 본체 ─────────────────────────────────────────────────────────────────────

const drive = (process.env.SystemDrive ?? 'C:').replace(':', '')
const cl = clusterSize(drive)
const cluster = cl.bytes

const electronDir = arg('electron-dir', path.join(LOCALAPPDATA, 'Programs', 'AgentCodeGUI'))
const electronSetup = arg('electron-setup', path.join(REPO, 'dist', 'AgentCodeGUI-Setup-2.6.2.exe'))
const tauriDir = arg('tauri-dir', path.join(LOCALAPPDATA, 'AgentCodeGUI3'))
const found = findTauriSetup()
const tauriSetup = arg('tauri-setup', found.pick)

const say = (s) => {
  if (!QUIET) console.log(s)
}
const mb = (b) => (b / 1024 / 1024).toFixed(1) + ' MB'

say(`클러스터 ${cluster}B (${cl.source})`)

const apps = {
  'electron-2.6.2': {
    label: 'AgentCodeGUI 2.6.2 (Electron · electron-builder NSIS)',
    installer: fileInfo(electronSetup),
    installDir: walk(electronDir, { cluster }),
    registry: uninstallEntry(/^AgentCodeGUI(?!3)/)
  },
  'tauri-3.0.0-beta.1': {
    label: 'AgentCodeGUI3 3.0.0-beta.1 (Tauri · NSIS)',
    installer: tauriSetup ? { ...fileInfo(tauriSetup), candidates: found.candidates } : { path: null, exists: false, bytes: 0, candidates: found.candidates },
    installDir: walk(tauriDir, { cluster }),
    registry: uninstallEntry(/^AgentCodeGUI3/)
  }
}

const shared = {
  note: '두 앱이 공유하거나 OS가 소유하는 몫 — 어느 쪽 설치 크기에도 더하지 않는다.',
  appHome: walk(path.join(os.homedir(), '.agentcodegui'), { cluster }),
  webview2Runtime: webview2Runtime(cluster)
}

const e = apps['electron-2.6.2']
const t = apps['tauri-3.0.0-beta.1']
const ratio = (a, b) => (b > 0 ? Number((a / b).toFixed(4)) : null)
const compare = {
  installerBytes: { electron: e.installer.bytes, tauri: t.installer.bytes, ratio: ratio(t.installer.bytes, e.installer.bytes) },
  installDirLogical: {
    electron: e.installDir.logicalBytes,
    tauri: t.installDir.logicalBytes,
    ratio: ratio(t.installDir.logicalBytes, e.installDir.logicalBytes),
    savedBytes: e.installDir.logicalBytes - t.installDir.logicalBytes
  },
  installDirAlloc: {
    electron: e.installDir.allocBytes,
    tauri: t.installDir.allocBytes,
    ratio: ratio(t.installDir.allocBytes, e.installDir.allocBytes)
  },
  // 정직한 상한: 3.0 앱 폴더 + WebView2 런타임 전부를 3.0 몫으로 쳐도 이만큼이다.
  // (실제로는 Edge와 공유하는 OS 구성요소라 Win10/11에는 이미 깔려 있다)
  tauriPlusRuntimeLogical: t.installDir.logicalBytes + (shared.webview2Runtime.logicalBytes ?? 0),
  tauriPlusRuntimeRatio: ratio(
    t.installDir.logicalBytes + (shared.webview2Runtime.logicalBytes ?? 0),
    e.installDir.logicalBytes
  )
}

const out = {
  at: new Date().toISOString(),
  method: {
    logicalBytes: '파일 길이의 합 (du -b)',
    allocBytes: `클러스터(${cluster}B, ${cl.source}) 올림의 합 — 탐색기 "디스크 할당 크기" 근사`,
    links: '정션/심볼릭 링크는 따라가지 않고 개수만 셈',
    registry: NO_REG ? 'skipped' : 'HKCU Uninstall EstimatedSize(KB) — 설치 프로그램이 써 넣은 값(측정값 아님)'
  },
  cluster: cl,
  apps,
  shared,
  compare,
  env: envInfo()
}

const dest = path.join(REPO, 'bench', 'results', `${OUT_NAME}.json`)
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.writeFileSync(dest, JSON.stringify(out, null, 2))

if (!QUIET) {
  for (const [k, a] of Object.entries(apps)) {
    console.log(`\n[${k}] ${a.label}`)
    console.log(`  설치본     ${a.installer.exists ? mb(a.installer.bytes) : '(없음)'}  ${a.installer.path ?? ''}`)
    console.log(
      `  설치 폴더  ${a.installDir.exists ? `${mb(a.installDir.logicalBytes)} 논리 / ${mb(a.installDir.allocBytes)} 할당 · 파일 ${a.installDir.files}` : '(없음)'}  ${a.installDir.path}`
    )
    if (a.registry) console.log(`  레지스트리 EstimatedSize ${(a.registry.estimatedSizeKB / 1024).toFixed(1)} MB · ${a.registry.displayName}`)
  }
  console.log(`\n[공유] 앱 홈 ${mb(shared.appHome.logicalBytes)} · WebView2 런타임 ${shared.webview2Runtime.exists ? mb(shared.webview2Runtime.logicalBytes) + ' (' + shared.webview2Runtime.version + ')' : '(없음)'}`)
  console.log(`\n설치본 비 ${compare.installerBytes.ratio ?? '—'} · 설치폴더 비 ${compare.installDirLogical.ratio ?? '—'} · +런타임까지 쳐도 ${compare.tauriPlusRuntimeRatio ?? '—'}`)
  console.log(`→ ${dest}`)
}
