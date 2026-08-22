// shot-html.mjs가 electron으로 띄우는 메인 프로세스.
//
// 왜 .cjs인가: electron.exe는 **GUI 서브시스템** 실행 파일이라 main 프로세스의
// console.log가 파이프로 안 나오는 경우가 있다(실측: 아무것도 안 찍히고 멈춘 것처럼 보였다).
// 그래서 결과는 stdout이 아니라 **파일**(SHOT_RESULT_FILE)로 넘긴다. 그리고 ESM(.mjs)
// 진입점은 electron 버전에 따라 조용히 실패하므로 CommonJS로 고정한다.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const RESULT = process.env.SHOT_RESULT_FILE
const TRACE = RESULT + '.trace'
const jobs = JSON.parse(process.env.SHOT_JOBS)
const W = Number(process.env.SHOT_W || 1820)
const H = Number(process.env.SHOT_H || 1400)

function trace(s) {
  try {
    fs.appendFileSync(TRACE, new Date().toISOString() + ' ' + s + '\n')
  } catch {}
}
function finish(code, payload) {
  try {
    fs.writeFileSync(RESULT, JSON.stringify(payload))
  } catch (e) {
    trace('write fail ' + e.message)
  }
  app.exit(code)
}

// 어떤 이유로든 멈추면 좀비로 남지 않게 (앞선 실측에서 electron이 남아 손으로 죽였다).
// 한 장당 45초: 개별 실행은 10~15초면 끝나지만, --all로 여러 장을 한 프로세스에서
// 찍으면 창이 늘수록 느려진다(문서 높이만큼 창을 키워 찍으므로 표면이 크다 —
// 8장 배치가 25초/장 예산에서 걸렸다). 급하면 --all 대신 한 장씩 돌리는 게 빠르다.
const HARD = 45000 * jobs.length + 15000
const bail = setTimeout(() => {
  trace('HARD TIMEOUT')
  finish(3, [])
}, HARD)

process.on('uncaughtException', (e) => {
  trace('uncaught ' + e.stack)
  finish(4, [])
})

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

app.whenReady().then(async () => {
  trace('ready')
  const out = []
  for (const j of jobs) {
    trace('open ' + j.src)
    const win = new BrowserWindow({
      width: W,
      height: H,
      // 가상 화면 밖 — 렌더는 되지만 사용자 눈에는 안 보인다(실앱이 떠 있는 데스크톱이다)
      x: -4200,
      y: 0,
      show: false,
      frame: false,
      skipTaskbar: true,
      backgroundColor: '#101010',
      webPreferences: { backgroundThrottling: false }
    })
    await win.loadFile(j.src)
    trace('loaded')
    win.showInactive() // 포커스는 뺏지 않는다
    await new Promise((r) => setTimeout(r, 1500)) // 폰트 + ui-notify.js 계측
    const info = await win.webContents.executeJavaScript(`(() => {
      const sums = {}
      document.querySelectorAll('[data-sum]').forEach(e => { sums[e.dataset.sum] = e.textContent })
      const v = document.querySelector('[data-verdict]')
      return { sums, verdict: v ? v.textContent : null,
               scrollH: document.documentElement.scrollHeight, title: document.title }
    })()`)
    trace('measured ' + JSON.stringify(info.sums))
    // 문서 전체가 들어가게 창을 늘려 다시 찍는다 — 잘린 목업으로는 판정을 못 한다
    const full = Math.min(Math.max(info.scrollH + 40, H), 6000)
    if (full !== H) {
      win.setContentSize(W, full)
      win.setPosition(-4200, 0)
      await new Promise((r) => setTimeout(r, 900))
    }
    const img = await win.webContents.capturePage()
    fs.mkdirSync(path.dirname(j.out), { recursive: true })
    fs.writeFileSync(j.out, img.toPNG())
    trace('shot ' + j.out)
    out.push({ src: j.src, out: j.out, ...info })
    win.destroy()
  }
  clearTimeout(bail)
  finish(0, out)
})
