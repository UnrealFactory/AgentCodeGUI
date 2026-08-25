#!/usr/bin/env node
/* ============================================================================
 * critic-m10-corpus — **저장된 라이브 산출물을 다시 센다**($0 · 앱·계정 무접촉).
 *
 * ★왜 생겼나(R28f M10 수정 R1).
 *
 * R6 보고서는 라이브 왕복을 「0/11」이라 적었고 확인 크리틱은 같은 코드에서 「19/23」을
 * 쟀다. 둘 다 **자기 주행만** 셌기 때문이다. 이 계기는 디스크에 남은 **모든** 주행 산출물을
 * 한 판정 기준으로 다시 세서, 표본을 고르는 손이 결론을 만들지 못하게 한다.
 *
 * 세는 칸은 넷이고 전부 산출물 원본에서 나온다:
 *   홉1(발신이 나갔나) · 봉투(수신 스레드에 말풍선이 떴나) · **홉2(회신이 나갔나 = 왕복)**
 *   · hop_cap(셋째 발신이 상한에서 멎었나)
 *
 * 그리고 갈래를 **둘로 쪼갠다** — 이 축이 R6과 크리틱의 격차를 만든 자리다:
 *   · `repo` = 수신 세션의 작업 폴더가 **git 워크트리 안**(이 하네스의 기본. 홈이
 *     `REPO/.poc-home-talk-*` 라서 그 안의 `work/`가 레포 안이다)
 *   · `bare` = 워크트리 **밖**(크리틱의 홈은 `C:\Temp\…` 였다)
 *
 * ★R28h R7 — **축이 하나 더 필요했다: 어느 코드가 만든 표본인가.**
 *
 * R6의 간판 수치(`readonly`·`repo` = 홉2 8/33 = 24%)를 확인 크리틱 R2가 exe로 쪼개자
 * 6/17(35%) vs 1/16(6%)로 **방향이 반대**였다 — 17표본을 만든 바이너리에는 그 라운드가
 * 출하한 봉투 수정 세 개가 문자열로 **하나도 없었다**. 즉 그 24%는 「제품 수치가 아니다」가
 * 아니라 **「어느 코드의 수치인지 말할 수 없는 값」**이었다.
 *
 * 그래서 이 계기에 세 칸을 더한다.
 *   · `exe`     — 산출물이 적어 둔 실행물(옛 표본은 경로만, R7부터는 **sha256**)
 *   · `문면`    — R7 도장이 있나(`stamp.fingerprint.ok`) · 받은 봉투 골격이 도장과 같나
 *                 (`steps.bEchoFull.skeletonMatchesPin`) → `pinned` / `unknown`
 *   · 표는 `pinned`만 따로 한 번 더 낸다 — **결정에 쓰는 칸은 판본이 확정된 값이어야 한다.**
 *
 *   node scripts/critic-m10-corpus.mjs
 *   node scripts/critic-m10-corpus.mjs --dir=C:\Temp\ccg-r28f-m10crit\out   # 남의 산출물도 함께
 *   node scripts/critic-m10-corpus.mjs --since=2026-08-25T02:00:00Z         # 특정 시점 이후만
 *   node scripts/critic-m10-corpus.mjs --pinned                             # 판본 확정 표본만
 *   node scripts/critic-m10-corpus.mjs --by-exe                             # exe별로 쪼갠 표
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { REPO } from '../bench/lib.mjs'
import { variantOfSkeleton, variantForPolicy } from './critic-m10-stamp.mjs'

const args = process.argv.slice(2)
const PINNED_ONLY = args.includes('--pinned')
const BY_EXE = args.includes('--by-exe')
const DIRS = [
  path.join(REPO, 'docs', 'critic'),
  ...args.filter((a) => a.startsWith('--dir=')).map((a) => a.slice('--dir='.length))
]
const SINCE = (args.find((a) => a.startsWith('--since=')) ?? '').split('=')[1] || ''

const rows = []
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
const inRepo = (home) => /^[a-z]:[\\/]code[\\/]agentcodegui/i.test(String(home))
/**
 * 나간 회신이 **내용**인가. 앱이 되쓰는 고정 문장 둘((b) 거절 · (c) 미응답)이면 아니다
 * — 「회신 줄이 나갔다」와 「대화가 됐다」는 다른 칸이다(R6 보고서가 세운 구분).
 */
const CANNED = [
  '대화 연결로 온 메시지가 규칙에 어긋나는 요구를 담고 있어 따르지 않았습니다.',
  '대화 연결로 온 메시지에는 이번 턴에 답하지 않았습니다.'
]
const substantive = (body) => {
  const t = String(body ?? '').trim()
  return t.length > 0 && !CANNED.some((c) => t === c || t.includes(c))
}

