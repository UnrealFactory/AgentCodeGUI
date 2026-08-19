/**
 * PoC — 워크플로 정착(settled) 이벤트 방출 타이밍 검증.
 *
 * 실측 증상(2026-08-19 스크린샷): 모델이 턴을 안 끝내고 워크플로를 연달아 돌리는 마라톤
 * 턴(TaskOutput block 대기 반복)에서, 정착한 워크플로의 settled 방출이 wfSettledEmits로
 * 미뤄진 채 flushWfSettled(=result·무음 정착·스트림 종료)만 기다려 알약이 턴 내내
 * running으로 남고 계속 쌓였다. 미룸의 원래 사유(정리 턴 전에 settled를 내보내면 wfAlive
 * 게이트가 풀려 새 전송이 정리 턴을 자름)는 유휴 상주(turnEnded)에서만 성립한다 — 진행
 * 중인 턴은 busy가 이미 전송을 예약 큐로 막는다.
 *
 * 검증: 가짜 SDK query(프레임 대본)로 진짜 엔진을 돌려
 *  A. 진행 중인 턴에서 정착(완료 통지가 result보다 먼저) → settled가 그 자리에서 즉시
 *     방출된다(result를 기다리지 않는다) — 알약이 턴 도중에 걷힌다
 *  B. 유휴 상주(턴 종료 후 CLI만 상주) 중 정착 → 기존대로 정리 턴의 result까지 미룬다
 *     (즉시 방출하면 정리 턴이 잘리는 원래 사고의 회귀 방지)
 *
 * 실행: node scripts/poc-wf-settle-emit.mjs   (esbuild로 엔진을 스텁 번들 후 인메모리 구동)
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const bundle = path.join(root, '.poc-engine-wfsettle.mjs')

// ── 전자·부수 모듈 스텁 — 엔진 로직만 남긴다 (poc-notif-replay.mjs와 동일 배선) ──
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 프레임 대본용 가짜 SDK query (poc-notif-replay.mjs와 동일) ──────────────
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

// ── 프레임 조립 ─────────────────────────────────────────────────────
const init = () => ({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-fable-5', cwd: os.tmpdir(), tools: [], apiKeySource: 'oauth' })
const assistantText = (text) => ({
  type: 'assistant',
  message: { model: 'claude-fable-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } },
  parent_tool_use_id: null
})
const resultFrame = (text) => ({ type: 'result', is_error: false, result: text, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0, duration_ms: 100, num_turns: 1 })
// bg 목록 REPLACE — tasks에 있는 동안 살아있음 (task_type 'local_workflow'가 워크플로 판별)
const bgList = (...ids) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks: ids.map((id) => ({ task_id: id, task_type: 'local_workflow', description: '테스트 워크플로' }))
})
// 진행 스냅샷 — 이걸 받아야 wfSnaps에 running 스냅샷이 생기고 렌더러에 알약이 뜬다
const wfProgress = (id) => ({
  type: 'system',
  subtype: 'task_progress',
  task_id: id,
  summary: '테스트 워크플로',
  workflow_progress: [
    { type: 'workflow_phase', index: 1, title: 'Build' },
    { type: 'workflow_agent', label: 'a1', phaseIndex: 1, phaseTitle: 'Build', model: 'claude-fable-5', state: 'done', tokens: 100 }
  ],
  usage: { total_tokens: 100, tool_uses: 2, duration_ms: 1000 }
})
const wfNotif = (id) => ({ type: 'system', subtype: 'task_notification', task_id: id, status: 'completed', summary: `Dynamic workflow completed` })
// CLI가 진행 중인 턴에 주입하는 정착 통지 user 프레임 — deliveredNotifs로 잡혀 이 턴의
// result가 보고 완료가 된다(pendingSettles 해제 → 입력 닫힘 → 대본이 깔끔히 끝난다)
const notifUserFrame = (id) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: `<task-notification> <task-id>${id}</task-id> <status>completed</status> </task-notification>` }] },
  parent_tool_use_id: null,
  session_id: 's1'
})
const runReq = { prompt: '워크플로 돌려줘', model: 'fable', mode: 'normal', effort: 'high', cwd: os.tmpdir(), useApi: false }

// ── A. 진행 중인 턴에서 정착 → settled 즉시 방출 (result를 기다리지 않는다) ──
{
  const events = []
  const settledCount = () => events.filter((e) => e.type === 'workflow' && e.wf.status !== 'running').length
  let settledBeforeResult = -1 // result 프레임을 밀어넣기 직전의 settled 방출 수
  installFakeQuery(async ({ push, waitPrompt }) => {
    await waitPrompt(1)
    push(init())
    push(bgList('wf1')) // 워크플로 시작 — 목록 등장
    push(wfProgress('wf1')) // 진행 스냅샷 → 알약 점등
    push(bgList()) // 목록 이탈 (정착 임박)
    push(wfNotif('wf1')) // 정착 통지 — 턴은 아직 진행 중 (result 전)
    push(notifUserFrame('wf1')) // CLI가 진행 중인 턴에 주입한 통지 (보고는 이 턴 몫)
    await sleep(400) // 엔진이 프레임을 소화할 시간 — 이 시점의 settled 수를 기록
    settledBeforeResult = settledCount()
    push(assistantText('워크플로 끝났고 결과 정리했어'))
    push(resultFrame('결과 정리'))
  })
  const eng = new ClaudeEngine((e) => events.push(e), 'chat')
  await eng.run(runReq)
  const running = events.filter((e) => e.type === 'workflow' && e.wf.status === 'running')
  const settled = events.filter((e) => e.type === 'workflow' && e.wf.status !== 'running')
  check('A 진행 스냅샷으로 알약 점등(running 방출)', running.length >= 1, running.length)
  check('A settled가 result 전에 즉시 방출됐다', settledBeforeResult === 1, { settledBeforeResult })
  check('A settled는 한 번만 (result에서 중복 방출 없음)', settled.length === 1, settled.map((e) => e.wf.status))
  check('A settled 상태 = completed', settled[0]?.wf.status === 'completed', settled[0]?.wf.status)
  check('A 턴 정상 종결(done)', events.some((e) => e.type === 'status' && e.status === 'done'))
}

// ── B. 유휴 상주 중 정착 → 기존대로 정리 턴 result까지 미룬다 (회귀 방지) ──
{
  const events = []
  const settledCount = () => events.filter((e) => e.type === 'workflow' && e.wf.status !== 'running').length
  let settledWhileIdle = -1 // 유휴 정착 통지 뒤·정리 턴 전의 settled 방출 수 (0이어야 정상)
  installFakeQuery(async ({ push, waitPrompt }) => {
    await waitPrompt(1)
    push(init())
    push(bgList('wf2'))
    push(wfProgress('wf2'))
    push(assistantText('워크플로 백그라운드로 시작했어'))
    push(resultFrame('시작함')) // 턴1 종료 — 워크플로 상주(입력 유지)
    await sleep(300) // 유휴 상주 진입
    push(bgList()) // 목록 이탈
    push(wfNotif('wf2')) // 유휴 중 정착 통지 — CLI가 재기동 턴을 낼 참
    await sleep(400)
    settledWhileIdle = settledCount() // 여기서 0이어야 함 — 정리 턴 전 방출은 전송 경합 유발
    push(assistantText('워크플로 결과: 다 됐어')) // 재기동(정리) 턴
    push(resultFrame('다 됐어'))
  })
  const eng = new ClaudeEngine((e) => events.push(e), 'chat')
  await eng.run(runReq)
  const settled = events.filter((e) => e.type === 'workflow' && e.wf.status !== 'running')
  const results = events.filter((e) => e.type === 'result')
  check('B 유휴 정착은 정리 턴 전까지 미룬다(즉시 방출 없음)', settledWhileIdle === 0, { settledWhileIdle })
  check('B 정리 턴 result에서 settled 방출', settled.length === 1 && settled[0].wf.status === 'completed', settled.map((e) => e.wf.status))
  check('B 두 턴 모두 정착(result 2회)', results.length === 2, results.length)
}

console.log(failed ? `\n${failed} FAILED` : '\nall ok')
process.exit(failed ? 1 : 0)
