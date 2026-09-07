// Native IPC + actual reset UI against a local fake Codex server. No real accounts or resets.
// Requires app:dev on port 5273 and cargo build -p agentcodegui.
// node scripts/poc-codex-reset-credits.mjs [--keep]
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { connectMainPage, killTree, quietHome, sleep } from '../bench/lib.mjs'

const repo = process.cwd()
const home = fs.mkdtempSync(path.join(repo, 'node_modules/.cache/codex-reset-'))
const port = 19422
const email = 'reset-demo@example.test'
const other = 'other-demo@example.test'
const now = Math.floor(Date.now() / 1000)
const stateFile = path.join(home, 'server-state.json')
const logFile = path.join(home, 'requests.jsonl')
const write = (name, value) => fs.writeFileSync(path.join(home, name), typeof value === 'string' ? value : JSON.stringify(value))
quietHome(home)
write('ui-prefs.json', { 'ui.lang': 'ko', 'workspace.mode': 'multi' })
const credit = { id: 'earned-reset-1', resetType: 'codexRateLimits', status: 'available', grantedAt: now - 86400,
  expiresAt: now + 86400 * 12, title: '친구 초대 보상', description: 'Codex 사용 한도 초기화권' }
write('server-state.json', { accounts: { [email]: { count: 2, used: 100, credits: [credit] }, [other]: { count: 4, used: 64, credits: null } }, redeemed: {}, mode: 'normal' })
function seal(value) {
  write('synthetic-auth.json', JSON.stringify(value))
  const file = path.join(home, 'synthetic-auth.json').replaceAll("'", "''")
  const script = `Add-Type -AssemblyName System.Security\n[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([IO.File]::ReadAllBytes('${file}'),$null,'CurrentUser'))`
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
write('codex-accounts.json', { version: 1, accounts: [email, other].map(e => ({ email: e, plan: 'plus', authEnc: seal({ tokens: { account_id: e, access_token: 'synthetic-only' } }) })) })
write('fake-server.cjs', `
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const stateFile=${JSON.stringify(stateFile)},logFile=${JSON.stringify(logFile)};
let initialized=false;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); fs.appendFileSync(logFile,JSON.stringify({home:process.env.CODEX_HOME,...m})+'\\n');
 const reply=result=>console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
 if(m.method==='initialize')return reply({userAgent:'fixture'});
 if(m.method==='initialized'){initialized=true;return;}
 if(m.id==null)return;
 if(!initialized)throw new Error('Missing initialized notification');
 const state=JSON.parse(fs.readFileSync(stateFile)),email=JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME,'auth.json'))).tokens.account_id;
 const a=state.accounts[email];
 if(m.method==='account/rateLimits/read')return reply({rateLimits:{planType:'plus',primary:{usedPercent:a.used,windowDurationMins:300,resetsAt:${now + 3600}}},
   rateLimitResetCredits:a.count==null?null:{availableCount:a.count,credits:a.credits}});
 if(m.method!=='account/rateLimitResetCredit/consume')return reply({});
 if(state.mode==='unsupported')return console.log(JSON.stringify({id:m.id,error:{code:-32601,message:'Method not found'}}));
 const key=email+':'+m.params.idempotencyKey;
 if(state.redeemed[key])return reply({outcome:'alreadyRedeemed'});
 if(a.count===0)return reply({outcome:'noCredit'});
 if(a.used===0)return reply({outcome:'nothingToReset'});
 a.count--;a.used=0;a.credits=null;state.redeemed[key]=true;
 fs.writeFileSync(stateFile,JSON.stringify(state));
 if(state.mode==='lostReply')return process.exit(0);
 reply({outcome:'reset'});
});
`)
// Only generated fixture paths are placed in this command wrapper.
write('fake-codex.cmd', `@echo off\r\n"${process.execPath}" "${path.join(home, 'fake-server.cjs')}"\r\n`)
const bundle = await build({ stdin: { resolveDir: repo, loader: 'tsx', contents: `
 import React from 'react'; import {createRoot} from 'react-dom/client';
 import {CodexResetCredits} from './app/src/components/CodexResetCredits';
 import {refreshCodexUsage,accountState} from './app/src/lib/accounts';
 const host=document.createElement('div');host.id='reset-fixture';document.body.append(host);
 const root=createRoot(host);
 window.resetTest={refresh:()=>refreshCodexUsage(true),state:accountState,close:()=>{root.unmount();host.remove()}};
 root.render(<div style={{position:'fixed',inset:0,zIndex:75,display:'grid',placeItems:'center',background:'var(--bg)'}}>
  <div style={{width:560,padding:28,border:'1px solid var(--line)',borderRadius:16}}>
   <h2 style={{fontSize:18}}>Codex 초기화권 · 임시 샘플</h2>
   <p style={{fontSize:12,color:'var(--text-3)'}}>보유 수량과 만료일, 사용 후 갱신을 확인하는 가상 계정입니다.</p>
   <div className="sc2 acct"><div className="who"><div className="em">${email}</div><div className="meta">Plus</div>
    <CodexResetCredits email="${email}"/></div></div>
  </div>
 </div>);
 ` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
 alias: { '@shared': path.join(repo, 'src/shared') }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })

let c
write('preview-bundle.js', bundle.outputFiles[0].text)
const launcher = `$p = Start-Process -FilePath '${path.join(repo, 'target/debug/agentcodegui.exe').replaceAll("'", "''")}' -WindowStyle Hidden -PassThru\n$p.Id`
const launched = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(launcher, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', env: { ...process.env,
  CCG_HOME: home, CCG_NO_NET: '0', CCG_NO_BOOT_ENGINE_UPDATE: '1', CCG_CODEX_BIN: path.join(home, 'fake-codex.cmd'),
  CCG_CDP_PORT: String(port), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } })
