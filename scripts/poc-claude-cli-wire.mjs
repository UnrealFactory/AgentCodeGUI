// PoC — drive the installed Claude Code CLI directly (no Node SDK), exactly the way
// @anthropic-ai/claude-agent-sdk 0.3.239 spawns it, and dump every stdout frame.
// Used to verify docs/protocol-claude-cli.md against the real wire.
//
//   node scripts/poc-claude-cli-wire.mjs            # no-auth smoke run (costs nothing)
//   node scripts/poc-claude-cli-wire.mjs --live     # ONE real turn on the default account
//
// Frames land in <out>/frames.jsonl and a summary is printed.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const LIVE = process.argv.includes('--live')
const ENGINE = process.env.CCG_ENGINE ?? '0.3.239'
const HOME = path.join(os.homedir(), '.agentcodegui')
const CLI = path.join(
  HOME,
  'engines',
  ENGINE,
  'node_modules',
  '@anthropic-ai',
  'claude-agent-sdk-win32-x64',
  process.platform === 'win32' ? 'claude.exe' : 'claude'
)
const OUT = path.join(os.tmpdir(), 'ccg-cli-wire')
fs.mkdirSync(OUT, { recursive: true })
const CWD = path.join(OUT, 'work')
fs.mkdirSync(CWD, { recursive: true })

// config dir: the default account's materialized folder for --live, an empty scratch
// dir otherwise (no credentials → the CLI fails auth at init, which is free).
const accounts = JSON.parse(fs.readFileSync(path.join(HOME, 'accounts.json'), 'utf8'))
const slugDir = fs
  .readdirSync(path.join(HOME, 'accounts'))
  .find((d) => d.startsWith(String(accounts.defaultEmail).replace(/@/g, '_').replace(/\+/g, '-')))
const CONFIG_DIR = LIVE ? path.join(HOME, 'accounts', slugDir) : path.join(OUT, 'noauth-config')
if (!LIVE) fs.mkdirSync(CONFIG_DIR, { recursive: true })

// ── argv: byte-for-byte what ProcessTransport.initialize() builds for the options
// src/main/claude/engine.ts passes (model haiku + minimal effort for the cheap probe).
const settings = JSON.stringify({ permissions: { defaultMode: 'default' } })
const args = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--thinking', 'disabled',
  '--model', 'haiku',
  '--permission-prompt-tool', 'stdio',
  '--setting-sources=user,project,local',
  '--permission-mode', 'default',
  '--include-partial-messages',
  '--settings', settings
]

const env = { ...process.env }
env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
env.CLAUDE_AGENT_SDK_VERSION = ENGINE
env.CLAUDE_CONFIG_DIR = CONFIG_DIR
delete env.NODE_OPTIONS
delete env.DEBUG
delete env.ANTHROPIC_API_KEY // subscription path; set it to bill an API key instead

console.log('CLI :', CLI)
console.log('argv:', args.join(' '))
console.log('cfg :', CONFIG_DIR, LIVE ? '(default account — LIVE)' : '(empty — no auth)')

const child = spawn(CLI, args, { cwd: CWD, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
const frames = []
const framesPath = path.join(OUT, LIVE ? 'frames.live.jsonl' : 'frames.noauth.jsonl')
fs.writeFileSync(framesPath, '')
let stderr = ''
child.stderr.on('data', (d) => (stderr += d.toString()))

const write = (o) => {
  const line = JSON.stringify(o) + '\n'
  console.log('>>>', line.slice(0, 200).trimEnd())
  child.stdin.write(line)
}

// 1) initialize control_request — exactly the SDK's payload for engine.ts's options
write({
  type: 'control_request',
  request_id: 'init-1',
  request: {
    subtype: 'initialize',
    hooks: undefined,
    sdkMcpServers: undefined,
    jsonSchema: undefined,
    systemPrompt: undefined, // preset claude_code ⇒ field absent
    appendSystemPrompt: undefined,
    forwardSubagentText: true,
    supportedDialogKinds: ['refusal_fallback_prompt']
  }
})
// 2) the user turn
write({
  type: 'user',
  session_id: '',
  parent_tool_use_id: null,
  message: {
    role: 'user',
    content: [{ type: 'text', text: LIVE ? 'Reply with exactly: OK' : 'hi' }]
  }
})

const rl = readline.createInterface({ input: child.stdout })
let sawResult = false
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    console.log('!!! non-JSON stdout:', line.slice(0, 300))
    return
  }
  frames.push(msg)
  fs.appendFileSync(framesPath, line + '\n')
  const tag = `${msg.type}${msg.subtype ? '/' + msg.subtype : ''}`
  let extra = ''
  if (msg.type === 'stream_event') extra = msg.event?.type + (msg.event?.delta?.type ? ':' + msg.event.delta.type : '')
  if (msg.type === 'assistant') extra = (msg.message?.content ?? []).map((b) => b.type).join(',')
  if (msg.type === 'control_response') extra = msg.response?.subtype + ' ' + msg.response?.request_id
  if (tag === 'system/init') extra = `session=${msg.session_id} model=${msg.model} apiKeySource=${msg.apiKeySource} caps=${(msg.capabilities ?? []).join('|')}`
  if (msg.type === 'result') extra = `is_error=${msg.is_error} cost=${msg.total_cost_usd} turns=${msg.num_turns} result=${JSON.stringify(msg.result ?? msg.errors)?.slice(0, 160)}`
  console.log('<<<', tag, extra)
  if (msg.type === 'result') {
    sawResult = true
    setTimeout(() => child.stdin.end(), 200) // endInput ⇒ CLI tears down
  }
})

child.on('exit', (code, sig) => {
  console.log('--- exit', code, sig, 'frames:', frames.length, 'sawResult:', sawResult)
  if (stderr.trim()) console.log('--- stderr:', stderr.trim().slice(0, 1500))
  const kinds = new Map()
  for (const f of frames) {
    const k = `${f.type}${f.subtype ? '/' + f.subtype : ''}${f.type === 'stream_event' ? ':' + f.event?.type : ''}`
    kinds.set(k, (kinds.get(k) ?? 0) + 1)
  }
  console.log('--- frame kinds:', JSON.stringify([...kinds.entries()], null, 1))
  console.log('--- saved:', framesPath)
})

setTimeout(() => {
  console.log('!!! timeout — killing')
  child.kill()
}, 120000).unref()
