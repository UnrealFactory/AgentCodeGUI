// Real Codex inventory/config round trips + GUI, without a model request.
// node scripts/poc-codex-tooling.mjs --codex=<native codex.exe> [--exe=...]
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, quietHome, REPO, sleep } from '../bench/lib.mjs'

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const codex = arg('codex')
assert(codex && fs.existsSync(codex), 'Pass --codex=<native executable>')
const exe = path.resolve(arg('exe') ?? 'target/debug/agentcodegui.exe')
const home = fs.mkdtempSync(path.join(REPO, '.poc-home-codex-tooling-'))
const work = path.join(home, 'work')
const native = path.join(home, 'native')
const port = 19387
const write = (name, value) => {
  const file = path.join(home, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
quietHome(home)
write('native/skills/native-review/SKILL.md', '---\nname: native-review\ndescription: Native imported skill\n---\nReview files.\n')
write('work/.agents/skills/project-review/SKILL.md', '---\nname: project-review\ndescription: Project Codex skill\n---\nReview this project.\n')
write('work/.claude/skills/claude-only/SKILL.md', '---\nname: claude-only\ndescription: Claude only\n---\nClaude.\n')
write('native/mcp.mjs', `import readline from 'node:readline';
const reply = (id,result) => console.log(JSON.stringify({jsonrpc:'2.0',id,result}));
readline.createInterface({input:process.stdin}).on('line',line=>{try { const m=JSON.parse(line);
if(m.id===undefined)return;
if(m.method==='initialize')reply(m.id,{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
else if(m.method==='tools/list')reply(m.id,{tools:[{name:'fixture_read',description:'Fixture',inputSchema:{type:'object',properties:{}}}]});
else reply(m.id,{});
} catch {}});`)
const quote = s => JSON.stringify(s.replaceAll('\\', '/'))
write('native/config.toml', `[mcp_servers."fixture.docs"]\ncommand = ${quote(process.execPath)}\nargs = [${quote(path.join(native, 'mcp.mjs'))}]\n`)
write('work/.codex/config.toml', `[mcp_servers."fixture.project"]\ncommand = ${quote(process.execPath)}\nargs = [${quote(path.join(native, 'mcp.mjs'))}]\n`)
write('codex/api-key/config.toml', `[projects.${JSON.stringify(work)}]\ntrust_level = "trusted"\n`)
write('api-config.json', { openaiKey: 'sk-fixture-no-model-requests', openaiEnc: false })
write('ui-prefs.json', { 'ui.lang': 'en', 'workspace.mode': 'multi' })
write('profile.json', { nickname: 'Codex tooling regression' })
write('multi-agent/index.json', { version: 2, order: ['tools'], activeSessionId: 'tools' })
write('multi-agent/tools.json', { id: 'tools', title: 'Codex tooling', count: 1, panels: [{ title: 'Codex tools', cwd: work, api: true,
  picker: { engine: 'codex', codexModel: 'gpt-5.6-terra', model: 'opus', effort: 'medium', mode: 'normal' }, snapshot: { messages: [] } }] })
let cdp
const app = spawn(exe, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, CCG_HOME: home, CCG_NO_NET: '1',
  CCG_CODEX_BIN: codex, CCG_CODEX_IMPORT_HOME: native, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } })
