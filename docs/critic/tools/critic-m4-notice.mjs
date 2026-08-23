import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO } from '../../../bench/lib.mjs'
const EXE = process.argv[2]
const HOME = path.join(REPO, '.critic-home-m4-notice'); const WORK = path.join(HOME, 'work')
const w=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,typeof v==='string'?v:JSON.stringify(v,null,2))}
try{fs.rmSync(HOME,{recursive:true,force:true})}catch{}
fs.mkdirSync(WORK,{recursive:true})
const ed=path.join(HOME,'engines','fake','node_modules','@anthropic-ai','claude-agent-sdk-win32-x64')
fs.mkdirSync(ed,{recursive:true}); fs.copyFileSync(path.join(REPO,'target','release','ccg-fakecli.exe'), path.join(ed,'claude.exe'))
w(path.join(HOME,'config.json'),{activeVersion:'fake'})
w(path.join(HOME,'accounts.json'),{defaultEmail:'f@e.com',accounts:[{email:'f@e.com'}]})
fs.mkdirSync(path.join(HOME,'accounts','f_e.com'),{recursive:true})
w(path.join(HOME,'chats','index.json'),{version:1,order:['c-n'],activeChatId:'c-n'})
w(path.join(HOME,'chats','c-n.json'),{id:'c-n',title:'n',custom:true,manualCwd:WORK,picker:{model:'haiku',effort:'minimal',mode:'normal'},refDirs:[],snapshot:{messages:[]},updatedAt:Date.now()})
w(path.join(HOME,'ui-prefs.json'),{'ui.lang':'ko'}); w(path.join(HOME,'profile.json'),{nickname:'c'})
const S=path.join(HOME,'s.jsonl')
fs.writeFileSync(S,[
 {afterMs:100,emit:{type:'control_response',response:{subtype:'success',request_id:'init-1',response:{}}}},
 {emit:{type:'system',subtype:'init',session_id:'N1',model:'claude-haiku',cwd:WORK,tools:[],apiKeySource:'none'}},
 {afterMs:120,emit:{type:'system',subtype:'notification',text:'CLAUDE-NOTICE-ONE'}},
 {afterMs:120,emit:{type:'assistant',session_id:'N1',parent_tool_use_id:null,message:{role:'assistant',content:[{type:'text',text:'DONE'}],usage:{input_tokens:3}}}},
 {emit:{type:'result',subtype:'success',is_error:false,result:'DONE',session_id:'N1',total_cost_usd:0,duration_ms:1,num_turns:1}}
].map(x=>JSON.stringify(x)).join('\n')+'\n')
const child=spawn(EXE,[],{env:{...process.env,CCG_HOME:HOME,CCG_FAKECLI_SCRIPT:S,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9540'},stdio:['ignore','pipe','pipe']})
const cdp=await connectMainPage(9540,{timeoutMs:60000})
const j=async(e)=>JSON.parse(await cdp.eval(`(async () => JSON.stringify(${e}))()`,{awaitPromise:true}))
for(let i=0;i<300;i++){const up=await cdp.eval(`(async()=>{try{return !!(await window.api.app.getVersion())}catch{return false}})()`,{awaitPromise:true}).catch(()=>false); if(up)break; await sleep(100)}
await j(`(window.__ev=[], window.api.onEngineEvent(e=>window.__ev.push(e)), 'armed')`)
for(let i=0;i<300;i++){ if(await j(`(await window.api.getChats())?.activeChatId==='c-n' && !!document.querySelector('.composer-row textarea')`)) break; await sleep(120)}
await j(`(()=>{const ta=document.querySelector('.composer-row textarea');const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;set.call(ta,'go');ta.dispatchEvent(new Event('input',{bubbles:true}));ta.focus();ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));return 'sent'})()`)
for(let i=0;i<200;i++){ if(await j(`window.__ev.some(e=>e.type==='result')`)) break; await sleep(120)}
await sleep(1200)
const n=await j(`window.__ev.filter(e=>e.type==='notice'&&String(e.text).includes('CLAUDE-NOTICE-ONE')).length`)
const dom=await j(`(document.body.innerText.match(/CLAUDE-NOTICE-ONE/g)??[]).length`)
console.log(JSON.stringify({claudeNoticeEvents:n, claudeNoticeInDom:dom}))
await j(`(window.api.win.close(),'x')`).catch(()=>{}); await sleep(600); killTree(child.pid)
try{fs.rmSync(HOME,{recursive:true,force:true})}catch{}