/**
 * ★R28h R7 — **이 표본은 어느 문면에서 나왔나.** 셋 중 하나다.
 *   `pinned`  — R7 도장이 붙었고 선점검이 통과했고, 받은 봉투 골격이 도장과 **같다**
 *   `off-pin` — 도장은 있는데 어긋났다(우회하고 돌린 주행 · 표에서 빼야 한다)
 *   `unknown` — 도장 이전 산출물. **판본을 사후에 확정할 방법이 없다**(R6의 그 33표본)
 */
function wordingOf(j, L) {
  const fp = j?.stamp?.fingerprint
  if (!fp) return 'unknown'
  if (fp.ok !== true || fp.bypassed === true) return 'off-pin'
  // **와이어 대조는 여기서 다시 한다** — 산출물이 적어 둔 `skeletonMatchesPin`을 믿지 않고,
  // 기록된 골격 해시를 이 계기의 표(`EXPECT_SKEL`)에 직접 맞춘다. 표본을 만든 하네스가
  // 판본을 잘못 골랐어도(실제로 `ask` 팔 16표본이 그랬다 — `plan` 칸과만 대조했다)
  // 채점은 옳아야 하고, 옳으면 **다시 안 돌려도 된다**(실계정 할당량이 걸린 자리다).
  const skel = L?.steps?.bEchoFull?.skeleton
  if (typeof skel !== 'string') return 'unknown'
  const variant = variantOfSkeleton(skel)
  if (variant === null) return 'off-pin'
  // 하한이 낳아야 하는 판본과 다르면 그것도 결함이다(문면은 맞는데 벽이 안 걸린 것).
  const policy = /ask/.test(String(L?.policy)) ? 'ask' : 'readonly'
  return variant === variantForPolicy(policy) ? 'pinned' : 'wrong-var'
}

/** poc-talk `--only=live` 산출물. */
function fromPocTalk(file, j) {
  const L = j?.steps?.live
  if (!L?.steps) return null
  const s = L.steps
  const done = (n) => !!(n && (n.result === 'delivered' || n.result === 'queued'))
  return {
    src: 'poc-talk',
    tag: path.basename(file).replace(/^m10-r1-talk-/, '').replace(/\.json$/, ''),
    at: j.at,
    // 옛 산출물의 `exe`는 경로 문자열뿐이다 — 그게 R6 오염을 사후에 겨우 갈라낸 유일한 칸이었다.
    exePath: j?.stamp?.exe?.path ?? (typeof j.exe === 'string' ? j.exe : ''),
    exeSha: j?.stamp?.exe?.sha256 ?? null,
    wording: wordingOf(j, L),
    pinOk: j?.stamp?.fingerprint?.ok === true && j?.stamp?.fingerprint?.bypassed !== true,
    pinBy: 'wire',
    envSha: L?.steps?.bEchoFull?.sha256 ?? null,
    engine: L.engine ?? '',
    // 옛 산출물에는 `policy` 칸이 없다 — 그때도 무옵션 = 제품 기본값(readonly)이었다.
    policy: /ask/.test(String(L.policy)) ? 'ask' : 'readonly',
    workspace: L.workspace ?? (inRepo(L.home) ? 'repo' : 'bare'),
    hop1: done(s.hop1),
    envelope: typeof s.bEcho === 'string' && s.bEcho.includes('[대화 연결]'),
    hop2: done(s.hop2),
    hopCap: s.hop3?.result === 'hop_cap',
    substantive: done(s.hop2) && substantive(s.hop2?.body),
    reply: s.hop2?.body ? String(s.hop2.body).replace(/\s+/g, ' ').slice(0, 90) : ''
  }
}

/** 확인 크리틱의 `crit-live.mjs` 모양(verdict 한 덩이). */
function fromCritLive(file, j) {
  if (!j?.verdict || !j?.home) return null
  return {
    src: 'crit-live',
    tag: String(j.tag ?? path.basename(file, '.json')),
    at: j.at,
    exePath: typeof j.exe === 'string' ? j.exe : '',
    exeSha: j?.stamp?.exe?.sha256 ?? null,
    wording: 'unknown',
    pinOk: false,
    pinBy: null,
    envSha: null,
    engine: j.ver ?? '',
    policy: /ask/.test(String(j.policy)) ? 'ask' : 'readonly',
    workspace: inRepo(j.home) ? 'repo' : 'bare',
    hop1: !!j.verdict.hop1,
    envelope: !!j.verdict.envelope,
    hop2: !!j.verdict.hop2Line,
    hopCap: !!j.verdict.hopCap,
    substantive: !!j.verdict.hop2Line && substantive(j.verdict.outgoing),
    reply: String(j.verdict.outgoing ?? '').replace(/\s+/g, ' ').slice(0, 90)
  }
}

