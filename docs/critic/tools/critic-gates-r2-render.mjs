#!/usr/bin/env node
/**
 * `critic-gates-r2-render` — GATES R2 확인 크리틱의 실렌더 계기.
 *
 * 빌더가 갈아 끼운 **02 메모리 절**을 ko/en 두 벌 다 화면에서 읽는다. `tsc`는 붙어 버린
 * 낱말을 못 보고, JSX는 `</b>` 뒤 줄바꿈에서 공백을 먹는다(PATCHNOTES R1이 두 번 밟았다).
 *
 * 보는 것:
 *  ① 카드가 실제로 뜨는가 · `ccg.lang`이 심은 값과 같은가
 *  ② `undefined` / `NaN` / `[object Object]` 0건
 *  ③ 낱말이 붙은 자리 0건(한글-영문 · 영문-괄호)
 *  ④ ★**새 수치 세 낱이 화면 문자열에 그대로 있는가** — 19MB · 505→256MB · 100MB.
 *     그리고 **옛 수치가 남아 있지 않은가** — 19.6 · 361 · 102.
 *     (열 이름 대조는 `critic-gates-r2-recompute.mjs`가 원파일로 따로 한다.)
 *
 * 규율: 이름 기반 kill 0(내가 스폰한 PID만) · CCG_HOME 격리 · 실홈 무접촉 · CDP 11230/11231.
 *
 * 사용:
 *   node docs/critic/tools/critic-gates-r2-render.mjs --exe=<AgentCodeGUI3.exe> \
 *     --installdir=<배포 모사 폴더> --out=docs/critic/evidence/gates-r2-render.json
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const argv = (k, d) => { const h = process.argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.split('=').slice(1).join('=') : d }
const EXE = argv('exe', '')
const INSTALLDIR = argv('installdir', '')
const OUT = path.resolve(REPO, argv('out', 'docs/critic/evidence/gates-r2-render.json'))

const lib = await import(pathToFileURL(path.join(REPO, 'bench', 'lib.mjs')).href)
const { connectMainPage, quietHome, killTree, sleep } = lib

const log = (...a) => console.log(...a)
const fail = []
const check = (ok, what) => { log(`${ok ? '  ✓' : '  ✖'} ${what}`); if (!ok) fail.push(what); return ok }

// 화면에 **있어야** 하는 낱 / **없어야** 하는 낱(한 라운드 전의 값)
const MUST = {
  ko: ['19MB', '505MB', '256MB', '100MB', '프로세스 0개'],
  en: ['19MB', '505MB', '256MB', '100MB', 'zero extra processes']
}
const MUSTNOT = { ko: ['19.6MB', '361MB', '102MB'], en: ['19.6MB', '361MB', '102MB'] }

const out = { what: 'GATES R2 — 패치노트 02 메모리 절 ko/en 실렌더 재현', at: new Date().toISOString(), exe: EXE, installdir: INSTALLDIR }

try {
  if (!EXE) throw new Error('--exe= 가 필요하다')
  out.render = {}
  let port = 11230
  for (const lang of ['ko', 'en']) {
    log(`[${lang}] 격리 홈에 ui.lang을 심고 띄운다 (CDP ${port})`)
    const home = quietHome(path.join(os.tmpdir(), `ccg-critic-gr2-home-${lang}`))
    fs.writeFileSync(path.join(home, 'ui-prefs.json'), JSON.stringify({ 'ui.lang': lang }))
    const child = spawn(EXE, [], {
      cwd: INSTALLDIR || path.dirname(EXE),
      env: { ...process.env, CCG_HOME: home, CCG_CDP_PORT: String(port) },
      stdio: 'ignore', windowsHide: true
    })
    let page = null
    try {
      page = await connectMainPage(port, { timeoutMs: 60000 })
      let text = null, seenLang = null
      for (let i = 0; i < 60; i++) {
        const r = await page.send('Runtime.evaluate', {
          expression: `(() => { const c = document.querySelector('.pncard'); return JSON.stringify({ t: c ? c.innerText : null, l: (window.ccg && window.ccg.lang) || null }) })()`,
          returnByValue: true
        })
        try { const v = JSON.parse(r?.result?.value ?? '{}'); text = v.t; seenLang = v.l } catch { /* ignore */ }
        if (text) break
        await sleep(500)
      }
      const t = text ?? ''
      // ★「낱말이 붙었는가」는 **정규식으로 재면 안 된다.** 한국어의 「(WebView2)을」과
      //   영어의 「them).」은 정상인데 소박한 `[)][가-힣]` · `[a-z][)]`가 둘 다 잡는다
      //   (이 크리틱이 처음 돌렸을 때 거짓 양성 8건을 냈다). 붙음의 정의는
      //   **「원문에 있던 공백이 화면에서 사라졌다」**이므로, 소스에서 태그를 걷어
      //   공백을 정규화한 문자열과 화면 문자열을 **직접 맞춘다.** 공백이 먹히면
      //   그 자리에서 두 문자열이 갈라진다.
      const bad = {
        undefined: t.includes('undefined'),
        NaN: /\bNaN\b/.test(t),
        objectObject: t.includes('[object Object]')
      }
      const norm = (s) => s.replace(/\s+/g, ' ').trim()
      const jsx = fs.readFileSync(path.join(REPO, 'app/src/components/PatchNotes.tsx'), 'utf8')
      // 02 메모리 절의 desc JSX를 언어별로 집어 태그를 걷는다.
      const anchor = lang === 'ko' ? '예전엔 추가 채팅' : 'Every extra chat or pop-out'
      const at = jsx.indexOf(anchor)
      const srcRaw = at < 0 ? null : jsx.slice(at, jsx.indexOf('</>', at))
      const srcText = srcRaw == null ? null : norm(srcRaw.replace(/<\/?b>/g, ''))
      const rendered = srcText == null ? null : norm((t.match(new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]{0,600}')) ?? [''])[0]).slice(0, srcText.length)
      bad.sourceVsRender = srcText != null && rendered != null && srcText !== rendered
        ? { srcText, rendered } : null
      const present = Object.fromEntries(MUST[lang].map((s) => [s, t.includes(s)]))
      const stale = Object.fromEntries(MUSTNOT[lang].map((s) => [s, t.includes(s)]))
      // 02 절만 뽑아 증거에 싣는다(카드 전문은 길다).
      const seg = (t.match(/[^\n]*(?:19MB|19MB and)[^\n]*(?:\n[^\n]*){0,4}/) ?? [''])[0]
      out.render[lang] = { cardFound: !!text, lang: seenLang, chars: t.length, bad, present, stale, memorySection: seg, text: t }
      check(!!text, `[${lang}] .pncard가 화면에 떴다`)
      // `window.ccg.lang`은 이 빌드에 없다 — 언어 전환은 **본문이 그 언어인가**로 판정한다.
      // ★en 카드에도 한글이 **한 줄** 있다 — 탐색기 우클릭 메뉴의 실제 라벨
      //   「AgentCodeGUI3으로 열기」를 그대로 인용한 자리라 정상이다(GATES R2가 만진 절도 아니다).
      //   그래서 「한글이 없다」로 재면 거짓 양성이 난다. 02 절의 언어로만 판정한다.
      const langOk = lang === 'ko'
        ? t.includes('프로세스 0개예요') && !t.includes('zero extra processes')
        : t.includes('zero extra processes') && !t.includes('프로세스 0개예요')
      check(langOk, `[${lang}] 카드 본문이 ${lang}로 렌더됐다 (window.ccg.lang=${seenLang} — 이 빌드엔 없는 필드)`)
      check(!bad.undefined && !bad.NaN && !bad.objectObject, `[${lang}] undefined/NaN/[object Object] 0건`)
      check(!bad.sourceVsRender, `[${lang}] 소스↔화면 공백 일치(낱말 붙음 0)${bad.sourceVsRender ? '\n      src: ' + JSON.stringify(bad.sourceVsRender.srcText) + '\n      dom: ' + JSON.stringify(bad.sourceVsRender.rendered) : ''}`)
      for (const [s, ok] of Object.entries(present)) check(ok, `[${lang}] 새 수치 「${s}」가 화면에 있다`)
      for (const [s, hit] of Object.entries(stale)) check(!hit, `[${lang}] 옛 수치 「${s}」가 화면에 없다`)
    } finally {
      try { page?.close?.() } catch { /* ignore */ }
      killTree(child.pid) // 내가 스폰한 PID만
      await sleep(1200)
    }
    port++
  }
  out.verdict = { failures: fail, ok: fail.length === 0 }
} catch (e) {
  out.error = String(e?.stack ?? e); fail.push(`예외: ${e?.message ?? e}`); out.verdict = { failures: fail, ok: false }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n')
log(`\n결과: ${OUT}`)
log(fail.length ? `✖ 실패 ${fail.length}건\n - ${fail.join('\n - ')}` : '✓ 전부 통과')
process.exit(fail.length ? 1 : 0)
