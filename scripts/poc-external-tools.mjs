// Real Tauri + independent Node adapter + browser selection + deterministic CLI.
// Uses an isolated app home and only terminates processes created by this script.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { Cdp, connectMainPage, cdpTargets, killTree, sleep, REPO } from '../bench/lib.mjs'

const args=process.argv.slice(2)
const option=name=>args.find(a=>a.startsWith(name+'='))?.slice(name.length+1)
const EXE=path.resolve(option('--exe')||path.join(REPO,'target/debug/agentcodegui.exe'))
const PORT=Number(option('--port')||11861)
const HOME=fs.mkdtempSync(path.join(REPO,'.poc-home-external-tools-'))
const WORK=path.join(HOME,'work')
const FAKE=path.join(REPO,'target/debug/ccg-fakecli.exe')
const PROBE=path.join(REPO,'target/debug/ccg-auth-probe.exe')
const INPUT=path.join(HOME,'engine-input.jsonl')
const SCRIPT=path.join(HOME,'engine-script.jsonl')
const READY=path.join(HOME,'lab-ready.json')
const report={at:new Date().toISOString(),home:HOME,exe:EXE,checks:[],screenshots:[]}
const write=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof data==='string'?data:JSON.stringify(data))}
function check(name,ok,detail){report.checks.push({name,ok:!!ok,...(detail?{detail}: {})});console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)throw new Error(name+(detail?' '+JSON.stringify(detail):''))}
async function until(fn,label,ms=12000){const start=Date.now();for(;;){const result=await fn().catch(()=>null);if(result)return result;if(Date.now()-start>ms)throw new Error('Timed out: '+label);await sleep(70)}}
const env={...process.env,CCG_HOME:HOME,CCG_NO_NET:'1',CCG_NO_BOOT_ENGINE_UPDATE:'1',CCG_CDP_PORT:String(PORT),CCG_FAKECLI_SCRIPT:SCRIPT,CCG_FAKECLI_IN:INPUT,CCG_ENGINE_LOG:path.join(HOME,'engine-output.jsonl')}
let native,lab,edge,page,labPage,labUrl,labToken
const extraPages=[]
const nativeLog=[]
const runNative=()=>{const child=spawn(EXE,[],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});child.stdout.on('data',b=>nativeLog.push(b.toString()));child.stderr.on('data',b=>nativeLog.push(b.toString()));return child}
const ev=expr=>page.eval(`(async()=>(${expr}))()`,{awaitPromise:true})
const ipc=(channel,payload=[])=>ev(`await window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:${JSON.stringify(channel)},payload:${JSON.stringify(payload)}})`)
const snapshot=()=>ipc('bridge:snapshot')
const binding=(state,id,chat)=>state.clients.find(c=>c.id===id)?.bindings.find(b=>b.chatId===chat)
const labApi=async(endpoint,body)=>{const response=await fetch(labUrl+'/api/'+endpoint,{method:body?'POST':'GET',headers:{'X-Lab-Token':labToken,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(6000)});const result=await response.json();if(!response.ok)throw new Error(result.error);return result}
const userInputs=()=>{try{return fs.readFileSync(INPUT,'utf8').trim().split('\n').map(line=>{try{return JSON.parse(line)}catch{return null}}).filter(v=>v?.type==='user')}catch{return []}}
const promptOf=input=>typeof input.message?.content==='string'?input.message.content:(input.message?.content||[]).filter(block=>block.type==='text').map(block=>block.text).join('\n')
const sourceDoc=(tag,n)=>({items:[{id:'selection',kind:'code/selection',title:tag,text:tag,uri:'lab://selection.ts',range:{startLine:n,endLine:n}}],state:{activeDocument:'lab://selection.ts',phase:n}})

async function shot(name){const image=await page.send('Page.captureScreenshot',{format:'png'});const file=path.join(HOME,name+'.png');fs.writeFileSync(file,Buffer.from(image.data,'base64'));report.screenshots.push(file)}
async function openConnections(root='body'){
  await ev(`(()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));const b=document.querySelector(${JSON.stringify(root)}).querySelector('.ext-chip');if(!b)return false;b.click();return true})()`)
  await until(()=>ev(`!!document.querySelector('.ext-popover')`),'connection popover')
}
async function connectTool(clientId,root='body'){
  await openConnections(root)
  await until(()=>ev(`!!document.querySelector('.ext-popover [data-client-id="${clientId}"] .ext-connect-button')`),'available tool row')
  const oldChats=new Set((await snapshot()).clients.find(c=>c.id===clientId)?.bindings.map(b=>b.chatId))
  await ev(`document.querySelector('.ext-popover [data-client-id="${clientId}"] .ext-connect-button').click()`)
  const chat=await until(async()=> (await snapshot()).clients.find(c=>c.id===clientId)?.bindings.find(b=>!oldChats.has(b.chatId))?.chatId,'tool bound')
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  return chat
}
async function draft(text,root='body'){
  await ev(`(()=>{const el=document.querySelector(${JSON.stringify(root)}).querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  await sleep(90)
}
async function send(text,root='body',queued=false){await draft(text,root);await ev(`document.querySelector(${JSON.stringify(root)}).querySelector(${JSON.stringify(queued?'.send.schedule':'.send:not(.stop):not(.schedule)')}).click()`)}
async function switchChat(title){await ev(`(()=>{const row=[...document.querySelectorAll('.sb-item')].find(e=>e.querySelector('.tx')?.textContent===${JSON.stringify(title)});if(!row)throw new Error('Missing sidebar chat');row.click();return true})()`);await sleep(250)}

function writeScenario(sessionId,cwd=WORK){
  const steps=[{emit:{type:'control_response',response:{subtype:'success',request_id:'init-1',response:{}}}},{emit:{type:'system',subtype:'init',session_id:sessionId,cwd,model:'claude-haiku-4-5',tools:['Read'],mcp_servers:[]}}]
  for(let turn=1;turn<=20;turn++)steps.push({awaitUser:turn},{afterMs:250,emit:{type:'assistant',session_id:sessionId,parent_tool_use_id:null,message:{id:'reply-'+turn,role:'assistant',content:[{type:'text',text:'외부 도구의 선택 내용과 상태를 전달받았습니다. (검증용 응답)'}]}}},{afterMs:2400,emit:{type:'result',subtype:'success',is_error:false,result:'Context received',session_id:sessionId,duration_ms:2650,num_turns:1,total_cost_usd:0}})
  write(SCRIPT,steps.map(x=>JSON.stringify(x)).join('\n'))
}
function seed(){
  fs.mkdirSync(WORK,{recursive:true});write(path.join(WORK,'README.md'),'# External tools integration fixture\n')
  const engine=path.join(HOME,'engines/fake/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe')
  fs.mkdirSync(path.dirname(engine),{recursive:true});fs.copyFileSync(FAKE,engine)
  write(path.join(HOME,'engines/fake/node_modules/@anthropic-ai/claude-agent-sdk/package.json'),{name:'@anthropic-ai/claude-agent-sdk',version:'fake'})
  write(path.join(HOME,'config.json'),{activeVersion:'fake'})
  write(path.join(HOME,'engine-auto-update.json'),{enabled:false})
  const seeded=spawnSync(PROBE,['seed','a@fake.test'],{env,encoding:'utf8',windowsHide:true})
  if(seeded.status!==0)throw new Error('Fake account seed failed: '+seeded.stderr)
  write(path.join(HOME,'ui-prefs.json'),{'ui.lang':'ko','whatsnew.seenVersion':JSON.parse(fs.readFileSync(path.join(REPO,'src-tauri/tauri.conf.json'),'utf8')).version,'sidebar.autohide':false,'workspace.mode':'single','explorer.swap':false})
  write(path.join(HOME,'profile.json'),{nickname:'외부 도구 연결 검증'})
  write(path.join(HOME,'chats/index.json'),{version:1,order:['c-a','c-b'],activeChatId:'c-a'})
  for(const [id,title] of [['c-a','External A'],['c-b','External B']])write(path.join(HOME,'chats',id+'.json'),{id,title,custom:true,manualCwd:WORK,picker:{model:'haiku',effort:'minimal',mode:'normal',account:'a@fake.test'},refDirs:[],snapshot:{messages:[]},updatedAt:Date.now()})
  writeScenario('external-tools-fixture')
}

try{
  seed();native=runNative();page=await connectMainPage(PORT,{timeoutMs:60000})
  await until(()=>ev(`!!document.querySelector('.ext-chip')`),'app header',30000)
  await until(()=>fs.promises.readFile(path.join(HOME,'external-bridge.json'),'utf8'),'discovery file')
  check('Native app exposes its loopback discovery file',true)
  lab=spawn(process.execPath,[path.join(REPO,'examples/external-tool-lab/server.mjs'),'--app-home='+HOME,'--ready-file='+READY],{stdio:['ignore','pipe','pipe'],windowsHide:true})
  lab.stdout.on('data',()=>{});lab.stderr.on('data',b=>nativeLog.push('lab: '+b))
  const ready=await until(async()=>JSON.parse(await fs.promises.readFile(READY,'utf8')),'independent tool server')
  labUrl=ready.url
  const html=await(await fetch(labUrl)).text();labToken=html.match(/<script nonce="([^"]+)"/)[1]
  const edgeExe=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p=>fs.existsSync(p))
  edge=spawn(edgeExe,['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port='+String(PORT+1),'--user-data-dir='+path.join(HOME,'lab-browser'),labUrl],{stdio:'ignore',windowsHide:true})
  const labTarget=await until(async()=> (await cdpTargets(PORT+1)).find(t=>t.type==='page'&&t.url.startsWith(labUrl)&&t.webSocketDebuggerUrl),'lab browser',20000)
  labPage=await Cdp.connect(labTarget.webSocketDebuggerUrl)
  await until(()=>labPage.eval("!!document.getElementById('editor')"),'lab editor ready')
  const clients=await until(async()=>{const s=await snapshot();return s.clients.length===3?s.clients:null},'three external adapters')
  const code=clients.find(c=>c.manifest.id==='dev.agentcodegui.lab.code').id
  const data=clients.find(c=>c.manifest.id==='dev.agentcodegui.lab.data').id
  let custom=clients.find(c=>c.manifest.id==='dev.agentcodegui.lab.custom').id
  check('External program registers three independently identified tools',clients.length===3)
  await connectTool(code)
  await until(async()=> binding(await snapshot(),code,'c-a'),'A binding')
  await labPage.eval(`(()=>{const el=document.getElementById('editor');el.value='CAPTURE_REAL_DRAG';el.setSelectionRange(0,el.value.length);el.dispatchEvent(new Event('select'));return true})()`)
  await until(()=>ev(`document.querySelector('.external-context-tray')?.textContent.includes('checkout.ts')`),'context tray')
  await until(async()=> (await snapshot()).clients.find(c=>c.id===code)?.document.items[0]?.text==='CAPTURE_REAL_DRAG','real external selection')
  check('Actual selection in the independent browser reaches the native session',true)
  check('Selected context does not require a tool panel',await ev(`!document.querySelector('.tool-panel, .ext-view')`))
  await labApi('publish',{tool:'code',document:sourceDoc('CAPTURE_A1',1)})
  await until(()=>ev(`document.querySelector('.external-context-tray')?.textContent.includes('CAPTURE_A1')`),'A1 preview')
  await send('Explain the first selected context')
  await until(()=>Promise.resolve(userInputs().length>=1),'first engine prompt')
  await labApi('publish',{tool:'code',document:sourceDoc('CAPTURE_QUEUED_A2',2)})
  await until(()=>ev(`document.querySelector('.external-context-tray')?.textContent.includes('CAPTURE_QUEUED_A2')`),'queued selection preview')
  await send('Explain the queued selection','body',true)
  await until(()=>ev(`document.querySelectorAll('.sched-item').length===1`),'queued draft')
  await labApi('publish',{tool:'code',document:sourceDoc('LATER_SELECTION_A3',3)})
  await until(()=>Promise.resolve(userInputs().length>=2),'queued engine prompt',18000)
  const inputs=userInputs()
  check('Engine receives selection and current tool state',promptOf(inputs[0]).includes('CAPTURE_A1')&&promptOf(inputs[0]).includes('"phase":1'))
  check('Queued messages retain their captured selection and state',promptOf(inputs[1]).includes('CAPTURE_QUEUED_A2')&&!promptOf(inputs[1]).includes('LATER_SELECTION_A3')&&promptOf(inputs[1]).includes('"phase":2'))
  await until(()=>ev(`!document.querySelector('.send.stop')`),'queued run completes',18000)
  check('Sent messages retain visible external context attachments',await ev(`document.querySelectorAll('.ext-sent-context').length>=2`))
  await until(async()=>{const text=await fs.promises.readFile(path.join(HOME,'chats-v3/c-a.json'),'utf8');return text.includes('externalContext')&&text.includes('CAPTURE_QUEUED_A2')},'persisted message snapshot')
  check('Context snapshots survive conversation persistence',true)
  await openConnections();await ev(`document.querySelector('.ext-popover [data-client-id="${code}"] [role="switch"]').click()`)
  await until(async()=> binding(await snapshot(),code,'c-a')?.enabled===false,'tool off')
  await labApi('publish',{tool:'code',document:sourceDoc('OFF_SELECTION_A4',4)})
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await send('No external tool data in this message')
  await until(()=>Promise.resolve(userInputs().length>=3),'disabled engine prompt')
  check('OFF retains the binding and excludes both selection and state',!(promptOf(userInputs()[2]).includes('External tool context'))&&!!binding(await snapshot(),code,'c-a'))
  await until(()=>ev(`!document.querySelector('.send.stop')`),'disabled run ends',18000)
  await openConnections();await ev(`document.querySelector('.ext-popover [data-client-id="${code}"] [role="switch"]').click()`)
  await until(()=>ev(`document.querySelector('.external-context-tray')?.textContent.includes('OFF_SELECTION_A4')`),'reenabled latest context')
  check('ON catches up to the latest external selection',true)
  await labApi('icon',{tool:'code',icon:'database'})
  await until(()=>ev(`!!document.querySelector('.external-context-tray [data-external-icon="database"]')`),'icon update')
  check('The external program selects a shared icon by ID',true)
  await labApi('icon',{tool:'code',icon:'unknown-icon'})
  await until(()=>ev(`!!document.querySelector('.external-context-tray [data-external-icon="tool"]')`),'fallback icon')
  check('Unknown icon IDs use the default tool icon',true)
  await labApi('icon',{tool:'code',icon:'code'})
  const discovery=JSON.parse(fs.readFileSync(path.join(HOME,'external-bridge.json'),'utf8'))
  check('HTTP rejects an unauthenticated native request',(await fetch(discovery.url+'/v1')).status===401)
  check('HTTP rejects browser-origin requests',(await fetch(discovery.url+'/v1',{headers:{Origin:'https://untrusted.example',Authorization:'Bearer '+discovery.token}})).status===403)
  check('Bootstrap credentials cannot read a registered tool connection',(await fetch(discovery.url+'/v1/clients/'+code+'/poll',{headers:{Authorization:'Bearer '+discovery.token}})).status===401)
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await switchChat('External B');await connectTool(data)
  await until(async()=> binding(await snapshot(),data,'c-b'),'B binding')
  await labApi('publish',{tool:'data',document:{items:[{id:'table',kind:'table/selection',title:'ONLY_SESSION_B',data:[{value:42}]}],state:{sheet:'B'}}})
  await until(()=>ev(`document.querySelector('.external-context-tray')?.textContent.includes('ONLY_SESSION_B')`),'B context')
  check('A second conversation receives only its connected tool',!(await ev(`document.querySelector('.external-context-tray').textContent`)).includes('OFF_SELECTION_A4'))
  await switchChat('External A');await until(()=>ev(`document.querySelector('.external-context-tray')?.textContent.includes('OFF_SELECTION_A4')`),'A context restored')
  await openConnections();await shot('native-connections')
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await ev(`document.querySelector('.ext-context-summary').click()`);await shot('native-context-and-history')
  // Restart the shell while the independently running adapters reconnect.
  await openConnections();await ev(`document.querySelector('.ext-popover [data-client-id="${code}"] [role="switch"]').click()`)
  await until(async()=> binding(await snapshot(),code,'c-a')?.enabled===false,'saved OFF setting')
  page.close();page=null;killTree(native.pid);native=runNative();page=await connectMainPage(PORT,{timeoutMs:60000})
  await until(async()=>{const s=await snapshot();const c=s.clients.find(c=>c.id===code);return c?.online&&binding(s,code,'c-a')?.enabled===false},'reconnect after app restart',30000)
  check('Restart restores session bindings and ON/OFF without storing live data',true)
  custom=await until(async()=> (await snapshot()).clients.find(c=>c.manifest.id==='dev.agentcodegui.lab.custom'&&c.online)?.id,'unbound adapter re-registered')
  await until(()=>ev(`document.querySelector('.sb-item .tx')?.textContent==='External A'&&!!document.querySelector('.external-context-tray')`),'restored session UI')
  await sleep(800)
  await until(()=>ev(`document.querySelectorAll('.ma-count-btn').length>0`),'panel count selector')
  await ev(`(()=>{const b=[...document.querySelectorAll('.ma-count-btn')].find(b=>b.textContent.trim()==='2');b.click();return true})()`)
  await until(()=>ev(`document.querySelectorAll('.ma-panel').length===2`),'two session panels')
  const codeChat=await connectTool(code,'.ma-panel[data-slot="0"]'),dataChat=await connectTool(data,'.ma-panel[data-slot="1"]')
  check('Connecting to another session preserves the existing connection and its OFF state',binding(await snapshot(),code,'c-a')?.enabled===false&&!!binding(await snapshot(),data,'c-b'))
  check('Panel connection ownership resolves to distinct canonical chats',codeChat!==dataChat&&codeChat!=='c-a'&&dataChat!=='c-b')
  await labApi('publish',{tool:'code',document:sourceDoc('MULTI_CODE_ONLY',8)})
  await labApi('publish',{tool:'data',document:{items:[{id:'rows',kind:'table/selection',title:'MULTI_DATA_ONLY',data:[1,2]}],state:{sheet:'multi-data'}}})
  await until(()=>ev(`document.querySelector('.ma-panel[data-slot="0"] .external-context-tray')?.textContent.includes('MULTI_CODE_ONLY')&&document.querySelector('.ma-panel[data-slot="1"] .external-context-tray')?.textContent.includes('MULTI_DATA_ONLY')`),'independent panel contexts')
  check('Two visible panels keep their external data separate',await ev(`!document.querySelector('.ma-panel[data-slot="0"] .external-context-tray').textContent.includes('MULTI_DATA_ONLY')`))
  const desktop=spawnSync('powershell.exe',['-NoProfile','-Command',"[Environment]::GetFolderPath('Desktop')"],{encoding:'utf8',windowsHide:true}).stdout.trim()
  writeScenario('external-tools-multi-fixture',desktop)
  await ev(`(()=>{window.__externalTestEvents=[];const handler=window.__TAURI_INTERNALS__.transformCallback(e=>window.__externalTestEvents.push(e));return Promise.all(['chat:event','ma:event'].map(event=>window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event,target:{kind:'Any'},handler})))})()`)
  const beforeMulti=userInputs().length;await send('Check this panel context','.ma-panel[data-slot="0"]')
  await until(()=>Promise.resolve(userInputs().length>beforeMulti),'multi engine input',18000)
  check('Multi-panel engine input contains only its own context',promptOf(userInputs().at(-1)).includes('MULTI_CODE_ONLY')&&!promptOf(userInputs().at(-1)).includes('MULTI_DATA_ONLY'))
  await until(()=>ev(`!document.querySelector('.ma-panel[data-slot="0"] .send.stop')`),'multi run completes',18000)
  check('The first run in a new panel survives a delayed empty save',true)
  await shot('native-two-sessions')
  await connectTool(custom,'.ma-panel[data-slot="0"]')
  await labApi('publish',{tool:'custom',document:sourceDoc('CUSTOM_SAME_SESSION',20)})
  await until(()=>ev(`document.querySelectorAll('.ma-panel[data-slot="0"] .ext-context-source').length===2`),'multiple tools in one session')
  check('Multiple enabled tools share one session without changing the other session',true)
  await ev(`document.querySelector('.ma-panel[data-slot="0"] .ext-context-source[data-client-id="${code}"] .ext-include').click()`)
  await until(async()=> binding(await snapshot(),code,codeChat)?.includeSelection===false,'selection excluded')
  await ev(`document.querySelector('.ma-panel[data-slot="0"] button[aria-label="별도 창으로"]').click()`)
  const popTarget=await until(async()=> (await cdpTargets(PORT)).find(t=>t.type==='page'&&t.url.includes('#mapanel')),'panel popout',20000)
  const mainPage=page
  extraPages.push(mainPage)
  page=await Cdp.connect(popTarget.webSocketDebuggerUrl)
  await until(()=>ev(`document.querySelectorAll('.ext-context-source').length===2`),'popout context')
  check('Detached panel keeps both session connections and selection settings',await ev(`document.querySelector('.ext-context-source[data-client-id="${code}"] .ext-include').getAttribute('aria-checked')==='false'`))
  const beforePop=userInputs().length
  await send('Use the tool state and the custom selection')
  await until(()=>Promise.resolve(userInputs().length>beforePop),'popout engine prompt')
  const popPrompt=promptOf(userInputs().at(-1))
  check('Detached panel sends tool state when its selection checkbox is off',popPrompt.includes('"phase":8')&&!popPrompt.includes('MULTI_CODE_ONLY')&&popPrompt.includes('CUSTOM_SAME_SESSION')&&!popPrompt.includes('MULTI_DATA_ONLY'))
  await labApi('publish',{tool:'custom',document:sourceDoc('CUSTOM_QUEUED_POPOUT',21)})
  await until(()=>ev(`document.querySelector('.external-context-tray').textContent.includes('CUSTOM_QUEUED_POPOUT')`),'popout queued selection')
  await send('Keep this queued snapshot','body',true)
  await until(()=>ev(`document.querySelectorAll('.sched-item').length===1`),'popout queued draft')
  await labApi('publish',{tool:'custom',document:sourceDoc('CUSTOM_LATER_POPOUT',22)})
  await until(()=>Promise.resolve(userInputs().length>=beforePop+2),'popout queued engine prompt',18000)
  check('Detached panel queues preserve their original context',promptOf(userInputs().at(-1)).includes('CUSTOM_QUEUED_POPOUT')&&!promptOf(userInputs().at(-1)).includes('CUSTOM_LATER_POPOUT'))
  await until(()=>ev(`!document.querySelector('.send.stop')`),'popout run finishes',18000)
  await openConnections()
  await ev(`document.querySelector('.ext-popover [data-client-id="${custom}"] .ext-remove').click()`)
  await until(async()=> !binding(await snapshot(),custom,codeChat),'disconnect X')
  await until(()=>ev(`!!document.querySelector('.ext-popover [data-client-id="${custom}"] .ext-connect-button')`),'disconnected tool available in UI')
  check('Disconnect removes only that binding and makes the running tool available again',!!binding(await snapshot(),code,codeChat)&&!!binding(await snapshot(),data,dataChat))
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  await shot('native-detached-session')
  const popPanelId=(await ev(`window.api.multi.panelHydrate()`)).panelId
  page.close();page=mainPage;extraPages.length=0
  const echo=await until(()=>ev(`window.__externalTestEvents?.find(e=>e.event==='chat:event'&&e.payload.chatId===${JSON.stringify(codeChat)}&&e.payload.event.type==='user-echo'&&e.payload.event.text==='Keep this queued snapshot')`),'popout echo')
  check('Other views receive the frozen context with the user-message echo',echo.payload.event.externalContext.sources.some(s=>s.items?.some(i=>i.title==='CUSTOM_QUEUED_POPOUT')))
  await ev(`window.api.multi.panelClose(${JSON.stringify(popPanelId)})`)
  await until(()=>ev(`!!document.querySelector('.ma-panel[data-slot="0"] .composer')`),'popout returned')
  await ev(`document.querySelector('.ma-count-btn[data-count="4"]').click()`)
  await until(()=>ev(`document.querySelectorAll('.ma-panel').length===4`),'four visible sessions')
  const sharedChats=[codeChat]
  for(let slot=1;slot<4;slot++)sharedChats.push(await connectTool(code,`.ma-panel[data-slot="${slot}"]`))
  await ev(`document.querySelector('.ma-panel[data-slot="0"] .ext-context-source[data-client-id="${code}"] .ext-include').click()`)
  await until(async()=>binding(await snapshot(),code,codeChat)?.includeSelection===true,'first session includes selection again')
  await labApi('publish',{tool:'code',document:sourceDoc('FOUR_SHARED_SELECTION',31)})
  await until(()=>ev(`document.querySelectorAll('.ma-panel .ext-context-source[data-client-id="${code}"]').length===4&&[...document.querySelectorAll('.ma-panel .ext-context-source[data-client-id="${code}"]')].every(e=>e.textContent.includes('FOUR_SHARED_SELECTION'))`),'selection in all four sessions')
  check('One external tool simultaneously supplies all four session panels',new Set(sharedChats).size===4)
  check('The UI offers Connect without a Move here action',await ev(`!document.body.innerText.includes('이 세션으로 이동')`))
  await openConnections('.ma-panel[data-slot="2"]')
  await ev(`document.querySelector('.ext-popover [data-client-id="${code}"] [role="switch"]').click()`)
  await until(async()=>binding(await snapshot(),code,sharedChats[2])?.enabled===false,'third session OFF')
  await labApi('publish',{tool:'code',document:sourceDoc('FOUR_LATEST_SELECTION',32)})
  await until(()=>ev(`document.querySelectorAll('.ma-panel .ext-context-source[data-client-id="${code}"]').length===3&&[...document.querySelectorAll('.ma-panel .ext-context-source[data-client-id="${code}"]')].every(e=>e.textContent.includes('FOUR_LATEST_SELECTION'))`),'remaining sessions updated')
  const afterOff=await snapshot()
  check('Turning a shared tool OFF affects only that session',sharedChats.filter((chat,i)=>i!==2).every(chat=>binding(afterOff,code,chat)?.enabled))
  await openConnections('.ma-panel[data-slot="1"]')
  await ev(`document.querySelector('.ext-popover [data-client-id="${code}"] .ext-remove').click()`)
  await until(async()=> !binding(await snapshot(),code,sharedChats[1]),'second session disconnected')
  const afterDisconnect=await snapshot()
  check('Disconnecting a shared tool preserves the other sessions and their preferences',!!binding(afterDisconnect,code,sharedChats[0])&&binding(afterDisconnect,code,sharedChats[2])?.enabled===false&&binding(afterDisconnect,code,sharedChats[3])?.enabled===true)
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
  writeScenario('shared-off-fixture',desktop)
  const beforeOff=userInputs().length;await send('This session disabled the shared tool','.ma-panel[data-slot="2"]')
  await until(()=>Promise.resolve(userInputs().length>beforeOff),'shared OFF engine input')
  check('OFF session engine input omits data even while other sessions use that tool',!promptOf(userInputs().at(-1)).includes('External tool context'))
  await until(()=>ev(`!document.querySelector('.ma-panel[data-slot="2"] .send.stop')`),'shared OFF run complete',18000)
  writeScenario('external-tools-multi-fixture',desktop)
  const beforeShared=userInputs().length;await send('Use the shared selection here','.ma-panel[data-slot="0"]')
  await until(()=>Promise.resolve(userInputs().length>beforeShared),'shared ON input')
  check('ON session receives its own captured shared-tool data',promptOf(userInputs().at(-1)).includes('FOUR_LATEST_SELECTION')&&promptOf(userInputs().at(-1)).includes('"phase":32'))
  await labApi('publish',{tool:'code',document:sourceDoc('FOUR_QUEUED_SELECTION',33)})
  await until(()=>ev(`document.querySelector('.ma-panel[data-slot="0"] .external-context-tray').textContent.includes('FOUR_QUEUED_SELECTION')`),'shared queue preview')
  await send('Keep this shared selection snapshot','.ma-panel[data-slot="0"]',true)
  await until(()=>ev(`document.querySelector('.ma-panel[data-slot="0"] .sched-item')!==null`),'shared queued draft')
  await labApi('publish',{tool:'code',document:sourceDoc('FOUR_AFTER_QUEUE',34)})
  await until(()=>Promise.resolve(userInputs().length>=beforeShared+2),'shared queued input',18000)
  check('Shared-tool queues keep their snapshot across later global tool updates',promptOf(userInputs().at(-1)).includes('FOUR_QUEUED_SELECTION')&&!promptOf(userInputs().at(-1)).includes('FOUR_AFTER_QUEUE'))
  await until(()=>ev(`!document.querySelector('.ma-panel[data-slot="0"] .send.stop')`),'shared queued run complete',18000)
  const savedBindings=(await snapshot()).clients.find(c=>c.id===code).bindings
  page.close();page=null;killTree(native.pid);native=runNative();page=await connectMainPage(PORT,{timeoutMs:60000})
  await until(async()=>{const c=(await snapshot()).clients.find(c=>c.id===code);return c?.online&&JSON.stringify(c.bindings)===JSON.stringify(savedBindings)},'all shared settings restored',30000)
  check('Restart restores every shared binding, independent OFF state, and disconnection',true)
  await until(()=>ev(`document.querySelectorAll('.ma-panel').length===4`),'restored four-panel UI')
  await shot('native-four-shared-sessions')
  report.ok=true
}catch(error){
  report.ok=false;report.error=error.stack;console.error(error.stack)
  if(page){try{write(path.join(HOME,'last-dom.txt'),await ev('document.body.innerText'));write(path.join(HOME,'last-events.json'),await ev('window.__externalTestEvents||[]'));write(path.join(HOME,'last-bridge.json'),await snapshot());await shot('failure')}catch{}}
  process.exitCode=1
}finally{
  write(path.join(HOME,'native.log'),nativeLog.join(''))
  write(path.join(HOME,'report.json'),report)
  try{await labApi('shutdown',{})}catch{}
  extraPages.forEach(p=>p.close());labPage?.close();page?.close();if(edge)killTree(edge.pid);if(lab)killTree(lab.pid);if(native)killTree(native.pid)
  console.log(JSON.stringify({ok:report.ok,checks:report.checks.length,home:HOME,report:path.join(HOME,'report.json')}))
}
