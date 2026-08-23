// PoC — M9 「멀티채팅 기준으로 MCP·Skill을 전용으로 보는 방법」의 **와이어 실측 하네스**.
//
// 묻는 것은 다섯이다. 지어내지 않고 실 CLI에 물어본다.
//   ① `system/init`의 `mcp_servers`에 **무엇이** 실려 오는가 (연결 성공/실패 각각)
//   ② `skills`·`slash_commands`가 **cwd마다 다른가** (프로젝트 `.claude/skills`)
//   ③ 턴 밖에서 상태를 **다시 물을 수 있는가** (`mcp_status` / `reload_skills` 컨트롤 왕복)
//   ④ 스킬 **설명**은 어디서 오는가 — `initialize` 컨트롤 응답의 `commands[]`,
//      그리고 세션 중간의 `system/commands_changed` 푸시(둘 다 REPLACE)
//   ⑤ ★셸이 끈 것(`deniedMcpServers`·`skillOverrides`)은 와이어에 **어떤 얼굴로** 오는가
//      — `status:"disabled"` 행인가, 아니면 행째 소멸인가 (C 픽스처)
//
// 픽스처 두 벌(A·B)을 %TEMP%에 만들고 **각각 다른 cwd**로 CLI를 띄운다 — 멀티 2패널이
// 서로 다른 목록을 보여야 한다는 요구의 원본 실측이다. MCP 서버는 이 스크립트가 같이
// 낳는 stdio 스텁(JSON-RPC 2.0 줄단위)이라 네트워크도 외부 설치도 없다. C는 B와 **같은
// 폴더**를 끈 정책으로 한 번 더 띄운 것이라, B와의 차이가 곧 "끄면 무슨 일이 나는가"다.
//
//   node scripts/poc-mcpskill.mjs           # 무인증 — init 프레임만 (공짜, 토큰 0)
//   node scripts/poc-mcpskill.mjs --live    # 기본 계정으로 A·B·C 각 1턴 (실과금 최소)
//   node scripts/poc-mcpskill.mjs --app     # ★실물 — 앱을 띄워 멀티 2패널(A·B) 각 1턴,
//                                           #  헤더 칩·팝오버 DOM을 CDP로 읽는다
//
// `--app`이 이 하네스의 종점이다. 위 셋은 "와이어가 무엇을 말하는가"까지고, `--app`은
// **그 값이 화면에 서로 다르게 그려지는가**를 묻는다 — 멀티 2패널이 서로 다른 폴더를
// 보고 있을 때 목록이 갈리지 않으면 이 기능은 없는 것과 같다.
//
// 실홈은 **읽기만** 한다: 엔진 경로와 계정 폴더 경로만 읽고, 쓰기는 전부 %TEMP%(와이어
// 모드)나 격리 `CCG_HOME`(앱 모드) 안이다. 사용자 실앱은 **이름으로 죽이지 않는다** —
// 죽이는 것은 이 스크립트가 spawn한 PID 트리뿐이다.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

const LIVE = process.argv.includes('--live')
const APP = process.argv.includes('--app')
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
const OUT = path.join(os.tmpdir(), 'ccg-mcpskill')

// ── 픽스처 ────────────────────────────────────────────────────────────────────
// stdio MCP 서버 스텁. MCP는 "줄 하나 = JSON-RPC 2.0 메시지 하나"라 20줄이면 된다.
// protocolVersion은 **클라이언트가 요청한 값을 되돌려준다** — 버전을 우리가 고르면
// CLI가 올릴 때마다 스텁이 먼저 깨진다(이 하네스가 거짓 음성을 내는 가장 쉬운 길).
const STUB = `#!/usr/bin/env node
// ccg PoC stdio MCP 서버 — 도구 1개짜리 최소 구현. argv[2] = 서버 표시 이름.
const NAME = process.argv[2] || 'ccg-probe'
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
let buf = ''
process.stdin.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (m.method === 'initialize')
      send({ jsonrpc: '2.0', id: m.id, result: {
        protocolVersion: m.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: '9.9.9' }
      } })
    else if (m.method === 'tools/list')
      send({ jsonrpc: '2.0', id: m.id, result: { tools: [
        { name: 'echo', description: NAME + ' echoes its argument back',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        { name: 'ping', description: NAME + ' answers pong',
          inputSchema: { type: 'object', properties: {} } }
      ] } })
    else if (m.method === 'tools/call')
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: NAME + ':' + JSON.stringify(m.params?.arguments ?? {}) }] } })
    else if (m.id != null)
      send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no ' + m.method } })
  }
})
`

const SKILL = (name, desc) => `---
name: ${name}
description: ${desc}
---

# ${name}

PoC 스킬. 이 파일이 존재한다는 사실만으로 init 프레임의 \`skills\`에 이름이 실려야 한다.
`

