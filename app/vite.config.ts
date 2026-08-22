import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 원격 웹폰트 CSS(jsdelivr·Google Fonts)를 **렌더 차단에서 뺀다**.
 *
 * index.html의 `<link rel="stylesheet" href="https://…">` 두 줄은 렌더 차단 자원이다.
 * 즉 (1) 첫 페인트가 두 번의 원격 왕복 뒤로 밀리고, (2) 차단 스타일시트는 그 뒤의
 * **모듈 스크립트 실행까지 막으므로** React 마운트(rootMs)도 같이 밀린다. 오프라인이면
 * DNS 타임아웃만큼 창이 안 뜬다. 2.6.2도 같은 HTML을 쓰지만(대칭) 이건 고쳐야 할 비용이지
 * 지켜야 할 파리티가 아니다 — R2의 콜드 스타트 레버 중 하나로 **따로 재서** 기록한다.
 *
 * 안전한 이유: 두 폰트 CSS 모두 `font-display:swap`이다(Wanted Sans 원본 CSS·Google
 * Fonts URL 파라미터로 실측 확인). 비차단으로 바꿔도 폰트가 늦게 오면 대체 글꼴로
 * 그렸다가 바꿔 그릴 뿐, 글자가 사라지는 구간(FOIT)은 없다.
 *
 * app/index.html 자체는 건드리지 않는다 — 그 파일은 디자인 담당 에이전트와 겹친다.
 * 빌드 시각의 변환으로만 처리한다(HTML 원본은 그대로, 산출물만 비차단).
 */
