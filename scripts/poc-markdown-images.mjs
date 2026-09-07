// Verify inline local images and their file-viewer links in the real Tauri renderer.
// Starts an isolated fixture profile and a Vite server if one is not already running.
// node scripts/poc-markdown-images.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'
import { connectMainPage, killTree, quietHome, REPO, sleep } from '../bench/lib.mjs'

const home = quietHome(fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-markdown-images-')))
const work = path.join(home, 'work')
const port = 19392
const write = (name, value) => {
  const file = path.join(home, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value))
}
write('work/art/시안 #1 100%.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500"><rect width="900" height="500" fill="#294f64"/><circle cx="450" cy="250" r="140" fill="#b1ddbd"/></svg>')
write('work/art/sample.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
write('work/docs/gallery.md', '# Relative image in a Markdown file\n\n![Document image](../art/시안%20%231%20100%25.svg)')
const svg = path.join(work, 'art/시안 #1 100%.svg')
const png = path.join(work, 'art/sample.png')
const cases = [
  ['Absolute PNG', png.replaceAll('\\', '/')],
  ['Windows backslashes', png.replaceAll('\\', '\\\\')],
  ['File URI with special characters', pathToFileURL(svg).href],
  ['Leading slash', '/' + png.replaceAll('\\', '/')],
  ['Relative PNG', 'art/sample.png'],
  ['Relative SVG with special characters', 'art/시안%20%231%20100%25.svg']
]
const text = cases.map(([label, src]) => `![${label}](<${src}>)`).join('\n\n')
write('ui-prefs.json', { 'ui.lang': 'en', 'workspace.mode': 'multi' })
write('profile.json', { nickname: 'Image regression' })
write('multi-agent/index.json', { version: 2, order: ['images'], activeSessionId: 'images' })
write('multi-agent/images.json', { id: 'images', title: 'Inline images', count: 1, panels: [{ title: 'Inline images', cwd: work,
  snapshot: { status: 'done', messages: [
    { kind: 'msg', id: 'old', role: 'assistant', animate: false, text },
    { kind: 'msg', id: 'new', role: 'assistant', animate: false, text: text + '\n\n[Image document](docs/gallery.md)\n\n![Missing](art/missing.png)\n\n![Blocked](javascript:alert%281%29)\n\n[Website](https://example.com/)\n\n[Blocked link](javascript:alert%281%29)' }
  ] }
}] })
let server, child, cdp
try {
  if (!await fetch('http://localhost:5273', { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false)) {
    server = await createServer({ configFile: path.join(REPO, 'app/vite.config.ts') })
    await server.listen()
  }
  child = spawn(path.join(REPO, 'target/debug/agentcodegui.exe'), [], { windowsHide: true, stdio: 'ignore', env: {
    ...process.env, CCG_HOME: home, CCG_NO_NET: '1', CCG_CDP_PORT: String(port), CCG_CODEX_IMPORT_HOME: path.join(home, 'empty-codex')
  } })
  cdp = await connectMainPage(port)
  const evaluate = expr => cdp.eval(expr, { awaitPromise: true })
  const until = async expr => {
    const end = Date.now() + 20000
    while (Date.now() < end) { if (await evaluate(expr)) return; await sleep(70) }
    throw new Error('Timed out: ' + expr + '\n' + await evaluate('document.body.innerText.slice(-1000)'))
  }
  await until(`document.querySelectorAll('.thread img.md-image').length >= 12`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Get started')?.click()`)
  // Fresh profiles can show an engine-install prompt; no engine is used by this test.
  await evaluate(`document.querySelector('.set-dialog .sd-cancel')?.click()`)
  const image = (label, index) => `Array.from(document.querySelectorAll('.thread img.md-image')).filter(i=>i.alt===${JSON.stringify(label)})[${index}]`
  const originalUrl = await evaluate('location.href')
  for (const index of [0, 1]) {
    for (const [label] of cases) {
      const el = image(label, index)
      await evaluate(`${el}.scrollIntoView({block:'center'})`)
      await until(`${el}?.complete && ${el}.naturalWidth > 0`)
      assert((await evaluate(`${el}.src`)).startsWith('http://ccg-img.localhost/'))
      assert(await evaluate(`${el}.getBoundingClientRect().width <= ${el}.closest('.content').getBoundingClientRect().width + 1`))
      await evaluate(`${el}.click()`)
      await until(`document.querySelector('.fv-imgel')?.naturalWidth > 0`)
      await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
      await until(`!document.querySelector('.fv-overlay')`)
      console.log(`PASS ${index ? 'latest' : 'older'}: ${label} loads inline and opens in the viewer`)
    }
  }
  const target = image('Absolute PNG', 1)
  await evaluate(`${target}.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`)
  await until(`document.querySelector('.fv-imgel')?.naturalWidth > 0`)
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await until(`!document.querySelector('.fv-overlay')`)
  await evaluate(`Array.from(document.querySelectorAll('.thread a')).find(a=>a.textContent==='Image document').click()`)
  await until(`document.querySelector('.fv-md img.md-image')?.naturalWidth === 900`)
  console.log('PASS keyboard activation and document-relative images')
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await evaluate(`document.querySelector('.thread .md-image-error')?.scrollIntoView({block:'center'})`)
  await until(`Array.from(document.querySelectorAll('.md-image-error')).some(e=>e.textContent.includes('Missing'))`)
  assert(await evaluate(`Array.from(document.querySelectorAll('.md-image-error')).some(e=>e.textContent.includes('Blocked'))`))
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.thread a')).find(a=>a.textContent==='Website').getAttribute('href')`), 'https://example.com/')
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.thread a')).find(a=>a.textContent==='Blocked link').getAttribute('href')`), '')
  assert.equal(await evaluate('location.href'), originalUrl)
  console.log('PASS missing-image fallback, external links and unsafe URL filtering')
  console.log(JSON.stringify({ ok: true, home }))
} finally {
  cdp?.close()
  if (child?.pid) killTree(child.pid)
  await server?.close()
}
