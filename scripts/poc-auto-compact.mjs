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

// ══════════════ B. 리듀서 — **두 렌더러를 각자의 기대값으로** ══════════════
//
// ★ R2 수정(크리틱 F1). R1은 단정만 3.0(M-UI) 문법으로 갈고 번들 **진입점은 2.6.2
// (`src/renderer`) 그대로**여서, 값은 옳은데 대상이 틀려 게이트가 빨개졌다(`5 FAILED`).
// 이제 두 리듀서를 **둘 다** 돌린다 — 3.0은 `boundary`(경계 선), 2.6.2는 `cmdresult`
// (카드). 장부 `docs/renderer-divergence.md` §6.2가 "`src/renderer`는 무수정"이라고
// 적어 둔 이상, 2.6.2 쪽 기대값도 예전 그대로 초록이어야 한다.

// i18n이 모듈 스코프에서 localStorage를 읽는다 — import 전에 스텁 (t()는 ko 기본)
globalThis.localStorage = { getItem: () => null, setItem: () => {} }

const eng = (event) => ({ type: 'engine', event })
const compactEv = (over = {}) => ({ type: 'compact', runId: 'r1', trigger: 'auto', preTokens: 150000, afterTokens: 12300, ...over })
const lastMsg = (s) => s.messages[s.messages.length - 1]

const RENDERERS = [
  {
    // 3.0 (Tauri) — M-UI §5-5: 자동 압축은 "명령이 하나 끝났다"가 아니라 "이 지점 위로는
    // 원문이 없다"는 **구조적 경계**라, 93.8px 카드가 아니라 15px 선이다.
    tag: 'app',
    entry: 'app/src/store/session.ts',
    name: '3.0 app/src',
    five: (m) => [
      ['5 auto → boundary(compact) 경계 선', m?.kind === 'boundary' && m?.glyph === 'compact', m],
      ['5 라벨 = 여기까지 요약됨', m?.label === '여기까지 요약됨', m?.label],
      ['5 수치 = 150K → 12K · 컨텍스트 75% → 6%', m?.num === '150K → 12K · 컨텍스트 75% → 6%', m?.num]
    ],
    eight: (m) => ['8 window 미상 → 토큰 전/후만', m?.kind === 'boundary' && m?.num === '150K → 12K', m?.num],
    nine: (m) => ['9 after 미상 → 수치 없음', m?.kind === 'boundary' && m?.num === null, m?.num]
  },
  {
    // 2.6.2 (Electron) — 장부상 무수정. 예전 기대값 그대로 초록이어야 한다.
    tag: 'renderer',
    entry: 'src/renderer/src/store/session.ts',
    name: '2.6.2 src/renderer',
    five: (m) => [
      ['5 auto → cmdresult(compact) 카드', m?.kind === 'cmdresult' && m?.name === 'compact' && m?.running === false, m],
      ['5 제목 = 자동 요약 안내', m?.title === '컨텍스트가 가득 차 대화를 자동으로 요약했어요', m?.title],
      ['5 stats = 75% → 6% · 138K 회수', m?.stats === '컨텍스트 75% → 6% 로 절약 · 토큰 138K 회수', m?.stats]
    ],
    eight: (m) => ['8 window 미상 → 토큰 회수만', m?.kind === 'cmdresult' && m?.stats === '토큰 138K 회수', m?.stats],
    nine: (m) => ['9 after 미상 → stats 없음', m?.kind === 'cmdresult' && m?.stats === null, m?.stats]
  }
]

for (const r of RENDERERS) {
  const storeBundle = path.join(root, `.poc-store-compact-${r.tag}.mjs`)
  await esbuild.build({
    entryPoints: [path.join(root, r.entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: storeBundle,
    alias: { '@shared': path.join(root, 'src/shared') },
    logLevel: 'silent'
  })
  const { reducer, initialSessionState } = await import(pathToFileURL(storeBundle).href)
  fs.rmSync(storeBundle, { force: true })

  const p = (label) => `[${r.name}] ${label}`

  // window(200000)를 아는 상태 — 이전 result가 contextWindow를 남긴 대화
  const withWindow = reducer(
    initialSessionState,
    eng({ type: 'result', runId: 'r1', isError: false, text: '', costUsd: null, durationMs: null, numTurns: null, contextTokens: 150000, contextWindow: 200000, viaApi: false })
  )

  // 5) auto → 이 렌더러의 표시 형태 + 수치(하나도 안 버린다)
  const m5 = lastMsg(reducer(withWindow, eng(compactEv())))
  for (const [label, cond, detail] of r.five(m5)) check(p(label), cond, detail)

  // 6) manual → 무시 (수동 /compact 카드가 담당)
  check(p('6 manual 무시'), reducer(withWindow, eng(compactEv({ trigger: 'manual' }))) === withWindow)

  // 7) 수동 /compact 실행 중(pendingCommand) → 무시 (이중 카드 방지)
  const pending = { ...withWindow, pendingCommand: { name: 'compact', beforeContext: 150000, beforeMsgs: 2, cardId: 'c1' } }
  check(p('7 pendingCommand=compact 중 무시'), reducer(pending, eng(compactEv())) === pending)

  // 8) window 미상 → 수치는 토큰만 (비율은 지어내지 않는다)
  const [l8, c8, d8] = r.eight(lastMsg(reducer(initialSessionState, eng(compactEv()))))
  check(p(l8), c8, d8)

  // 9) after 미상(무프레임 종결 플러시) → 수치 없이 자리만 (§4-4)
  const [l9, c9, d9] = r.nine(lastMsg(reducer(withWindow, eng(compactEv({ afterTokens: null })))))
  check(p(l9), c9, d9)
}

fs.rmSync(cwd, { recursive: true, force: true })
console.log(failed ? `\n${failed} FAILED` : '\nall ok')
process.exit(failed ? 1 : 0)
