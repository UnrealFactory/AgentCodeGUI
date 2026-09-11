// Native Codex async-question -> real question card -> turn/steer regression.
// Fake account and app-server only. Requires Vite (5273) and a debug Tauri build.
// node scripts/poc-codex-questions.mjs [--keep]
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import {connectMainPage,killTree,quietHome,sleep} from '../bench/lib.mjs';
const repo=process.cwd(),home=fs.mkdtempSync(path.join(repo,'node_modules/.cache/codex-questions-'));
const port=19424,email='question-demo@example.test',panelId='default::0';
const write=(name,data)=>fs.writeFileSync(path.join(home,name),typeof data==='string'||Buffer.isBuffer(data)?data:JSON.stringify(data));
quietHome(home);
write('ui-prefs.json',{'ui.lang':'ko','workspace.mode':'multi'});
write('fixture.html','<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/src/styles.css"><div id="question-host-ready"></div><script type="module" src="/src/api/shim.ts"></script>');
write('synthetic-auth.json',{tokens:{account_id:email,access_token:'synthetic-only'}});
const ps=script=>spawnSync('powershell',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8'});
const sealed=ps(`Add-Type -AssemblyName System.Security\n[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([IO.File]::ReadAllBytes('${path.join(home,'synthetic-auth.json').replaceAll("'","''")}'),$null,'CurrentUser'))`);
assert.equal(sealed.status,0,sealed.stderr);
write('codex-accounts.json',{version:1,accounts:[{email,plan:'plus',authEnc:sealed.stdout.trim()}]});
write('fake-server.cjs',`
const fs=require('node:fs'),readline=require('node:readline');
const log=${JSON.stringify(path.join(home,'requests.jsonl'))};let seq=0,turn='',mode='',failed=false;
const logOut=console.log;console.log=line=>{fs.appendFileSync(log,JSON.stringify({direction:'out',value:JSON.parse(line)})+'\\n');logOut(line)};
const emit=(method,params)=>console.log(JSON.stringify({jsonrpc:'2.0',method,params}));
const item=(text,questions=null)=>emit('item/completed',{threadId:'th-question',turnId:turn,item:{type:'agentMessage',id:'item-'+process.pid+'-'+(++seq),text,phase:'commentary',questions}});
const finish=()=>{if(!turn)return;item('답변을 반영해서 계속 진행했습니다.');emit('turn/completed',{threadId:'th-question',turn:{id:turn,status:'completed',items:[],error:null}});turn=''};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(m)+'\\n');
 const reply=result=>console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
 if(m.id==null)return;
 if(!m.method){finish();return;}
 if(m.method==='initialize')return reply({userAgent:'synthetic-codex'});
 if(m.method==='thread/start'||m.method==='thread/resume')return reply({thread:{id:'th-question'}});
 if(m.method==='model/list')return reply({data:[],nextCursor:null});
 if(m.method==='skills/list')return reply({data:[]});
 if(m.method==='mcpServerStatus/list')return reply({data:[],nextCursor:null});
 if(m.method==='thread/backgroundTerminals/list')return reply({terminals:[]});
 if(m.method==='account/rateLimits/read')return reply({rateLimits:{planType:'plus',primary:{usedPercent:2,windowDurationMins:300,resetsAt:2000000000}}});
 if(m.method==='turn/start'){
  turn='turn-'+(++seq);mode=m.params.input.map(i=>i.text||'').join('');failed=false;reply({turn:{id:turn}});emit('turn/started',{threadId:'th-question',turn:{id:turn}});
  setTimeout(()=>{
   if(mode.startsWith('사용자가 질문에 답했습니다.'))return finish();
   if(mode==='sync')return console.log(JSON.stringify({id:700,method:'item/tool/requestUserInput',params:{threadId:'th-question',turnId:turn,itemId:'sync-item',questions:[{id:'q1',header:'확인',question:'기존 질문도 동작하나요?',options:[{label:'동작해요',description:''}]}]}}));
   item('답변이 이미 끝난 대화에서도 위아래로 스크롤하면 글자가 떨리나요?', [{title:'답변이 이미 끝난 대화에서도 위아래로 스크롤하면 글자가 떨리나요?',options:mode==='free'?null:['끝난 답변에서도 발생해요','AI가 답변하는 중에만 발생해요','둘 다 그런 것 같아요']}]);
   if(mode==='late')setTimeout(finish,150);
  },200);return;
 }
 if(m.method==='turn/steer'){
  if(mode==='fail'&&!failed){failed=true;return setTimeout(()=>console.log(JSON.stringify({id:m.id,error:{code:-32600,message:'temporary test failure'}})),500)}
  if(m.params.expectedTurnId!==turn)return console.log(JSON.stringify({id:m.id,error:{code:-32600,message:'no active turn'}}));
  setTimeout(()=>{reply({turnId:turn});setTimeout(finish,100)},600);return;
 }
 if(m.method==='turn/interrupt'){reply({});finish();return;}
 reply({});
});
`);
write('fake-codex.cmd',`@echo off\r\n"${process.execPath}" "${path.join(home,'fake-server.cjs')}"\r\n`);
const bundle=await build({stdin:{resolveDir:repo,loader:'tsx',contents:`
import React,{useReducer,useEffect} from 'react';import {createRoot} from 'react-dom/client';
import {QuestionModal,MessageView} from './app/src/components/Chat';import {reducer,engineAction,initialSessionState} from './app/src/store/session';
if(window.__questionSavedApi)window.api=window.__questionSavedApi;
const api=window.api,host=document.createElement('div');host.id='question-fixture';document.body.append(host);const root=createRoot(host);
window.qaTest={events:[],close:()=>{root.unmount();host.remove();location.assign('http://localhost:5273/')}};
function Preview(){const [state,dispatch]=useReducer(reducer,initialSessionState);window.qaTest.state=state;window.qaTest.dispatch=dispatch;
 useEffect(()=>api.multi.onEvent('${panelId}',e=>{window.qaTest.events.push(e);dispatch(engineAction(e))}),[]);
 const answer=answers=>{api.multi.respondQuestion({panelId:'${panelId}',requestId:state.pendingQuestion.requestId,answers});dispatch({type:'answer-question',answers})};
 const dismiss=()=>{api.multi.respondQuestion({panelId:'${panelId}',requestId:state.pendingQuestion.requestId,answers:null});dispatch({type:'clear-question'})};
 return <div style={{position:'fixed',inset:0,zIndex:65,background:'#101010',display:'flex',flexDirection:'column',padding:24}}><div>질문 카드 확인용 샘플 <button style={{float:'right'}} onClick={()=>window.qaTest.close()}>닫기</button></div><div className='ma-panel' style={{flex:1,marginTop:18}}><div className='ma-p-body'><div className='chat-scroll scroll'><div className='thread'>{state.messages.map(m=><MessageView key={m.id} item={m}/>)}</div></div></div><QuestionModal question={state.pendingQuestion} onAnswer={answer} onDismiss={dismiss}/></div></div>
}
root.render(<Preview/>);
`},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',alias:{'@shared':path.join(repo,'src/shared')},loader:{'.css':'empty'},plugins:[{name:'vite-raw',setup(b){
 b.onResolve({filter:/\?raw$/},a=>({path:path.resolve(a.resolveDir,a.path.slice(0,-4)),namespace:'raw'}));
 b.onLoad({filter:/.*/,namespace:'raw'},a=>({contents:fs.readFileSync(a.path,'utf8'),loader:'text'}));
}}],define:{'import.meta.glob':'__previewGlob','process.env.NODE_ENV':'"production"'},banner:{js:'var __previewGlob=()=>({});'},logLevel:'silent'});
const env={...process.env,CCG_HOME:home,CCG_NO_NET:'0',CCG_NO_BOOT_ENGINE_UPDATE:'1',CCG_CODEX_BIN:path.join(home,'fake-codex.cmd'),CCG_CDP_PORT:String(port),CCG_ENGINE_LOG:path.join(home,'wire.jsonl')};delete env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
const output=fs.openSync(path.join(home,'native.log'),'a');
const launched=spawn(path.join(repo,'target/debug/agentcodegui.exe'),[],{windowsHide:true,detached:true,env,stdio:['ignore',output,output]});launched.unref();fs.closeSync(output);
const pid=launched.pid;let c,keep=false;
try{
 c=await connectMainPage(port,{timeoutMs:30000});const ev=s=>c.eval(s,{awaitPromise:true,timeoutMs:30000});
 const until=async expr=>{for(let i=0;i<180;i++){if(await ev(expr))return;await sleep(80)}console.log('DEBUG',await ev(`window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:'engine:debug',payload:[]})`));throw Error('Timed out '+expr+'\n'+await ev('JSON.stringify(window.qaTest?.events.slice(-8))'))};
 const ok=(name,value)=>{assert.ok(value,name);console.log('PASS '+name)};
 await c.send('Page.navigate',{url:'http://localhost:5273/@fs/'+path.join(home,'fixture.html').replaceAll('\\','/')});
 await until('!!document.querySelector("#question-host-ready")&&!!window.api?.multi');await ev('window.__questionSavedApi=window.api');await ev(bundle.outputFiles[0].text);await ev('delete window.__questionSavedApi');await sleep(300);
 const logs=()=>fs.existsSync(path.join(home,'requests.jsonl'))?fs.readFileSync(path.join(home,'requests.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 const run=async prompt=>{await ev(`window.qaTest.events=[];window.qaTest.dispatch({type:'load',state:{...window.qaTest.state,pendingQuestion:null}})`);await ev(`window.api.multi.run(${JSON.stringify({panelId,prompt,engine:'codex',model:'sonnet',codexModel:'gpt-5.6-sol',codexAccount:email,effort:'low',mode:'bypass',cwd:repo,resume:'th-question'})})`);await until('!!window.qaTest.state.pendingQuestion');};
 const click=async index=>ev(`document.querySelectorAll('#question-fixture .qcard .qopt')[${index}].click()`);
 const done=()=>until(`window.qaTest.events.some(e=>e.type==='result')`);
 await run('normal');ok('Async question opens a card with all options',await ev(`document.querySelectorAll('#question-fixture .qcard .qopt').length===4&&window.qaTest.state.pendingQuestion.nonBlocking===true`));
 const count=logs().filter(m=>m.method==='turn/steer').length;await click(1);await until('!!window.qaTest.state.pendingQuestion?.answering');ok('Card waits for server acceptance',await ev(`!!document.querySelector('#question-fixture .qcard[aria-busy="true"]')`));
 await ev(`window.api.multi.respondQuestion({panelId:'${panelId}',requestId:window.qaTest.state.pendingQuestion.requestId,answers:[['AI가 답변하는 중에만 발생해요']]})`);
 await until('!window.qaTest.state.pendingQuestion');await done();ok('Duplicate clicks send a single reply',logs().filter(m=>m.method==='turn/steer').length===count+1);
 ok('Answer joins the active turn without interruption',logs().some(m=>m.method==='turn/steer'&&m.params.input[0].text.includes('AI가 답변하는 중에만 발생해요'))&&!logs().some(m=>m.method==='turn/interrupt'));
 ok('Accepted answer leaves a question-and-answer record',await ev(`window.qaTest.state.messages.some(m=>m.kind==='qa'&&m.pairs[0].a[0]==='AI가 답변하는 중에만 발생해요')`));
 await run('late');await done();ok('Unanswered card survives turn completion',await ev('!!window.qaTest.state.pendingQuestion'));await click(0);await until('!window.qaTest.state.pendingQuestion');await sleep(700);ok('Late answer starts a follow-up turn',logs().some(m=>m.method==='turn/start'&&m.params.input[0].text.startsWith('사용자가 질문에 답했습니다.')));
 await run('fail');await click(1);await until(`window.qaTest.events.some(e=>e.type==='notice'&&e.text.includes('temporary test failure'))`);ok('Failed reply keeps the card available for retry',await ev('!!window.qaTest.state.pendingQuestion&&!window.qaTest.state.pendingQuestion.answering'));await click(1);await until('!window.qaTest.state.pendingQuestion');await done();ok('Retry is accepted without stopping the run',true);
 await run('free');ok('Free-text-only question opens',await ev(`document.querySelectorAll('#question-fixture .qcard .qopt').length===1`));await ev(`window.api.multi.respondQuestion({panelId:'${panelId}',requestId:window.qaTest.state.pendingQuestion.requestId,answers:[['직접 입력한 답']]});window.qaTest.dispatch({type:'answer-question',answers:[['직접 입력한 답']]})`);await until('!window.qaTest.state.pendingQuestion');await done();ok('Free text reaches Codex unchanged',logs().some(m=>m.method==='turn/steer'&&m.params.input[0].text.includes('직접 입력한 답')));
 await run('sync');ok('Existing blocking questions still open',await ev('!window.qaTest.state.pendingQuestion.nonBlocking'));await click(0);await done();ok('Blocking answer retains the JSON-RPC question-id response',logs().some(m=>m.id===700&&m.result?.answers?.q1?.answers?.[0]==='동작해요'));
 if(process.argv.includes('--keep')){await run('normal');await ev('window.qaTest.dispatch({type: '+JSON.stringify('load')+',state:{...window.qaTest.state,messages:window.qaTest.state.messages.slice(-1)}})');await sleep(250);const shot=await c.send('Page.captureScreenshot',{format:'png'});write('question-preview.png',Buffer.from(shot.data,'base64'));keep=true;fs.writeFileSync(path.join(repo,'node_modules/.cache/dev-question-preview.json'),JSON.stringify({home,port,pid}));console.log('Preview '+home);await c.send('Page.bringToFront');}
}finally{c?.close();if(!keep)killTree(pid)}