assert.equal(launched.status, 0, launched.stderr)
const app = { pid: Number(launched.stdout.trim()) }
assert(app.pid > 0)
const passed = []
let keep = false
const ok = (name, value) => { assert(value, name); passed.push(name); console.log('PASS  ' + name) }
const change = patch => { const s = JSON.parse(fs.readFileSync(stateFile)); patch(s); fs.writeFileSync(stateFile, JSON.stringify(s)) }
const consumed = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.method === 'account/rateLimitResetCredit/consume')
try {
 c = await connectMainPage(port, { timeoutMs: 30000 })
 const ev = expression => c.eval(expression, { awaitPromise: true, timeoutMs: 50000 })
 const until = async expression => { for (let i=0;i<160;i++){if(await ev(expression))return;await sleep(80)}throw new Error('Timed out: '+expression) }
 await until('!!window.api?.codexAuth')
 await ev(bundle.outputFiles[0].text)
 await ev('window.resetTest.refresh()')
 await until('!!document.querySelector(".cx-reset-trigger")')
 const click = async selector => { await ev(`document.querySelector(${JSON.stringify(selector)}).click()`);await sleep(100) }
 const has = text => ev(`document.querySelector('.cx-reset-dialog')?.textContent.includes(${JSON.stringify(text)})`)
 const refresh = () => ev('window.resetTest.refresh()')
 ok('Native parser preserves count independently of partial details', await ev(`window.resetTest.state().cxUsage[${JSON.stringify(email)}].rateLimitResetCredits.availableCount===2`))
 await click('.cx-reset-trigger')
 ok('Detail opens without consuming a credit', consumed().length===0)
 ok('Grant and expiry dates are visible', await has('지급') && await has('만료'))
 ok('Partial detail list keeps the full balance', await has('2개') && await has('전체 수량'))
 await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
 await until('!document.querySelector(".cx-reset-dialog")')
 ok('Escape returns to the source account', await ev('!!document.querySelector(".cx-reset-trigger")'))
 await click('.cx-reset-trigger')
 await ev(`(()=>{const b={bubbles:true,pointerType:'mouse',pointerId:90,button:2,buttons:2,clientX:600,clientY:400};document.querySelector('.cx-reset-dialog').dispatchEvent(new PointerEvent('pointerdown',b));window.dispatchEvent(new PointerEvent('pointermove',{...b,clientX:480}));window.dispatchEvent(new PointerEvent('pointerup',{...b,buttons:0,clientX:480}));})()`)
 await until('!document.querySelector(".cx-reset-dialog")')
 ok('Left mouse gesture returns to the source account', true)
 await click('.cx-reset-trigger')
 await ev(`document.querySelector('.cx-reset-use').click();document.querySelector('.cx-reset-use').click()`)
 await until(`document.querySelector('.cx-reset-notice')?.textContent.includes('갱신했습니다')`)
 ok('Double click consumes once with a UUID', consumed().length===1 && /^[0-9a-f-]{36}$/.test(consumed()[0].params.idempotencyKey))
 ok('Success refetches the real balance and usage windows', await ev(`window.resetTest.state().cxUsage[${JSON.stringify(email)}].rateLimitResetCredits.availableCount===1 && window.resetTest.state().cxUsage[${JSON.stringify(email)}].windows[0].usedPct===0`))
 ok('Another account retains its own balance', await ev(`window.resetTest.state().cxUsage[${JSON.stringify(other)}].rateLimitResetCredits.availableCount===4`))
 await click('.cx-reset-use')
 await until(`document.querySelector('.cx-reset-notice')?.textContent.includes('초기화할 수 있는')`)
 ok('Nothing-to-reset is explained without spending a credit', JSON.parse(fs.readFileSync(stateFile)).accounts[email].count===1)

 change(s=>{s.accounts[email].used=100;s.mode='lostReply'})
 await refresh()
 await click('.cx-reset-use')
 await until(`document.querySelector('.cx-reset-notice')?.textContent.includes('결과를 확인하지 못했어요')`)
 const lostKey = consumed().at(-1).params.idempotencyKey
 await click('.cx-reset-close')
 await click('.cx-reset-trigger')
 ok('A lost response retains a pending attempt after closing', await ev(`document.querySelector('.cx-reset-use').textContent.includes('다시 확인')`))
 change(s=>{s.mode='normal'})
 await click('.cx-reset-use')
 await until(`document.querySelector('.cx-reset-notice')?.textContent.includes('갱신했습니다')`)
 ok('Retry uses the same key and accepts alreadyRedeemed', consumed().at(-1).params.idempotencyKey===lostKey && JSON.parse(fs.readFileSync(stateFile)).accounts[email].count===0)
 ok('Zero balance disables spending', await ev(`document.querySelector('.cx-reset-use').disabled`))

 change(s=>{s.accounts[email].count=null})
 await refresh()
 ok('Unknown balance is distinct from zero', await has('정보를 받지 못했어요') && await ev(`document.querySelector('.cx-reset-balance strong').textContent==='—'`))
 change(s=>{s.accounts[email].count=1;s.accounts[email].used=100;s.mode='unsupported'})
 await refresh()
 await click('.cx-reset-use')
 await until(`document.querySelector('.cx-reset-notice')?.textContent.includes('업데이트')`)
 ok('Unsupported CLI shows an actionable error', true)
 change(s=>{s.mode='normal';s.accounts[email].count=0})
 await click('.cx-reset-use')
 await until(`document.querySelector('.cx-reset-notice')?.textContent.includes('사용할 수 있는 초기화권이 없어요')`)
 ok('No-credit server result refreshes the authoritative zero balance', await ev(`document.querySelector('.cx-reset-use').disabled`))
 const before = consumed().length
 const invalid = await ev(`window.api.codexAuth.consumeResetCredit('', 'test')`)
 const unknown = await ev(`window.api.codexAuth.consumeResetCredit('missing@example.test', 'test')`)
 ok('Invalid or unregistered accounts never reach Codex', invalid.error==='invalidRequest' && unknown.error==='accountUnavailable' && consumed().length===before)

 change(s=>{s.accounts[email]={count:2,used:100,credits:[credit]};s.mode='normal'})
 await refresh()
 await ev('window.resetTest.close()')
 await ev(bundle.outputFiles[0].text)
 await refresh()
 await click('.cx-reset-trigger')
 await sleep(200)
 const shot = await c.send('Page.captureScreenshot',{format:'png'})
 fs.writeFileSync(path.join(home,'preview.png'),Buffer.from(shot.data,'base64'))
 console.log(JSON.stringify({passed:passed.length,home,port,pid:app.pid}))
 if(process.argv.includes('--keep')) {
   keep = true
   fs.writeFileSync(path.join(repo,'node_modules/.cache/dev-reset-preview.json'),JSON.stringify({home,port,pid:app.pid}))
   await c.send('Page.bringToFront')
 }
} finally {
 c?.close()
 if(!keep)killTree(app.pid)
}
