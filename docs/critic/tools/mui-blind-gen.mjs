// 블라인드 배치 비교지 생성 — 목업 8장에서 A/B 판(.pane)만 뽑아 **라벨을 지우고**
// 행마다 좌/우를 무작위로 뒤집어 한 페이지에 늘어놓는다. 정답은 별도 JSON에만 쓴다.
// (bench/blind.mjs의 방식 차용: 보는 사람이 어느 쪽이 신안인지 모르게 하고 항목별로 고른다.)
//
//   node docs/critic/tools/mui-blind-gen.mjs
//     → docs/critic/tools/mui-r1-blind.html   (판정지)
//       docs/critic/mui-r1-blind-key.json     (정답 키 + 자가 계측 높이)
import fs from 'node:fs'
import path from 'node:path'

const REPO = 'C:/Code/AgentCodeGUI'
const MOCK = path.join(REPO, 'docs/design/mockups')
const SHEETS = [
  ['0-system', '7종이 한 스레드에'],
  ['1-fallback', '모델 자동 전환'],
  ['2-notice', '안내 3건'],
  ['3-error', '오류 2건'],
  ['4-interrupt', '중단선'],
  ['5-compact', '압축 경계'],
  ['6-command', '명령 카드'],
  ['7-qa', '문답 흔적']
]

/** `<div class="pane" data-k="X">` … 매칭되는 닫는 태그까지 잘라 낸다(중첩 div 계수). */
function cutPane(html, k) {
  const open = new RegExp(`<div class="pane" data-k="${k}">`)
  const m = open.exec(html)
  if (!m) return null
  let i = m.index + m[0].length
  let depth = 1
  const tag = /<\/?div\b[^>]*>/g
  tag.lastIndex = i
  let t
  while ((t = tag.exec(html))) {
    if (t[0].startsWith('</')) depth--
    else depth++
    if (depth === 0) return html.slice(m.index, t.index + t[0].length)
  }
  return null
}
/** 판 머리(A/B 라벨 줄)를 지운다 — 블라인드의 핵심. */
function stripHead(pane) {
  return pane.replace(/<div class="ph">[\s\S]*?<\/div>\s*(?=<div class="thread")/, '')
}

const rnd = () => Math.random() < 0.5
const rows = []
const key = []
for (const [id, title] of SHEETS) {
  const file = path.join(MOCK, `ui-notify-${id}.html`)
  const html = fs.readFileSync(file, 'utf8')
  const a = stripHead(cutPane(html, 'A'))
  const b = stripHead(cutPane(html, 'B'))
  if (!a || !b) {
    console.error('pane 추출 실패:', id)
    continue
  }
  const flip = rnd()
  const left = flip ? b : a
  const right = flip ? a : b
  key.push({ sheet: id, title, left: flip ? 'B(3.0 제안)' : 'A(2.6.2 현행)', right: flip ? 'A(2.6.2 현행)' : 'B(3.0 제안)' })
  rows.push(`
<section class="row">
  <h2><span class="n">${id.split('-')[0]}</span> ${title}</h2>
  <div class="ab">
    <div class="side"><div class="lbl">좌</div>${left}</div>
    <div class="side"><div class="lbl">우</div>${right}</div>
  </div>
</section>`)
}

const page = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8" />
<title>M-UI R1 — 알림 블라인드 배치 비교</title>
<link rel="stylesheet" href="../../design/mockups/ui-notify.css" />
<style>
  body{padding:18px 22px;}
  .top{max-width:1580px;margin:0 auto 16px;}
  .top h1{font-size:15px;font-weight:700;color:var(--text);margin-bottom:6px;}
  .top p{font-size:11.5px;color:var(--text-3);line-height:1.7;max-width:1100px;}
  .row{max-width:1580px;margin:0 auto 26px;}
  .row h2{font-size:12px;font-weight:600;color:var(--text-2);margin:0 0 8px;display:flex;align-items:center;gap:8px;}
  .row h2 .n{font-family:var(--font-mono);font-size:10px;color:var(--text-4);border:1px solid var(--line);border-radius:5px;padding:1px 6px;}
  .side{position:relative;}
  .lbl{position:absolute;top:-1px;left:-1px;z-index:5;font-family:var(--font-mono);font-size:10px;
       color:var(--text-3);background:rgba(0,0,0,.55);border:1px solid var(--line);border-radius:0 0 6px 0;padding:2px 7px;}
  /* 자가 계측 태그는 블라인드에서 답을 알려 준다 — 가린다 */
  .h-tag{display:none !important;}
</style></head>
<body>
<div class="top">
  <h1>알림 7종 — 블라인드 배치 비교 (좌 / 우)</h1>
  <p>같은 사건을 두 문법으로 그린 판을 나란히 놓았다. <b>어느 쪽이 현행이고 어느 쪽이 제안인지 표시하지 않았고,
  행마다 좌우를 무작위로 뒤집었다.</b> 판정 기준: ① 같은 정보가 다 있나 ② 눈이 먼저 무엇에 닿나
  ③ 스레드를 끊는가 잇는가 ④ 여백이 정보를 밀어냈나. 정답 키는 <code>docs/critic/mui-r1-blind-key.json</code>.</p>
</div>
${rows.join('\n')}
</body></html>`

fs.writeFileSync(path.join(REPO, 'docs/critic/tools/mui-r1-blind.html'), page, 'utf8')
fs.writeFileSync(path.join(REPO, 'docs/critic/mui-r1-blind-key.json'), JSON.stringify({ generatedAt: new Date().toISOString(), key }, null, 1), 'utf8')
console.log('blind page + key written', key.map((k) => k.sheet + ':' + k.left[0]).join(' '))