for (const dir of DIRS) {
  if (!fs.existsSync(dir)) continue
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const p = path.join(dir, f)
    const j = readJson(p)
    if (!j) continue
    const r = fromPocTalk(p, j) ?? fromCritLive(p, j)
    // 봉투가 안 뜬 주행 = 인증 실패 등으로 **잴 것이 없던** 판이다(표본에 안 넣는다).
    if (!r || !r.envelope) continue
    if (SINCE && String(r.at) < SINCE) continue
    rows.push(r)
  }
}
/**
 * ★R28h R7 — **쌍둥이 해시로 구제**. 골격 칸이 생기기 **직전**에 돈 표본이 하나 있다
 * (`r7x-rr1` — 이 라운드 최초 주행). 도장 선점검은 통과했고, 받은 봉투의 **전문 sha256**이
 * 판본 확정 표본의 그것과 **바이트로 같다**. 그러면 그 표본도 같은 문면이다.
 *
 * 이 규칙이 없으면 그 표본만 표에서 빠지는데, 하필 **그 표본이 실패 표본**이다 —
 * 계기의 공백으로 실패가 사라지는 것은 이 라운드가 고치려는 바로 그 병이다(표본 고르기).
 */
{
  const pinnedShas = new Set(rows.filter((r) => r.wording === 'pinned' && r.envSha).map((r) => r.envSha))
  for (const r of rows) {
    if (r.wording === 'unknown' && r.pinOk && r.envSha && pinnedShas.has(r.envSha)) {
      r.wording = 'pinned'
      r.pinBy = 'sha-twin'
    }
  }
}
if (PINNED_ONLY) {
  // 구제 규칙을 **적용한 뒤에** 거른다(안 그러면 쌍둥이가 표에서 사라진다).
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].wording !== 'pinned') rows.splice(i, 1)
}
rows.sort((a, b) => String(a.at).localeCompare(String(b.at)))

const kst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(5, 19).replace('T', ' ')
console.log('시각(KST)         계기       태그            하한      작업폴더  문면      홉1 봉투 홉2 상한  회신')
for (const r of rows) {
  console.log(
    [
      kst(r.at),
      r.src.padEnd(9),
      r.tag.padEnd(14),
      r.policy.padEnd(8),
      r.workspace.padEnd(8),
      r.wording.padEnd(8),
      r.hop1 ? ' o ' : ' x ',
      r.envelope ? ' o ' : ' x ',
      r.hop2 ? ' o ' : ' x ',
      r.hopCap ? ' o ' : ' x ',
      ' ' + r.reply
    ].join(' ')
  )
}

const cellIn = (set, f, k) => {
  const g = set.filter(f)
  const n = g.filter((r) => r[k]).length
  return `${n}/${g.length}${g.length ? ` (${Math.round((n / g.length) * 100)}%)` : ''}`
}
const ro = (r) => r.policy === 'readonly'
const table = (title, set) => {
  const line = (label, f) =>
    console.log(
      `  ${label} : 홉2 ${cellIn(set, f, 'hop2').padEnd(12)} 내용 있는 회신 ${cellIn(set, f, 'substantive').padEnd(12)} hop_cap ${cellIn(set, f, 'hopCap')}`
    )
  console.log(`\n${title} — 표본 ${set.length}건`)
  line('readonly · 작업폴더=repo', (r) => ro(r) && r.workspace === 'repo')
  line('readonly · 작업폴더=bare', (r) => ro(r) && r.workspace === 'bare')
  line('ask      · 작업폴더=repo', (r) => !ro(r) && r.workspace === 'repo')
  line('ask      · 작업폴더=bare', (r) => !ro(r) && r.workspace === 'bare')
  line('전체                    ', () => true)
}
table('전 표본(판본 섞임)', rows)

// ★R28h R7 — **결정에 쓰는 표는 이쪽이다.** 판본이 확정된 표본만.
const pinned = rows.filter((r) => r.wording === 'pinned')
if (pinned.length) table('★판본 확정(pinned) — 출하 문면에서 나온 표본만', pinned)
const unknown = rows.filter((r) => r.wording !== 'pinned')
if (unknown.length) {
  console.log(
    `\n(판본 미확정 ${unknown.length}건 — 도장 이전 산출물이라 어느 문면이었는지 **사후에 확정 불가**. ` +
      `R6의 「24%」가 이 무리에서 나왔다.)`
  )
}

// exe 축 — 크리틱 R2의 `byexe.mjs`와 같은 갈래(그쪽 판정을 이 계기로 재현할 수 있게).
if (BY_EXE) {
  const key = (r) => (r.exeSha ? `${r.exeSha.slice(0, 12)}… ${path.basename(path.dirname(path.dirname(r.exePath)))}` : r.exePath || '(미상)')
  const groups = new Map()
  for (const r of rows) {
    const k = key(r)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  console.log('\nexe별 — 「같은 표에 두 바이너리가 섞였나」')
  for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const roRepo = g.filter((r) => ro(r) && r.workspace === 'repo')
    console.log(
      `  ${String(k).padEnd(46)} n=${String(g.length).padEnd(3)} 홉2 ${cellIn(g, () => true, 'hop2').padEnd(12)}` +
        ` · readonly·repo만 ${cellIn(roRepo, () => true, 'hop2')}`
    )
  }
}