/** 픽스처 한 벌 — cwd + .mcp.json(서버 n개) + .claude/skills(스킬 n개). */
function fixture(tag, servers, skills) {
  const dir = path.join(OUT, tag)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(OUT, 'mcp-stub.mjs'), STUB)
  const mcpServers = {}
  for (const s of servers) mcpServers[s.name] = s.cfg
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers }, null, 2))
  // `.mcp.json`은 기본이 **미승인**이다(터미널이 "이 서버 쓸까요?"를 묻는 자리).
  // 프로젝트 설정으로 자동 승인해 둔다 — 실홈을 안 건드리고 승인 상태를 만드는 유일한 길.
  fs.writeFileSync(
    path.join(dir, '.claude', 'settings.local.json'),
    JSON.stringify({ enableAllProjectMcpServers: true }, null, 2)
  )
  for (const s of skills) {
    fs.mkdirSync(path.join(dir, '.claude', 'skills', s.name), { recursive: true })
    fs.writeFileSync(path.join(dir, '.claude', 'skills', s.name, 'SKILL.md'), SKILL(s.name, s.desc))
  }
  return dir
}

const node = process.execPath
const stub = path.join(OUT, 'mcp-stub.mjs')
fs.mkdirSync(OUT, { recursive: true })

const FIX = {
  A: () =>
    fixture(
      'A',
      [{ name: 'ccg-probe-a', cfg: { command: node, args: [stub, 'ccg-probe-a'] } }],
      [{ name: 'alpha-probe', desc: 'A 픽스처 전용 스킬 — B에는 없다' }]
    ),
  // B는 **고장난 서버를 하나 더** 둔다. `status:"failed"`가 실제로 실려 오는지가
  // "연결 실패도 화면에 뜬다"의 유일한 근거다(없으면 그 UI는 지어낸 것이 된다).
  B: () =>
    fixture(
      'B',
      [
        { name: 'ccg-probe-b', cfg: { command: node, args: [stub, 'ccg-probe-b'] } },
        { name: 'ccg-broken-b', cfg: { command: node, args: [path.join(OUT, 'does-not-exist.mjs')] } }
      ],
      [
        { name: 'beta-probe', desc: 'B 픽스처 전용 스킬 — A에는 없다' },
        { name: 'beta-second', desc: 'B에만 있는 두 번째 스킬' }
      ]
    )
}

// ── 계정 폴더(읽기 전용) ──────────────────────────────────────────────────────
function configDir() {
  if (!LIVE) {
    const d = path.join(OUT, 'noauth-config')
    // 개인(user) 스코프 스킬 씨앗. **무인증 폴더에만** 심는다 — 실 계정 폴더는 읽기 전용
    // 규약이라 `--live`에서는 이 씨앗이 없고, `(user)` 단언도 그때는 건너뛴다.
    //
    // 이 씨앗이 필요한 이유: 설명 꼬리의 스코프 표식이 `(project)` 한 종류라면 셸의
    // `split_scope`가 닫힌 집합을 가질 근거가 없다. **개인 스킬도 같은 문법으로 오는가**를
    // 여기서 확인한다(하네스가 남긴 찌꺼기에 기대면 새 기계에서 그 근거가 사라진다).
    const seed = path.join(d, 'skills', 'gamma-personal')
    fs.mkdirSync(seed, { recursive: true })
    fs.writeFileSync(path.join(seed, 'SKILL.md'), SKILL('gamma-personal', '개인 스코프 스킬 — 스코프 접미사 확인용'))
    return d
  }
  const accounts = JSON.parse(fs.readFileSync(path.join(HOME, 'accounts.json'), 'utf8'))
  const slug = String(accounts.defaultEmail).replace(/@/g, '_').replace(/\+/g, '-')
  const dir = fs.readdirSync(path.join(HOME, 'accounts')).find((d) => d.startsWith(slug))
  if (!dir) throw new Error('기본 계정 폴더를 못 찾음 — --live 불가')
  return path.join(HOME, 'accounts', dir)
}
// 앱 모드는 CLI를 직접 안 띄운다(앱이 띄운다) — 설정 폴더도 격리 홈이 만든다.
const CONFIG_DIR = APP ? '' : configDir()

// ── 한 판 돌리기 ──────────────────────────────────────────────────────────────
/**
 * @param tag       산출물 이름표
 * @param cwd       CLI의 작업 폴더
 * @param policy    `--settings`에 얹을 정책 조각. 셸(`driver.rs`)이 P1e `tools` 축을
 *                  물질화하는 모양 그대로 준다 — `deniedMcpServers:[{serverName}]` ·
 *                  `skillOverrides:{이름:'off'}`.
 */
