// ── 블라인드 비교 준비기 ────────────────────────────────────────────────────────
//
//   node bench/blind.mjs            (기본: electron vs tauri)
//   node bench/blind.mjs --seed=7   좌우 배치 재현용 시드
//
// 두 앱의 bench/shots/<app>/*.png를 화면 id로 짝지어, 좌/우를 **무작위로 섞고**
// 라벨을 A/B로 가린 나란히 비교 페이지(bench/shots/blind.html)를 만든다.
//
// [블라인드 유지 규약]
//  - 비교 페이지는 앱 이름을 어디에도 담지 않는다. 이미지도 원본 경로를 그대로 쓰면
//    src="electron/…"이 정답을 흘리므로, blind/ 폴더로 <id>-A.png / <id>-B.png 로 복사한다.
//  - 정답 키는 bench/shots/blind-key.json에만 있고 페이지에서 접근할 수 없다.
//  - 판정은 페이지 안에서 localStorage에 모이고, '결과 내보내기'로 JSON을 받는다.
import fs from 'node:fs'
import path from 'node:path'
import { REPO } from './lib.mjs'
import { SCREENS } from './screens.mjs'

const argv = process.argv.slice(2)
const apps = (argv.find((a) => a.startsWith('--apps=')) ?? '--apps=electron,tauri').slice(7).split(',')
const seedArg = argv.find((a) => a.startsWith('--seed='))
const SEED = seedArg ? Number(seedArg.slice(7)) : Math.floor(Math.random() * 1e9)

const SHOTS = path.join(REPO, 'bench', 'shots')
const BLIND = path.join(SHOTS, 'blind')
const [APP1, APP2] = apps

// 재현 가능한 난수 (mulberry32) — 같은 시드면 같은 좌우 배치
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const meta = new Map(SCREENS.map((s) => [s.id, s]))
const have = (app, id) => fs.existsSync(path.join(SHOTS, app, `${id}.png`))

const reportOf = (app) => {
  const f = path.join(SHOTS, app, 'report.json')
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
}
const r1 = reportOf(APP1)
const r2 = reportOf(APP2)

// 짝: 두 앱 모두 png가 있는 화면만 나란히 비교할 수 있다
const ids = SCREENS.filter((s) => !s.internal && !s.skip).map((s) => s.id)
const paired = ids.filter((id) => have(APP1, id) && have(APP2, id))
const onlyIn1 = ids.filter((id) => have(APP1, id) && !have(APP2, id))
const onlyIn2 = ids.filter((id) => !have(APP1, id) && have(APP2, id))

fs.rmSync(BLIND, { recursive: true, force: true })
fs.mkdirSync(BLIND, { recursive: true })

const rand = rng(SEED)
const key = { seed: SEED, apps: [APP1, APP2], at: new Date().toISOString(), map: {} }
const items = []
for (const id of paired) {
  const flip = rand() < 0.5
  const A = flip ? APP2 : APP1
  const B = flip ? APP1 : APP2
  fs.copyFileSync(path.join(SHOTS, A, `${id}.png`), path.join(BLIND, `${id}-A.png`))
  fs.copyFileSync(path.join(SHOTS, B, `${id}.png`), path.join(BLIND, `${id}-B.png`))
  key.map[id] = { A, B }
  const s = meta.get(id)
  items.push({ id, label: s?.label ?? id, area: s?.area ?? '', surface: s?.surface ?? '' })
}
fs.writeFileSync(path.join(SHOTS, 'blind-key.json'), JSON.stringify(key, null, 2))

// 절(area)별로 묶어 순서를 안정화 — 판정자가 맥락을 잃지 않게
items.sort((a, b) => (a.area === b.area ? a.id.localeCompare(b.id) : a.area.localeCompare(b.area)))

