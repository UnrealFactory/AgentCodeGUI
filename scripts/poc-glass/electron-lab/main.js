// 유리(아크릴) 실험대 — 2.6.2 메인 창의 껍데기 규칙만 뽑아낸 최소 재현기.
//
// 왜 제품 앱이 아니라 이 껍데기인가: 제품(src/main/index.ts)은 이미 keepAcrylicWhenBlurred가
// 박혀 있어서 "고치기 전" 상태를 만들 수 없다. 여기서는 그 보정을 env로 껐다 켜며
// **같은 창에서 A/B**를 뜬다. src/**는 읽기만 하고 손대지 않는다.
//
//   LAB_MAT      acrylic(기본) | mica | tabbed | none | auto   → BrowserWindow.backgroundMaterial
//                (= DWMWA_SYSTEMBACKDROP_TYPE 3 / 2 / 4 / 1 / 0)
//   LAB_FIX      none(기본) | reapply | reapply0
//                  reapply  = 2.6.2의 keepAcrylicWhenBlurred (blur + 50ms 뒤 재적용)
//                  reapply0 = 지연 없이 즉시 재적용 (딥 프레임이 실제로 생기는지 가르는 대조군)
//   LAB_CSS      none(기본) | crossfade   → 비활성일 때 틴트를 부드럽게 갈아끼우는 (b)안
//   LAB_FALLBACK none(기본) | designed    → 투명 효과 꺼짐을 감지해 디자인된 단색+그라데이션으로 (d)안
//   LAB_TAG      창 안에 크게 찍는 라벨(스크린샷에서 어떤 조합인지 바로 읽히게)
//   LAB_X/Y/W/H  창 위치·크기
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const MAT = process.env.LAB_MAT || 'acrylic'
const FIX = process.env.LAB_FIX || 'none'
const CSSMODE = process.env.LAB_CSS || 'none'
const FALLBACK = process.env.LAB_FALLBACK || 'none'
const TAG = process.env.LAB_TAG || `${MAT}/${FIX}/${CSSMODE}/${FALLBACK}`

const num = (v, d) => (v === undefined ? d : Number(v))

// 실앱과 캐시/설정이 섞이지 않게 (사용자 실앱 보호)
app.setPath('userData', path.join(__dirname, '.userdata'))
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
nativeTheme.themeSource = 'dark'

/** 투명 효과(설정 › 개인 설정 › 색) 상태. 배터리 절약/에너지 세이버도 이 값을 실질적으로 끈다. */
function transparencyEnabled() {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'EnableTransparency'],
      { encoding: 'utf8' }
    )
    const m = out.match(/EnableTransparency\s+REG_DWORD\s+0x([0-9a-f]+)/i)
    return m ? parseInt(m[1], 16) !== 0 : true
  } catch {
    return true
  }
}

let win = null

app.whenReady().then(() => {
  win = new BrowserWindow({
    x: num(process.env.LAB_X, 530),
    y: num(process.env.LAB_Y, 180),
    width: num(process.env.LAB_W, 1500),
    height: num(process.env.LAB_H, 950),
    show: false,
    frame: false,
    // 2.6.2 규칙 그대로: backgroundColor 금지(불투명 층이 재질을 막는다)
    ...(MAT === 'none' ? {} : { backgroundMaterial: MAT }),
    autoHideMenuBar: true,
    title: `glass-lab ${TAG}`,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false }
  })

  // ── (a)안: 비활성 전환 뒤 백드롭 재적용 ──────────────────────────────────────
  if (FIX === 'reapply' || FIX === 'reapply0') {
    const delay = FIX === 'reapply' ? 50 : 0
    win.on('blur', () => {
      setTimeout(() => {
        if (win && !win.isDestroyed() && MAT !== 'none') win.setBackgroundMaterial(MAT)
      }, delay)
    })
  }

  const push = () => {
    if (!win || win.isDestroyed()) return
    win.webContents.send('lab', {
      tag: TAG,
      focused: win.isFocused(),
      maximized: win.isMaximized(),
      cssMode: CSSMODE,
      fallback: FALLBACK,
      transparency: transparencyEnabled()
    })
  }
  win.on('focus', push)
  win.on('blur', push)
  win.on('maximize', push)
  win.on('unmaximize', push)
  // 투명 효과는 OS 설정이라 Electron 이벤트가 없다 — PoC라 1초 폴링(3.0 본구현은
  // WinRT UISettings.AdvancedEffectsEnabledChanged를 쓴다. glass-findings.md 참조)
  setInterval(push, 1000)

  ipcMain.handle('lab:hello', () => ({
    tag: TAG,
    focused: win?.isFocused() ?? false,
    maximized: win?.isMaximized() ?? false,
    cssMode: CSSMODE,
    fallback: FALLBACK,
    transparency: transparencyEnabled()
  }))

  win.loadFile(path.join(__dirname, 'index.html'))
  win.once('ready-to-show', () => {
    win.show()
    console.log('LAB_READY pid=' + process.pid + ' tag=' + TAG)
  })
})

app.on('window-all-closed', () => app.quit())
