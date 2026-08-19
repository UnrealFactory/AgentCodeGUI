/**
 * PoC — 자동 압축(auto-compact) 표시 검증.
 *
 * 사고: CLI가 컨텍스트가 가득 차 스스로 대화를 요약하면(system/compact_boundary)
 * 엔진이 그 프레임을 버려서, 게이지만 말없이 뚝 떨어지고 이유 표시가 없었다.
 * 수정: 엔진이 경계를 보류했다가 압축 후 첫 assistant 프레임의 실측 컨텍스트와
 * 짝지어 compact 이벤트(전/후)를 context보다 먼저 내보내고, 렌더러가 auto만
 * /compact 계열 카드(제목+절약 stats)로 남긴다.
 *
 * 검증:
 *  A. 엔진(가짜 SDK 프레임 대본 — poc-edit-row-counts 하네스 재사용)
 *   1. auto 경계 → 다음 assistant 프레임에서 compact{pre,after} 1회, context(after)보다 먼저
 *   2. 게이지 흐름: context 140500 → 12300, result.contextTokens=12300
 *   3. 경계 후 assistant 프레임 없이 종결 → settle에서 afterTokens:null로 플러시(다음 턴 누수 방지)
 *   4. manual 경계도 이벤트는 흐른다(거름은 렌더러 몫)
 *  B. 리듀서(진짜 store/session.ts reducer 직접 구동)
 *   5. auto → cmdresult(name compact) 카드 + '컨텍스트 75% → 6% … 138K 회수' stats
 *   6. manual → 무시(수동 /compact 카드가 담당), 7. pendingCommand=compact 중 → 무시
 *   8. window 미상 → 토큰 회수만, 9. after=null → stats 없이 카드만
 *
 * 실행: node scripts/poc-auto-compact.mjs
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')

let failed = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || detail == null ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (!cond) failed++
}

// ══════════════ A. 엔진 — 가짜 SDK 프레임 대본 ══════════════

const engineBundle = path.join(root, '.poc-engine-compact.mjs')
const stubs = {
  electron: `export const app = { getPath: () => ${JSON.stringify(os.tmpdir())} }`,
  '../engine/versions': `import os from 'node:os'
export const APP_HOME = os.tmpdir()
export const loadActiveQuery = async () => globalThis.__pocQuery`,
  '../skills': `export const disabledSkillOverrides = () => null`,
  '../mcp': `export const deniedMcpServers = () => null`,
  '../apiConfig': `export const getApiKey = () => null
export const addSpend = () => {}
export const envKeyChoice = () => 'use'
export const setEnvKeyChoice = () => {}`,
  '../apiUsage': `export const recordApiUsage = () => {}`,
  '../auth': `import os from 'node:os'
export const accountRunDir = () => os.tmpdir()
export const syncAccountTokens = () => {}
export const defaultAccountEmail = () => 'poc@example.com'`,
  '../lsp/manager': `export const lspManager = { filesChanged: () => {}, notifyWatchedFiles: () => {} }`
}
const stubPlugin = {
  name: 'poc-stubs',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'poc-stub' }))
    build.onResolve({ filter: /^\.\.\/(engine\/versions|skills|mcp|apiConfig|apiUsage|auth|lsp\/manager)$/ }, (args) => ({
      path: args.path,
      namespace: 'poc-stub'
    }))
    build.onLoad({ filter: /.*/, namespace: 'poc-stub' }, (args) => ({ contents: stubs[args.path], loader: 'js', resolveDir: root }))
  }
}
await esbuild.build({
  entryPoints: [path.join(root, 'src/main/claude/engine.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: engineBundle,
  alias: { '@shared': path.join(root, 'src/shared') },
  plugins: [stubPlugin],
  logLevel: 'silent'
})
const { ClaudeEngine } = await import(pathToFileURL(engineBundle).href)
fs.rmSync(engineBundle, { force: true })
delete process.env.ANTHROPIC_API_KEY

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-compact-'))

function installFakeQuery(driver) {
  globalThis.__pocQuery = (args) => {
    const frames = []
    let wake = null
    let ended = false
    const push = (f) => {
      frames.push(f)
      wake?.()
    }
    const end = () => {
      ended = true
      wake?.()
    }
    ;(async () => {
      for await (const _ of args.prompt) {
        /* 프롬프트 소비만 */
      }
      end()
    })().catch(() => end())
    const q = {
      interrupt: async () => {},
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (frames.length) {
            yield frames.shift()
            continue
          }
          if (ended) return
          await new Promise((r) => (wake = r))
          wake = null
        }
      }
    }
    driver({ push, end }).catch((e) => {
      console.error('driver error:', e.message)
      failed++
      end()
    })
    return q
  }
}

