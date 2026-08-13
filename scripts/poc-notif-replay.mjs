/**
 * PoC — 통지 삼킴 리플레이(ClaudeEngine.tryNotifReplay) 검증.
 *
 * 실측 사고(2026-08-13 01:08Z, C--Code-AutoProject/b37588df 전사): 워크플로를 쥔 CLI가
 * 완료 기록 없이 죽은 뒤(Esc 중지=TaskStop은 전사에 마커를 안 남긴다·앱 종료 등), 다음
 * 재기동 턴에서 CLI가 고아 <task-notification>을 합성·주입 → 그 기상 턴이 사용자 프롬프트를
 * 한 턴으로 묶어 'No response requested.'만 내고 종결 → 렌더러엔 "응답 없이 끝났어요"만
 * 남고 메시지가 증발했다(수동 재전송은 정상 동작 — 이 PoC의 시나리오 A가 그 와이어 재현).
 *
 * 검증: 가짜 SDK query(프레임 대본)로 엔진을 돌려
 *  A. 통지 주입 + 무활동 종결('No response requested.' result) → 프롬프트가 자동 재주입되고
 *     빈 done이 렌더러로 새지 않는다 (스크린샷의 무음 턴 오탐이 사라진다)
 *  B. 통지 없는 진짜 무음 턴 → 리플레이 없이 기존대로 정착 (재전송 루프 금지)
 *  C. 통지 주입 + 사용자가 Esc로 끊은 턴 → 리플레이가 프롬프트를 되살리지 않는다
 *
 * 실행: node scripts/poc-notif-replay.mjs   (esbuild로 엔진을 스텁 번들 후 인메모리 구동)
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const bundle = path.join(root, '.poc-engine.mjs')

// ── 전자·부수 모듈 스텁 — 엔진 로직만 남긴다 ─────────────────────────
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
  '../lsp/manager': `export const lspManager = { filesChanged: () => {} }`
}
const stubPlugin = {
  name: 'poc-stubs',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'poc-stub' }))
    build.onResolve({ filter: /^\.\.\/(engine\/versions|skills|mcp|apiConfig|apiUsage|auth|lsp\/manager)$/ }, (args) => {
      // 엔진 파일(src/main/claude)에서의 상대 경로만 대상 — 다른 위치의 동명 경로는 없음
      return { path: args.path, namespace: 'poc-stub' }
    })
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

delete process.env.ANTHROPIC_API_KEY // 전역 키 확인 카드 경로 차단 — 구독 경로로 고정

let failed = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || detail == null ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (!cond) failed++
}

// ── 프레임 대본용 가짜 SDK query ────────────────────────────────────
// 엔진의 prompt AsyncIterable을 소비해 prompts[]에 쌓고(재주입 관찰 지점), 대본(driver)이
// push()한 프레임을 엔진 루프에 흘린다. 프롬프트 스트림이 닫히면(엔진 closeInput) 실제
// CLI처럼 프레임 스트림도 끝낸다.
function installFakeQuery(driver) {
  const state = { prompts: [], q: null }
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
    const waiters = []
    ;(async () => {
      for await (const m of args.prompt) {
        state.prompts.push(m?.message?.content?.[0]?.text ?? '')
        waiters.splice(0).forEach((r) => r())
      }
      end() // 입력이 닫히면 CLI가 정리 후 종료 — 스트림도 끝난다
    })().catch(() => end())
    const waitPrompt = (n) =>
      new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`waitPrompt(${n}) timeout — prompts=${JSON.stringify(state.prompts)}`)), 30_000)
        const chk = () => {
          if (state.prompts.length >= n) {
            clearTimeout(t)
            res()
          } else waiters.push(chk)
        }
        chk()
      })
    const q = {
      interrupt: async () => q.onInterrupt?.(),
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
    state.q = q
    driver({ push, end, waitPrompt, q }).catch((e) => {
      console.error('driver error:', e.message)
      failed++
      end()
    })
    return q
  }
  return state
}

const init = () => ({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-fable-5', cwd: os.tmpdir(), tools: [], apiKeySource: 'oauth' })
const notifFrame = (id) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: `<task-notification> <task-id>${id}</task-id> <status>stopped</status> <summary>No completion record was found…</summary> </task-notification>` }] },
  parent_tool_use_id: null,
  session_id: 's1'
})
const assistantText = (text) => ({
  type: 'assistant',
  message: { model: 'claude-fable-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } },
  parent_tool_use_id: null
})
const resultFrame = (text) => ({ type: 'result', is_error: false, result: text, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0, duration_ms: 100, num_turns: 1 })
const runReq = { prompt: '계속해줄래?', model: 'fable', mode: 'normal', effort: 'high', cwd: os.tmpdir(), useApi: false }

// ── A. 고아 통지 삼킴 → 프롬프트 자동 리플레이 ──────────────────────
{
  const events = []
  const fake = installFakeQuery(async ({ push, waitPrompt }) => {
    await waitPrompt(1)
    push(init())
    push(notifFrame('wf123'))
    push(resultFrame('No response requested.')) // 기상 턴이 프롬프트째 삼킨 종결 (실측 시그니처)
    await waitPrompt(2) // ← 리플레이 기대 지점
    push(assistantText('네, 이어갑니다'))
    push(resultFrame('네, 이어갑니다'))
  })
  const eng = new ClaudeEngine((e) => events.push(e), 'chat')
  await eng.run(runReq)
  const results = events.filter((e) => e.type === 'result')
  const dones = events.filter((e) => e.type === 'status' && (e.status === 'done' || e.status === 'error'))
  check('A 프롬프트가 자동 재주입됐다', fake.prompts.length === 2 && fake.prompts[1] === '계속해줄래?', fake.prompts)
  check('A 빈 종결이 렌더러로 새지 않았다 (result 1회)', results.length === 1, results.map((r) => r.text))
  check('A 최종 result = 진짜 답변', results[0]?.text === '네, 이어갑니다', results[0]?.text)
  check('A 종결 status도 1회(done)', dones.length === 1 && dones[0].status === 'done', dones)
  check('A 답변 말풍선 정상 도착', events.some((e) => e.type === 'assistant-done' && e.text === '네, 이어갑니다'))
}

// ── B. 통지 없는 진짜 무음 턴 — 리플레이 금지(기존 정착 유지) ────────
{
  const events = []
  const fake = installFakeQuery(async ({ push, waitPrompt }) => {
    await waitPrompt(1)
    push(init())
    push(resultFrame('')) // 통지 없이 빈 성공 종결 — held 2.5s 뒤 무음 턴으로 정착해야 한다
  })
  const eng = new ClaudeEngine((e) => events.push(e), 'chat')
  await eng.run(runReq)
  const results = events.filter((e) => e.type === 'result')
  check('B 재주입 없음', fake.prompts.length === 1, fake.prompts)
  check('B 무음 턴 그대로 정착 (result 1회·빈 텍스트)', results.length === 1 && results[0].text === '', results)
  check('B done 정착', events.some((e) => e.type === 'status' && e.status === 'done'))
}

// ── C. 통지 주입 + Esc 중단 — 끊은 턴을 되살리지 않는다 ─────────────
{
  const events = []
  const fake = installFakeQuery(async ({ push, waitPrompt, q }) => {
    await waitPrompt(1)
    push(init())
    push(notifFrame('wf999'))
    q.onInterrupt = () => push(resultFrame('')) // interrupt 응답 = 중단된 턴의 result
  })
  const eng = new ClaudeEngine((e) => events.push(e), 'chat')
  const done = eng.run(runReq)
  await new Promise((r) => setTimeout(r, 800)) // init·통지 프레임이 흐를 시간
  await eng.interruptTurn()
  await done
  check('C Esc로 끊은 턴은 재주입되지 않는다', fake.prompts.length === 1, fake.prompts)
  check('C 종결은 정상 정착', events.some((e) => e.type === 'status' && (e.status === 'done' || e.status === 'error')))
}

console.log(failed ? `\n${failed} FAILED` : '\nall ok')
process.exit(failed ? 1 : 0)
