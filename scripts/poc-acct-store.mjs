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
 *  C.  우선 조회 + 수동 재시도 — `priority`가 실려 나가고 `force`가 TTL을 넘는다
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

console.log('\n── E. §3 역인덱스 (계정 → 살아 있는 자리) ──────────────────────')
S.putSlotNames('chats', { 'chat-main': '본채팅' })
S.putSlotNames('wins', { 'chat-win': '추가 창' })
S.putChatStatuses([
  { chatId: 'chat-main', account: 'a0@x', panelId: null },
  { chatId: 'chat-p2', account: 'a1@x', panelId: 'board-1::1' },
  { chatId: 'chat-p3', account: 'a1@x', panelId: 'board-1::2' },
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

fs.rmSync(out, { force: true })
console.log(`\n${fails.length === 0 ? '✅ 전부 통과' : `❌ 실패 ${fails.length}건`}`)
for (const f of fails) console.log('   - ' + f)
process.exit(fails.length === 0 ? 0 : 1)
