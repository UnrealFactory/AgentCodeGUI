// Provider/account selection + Git and translation IPC against synthetic Claude/Codex processes.
// Requires Vite, cargo build -p agentcodegui, ccg-auth-probe and both fake CLI binaries.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { REPO, quietHome, connectMainPage, sleep, killTree } from '../bench/lib.mjs'
import { testTranslation } from './poc-translation-scenarios.mjs'

const home = fs.mkdtempSync(path.join(REPO, '.poc-home-git-ai-'))
quietHome(home)
const work = path.join(home, 'repo with spaces')
const first = 'default@openai.test'
const selected = 'selected@openai.test'
const claude = 'writer@anthropic.test'
const write = (name, value) => {
  const file = path.join(home, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}
const run = (file, args, opts = {}) => {
  const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, ...opts })
  assert.equal(r.status, 0, r.stderr || r.stdout)
  return r.stdout.trim()
}
write('synthetic-auth.json', { tokens: { account_id: 'synthetic', access_token: 'synthetic-only' } })
const ps = `Add-Type -AssemblyName System.Security
[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([IO.File]::ReadAllBytes('${path.join(home, 'synthetic-auth.json').replaceAll("'", "''")}'),$null,'CurrentUser'))`
const authEnc = run('powershell', ['-NoProfile', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')])
write('codex-accounts.json', { version: 1, accounts: [first, selected].map(email => ({ email, plan: 'plus', authEnc })) })
run(path.join(REPO, 'target/debug/ccg-auth-probe.exe'), ['seed', claude], { env: { ...process.env, CCG_HOME: home, CCG_NO_NET: '1' } })
const claudeBin = 'engines/fixture/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'
write(claudeBin, '')
fs.copyFileSync(path.join(REPO, 'target/debug/ccg-fakecli.exe'), path.join(home, claudeBin))
write('config.json', { activeVersion: 'fixture' })
write('ui-prefs.json', { 'ui.lang': 'en', 'whatsnew.seenVersion': '99.0.0', 'git.ai.model': 'sonnet' })
write('repo with spaces/a.txt', 'before\n')
const git = (...args) => run('git', args, { cwd: work })
git('init', '-q')
git('config', 'user.email', 'fixture@test')
git('config', 'user.name', 'Fixture')
git('add', 'a.txt')
git('commit', '-qm', 'feat: fixture baseline')
write('repo with spaces/a.txt', 'after\n')
const beforeStatus = git('status', '--porcelain')
const beforeHead = git('rev-parse', 'HEAD')
const chatIds = ['translation-openai', 'translation-claude', 'translation-api']
write('api-config.json', { key: 'synthetic-anthropic-key', enc: false, openaiKey: 'synthetic-openai-key', openaiEnc: false })
write('chats-v3/index.json', { version: 1, order: chatIds, activeChatId: chatIds[0], migrationComplete: true })
for (const [i, id] of chatIds.entries()) write(`chats-v3/${id}.json`, {
  id, title: 'Translation fixture', origin: 'panel', identity: {
    engine: { kind: i === 1 ? 'claude' : 'codex', model: i === 1 ? 'sonnet' : 'gpt-5.6-terra', effort: 'low', codexAccount: selected },
    billing: { kind: i === 2 ? 'api_key' : 'subscription', account: claude, dropEnvKey: true }, cwd: work, addDirs: [], mode: 'normal',
    tools: { skillOverrides: {}, deniedMcp: [] }
  }, snapshot: { messages: [] }
})
write('boards/index.json', { version: 1, order: ['translation-board'], activeBoardId: 'translation-board' })
write('boards/translation-board.json', { id: 'translation-board', title: 'Translation fixture', count: 2, order: [0,1,2,3,4,5], slots: [...chatIds, null, null, null] })
// Exercise Windows launcher wrappers and record only the synthetic execution identity.
write('codex.cmd', `@echo off\r\n> "${path.join(home, 'codex-home.txt')}" echo %CODEX_HOME%\r\n> "${path.join(home, 'codex-key.txt')}" echo [%OPENAI_API_KEY%]\r\n"${path.join(REPO, 'target/debug/ccg-fakecodex.exe')}"\r\n`)
const init = [
  { await: 'initialize', result: {} },
  { await: 'config/read', result: { config: { mcp_servers: { fixture: { command: 'unused' } } } } },
  { await: 'thread/start', result: { thread: { id: 'git-thread' } } },
  { await: 'turn/start', result: { turn: { id: 'git-turn' } } }
]
const frames = steps => write('codex.jsonl', [...init, ...steps].map(v => JSON.stringify(v)).join('\n'))
frames([
  { emit: { method: 'item/completed', params: { threadId: 'git-thread', item: { type: 'agentMessage', phase: 'commentary', text: 'Thinking…' } } } },
  { emit: { method: 'item/completed', params: { threadId: 'git-thread', item: { type: 'agentMessage', phase: 'final_answer', text: '<commit>feat: GPT message\n\nGenerated from the selected diff.</commit>' } } } },
  { emit: { method: 'turn/completed', params: { threadId: 'git-thread', turn: { status: 'completed' } } } }
])
write('claude.jsonl', [
  { emit: { type: 'result', result: '<commit>feat: Claude message</commit>', is_error: false } }, { exit: 0 }
].map(v => JSON.stringify(v)).join('\n'))

const app = spawn(path.join(REPO, 'target/debug/agentcodegui.exe'), [], { windowsHide: true, stdio: 'ignore', env: {
  ...process.env, CCG_HOME: home, CCG_NO_NET: '1', CCG_CODEX_BIN: path.join(home, 'codex.cmd'),
  CCG_CODEX_IMPORT_HOME: path.join(home, 'empty-native'), OPENAI_API_KEY: 'synthetic-must-be-removed',
  CCG_FAKECODEX_SCRIPT: path.join(home, 'codex.jsonl'), CCG_FAKECODEX_IN: path.join(home, 'codex-input.jsonl'),
  CCG_FAKECLI_SCRIPT: path.join(home, 'claude.jsonl'), CCG_FAKECLI_ARGV: path.join(home, 'claude-argv.json'),
  CCG_FAKECLI_IN: path.join(home, 'claude-input.jsonl'),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=19417'
} })
let cdp
const evaluate = expr => cdp.eval(`(async()=>(${expr}))()`, { awaitPromise: true, timeoutMs: 20000 })
const until = async expr => {
  const end = Date.now() + 15000
  while (Date.now() < end) { if (await evaluate(expr)) return; await sleep(100) }
  throw new Error(`Timed out: ${expr}\n${await evaluate('document.body.innerText.slice(-1800)')}`)
}
const clickText = (selector, text) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`)
const open = () => evaluate(`document.querySelector('.gitm-btn.claude').click()`)
const pick = name => clickText('.qopt .ql', name)
const subject = () => evaluate(`document.querySelector('.gitm-compose input').value`)
const ipc = opts => evaluate(`window.api.git.aiMessage(${JSON.stringify(work)},['a.txt'],${JSON.stringify(opts)})`)

try {
  cdp = await connectMainPage(19417)
  await until('!!window.api')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 950, deviceScaleFactor: 1, mobile: false })
  await evaluate(`(async()=>{
    window.api.auth.accountsUsage=async()=>[{email:${JSON.stringify(claude)},fiveHourPct:12,weeklyPct:20,fablePct:null}];
    window.api.codexAuth.accountsUsage=async()=>${JSON.stringify([first, selected].map((email, i) => ({ email, planType: 'plus', windows: [{ label: 'Weekly', usedPct: i ? 25 : 80 }] })))};
    window.api.codexModels=async()=>[
      {id:'gpt-5.6-terra',label:'GPT-5.6-Terra',desc:'',efforts:['low','high'],defaultEffort:'low',isDefault:true,tiers:[{id:'priority',name:'Fast',desc:'1.5x speed, increased usage'}]},
      {id:'gpt-5.6-sol',label:'GPT-5.6-Sol',desc:'',efforts:['low','high'],defaultEffort:'low',isDefault:false,tiers:[{id:'priority',name:'Fast',desc:'1.5x speed, increased usage'},{id:'ultrafast',name:'Ultrafast',desc:'Fastest responses'}]},
      {id:'gpt-5.6-luna',label:'GPT-5.6-Luna',desc:'',efforts:['low','high'],defaultEffort:'low',isDefault:false,tiers:[]}
    ];
    const source=await (await fetch('/src/components/GitModal.tsx')).text();
    const entry=await (await fetch('/src/main.tsx')).text();
    const {default:React}=await import(source.match(/from "([^"]*react[.]js[^"]*)"/)[1]);
    const {default:{createRoot}}=await import(entry.match(/from "([^"]*react-dom_client.js[^"]*)"/)[1]);
    const {GitModal}=await import('/src/components/GitModal.tsx');
    document.querySelector('#root').style.display='none';
    const host=document.createElement('div'); document.body.append(host);
    window.__gitRoot=createRoot(host);
    window.__gitRoot.render(React.createElement(GitModal,{cwd:${JSON.stringify(work)},refreshKey:0,onClose:()=>{},onOpenFile:()=>{}}));
  })()`)
  await until(`document.querySelector('.gitm-btn.claude')?.disabled===false`)
  await open()
  await until(`document.querySelector('.qbl')?.textContent.includes('Provider')`)
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.qopt .ql')].map(b=>b.textContent)`), ['Anthropic', 'OpenAI'])
  await pick('OpenAI')
  await until(`document.querySelector('.qopts')?.textContent.includes(${JSON.stringify(selected)})`)
  assert(!(await evaluate(`document.querySelector('.qopts').textContent`)).includes(claude))
  assert((await evaluate(`document.querySelector('.qopts').textContent`)).includes('75% left'))
  await pick(selected)
  await until(`document.querySelector('.gai-seg')?.textContent.includes('GPT')`)
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.gai-seg')[1].querySelectorAll('button')].map(b=>b.textContent)`), ['Low', 'High'])
  await clickText('.gai-seg button', 'High')
  await clickText('.qgo', 'Write')
  await until(`document.querySelector('.gitm-compose input')?.value==='feat: GPT message'`)
  const usedHome = fs.readFileSync(path.join(home, 'codex-home.txt'), 'utf8').trim()
  assert.equal(path.dirname(usedHome), path.join(home, 'codex/accounts'))
  assert(path.basename(usedHome).startsWith('selected_openai.test-'), usedHome)
  assert.equal(fs.readFileSync(path.join(home, 'codex-key.txt'), 'utf8').trim(), '[]')
  const wire = fs.readFileSync(path.join(home, 'codex-input.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const thread = wire.find(v => v.method === 'thread/start').params
  const turn = wire.find(v => v.method === 'turn/start').params
  assert.equal(thread.model, 'gpt-5.6-terra')
  assert.equal(thread.ephemeral, true)
  assert.equal(thread.sandbox, 'read-only')
  assert.equal(thread.config.mcp_servers.fixture.enabled, false)
  assert.equal(turn.effort, 'high')
  assert(turn.input[0].text.includes('+after') && turn.input[0].text.includes('feat: fixture baseline'))
  assert.equal(git('status', '--porcelain'), beforeStatus)
  assert.equal(git('rev-parse', 'HEAD'), beforeHead)
  console.log('PASS: provider → account → GPT model/effort → native message; account isolation; Git unchanged')

  await open()
  await pick('Anthropic')
  await until(`document.querySelector('.qopts')?.textContent.includes(${JSON.stringify(claude)})`)
  assert(!(await evaluate(`document.querySelector('.qopts').textContent`)).includes(selected))
  await pick(claude + ' · default')
  await until(`document.querySelector('.gai-seg')?.textContent.includes('Sonnet')`)
  assert.equal(await evaluate(`document.querySelector('.gai-seg button.on').textContent`), 'Sonnet')
  await clickText('.qgo', 'Write')
  await until(`document.querySelector('.gitm-compose input')?.value==='feat: Claude message'`)
  assert(fs.readFileSync(path.join(home, 'claude-argv.json'), 'utf8').includes('sonnet'))
  console.log('PASS: Anthropic account/model selection still generates a message')

  await open()
  await pick('OpenAI')
  await until(`document.querySelector('.qopt.on .ql')?.textContent===${JSON.stringify(selected)}`)
  await pick(selected)
  await until(`document.querySelectorAll('.gai-seg button.on').length===2`)
  assert.equal(await evaluate(`[...document.querySelectorAll('.gai-seg button.on')].at(-1).textContent`), 'High')
  frames([{ emit: { method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Partial response' } } } },
    { emit: { method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'Synthetic rate limit' } } } } }])
  await clickText('.qgo', 'Write')
  await until(`document.querySelector('.gitm-overlay')?.textContent.includes('Synthetic rate limit')`)
  assert.equal(await subject(), 'feat: Claude message')
  assert.equal((await ipc({ engine: 'codex', account: 'missing@test' })).ok, false)
  assert.equal((await ipc({ engine: 'unsupported', account: selected })).ok, false)
  frames([{ emit: { id: 77, method: 'item/commandExecution/requestApproval', params: {} } }])
  assert.equal((await ipc({ engine: 'codex', account: selected })).ok, false)
  console.log('PASS: provider preferences; failed/partial generation preserves text; missing accounts and approvals fail')

  // A slow provider response must not replace the next provider's list.
  await evaluate(`window.api.auth.listAccounts=()=>new Promise(r=>setTimeout(()=>r([{email:'late@anthropic.test',isDefault:true}]),800))`)
  await open()
  await pick('Anthropic')
  await until(`document.querySelector('.qbl')?.textContent.includes('Account')`)
  await clickText('.qback', 'Choose provider again')
  await pick('OpenAI')
  await until(`document.querySelector('.qopts')?.textContent.includes(${JSON.stringify(selected)})`)
  await sleep(1000)
  assert(!(await evaluate(`document.querySelector('.qopts').textContent`)).includes('late@anthropic.test'))
  await cdp.send('Page.captureScreenshot', { format: 'png' }).then(r => fs.writeFileSync(path.join(home, 'accounts.png'), Buffer.from(r.data, 'base64')))
  console.log('PASS: late account responses cannot cross providers')
  const prefs = JSON.parse(fs.readFileSync(path.join(home, 'ui-prefs.json'), 'utf8'))
  assert.equal(prefs['git.ai.account'], claude)
  assert.equal(prefs['git.ai.model'], 'sonnet')
  assert.equal(prefs['git.ai.codex.account'], selected)
  assert.equal(prefs['git.ai.codex.effort'], 'high')
  await clickText('.qback', 'Choose provider again')
  await evaluate('window.api.codexAuth.listAccounts=async()=>[]')
  await pick('OpenAI')
  await until(`document.querySelector('.qopts')?.textContent.includes('No OpenAI accounts yet')`)
  assert.equal(await evaluate(`document.querySelectorAll('.qopts .qopt, .qgo').length`), 0)
  console.log('PASS: provider preferences persist separately; empty provider cannot generate')

  await testTranslation({ evaluate, until, clickText, cdp, home, selected, claude, write, frames })
  console.log(`Artifacts: ${home}`)
} finally {
  cdp?.close()
  await killTree(app.pid)
}
