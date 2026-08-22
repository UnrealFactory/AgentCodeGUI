// M-UI R1 크리틱 — 격리 인스턴스를 CDP로 조작/관측하는 최소 드라이버.
// (사용자 실앱에는 붙지 않는다 — 포트는 내가 띄운 인스턴스의 CCG_CDP_PORT뿐이다.)
//
//   node docs/critic/tools/mui-cdp.mjs <port> diag        유리 폴백 상태 + 토큰 실측
//   node docs/critic/tools/mui-cdp.mjs <port> dismiss     부팅 모달(패치노트 등) 닫기
//   node docs/critic/tools/mui-cdp.mjs <port> newwin      추가 채팅 창 열기
//   node docs/critic/tools/mui-cdp.mjs <port> eval "<js>"
import { connectMainPage } from '../../../bench/lib.mjs'

const port = Number(process.argv[2])
const cmd = process.argv[3] ?? 'diag'
const arg = process.argv[4] ?? ''

const DIAG = `(() => {
  const de = document.documentElement
  const cs = getComputedStyle(de)
  const bs = getComputedStyle(document.body)
  const g = window.__ccgGlass || null
  return JSON.stringify({
    htmlClass: de.className,
    hasFallbackStyle: !!document.getElementById('ccg-glass-fallback'),
    rootPanel: cs.getPropertyValue('--panel').trim(),
    rootChatBg: cs.getPropertyValue('--chat-bg').trim(),
    bodyPanel: bs.getPropertyValue('--panel').trim(),
    bodyBg: bs.backgroundColor,
    bodyBgImage: bs.backgroundImage.slice(0, 60),
    inlinePanel: de.style.getPropertyValue('--panel'),
    glass: g ? { state: g.state, events: g.events, appliedAt: g.appliedAt } : null,
    overlays: [...document.querySelectorAll('.modal, .modal-back, .update-modal, [class*=modal]')].map(e => e.className).slice(0, 8)
  })
})()`

const DISMISS = `(() => {
  const out = []
  // 패치노트/업데이트 모달 — 버튼 라벨로 찾는다(컴포넌트 이름에 의존하지 않게)
  const btns = [...document.querySelectorAll('button')]
  for (const b of btns) {
    const t = (b.textContent || '').trim()
    if (/^(시작하기|Get started|확인|닫기|Close)$/.test(t)) { b.click(); out.push('clicked:' + t); break }
  }
  document.body.click()
  return JSON.stringify({ done: out, remaining: [...document.querySelectorAll('[class*=modal]')].map(e => e.className).slice(0, 6) })
})()`

const cdp = await connectMainPage(port, { timeoutMs: 20000 })
try {
  if (cmd === 'diag') console.log(await cdp.eval(DIAG))
  else if (cmd === 'dismiss') {
    console.log(await cdp.eval(DISMISS))
    await new Promise((r) => setTimeout(r, 700))
    console.log(await cdp.eval(DIAG))
  } else if (cmd === 'newwin') {
    console.log(await cdp.eval(`(async () => { await window.api.openSessionWindow(); return 'ok' })()`, { awaitPromise: true }))
  } else if (cmd === 'eval') console.log(JSON.stringify(await cdp.eval(arg)))
} finally {
  cdp.close()
}
