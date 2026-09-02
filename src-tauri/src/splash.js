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
    '#__ccg_splash .lg{width:56px;height:56px}' +
    '#__ccg_splash .lg img{width:100%;height:100%;display:block;-webkit-user-drag:none}' +
    '#__ccg_splash .nm{margin-top:16px;font-size:14px;font-weight:600;color:rgba(255,255,255,.90);letter-spacing:-.01em}' +
    '#__ccg_splash .sp{margin-top:18px;width:20px;height:20px;border-radius:50%;' +
    'border:2.5px solid rgba(255,255,255,.14);border-top-color:rgba(255,255,255,.62);animation:__ccgspin .7s linear infinite}' +
    '#__ccg_splash .sb{margin-top:12px;font-size:11.5px;color:rgba(255,255,255,.40)}' +
    '@keyframes __ccgspin{to{transform:rotate(360deg)}}'

  // 앱 아이콘 그대로(build/icon.png 112px 축소판, base64 인라인) — 로딩 화면과 작업
  // 표시줄 아이콘이 같은 얼굴이어야 한다(2026-09-01 사용자 결정: 라인아트 마스코트 기각).
  // 주입 스크립트라 파일을 못 읽는다 — 갱신은 build/icon.png를 112px로 줄여 base64 재생성.
  var LOGO = '<img alt="" src="data:image/png;base64,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">'

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