function nonBlockingRemoteFonts(): Plugin {
  return {
    name: 'ccg-non-blocking-remote-fonts',
    // vite가 자기 자산 링크를 다 넣은 뒤에 돌아야 원격 링크만 정확히 고른다
    enforce: 'post',
    transformIndexHtml(html) {
      // 대조군 빌드용 스위치 — 이 레버의 기여도를 따로 재려면 CCG_BLOCKING_FONTS=1로 빌드.
      if (process.env.CCG_BLOCKING_FONTS) return html
      return html.replace(/<link\b[^>]*>/g, (tag) => {
        if (!/rel=["']stylesheet["']/.test(tag)) return tag
        if (!/href=["']https?:\/\//.test(tag)) return tag // 로컬 CSS는 차단인 채로 둔다
        if (/\bmedia=/.test(tag)) return tag
        // 원본이 `<link … />`(자기 닫힘)일 수 있으니 끝을 정규화한 뒤 붙인다
        const inner = tag.replace(/^<link\b/, '').replace(/\/?>$/, '')
        return `<link${inner} media="print" onload="this.media='all'">`
      })
    }
  }
}

/**
 * **스플래시가 먼저 한 프레임 그려지게 한다** — 앱 번들 실행을 rAF 두 번 뒤로 미룬다.
 *
 * 왜: 셸이 창을 띄우는 시점은 "렌더 차단 CSS가 다 와서 다음 프레임이 곧 스플래시인
 * 순간"(src-tauri/src/splash.js)이다. 그런데 그 직후 곧바로 1MB 진입 청크가 실행돼
 * 메인 스레드를 ~110ms 붙든다 — 합성기가 BeginFrame을 받을 틈이 없어서 **창은 떴는데
 * 빈 아크릴만 보이는 구간**이 생긴다(실측: 창 21~29ms · 첫 페인트 140~160ms).
 * 한 프레임만 양보하면 스플래시가 ~40ms에 뜨고, 앱 시작은 그만큼(≈1 프레임)만 늦다.
 *
 * `modulepreload`를 함께 심어 **내려받기는 원래대로 파서가 시작**하게 둔다 — 미루는 건
 * 실행뿐이라 네트워크 왕복이 뒤로 밀리지 않는다.
 *
 * 안전망 두 겹: rAF가 끝내 안 오면 300ms 타이머가 실행하고, import 실패는 콘솔에 남긴다.
 *
 * **기본값은 꺼짐이다.** 실측(R3, 5회 중앙값)으로 값을 치른 게 확인됐다:
 *   켬  — winMs 231 · rootMs 378 · 스플래시 픽셀 ≈ 300ms
 *   끔  — winMs 243 · rootMs 335 · 스플래시 픽셀 ≈ 400ms(그 전엔 빈 아크릴)
 * 창이 막 떠서 합성기가 첫 표면을 만드는 데 60~90ms가 걸리는데, 그동안 메인 스레드가
 * 놀기 때문이다. "브랜드 스플래시를 100ms 일찍 보여주고 앱은 43ms 늦게 쓴다"는 교환이라
 * 성능 목표(rootMs) 쪽을 택했다. 켜려면 `CCG_DEFER_APP_SCRIPTS=1`로 빌드.
 *
 * index.html에만 적용한다 — toast/tray는 스플래시가 없고 스크립트도 초경량이다.
 */
function paintSplashBeforeApp(): Plugin {
  return {
    name: 'ccg-defer-app-scripts',
    enforce: 'post',
    transformIndexHtml(html, ctx) {
      if (!process.env.CCG_DEFER_APP_SCRIPTS) return html
      if (!/(^|\/)index\.html$/.test(ctx.path.replace(/^\//, '') || 'index.html')) return html
      const srcs: string[] = []
      const stripped = html.replace(/<script\b[^>]*\btype=["']module["'][^>]*><\/script>\s*/g, (tag) => {
        const m = /\bsrc=["']([^"']+)["']/.exec(tag)
        if (!m) return tag // 인라인 모듈은 건드리지 않는다
        srcs.push(m[1])
        return ''
      })
      if (!srcs.length) return html
      const list = JSON.stringify(srcs)
      const boot =
        `<script>(function(){var s=${list},d=0;` +
        `function go(){if(d)return;d=1;s.reduce(function(p,u){return p.then(function(){return import(u)})},Promise.resolve())` +
        `.catch(function(e){console.error('[boot] app import 실패',e)})}` +
        // rAF 콜백 안에서 매크로태스크를 예약한다 = "이 프레임의 커밋이 끝난 직후".
        // rAF 두 번으로 기다리면 다음 vsync(최대 16ms)를 통째로 버리고, 창이 막 떠서
        // 합성기가 첫 표면을 만드는 동안 메인 스레드가 놀아 rootMs가 40ms 밀린다(실측).
        `requestAnimationFrame(function(){setTimeout(go,0)});setTimeout(go,300)})()</script>`
      const preload = srcs.map((s) => `<link rel="modulepreload" href="${s}">`).join('')
      return stripped.replace('</head>', `${preload}</head>`).replace('</body>', `${boot}</body>`)
    }
  }
}

// 3.0 프론트엔드 루트 — src/renderer의 이식본(app/). 렌더러 코드는 2.6.2와 동일하고,
// 메인과의 대화만 app/src/api/shim.ts(window.api)로 갈아끼운다.
//
// @shared는 복제하지 않는다: src/shared/protocol.ts·api.ts가 계약면의 단일 소스라
// 여기서 상대 경로로 그대로 가리킨다(레포 루트 밖이 아니라 위 폴더 — fs.allow 필요).
export default defineConfig({
  root: __dirname,
  // Tauri는 dist를 file:// 대신 커스텀 프로토콜(http://tauri.localhost)로 서빙하지만,
  // 상대 base가 세 페이지(index/toast/tray) 모두에서 자산 경로를 안전하게 만든다.
  base: './',
  clearScreen: false,
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../src/shared'),
      '@renderer': resolve(__dirname, 'src')
    }
  },
  server: {
    port: 5273,
    strictPort: true,
    // @shared가 vite root(app/) 밖에 있다 — dev 서버가 그 파일을 서빙하게 허용
    fs: { allow: [resolve(__dirname, '..')] }
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    // electron.vite.config.ts와 같은 이유로 명시 — 미지정 기본값이 번들을 3배로 만든다
    minify: 'esbuild',
    target: 'chrome110',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        // 포커스 밖 알림 토스트 창 (React 없는 초경량 페이지)
        toast: resolve(__dirname, 'toast.html'),
        // 트레이 우클릭 메뉴 창 (같은 초경량 패턴)
        tray: resolve(__dirname, 'tray.html')
      }
    }
  },
  plugins: [react(), nonBlockingRemoteFonts(), paintSplashBeforeApp()]
})
