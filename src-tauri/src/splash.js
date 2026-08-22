/* 부팅 스플래시 — **셸이 주입한다**(initialization_script). 렌더러 번들이 아니다.
 *
 * 왜 창 안의 오버레이인가 (2.6.2는 별도 BrowserWindow 스플래시다):
 *   2.6.2의 스플래시는 300x240짜리 두 번째 창이다. 3.0에서 같은 짓을 하면 WebView2가
 *   **웹뷰를 하나 더** 만든다 — 렌더러 프로세스 +1. 유휴 메모리를 반으로 줄이겠다는
 *   이번 라운드의 목표와 정면으로 충돌한다. 그래서 3.0은 메인 창 안에 오버레이를 깔고,
 *   그 오버레이가 **처음 그려진 순간** 창을 보여준다. 프로세스 0개 추가, 흰 화면 0프레임.
 *   부수 효과로 인상이 더 낫다: 작은 카드 → 큰 창으로 튀는 전환이 없다.
 *
 * 타이밍 계약 (R3에서 고침 — R2의 규약은 **실제로 한 번도 발화하지 않았다**):
 *   document_start에 붙어 body가 생기자마자 오버레이를 깔고, **렌더 차단 스타일시트가
 *   다 도착한 순간**(= 다음 프레임이 곧 스플래시다) 셸에 'win:first-paint'를 보낸다.
 *   셸은 그때 show()한다. #root에 자식이 생기면(=React 마운트) 130ms 페이드로 걷는다.
 *
 *   R2는 rAF 두 번 뒤에 보냈다. 그런데 **창이 숨겨져 있는 동안 WebView2는 프레임을
 *   만들지 않으므로 rAF가 영영 오지 않는다** — 창을 보여줘야 rAF가 오고, rAF가 와야
 *   창을 보여주는 닭-달걀이다. 그래서 창은 결국 셸의 안전망(PageLoadEvent::Finished =
 *   load 이벤트)으로 떴고, load는 **원격 웹폰트 CSS 두 개까지 기다린다**. 실측:
 *   DOMContentLoaded 61~66ms인데 load 109~119ms — 창 표시가 네트워크에 50ms 묶여 있었고
 *   오프라인이면 그만큼 더 늦었다. rAF는 이제 진단 표식(__ccgSplashPaintAt)에만 쓴다.
 *
 * 실패해도 앱을 막지 않는다: 셸에 3.5초 안전망이 있고(win.rs), 여기서 예외가 나도
 * try/catch로 삼킨다.
 */
