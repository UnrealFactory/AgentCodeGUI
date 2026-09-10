import assert from 'node:assert/strict'
import test from 'node:test'
import { ArchiveRecordingSwitch } from '../app/src/lib/archiveRecordingSwitch.ts'

const config = {cwd:'C:/project', roots:['C:/project'], title:''}
const status = (enabled, extra={}) => ({status:{enabled,...extra}})
const deferred = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
const tick = () => new Promise(resolve=>setImmediate(resolve))

test('clicks update immediately and the last intent survives a slow prior write',async()=>{
 const writes=[]
 const control=new ArchiveRecordingSwitch(async()=>status(false), c=>{const wait=deferred();writes.push({enabled:c.enabled,...wait});return wait.promise})
 await control.refresh()
 control.toggle(config)
 assert.equal(control.getSnapshot().enabled,true)
 assert.equal(control.getSnapshot().pending,true)
 control.toggle(config)
 assert.equal(control.getSnapshot().enabled,false)
 assert.deepEqual(writes.map(w=>w.enabled),[true])
 writes[0].resolve(status(true));await tick()
 assert.deepEqual(writes.map(w=>w.enabled),[true,false])
 assert.equal(control.getSnapshot().enabled,false,'an old ON reply must not flash over the requested OFF')
 writes[1].resolve(status(false));await tick()
 assert.equal(control.getSnapshot().pending,false)
 assert.equal(control.getSnapshot().enabled,false)
})

test('rapid ON OFF ON clicks coalesce to a single matching write',async()=>{
 const wait=deferred();let calls=0
 const control=new ArchiveRecordingSwitch(async()=>status(false),async()=>{calls++;return wait.promise})
 await control.refresh()
 control.toggle(config);control.toggle(config);control.toggle(config)
 assert.equal(control.getSnapshot().enabled,true)
 wait.resolve(status(true));await tick()
 assert.equal(calls,1)
 assert.equal(control.getSnapshot().pending,false)
})

test('a stale status response cannot roll back a completed click',async()=>{
 const poll=deferred();let reads=0
 const control=new ArchiveRecordingSwitch(()=>++reads===1?Promise.resolve(status(false)):poll.promise,async()=>status(true))
 await control.refresh()
 const refresh=control.refresh()
 control.toggle(config);await tick()
 assert.equal(control.getSnapshot().enabled,true)
 poll.resolve(status(false));await refresh
 assert.equal(control.getSnapshot().enabled,true)
})

test('file preparation and capture errors do not alter the header state or trigger an action notice',async()=>{
 let live=status(true)
 const control=new ArchiveRecordingSwitch(async()=>live,async()=>status(false))
 await control.refresh();const snapshot=control.getSnapshot()
 live=status(true,{preparing:true,fileCount:100,error:'some file is locked'})
 await control.refresh()
 assert.equal(control.getSnapshot(),snapshot,'unchanged ON/OFF must not repaint for file progress')
 assert.equal(control.getSnapshot().error,'')
})

test('a failed setting change restores the confirmed state and remains retryable',async()=>{
 let fail=true
 const control=new ArchiveRecordingSwitch(async()=>status(false),async()=>{if(fail)throw new Error('setting failed');return status(true)})
 await control.refresh();control.toggle(config);await tick()
 assert.equal(control.getSnapshot().enabled,false)
 assert.equal(control.getSnapshot().pending,false)
 assert.equal(control.getSnapshot().error,'setting failed')
 fail=false;control.toggle(config);await tick()
 assert.equal(control.getSnapshot().enabled,true)
 assert.equal(control.getSnapshot().error,'')
})

test('a failure after the backend changed state restores the actual state',async()=>{
 let enabled=false
 const control=new ArchiveRecordingSwitch(async()=>status(enabled),async()=>{enabled=true;throw new Error('could not flush preference')})
 await control.refresh();control.toggle(config);await tick()
 assert.equal(control.getSnapshot().enabled,true)
 assert.equal(control.getSnapshot().pending,false)
 assert.match(control.getSnapshot().error,/flush/)
})

test('pending intent finishes after the view unmounts before its controller is released',async()=>{
 const writes=[];let releases=0
 const control=new ArchiveRecordingSwitch(async()=>status(false),c=>{const wait=deferred();writes.push({enabled:c.enabled,...wait});return wait.promise},()=>releases++)
 const unsubscribe=control.subscribe(()=>{})
 await control.refresh();control.toggle(config);control.toggle(config);unsubscribe();await tick()
 assert.equal(releases,0)
 writes[0].resolve(status(true));await tick()
 writes[1].resolve(status(false));await tick()
 assert.equal(control.getSnapshot().enabled,false)
 assert.equal(releases,1)
})
