// Real React notification hook + session reducer in an isolated native WebView.
// Captures notify:event calls; no accounts, model calls, or real toast popups.
// Requires Vite on 5273 and target/debug/agentcodegui.exe.
// node scripts/poc-turn-notify.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { connectMainPage, killTree, quietHome, sleep } from '../bench/lib.mjs'

const repo = process.cwd()
const home = quietHome(fs.mkdtempSync(path.join(repo, 'node_modules/.cache/turn-notify-')))
const port = 19429
const fixture = path.join(home, 'fixture.html')
fs.writeFileSync(fixture, '<!doctype html><meta charset="utf-8"><div id="notify-fixture"></div>')
const bundle = await build({
  stdin: { resolveDir: repo, loader: 'tsx', contents: `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useTurnNotifyList } from './app/src/lib/notify'
import { initialSessionState, reducer as sessionReducer } from './app/src/store/session'

const events = [], checks = []
window.api = { notify: { event: async e => { events.push(e) } } }
const root = createRoot(document.getElementById('notify-fixture'))
function Watch({ items }) { useTurnNotifyList(items); return null }
let generation = 0
const watchItem = (state, target) => ({state,busy:['analyzing','working'].includes(state.status),title:target.id,target})
const showItems = items => flushSync(() => root.render(<Watch key={generation} items={items}/>))
const show = (state, id = 'a') => showItems([watchItem(state,{surface:'single',id})])
const apply = (state, e) => sessionReducer(state, {type:'engine',event:e})
const status = (state, value, runId = state.curRunId) => apply(state, {type:'status',status:value,runId})
const reply = (state, id, text) => apply(state, {type:'assistant-done',messageId:id,text})
const start = (state, id) => status(state, 'analyzing', id)
const old = { ...initialSessionState, status:'done', curRunId:'old-run', messages:[{kind:'msg',id:'old-reply',role:'assistant',text:'Previously finished answer',animate:false,time:'12:00'}] }
const reset = (state = old) => { generation++; events.length = 0; show(state) }
const check = (name, ok) => checks.push({name,ok, ...(!ok ? {events:[...events]} : {})})

reset(); check('Opening completed history does not notify', events.length === 0)
let s = start(old, 'new-run'); show(s)
s = reply(s, 'new-reply', 'Fresh answer'); show(s)
s = status(s, 'done'); show(s)
check('A fresh reply sends one completion with its own preview', events.length === 1 && events[0].kind === 'done' && events[0].preview === 'Fresh answer')
const delivered = events.length
show(status(s, 'working')); show(s)
check('Repeated working/done statuses do not resend the same reply', events.length === delivered)

reset(); s = start(old, 'cleanup-run'); show(s); s = status(s, 'done'); show(s)
check('A silent internal cleanup does not announce the previous answer', events.length === 0)

reset(); s = start(old, 'away-run'); show(s)
show(old, 'b')
s = status(reply(s, 'away-reply', 'Finished while away'), 'done'); show(s)
check('Returning to a completed chat is not a fresh completion', events.length === 0)
s = start(s, 'back-run'); show(s); s = status(reply(s, 'back-reply', 'New reply after returning'), 'done'); show(s)
check('A new turn after returning still notifies', events.length === 1 && events[0].preview === 'New reply after returning')

reset(); s = start(old, 'reset-run'); show(s); show(initialSessionState)
check('Clearing or unloading a busy chat does not announce completion', events.length === 0)

reset(); s = start(old, 'stop-run'); show(s); s = reply(s, 'partial', 'Partial reply'); show(s)
s = sessionReducer(s, {type:'interrupt-turn'}); s = status(s, 'done'); show(s)
check('Batched stop and late done remain silent', events.length === 0)

reset(); s = start(old, 'failed-run'); show(s); s = status(s, 'error'); show(s)
check('Failure notifies without recycling an old successful reply', events.length === 1 && events[0].kind === 'error' && !events[0].preview)

reset(); s = start(old, 'error-text-run'); show(s)
s = apply(s, {type:'error',runId:'error-text-run',message:'New failure'}); s = status(s, 'error'); show(s)
check('Failure preview belongs to the current turn', events.length === 1 && events[0].kind === 'error' && events[0].preview?.includes('New failure'))

reset(); s = start(old, 'approve-run'); show(s)
s = {...s,pendingPermission:{requestId:'p1',toolName:'Bash',summary:'Allow this command?'}}; show(s); show({...s})
check('Approval requests notify once', events.length === 1 && events[0].kind === 'approve')
s = {...s,pendingPermission:{...s.pendingPermission,requestId:'p2',summary:'Allow the next command?'}}; show(s)
check('A replacement approval request is not swallowed', events.length === 2 && events[1].preview === 'Allow the next command?')

reset(); s = start(old, 'question-run'); show(s)
s = {...s,pendingQuestion:{requestId:'q1',questions:[{question:'Pick a color?'}],nonBlocking:true}}; show(s)
s = status(s, 'done'); show(s)
check('A question notifies without an extra completion alert', events.length === 1 && events[0].kind === 'ask')

reset(); s = sessionReducer(old, {type:'begin',text:'/compact',command:'compact',time:'12:01'}); show(s)
s = start(s, 'compact-run'); show(s)
s = apply(s, {type:'result',runId:'compact-run',isError:false,text:'',costUsd:null,durationMs:1000,numTurns:1,contextTokens:100,contextWindow:272000}); show(s)
s = status(s, 'done'); show(s)
check('Command completion uses its own card instead of an old reply', events.length === 1 && events[0].kind === 'done' && events[0].preview?.includes('압축') && !events[0].preview.includes('Previously finished answer'))

reset(); s = start(old, 'background-run'); show(s)
s = {...status(reply(s,'background-reply','Fresh reply with background work'), 'done'),bgTasks:[{id:'bg1',status:'running'}]}; show(s)
check('Fresh replies still notify while background work remains', events.length === 1)

reset(); s = start(old, 'same-text-run'); show(s)
s = status(reply(s,'different-message','Previously finished answer'), 'done'); show(s)
check('A new reply with the same words is still a new reply', events.length === 1)

reset(); s = start(old, 'code-run'); show(s)
s = status(reply(s,'code-message',String.fromCharCode(96,96,96)+'js\\nconst x = 1\\n'+String.fromCharCode(96,96,96)), 'done'); show(s)
check('A reply containing only code still notifies', events.length === 1)

generation++; events.length = 0
const panel = (state, sub) => watchItem(state,{surface:'multi',id:'board',sub})
showItems([panel(old,'0'),panel(old,'1')])
const a = start(old,'panel-a'), b = start(old,'panel-b')
showItems([panel(a,'0'),panel(b,'1')])
const aDone = status(reply(a,'panel-a-reply','First panel reply'),'done')
showItems([panel(b,'1'),panel(aDone,'0')])
check('Reordering panels preserves their notification targets', events.length === 1 && events[0].target.sub === '0')
const bDone = status(reply(b,'panel-b-reply','Second panel reply'),'done')
showItems([panel(bDone,'1'),panel(aDone,'0')])
showItems([panel(status(bDone,'working'),'1'),panel(aDone,'0')])
showItems([panel(bDone,'1'),panel(aDone,'0')])
check('Panels notify independently without repeating completed neighbors', events.length === 2 && events[1].target.sub === '1')

window.notifyChecks = checks
` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  alias: { '@shared': path.join(repo, 'src/shared') }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent'
})
const child = spawn(path.join(repo, 'target/debug/agentcodegui.exe'), [], {
  windowsHide: true, stdio: 'ignore', env: { ...process.env, CCG_HOME: home, CCG_CDP_PORT: String(port),
    CCG_NO_NET: '1', CCG_NO_BOOT_ENGINE_UPDATE: '1', CCG_CODEX_IMPORT_HOME: path.join(home, 'empty-codex') }
})
let c
try {
  c = await connectMainPage(port, {timeoutMs:30000})
  await c.send('Page.navigate', {url:'http://localhost:5273/@fs/'+fixture.replaceAll('\\','/')})
  for (let i=0;i<150;i++) { if(await c.eval('!!document.getElementById("notify-fixture")')) break; await sleep(80) }
  await c.eval(bundle.outputFiles[0].text)
  const checks = await c.eval('window.notifyChecks')
  assert.ok(checks?.length, 'Browser scenarios ran')
  for (const check of checks) console.log((check.ok?'PASS ':'FAIL ')+check.name+(!check.ok?' '+JSON.stringify(check.events):''))
  assert.equal(checks.filter(c=>!c.ok).length, 0, 'Notification regressions')
} finally { c?.close(); killTree(child.pid) }
