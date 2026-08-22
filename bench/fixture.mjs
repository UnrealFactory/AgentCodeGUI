// 벤치 홈 픽스처 생성기 — 긴 스레드(480항목) 채팅 + 조용한 부팅 환경.
// 정찰 실측(2.6.2 sanitizeSnapshot) 기준: 살아남는 필드만 넣고, session:null(리셋 사고
// 차단), 모든 msg animate:false, 마지막 항목은 worked(liveMsg 오인 방지), cap 500 미만.
// 사용: node bench/fixture.mjs <homeDir> <appVersion>   (예: .bench-home 2.6.2)
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

export const FIX_ID = 'fix-long-thread'

export function makeFixtureHome(homeDir, appVersion) {
  fs.mkdirSync(path.join(homeDir, 'chats'), { recursive: true })

  fs.writeFileSync(path.join(homeDir, 'profile.json'), JSON.stringify({ nickname: 'Bench', color: '#0EA5E9' }))
  fs.writeFileSync(path.join(homeDir, 'engine-auto-update.json'), JSON.stringify({ enabled: false }))
  // 패치노트 오버레이 차단(seenVersion=현재 앱 버전) + 단일 채팅 화면 + 줌 1 고정
  fs.writeFileSync(
    path.join(homeDir, 'ui-prefs.json'),
    JSON.stringify({
      'workspace.mode': 'single',
      'explorer.swap': false,
      'chat.zoom': 1,
      'sidebar.autohide': false,
      'whatsnew.seenVersion': appVersion,
      'ui.lang': 'ko'
    })
  )

  // 엔진: 실홈의 engines를 정션으로 공유(읽기 전용 사용 — 벤치에서 설치/정리 금지)
  const engines = path.join(homeDir, 'engines')
  const realEngines = path.join(os.homedir(), '.agentcodegui', 'engines')
  if (!fs.existsSync(engines) && fs.existsSync(realEngines)) {
    try {
      execFileSync('cmd', ['/c', 'mklink', '/J', engines, realEngines], { stdio: 'ignore' })
    } catch { /* 정션 실패 시 엔진 없는 홈 — 게이트 카드가 뜰 수 있음 */ }
  }
  const realCfg = path.join(os.homedir(), '.agentcodegui', 'config.json')
  if (fs.existsSync(realCfg)) fs.copyFileSync(realCfg, path.join(homeDir, 'config.json'))

  // 계정: accounts.json은 홈에 있지만 그 안의 토큰은 Chromium OSCrypt(userData의
  // 'Local State'에 DPAPI로 감싼 AES 키)로 암호화돼 있다. 격리 userData엔 그 키가 없어
  // "복호화하지 못했어요"로 실행이 죽으므로, 설치본 userData의 Local State를 벤치
  // userData로 미리 넣어 같은 키를 쓰게 한다(같은 Windows 사용자라 DPAPI 해제 가능).
  // ※ 이 사실은 3.0(M5)의 제약이기도 하다 — Rust 쪽도 같은 스킴을 풀어야 기존 계정이 산다.
  const realLocalState = path.join(os.homedir(), 'AppData', 'Roaming', 'agent-code-gui', 'Local State')
  if (fs.existsSync(realLocalState)) {
    const ud = path.join(homeDir, 'userData')
    fs.mkdirSync(ud, { recursive: true })
    fs.copyFileSync(realLocalState, path.join(ud, 'Local State'))
  }
  for (const f of ['accounts.json', 'codex-accounts.json', 'api-config.json']) {
    const src = path.join(os.homedir(), '.agentcodegui', f)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(homeDir, f))
  }

  // ── 긴 스레드 스냅샷 합성 ──────────────────────────────────────────────────
  const messages = []
  let seq = 0
  const time = '오후 3:00'
  const mdBlock = (i) =>
    `### 구간 ${i} 정리\n\n` +
    `이 구간에서는 **모듈 경계**와 캐시 무효화 규칙을 검토했다. 핵심은 다음과 같다.\n\n` +
    `- 항목 하나: \`invalidate(rev)\` 는 세대 비교로만 동작한다\n` +
    `- 항목 둘: 소비자는 [[registry]]를 폴링하지 않고 이벤트를 구독한다\n` +
    `- 항목 셋: 실패 경로는 재시도 없이 상위로 전파한다\n\n` +
    '```ts\n' +
    `export function step${i}(rev: number): Result {\n` +
    `  const snap = registry.at(rev)\n` +
    `  if (!snap) return { ok: false, reason: 'stale' }\n` +
    `  return { ok: true, value: snap.tokens.length }\n` +
    `}\n` +
    '```\n\n' +
    `측정값은 ${100 + i}ms로, 직전 구간보다 ${i % 7}ms 개선됐다.`

  for (let block = 0; messages.length < 470; block++) {
    messages.push({
      kind: 'msg', id: `u${++seq}`, role: 'user',
      text: `구간 ${block}의 캐시 무효화 규칙을 검토하고 개선점을 정리해줘.`,
      animate: false, time
    })
    messages.push({
      kind: 'msg', id: `a${++seq}`, role: 'assistant',
      text: mdBlock(block), animate: false, time
    })
    messages.push({
      kind: 'toolgroup', id: `tg${++seq}`, time,
      tools: [
        { id: `t${seq}-1`, verb: 'Read', kind: 'read', target: `src/mod${block}/cache.ts`, status: 'done', result: '412줄', durationMs: 12 },
        { id: `t${seq}-2`, verb: 'Bash', kind: 'bash', target: `npm test -- cache${block}`, status: 'done', result: '통과', output: `> vitest run cache${block}\n✓ invalidation (${block})\n✓ generation compare\n2 passed`, durationMs: 830 },
        { id: `t${seq}-3`, verb: 'Search', kind: 'search', target: `invalidate\\(rev`, status: 'done', result: `${3 + (block % 5)}건`, durationMs: 40 }
      ]
    })
    messages.push({
      kind: 'msg', id: `a${++seq}`, role: 'assistant',
      text: `구간 ${block} 결론: 세대 비교 경로는 유지하고, 소비자 쪽 폴링 두 곳을 이벤트 구독으로 바꾸면 프레임당 호출이 ${2 + (block % 4)}회 줄어든다. 다음 구간에서 이어서 본다.`,
      animate: false, time
    })
    if (block % 5 === 4) messages.push({ kind: 'notice', id: `n${++seq}`, text: `구간 ${block} 자동 저장 완료`, time })
  }
  messages.push({ kind: 'worked', id: `w${++seq}`, ms: 187000 })

  const chat = {
    id: FIX_ID,
    title: '벤치 긴 스레드',
    custom: true,
    manualCwd: 'C:\\Code\\AgentCodeGUI',
    picker: { model: 'haiku', effort: 'minimal', mode: 'bypass' },
    updatedAt: Date.now(),
    snapshot: {
      status: 'done',
      messages,
      todos: [], files: [], diffs: {}, subagents: [], bgTasks: [],
      session: null,
      result: { costUsd: 0, durationMs: 1000, numTurns: 1, contextTokens: 120000, contextWindow: 1000000 },
      spentUsd: 0, tokenTotals: {}, seq: seq + 1, shownNotices: []
    }
  }
  fs.writeFileSync(path.join(homeDir, 'chats', `${FIX_ID}.json`), JSON.stringify(chat))
  fs.writeFileSync(
    path.join(homeDir, 'chats', 'index.json'),
    JSON.stringify({ version: 1, order: [FIX_ID], activeChatId: FIX_ID })
  )
  return { items: messages.length }
}

