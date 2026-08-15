/**
 * PoC — Edit/Write 도구 행의 +N −N이 "이 도구 한 번" 기준인지 검증.
 *
 * 사고: 도구 행 수치가 fileChangePending의 런 누적 diff(첫 접촉 기준선→현재)를 그대로
 * 실어, 같은 파일을 거듭 고칠수록 행마다 숫자가 불어났다(한 줄 고쳐도 +N −N이 런 전체).
 * 런에서 태어난 파일은 후속 Edit도 계속 '새 파일'로 떴다. 수정: pending.op(cur→next
 * 증감)를 별도 계산해 행에 싣고, 누적 diff는 모달·변경 파일 패널용으로 유지.
 *
 * 검증(가짜 SDK 프레임 대본 — poc-notif-replay 하네스 재사용):
 *  1. Write 새 파일 → 행 '새 파일'
 *  2. 기존 파일 첫 Edit(1줄) → 행 +1 -1 (누적과 동일 — 재계산 생략 경로)
 *  3. 같은 파일 둘째 Edit(1줄) → 행 +1 -1 (수정 전엔 +2 -2), file-change 누적은 2/2 유지
 *  4. 런에서 태어난 파일의 후속 Edit → 행 +1 -0 (수정 전엔 '새 파일'), 누적 diff는 new 유지
 *  5. 기존 파일 Write 전량 교체(실변경 1줄 추가) → 행 +1 -0, 누적은 기준선 대비 3/2
 *
 * 실행: node scripts/poc-edit-row-counts.mjs
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const bundle = path.join(root, '.poc-engine-rows.mjs')

// ── 전자·부수 모듈 스텁 — 엔진 로직만 남긴다 (poc-notif-replay와 동일) ──
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
    build.onLoad({ filter: /.*/, namespace: 'poc-stub' }, (args) => ({
      contents: stubs[args.path],
      loader: 'js',
      resolveDir: root
    }))
  }
}

await esbuild.build({
  entryPoints: [path.join(root, 'src/main/claude/engine.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  alias: { '@shared': path.join(root, 'src/shared') },
  plugins: [stubPlugin],
  logLevel: 'silent'
})
const { ClaudeEngine } = await import(pathToFileURL(bundle).href)
fs.rmSync(bundle, { force: true })

delete process.env.ANTHROPIC_API_KEY

let failed = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || detail == null ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (!cond) failed++
}

// ── 작업 폴더 — b.txt는 런 전부터 있던 파일, a.txt는 런에서 태어난다 ──
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-rows-'))
const aAbs = path.join(cwd, 'a.txt')
const bAbs = path.join(cwd, 'b.txt')
fs.writeFileSync(bAbs, 'b1\nb2\nb3\nb4\nb5\n')

// ── 가짜 SDK query — 프레임 대본 (poc-notif-replay와 같은 골격) ──────
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
const toolUse = (id, name, input) => ({
  type: 'assistant',
  message: { model: 'claude-fable-5', content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 10, output_tokens: 5 } },
  parent_tool_use_id: null
})
const toolResult = (id) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'ok' }] }] },
  parent_tool_use_id: null,
  session_id: 's1'
})
const resultFrame = (text) => ({ type: 'result', is_error: false, result: text, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0, duration_ms: 100, num_turns: 1 })

const events = []
const waitEv = (pred, what) =>
  new Promise((res, rej) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      const e = events.find(pred)
      if (e) {
        clearInterval(iv)
        res(e)
      } else if (Date.now() - t0 > 15_000) {
        clearInterval(iv)
        rej(new Error(`timeout: ${what} — events=${JSON.stringify(events.map((x) => x.type))}`))
      }
    }, 10)
  })
const toolEnd = (id) => events.find((e) => e.type === 'tool-end' && e.id === id)
// 그 도구의 file-change — tool-end 직전에 emit되므로 tool-end 위치에서 뒤로 첫 매치
const fileChangeOf = (id, p) => {
  const at = events.findIndex((e) => e.type === 'tool-end' && e.id === id)
  return events.slice(0, at).reverse().find((e) => e.type === 'file-change' && e.file.path === p)
}

