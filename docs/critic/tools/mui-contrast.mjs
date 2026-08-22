// 알림 체계 대비비 — ui-notify.md §7-5("접근성 미검토")를 수치로 닫는다.
// 토큰이 전부 알파라, 배경을 실제로 합성한 뒤에 재야 한다:
//   벽지/아크릴 → --chat-bg(또는 --panel) → --face(색조 면) → 글자색(알파)
// 아크릴 뒤 밝기는 실측 범위를 쓴다(docs/critic/mui-r1-px.json: 어두운 15 ~ 밝은 38,
// 폴백은 20 고정). 두 극단에서 재면 "이 앱에서 실제로 나오는 대비비"의 상·하한이 나온다.
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const over = (fg, a, bg) => fg.map((c, i) => c * a + bg[i] * (1 - a))
const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
const L = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])
const ratio = (a, b) => { const l1 = L(a), l2 = L(b); const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]; return (hi + 0.05) / (lo + 0.05) }
const r2 = (x) => Math.round(x * 100) / 100

const YELLOW = hex('#d9c063'), RED = hex('#dd7a6b'), GREEN = hex('#82c9a4'), W = [255, 255, 255]
const TOK = {
  'text (0.90)': [W, 0.9],
  'text-2 (0.62)': [W, 0.62],
  'text-3 (0.40)': [W, 0.4],
  'text-4 (0.26)': [W, 0.26],
  'yellow': [YELLOW, 1],
  'red': [RED, 1],
  'green': [GREEN, 1]
}
const FACES = {
  'notice (yellow-soft .12)': [YELLOW, 0.12],
  'danger (red-soft .13)': [RED, 0.13],
  'positive (green-soft .12)': [GREEN, 0.12],
  'neutral (surface .03)': [W, 0.03],
  'no face (rule/qa)': [W, 0]
}
// 아크릴 뒤 실측 밝기 3종 + 폴백
const BASES = {
  'dark wallpaper (15)': [15, 15, 15],
  'fallback opaque (20)': [20, 20, 20],
  'bright wallpaper (38)': [38, 38, 38]
}

const out = []
for (const [bn, base] of Object.entries(BASES)) {
  // 본문 면: --chat-bg rgba(16,16,16,.70)이 아크릴 위에 얹힌 결과
  const chat = bn === 'fallback opaque (20)' ? [20, 20, 20] : over([16, 16, 16], 0.7, base)
  for (const [fn, [fc, fa]] of Object.entries(FACES)) {
    const face = over(fc, fa, chat)
    for (const [tn, [tc, ta]] of Object.entries(TOK)) {
      const fg = over(tc, ta, face)
      out.push({ base: bn, face: fn, token: tn, cr: r2(ratio(fg, face)) })
    }
  }
}
// 관심 조합만 추린다 — 알림 체계가 실제로 쓰는 짝
const USED = [
  ['notice (yellow-soft .12)', 'text-2 (0.62)', 'band 본문'],
  ['notice (yellow-soft .12)', 'text (0.90)', 'band 강조(.b)'],
  ['notice (yellow-soft .12)', 'yellow', 'band 도착값(.kw)/글리프'],
  ['notice (yellow-soft .12)', 'text-3 (0.40)', 'band 시각(.tm)'],
  ['danger (red-soft .13)', 'text-2 (0.62)', '오류 본문'],
  ['danger (red-soft .13)', 'red', '오류 글리프'],
  ['danger (red-soft .13)', 'text-3 (0.40)', '오류 원문(.raw)'],
  ['no face (rule/qa)', 'red', 'rule 라벨(중단)'],
  ['no face (rule/qa)', 'text-3 (0.40)', 'rule 수치(.num) 11px'],
  ['no face (rule/qa)', 'text-4 (0.26)', 'rule 시각(.tm) 11px'],
  ['no face (rule/qa)', 'green', '문답 체크'],
  ['neutral (surface .03)', 'text-4 (0.26)', 'card 시각 11px']
]
const rows = []
for (const [face, token, what] of USED) {
  const r = {}
  for (const bn of Object.keys(BASES)) r[bn] = out.find((o) => o.base === bn && o.face === face && o.token === token).cr
  rows.push({ what, face, token, ...r })
}
const need = (what) => (/시각|수치|원문/.test(what) ? 4.5 : 4.5)
console.log('| 자리 | 면 | 글자 | 어두운(15) | 폴백(20) | 밝은(38) | WCAG AA(4.5) |')
console.log('|---|---|---|---|---|---|---|')
for (const r of rows) {
  const worst = Math.min(r['dark wallpaper (15)'], r['fallback opaque (20)'], r['bright wallpaper (38)'])
  console.log(`| ${r.what} | ${r.face} | ${r.token} | ${r['dark wallpaper (15)']} | ${r['fallback opaque (20)']} | ${r['bright wallpaper (38)']} | ${worst >= 4.5 ? 'PASS' : worst >= 3 ? '3:1만' : 'FAIL'} |`)
}
