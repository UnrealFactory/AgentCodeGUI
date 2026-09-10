// Open the real app + an independent adapter in a disposable profile.
// The existing installed app and its account/profile remain in use.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, REPO, sleep } from '../bench/lib.mjs'

const option=name=>process.argv.find(a=>a.startsWith(name+'='))?.slice(name.length+1)
const home=fs.mkdtempSync(path.join(REPO,'.poc-home-external-preview-'))
const work=path.join(home,'work')
const write=(name,value)=>{const file=path.join(home,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value))}
const server=net.createServer()
const port=await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port))})})
const env={...process.env,CCG_HOME:home,CCG_NO_NET:'1',CCG_NO_BOOT_ENGINE_UPDATE:'1',CCG_CDP_PORT:String(port),CCG_FAKECLI_SCRIPT:path.join(home,'script.jsonl')}
fs.mkdirSync(work,{recursive:true})
write('work/README.md','# 외부 도구 연결 테스트\n\n이 창은 검증 전용 프로필입니다. AI 답변은 고정된 테스트 응답입니다.\n')
const engine='engines/fake/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'
write(engine,'')
fs.copyFileSync(path.join(REPO,'target/debug/ccg-fakecli.exe'),path.join(home,engine))
write('engines/fake/node_modules/@anthropic-ai/claude-agent-sdk/package.json',{name:'@anthropic-ai/claude-agent-sdk',version:'fake'})
write('config.json',{activeVersion:'fake'})
write('engine-auto-update.json',{enabled:false})
const account=spawnSync(path.join(REPO,'target/debug/ccg-auth-probe.exe'),['seed','preview@fake.test'],{env,windowsHide:true,stdio:'pipe'})
if(account.status!==0)throw new Error('Could not seed the isolated preview account')
write('ui-prefs.json',{'ui.lang':'ko','workspace.mode':'single','whatsnew.seenVersion':JSON.parse(fs.readFileSync(path.join(REPO,'src-tauri/tauri.conf.json'),'utf8')).version,'sidebar.autohide':false})
write('profile.json',{nickname:'외부 도구 연결 테스트'})
write('chats/index.json',{version:1,order:['external-preview','external-preview-b'],activeChatId:'external-preview'})
for(const [id,title] of [['external-preview','외부 도구 연결 · 검증용 앱'],['external-preview-b','두 번째 세션']])write('chats/'+id+'.json',{id,title,custom:true,manualCwd:work,picker:{model:'haiku',effort:'minimal',mode:'normal',account:'preview@fake.test'},refDirs:[],snapshot:{messages:[]},updatedAt:Date.now()})
const steps=[{emit:{type:'control_response',response:{subtype:'success',request_id:'init-1',response:{}}}},{emit:{type:'system',subtype:'init',session_id:'external-preview',cwd:work,model:'claude-haiku-4-5',tools:[],mcp_servers:[]}}]
for(let turn=1;turn<=50;turn++)steps.push({awaitUser:turn},{afterMs:200,emit:{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'검증용 응답입니다. 실제 AI는 실행하지 않았습니다.\n\n보낸 메시지 위의 도구 첨부를 펼치면 전송 당시 선택 내용과 도구 상태를 확인할 수 있습니다. 테스트 도구에서 선택을 바꾼 뒤 다시 보내거나, 연결 스위치를 꺼서 비교해 보세요.'}]}}},{afterMs:1800,emit:{type:'result',subtype:'success',is_error:false,terminal_reason:'completed',result:'Preview complete',session_id:'external-preview',duration_ms:2000,num_turns:1,total_cost_usd:0}})
write('script.jsonl',steps.map(s=>JSON.stringify(s)).join('\n'))
const app=spawn(path.join(REPO,'target/debug/agentcodegui.exe'),[],{env,windowsHide:true,stdio:'ignore',detached:true})
app.unref()
const toolRoot=path.resolve(option('--tool-dir')||path.join(REPO,'examples/external-tool-lab'))
const lab=spawn(process.execPath,[path.join(toolRoot,'server.mjs'),'--app-home='+home,'--ready-file='+path.join(home,'lab-ready.json'),'--open'],{windowsHide:true,stdio:'ignore',detached:true})
lab.unref()
write('preview-processes.json',{appPid:app.pid,labPid:lab.pid,home,port})
const page=await connectMainPage(port,{timeoutMs:45000})
try{
  for(let i=0;i<150;i++){
    if(await page.eval("!!window.__TAURI_INTERNALS__&&!!document.querySelector('.ext-chip')").catch(()=>false))break
    await sleep(100)
  }
  const ipc=(channel,arg)=>page.eval(`window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:${JSON.stringify(channel)},payload:[${JSON.stringify(arg||{})}]})`,{awaitPromise:true})
  for(let i=0;i<150;i++){
    const snapshot=await ipc('bridge:snapshot')
    const ready=snapshot.clients?.filter(c=>c.online&&['dev.agentcodegui.lab.code','dev.agentcodegui.lab.data'].includes(c.manifest.id))
    if(ready?.length===2){for(const client of ready)await ipc('bridge:bind',{clientId:client.id,address:'external-preview'});break}
    await sleep(200)
  }
  console.log(JSON.stringify({appPid:app.pid,labPid:lab.pid,home,port}))
}finally{page.close()}