/**
 * 멀티채팅 픽스처 — N개 패널이 각자 스레드를 가진 세션 1개.
 * 사용자 지적: "여러 개 켰을 때가 항상 문제" → 이게 성능의 주 무대다.
 * ui-prefs의 workspace.mode를 multi로 돌려 부팅 즉시 멀티 그리드가 뜨게 한다.
 */
export const MA_SESSION_ID = 'fix-multi-session'
export function makeMultiFixture(homeDir, appVersion, { panels = 4, itemsPerPanel = 120 } = {}) {
  makeFixtureHome(homeDir, appVersion)
  const dir = path.join(homeDir, 'multi-agent')
  fs.mkdirSync(dir, { recursive: true })

  // 멀티 그리드로 부팅 (단일 픽스처가 써둔 ui-prefs를 갈아끼운다)
  const prefsPath = path.join(homeDir, 'ui-prefs.json')
  const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'))
  prefs['workspace.mode'] = 'multi'
  fs.writeFileSync(prefsPath, JSON.stringify(prefs))

  const time = '오후 3:00'
  const panelList = []
  for (let p = 0; p < 6; p++) {
    const live = p < panels
    const messages = []
    let seq = 0
    for (let i = 0; live && messages.length < itemsPerPanel; i++) {
      messages.push({ kind: 'msg', id: `p${p}u${++seq}`, role: 'user', text: `패널 ${p} 구간 ${i}: 이 모듈의 캐시 무효화를 점검해줘.`, animate: false, time })
      messages.push({
        kind: 'msg', id: `p${p}a${++seq}`, role: 'assistant', animate: false, time,
        text: `### 패널 ${p} · 구간 ${i}\n\n검토 결과 **세대 비교** 경로는 정상이다.\n\n- 소비자 폴링 ${i % 3}곳을 이벤트 구독으로 전환 가능\n- 실패 경로는 상위 전파 유지\n\n\`\`\`ts\nexport function step${i}(rev: number) {\n  const snap = registry.at(rev)\n  return snap ? snap.tokens.length : -1\n}\n\`\`\`\n\n소요 ${100 + i}ms.`
      })
      messages.push({
        kind: 'toolgroup', id: `p${p}tg${++seq}`, time,
        tools: [
          { id: `p${p}t${seq}a`, verb: 'Read', kind: 'read', target: `src/mod${i}/cache.ts`, status: 'done', result: '412줄', durationMs: 11 },
          { id: `p${p}t${seq}b`, verb: 'Bash', kind: 'bash', target: `npm test -- m${i}`, status: 'done', result: '통과', durationMs: 640 }
        ]
      })
    }
    if (live) messages.push({ kind: 'worked', id: `p${p}w${++seq}`, ms: 92000 })
    panelList.push({
      title: live ? `벤치 패널 ${p + 1}` : '',
      custom: live,
      locked: false,
      color: '',
      cwd: 'C:\\Code\\AgentCodeGUI',
      refDirs: [],
      picker: { model: 'haiku', effort: 'minimal', mode: 'bypass' },
      api: false,
      snapshot: live
        ? {
            status: 'done', messages, todos: [], files: [], diffs: {}, subagents: [], bgTasks: [],
            session: null,
            result: { costUsd: 0, durationMs: 1000, numTurns: 1, contextTokens: 90000, contextWindow: 1000000 },
            spentUsd: 0, tokenTotals: {}, seq: seq + 1, shownNotices: []
          }
        : null
    })
  }

  const session = {
    id: MA_SESSION_ID,
    title: '벤치 멀티',
    custom: true,
    count: panels,
    panelOrder: [0, 1, 2, 3, 4, 5],
    panels: panelList,
    updatedAt: Date.now()
  }
  fs.writeFileSync(path.join(dir, `${MA_SESSION_ID}.json`), JSON.stringify(session))
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({ version: 2, activeSessionId: MA_SESSION_ID, order: [MA_SESSION_ID] })
  )
  return { panels, itemsPerPanel, totalItems: panels * itemsPerPanel }
}

if (process.argv[1] && process.argv[1].endsWith('fixture.mjs') && process.argv[2]) {
  const home = path.resolve(process.argv[2])
  const ver = process.argv[3] ?? '2.6.2'
  const r = makeFixtureHome(home, ver)
  console.log(`fixture home ready: ${home} (thread items: ${r.items}, seenVersion: ${ver})`)
}
