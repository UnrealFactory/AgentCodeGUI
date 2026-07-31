/**
 * PoC — 스트리밍 입력 모드에서 cancel() 경로(interrupt → closeInput → abort) 실측.
 * 멀티 패널 "취소해도 채팅이 계속됨" 재현용: 긴 턴(sleep 40) 중간에 엔진 cancel()과
 * 동일한 순서를 밟고, 이후 프레임이 계속 오는지 / 루프가 언제 끝나는지 본다.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

delete process.env.ANTHROPIC_API_KEY
delete process.env.CLAUDECODE
delete process.env.CLAUDE_CODE_ENTRYPOINT

const APP_HOME = path.join(os.homedir(), '.agentcodegui')
const active = JSON.parse(fs.readFileSync(path.join(APP_HOME, 'config.json'), 'utf8')).activeVersion
const { query } = await import(pathToFileURL(path.join(APP_HOME, 'engines', active, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs')).href)

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-cancel-poc-'))
const t0 = Date.now()
const sec = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5)
const note = (s) => console.log(`[${sec()}s] ${s}`)

const inbox = []
let wake = null
let closed = false
async function* stream() {
  while (true) {
    if (inbox.length) {
      yield inbox.shift()
      continue
    }
    if (closed) return
    await new Promise((r) => (wake = r))
  }
}
const closeInput = () => {
  if (closed) return
  closed = true
  note('== closeInput')
  wake?.()
}
inbox.push({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'Bash로 `sleep 40`을 포그라운드로 실행해줘. 백그라운드로 돌리지 말 것.' }] },
  parent_tool_use_id: null,
  session_id: ''
})

const abort = new AbortController()
const q = query({
  prompt: stream(),
  options: {
    cwd: workDir,
    model: 'sonnet',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: [],
    includePartialMessages: false,
    abortController: abort,
    stderr: () => {}
  }
})

// t=10s: 엔진 cancel()과 동일 순서 — interrupt(1.5s 레이스) → closeInput → abort
setTimeout(async () => {
  note('>> CANCEL 시작 — interrupt()')
  try {
    await Promise.race([q.interrupt().catch((e) => note('interrupt reject: ' + e.message)), new Promise((r) => setTimeout(r, 1500))])
  } catch (e) {
    note('interrupt throw: ' + e.message)
  }
  note('>> interrupt 단계 종료 — closeInput + abort')
  closeInput()
  abort.abort()
}, 10_000)

// 하드 워치독 — 60s에 강제 종료
const watchdog = setTimeout(() => {
  note('!! watchdog 60s — 강제 종료')
  process.exit(2)
}, 60_000)

let afterAbort = 0
try {
  for await (const msg of q) {
    const tag = `${msg.type}${msg.subtype ? '/' + msg.subtype : ''}`
    if (abort.signal.aborted) afterAbort++
    note(`<< ${tag}${msg.type === 'result' ? ` is_error=${msg.is_error}` : ''}${abort.signal.aborted ? '  (abort 이후!)' : ''}`)
  }
  note('== 루프 정상 종료')
} catch (e) {
  note('== 루프 예외 종료: ' + String(e?.message ?? e).slice(0, 120))
} finally {
  clearTimeout(watchdog)
  note(`판정: abort 이후 프레임 ${afterAbort}개, 총 경과 ${sec()}s`)
}
