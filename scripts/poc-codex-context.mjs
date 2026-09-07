// Real Settings card -> native persistence -> Codex driver RPC, using an isolated
// fake account/server. Requires Vite on 5273 and a debug Tauri build.
// node scripts/poc-codex-context.mjs [--keep]
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import {connectMainPage, killTree, quietHome, sleep} from '../bench/lib.mjs';

const repo = process.cwd(), home = fs.mkdtempSync(path.join(repo, 'node_modules/.cache/codex-context-'));
const port = 19426, email = 'context-demo@example.test', panelId = 'default::0';
const file = path.join(home, 'codex-context.json');
const write = (name, value) => fs.writeFileSync(path.join(home, name), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
quietHome(home);
write('ui-prefs.json', {'ui.lang':'ko'});
write('fixture.html', '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/src/styles.css"><div id="context-host-ready"></div><script type="module" src="/src/api/shim.ts"></script>');
write('synthetic-auth.json', {tokens:{account_id:email, access_token:'synthetic-only'}});
const ps = `Add-Type -AssemblyName System.Security\n[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([IO.File]::ReadAllBytes('${path.join(home,'synthetic-auth.json').replaceAll("'","''")}'),$null,'CurrentUser'))`;
const sealed = spawnSync('powershell', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')], {windowsHide:true,encoding:'utf8'});
assert.equal(sealed.status, 0, sealed.stderr);
write('codex-accounts.json', {version:1, accounts:[{email,plan:'plus',authEnc:sealed.stdout.trim()}]});
write('fake-server.cjs', `
if(process.argv.includes('--version')){console.log('codex-cli 0.153.4');process.exit(0)}
const fs=require('node:fs'),rl=require('node:readline');let seq=0;
const log=${JSON.stringify(path.join(home,'requests.jsonl'))};
const send=v=>console.log(JSON.stringify({jsonrpc:'2.0',...v}));
rl.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(m)+'\\n');if(m.id==null)return;
 const reply=result=>send({id:m.id,result});
 if(m.method==='initialize'){
  fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});
  fs.writeFileSync(require('node:path').join(process.env.CODEX_HOME,'models_cache.json'),JSON.stringify({models:['gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.5'].map(slug=>({slug,context_window:272000}))}));
  return reply({userAgent:'synthetic-codex'});
 }
 if(m.method==='thread/start'||m.method==='thread/resume')return reply({thread:{id:'th-context'}});
 if(m.method==='model/list')return reply({data:['gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.5'].map(id=>({id,displayName:id,description:'',supportedReasoningEfforts:[]})),nextCursor:null});
 if(m.method==='config/read')return reply({config:{}});
 if(m.method==='skills/list')return reply({data:[]});
 if(m.method==='mcpServerStatus/list')return reply({data:[],nextCursor:null});
 if(m.method==='thread/backgroundTerminals/list')return reply({terminals:[]});
 if(m.method==='account/rateLimits/read')return reply({rateLimits:{planType:'plus',primary:{usedPercent:2,windowDurationMins:300,resetsAt:2000000000}}});
 if(m.method==='turn/start'){
  const id='turn-'+(++seq);reply({turn:{id}});send({method:'turn/started',params:{threadId:'th-context',turn:{id}}});
  setTimeout(()=>send({method:'turn/completed',params:{threadId:'th-context',turn:{id,status:'completed',items:[],error:null}}}),150);return;
 }
 reply({});
});
`);
write('fake-codex.cmd', `@echo off\r\n"${process.execPath}" "${path.join(home,'fake-server.cjs')}" %*\r\n`);
const bundle = await build({stdin:{resolveDir:repo,loader:'tsx',contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {CodexContextCard} from './app/src/components/CodexContextCard';
import {SettingsModal} from './app/src/components/Settings';
import {loadPrefs} from './app/src/lib/prefs';
const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
window.ctxTest={events:[],mount:()=>root.render(<div style={{background:'#101010',height:'100vh',padding:36,overflow:'auto'}}><div style={{maxWidth:700,margin:'0 auto'}}><CodexContextCard/></div></div>),settings:()=>root.render(<SettingsModal initialView='version' onClose={()=>location.assign('http://localhost:5273/')}/>)};
window.api.multi.onEvent('${panelId}',e=>window.ctxTest.events.push(e));
loadPrefs().then(window.ctxTest.mount);
`},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',alias:{'@shared':path.join(repo,'src/shared')},define:{'import.meta.glob':'__previewGlob','process.env.NODE_ENV':'"production"'},banner:{js:'var __previewGlob=()=>({});'},logLevel:'silent'});
const env = {...process.env,CCG_HOME:home,CCG_NO_NET:'0',CCG_NO_BOOT_ENGINE_UPDATE:'1',CCG_CODEX_BIN:path.join(home,'fake-codex.cmd'),CCG_CDP_PORT:String(port)};
delete env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
const out = fs.openSync(path.join(home,'native.log'),'a');
const child = spawn(path.join(repo,'target/debug/agentcodegui.exe'),[],{windowsHide:true,detached:true,env,stdio:['ignore',out,out]});child.unref();fs.closeSync(out);
let c, keep = false;
try {
  c = await connectMainPage(port,{timeoutMs:30000});
  const ev = s => c.eval(s,{awaitPromise:true,timeoutMs:30000});
  const until = async expression => {for(let i=0;i<160;i++){if(await ev(expression))return;await sleep(80)}throw Error('Timed out: '+expression)};
  const ok = (name, value) => {assert.ok(value,name);console.log('PASS '+name)};
  await c.send('Page.navigate',{url:'http://localhost:5273/@fs/'+path.join(home,'fixture.html').replaceAll('\\','/')});
  await until('!!document.querySelector("#context-host-ready")&&!!window.api?.codexContext');
  await ev(bundle.outputFiles[0].text);await until('!!document.querySelector(".cx-context fieldset:not([disabled])")');
  const click = text => ev(`[...document.querySelectorAll('.cx-context button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
  const preset = index => ev(`document.querySelectorAll('.cx-context-presets button')[${index}].click()`);
  const stored = () => JSON.parse(fs.readFileSync(file,'utf8'));
  const save = async () => {await click('저장');await until(`!document.querySelector('.cx-token-settings[aria-busy="true"]')`)};
  const management = async () => {await ev(`document.querySelector('.cx-management [role="switch"]').click()`);await until(`!document.querySelector('.cx-management[aria-busy="true"]')`)};
  const inputs = () => ev(`[...document.querySelectorAll('.cx-context input')].map(i=>i.value)`);
  const logs = () => fs.existsSync(path.join(home,'requests.jsonl')) ? fs.readFileSync(path.join(home,'requests.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const run = async (model, resume) => {
    await ev(`window.api.multi.dispose('${panelId}')`);await sleep(180);
    const count=logs().filter(m=>m.method==='thread/start'||m.method==='thread/resume').length;
    await ev(`window.ctxTest.events=[];window.api.multi.run(${JSON.stringify({panelId,prompt:'Synthetic context settings check',engine:'codex',model:'sonnet',codexModel:model,codexAccount:email,effort:'low',mode:'bypass',cwd:repo,...(resume?{resume:'th-context'}:{})})})`);
    await until(`window.ctxTest.events.some(e=>e.type==='result')`);
    const requests=logs().filter(m=>m.method==='thread/start'||m.method==='thread/resume');assert.equal(requests.length,count+1);
    return requests.at(-1);
  };
  const row = model => ev(`[...document.querySelectorAll('[data-model="${model}"] input')].map(i=>i.value.replaceAll(',',''))`);
  ok('All four picker models appear and older hidden models stay hidden',await ev(`document.querySelectorAll('.cx-model-table tbody tr').length===4&&!document.querySelector('[data-model="gpt-5.5"]')`));
  ok('Default preset displays actual numbers without saving overrides',!fs.existsSync(file)&&(await row('gpt-6-astra')).join(',')==='272000,244800'&&(await row('gpt-5.6-sol')).join(',')==='272000,244800');
  ok('Management has one ON/OFF switch with no Default choice',await ev(`document.querySelectorAll('.cx-management button').length===1&&document.querySelector('.cx-management [role="switch"]').getAttribute('aria-checked')==='false'`));
  await preset(1);ok('Recommended changes Astra only in the displayed rows',(await row('gpt-6-astra')).join(',')==='512000,430000'&&(await row('gpt-5.6-sol')).join(',')==='272000,244800');
  await save();ok('Recommended stores only the Astra override',stored().models['gpt-6-astra'].contextWindow===512000&&Object.keys(stored().models).length===1);
  await management();ok('Management saves independently without a token Save',stored().management===true&&stored().preset==='recommended');
  let request=await run('gpt-6-astra',false),config=request.params.config;
  ok('Astra thread receives both token values and experimental management',request.method==='thread/start'&&config.model_context_window===512000&&config.model_auto_compact_token_limit===430000&&config.features.context_management.experimental_mode===true);
  request=await run('gpt-5.6-sol',true);ok('Sol keeps its native defaults under Recommended',request.method==='thread/resume'&&!('model_context_window' in request.params.config)&&!('model_auto_compact_token_limit' in request.params.config));
  const input = async (index,text) => ev(`(()=>{const i=document.querySelectorAll('.cx-context input')[${index}];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(text)});i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await input(1,'512000');ok('Compaction at the window size is rejected before saving',await ev(`document.querySelector('.cx-context-footer button').disabled&&!!document.querySelector('.cx-context [role="alert"]')`));
  await management();ok('Management can save while token edits are invalid and preserves the draft',stored().management===false&&stored().models['gpt-6-astra'].compactTokenLimit===430000&&(await inputs())[1]==='512000');
  await input(0,'200000');await input(1,'160000');await input(2,'210000');await input(3,'170000');await save();ok('Direct values are stored independently for Astra and Sol',stored().preset==='custom'&&stored().models['gpt-6-astra'].contextWindow===200000&&stored().models['gpt-5.6-sol'].contextWindow===210000&&stored().management===false);
  const bad=await ev(`window.api.codexContext.save({preset:'custom',models:{'gpt-5.6-sol':{contextWindow:200000,compactTokenLimit:200000}}})`);ok('Native validation rejects invalid callers without overwriting the saved values',!!bad.error&&stored().models['gpt-5.6-sol'].compactTokenLimit===170000);
  request=await run('gpt-5.6-sol',true);ok('Sol receives only its own custom values and explicit OFF',request.params.config.model_context_window===210000&&request.params.config.model_auto_compact_token_limit===170000&&request.params.config.features.context_management.experimental_mode===false);
  request=await run('gpt-6-astra',true);ok('Astra receives its separate custom values',request.params.config.model_context_window===200000&&request.params.config.model_auto_compact_token_limit===160000);
  await preset(0);ok('Default immediately shows baseline numbers again',(await row('gpt-6-astra')).join(',')==='272000,244800'&&(await row('gpt-5.6-sol')).join(',')==='272000,244800');
  await save();request=await run('gpt-6-astra',true);ok('Default removes numeric overrides and preserves the independent OFF choice',!('model_context_window' in request.params.config)&&request.params.config.features.context_management.experimental_mode===false);
  // Disk failure: the UI must retain edits and allow retry after the error is fixed.
  await preset(1);fs.renameSync(file,file+'.bak');fs.mkdirSync(file);
  try {await save();ok('Failed persistence shows an error and keeps the unsaved values',await ev(`!!document.querySelector('.cx-context [role="alert"]')&&!document.querySelector('.cx-context-footer button').disabled`))}
  finally {fs.rmdirSync(file);fs.renameSync(file+'.bak',file)}
  await save();ok('Retry saves after a disk error',stored().preset==='recommended');
  await ev(`window.ctxTest.settings()`);await until(`!!document.querySelector('.set-modal .cx-context fieldset:not([disabled])')`);
  ok('Reopening Engine settings reloads all model values',(await row('gpt-6-astra')).join(',')==='512000,430000'&&(await row('gpt-5.6-terra')).join(',')==='272000,244800');
  ok('Token settings and context management are separate cards',await ev(`document.querySelector('.cx-token-settings').parentElement===document.querySelector('.cx-management').parentElement&&!document.querySelector('.cx-token-settings .cx-management')`));
  // Leave the preview on the shipped default; Recommended is an explicit opt-in.
  await preset(0);await save();
  await ev(`document.querySelector('.cx-context').scrollIntoView({block:'center'})`);await sleep(250);
  write('context-preview.png',Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  if(process.argv.includes('--keep')){keep=true;write('preview.json',{home,port,pid:child.pid});fs.writeFileSync(path.join(repo,'node_modules/.cache/dev-context-preview.json'),JSON.stringify({home,port,pid:child.pid}));await c.send('Page.bringToFront')}
  console.log(JSON.stringify({home,port,pid:child.pid,keep}));
} finally {try{c?.close()}catch{}if(!keep)killTree(child.pid)}
