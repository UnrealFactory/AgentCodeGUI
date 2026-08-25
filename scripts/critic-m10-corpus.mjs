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
 *   node scripts/critic-m10-corpus.mjs
 *   node scripts/critic-m10-corpus.mjs --dir=C:\Temp\ccg-r28f-m10crit\out   # 남의 산출물도 함께
 *   node scripts/critic-m10-corpus.mjs --since=2026-08-25T02:00:00Z         # 특정 시점 이후만
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { REPO } from '../bench/lib.mjs'

const args = process.argv.slice(2)
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
rows.sort((a, b) => String(a.at).localeCompare(String(b.at)))

const kst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().slice(5, 19).replace('T', ' ')
console.log('시각(KST)         계기       태그            엔진      하한      작업폴더  홉1 봉투 홉2 상한  회신')
for (const r of rows) {
  console.log(
    [
      kst(r.at),
      r.src.padEnd(9),
      r.tag.padEnd(14),
      String(r.engine).padEnd(8),
      r.policy.padEnd(8),
      r.workspace.padEnd(8),
      r.hop1 ? ' o ' : ' x ',
      r.envelope ? ' o ' : ' x ',
      r.hop2 ? ' o ' : ' x ',
      r.hopCap ? ' o ' : ' x ',
      ' ' + r.reply
    ].join(' ')
  )
}

const cell = (f, k) => {
  const g = rows.filter(f)
  const n = g.filter((r) => r[k]).length
  return `${n}/${g.length}${g.length ? ` (${Math.round((n / g.length) * 100)}%)` : ''}`
}
const ro = (r) => r.policy === 'readonly'
const line = (label, f) =>
  console.log(`  ${label} : 홉2 ${cell(f, 'hop2').padEnd(12)} 내용 있는 회신 ${cell(f, 'substantive').padEnd(12)} hop_cap ${cell(f, 'hopCap')}`)
console.log(`\n표본 ${rows.length}건`)
line('readonly · 작업폴더=repo', (r) => ro(r) && r.workspace === 'repo')
line('readonly · 작업폴더=bare', (r) => ro(r) && r.workspace === 'bare')
line('ask      · 작업폴더=repo', (r) => !ro(r) && r.workspace === 'repo')
line('전체                    ', () => true)
