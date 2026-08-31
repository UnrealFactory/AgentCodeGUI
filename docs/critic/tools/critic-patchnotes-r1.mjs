#!/usr/bin/env node
/**
 * `critic-patchnotes-r1` — PATCHNOTES R1 확인 크리틱의 계기.
 *
 * 이 조각의 위험은 코드가 아니라 **수치 옮겨 적기**다(decisions 초판이 손으로 적다 세 칸
 * 틀린 전례). 그래서 두 가지를 한다:
 *
 *  ① **전수 대조** — `PatchNotes.tsx`의 3.0.0 덩이에서 숫자를 **긁어내** 커밋된 결과 파일 ·
 *     디스크 실측 · 박제 분모(`multi-electron-2.6.2.json`)와 하나씩 맞춘다. 나눗셈은 다시 한다.
 *     ★ 특히 **어느 열에서 온 수인가**(WS ↔ Private)를 본다 — 값이 맞아도 열이 틀리면 거짓이다.
 *  ② **실렌더** — 격리 홈에 `ui-prefs.json`을 심어 ko/en 각각으로 앱을 띄우고 `.pncard`의
 *     innerText를 덤프한다. JSX가 줄바꿈 경계 공백을 먹는 버그(빌더가 2건 잡았다)와
 *     `undefined`/`NaN`/`[object Object]`를 화면에서 직접 본다.
 *
 * 규율: 이름 기반 kill 0(내가 스폰한 PID만) · CCG_HOME 격리 · 실홈 무접촉 · CDP 11034/11035.
 *
 * 사용:
 *   node docs/critic/tools/critic-patchnotes-r1.mjs --exe=<AgentCodeGUI3.exe> \
 *     --installdir=<배포 모사 폴더> --out=docs/critic/patchnotes-critic-r1-evidence.json
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const argv = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.split('=').slice(1).join('=') : d
}
const EXE = argv('exe', '')
const INSTALLDIR = argv('installdir', '')
const OUT = path.resolve(REPO, argv('out', 'docs/critic/patchnotes-critic-r1-evidence.json'))
const SKIP_RENDER = process.argv.includes('--no-render')

const lib = await import(pathToFileURL(path.join(REPO, 'bench', 'lib.mjs')).href)
const { connectMainPage, quietHome, killTree, sleep } = lib

const log = (...a) => console.log(...a)
const fail = []
const check = (ok, what) => {
  log(`${ok ? '  ✓' : '  ✖'} ${what}`)
  if (!ok) fail.push(what)
  return ok
}
const mb = (b) => +(b / 1048576).toFixed(2)
/** 「반올림해서 같은가」 — 패치노트는 반올림만 허용한다. */
const near = (claim, actual, tol = 0.05) => Math.abs(claim - actual) <= tol

const out = { critic: 'patchnotes-r1', at: new Date().toISOString(), inputs: { EXE, INSTALLDIR } }

