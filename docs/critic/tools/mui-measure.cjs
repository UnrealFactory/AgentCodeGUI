// M-UI R1 크리틱 — 목업 페이지를 화면 밖에서 렌더해 **행 단위 높이·여백·정보량**을 뽑는다.
//
// 왜 shot-html.mjs로 부족한가: 그 하네스는 페이지가 스스로 찍은 합계([data-sum])만 회수한다.
// 합계가 어디서 왔는지(형태에서 온 이득인지, A/B에 다르게 걸린 owl 규칙에서 온 이득인지,
// 문장을 짧게 써서 얻은 것인지)는 행 단위로 뜯어야 갈린다.
//
//   node_modules/electron/dist/electron.exe docs/critic/tools/mui-measure.cjs
//   (환경변수 MEAS_FILES=<html;html;...>  MEAS_OUT=<json>)
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const FILES = (process.env.MEAS_FILES || '').split(';').filter(Boolean)
const OUT = process.env.MEAS_OUT || path.join(process.cwd(), 'mui-measure.json')
const TRACE = OUT + '.trace'
const trace = (s) => { try { fs.appendFileSync(TRACE, new Date().toISOString() + ' ' + s + '\n') } catch {} }

const JS = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim()
  const out = { panes: {}, sums: {}, verdict: null }
  document.querySelectorAll('[data-sum]').forEach(e => { out.sums[e.dataset.sum] = e.textContent })
  const v = document.querySelector('[data-verdict]'); out.verdict = v ? v.textContent : null
  document.querySelectorAll('.pane[data-k]').forEach(p => {
    const k = p.dataset.k
    const th = p.querySelector('.thread')
    if (!th) return
    const rows = [...th.children].map(el => {
      const cs = getComputedStyle(el)
      const txt = clean(el.textContent)
      return {
        cls: el.className,
        h: Math.round(el.getBoundingClientRect().height * 10) / 10,
        mt: Math.round((parseFloat(cs.marginTop) || 0) * 10) / 10,
        chars: txt.length,
        digits: (txt.match(/[0-9]/g) || []).length,
        buttons: el.querySelectorAll('button').length,
        text: txt.slice(0, 46)
      }
    })
    const thr = th.getBoundingClientRect().height
    const cs = getComputedStyle(th)
    out.panes[k] = {
      threadH: Math.round(thr * 10) / 10,
      padY: (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0),
      sumMt: Math.round(rows.reduce((a, r) => a + r.mt, 0) * 10) / 10,
      sumH: Math.round(rows.reduce((a, r) => a + r.h, 0) * 10) / 10,
      chars: rows.reduce((a, r) => a + r.chars, 0),
      digits: rows.reduce((a, r) => a + r.digits, 0),
      buttons: rows.reduce((a, r) => a + r.buttons, 0),
      rows
    }
  })
  return JSON.stringify(out)
})()`

app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

// 하드 타임아웃 — 이게 없으면 loadFile 거절 한 번에 프로세스가 영원히 산다(실측으로 밟았다).
const res = []
function finish(code) {
  try { fs.writeFileSync(OUT, JSON.stringify(res, null, 1)) } catch (e) { trace('write fail ' + e.message) }
  app.exit(code)
}
const bail = setTimeout(() => { trace('HARD TIMEOUT'); finish(3) }, 30000 * Math.max(1, FILES.length) + 10000)
process.on('uncaughtException', (e) => { trace('uncaught ' + e.stack); finish(4) })
process.on('unhandledRejection', (e) => { trace('unhandled ' + (e && e.stack)); finish(5) })

app.whenReady().then(async () => {
  for (const f of FILES) {
    const abs = path.resolve(process.cwd(), f)
    trace('open ' + abs)
    const win = new BrowserWindow({
      width: 1820, height: 1400, x: -4200, y: 0, show: false, frame: false,
      skipTaskbar: true, backgroundColor: '#101010', webPreferences: { backgroundThrottling: false }
    })
    try {
      await win.loadFile(abs)
      trace('loaded')
      win.showInactive()
      await new Promise((r) => setTimeout(r, 1600))
      const json = await win.webContents.executeJavaScript(JS)
      res.push({ file: f, ...JSON.parse(json) })
      trace('measured ' + f)
    } catch (e) {
      trace('fail ' + f + ' ' + e.message)
      res.push({ file: f, error: e.message })
    }
    win.destroy()
  }
  clearTimeout(bail)
  finish(0)
})