function run(tag, cwd, policy = {}) {
  return new Promise((resolve) => {
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
      // 앱이 실제로 싣는 자리 그대로. `.mcp.json` 자동 승인만 얹었다.
      '--settings',
      JSON.stringify({ permissions: { defaultMode: 'default' }, enableAllProjectMcpServers: true, ...policy })
    ]
    const env = { ...process.env }
    env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts'
    env.CLAUDE_AGENT_SDK_VERSION = ENGINE
    env.CLAUDE_CONFIG_DIR = CONFIG_DIR
    delete env.NODE_OPTIONS
    delete env.DEBUG
    delete env.ANTHROPIC_API_KEY

    const child = spawn(CLI, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const framesPath = path.join(OUT, `frames.${tag}.${LIVE ? 'live' : 'noauth'}.jsonl`)
    fs.writeFileSync(framesPath, '')
    // `initCmds`·`pushCmds`가 셸(`wire.rs`)이 실제로 먹는 두 입이다 — 스킬 **설명**의
    // 유일한 원전이라, 여기서 모양이 흔들리면 팝오버가 이름만 나열하게 된다.
    const res = {
      tag, cwd, framesPath, policy,
      init: null, initCmds: null, pushCmds: null, initFirst: null,
      mcpStatus: null, reloadSkills: null, stderr: '', frames: 0
    }
    child.stderr.on('data', (d) => (res.stderr += d.toString()))
    const write = (o) => child.stdin.write(JSON.stringify(o) + '\n')

    write({
      type: 'control_request',
      request_id: 'init-1',
      request: { subtype: 'initialize', forwardSubagentText: true, supportedDialogKinds: ['refusal_fallback_prompt'] }
    })
    write({
      type: 'user',
      session_id: '',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }
    })

    let asked = false
    const done = () => {
      try { child.stdin.end() } catch { /* 이미 닫혔다 */ }
      setTimeout(() => { try { child.kill() } catch { /* 이미 죽었다 */ } }, 400)
      resolve(res)
    }
    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      if (!line.trim()) return
      let m
      try { m = JSON.parse(line) } catch { return }
      res.frames++
      fs.appendFileSync(framesPath, line + '\n')
      // 세션 중간 REPLACE 푸시 — 셸이 사전을 갈아끼우는 두 번째 입.
      if (m.type === 'system' && m.subtype === 'commands_changed') res.pushCmds = m.commands ?? null
      if (m.type === 'system' && m.subtype === 'init' && !res.init) {
        res.init = m
        if (!asked) {
          asked = true
          // 턴 밖 재조회 — 화면이 "지금 상태"를 다시 물을 수 있는지.
          write({ type: 'control_request', request_id: 'mcp-1', request: { subtype: 'mcp_status' } })
          write({ type: 'control_request', request_id: 'sk-1', request: { subtype: 'reload_skills' } })
        }
      }
      if (m.type === 'control_response') {
        const id = m.response?.request_id
        if (id === 'init-1') {
          res.initCmds = m.response?.response?.commands ?? null
          // 셸은 `initialize` 응답을 `system/init`보다 **먼저** 본다고 가정하고
          // 사전을 먼저 채운다 — 그 순서가 실제로 그런지 여기서 못 박는다.
          res.initFirst = res.init === null
        }
        if (id === 'mcp-1') res.mcpStatus = m.response
        if (id === 'sk-1') res.reloadSkills = m.response
      }
      // result 이후에도 컨트롤 응답을 기다린다 — 셋 다 오거나 타임아웃까지.
      // `pushCmds`(commands_changed)는 **result 뒤에** 오므로 기다리는 조건에 넣는다.
      if (res.init && res.mcpStatus && res.reloadSkills && res.pushCmds) done()
    })
    child.on('exit', () => resolve(res))
    setTimeout(done, LIVE ? 90_000 : 45_000)
  })
}

// ── 보고 ──────────────────────────────────────────────────────────────────────
const short = (v, n = 10) => (Array.isArray(v) && v.length > n ? v.slice(0, n).concat([`…+${v.length - n}`]) : v)
const fails = []
const ok = (cond, msg) => {
  console.log((cond ? '  OK   ' : '  FAIL ') + msg)
  if (!cond) fails.push(msg)
}

