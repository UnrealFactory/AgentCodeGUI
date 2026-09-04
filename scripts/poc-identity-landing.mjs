// ★2026-09-04 — `app/src/lib/identityLanding.ts` 규칙 검증(esbuild로 묶어 진짜 함수를 부른다).
// 보고: 한도 자동 전환 뒤 자리 칩이 옛 계정을 말하고 「lmg56631 사용 중 · 2곳」이 유령처럼 보였다.
//   node scripts/poc-identity-landing.mjs
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const r = await build({
  entryPoints: ['app/src/lib/identityLanding.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node'
})
const dir = join(process.cwd(), 'node_modules', '.cache', 'poc-identity-landing')
mkdirSync(dir, { recursive: true })
const out = join(dir, 'identityLanding.mjs')
writeFileSync(out, r.outputFiles[0].text)
const m = await import(pathToFileURL(out).href)

let fails = 0
const check = (label, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  ← ${JSON.stringify(got)}`}`)
  if (!ok) fails++
}
const sub = (account, origin = 'auto_account_switch', extra = {}) => ({
  chatId: 'c',
  origin,
  revision: 3,
  identity: { engine: { kind: 'claude', model: 'fable' }, billing: { kind: 'subscription', account }, ...extra }
})
const bound = { model: 'fable', effort: 'xhigh', mode: 'bypass', account: 'lmg56630@gmail.com' }

// ── 보고 그대로: 바인딩 lmg56630 · 엔진이 lmg56631로 자동 전환 → 바인딩이 따라간다 ──
let n = m.pickerAfterLanding(bound, sub('lmg56631@gmail.com'))
check('자동 전환 → 바인딩 미러링', n.account === 'lmg56631@gmail.com' && n.model === 'fable', n)
check('다른 필드는 그대로', n.effort === 'xhigh' && n.mode === 'bypass', n)
// 되돌리기 → 옛 계정으로 되미러링
n = m.pickerAfterLanding(n, sub('lmg56630@gmail.com', 'revert'))
check("되돌리기('revert') → 옛 계정으로", n.account === 'lmg56630@gmail.com', n)
// 같은 값이면 같은 객체(헛 렌더·헛 저장 없음)
check('같은 계정이면 같은 객체', m.pickerAfterLanding(bound, sub('lmg56630@gmail.com', 'user')) === bound)
// 리비전 0(default)은 요청 패치 전의 정체성 — 건너뛴다
check("origin 'default'는 무시", m.pickerAfterLanding(bound, sub('x@y', 'default')) === bound)
// 바인딩 없는(따라감) 채팅은 손대지 않는다
const follow = { model: 'fable', effort: 'xhigh', mode: 'bypass' }
check('바인딩 없으면 무동작', m.pickerAfterLanding(follow, sub('lmg56631@gmail.com')) === follow)
const empty = { ...follow, account: '' }
check("바인딩 ''도 무동작", m.pickerAfterLanding(empty, sub('lmg56631@gmail.com')) === empty)
// API 키 축·계정 미상은 무시
check('api_key 축은 무시', m.pickerAfterLanding(bound, { chatId: 'c', origin: 'user', identity: { billing: { kind: 'api_key' } } }) === bound)
check('계정 null은 무시', m.pickerAfterLanding(bound, sub(null)) === bound)
check('identity 없음은 무시', m.pickerAfterLanding(bound, { chatId: 'c', origin: 'user' }) === bound)
// Codex 축 — engine.account → codexAccount (구독 계정은 안 건드린다)
const cxBound = { ...bound, engine: 'codex', codexModel: 'gpt-5.6-terra', codexAccount: 'a@openai' }
n = m.pickerAfterLanding(cxBound, {
  chatId: 'c',
  origin: 'auto_account_switch',
  identity: { engine: { kind: 'codex', model: 'gpt-5.6-terra', account: 'b@openai' }, billing: { kind: 'subscription', account: 'lmg56630@gmail.com' } }
})
check('Codex 계정 미러링', n.codexAccount === 'b@openai' && n.account === 'lmg56630@gmail.com', n)
check('Claude 축 이벤트는 codexAccount를 안 건드린다', m.pickerAfterLanding(cxBound, sub('lmg56630@gmail.com')) === cxBound)

// ── 예약 메시지의 picker 스냅샷 ──
const q = [
  { id: '1', text: 'a', images: [], picker: bound },
  { id: '2', text: 'b', images: [], picker: follow }
]
const q2 = m.queueAfterLanding(q, sub('lmg56631@gmail.com'))
check('예약 1(바인딩 있음)은 새 계정', q2[0].picker.account === 'lmg56631@gmail.com' && q2[0].text === 'a', q2[0])
check('예약 2(따라감)은 그대로 같은 객체', q2[1] === q[1])
check('바뀔 게 없으면 같은 배열', m.queueAfterLanding(q, sub('lmg56630@gmail.com', 'user')) === q)

// ── 자리 채번 규칙 ──
check('ma-{board}-{slot} → slot', m.panelSlotOfChat('ma-27ad11f8-5e95-2', '27ad11f8-5e95') === 2)
check('다른 보드는 null', m.panelSlotOfChat('ma-other-2', '27ad11f8-5e95') === null)
check('본채팅 UUID는 null', m.panelSlotOfChat('55098d47-fc97', '27ad11f8-5e95') === null)
check('빈 보드는 null', m.panelSlotOfChat('ma--1', '') === null)
check('숫자 아닌 꼬리는 null', m.panelSlotOfChat('ma-b-x', 'b') === null)

console.log(fails ? `\n${fails} FAIL` : '\nALL PASS')
process.exit(fails ? 1 : 0)
