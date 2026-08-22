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
  plugins: [react(), nonBlockingRemoteFonts()]
})
