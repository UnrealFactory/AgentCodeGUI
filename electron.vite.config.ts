import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'src/shared') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    build: {
      // electron-vite의 렌더러 기본값이 minify:false다 — 미지정 시 JS 2.97MB·CSS 295KB가
      // 주석까지 통째로 나가 로드·파스·V8 코드 메모리를 3배로 만든다(실측). 명시로 켠다.
      minify: 'esbuild',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // 포커스 밖 알림 토스트 창 — React 없는 초경량 페이지 (main/notifyToast.ts가 띄운다)
          toast: resolve(__dirname, 'src/renderer/toast.html'),
          // 트레이 우클릭 메뉴 창 — 같은 초경량 패턴 (main/index.ts showTrayMenu가 띄운다)
          tray: resolve(__dirname, 'src/renderer/tray.html')
        }
      }
    },
    plugins: [react()]
  }
})
