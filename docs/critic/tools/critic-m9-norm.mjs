#!/usr/bin/env node
/* ============================================================================
 * critic-m9-norm — `mcp_norm`(서버 이름 → 도구 접두사) **실측** (크리틱 전용).
 *
 * 왜: `wire.rs`의 `mcp_norm`은 "비 [A-Za-z0-9_-] → `_`"라는 규칙을 `sdk.d.ts` 주석에서
 * 가져와 단위 테스트로 못 박았다. 그런데 빌더가 실 CLI로 잰 서버 이름은 `ccg-probe-a`·
 * `ccg-probe-b` — **정규화할 문자가 하나도 없는 이름**이다. 즉 규칙 자체는 실측이 아니다.
 * 여기서 점·공백·`__`·한글·이모지 이름을 실 CLI에 물려 접두사를 직접 읽는다.
 *
 * 무인증(토큰 0) · %TEMP%에만 쓴다 · 실홈은 엔진 경로만 읽는다.
 * ========================================================================== */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const ENGINE = process.env.CCG_ENGINE ?? JSON.parse(fs.readFileSync(path.join(os.homedir(), '.agentcodegui', 'config.json'), 'utf8')).activeVersion
const HOME = path.join(os.homedir(), '.agentcodegui')
const CLI = path.join(HOME, 'engines', ENGINE, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe')
const OUT = path.join(os.tmpdir(), 'ccg-m9norm')
const OUTFILE = (process.argv.find((a) => a.startsWith('--out=')) ?? '').split('=')[1] || path.join(OUT, 'result.json')

// 빌더 하네스와 **같은** stdio 스텁(있으면 재사용, 없으면 최소본을 쓴다)
const STUBSRC = path.join(os.tmpdir(), 'ccg-mcpskill', 'mcp-stub.mjs')
const stub = path.join(OUT, 'mcp-stub.mjs')
fs.mkdirSync(OUT, { recursive: true })
fs.copyFileSync(STUBSRC, stub)

// 이름 후보 — 각각 무엇을 묻는가
const NAMES = {
  'my.co tools': '점 + 공백 (wire.rs 단위 테스트가 가정한 바로 그 이름)',
  'srv__dbl': '이름에 `__` — 접두사를 뒤에서 가르는 규칙의 근거',
  '한글서버': 'BMP 비ASCII (Rust chars == JS UTF-16 단위)',
  'emoji🚀srv': '비BMP — Rust `chars()` 1자 vs JS 정규식 2단위',
  'UPPER-Case': '대문자 보존 여부'
}
const dir = path.join(OUT, 'w')
fs.rmSync(dir, { recursive: true, force: true })
fs.mkdirSync(path.join(dir, '.claude'), { recursive: true })
const mcpServers = {}
for (const n of Object.keys(NAMES)) mcpServers[n] = { command: process.execPath, args: [stub, n] }
fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers }, null, 2))
fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }))

const res = await new Promise((resolve) => {
  const out = { engine: ENGINE, cwd: dir, init: null, stderr: '' }
  const child = spawn(CLI, [
    '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
    '--thinking', 'disabled', '--model', 'haiku', '--permission-prompt-tool', 'stdio',
    '--setting-sources=user,project,local', '--permission-mode', 'default', '--include-partial-messages',
    '--settings', JSON.stringify({ permissions: { defaultMode: 'default' }, enableAllProjectMcpServers: true })
  ], {
    cwd: dir,
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: ENGINE,
           CLAUDE_CONFIG_DIR: path.join(OUT, 'noauth'), NODE_OPTIONS: undefined, ANTHROPIC_API_KEY: undefined },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  })
  child.stderr.on('data', (d) => (out.stderr += d.toString()))
  child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'init-1', request: { subtype: 'initialize' } }) + '\n')
  // 빌더 하네스와 같은 자극 — 턴이 시작돼야 MCP가 붙는 판을 배제하지 않는다
  child.stdin.write(JSON.stringify({ type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] } }) + '\n')
  const fin = () => { try { child.stdin.end() } catch { /* closed */ } setTimeout(() => { try { child.kill() } catch { /* dead */ } }, 300); resolve(out) }
  readline.createInterface({ input: child.stdout }).on('line', (l) => {
    let m
    try { m = JSON.parse(l) } catch { return }
    if (m.type === 'system' && m.subtype === 'init') { out.init = m; fin() }
  })
  child.on('exit', () => resolve(out))
  setTimeout(fin, 60_000)
})

/** wire.rs의 `mcp_norm`을 그대로 옮긴 것 — Rust는 **유니코드 스칼라** 단위로 돈다. */
const mcpNormRust = (name) => [...name].map((c) => (/[A-Za-z0-9_-]/.test(c) ? c : '_')).join('')
const prefixes = (res.init?.tools ?? []).filter((t) => t.startsWith('mcp__'))
const rows = Object.keys(NAMES).map((name) => {
  const expect = mcpNormRust(name)
  const mine = prefixes.filter((t) => t.startsWith(`mcp__${expect}__`))
  return {
    name, why: NAMES[name], status: (res.init?.mcp_servers ?? []).find((s) => s.name === name)?.status ?? null,
    expectPrefix: `mcp__${expect}__`, matched: mine, ok: mine.length > 0
  }
})
const report = { engine: ENGINE, gotInit: !!res.init, stderr: res.stderr.slice(0, 300), mcpServers: res.init?.mcp_servers ?? [], prefixes, rows,
                 unmatched: prefixes.filter((t) => !rows.some((r) => r.matched.includes(t))) }
fs.mkdirSync(path.dirname(OUTFILE), { recursive: true })
fs.writeFileSync(OUTFILE, JSON.stringify(report, null, 1))
console.log(JSON.stringify(report, null, 1))
console.log('\n산출:', OUTFILE)
