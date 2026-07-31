/**
 * PoC — 워크플로 상주 실측 하네스 (설계 착수 전 검증 전용, 앱 코드와 무관하게 단독 실행)
 *
 * 검증 3항목:
 *  ① keep-alive: 문자열 프롬프트 대신 스트리밍 입력(AsyncIterable)을 열어두면
 *     첫 턴 result 이후에도 CLI가 살아서 백그라운드 워크플로가 계속 도는가
 *  ② 재기동: 워크플로 완료(task_notification) 뒤 모델이 스스로 깨어나
 *     정리 턴(assistant + result)을 내는가 — 어떤 프레임 순서로 오는가
 *  ③ 주입: 워크플로가 도는 중에 두 번째 사용자 메시지를 같은 스트림에 넣으면
 *     정상 턴으로 처리되는가
 *
 * 실행: node scripts/poc-workflow-keepalive.mjs
 * 로그: 임시 폴더에 frames.jsonl(전체 프레임 원문) — 경로는 시작 시 출력.
 * 인증: 전역 ~/.claude 구독 로그인(터미널 CLI와 동일 경로). 읽기/리프레시만 발생.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

// 이 하네스는 구독 로그인으로 돌아야 실측이 앱과 같다 — env API 키 하이재킹 차단
delete process.env.ANTHROPIC_API_KEY
// 중첩 Claude Code 세션 표식 제거 (하네스를 Claude Code 안에서 띄워도 오염 없게)
delete process.env.CLAUDECODE
delete process.env.CLAUDE_CODE_ENTRYPOINT

// ── 활성 엔진의 SDK 로드 (engine/versions.ts와 같은 규칙, 단독 실행용 축약) ──
const APP_HOME = path.join(os.homedir(), '.agentcodegui')
const active = JSON.parse(fs.readFileSync(path.join(APP_HOME, 'config.json'), 'utf8')).activeVersion
const sdkDir = path.join(APP_HOME, 'engines', active, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
const { query } = await import(pathToFileURL(path.join(sdkDir, 'sdk.mjs')).href)
console.log(`[poc] SDK ${active} @ ${sdkDir}`)

// ── 작업 폴더·로그 ──
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-wf-poc-'))
const logPath = path.join(workDir, 'frames.jsonl')
const log = fs.createWriteStream(logPath)
const t0 = Date.now()
const sec = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6)
function note(tag, extra = '') {
  console.log(`[${sec()}s] ${tag}${extra ? ' ' + extra : ''}`)
}
function record(kind, obj) {
  log.write(JSON.stringify({ t: Date.now() - t0, kind, obj }) + '\n')
}
console.log(`[poc] cwd=${workDir}`)
console.log(`[poc] log=${logPath}`)

// ── 스트리밍 입력 — 밀어넣기 큐 (닫기 전까지 스트림이 열려 있는 게 실험의 핵심) ──
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
let sends = 0
function send(text) {
  sends++
  note(`>> user#${sends}`, JSON.stringify(text.slice(0, 60)))
  record('send', { text })
  inbox.push({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: ''
  })
  wake?.()
}
function closeStream(why) {
  if (closed) return
  closed = true
  note('== close stream', why)
  record('close', { why })
  wake?.()
}

// ── 실험 상태 ──
let results = 0 // result 프레임 수
let turn1At = 0 // 첫 result 시각 (ms)
let injectedAt = 0 // 두 번째 메시지 보낸 시각
let wfTaskId = '' // 워크플로 task_id (task_started/bg 목록에서 포착)
let wfSettledAt = 0 // 워크플로 완료 통지 시각
let postSettleText = 0 // 완료 통지 이후 도착한 assistant 텍스트 수 (② 재기동 증거)
let assistantTexts = 0

const abort = new AbortController()
// 하드 워치독 — 9분 안에 안 끝나면 정리하고 결과만 보고
const watchdog = setTimeout(() => {
  note('!! watchdog', '9분 초과 — 스트림 닫고 30초 뒤 abort')
  closeStream('watchdog')
  setTimeout(() => abort.abort(), 30_000)
}, 9 * 60_000)

const q = query({
  prompt: stream(),
  options: {
    cwd: workDir,
    model: 'sonnet',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: [], // 사용자 전역 설정·훅과 격리된 맨몸 실행
    includePartialMessages: false, // 프레임 종류만 보면 됨 — 델타 소음 제거
    abortController: abort,
    stderr: (d) => {
      const s = String(d).trim()
      if (s) record('stderr', { s })
    }
  }
})

// 첫 턴이 끝나면: (③) 15초 뒤 워크플로 도는 중에 메시지 주입
function afterTurn1() {
  setTimeout(() => {
    if (closed) return
    injectedAt = Date.now()
    send('워크플로 아직 도는 중이야? 지금 상태를 한 문장으로만 알려줘.')
  }, 15_000)
}

// 종료 판정 — ①②③ 증거가 다 모였으면 5초 여유 두고 닫는다
function maybeFinish() {
  if (closed) return
  const inj = injectedAt ? results >= 3 : results >= 2 // 주입 전이면 결과 2개로도 충분
  if (turn1At && wfSettledAt && postSettleText > 0 && inj) {
    setTimeout(() => closeStream('증거 수집 완료'), 5_000)
  }
}

try {
  send(
    'Workflow 도구를 사용해서 작은 테스트 워크플로를 하나 실행해줘. ' +
      '내용: 에이전트 2개가 병렬로, 각각 Bash로 `sleep 45`를 실행한 뒤 각각 1+1과 2+2를 계산해 숫자만 반환. ' +
      '(sleep은 일부러 넣는 거야 — 오래 걸리는 워크플로를 흉내내는 중.) ' +
      '워크플로를 백그라운드로 시작했으면 시작했다고 한 문장으로 답하고 턴을 끝내. ' +
      '결과가 나오면 두 답을 합쳐서 알려줘.'
  )

  for await (const msg of q) {
    record('msg', msg)
    const sub = msg.subtype ? `/${msg.subtype}` : ''

    if (msg.type === 'system' && msg.subtype === 'init') {
      note('<< system/init', `session=${msg.session_id}`)
      continue
    }
    if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
      const tasks = (msg.tasks ?? []).map((t) => `${t.task_type}:${t.task_id}`)
      note('<< bg_tasks_changed', `[${tasks.join(', ')}]`)
      // 워크플로 task_id 포착 — task_type 실측이 UI 배선(칩 필터)에 필요
      for (const t of msg.tasks ?? []) {
        if (!/bash|shell/i.test(t.task_type ?? '')) wfTaskId = t.task_id
      }
      continue
    }
    if (msg.type === 'system' && msg.subtype === 'task_started') {
      note('<< task_started', `task=${msg.task_id} tool_use=${msg.tool_use_id}`)
      continue
    }
    if (msg.type === 'system' && msg.subtype === 'task_notification') {
      note('<< task_notification', `task=${msg.task_id} status=${msg.status} summary=${JSON.stringify((msg.summary ?? '').slice(0, 80))}`)
      if (!wfTaskId || msg.task_id === wfTaskId) wfSettledAt = Date.now()
      maybeFinish()
      continue
    }
    if (msg.type === 'system') {
      note(`<< system${sub}`)
      continue
    }
    if (msg.type === 'assistant') {
      for (const b of msg.message?.content ?? []) {
        if (b.type === 'text' && b.text?.trim()) {
          assistantTexts++
          if (wfSettledAt) postSettleText++
          note('<< assistant.text', JSON.stringify(b.text.slice(0, 100)))
        } else if (b.type === 'tool_use') {
          note('<< assistant.tool_use', `${b.name}`)
        }
      }
      maybeFinish()
      continue
    }
    if (msg.type === 'user') {
      // tool_result 반향 — 워크플로 접수증 텍스트가 여기 실린다
      for (const b of msg.message?.content ?? []) {
        if (b.type === 'tool_result') {
          const txt = Array.isArray(b.content)
            ? b.content.map((c) => c.text ?? '').join(' ')
            : String(b.content ?? '')
          note('<< tool_result', JSON.stringify(txt.slice(0, 100)))
        }
      }
      continue
    }
    if (msg.type === 'result') {
      results++
      if (results === 1) {
        turn1At = Date.now()
        note('<< RESULT#1 — 턴1 종료. 스트림은 계속 열어둠', `is_error=${msg.is_error}`)
        afterTurn1()
      } else {
        note(`<< RESULT#${results}`, `is_error=${msg.is_error}`)
      }
      maybeFinish()
      continue
    }
    note(`<< ${msg.type}${sub}`)
  }
  note('== stream ended (for-await 종료)')
} catch (e) {
  note('!! error', String(e?.message ?? e))
  record('error', { message: String(e?.message ?? e) })
} finally {
  clearTimeout(watchdog)
  const verdict = {
    turn1: turn1At > 0,
    // ①: 턴1 result 이후에도 살아서 워크플로가 정착했는가
    keepAlive: turn1At > 0 && wfSettledAt > turn1At,
    // ②: 완료 통지 뒤 모델 재기동(추가 텍스트)이 왔는가
    reinvoke: postSettleText > 0,
    // ③: 도중 주입한 메시지가 응답을 받았는가 (주입 시각 이후 result 증가로 판별은 로그로)
    injected: injectedAt > 0,
    results,
    assistantTexts,
    wfTaskId,
    elapsedSec: +((Date.now() - t0) / 1000).toFixed(1)
  }
  console.log('\n[poc] ══ 판정 ══')
  console.log(JSON.stringify(verdict, null, 2))
  record('verdict', verdict)
  log.end()
  console.log(`[poc] 전체 프레임: ${logPath}`)
}
