/* R2 — 기본값 반전의 값을 재는 자 (M-UI R2 빌더).
 *
 * 물음: "부팅 기본 = 폴백"으로 뒤집었으니 **불투명 → 투명 전환이 화면에 보이는가**.
 * 두 경우를 나눠 잰다.
 *
 *  A) 정상 경로 — 셸의 부팅 스냅샷이 같은 태스크 안에서 "살아 있음"을 증명한다.
 *     `__ccgGlassBoot.tOn/tOff`로 폴백이 걸려 있던 시간을 재고, 스플래시의 첫 합성
 *     프레임(`__ccgSplashPaintAt`)과 비교한다. tOff < paint 면 **불투명 프레임 0장**이다.
 *
 *  B) 최악 경로 — 증명이 없어 문서가 실제로 **불투명으로 서고**, 셸의 통지가 와서야
 *     투명으로 넘어간다. 만들어 내는 방법: 직전 문서가 남긴 sessionStorage 판정을
 *     `{ok:false}`로 위조하고 재로드한다(부트스트랩이 스냅샷과 AND 하므로 폴백에 착지).
 *     document-start에 심은 MutationObserver가 클래스가 걷히는 순간을 ms로 찍는다.
 *
 * 사용: node scripts/poc-glass/poc-glass-flash.mjs <cdpPort>
 * (내가 띄운 격리 인스턴스에만 붙는다 — 사용자 실앱에는 CDP 포트가 없다.)
 */
import { Cdp, cdpTargets } from '../../bench/lib.mjs'

const port = Number(process.argv[2] || 9334)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PROBE = `(() => {
  var f = { t0: performance.now(), onAt: null, offAt: null, opaqueMs: null, firstRafAt: null, flips: [] }
  window.__ccgFlash = f
  /* **첫 rAF = 이 창이 프레임을 만들기 시작한 순간.** 창이 숨겨져 있는 동안 WebView2는
     프레임을 만들지 않아 rAF가 오지 않는다(splash.js 헤더의 실측 규약). 그래서
     offAt < firstRafAt 이면 **불투명 상태로 합성된 프레임이 0장**이라는 뜻이다. */
  try { requestAnimationFrame(function () { f.firstRafAt = Math.round(performance.now() * 100) / 100 }) } catch (e) {}
  function look(when) {
    var on = document.documentElement.classList.contains('ccg-glass-off')
    f.flips.push([when, on, Math.round(performance.now() * 100) / 100])
  }
  function watch() {
    var de = document.documentElement
    if (!de) { setTimeout(watch, 0); return }
    look('install')
    if (de.classList.contains('ccg-glass-off')) f.onAt = performance.now()
    new MutationObserver(function () {
      var on = de.classList.contains('ccg-glass-off')
      var t = performance.now()
      if (on && f.onAt === null) f.onAt = t
      if (!on && f.onAt !== null && f.offAt === null) {
        f.offAt = t
        f.opaqueMs = Math.round((t - f.onAt) * 100) / 100
      }
      f.flips.push(['mut', on, Math.round(t * 100) / 100])
    }).observe(de, { attributes: true, attributeFilter: ['class'] })
  }
  watch()
})()`

const READ = `JSON.stringify({
  cls: document.documentElement.className,
  boot: window.__ccgGlassBoot ? {
    ok: window.__ccgGlassBoot.ok, tOn: window.__ccgGlassBoot.tOn,
    tOff: window.__ccgGlassBoot.tOff, prev: window.__ccgGlassBoot.prev
  } : null,
  splashPaintAt: window.__ccgSplashPaintAt ?? null,
  flash: window.__ccgFlash ? {
    onAt: window.__ccgFlash.onAt == null ? null : Math.round(window.__ccgFlash.onAt * 100) / 100,
    offAt: window.__ccgFlash.offAt == null ? null : Math.round(window.__ccgFlash.offAt * 100) / 100,
    opaqueMs: window.__ccgFlash.opaqueMs, firstRafAt: window.__ccgFlash.firstRafAt,
    flips: window.__ccgFlash.flips
  } : null,
  glass: window.__ccgGlass ? { events: window.__ccgGlass.events, ok: window.__ccgGlass.state && window.__ccgGlass.state.ok } : null
})`

const targets = await cdpTargets(port)
const t = targets.find((x) => x.type === 'page' && !x.url.includes('#session'))
if (!t) throw new Error('no main page target: ' + JSON.stringify(targets.map((x) => x.url)))
const cdp = await Cdp.connect(t.webSocketDebuggerUrl, { timeoutMs: 10000 })
await cdp.send('Page.enable')
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })

const out = {}

// ── A) 정상 경로 ────────────────────────────────────────────────────────────
await cdp.eval(`try{sessionStorage.removeItem('ccg.glass.last')}catch(e){}`)
await cdp.send('Page.reload', { ignoreCache: false })
await sleep(4500)
out.A_normal = JSON.parse(await cdp.eval(READ))

// ── B) 최악 경로: 증명이 없는 문서 ─────────────────────────────────────────
await cdp.eval(`try{sessionStorage.setItem('ccg.glass.last', JSON.stringify({ok:false,at:Date.now()}))}catch(e){}`)
await cdp.send('Page.reload', { ignoreCache: false })
await sleep(6000)
out.B_unproven = JSON.parse(await cdp.eval(READ))

// 뒷정리 — 위조한 판정을 지우고 한 번 더 세운다
await cdp.eval(`try{sessionStorage.removeItem('ccg.glass.last')}catch(e){}`)
await cdp.send('Page.reload', {})
await sleep(3500)
out.C_restored = JSON.parse(await cdp.eval(READ))

// ── D) 추가 채팅 창 — **스플래시가 없는** 창의 최악 경로 ────────────────────
// 메인 창은 오버레이(불투명 #151515)가 전환을 가려 준다. 추가 채팅 창에는 그 오버레이가
// 없으므로, "숨겨진 채로 끝났는가"만이 방패다(창은 PageLoad(Finished)에서 show된다).
await cdp.eval(`(async () => { await window.api.openSessionWindow(); return 1 })()`, { awaitPromise: true })
await sleep(3500)
const st = (await cdpTargets(port)).find((x) => x.type === 'page' && x.url.includes('#session'))
if (st) {
  const s = await Cdp.connect(st.webSocketDebuggerUrl, { timeoutMs: 10000 })
  await s.send('Page.enable')
  await s.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE })
  await s.eval(`try{sessionStorage.setItem('ccg.glass.last', JSON.stringify({ok:false,at:Date.now()}))}catch(e){}`)
  await s.send('Page.reload', {})
  await sleep(6000)
  out.D_session_unproven = JSON.parse(await s.eval(READ))
  await s.eval(`try{sessionStorage.removeItem('ccg.glass.last')}catch(e){}`)
  s.close()
}

console.log(JSON.stringify(out, null, 1))
cdp.close()
