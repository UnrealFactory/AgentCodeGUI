// Native IPC + actual account subscription component. --live reuses only the previously
// authorized probe session, in isolated test profiles; it never logs credentials.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { connectMainPage, quietHome, killTree, sleep } from '../bench/lib.mjs'
import { launchBrowser } from '../src-tauri/src/subscription-browser.mjs'

const repo = process.cwd(), cache = path.join(repo, 'node_modules/.cache')
fs.mkdirSync(cache, { recursive: true })
const home = fs.mkdtempSync(path.join(cache, 'subscription-settings-'))
const live = process.argv.includes('--live'), port = 19427
const keys = [{ provider: 'claude', email: 'claude-demo@example.test', identity: 'claude-fixture' }, { provider: 'codex', email: 'gpt-demo@example.test', identity: 'codex-fixture' }]
const slug = email => { let hash=0;for(let i=0;i<email.length;i++)hash=(Math.imul(hash,31)+email.charCodeAt(i))>>>0;return email.toLowerCase().replace(/[^a-z0-9._-]+/g,'_')+'-'+hash.toString(36) }
const relative = key => `web-subscriptions/${key.provider}/${slug(key.email)}`
function write(file, value) { const p=path.join(home,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(value)) }
quietHome(home)
write('ui-prefs.json', { 'ui.lang': 'ko', 'workspace.mode': 'multi', 'whatsnew.seenVersion': '99.0.0' })
if(live){
  const browser='C:/Program Files/Google/Chrome/Application/chrome.exe'
  const source=await launchBrowser({browser,profile:path.join(process.env.LOCALAPPDATA,'AgentCodeGUI/subscription-web-probe'),interactive:false})
  let cookies
  try{cookies=(await source.send('Storage.getCookies')).cookies}finally{await source.close()}
  keys[0].identity=cookies.find(c=>c.name==='lastActiveOrg')?.value
  const root=path.join(process.env.USERPROFILE,'.agentcodegui3/codex/accounts')
  for(const folder of fs.readdirSync(root)){
    const file=path.join(root,folder,'auth.json');if(!fs.existsSync(file))continue
    const auth=JSON.parse(fs.readFileSync(file,'utf8'))
    const claim=JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1],'base64url'))['https://api.openai.com/auth']
    if(claim.chatgpt_subscription_active_until?.startsWith('2026-10-06'))keys[1].identity=claim.chatgpt_account_id
  }
  for(const key of keys){
    assert(key.identity)
    const domain=key.provider==='claude'?'claude.ai':'chatgpt.com'
    const profile=path.join(home,relative(key),'profile')
    const target=await launchBrowser({browser,profile,interactive:false})
    try{
      const selected=cookies.filter(c=>c.domain===domain||c.domain.endsWith('.'+domain)).map(c=>{
        const out={name:c.name,value:c.value,domain:c.domain,path:c.path,secure:c.secure,httpOnly:c.httpOnly}
        for(const k of ['sameSite','priority','partitionKey'])if(c[k]!=null)out[k]=c[k]
        if(c.expires>0)out.expires=c.expires
        return out
      })
      await target.send('Storage.setCookies',{cookies:selected})
    }finally{await target.close()}
  }
}
write('accounts.json',{version:3,accounts:[{email:keys[0].email,subscriptionType:'max'}]})
write(`accounts/${slug(keys[0].email)}/.claude.json`,{oauthAccount:{emailAddress:keys[0].email,organizationUuid:keys[0].identity}})
write('codex-accounts.json',{version:1,accounts:[{email:keys[1].email,plan:'pro'}]})
write(`codex/accounts/${slug(keys[1].email)}/auth.json`,{tokens:{id_token:'h.'+Buffer.from(JSON.stringify({email:keys[1].email,'https://api.openai.com/auth':{chatgpt_account_id:keys[1].identity,chatgpt_plan_type:'pro'}})).toString('base64url')+'.s'}})
for(const key of keys)write(relative(key)+'/status.json',{connected:true,identity:key.identity,browser:'chrome',attemptedAt:live?0:Math.floor(Date.now()/1000),data:live?null:{kind:key.provider==='claude'?'cancels':'renews',date:key.provider==='claude'?'2026-10-03T03:48:50Z':'2026-10-06T09:11:11Z',checkedAt:Math.floor(Date.now()/1000)}})
const code = `
import React from 'react';import {createRoot} from 'react-dom/client';import {AccountSubscription} from '/@fs/${repo.replaceAll('\\','/')}/app/src/components/AccountSubscription.tsx';import {SettingsModal} from '/@fs/${repo.replaceAll('\\','/')}/app/src/components/Settings.tsx';
const host=document.createElement('div');host.id='subscription-fixture';document.body.append(host);
Object.assign(host.style,{position:'fixed',inset:0,zIndex:9999,background:'#121212'});
const root=createRoot(host);
window.subscriptionFixture={full:()=>{window.api.auth.accountsUsage=async()=>[{email:'${keys[0].email}',fiveHourPct:20,weeklyPct:30,fablePct:15}];window.api.codexAuth.accountsUsage=async()=>[{email:'${keys[1].email}',planType:'pro',windows:[{label:'Weekly',usedPct:40}]}];root.render(<SettingsModal initialView="account" onClose={()=>{}}/>)}};
root.render(<div style={{padding:40}}><div style={{maxWidth:800,margin:'30px auto'}}><h2>구독 날짜 · 검증용 계정</h2><p>설정 Account에 표시하는 실제 컴포넌트입니다.</p>
${keys.map(k=>`<div className="sc2 acct" data-provider="${k.provider}"><div className="ava2">${k.provider==='claude'?'C':'G'}</div><div className="who"><div className="em">${k.email}</div><div className="meta">${k.provider==='claude'?'Max':'ChatGPT Pro'}</div><AccountSubscription provider="${k.provider}" email="${k.email}"/></div></div>`).join('')}
</div></div>);
`
const preview=path.join(home,'subscription-preview.tsx')
fs.writeFileSync(preview,code)
const launcher=`$p = Start-Process -FilePath '${path.join(repo,'target/debug/agentcodegui.exe').replaceAll("'","''")}' -WindowStyle Hidden -PassThru\n$p.Id`
const started=spawnSync('powershell',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(launcher,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',env:{...process.env,CCG_HOME:home,CCG_NO_NET:live?'0':'1',CCG_NO_BOOT_ENGINE_UPDATE:'1',CCG_CDP_PORT:String(port),WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`}})
assert.equal(started.status,0);const pid=Number(started.stdout.trim());assert(pid>0)
let c
try{
  c=await connectMainPage(port)
  const ev=expression=>c.eval(expression,{awaitPromise:true})
  const call=(action,args={})=>ev(`window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:'subscriptions:${action}',payload:[${JSON.stringify(args)}]})`)
  const until=async expression=>{const deadline=Date.now()+130000;while(Date.now()<deadline){if(await ev(expression))return;await sleep(150)}throw new Error('Timed out: '+expression)}
  await until('!!window.api')
  await ev(`import(${JSON.stringify('http://localhost:5273/@fs/'+preview.replaceAll('\\','/'))}).then(()=>true)`)
  await until(`document.querySelector('[data-provider="claude"]')?.textContent.includes('취소 예정')&&document.querySelector('[data-provider="codex"]')?.textContent.includes('자동 갱신 예정')`)
  const rows=await call('list')
  assert.equal(rows[0].data.kind,'cancels');assert.equal(rows[1].data.kind,'renews')
  assert(rows.every(r=>r.connected&&r.phase==='idle'&&!r.error))
  console.log('PASS provider dates and statuses through native IPC',live?'live':'fixture')
  const serialized=JSON.stringify(rows)
  assert(!/sessionKey|access_token|refresh_token|authEnc|identity|browserPid/.test(serialized))
  console.log('PASS renderer receives no credentials or internal identifiers')
  assert.equal((await call('connect',{provider:'claude',email:'not-registered@example.test'})).error,'notRegistered')
  console.log('PASS unregistered account rejected')
  if(!live){
    await call('refresh',keys[0])
    await until(`!!document.querySelector('[data-provider="claude"] [role="alert"]')`)
    assert((await call('list'))[0].data.kind==='cancels')
    console.log('PASS failed refresh preserves last known date and shows an error')
  }
  if(live){
    write(`accounts/${slug(keys[0].email)}/.claude.json`,{oauthAccount:{emailAddress:keys[0].email,organizationUuid:'wrong-account-fixture'}})
    await call('refresh',keys[0])
    await until(`(async()=>{const r=await window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:'subscriptions:list',payload:[]});return r[0].phase==='idle'&&r[0].error==='wrongAccount'})()`)
    assert.equal((await call('list'))[0].data,null)
    console.log('PASS different web organization cannot populate the selected account')
    write(`accounts/${slug(keys[0].email)}/.claude.json`,{oauthAccount:{emailAddress:keys[0].email,organizationUuid:keys[0].identity}})
    await call('connect',keys[0])
    await until(`(async()=>{const r=await window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:'subscriptions:list',payload:[]});return r[0].phase==='idle'&&r[0].data?.kind==='cancels'&&!r[0].error})()`)
    console.log('PASS visible reconnect recovers with the matching account')
    await call('connect',keys[0]);await call('cancel',keys[0])
    await until(`(async()=>{const r=await window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:'subscriptions:list',payload:[]});return r[0].phase==='idle'})()`)
    assert((await call('list'))[0].data?.kind==='cancels')
    console.log('PASS cancellation preserves the previous subscription snapshot')
    await call('refresh',keys[0])
    await until(`(async()=>{const r=await window.__TAURI_INTERNALS__.invoke('ipc_call',{channel:'subscriptions:list',payload:[]});return r[0].phase==='idle'&&!r[0].error})()`)
  }
  await ev('window.subscriptionFixture.full()')
  await until(`document.querySelectorAll('#subscription-fixture .sc2.acct').length===2`)
  await c.send('Emulation.setDeviceMetricsOverride',{width:1050,height:750,deviceScaleFactor:1,mobile:false})
  await sleep(200)
  assert(await ev(`[...document.querySelectorAll('#subscription-fixture .acct-subscription')].every(e=>e.scrollWidth<=e.clientWidth+1)`))
  console.log('PASS complete Account settings renders without subscription overflow')
  fs.mkdirSync(path.join(repo,'AgentMonitoring/assets'),{recursive:true})
  const shot=await c.send('Page.captureScreenshot',{format:'png'})
  fs.writeFileSync(path.join(repo,'AgentMonitoring/assets/subscription-settings-validation.png'),Buffer.from(shot.data,'base64'))
  await call('disconnect',keys[0])
  await until(`document.querySelector('#subscription-fixture .set-inner')?.textContent.includes('웹 연결로 구독 날짜 확인')`)
  const remaining=await call('list')
  assert.equal(remaining[0].connected,false);assert.equal(remaining[0].data,null);assert(remaining[1].connected)
  assert(!fs.existsSync(path.join(home,relative(keys[0]))))
  console.log('PASS disconnect removes only the selected account profile and date')
  console.log('ARTIFACT AgentMonitoring/assets/subscription-settings-validation.png')
}finally{
  c?.close();killTree(pid)
  await sleep(500)
  const resolved=fs.realpathSync(home),boundary=fs.realpathSync(cache)+path.sep
  if(!resolved.startsWith(boundary))throw new Error('Unsafe cleanup path')
  fs.rmSync(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:500})
}