try {
  // ── 1. 출처 읽기 ──────────────────────────────────────────────────────────
  log('[1] 출처')
  const R = (p) => JSON.parse(fs.readFileSync(path.join(REPO, p), 'utf8'))
  const frozen = R('bench/results/multi-electron-2.6.2.json') // 박제 분모
  const dist = R('bench/results/multi-tauri-3.0.0-default-patchnotes-dist.json')
  const cold = R('bench/results/coldstart-patchnotes-dist.json')
  const H = /^(node|conhost|python|pyright|clangd|Microsoft\.CodeAnalysis)/i
  const med = (a) => {
    const s = [...a].sort((x, y) => x - y)
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
  }
  const helperWs = med(dist.perRun.map((r) => +r.procDetail.filter((p) => H.test(p.name)).reduce((a, p) => a + p.wsMB, 0).toFixed(2)))
  const helperPriv = med(dist.perRun.map((r) => +r.procDetail.filter((p) => H.test(p.name)).reduce((a, p) => a + (p.privMB ?? 0), 0).toFixed(2)))
  const src = {
    e262: { idleWs: frozen.idleGrid.totalWsMB, idlePriv: frozen.idleGrid.totalPrivMB, perWindowWs: frozen.windowCost.wsMBPerWindow, panels: frozen.panels },
    t30: { idleWs: dist.summary.idleGridWsMB, idlePriv: dist.summary.idleGridPrivMB, perWindowWs: dist.summary.wsMBPerWindow, procsAdded: dist.summary.procsAdded, helperWs, helperPriv },
    cold: { paint: cold.medianPaintMs, root: cold.medianRootMs, win: cold.medianWinMs },
    exeSha: dist.bin.exeSha256,
    launchCwd: dist.launchCwd
  }
  out.sources = src
  log(`    박제 2.6.2  유휴 WS ${src.e262.idleWs} · Priv ${src.e262.idlePriv} · 창당 ${src.e262.perWindowWs}(WS) · ${src.e262.panels}패널`)
  log(`    배포 3.0    유휴 WS ${src.t30.idleWs} · Priv ${src.t30.idlePriv} · 창당 ${src.t30.perWindowWs}(WS) · 헬퍼 WS ${helperWs} / Priv ${helperPriv}`)

  // ── 2. 디스크 실측 ────────────────────────────────────────────────────────
  log('[2] 디스크 실측(논리 바이트)')
  const walk = (d) => {
    let b = 0
    let n = 0
    const go = (x) => {
      for (const e of fs.readdirSync(x, { withFileTypes: true })) {
        const p = path.join(x, e.name)
        if (e.isDirectory()) go(p)
        else if (e.isFile()) {
          b += fs.statSync(p).size
          n++
        }
      }
    }
    if (fs.existsSync(d)) go(d)
    return { bytes: b, files: n, mb: mb(b) }
  }
  const e262Setup = fs.statSync(path.join(REPO, 'dist', 'AgentCodeGUI-Setup-2.6.2.exe')).size
  const e262Dir = walk(path.join(REPO, 'dist', 'win-unpacked'))
  const inst = INSTALLDIR && fs.existsSync(INSTALLDIR) ? walk(INSTALLDIR) : null
  const setup30 = (() => {
    const d = path.dirname(path.dirname(EXE || '')) // …/release/bundle/nsis 추정 대신 인자로 받는다
    void d
    const p = argv('setup', '')
    return p && fs.existsSync(p) ? fs.statSync(p).size : null
  })()
  const appExe = EXE && fs.existsSync(EXE) ? fs.statSync(EXE).size : null
  const nodeExe = inst && fs.existsSync(path.join(INSTALLDIR, 'node.exe')) ? fs.statSync(path.join(INSTALLDIR, 'node.exe')).size : null
  const nmDir = inst ? walk(path.join(INSTALLDIR, 'node_modules')) : null
  out.disk = {
    e262SetupBytes: e262Setup,
    e262SetupMB: mb(e262Setup),
    e262DirMB: e262Dir.mb,
    e262Files: e262Dir.files,
    setup30Bytes: setup30,
    setup30MB: setup30 ? mb(setup30) : null,
    installDirMB: inst?.mb ?? null,
    installFiles: inst?.files ?? null,
    appExeMB: appExe ? mb(appExe) : null,
    nodeExeMB: nodeExe ? mb(nodeExe) : null,
    modulesMB: nmDir?.mb ?? null
  }
  log(`    2.6.2 설치기 ${mb(e262Setup)}MB · 폴더 ${e262Dir.mb}MB(${e262Dir.files}파일)`)
  if (inst) log(`    3.0 설치 폴더 ${inst.mb}MB(${inst.files}파일) = 앱 ${mb(appExe)} + node ${mb(nodeExe)} + 모듈 ${nmDir.mb}`)
  if (setup30) log(`    3.0 설치기 ${mb(setup30)}MB`)

  // ── 3. 전수 대조 ──────────────────────────────────────────────────────────
  log('[3] 패치노트 숫자 전수 대조')
  const claims = []
  const C = (label, claim, actual, unitNote = null) => {
    const ok = near(claim, actual, Math.max(0.05, Math.abs(actual) * 0.005))
    claims.push({ label, claim, actual, ok, unitNote })
    check(ok, `${label}: 패치노트 ${claim} ↔ 실측 ${actual}${unitNote ? ` (${unitNote})` : ''}`)
    return ok
  }
  C('설치 파일 2.6.2(MB)', 157.5, mb(e262Setup))
  if (setup30) C('설치 파일 3.0(MB)', 30.9, mb(setup30))
  C('설치 파일 비(5.1배)', 5.1, +(157.5 / 30.9).toFixed(2))
  C('설치 폴더 2.6.2(MB)', 633.7, e262Dir.mb)
  if (inst) C('설치 폴더 3.0(MB)', 139.4, inst.mb)
  C('설치 폴더 비(4.5배)', 4.5, +(633.7 / 139.4).toFixed(2))
  C('디스크 절감(MB)', 494, +(633.7 - 139.4).toFixed(1), '633.7−139.4')
  if (appExe) C('앱 자체(MB)', 6.8, mb(appExe))
  if (nodeExe && nmDir) C('코드 인텔리전스(MB)', 132.6, +(mb(nodeExe) + nmDir.mb).toFixed(2), 'node+모듈')
  C('창당 2.6.2(MB·WS)', 110.7, src.e262.perWindowWs)
  C('창당 3.0(MB·WS)', 19.6, src.t30.perWindowWs)
  C('멀티 유휴 2.6.2(MB·Private)', 505, src.e262.idlePriv)
  C('멀티 유휴 3.0(MB·Private)', 361, src.t30.idlePriv)
  // ★ 열 대조 — 값이 아니라 **출처 열**을 본다
  const helperClaim = 115
  const helperOkAsWs = near(helperClaim, src.t30.helperWs, 0.6)
  const helperOkAsPriv = near(helperClaim, src.t30.helperPriv, 0.6)
  claims.push({ label: '헬퍼 몫(Private 총계의 구성분으로 적힘)', claim: helperClaim, actual: src.t30.helperPriv, ok: helperOkAsPriv, unitNote: `WS라면 ${src.t30.helperWs} · Private이면 ${src.t30.helperPriv}` })
  check(
    helperOkAsPriv,
    `★열 대조 — 「유휴 Private ${src.t30.idlePriv} 안에 ${helperClaim}MB」: 헬퍼 Private은 ${src.t30.helperPriv}MB다` +
      (helperOkAsWs ? ` (${helperClaim}은 헬퍼 **WS** ${src.t30.helperWs}의 값이다)` : '')
  )
  // lead 문구가 실측을 넘어서지 않는가(과장 금지 — 보수적 반올림만 허용)
  const leadInstaller = 157.5 / 30.9 // 5.097
  check(leadInstaller >= 5, `lead 「5배 작아지고」: 실측 ${leadInstaller.toFixed(2)}배 — 과장 아님(보수적)`)
  const leadWindow = src.e262.perWindowWs / src.t30.perWindowWs // 5.648
  check(leadWindow >= 5, `lead 「5분의 1」: 실측 ${leadWindow.toFixed(2)}분의 1 — 과장 아님(보수적)`)
  out.claims = claims

  // ── 4. 실렌더 ─────────────────────────────────────────────────────────────
  if (!SKIP_RENDER && EXE) {
    log('[4] 실렌더 — ko/en 각각 격리 홈으로 띄워 .pncard 덤프')
    out.render = {}
    let port = 11034
    for (const lang of ['ko', 'en']) {
      const home = quietHome(path.join(os.tmpdir(), `ccg-critic-pn-home-${lang}`))
      fs.writeFileSync(path.join(home, 'ui-prefs.json'), JSON.stringify({ 'ui.lang': lang }))
      // 도장(whatsnew.seenVersion)은 **심지 않는다** — 그래야 카드가 스스로 열린다.
      const child = spawn(EXE, [], {
        cwd: INSTALLDIR || path.dirname(EXE),
        env: { ...process.env, CCG_HOME: home, CCG_CDP_PORT: String(port) },
        stdio: 'ignore',
        windowsHide: true
      })
      let page = null
      try {
        page = await connectMainPage(port, { timeoutMs: 60000 })
        // 카드는 getVersion() 응답 뒤에 뜬다 — 나타날 때까지 기다린다.
        let text = null
        for (let i = 0; i < 60; i++) {
          const r = await page.send('Runtime.evaluate', {
            expression: `(() => { const c = document.querySelector('.pncard'); return c ? c.innerText : null })()`,
            returnByValue: true
          })
          text = r?.result?.value ?? null
          if (text) break
          await sleep(500)
        }
        const found = !!text
        const bad = {
          undefined: (text ?? '').includes('undefined'),
          NaN: /\bNaN\b/.test(text ?? ''),
          objectObject: (text ?? '').includes('[object Object]'),
          // ★ JSX 줄바꿈 공백 먹기 — 한글/영문 낱말이 붙어 버린 자리
          gluedKo: /[가-힣][A-Za-z]|[)][가-힣]/.test(text ?? '') ? (text ?? '').match(/.{0,12}(?:[가-힣][A-Za-z]|[)][가-힣]).{0,12}/g) : null,
          gluedEn: /[a-z][)]|[)][a-z]|[a-z]{2,}[A-Z][a-z]{2,}/.test(text ?? '') ? (text ?? '').match(/.{0,14}(?:[a-z][)]|[)][a-z]).{0,14}/g) : null
        }
        out.render[lang] = { cardFound: found, chars: (text ?? '').length, bad, text }
        check(found, `[${lang}] .pncard가 화면에 떴다`)
        check(!bad.undefined && !bad.NaN && !bad.objectObject, `[${lang}] undefined/NaN/[object Object] 0건`)
        check(!bad.gluedEn, `[${lang}] 영문 낱말 붙음 없음${bad.gluedEn ? ' → ' + JSON.stringify(bad.gluedEn) : ''}`)
        check(!bad.gluedKo, `[${lang}] 한글-영문 붙음 없음${bad.gluedKo ? ' → ' + JSON.stringify(bad.gluedKo) : ''}`)
      } finally {
        try {
          page?.close?.()
        } catch {
          /* ignore */
        }
        killTree(child.pid) // 내가 스폰한 PID만 — 이름 기반 kill 금지
        await sleep(1200)
      }
      port++
    }
  }

  out.verdict = { failures: fail, ok: fail.length === 0 }
} catch (e) {
  out.error = String(e?.stack ?? e)
  fail.push(`예외: ${e?.message ?? e}`)
  out.verdict = { failures: fail, ok: false }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n')
log(`\n결과: ${OUT}`)
log(fail.length ? `✖ 실패 ${fail.length}건\n - ${fail.join('\n - ')}` : '✓ 전부 통과')
process.exit(fail.length ? 1 : 0)