// ══ `--app` — 실물 앱 · 멀티 2패널 · 헤더 칩과 팝오버 DOM ═══════════════════════
//
// 여기서만 답할 수 있는 질문: **두 패널이 서로 다른 목록을 그리는가.** 와이어가
// cwd마다 다른 값을 준다는 것은 위에서 봤고, 이건 그 값이 각자 자기 패널에만 닿는지다
// (`ma:event`의 panelId 봉투가 새면 두 패널이 같은 목록을 그린다 — 눈으로만 봐서는
// "둘 다 잘 나온다"로 보이는 종류의 결함이다).
if (APP) {
  const { connectMainPage, killTree, sleep, REPO } = await import('../bench/lib.mjs')
  const EXE = path.join(REPO, 'target', 'release', 'agentcodegui.exe')
  const CCG_HOME = path.join(REPO, '.poc-home-mcpskill')
  const PORT = 9391
  const dirA = FIX.A()
  const dirB = FIX.B()

  // 격리 홈 삭제는 **재시도한다** — 방금 죽은 WebView2가 핸들을 한 박자 늦게 놓는다.
  const rmrf = (p) => {
    for (let i = 0; i < 12; i++) {
      try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
        return
      } catch (e) {
        if (i === 11) throw e
        spawnSync('cmd', ['/c', 'ping', '127.0.0.1', '-n', '2'], { stdio: 'ignore' })
      }
    }
  }
  const put = (p, v) => {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v))
  }

  // ── 격리 홈 씨앗 ────────────────────────────────────────────────────────────
  // 엔진은 **정션**(복사 337MB 회피), 계정은 자격증명만 **복사**(CLI의 토큰 갱신이
  // 실홈에 안 닿게). 실홈에 쓰는 경로가 하나도 없다.
  rmrf(CCG_HOME)
  const ver = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')).activeVersion
  put(path.join(CCG_HOME, 'config.json'), { activeVersion: ver })
  spawnSync('cmd', ['/c', 'mklink', '/J', path.join(CCG_HOME, 'engines'), path.join(HOME, 'engines')], {
    stdio: 'ignore'
  })
  const accounts = JSON.parse(fs.readFileSync(path.join(HOME, 'accounts.json'), 'utf8'))
  const slug = String(accounts.defaultEmail).replace(/@/g, '_').replace(/\+/g, '-')
  const acct = fs.readdirSync(path.join(HOME, 'accounts')).find((d) => d === slug || d.startsWith(slug + '-'))
  if (!acct) throw new Error('기본 계정 폴더를 못 찾음 — --app 불가')
  for (const f of ['.credentials.json', '.claude.json']) {
    const s = path.join(HOME, 'accounts', acct, f)
    if (fs.existsSync(s)) put(path.join(CCG_HOME, 'accounts', acct, f), fs.readFileSync(s, 'utf8'))
  }
  put(path.join(CCG_HOME, 'accounts.json'), accounts)
  // 멀티 화면으로 부팅 + 한국어(칩 문구 단언이 한국어 기준)
  put(path.join(CCG_HOME, 'ui-prefs.json'), { 'ui.lang': 'ko', 'workspace.mode': 'multi' })
  put(path.join(CCG_HOME, 'profile.json'), { nickname: 'poc' })

  // 프레임 덤프를 켠다 — 「스냅샷이 턴마다 오는가 스폰마다 오는가」는 화면이 아니라
  // 와이어에서만 셀 수 있다(`system/init`의 개수 = 스폰 수).
  const FRAMES = path.join(CCG_HOME, 'frames.jsonl')
  const child = spawn(EXE, [], {
    env: {
      ...process.env,
      CCG_HOME,
      CCG_ENGINE_LOG: FRAMES,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let applog = ''
  child.stdout.on('data', (d) => (applog += d.toString()))
  child.stderr.on('data', (d) => (applog += d.toString()))
  const cdp = await connectMainPage(PORT, { timeoutMs: 60_000 })
  const j = async (expr) => JSON.parse(await cdp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
  const until = async (expr, ms = 60_000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (await j(`await (async () => !!(${expr}))()`).catch(() => false)) return true
      await sleep(150)
    }
    return false
  }

  const out = { home: CCG_HOME, engine: ver, account: accounts.defaultEmail, dirA, dirB }
  try {
    if (!(await until('typeof window.api === "object" && !!(await window.api.app.getVersion())')))
      throw new Error('앱 IPC가 안 올라옴')

    // ── 보드 씨앗 — 앱 자신의 IPC로 심는다(디스크 포맷을 하네스가 알 필요 없다) ──
    const board = {
      version: 2,
      activeSessionId: 'm9-two',
      sessions: [
        {
          id: 'm9-two',
          title: 'M9 두 폴더',
          custom: true,
          count: 2,
          panels: [
            { title: 'A', custom: true, cwd: dirA, picker: { model: 'haiku', effort: 'minimal', mode: 'normal' } },
            { title: 'B', custom: true, cwd: dirB, picker: { model: 'haiku', effort: 'minimal', mode: 'normal' } }
          ],
          updatedAt: Date.now()
        }
      ]
    }
    await j(`(await window.api.multi.saveState(${JSON.stringify(board)}), 'saved')`)
    await cdp.send('Page.reload', {})
    await sleep(1200)
    if (!(await until('typeof window.api === "object" && !!(await window.api.app.getVersion())')))
      throw new Error('reload 뒤 앱 IPC가 안 올라옴')
    if (!(await until('document.querySelectorAll(".ma-panel").length >= 2')))
      throw new Error('멀티 2패널이 안 떴다')
    out.panelCwds = await j(
      `[...document.querySelectorAll('.ma-panel')].map((p) => p.querySelector('.ma-p-folder-name')?.textContent ?? null)`
    )

    // 패널 0의 `tooling` 이벤트를 통째로 받아 둔다 — **화면 단언과 독립인 두 번째 증거**
    // 이자, "몇 번 나가는가"의 유일한 계측점이다(2턴째에 또 나가는지 = 상주 CLI에서
    // init이 턴마다 오는지).
    await j(`(window.__tl = [], window.api.multi.onEvent('m9-two::0', (e) => { if (e.type === 'tooling') window.__tl.push(e) }), 'armed')`)

    // ── 각 패널 1턴 ─────────────────────────────────────────────────────────
    // 도구 환경 스냅샷은 `system/init`에 실려 오고, init은 **스폰**에서 온다 —
    // 즉 패널이 한 번은 말을 걸어야 한다. 가장 싼 한 턴(haiku · 도구 없음).
    for (const slot of [0, 1]) {
      const r = await j(`(() => {
        const p = document.querySelector('.ma-panel[data-slot="${slot}"]')
        const ta = p && p.querySelector('textarea')
        if (!ta) return 'no-textarea'
        const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        set.call(ta, 'Reply with exactly: OK')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
        ta.focus()
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        return 'sent'
      })()`)
      if (r !== 'sent') throw new Error(`패널 ${slot} 컴포저를 못 찾음: ${r}`)
      await sleep(400)
    }

    // ── 칩이 뜰 때까지 ──────────────────────────────────────────────────────
    const CHIP = `[...document.querySelectorAll('.ma-panel')].map((p) =>
      [...p.querySelectorAll('.ma-p-head button.ma-p-folder')].find((b) => /MCP/.test(b.getAttribute('aria-label') || '')) ?? null)`
    const chipUp = await until(`(${CHIP}).filter(Boolean).length >= 2`, 180_000)
    out.chips = await j(`(${CHIP}).map((b) => b && ({ text: b.innerText.replace(/\\s+/g, ' ').trim(), tip: b.getAttribute('aria-label') }))`)
    ok(chipUp, `두 패널 모두에 도구 환경 칩이 떴다 — 실제: ${JSON.stringify(out.chips)}`)

    // ── 팝오버를 열어 목록을 읽는다 ─────────────────────────────────────────
    out.pops = []
    for (const slot of [0, 1]) {
      await j(`(() => {
        const p = document.querySelector('.ma-panel[data-slot="${slot}"]')
        const b = [...p.querySelectorAll('.ma-p-head button.ma-p-folder')].find((x) => /MCP/.test(x.getAttribute('aria-label') || ''))
        b.click()
        return 'clicked'
      })()`)
      await sleep(250)
      out.pops.push(
        await j(`(() => {
          const p = document.querySelector('.ma-panel[data-slot="${slot}"]')
          const b = [...p.querySelectorAll('.ma-p-head button.ma-p-folder')].find((x) => /MCP/.test(x.getAttribute('aria-label') || ''))
          const pop = b.closest('.hfold').querySelector('.wb-pop')
          if (!pop) return null
          // 섹션 걷기 — wb-psep 뒤는 출처 각주라 섹션에 안 넣는다(안 그러면 마지막
          // 섹션의 행이 각주로 덮인다: 이 하네스가 실제로 밟은 함정이다).
          // (이 주석에 역따옴표를 쓰면 바깥 템플릿 문자열이 끊긴다 — 두 번째 함정.)
          const secs = []
          let cur = null
          let foot = null
          for (const el of pop.children) {
            if (el.classList.contains('wb-psep')) { cur = null; foot = ''; continue }
            if (foot !== null) { foot += el.innerText.trim(); continue }
            if (el.classList.contains('hsec')) { cur = { head: el.innerText.trim(), rows: [] }; secs.push(cur) }
            else if (el.classList.contains('wb-pop-list') && cur) cur.rows = [...el.children].map((r) => r.innerText.replace(/\\n/g, ' · ').trim())
            else if (el.classList.contains('ag-none') && cur) cur.rows = ['(비어 있음) ' + el.innerText.trim()]
          }
          return { head: pop.querySelector('.wb-pop-h')?.innerText.replace(/\\n/g, ' · ').trim() ?? null, secs, foot }
        })()`)
      )
      // 바깥 클릭으로 닫는다(카드 규약 — 네이티브 다이얼로그 없음)
      await j(`(document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), 'closed')`)
      await sleep(150)
    }

    const flat = (i) => JSON.stringify(out.pops[i] ?? null)
    const p0 = flat(0)
    const p1 = flat(1)
    ok(/ccg-probe-a/.test(p0), `패널1 팝오버에 ccg-probe-a — 실제: ${p0.slice(0, 400)}`)
    ok(/alpha-probe/.test(p0), `패널1 팝오버에 /alpha-probe`)
    ok(!/ccg-probe-b|beta-probe/.test(p0), '패널1에 B의 서버·스킬이 **없다**')
    ok(/ccg-probe-b/.test(p1), `패널2 팝오버에 ccg-probe-b — 실제: ${p1.slice(0, 400)}`)
    ok(/beta-probe/.test(p1) && /beta-second/.test(p1), '패널2 팝오버에 /beta-probe · /beta-second')
    ok(/ccg-broken-b/.test(p1) && /연결 실패/.test(p1), '패널2에 죽은 서버가 「연결 실패」로 남는다')
    ok(!/ccg-probe-a|alpha-probe/.test(p1), '패널2에 A의 서버·스킬이 **없다**')
    ok(p0 !== p1, '두 패널의 목록이 서로 다르다 (panelId 봉투가 안 샌다)')
    // 서버가 붙인 도구가 행에 실렸는가 (`init.tools` 접두사 갈라내기의 화면 증거)
    ok(/echo/.test(p1) && /ping/.test(p1), `패널2 MCP 행에 도구 이름(echo·ping) — 실제: ${p1.slice(0, 500)}`)
    // ★설명 한 줄 자르기 — 내장 스킬 설명은 941자짜리가 있다(dataviz). 안 자르면 그
    // 한 행이 팝오버(340px) 전체를 먹어 목록이 문단 더미가 된다.
    const skillRows = (out.pops[1]?.secs ?? []).find((s) => /스킬/.test(s.head))?.rows ?? []
    const longest = skillRows.reduce((a, r) => Math.max(a, r.length), 0)
    out.longestSkillRow = longest
    ok(
      skillRows.length >= 10 && longest <= 200,
      `스킬 행 ${skillRows.length}개가 전부 한 줄로 잘렸다(최장 ${longest}자 ≤ 200)`
    )

    // ── 2턴째 — 상주 CLI에서 스냅샷이 몇 번 나가는가 ─────────────────────────
    // 「턴마다 온다」와 「스폰마다 온다」는 다른 말이다: 전자면 화면이 매 턴 REPLACE를
    // 받고, 후자면 첫 턴의 스냅샷이 그 프로세스의 수명 내내 유일한 진실이다(그래서
    // `commands_changed` 푸시가 필요해진다). 지어내지 않고 센다.
    out.toolingAfterTurn1 = await j('window.__tl.length')
    const before = out.toolingAfterTurn1
    await j(`(() => {
      const p = document.querySelector('.ma-panel[data-slot="0"]')
      const ta = p.querySelector('textarea')
      const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      set.call(ta, 'Reply with exactly: TWO')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.focus()
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      return 'sent'
    })()`)
    // 2턴째가 실제로 끝날 때까지 기다린다(안 기다리면 "안 왔다"가 아니라 "아직"이다)
    await until(`document.querySelector('.ma-panel[data-slot="0"]').innerText.includes('TWO')`, 180_000)
    await sleep(1500)
    out.toolingAfterTurn2 = await j('window.__tl.length')
    out.toolingCwds = await j('window.__tl.map((e) => e.tooling.cwd)')
    console.log(`\n  tooling 이벤트 수 — 1턴 뒤 ${before} · 2턴 뒤 ${out.toolingAfterTurn2}`)
    ok(out.toolingAfterTurn1 >= 1, `1턴에 tooling 스냅샷이 최소 1번 나간다 — 실제 ${out.toolingAfterTurn1}`)
    ok(
      out.toolingCwds.every((c) => String(c).toLowerCase() === dirA.toLowerCase()),
      `패널1이 받은 스냅샷의 cwd가 전부 A다 — 실제: ${JSON.stringify([...new Set(out.toolingCwds)])}`
    )
    // 와이어 쪽 계수 — 화면 계수와 **독립**이다. init 수 = 스폰 수.
    if (fs.existsSync(FRAMES)) {
      const fr = fs
        .readFileSync(FRAMES, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l) } catch { return null } })
        .filter(Boolean)
      const inits = fr.filter((m) => m?.type === 'system' && m?.subtype === 'init')
      const pushes = fr.filter((m) => m?.type === 'system' && m?.subtype === 'commands_changed')
      out.wire = { frames: fr.length, inits: inits.length, commandsChanged: pushes.length,
                   initCwds: inits.map((m) => m.cwd) }
      console.log('  와이어 계수:', JSON.stringify(out.wire))
    }
  } catch (e) {
    ok(false, `앱 주행 실패: ${e.message}`)
    out.error = String(e.stack || e)
    out.applog = applog.slice(-2000)
    // 실패는 **왜**까지 남긴다 — 창은 떴는데 렌더러가 다른 화면(업데이트 게이트·폴더
    // 선택)에 앉아 있는 경우가 가장 흔하고, 그건 DOM을 봐야만 갈린다.
    out.diag = await j(`({
      title: document.title, ready: document.readyState,
      api: typeof window.api, apiKeys: Object.keys(window.api ?? {}).slice(0, 40),
      panels: document.querySelectorAll('.ma-panel').length,
      body: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 600)
    })`).catch((x) => ({ evalFailed: String(x) }))
  } finally {
    const dump = path.join(OUT, 'app-dom.json')
    fs.writeFileSync(dump, JSON.stringify(out, null, 1))
    console.log('\n앱 DOM 덤프:', dump)
    console.log(JSON.stringify(out, null, 1).slice(0, 4000))
    try { cdp.close?.() } catch { /* 이미 닫혔다 */ }
    killTree(child.pid)
    await sleep(900)
  }
  console.log(fails.length ? `\n실패 ${fails.length}건` : '\n전부 통과')
  process.exit(fails.length ? 1 : 0)
}

