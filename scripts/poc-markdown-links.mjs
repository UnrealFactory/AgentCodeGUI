// Real WebView clicks must open the owning chat's file viewer, including the
// latest answer (SmoothMarkdown). Run with `npm run app:dev` already serving.
// node scripts/poc-markdown-links.mjs [--exe=target/debug/agentcodegui.exe]
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, quietHome, REPO, sleep } from '../bench/lib.mjs'

const exe = path.resolve(process.argv.find(a => a.startsWith('--exe='))?.slice(6) ?? 'target/debug/agentcodegui.exe')
const home = fs.mkdtempSync(path.join(REPO, '.poc-home-markdown-links-'))
const work = path.join(home, 'work')
const port = 19391
const write = (name, value) => {
  const file = path.join(home, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
quietHome(home)
write('work/docs/상세 제안서.md', '# PROPOSAL_CONTENT\n\nThe proposal opened from a chat link.\n')
write('work/docs/design #1.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="100"><rect width="180" height="100" fill="teal"/></svg>')
const proposal = path.join(work, 'docs/상세 제안서.md')
const svg = path.join(work, 'docs/design #1.svg')
const cases = [
  ['상세 제안서', proposal.replaceAll('\\', '/')],
  // Escape Markdown punctuation: a raw backslash before the fixture's .poc-home
  // would escape the dot itself and describe a different filename.
  ['Windows backslashes', proposal.replaceAll('\\', '\\\\')],
  ['File URI', pathToFileURL(proposal).href],
  ['Relative document', 'docs/상세%20제안서.md'],
  ['Leading slash', '/' + proposal.replaceAll('\\', '/')],
  ['Line suffix', proposal.replaceAll('\\', '/') + ':12:3'],
  ['Line fragment', 'docs/상세%20제안서.md#L12'],
  ['SVG 시안 열기', pathToFileURL(svg).href],
  ['Relative SVG', 'docs/design%20%231.svg']
]
const links = cases.map(([label, href]) => `[${label}](<${href}>)`).join('\n\n')
write('ui-prefs.json', { 'ui.lang': 'en', 'workspace.mode': 'multi' })
write('profile.json', { nickname: 'Markdown link regression' })
write('multi-agent/index.json', { version: 2, order: ['links'], activeSessionId: 'links' })
write('multi-agent/links.json', {
  id: 'links', title: 'Markdown links', count: 1,
  panels: [{ title: 'Markdown links', cwd: work,
    snapshot: { messages: [
      { kind: 'msg', id: 'older', role: 'assistant', text: links, animate: false },
      { kind: 'msg', id: 'latest', role: 'assistant', text: links + '\n\n[Website](https://example.com/reference)\n\n[Blocked](javascript:alert%281%29)', animate: false }
    ] } }]
})
let cdp
const app = spawn(exe, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
  CCG_HOME: home, CCG_NO_NET: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } })
try {
  cdp = await connectMainPage(port)
  const evaluate = expr => cdp.eval(`(async()=>(${expr}))()`, { awaitPromise: true })
  const until = async expr => {
    const end = Date.now() + 20000
    while (Date.now() < end) { if (await evaluate(expr)) return; await sleep(100) }
    throw new Error(`Timed out: ${expr}\n${await evaluate('document.body.innerText.slice(-1600)')}`)
  }
  const anchor = (label, index) => `Array.from(document.querySelectorAll('.thread .content a')).filter(a=>a.textContent===${JSON.stringify(label)})[${index}]`
  const click = async (label, index, button = 'left') => {
    const location = `(()=>{const el=${anchor(label, index)}; if(!el)return null;
      el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();
      const x=r.x+r.width/2,y=r.y+r.height/2;
      return el.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`
    await until(location)
    const point = await evaluate(location)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: 1 })
  }
  const closeViewer = async () => {
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    await until(`!document.querySelector('.fv-overlay')`)
  }
  await until(`!!${anchor('SVG 시안 열기', 1)}`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Get started')?.click()`)
  await until(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Later')`)
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Later').click()`)
  await evaluate(`(()=>{window.__linkUrls=[];window.api.openExternal=async url=>{window.__linkUrls.push(url);return true;};})()`)
  const originalUrl = await evaluate('location.href')
  console.log(`Testing ${originalUrl}`)
  for (const index of [0, 1]) {
    for (const [label] of cases) {
      assert(await evaluate(`${anchor(label, index)}.getAttribute('href')`), `${label} retains its destination`)
      await click(label, index)
      if (label.includes('SVG')) {
        await until(`(()=>{const img=document.querySelector('.fv-imgel');return img?.complete&&img.naturalWidth===180;})()`)
      } else {
        await until(`document.querySelector('.fv-md')?.textContent.includes('PROPOSAL_CONTENT')`)
      }
      await closeViewer()
      console.log(`PASS ${index ? 'latest' : 'older'}: ${label}`)
    }
  }
  await click('Relative document', 1, 'middle')
  await until(`document.querySelector('.fv-md')?.textContent.includes('PROPOSAL_CONTENT')`)
  await closeViewer()
  await evaluate(`${anchor('Relative document', 1)}.focus()`)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await until(`document.querySelector('.fv-md')?.textContent.includes('PROPOSAL_CONTENT')`)
  await closeViewer()
  await click('Website', 0)
  assert.deepEqual(await evaluate('window.__linkUrls'), ['https://example.com/reference'])
  assert.equal(await evaluate(`${anchor('Blocked', 0)}.getAttribute('href')`), '')
  assert.equal(await evaluate('location.href'), originalUrl, 'File links never navigate the app')
  console.log('PASS middle click, keyboard activation, external routing, and URL sanitization')
  console.log(JSON.stringify({ ok: true, home }))
} finally {
  cdp?.close()
  killTree(app.pid)
}