try {
  cdp = await connectMainPage(port)
  const evaluate = expr => cdp.eval(`(async()=>(${expr}))()`, { awaitPromise: true, timeoutMs: 50000 })
  const ipc = (channel, payload) => evaluate(`window.__TAURI_INTERNALS__.invoke('ipc_call',${JSON.stringify({ channel, payload: [payload] })})`)
  const until = async expr => {
    const end = Date.now() + 30000
    while (Date.now() < end) { if (await evaluate(expr)) return; await sleep(100) }
    console.log(await evaluate('document.body.innerText.slice(-2500)'))
    throw new Error(`Timed out: ${expr}`)
  }
  await until('!!window.api && !!document.querySelector(".ma-panel .composer textarea")')
  const context = { cwd: work, apiMode: true }
  let list = await ipc('codex:tooling', context)
  console.log('inventory', JSON.stringify({ mcp: list.mcp, skills: list.skills?.map(s => s.name), errors: list.errors, error: list.error }))
  assert(!list.error, list.error)
  assert.deepEqual(list.errors, [])
  assert(list.skills.some(s => s.name === 'native-review'))
  assert(list.skills.some(s => s.name === 'project-review'))
  assert(!list.skills.some(s => s.name === 'claude-only'))
  assert(list.mcp.some(m => m.name === 'fixture.docs'))
  assert.equal(list.mcp.find(m => m.name === 'fixture.docs')?.scope, 'global')
  assert.equal(list.mcp.find(m => m.name === 'fixture.project')?.scope, 'local')
  const skill = list.skills.find(s => s.name === 'native-review')
  assert.equal((await ipc('codex:tooling-set-enabled', { ...context, kind: 'skill', name: skill.path, enabled: false })).ok, true)
  assert.equal((await ipc('codex:tooling-set-enabled', { ...context, kind: 'mcp', name: 'fixture.docs', enabled: false })).ok, true)
  list = await ipc('codex:tooling', context) // another home materialization/process
  assert.equal(list.skills.find(s => s.path === skill.path).off, true)
  assert.equal(list.mcp.find(s => s.name === 'fixture.docs').status, 'off')
  const otherHome = await ipc('codex:tooling', { cwd: work, apiMode: false })
  assert.notEqual(otherHome.mcp.find(s => s.name === 'fixture.docs').status, 'off', 'API config must not disable another account home')
  assert.equal((await ipc('codex:tooling-set-enabled', { ...context, kind: 'skill', name: skill.path, enabled: true })).ok, true)
  assert.equal((await ipc('codex:tooling-set-enabled', { ...context, kind: 'mcp', name: 'fixture.docs', enabled: true })).ok, true)
  list = await ipc('codex:tooling', context)
  assert.equal(list.skills.find(s => s.path === skill.path).off, false)
  assert.notEqual(list.mcp.find(s => s.name === 'fixture.docs').status, 'off')
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('MCP & SKILL')).click()`)
  await until(`document.body.innerText.includes('$native-review') && document.body.innerText.includes('$project-review')`)
  assert(!(await evaluate(`document.querySelector('.wb-pop.hpop')?.innerText.includes('claude-only')`)))
  const filter = label => evaluate(`Array.from(document.querySelectorAll('.wb-pop.hpop .pp-filt')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`)
  const popover = () => evaluate(`document.querySelector('.wb-pop.hpop').innerText`)
  // Both -> local only -> global only -> both. Click the real filter buttons.
  await filter('Global')
  let visible = await popover()
  assert(visible.includes('fixture.project') && visible.includes('$project-review'))
  assert(!visible.includes('fixture.docs') && !visible.includes('$native-review'))
  await filter('Global')
  await filter('Local')
  visible = await popover()
  assert(visible.includes('fixture.docs') && visible.includes('$native-review'))
  assert(!visible.includes('fixture.project') && !visible.includes('$project-review'))
  await filter('Local')
  visible = await popover()
  assert(visible.includes('fixture.project') && visible.includes('fixture.docs'))
  await evaluate(`document.querySelector('[aria-label="Turn off $native-review"]').click()`)
  await until(`document.querySelector('[aria-label="Turn on $native-review"]')?.getAttribute('aria-checked') === 'false' && document.body.innerText.includes('Saved.')`)
  list = await ipc('codex:tooling', context)
  assert.equal(list.skills.find(s => s.path === skill.path).off, true, 'GUI switch must reach native settings')
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await evaluate(`(()=>{const ta=document.querySelector('.ma-panel .composer textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(ta,'$project');ta.dispatchEvent(new Event('input',{bubbles:true}));})()`)
  await until(`!!document.querySelector('.slash-opt') && document.querySelector('.slash-menu').innerText.includes('project-review')`)
  await evaluate(`document.querySelector('.slash-opt').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`)
  assert.equal(await evaluate(`document.querySelector('.ma-panel .composer textarea').value`), '$project-review ')
  console.log(JSON.stringify({ passed: true, home, checks: ['native import', 'project skills', 'engine isolation', 'MCP switches', 'skill switches', 'persistence', 'GUI inventory', 'local/global filter clicks', '$ skill palette'] }))
} finally {
  cdp?.close()
  killTree(app.pid)
}