const init = () => ({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-fable-5', cwd, tools: [], apiKeySource: 'oauth' })
const textFrame = (text, usage) => ({
  type: 'assistant',
  message: { model: 'claude-fable-5', content: [{ type: 'text', text }], usage },
  parent_tool_use_id: null
})
const boundary = (trigger, pre) => ({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger, pre_tokens: pre } })
const resultFrame = (text) => ({ type: 'result', is_error: false, result: text, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0, duration_ms: 100, num_turns: 1 })

async function runScript(driver) {
  const events = []
  installFakeQuery(driver)
  const eng = new ClaudeEngine((e) => events.push(e), 'chat')
  await eng.run({ prompt: '계속 진행해줘', model: 'fable', mode: 'auto', effort: 'high', cwd, useApi: false })
  return events
}

// 1·2) auto 경계가 턴 중간에 — 전/후 짝 + 순서 + 게이지 흐름
const ev1 = await runScript(async ({ push }) => {
  push(init())
  push(textFrame('중간 답변', { input_tokens: 100000, cache_read_input_tokens: 40000, output_tokens: 500 }))
  push(boundary('auto', 150000))
  push(textFrame('압축 후 답변', { input_tokens: 12000, output_tokens: 300 }))
  push(resultFrame('완료'))
})
const compacts1 = ev1.filter((e) => e.type === 'compact')
check('1 auto compact 이벤트 1회', compacts1.length === 1, compacts1)
check(
  '1 전/후 짝 (pre 150000 → after 12300)',
  compacts1[0]?.trigger === 'auto' && compacts1[0]?.preTokens === 150000 && compacts1[0]?.afterTokens === 12300,
  compacts1[0]
)
const iCompact = ev1.findIndex((e) => e.type === 'compact')
const iCtxAfter = ev1.findIndex((e) => e.type === 'context' && e.contextTokens === 12300)
check('1 compact가 하락 context보다 먼저', iCompact >= 0 && iCtxAfter > iCompact, { iCompact, iCtxAfter })
const ctxSeq = ev1.filter((e) => e.type === 'context').map((e) => e.contextTokens)
check('2 게이지 흐름 140500 → 12300', ctxSeq.join() === '140500,12300', ctxSeq)
check('2 result.contextTokens = 압축 후 실측', ev1.find((e) => e.type === 'result')?.contextTokens === 12300)

// 3) 경계 후 assistant 프레임 없이 종결 — settle에서 after:null 플러시
const ev2 = await runScript(async ({ push }) => {
  push(init())
  push(textFrame('답변', { input_tokens: 90000, output_tokens: 200 }))
  push(boundary('auto', 95000))
  push(resultFrame('완료'))
})
const c2 = ev2.find((e) => e.type === 'compact')
check('3 무프레임 종결 → after:null 플러시', c2?.trigger === 'auto' && c2?.preTokens === 95000 && c2?.afterTokens === null, c2)
check('3 result보다 먼저', ev2.findIndex((e) => e.type === 'compact') < ev2.findIndex((e) => e.type === 'result'))

// 4) manual 경계 — 이벤트는 흐른다(렌더러가 거른다)
const ev3 = await runScript(async ({ push }) => {
  push(init())
  push(boundary('manual', 90000))
  push(textFrame('요약 후', { input_tokens: 8000, output_tokens: 100 }))
  push(resultFrame('완료'))
})
const c3 = ev3.find((e) => e.type === 'compact')
check('4 manual도 이벤트 방출 (trigger 유지)', c3?.trigger === 'manual' && c3?.preTokens === 90000 && c3?.afterTokens === 8100, c3)

// ══════════════ B. 리듀서 — 진짜 store/session.ts 직접 구동 ══════════════

// i18n이 모듈 스코프에서 localStorage를 읽는다 — import 전에 스텁 (t()는 ko 기본)
globalThis.localStorage = { getItem: () => null, setItem: () => {} }

const storeBundle = path.join(root, '.poc-store-compact.mjs')
await esbuild.build({
  entryPoints: [path.join(root, 'src/renderer/src/store/session.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: storeBundle,
  alias: { '@shared': path.join(root, 'src/shared') },
  logLevel: 'silent'
})
const { reducer, initialSessionState } = await import(pathToFileURL(storeBundle).href)
fs.rmSync(storeBundle, { force: true })

const eng = (event) => ({ type: 'engine', event })
const compactEv = (over = {}) => ({ type: 'compact', runId: 'r1', trigger: 'auto', preTokens: 150000, afterTokens: 12300, ...over })
const lastMsg = (s) => s.messages[s.messages.length - 1]

// window(200000)를 아는 상태 — 이전 result가 contextWindow를 남긴 대화
const withWindow = reducer(
  initialSessionState,
  eng({ type: 'result', runId: 'r1', isError: false, text: '', costUsd: null, durationMs: null, numTurns: null, contextTokens: 150000, contextWindow: 200000, viaApi: false })
)

// 5) auto → 카드 + % stats
const s5 = reducer(withWindow, eng(compactEv()))
const m5 = lastMsg(s5)
check('5 auto → cmdresult(compact) 카드', m5?.kind === 'cmdresult' && m5?.name === 'compact' && m5?.running === false, m5)
check('5 제목 = 자동 요약 안내', m5?.title === '컨텍스트가 가득 차 대화를 자동으로 요약했어요', m5?.title)
check('5 stats = 75% → 6% · 138K 회수', m5?.stats === '컨텍스트 75% → 6% 로 절약 · 토큰 138K 회수', m5?.stats)

// 6) manual → 무시 (수동 /compact 카드가 담당)
check('6 manual 무시', reducer(withWindow, eng(compactEv({ trigger: 'manual' }))) === withWindow)

// 7) 수동 /compact 실행 중(pendingCommand) → 무시 (이중 카드 방지)
const pending = { ...withWindow, pendingCommand: { name: 'compact', beforeContext: 150000, beforeMsgs: 2, cardId: 'c1' } }
check('7 pendingCommand=compact 중 무시', reducer(pending, eng(compactEv())) === pending)

// 8) window 미상 → 토큰 회수만
const m8 = lastMsg(reducer(initialSessionState, eng(compactEv())))
check('8 window 미상 → 토큰 회수만', m8?.kind === 'cmdresult' && m8?.stats === '토큰 138K 회수', m8?.stats)

// 9) after 미상(무프레임 종결 플러시) → stats 없이 카드만
const m9 = lastMsg(reducer(withWindow, eng(compactEv({ afterTokens: null }))))
check('9 after 미상 → stats 없음', m9?.kind === 'cmdresult' && m9?.stats === null, m9?.stats)

fs.rmSync(cwd, { recursive: true, force: true })
console.log(failed ? `\n${failed} FAILED` : '\nall ok')
process.exit(failed ? 1 : 0)
