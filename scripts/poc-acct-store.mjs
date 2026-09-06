/**
 * PoC — ★R28 ACCT 계정 단일 스토어(`app/src/lib/accounts.ts`) 실동작 검증.
 *
 * 왜 필요한가: 이 라운드가 고치는 것은 대부분 **"언제 무엇을 부르지 않는가"** 다.
 * 화면을 보면 숫자가 뜨니 멀쩡해 보이지만, 그 숫자가 몇 번의 HTTP로 왔는지·첫 페인트가
 * 조회를 기다렸는지·워밍이 토큰을 회전시킬 계정까지 건드렸는지는 눈으로 못 본다.
 * 여기서 그 셋을 **호출 로그로** 잰다.
 *
 * 시나리오(**순서가 규약이다** — 갱신 TTL이 있어 신선해진 뒤에는 안 나가는 게 정상):
 *  D.  선행 워밍 — `warm:true` + 쿨다운(두 번 불러도 한 번만 나간다)
 *  D2. 갱신 TTL — 표면을 여닫아도 방금 받은 값이 있으면 조회가 안 나간다
 *  A.  인플라이트 중복 0 — 설정 탭과 채팅 picker가 같은 순간 열려도 조회는 한 벌
 *  B.  캐시 우선 첫 페인트 — `cachedOnly`가 실조회를 기다리지 않고 즉시 값을 앉힌다
 *  C.  우선 조회 + 수동 재시도 — `priority`·`retry`가 실려 나가고 `force`가 TTL을 넘는다
 *  C2. ★R2(F5 부수) — 재시도는 워밍·자동 갱신에 **합류하지 않는다**(그 답에는 사용자가
 *      보려는 계정이 비어 있다). C3은 그 반대쪽 못: 재시도끼리는 합류한다(중복 0 무회귀).
 *  C4. ★R2(N1) — 그 합류의 **경계**: 창이 둘이면(=모듈 인스턴스가 둘이면) 조회도 둘이다.
 *      「HTTP 한 벌」의 근거는 렌더러가 아니라 셸의 계정별 레인이다(위 헤더 참고).
 *  E.  §3 역인덱스 — 「사용 중 · 2번 자리」·「2곳」·자기 자리는 「현재」라 빠진다
 *  F.  §3 살아 있음 판정 — `account` 키가 없는 행(status.json 재구성)은 자리로 안 센다
 *
 * 실행: node scripts/poc-acct-store.mjs
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(os.tmpdir(), `ccg-poc-acct-${process.pid}.mjs`)

// ── window.api 스텁 — 호출 로그가 이 PoC의 계측기다 ─────────────────────────
const calls = []
let liveDelayMs = 60 // 실조회 왕복(전역 1200ms 게이트를 축소해 흉내)
const rows = (n) => Array.from({ length: n }, (_, i) => ({ email: `a${i}@x`, weeklyPct: i * 10, fiveHourPct: null, fablePct: null }))

globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  api: {
    auth: {
      listAccounts: async () => {
        calls.push({ ch: 'listAccounts' })
        return rows(3).map((r, i) => ({ email: r.email, isDefault: i === 0 }))
      },
      accountsUsage: async (opts) => {
        calls.push({ ch: 'accountsUsage', opts: opts ?? null })
        if (opts?.cachedOnly) return rows(3).map((r) => ({ ...r, stale: true }))
        await new Promise((r) => setTimeout(r, liveDelayMs))
        return rows(3)
      }
    },
    codexAuth: {
      listAccounts: async () => {
        calls.push({ ch: 'cxListAccounts' })
        return []
      },
      accountsUsage: async () => {
        calls.push({ ch: 'cxAccountsUsage' })
        return []
      }
    }
  }
}
globalThis.localStorage = { getItem: () => null, setItem() {} }

const fails = []
const ok = (cond, label, detail = '') => {
  if (!cond) fails.push(label + (detail ? ` — ${detail}` : ''))
  console.log(`${cond ? '  ok ' : '  ✗  '}${label}${detail ? ` — ${detail}` : ''}`)
}
const usageCalls = () => calls.filter((c) => c.ch === 'accountsUsage' && !c.opts?.cachedOnly)

await esbuild.build({
  entryPoints: [path.join(root, 'app/src/lib/accounts.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: out,
  // react까지 통째로 넣는다 — 번들이 레포 밖(%TEMP%)에 앉아 node_modules를 못 보기
  // 때문이다(하네스 위생: 스크래치는 레포 밖). 이 PoC는 훅을 안 쓰고 순수 문만 부른다.
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent'
})
const S = await import(pathToFileURL(out).href)

// ★ 순서가 중요하다: 스토어에는 갱신 TTL(60초)이 있어서, 한 번 신선해지면 그다음
//   조회들이 **안 나가는 것이 정상**이다. 그래서 워밍(가장 먼저 도는 것)부터 잰다.
console.log('\n── D. 선행 워밍 (warm=true · 쿨다운) ───────────────────────────')
calls.length = 0
S.warmUsage('a1@x')
S.warmUsage('a1@x') // 쿨다운 안 — 나가면 안 된다
await new Promise((r) => setTimeout(r, 250))
const warmed = usageCalls()
ok(warmed.length === 1, '쿨다운 안의 두 번째 워밍은 안 나간다', `실측 ${warmed.length}회`)
ok(warmed[0]?.opts?.warm === true, '★ warm 표식이 붙는다(토큰 회전 유발 금지의 그 문)', JSON.stringify(warmed[0]?.opts))

console.log('\n── D2. 갱신 TTL (표면을 여닫아도 매번 안 묻는다) ───────────────')
calls.length = 0
await S.refreshUsage({})
await S.refreshUsage({ priority: 'a0@x' })
ok(usageCalls().length === 0, '★ 방금 받은 값이 있으면 조회가 안 나간다', `실측 ${usageCalls().length}회`)

console.log('\n── A. 인플라이트 중복 0 (설정 탭 + 채팅 picker 동시) ─────────────')
calls.length = 0
const two = await Promise.all([S.refreshUsage({ priority: 'a0@x', force: true }), S.refreshUsage({ priority: 'a1@x', force: true })])
ok(usageCalls().length === 1, '동시 두 표면 → 실조회 1회', `실측 ${usageCalls().length}회`)
ok(two[0] === two[1], '두 표면이 같은 값 한 벌을 받는다')

console.log('\n── B. 캐시 우선 첫 페인트 (stale-while-revalidate) ──────────────')
calls.length = 0
liveDelayMs = 400 // 실조회는 느리다(직렬 게이트 × 계정 수)
const t0 = Date.now()
const slow = S.refreshUsage({ force: true }) // 뒤에서 도는 갱신
await S.primeUsageFromDisk()
const paintMs = Date.now() - t0
const painted = Object.keys(S.accountState().usage).length
ok(paintMs < 200, '첫 페인트가 실조회를 안 기다린다', `${paintMs}ms (실조회 ${liveDelayMs}ms)`)
ok(painted === 3, '보존값 3건이 즉시 앉는다', `${painted}건`)
ok(
  calls.some((c) => c.ch === 'accountsUsage' && c.opts?.cachedOnly === true),
  'cachedOnly 조회가 실제로 나갔다'
)
await slow
liveDelayMs = 60

console.log('\n── C. 우선 조회 + 수동 재시도 (TTL을 넘는 유일한 문) ────────────')
calls.length = 0
await S.refreshUsage({ priority: 'a2@x', force: true })
ok(usageCalls().length === 1, '★ 「다시 시도」는 캐시가 아니라 조회여야 한다', `실측 ${usageCalls().length}회`)
ok(usageCalls()[0]?.opts?.priority === 'a2@x', 'priority가 셸까지 실려 간다', JSON.stringify(usageCalls()[0]?.opts))
// ★R2(F5) — 렌더러 TTL만 넘고 끝나면 셸의 3분 실패 격리에서 버튼이 무동작이다.
ok(usageCalls()[0]?.opts?.retry === true, '★ 수동 재시도 표식이 셸까지 간다(격리를 넘는 유일한 근거)', JSON.stringify(usageCalls()[0]?.opts))

console.log('\n── C2. 수동 재시도는 「약한 조회」에 합류하지 않는다 (R2 · F5 부수) ──')
// 워밍은 **토큰이 만료된 계정을 건너뛰고**, 자동 갱신은 **격리된 계정을 건너뛴다** —
// 사용자가 「다시 시도」로 보려는 것이 정확히 그 계정들이다. 그 조회에 합류해 놓고
// 「다시 시도했다」고 말하면 버튼이 거짓말을 한다(확인 크리틱 R1 F5 부수).
calls.length = 0
liveDelayMs = 200
S.invalidateAccounts() // 로그인·정렬 뒤와 같은 판 — 한도 TTL이 식는다
const warming = S.refreshUsage({ priority: 'a0@x', warm: true }) // 도는 워밍(약한 조회)
await new Promise((r) => setTimeout(r, 20))
const clicked = S.refreshUsage({ priority: 'a1@x', force: true }) // 그 사이 사람이 누른 재시도
await Promise.all([warming, clicked])
const two2 = usageCalls()
ok(two2.length === 2, '★ 워밍 결과를 재시도로 속이지 않는다(뒤이어 한 번 더 돈다)', `실측 ${two2.length}회`)
ok(two2[0]?.opts?.warm === true && two2[1]?.opts?.warm !== true, '두 번째는 워밍이 아니다', JSON.stringify(two2.map((c) => c.opts)))
ok(two2[1]?.opts?.retry === true, '두 번째에 재시도 표식이 붙는다', JSON.stringify(two2[1]?.opts))

console.log('\n── C3. 재시도끼리는 그대로 합류한다 (§1 인플라이트 중복 0 무회귀) ──')
calls.length = 0
const both = await Promise.all([S.refreshUsage({ priority: 'a0@x', force: true }), S.refreshUsage({ priority: 'a1@x', force: true })])
ok(usageCalls().length === 1, '★ 두 표면의 재시도가 두 벌로 나가면 안 된다', `실측 ${usageCalls().length}회`)
ok(both[0] === both[1], '두 표면이 같은 값 한 벌을 받는다')
liveDelayMs = 60

console.log('\n── C4. 합류의 경계 = **이 창** (R2 · N1) ────────────────────────')
// ★확인 크리틱 R1 N1 — 위 A·C3의 「중복 0」은 **한 JS 힙 안에서만** 참이다.
// `#session`·`#mapanel`은 같은 번들의 다른 OS 창이라 이 모듈을 한 벌씩 들고, 그 창들도
// picker를 그린다. 렌더러에는 창 밖을 세는 방법이 없다(모듈 상태를 공유할 길이 없다) —
// 그래서 「HTTP 한 벌」의 근거는 셸의 계정별 레인이다
// (`ipc/parity/usage.rs::two_windows_sweeping_at_once_ask_each_account_only_once` —
//  레인을 빼고 재면 계정 3개 × 2창 = **6회**, 넣으면 3회).
// 여기서는 그 경계를 못으로 박는다: **모듈을 한 벌 더 들면 조회도 한 벌 더 나간다.**
calls.length = 0
const S2 = await import(pathToFileURL(out).href + '?win=mapanel') // 다른 창 = 다른 모듈 인스턴스
await Promise.all([S.refreshUsage({ force: true }), S2.refreshUsage({ force: true })])
ok(
  usageCalls().length === 2,
  '★ 두 창은 렌더러에서 안 합쳐진다(합쳐진다고 적으면 셸 레인을 걷어내도 초록이다)',
  `실측 ${usageCalls().length}회 — 셸 레인이 이 둘을 계정당 1건으로 접는다`
)

console.log('\n── E. §3 역인덱스 (계정 → 살아 있는 자리) ──────────────────────')
// ★R2(F4) — 본채팅 행의 `panelId`가 `null`인 것은 **셸의 판정**이다(`panel_seat_for_chat`:
// `chrome:"ide"` 보드 = 본채팅 화면이므로 자리로 안 센다). R1은 마이그레이션이 만든
// `default` 보드 때문에 실제로는 `default::0`이 실려 왔고, 자리 번호가 이름표를 이겨
// **본채팅도 「1번 자리」**였다(확인 크리틱 R1 F4 — 하네스 픽스처가 현실과 갈렸던 자리).
// 렌더러 쪽에서는 못 가린다: 같은 `default` 보드가 멀티에서는 `chrome:"grid"`로 산다.
S.putSlotNames('chats', { 'chat-main': '본채팅' })
S.putSlotNames('wins', { 'chat-win': '추가 창' })
S.putChatStatuses([
  { chatId: 'chat-main', account: 'a0@x', panelId: null },
  { chatId: 'chat-p2', account: 'a1@x', panelId: 'board-1::1', seat: 2 },
  { chatId: 'chat-p3', account: 'a1@x', panelId: 'board-1::2', seat: 3 },
  { chatId: 'chat-win', account: 'a2@x', panelId: null }
])
ok(S.inUseLabel('a0@x') === '사용 중 · 본채팅', '본채팅 이름표', String(S.inUseLabel('a0@x')))
ok(S.inUseLabel('a1@x') === '사용 중 · 2곳', '여럿이면 개수', String(S.inUseLabel('a1@x')))
ok(S.inUseLabel('a1@x', 'board-1::1') === '사용 중 · 3번 자리', '자기 자리는 빠지고 남은 하나를 이름으로', String(S.inUseLabel('a1@x', 'board-1::1')))
ok(S.inUseLabel('a2@x', 'chat-win') === null, '★ 자기 자리뿐이면 칩이 없다(그건 「현재」다)', String(S.inUseLabel('a2@x', 'chat-win')))
ok(S.inUseLabel('nobody@x') === null, '아무도 안 쓰는 계정엔 칩이 없다')
ok(S.slotsUsing('a1@x', 'board-1::1').filter((s) => s.self).length === 1, 'self 표식은 자기 자리 하나')

console.log('\n── F. 살아 있음 판정 (account 키가 곧 살아 있는 런타임) ────────')
S.putChatStatuses([
  { chatId: 'chat-main', busy: false }, // status.json 재구성 행 — account 키가 없다
  { chatId: 'chat-p2', account: '', panelId: 'board-1::1' } // 빈 문자열 = 계정 미상
])
ok(S.inUseLabel('a0@x') === null, '★ 죽은 채팅(키 없음)이 계정을 물고 있다고 말하면 안 된다', String(S.inUseLabel('a0@x')))
ok(S.slotsUsing('a1@x').length === 0, '빈 계정 문자열도 자리로 안 센다')

console.log('\n── G. Claude / Codex 계정은 같은 이메일도 따로 센다 ─────────')
S.putChatStatuses([
  { chatId: 'claude', account: 'shared@x', panelId: 'b::0', seat: 1 },
  { chatId: 'codex1', codexAccount: 'shared@x', panelId: 'b::1', seat: 2 },
  { chatId: 'codex2', codexAccount: 'shared@x', panelId: 'b::2', seat: 3 }
])
ok(S.inUseLabel('shared@x', 'b::0') === null, 'Claude 자기 자리만 쓰면 Codex 두 자리를 세지 않는다')
ok(S.slotsUsing('shared@x').length === 1, 'Claude 계정 사용처는 한 곳')
ok(S.inUseLabel('shared@x', 'b::1', 'codex') === '사용 중 · 3번 자리', 'Codex도 자기 자리를 빼고 다른 Codex 자리만 표시')
ok(S.liveAccountOf('b::1', 'codex') === 'shared@x', 'Codex 실제 실행 계정을 읽는다')
ok(S.liveAccountOf('b::1') === undefined, 'Codex 실행 계정을 Claude 현재 계정으로 읽지 않는다')
ok(S.panelIdOfChat('codex1') === 'b::1', 'Codex 분리 창도 자리 식별 가능')
S.putChatStatuses([{ chatId: 'claude', account: 'shared@x', panelId: 'b::0', seat: 1 }])
ok(S.inUseLabel('shared@x', undefined, 'codex') === null, '런타임 회수 후 Codex 사용 중 표시는 사라진다')

fs.rmSync(out, { force: true })
console.log(`\n${fails.length === 0 ? '✅ 전부 통과' : `❌ 실패 ${fails.length}건`}`)
for (const f of fails) console.log('   - ' + f)
process.exit(fails.length === 0 ? 0 : 1)