// C는 **B와 같은 폴더**를 셸의 끄기 정책으로 한 번 더 띄운 판이다(`driver.rs`가 P1e
// `tools` 축을 물질화하는 모양 그대로). B와의 차이가 곧 "끄면 와이어에 무슨 일이 나는가"다.
const OFF_POLICY = {
  deniedMcpServers: [{ serverName: 'ccg-probe-b' }],
  skillOverrides: { 'beta-probe': 'off' }
}

const rows = []
for (const tag of ['A', 'B', 'C']) {
  // C는 B가 방금 만든 폴더를 **그대로** 쓴다(다시 만들지 않는다) — 막 죽은 CLI가
  // 아직 그 폴더 핸들을 쥐고 있어 `rmSync`가 EPERM으로 죽는다(실측). 같은 폴더를
  // 다시 여는 것이 이 픽스처의 요점이기도 하다: 차이는 정책 하나뿐이어야 한다.
  const cwd = tag === 'C' ? path.join(OUT, 'B') : FIX[tag]()
  const policy = tag === 'C' ? OFF_POLICY : {}
  console.log(`\n===== ${tag} · ${cwd} =====`)
  if (tag === 'C') console.log('  정책            :', JSON.stringify(policy))
  const r = await run(tag, cwd, policy)
  rows.push(r)
  if (!r.init) {
    ok(false, `${tag}: init 프레임이 아예 없다 (frames=${r.frames}) — stderr: ${r.stderr.slice(0, 300)}`)
    continue
  }
  const mcp = r.init.mcp_servers ?? []
  console.log('  init.mcp_servers  :', JSON.stringify(mcp))
  console.log('  init.skills       :', JSON.stringify(short(r.init.skills ?? [])))
  console.log('  init.slash_commands:', JSON.stringify(short(r.init.slash_commands ?? [], 6)))
  console.log('  init.plugins      :', JSON.stringify(r.init.plugins ?? []))
  console.log('  init.cwd          :', r.init.cwd)
  if (r.mcpStatus) console.log('  mcp_status        :', JSON.stringify(r.mcpStatus.response ?? r.mcpStatus).slice(0, 1400))
  else console.log('  mcp_status        : (응답 없음)')
  if (r.reloadSkills) {
    const sk = r.reloadSkills.response?.skills ?? []
    console.log('  reload_skills     :', sk.length, '개 ·', JSON.stringify(short(sk.map((s) => s.name), 8)))
    const mine = sk.filter((s) => s.name.includes('probe'))
    console.log('  reload_skills(mine):', JSON.stringify(mine))
  } else console.log('  reload_skills     : (응답 없음)')
  console.log('  initialize.commands:', r.initCmds ? `${r.initCmds.length}개` : '(없음)', '· init보다 먼저?', r.initFirst)
  console.log('  commands_changed  :', r.pushCmds ? `${r.pushCmds.length}개` : '(없음)')
  const mine = (r.initCmds ?? []).filter((c) => /probe|gamma/.test(c.name))
  console.log('  initialize(mine)  :', JSON.stringify(mine))
}

