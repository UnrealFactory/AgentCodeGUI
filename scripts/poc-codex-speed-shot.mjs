// dev 앱(CCG_CDP_PORT=9411)에 붙어 picker → OpenAI → 모델 행을 눌러 드로어(추론 + 속도 줄)를 스크린샷한다.
// 사용: node scripts/poc-codex-speed-shot.mjs [port] [outDir]
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { connectMainPage, sleep } from '../bench/lib.mjs'

const port = Number(process.argv[2] || 9411)
const outDir = process.argv[3] || os.tmpdir()
const cdp = await connectMainPage(port, { timeoutMs: 60000 })
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')

const js = (expr) => cdp.eval(expr, { awaitPromise: true })
const click = (finder) =>
  js(`(() => { const el = (${finder})(); if (!el) return 'MISSING'; el.click(); return 'ok' })()`)
const byText = (sel, text) =>
  `() => [...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))`

async function shot(name) {
  const clip = JSON.parse(await js(`(() => { const d = document.querySelector('.edrawer.open') || document.querySelector('.model-chip'); const p = d && (d.closest('[class*=pop]') || d); if (!p) return 'null'; const r = p.getBoundingClientRect(); return JSON.stringify({ x: r.left - 8, y: r.top - 8, width: r.width + 16, height: Math.min(r.height, 420) + 16, scale: 2 }) })()`))
  const { data } = await cdp.send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' })
  const p = path.join(outDir, name)
  fs.writeFileSync(p, Buffer.from(data, 'base64'))
  console.log('shot', p)
}

console.log('chip:', await click(`() => document.querySelector('.model-chip')`))
await sleep(400)
console.log('engine OpenAI:', await click(byText('.picker-pop button, .pp button, button', 'OpenAI')))
await sleep(600)
for (const model of ['GPT-5.6-Sol', 'GPT-6-Astra']) {
  console.log(`${model}:`, await click(byText('.pp-row', model)))
  await sleep(500)
  const speedTxt = await js(`(() => { const s = document.querySelector('.edrawer.open .espeed'); return s ? s.innerText.replace(/\\n/g, ' | ') : 'NO SPEED ROW' })()`)
  const rect = await js(`(() => { const d = document.querySelector('.edrawer.open'); if (!d) return 'no drawer'; const r = d.getBoundingClientRect(); const s = d.querySelector('.espeed'); const sr = s && s.getBoundingClientRect(); return JSON.stringify({ drawerH: r.height, speedH: sr && sr.height, speedBottomInside: sr ? sr.bottom <= r.bottom + 0.5 : null, scrollOverflow: s ? s.scrollWidth > s.clientWidth : null }) })()`)
  console.log('  speed row:', speedTxt, rect)
  await shot(`ccg-speed-${model.toLowerCase()}.png`)
}
// Fast를 눌러 칩 라벨이 바뀌는지
console.log('Fast:', await click(byText('.edrawer.open .eseg-b', 'Fast')))
await sleep(300)
console.log('chip label:', await js(`document.querySelector('.model-chip')?.innerText.replace(/\\n/g,' ')`))
await shot('ccg-speed-fast-on.png')
cdp.close()
