import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
  plugins: [react()]
})