console.log('\n===== 단언 =====')
const [A, B, C] = rows
if (A?.init && B?.init) {
  const an = (A.init.mcp_servers ?? []).map((s) => s.name)
  const bn = (B.init.mcp_servers ?? []).map((s) => s.name)
  ok(an.includes('ccg-probe-a'), `A의 init.mcp_servers에 ccg-probe-a — 실제: ${JSON.stringify(an)}`)
  ok(bn.includes('ccg-probe-b'), `B의 init.mcp_servers에 ccg-probe-b — 실제: ${JSON.stringify(bn)}`)
  ok(!an.includes('ccg-probe-b') && !bn.includes('ccg-probe-a'), 'A·B의 MCP 목록이 서로 다르다 (cwd별 .mcp.json)')
  const conn = (A.init.mcp_servers ?? []).find((s) => s.name === 'ccg-probe-a')?.status
  const broke = (B.init.mcp_servers ?? []).find((s) => s.name === 'ccg-broken-b')?.status
  ok(conn === 'connected', `연결 성공 서버의 status='connected' — 실제: ${conn}`)
  ok(broke && broke !== 'connected', `죽은 서버의 status가 connected가 아니다 — 실제: ${broke}`)
  const ask = A.init.skills ?? []
  const bsk = B.init.skills ?? []
  ok(ask.includes('alpha-probe'), `A의 init.skills에 alpha-probe — 실제: ${JSON.stringify(short(ask))}`)
  ok(bsk.includes('beta-probe') && bsk.includes('beta-second'), `B의 init.skills에 beta-probe·beta-second — 실제: ${JSON.stringify(short(bsk))}`)
  ok(!ask.includes('beta-probe') && !bsk.includes('alpha-probe'), 'A·B의 스킬 목록이 서로 다르다 (cwd별 .claude/skills)')
  const ms = A.mcpStatus?.response?.mcpServers
  ok(Array.isArray(ms), `mcp_status 응답의 response.mcpServers가 배열 — 실제: ${typeof ms}`)
  if (Array.isArray(ms)) {
    const row = ms.find((s) => s.name === 'ccg-probe-a')
    ok(!!row, 'mcp_status에도 ccg-probe-a가 있다')
    ok(!!row?.tools?.length, `mcp_status가 도구 목록을 싣는다 — 실제: ${JSON.stringify(row?.tools?.map((t) => t.name))}`)
    ok(!!row?.scope, `mcp_status가 scope를 싣는다 — 실제: ${row?.scope}`)
  }
  const rsk = A.reloadSkills?.response?.skills
  ok(Array.isArray(rsk), `reload_skills 응답의 response.skills가 배열 — 실제: ${typeof rsk}`)
  ok(!!rsk?.find((s) => s.name === 'alpha-probe')?.description, 'reload_skills는 description까지 준다 (init.skills는 이름뿐)')

  // ── ④ 설명의 원전 — 셸(`wire.rs`)이 실제로 먹는 두 입 ──────────────────────
  // `init.skills`가 **이름뿐**이라는 것이 이 조인의 전제다. 여기서 깨지면 조인이
  // 통째로 불필요해진다(그때는 wire.rs를 지우는 게 맞다).
  ok(
    (B.init.skills ?? []).every((s) => typeof s === 'string'),
    `init.skills는 문자열 배열(=이름뿐) — 실제 첫 항목: ${JSON.stringify((B.init.skills ?? [])[0])}`
  )
  ok(Array.isArray(B.initCmds), `initialize 응답에 commands[] — 실제: ${typeof B.initCmds}`)
  ok(B.initFirst === true, `initialize 응답이 system/init보다 먼저 온다 — 실제: ${B.initFirst}`)
  const bp = (B.initCmds ?? []).find((c) => c.name === 'beta-probe')
  ok(!!bp?.description, `커맨드 사전이 설명을 싣는다 — 실제: ${JSON.stringify(bp)}`)
  ok(
    /\(project\)$/.test(bp?.description ?? ''),
    `프로젝트 스킬 설명 꼬리가 " (project)" — 실제: ${JSON.stringify(bp?.description)}`
  )
  // 개인 스코프 씨앗은 무인증 폴더에만 심는다(실 계정 폴더는 읽기 전용) — `--live`는 건너뛴다.
  if (!LIVE) {
    const gp = (B.initCmds ?? []).find((c) => c.name === 'gamma-personal')
    ok(
      /\(user\)$/.test(gp?.description ?? ''),
      `개인 스킬 설명 꼬리가 " (user)" — 실제: ${JSON.stringify(gp?.description)}`
    )
  }
  // 스코프가 **아닌** 꼬리도 같은 자리에 온다 — 셸이 닫힌 집합만 떼어내야 하는 근거.
  const dyn = (B.initCmds ?? []).find((c) => c.name === 'deep-research')
  ok(
    /\((?!user|project|local|plugin\)).+\)$/.test(dyn?.description ?? ''),
    `스코프가 아닌 꼬리도 존재한다(닫힌 집합만 떼어내야 하는 근거) — 실제: …${(dyn?.description ?? '').slice(-30)}`
  )
  ok(Array.isArray(B.pushCmds), `세션 중간 system/commands_changed 푸시가 온다 — 실제: ${typeof B.pushCmds}`)
  // 서버별 도구는 `init.tools`의 `mcp__<서버>__<도구>` 접두사에서만 갈라낼 수 있다.
  const pref = (B.init.tools ?? []).filter((t) => t.startsWith('mcp__'))
  ok(
    pref.includes('mcp__ccg-probe-b__echo') && pref.includes('mcp__ccg-probe-b__ping'),
    `init.tools에 mcp__<서버>__<도구> — 실제: ${JSON.stringify(pref)}`
  )
}

