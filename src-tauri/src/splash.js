/* 부팅 스플래시 — **셸이 주입한다**(initialization_script). 렌더러 번들이 아니다.
 *
 * 왜 창 안의 오버레이인가 (2.6.2는 별도 BrowserWindow 스플래시다):
 *   2.6.2의 스플래시는 300x240짜리 두 번째 창이다. 3.0에서 같은 짓을 하면 WebView2가
 *   **웹뷰를 하나 더** 만든다 — 렌더러 프로세스 +1. 유휴 메모리를 반으로 줄이겠다는
 *   이번 라운드의 목표와 정면으로 충돌한다. 그래서 3.0은 메인 창 안에 오버레이를 깔고,
 *   그 오버레이가 **처음 그려진 순간** 창을 보여준다. 프로세스 0개 추가, 흰 화면 0프레임.
 *   부수 효과로 인상이 더 낫다: 작은 카드 → 큰 창으로 튀는 전환이 없다.
 *
 * 타이밍 계약:
 *   document_start에 붙어 body가 생기자마자 오버레이를 깔고, rAF 두 번(= 실제 프레임이
 *   합성기까지 갔다는 신호) 뒤에 셸에 'win:first-paint'를 보낸다. 셸은 그때 show()한다.
 *   #root에 자식이 생기면(=React 마운트) 오버레이를 130ms 페이드로 걷는다.
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

  var painted = false
  function firstPaint() {
    if (painted) return
    painted = true
    try {
      // 셸에 "그렸다" — 심(shim)이 아직 안 섰을 수 있어 내부 API를 직접 쓴다.
      var inv = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke
      if (inv) inv('ipc_call', { channel: 'win:first-paint', payload: [] })
    } catch (e) {
      /* 셸의 안전망이 받는다 */
    }
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
      // 프레임 두 번 = 합성기가 실제로 한 장을 올렸다는 뜻. 한 번으로는 이르다.
      requestAnimationFrame(function () {
        requestAnimationFrame(firstPaint)
      })
      watchRoot(el)
    } catch (e) {
      firstPaint()
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