const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>블라인드 화면 비교</title>
<style>
  :root { color-scheme: dark; --bg:#0e1016; --card:#171a22; --line:#262a34; --tx:#e6e8ee; --dim:#8b93a5; --acc:#0EA5E9 }
  * { box-sizing: border-box }
  body { margin:0; background:var(--bg); color:var(--tx); font:14px/1.55 -apple-system,'Segoe UI',system-ui,sans-serif }
  header { position:sticky; top:0; z-index:10; background:rgba(14,16,22,.94); backdrop-filter:blur(8px);
           border-bottom:1px solid var(--line); padding:14px 22px; display:flex; gap:16px; align-items:center }
  h1 { font-size:16px; margin:0; font-weight:650; letter-spacing:-.01em }
  .sub { color:var(--dim); font-size:12px }
  .grow { flex:1 }
  button { background:var(--card); color:var(--tx); border:1px solid var(--line); border-radius:8px;
           padding:7px 14px; font:inherit; font-size:13px; cursor:pointer }
  button.pri { background:var(--acc); border-color:var(--acc); color:#04121a; font-weight:600 }
  button:hover { border-color:#3a4150 }
  main { padding:22px; max-width:1780px; margin:0 auto }
  .row { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin-bottom:20px }
  .rh { display:flex; align-items:baseline; gap:10px; margin-bottom:12px }
  .rh .nm { font-weight:600 }
  .rh .id { color:var(--dim); font-size:12px; font-family:ui-monospace,Consolas,monospace }
  .rh .ar { color:var(--dim); font-size:12px; margin-left:auto }
  .pair { display:grid; grid-template-columns:1fr 1fr; gap:14px }
  figure { margin:0 }
  figcaption { font-size:12px; color:var(--dim); margin-bottom:6px; display:flex; gap:8px; align-items:center }
  .tag { display:inline-flex; width:20px; height:20px; align-items:center; justify-content:center;
         border-radius:6px; background:#232833; color:var(--tx); font-weight:700; font-size:12px }
  img { width:100%; display:block; border:1px solid var(--line); border-radius:10px; background:#0b0d12; cursor:zoom-in }
  .vote { display:flex; gap:14px; align-items:center; margin-top:12px; flex-wrap:wrap }
  label.opt { display:inline-flex; gap:6px; align-items:center; cursor:pointer; padding:5px 11px;
              border:1px solid var(--line); border-radius:999px; font-size:13px }
  label.opt:has(input:checked) { border-color:var(--acc); background:rgba(14,165,233,.13) }
  input[type=text] { flex:1; min-width:260px; background:#0f1219; color:var(--tx); border:1px solid var(--line);
                     border-radius:8px; padding:7px 11px; font:inherit; font-size:13px }
  .done { outline:1px solid rgba(14,165,233,.35) }
  #lb { position:fixed; inset:0; background:rgba(6,8,12,.93); display:none; z-index:50; padding:24px; overflow:auto }
  #lb.on { display:block }
  #lb img { max-width:100%; width:auto; margin:0 auto; cursor:zoom-out }
  .note { color:var(--dim); font-size:12px; margin:0 0 16px }
</style></head>
<body>
<header>
  <h1>블라인드 화면 비교</h1>
  <span class="sub" id="prog">0 / ${items.length}</span>
  <span class="grow"></span>
  <button onclick="clearAll()">판정 초기화</button>
  <button class="pri" onclick="exportJson()">결과 내보내기</button>
</header>
<main>
  <p class="note">두 이미지는 같은 화면을 서로 다른 빌드에서 찍은 것이다. 어느 쪽이 어느 빌드인지는 가려져 있다.
     각 화면마다 <b>더 나은 쪽</b>을 고르고, 이유를 한 줄로 남겨라. 이미지를 클릭하면 원본 크기로 열린다.</p>
  ${items.map((it) => `
  <section class="row" id="row-${it.id}">
    <div class="rh"><span class="nm">${esc(it.label)}</span><span class="id">${esc(it.id)}</span><span class="ar">${esc(it.area)} · ${esc(it.surface)}</span></div>
    <div class="pair">
      <figure><figcaption><span class="tag">A</span> 왼쪽</figcaption><img loading="lazy" src="blind/${it.id}-A.png" alt="A"></figure>
      <figure><figcaption><span class="tag">B</span> 오른쪽</figcaption><img loading="lazy" src="blind/${it.id}-B.png" alt="B"></figure>
    </div>
    <div class="vote">
      <label class="opt"><input type="radio" name="v-${it.id}" value="A">A가 낫다</label>
      <label class="opt"><input type="radio" name="v-${it.id}" value="B">B가 낫다</label>
      <label class="opt"><input type="radio" name="v-${it.id}" value="tie">동등</label>
      <input type="text" id="n-${it.id}" placeholder="메모 — 무엇이 더 나은가 / 무엇이 빠졌나">
    </div>
  </section>`).join('')}
</main>
<div id="lb" onclick="this.classList.remove('on')"><img id="lbi" alt=""></div>
<script>
const IDS = ${JSON.stringify(items.map((i) => i.id))}
const KEY = 'ccg.blind.votes'
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} } }
let votes = load()
function save() { localStorage.setItem(KEY, JSON.stringify(votes)); paint() }
function paint() {
  let n = 0
  for (const id of IDS) {
    const v = votes[id]
    const row = document.getElementById('row-' + id)
    if (v && v.pick) { n++; row.classList.add('done') } else { row.classList.remove('done') }
  }
  document.getElementById('prog').textContent = n + ' / ' + IDS.length
}
for (const id of IDS) {
  for (const el of document.querySelectorAll('input[name="v-' + id + '"]')) {
    el.addEventListener('change', () => { votes[id] = { ...(votes[id] || {}), pick: el.value }; save() })
  }
  const note = document.getElementById('n-' + id)
  note.addEventListener('input', () => { votes[id] = { ...(votes[id] || {}), note: note.value }; save() })
  const v = votes[id]
  if (v) {
    if (v.pick) { const r = document.querySelector('input[name="v-' + id + '"][value="' + v.pick + '"]'); if (r) r.checked = true }
    if (v.note) note.value = v.note
  }
}
for (const img of document.querySelectorAll('.pair img')) {
  img.addEventListener('click', () => { document.getElementById('lbi').src = img.src; document.getElementById('lb').classList.add('on') })
}
function clearAll() { if (!confirm('판정을 모두 지울까요?')) return; votes = {}; localStorage.removeItem(KEY)
  for (const el of document.querySelectorAll('input[type=radio]')) el.checked = false
  for (const el of document.querySelectorAll('input[type=text]')) el.value = ''
  paint() }
function exportJson() {
  const out = { at: new Date().toISOString(), total: IDS.length, votes: {} }
  for (const id of IDS) out.votes[id] = votes[id] || { pick: null, note: '' }
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = 'blind-votes.json'; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}
paint()
</script>
</body></html>
`

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) }

fs.writeFileSync(path.join(SHOTS, 'blind.html'), html)

console.log(`blind: ${paired.length}쌍 (seed ${SEED})`)
if (onlyIn1.length) console.log(`  ${APP1}에만 있음 (${onlyIn1.length}): ${onlyIn1.slice(0, 12).join(', ')}${onlyIn1.length > 12 ? ' …' : ''}`)
if (onlyIn2.length) console.log(`  ${APP2}에만 있음 (${onlyIn2.length}): ${onlyIn2.slice(0, 12).join(', ')}${onlyIn2.length > 12 ? ' …' : ''}`)
if (r1 && r2) console.log(`  성공률: ${APP1} ${r1.summary?.successRatePct}% · ${APP2} ${r2.summary?.successRatePct}%`)
console.log(`  페이지: bench/shots/blind.html   정답 키: bench/shots/blind-key.json (페이지에서 접근 불가)`)