// 실제 CLI 순서 재현: tool_use 프레임 → (엔진이 tool-start에서 디스크를 미리 읽음) →
// 디스크에 변경 적용 → tool_result 프레임. tool-start 목격 후에 디스크를 만져야
// 엔진의 사전 읽기(cur)가 "적용 전" 내용이라는 실계약이 지켜진다.
async function runTool({ push }, id, name, input, applyToDisk) {
  push(toolUse(id, name, input))
  await waitEv((e) => e.type === 'tool-start' && e.tool.id === id, `tool-start ${id}`)
  applyToDisk()
  push(toolResult(id))
  await waitEv((e) => e.type === 'tool-end' && e.id === id, `tool-end ${id}`)
}

installFakeQuery(async (io) => {
  io.push(init())

  // 1) Write 새 파일 a.txt (3줄)
  await runTool(io, 'tu1', 'Write', { file_path: aAbs, content: 'a1\na2\na3\n' }, () => fs.writeFileSync(aAbs, 'a1\na2\na3\n'))

  // 2) b.txt 첫 Edit — b2→B2
  await runTool(io, 'tu2', 'Edit', { file_path: bAbs, old_string: 'b2', new_string: 'B2' }, () =>
    fs.writeFileSync(bAbs, fs.readFileSync(bAbs, 'utf8').replace('b2', 'B2'))
  )

  // 3) b.txt 둘째 Edit — b4→B4 (수정 전엔 여기가 +2 -2로 떴다)
  await runTool(io, 'tu3', 'Edit', { file_path: bAbs, old_string: 'b4', new_string: 'B4' }, () =>
    fs.writeFileSync(bAbs, fs.readFileSync(bAbs, 'utf8').replace('b4', 'B4'))
  )

  // 4) 런에서 태어난 a.txt의 후속 Edit — a3 뒤에 a4 추가 (수정 전엔 '새 파일'로 떴다)
  await runTool(io, 'tu4', 'Edit', { file_path: aAbs, old_string: 'a3', new_string: 'a3\na4' }, () =>
    fs.writeFileSync(aAbs, 'a1\na2\na3\na4\n')
  )

  // 5) 기존 파일 Write 전량 교체 — 현재 대비 실변경은 b6 한 줄 추가
  const bNext = 'b1\nB2\nb3\nB4\nb5\nb6\n'
  await runTool(io, 'tu5', 'Write', { file_path: bAbs, content: bNext }, () => fs.writeFileSync(bAbs, bNext))

  io.push(resultFrame('완료'))
})

const eng = new ClaudeEngine((e) => events.push(e), 'chat')
await eng.run({ prompt: '파일 정리해줘', model: 'fable', mode: 'auto', effort: 'high', cwd, useApi: false })

// ── 판정 ────────────────────────────────────────────────────────────
check("1 새 파일 Write 행 = '새 파일'", toolEnd('tu1')?.result === '새 파일', toolEnd('tu1')?.result)
check('2 첫 Edit 행 = +1 -1', toolEnd('tu2')?.result === '+1 -1', toolEnd('tu2')?.result)
check('3 둘째 Edit 행 = +1 -1 (누적 아님)', toolEnd('tu3')?.result === '+1 -1', toolEnd('tu3')?.result)
const fc3 = fileChangeOf('tu3', 'b.txt')
check('3 변경 파일 패널 누적은 유지 (+2 -2)', fc3 && fc3.file.add === 2 && fc3.file.del === 2, fc3?.file)
check("4 런 탄생 파일 후속 Edit 행 = +1 -0 ('새 파일' 아님)", toolEnd('tu4')?.result === '+1 -0', toolEnd('tu4')?.result)
const fc4 = fileChangeOf('tu4', 'a.txt')
check("4 누적 diff는 '새 파일' 한 장 유지 (new·+4)", fc4 && fc4.file.tag === 'new' && fc4.file.add === 4, fc4?.file)
check('5 기존 파일 Write 행 = 이번 변경만 (+1 -0)', toolEnd('tu5')?.result === '+1 -0', toolEnd('tu5')?.result)
const fc5 = fileChangeOf('tu5', 'b.txt')
check('5 누적은 기준선 대비 (+3 -2)', fc5 && fc5.file.add === 3 && fc5.file.del === 2, fc5?.file)

fs.rmSync(cwd, { recursive: true, force: true })
console.log(failed ? `\n${failed} FAILED` : '\nall ok')
process.exit(failed ? 1 : 0)
