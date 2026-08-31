#!/usr/bin/env node
// critic-hosti18n-cdp — **실제 화면**에서 Verse 사유가 무슨 언어로 그려지는가.
//
// 왜 필요한가: 셸 응답만 재면 `r.error ?? t(…)`의 **순서**를 못 본다. 렌더러가 셸 문자열을
// 이기면(폴백이 앞서면) 셸을 고쳐도 화면은 그대로다. 그래서 화면의 텍스트 노드를 읽는다.
//
// 경로: 셸 `{"error": verse_out_of_scope()}` → 심 `callPathOrNull`이 `ShimUnavailableError`로
// 올리며 `detail`에 그 문자열을 싣는다 → `Settings.tsx doVersePick`의 catch가
// `(e).detail ?? t('요청이 실패했어요…','The request failed…')`로 카드 `error`를 세운다.
//
// 사용: node critic-hosti18n-cdp.mjs <cdp포트> [--json <경로>]
const port = process.argv[2] || '11020'
const jsonAt = process.argv.indexOf('--json')

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) {
  console.error('page 타깃이 없다')
  process.exit(2)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text }
  return { value: r.result?.result?.value }
}

await send('Runtime.enable')
const steps = []
const step = (name, v) => {
  steps.push({ name, value: v })
  console.log(`— ${name}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
}

// 0) 렌더러가 정말 en인가(화면 언어의 독립 확인)
step('renderer ui.lang', (await evalJs(`(await window.api.prefs.load()).ui?.['ui.lang'] ?? '(none)'`)).value ?? '(읽기 실패)')

// 1) 셸이 그 채널에 무엇으로 답하는가(심을 거치기 전 원본)
step(
  'shell raw invoke',
  (await evalJs(`JSON.stringify(await window.__TAURI_INTERNALS__.invoke('ipc', { channel: 'lsp:pick-verse-server', args: [] }).catch(e => String(e)))`)).value
)

// 2) **심을 거친** 값 — 컴포넌트가 catch에서 보는 바로 그 e.detail
step(
  'shim e.detail (컴포넌트가 보는 값)',
  (await evalJs(`await window.api.lsp.pickVerseServer().then(v => 'RESOLVED:' + v).catch(e => e && e.detail ? e.detail : 'NO-DETAIL:' + String(e))`)).value
)

// 3) 컴포넌트 표현식 그대로 — `detail ?? t(폴백)`이 무엇을 고르는가
step(
  '컴포넌트 표현식 결과',
  (
    await evalJs(
      `await window.api.lsp.pickVerseServer().then(()=>'(취소로 읽힘)').catch(e => (e && e.detail) ?? 'FALLBACK-WON')`
    )
  ).value
)

const out = { at: new Date().toISOString(), port, steps }
if (jsonAt > 0 && process.argv[jsonAt + 1]) {
  const fs = await import('node:fs')
  fs.writeFileSync(process.argv[jsonAt + 1], JSON.stringify(out, null, 2))
  console.log(`증거: ${process.argv[jsonAt + 1]}`)
}
ws.close()
