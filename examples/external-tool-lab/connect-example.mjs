import { ExternalToolClient } from './client.mjs'

const client = new ExternalToolClient({
  id: 'com.example.my-tool',
  instanceId: 'example-workspace-1',
  name: 'My Tool',
  version: '1.0.0',
  icon: 'code'
})

client.on('status', ({ connected, bindings, error }) => {
  console.log({ connected, connectedSessions: bindings.length, error })
})
client.start()

// Replace this sample with the current selection/state from your program.
// Call publish again whenever the selection or state changes.
await client.publish({
  items: [{ id: 'selection', kind: 'code/selection', title: 'example.ts : 1–1', text: 'const greeting = "Hello, AgentCodeGUI";' }],
  state: { activeDocument: 'example.ts', unsavedChanges: false }
})

const close = () => { void client.close().finally(() => process.exit(0)) }
process.once('SIGINT', close)
process.once('SIGTERM', close)