// ── ⑤ ★끈 것은 와이어에 어떤 얼굴로 오는가 (C = B와 같은 폴더 · 끄기 정책) ────
// 이 결과가 `wire.rs`의 `status:"off"` 되붙이기와 `SkillLive.off`의 **유일한 근거**다.
// 만약 CLI가 `status:"disabled"` 행을 준다면 되붙이기는 지어낸 코드가 된다.
if (B?.init && C?.init) {
  const cn = (C.init.mcp_servers ?? []).map((s) => s.name)
  const csk = C.init.skills ?? []
  console.log('  C.init.mcp_servers:', JSON.stringify(C.init.mcp_servers ?? []))
  const row = (C.init.mcp_servers ?? []).find((s) => s.name === 'ccg-probe-b')
  ok(
    !cn.includes('ccg-probe-b'),
    `끈 MCP 서버는 init.mcp_servers에서 **행째 사라진다**(status:"disabled"가 아니다) — 실제: ${JSON.stringify(row ?? cn)}`
  )
  ok(cn.includes('ccg-broken-b'), `안 끈 서버는 그대로 남는다(정책이 목록을 통째로 비우지 않는다) — 실제: ${JSON.stringify(cn)}`)
  ok(
    !csk.includes('beta-probe'),
    `skillOverrides:'off'인 스킬은 init.skills에서 사라진다 — 실제: ${JSON.stringify(short(csk))}`
  )
  ok(csk.includes('beta-second'), `안 끈 스킬은 그대로 남는다 — 실제: ${JSON.stringify(short(csk))}`)
  ok(
    !(C.init.tools ?? []).some((t) => t.startsWith('mcp__ccg-probe-b__')),
    `끈 서버의 도구도 init.tools에서 사라진다 — 실제: ${JSON.stringify((C.init.tools ?? []).filter((t) => t.startsWith('mcp__')))}`
  )
  // 끈 스킬의 **설명은 남는가** — 남으면 셸이 off 행에도 설명을 적을 수 있다.
  const offDesc = (C.initCmds ?? []).find((c) => c.name === 'beta-probe')
  console.log('  C의 커맨드 사전에 남은 beta-probe:', JSON.stringify(offDesc ?? null))
}
console.log(fails.length ? `\n실패 ${fails.length}건` : '\n전부 통과')
console.log('프레임:', rows.map((r) => r.framesPath).join(' · '))
process.exitCode = fails.length ? 1 : 0