;(function () {
  if (window.__ccgSplash) return
  window.__ccgSplash = 1
  // 메인 창만 — toast/tray 페이지는 오버레이가 필요 없다(그리고 #root가 없다).
  if (!/(^\/?$)|index\.html$/.test(location.pathname)) return

  var CSS =
    '#__ccg_splash{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;' +
    'align-items:center;justify-content:center;background:#151515;' +
    "font-family:'Wanted Sans Variable',system-ui,-apple-system,sans-serif;" +
    '-webkit-user-select:none;user-select:none;transition:opacity .13s linear}' +
    '#__ccg_splash.out{opacity:0;pointer-events:none}' +
    '#__ccg_splash .lg{width:56px;height:56px;border-radius:16px;background:#e9e9e9;display:grid;' +
    'place-items:center;color:#161616}' +
    '#__ccg_splash .nm{margin-top:16px;font-size:14px;font-weight:600;color:rgba(255,255,255,.90);letter-spacing:-.01em}' +
    '#__ccg_splash .sp{margin-top:18px;width:20px;height:20px;border-radius:50%;' +
    'border:2.5px solid rgba(255,255,255,.14);border-top-color:rgba(255,255,255,.62);animation:__ccgspin .7s linear infinite}' +
    '#__ccg_splash .sb{margin-top:12px;font-size:11.5px;color:rgba(255,255,255,.40)}' +
    '@keyframes __ccgspin{to{transform:rotate(360deg)}}'

  // 2.6.2 splashHtml()의 로고 그대로 (src/main/index.ts)
  var LOGO =
    '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="8" width="13" height="10" rx="4.5"/>' +
    '<circle cx="10.2" cy="13" r=".95" fill="currentColor" stroke="none"/>' +
    '<circle cx="13.8" cy="13" r=".95" fill="currentColor" stroke="none"/>' +
    '<path d="M9.5 8Q9 5.8 7.3 4.9"/><circle cx="7" cy="4.7" r=".85" fill="currentColor" stroke="none"/>' +
    '<path d="M14.5 8Q15 5.8 16.7 4.9"/><circle cx="17" cy="4.7" r=".85" fill="currentColor" stroke="none"/>' +
    '<path d="M4.4 10.6C3 11.5 3 14.5 4.4 15.4"/><path d="M19.6 10.6C21 11.5 21 14.5 19.6 15.4"/></svg>'

  /** 셸 내부 채널로 한 줄 보낸다(심이 아직 안 섰을 수 있어 내부 API를 직접 쓴다). */
  function tell(channel) {
    try {
      var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke
      if (inv) inv('ipc_call', { channel: channel, payload: [] })
    } catch (e) {
      /* 셸의 안전망(PageLoadEvent::Finished / 3.5초 타이머)이 받는다 */
    }
  }

  var notified = false
  /** 셸에 "그릴 것이 DOM에 있고 다음 프레임이 그것이다" — 여기서 창이 뜬다. */
  function notifyShell() {
    if (notified) return
    notified = true
    tell('win:first-paint')
  }

  var mounted = false
  /**
   * **마운트 하트비트** — `#root`에 자식이 생겼다 = 앱이 실제로 섰다.
   * 크래시 복구(crash.rs)가 이 신호로 "복구가 붙었는지"를 판정한다. 이게 없으면
   * 셸은 reload()를 걸어 놓고 그게 먹혔는지 영영 모른다(R4 크리틱 §1.3-(3)).
   * 이 스크립트는 initialization_script라 **재로드마다 다시 도므로** 복구 뒤에도 온다.
   */
  function notifyMounted() {
    if (mounted) return
    mounted = true
    tell('win:mounted')
  }

  /**
   * 렌더 차단 스타일시트가 전부 도착했는가. Blink는 그 전엔 **어떤 픽셀도** 올리지
   * 않으므로, 여기가 "보여주면 곧바로 스플래시가 보이는" 가장 이른 지점이다.
   * 원격 폰트 CSS는 vite가 media="print"로 비차단으로 바꿔 두므로 세지 않는다
   * (app/vite.config.ts의 nonBlockingRemoteFonts — 그래서 오프라인에도 안 막힌다).
   */
  function paintReady() {
    var links = document.querySelectorAll('link[rel="stylesheet"]')
    for (var i = 0; i < links.length; i++) {
      var m = links[i].media
      if (m && m !== 'all' && m !== 'screen') continue
      if (!links[i].sheet) return false
    }
    return true
  }

  var painted = false
  /** 실제 첫 프레임 — 진단 표식(bench/boot.mjs가 읽는다). 값 하나 대입이라 비용 0. */
  function firstPaint() {
    if (painted) return
    painted = true
    try {
      window.__ccgSplashPaintAt = Math.round(performance.now() * 10) / 10
    } catch (e) {
      /* 진단용 — 실패해도 무시 */
    }
    notifyShell()
  }

  function mount() {
    if (!document.body) {
      // body는 <head> 파싱 직후에 생긴다. rAF는 페인트에 묶여 있어 여기선 못 쓴다.
      setTimeout(mount, 1)
      return
    }
    try {
      var st = document.createElement('style')
      st.textContent = CSS
      document.head.appendChild(st)
      var el = document.createElement('div')
      el.id = '__ccg_splash'
      el.innerHTML =
        '<div class="lg">' + LOGO + '</div><div class="nm">AgentCodeGUI</div>' +
        '<div class="sp"></div><div class="sb">' +
        (navigator.language && navigator.language.indexOf('ko') === 0 ? '시작하는 중…' : 'Starting…') +
        '</div>'
      document.body.appendChild(el)
      // 스타일시트가 준비되는 즉시 창을 띄운다(4ms 폴링, 120ms 상한).
      // 상한은 CSS가 끝내 안 오는 경우의 안전망 — 그때도 창은 떠야 한다.
      var t0 = Date.now()
      ;(function waitPaintable() {
        if (paintReady() || Date.now() - t0 > 120) notifyShell()
        else setTimeout(waitPaintable, 4)
      })()
      // 프레임 두 번 = 합성기가 실제로 한 장을 올렸다는 뜻(창이 뜬 뒤에야 온다).
      requestAnimationFrame(function () {
        requestAnimationFrame(firstPaint)
      })
      watchRoot(el)
    } catch (e) {
      notifyShell()
    }
  }

  function watchRoot(el) {
    var root = document.getElementById('root')
    function done() {
      el.classList.add('out')
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el)
      }, 200)
    }
    function check() {
      var r = root || (root = document.getElementById('root'))
      if (r && r.children.length > 0) {
        notifyMounted()
        done()
        return true
      }
      return false
    }
    if (check()) return
    var obs = new MutationObserver(function () {
      if (check()) obs.disconnect()
    })
    obs.observe(document.documentElement, { childList: true, subtree: true })
    // 렌더러가 끝내 못 서면 8초 뒤 걷는다 — 스플래시가 앱을 영원히 덮지 않게.
    setTimeout(function () {
      obs.disconnect()
      done()
    }, 8000)
  }

  mount()
})()
