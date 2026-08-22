#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// critic-m2-migrate — 마이그레이션 **독립 재현**.
//
// 빌더 하네스를 부르지 않는다. 다른 점 셋(= 빌더 하네스의 맹점을 노린 자리):
//  1. before 인벤토리를 **디스크 파일**에서 만든다(index.order가 아니라).
//  2. 원본 레코드의 **키를 전수 추적**한다 — 매핑표에 없는 키가 소리 없이 사라지는지.
//     (빌더 하네스는 자기 매핑 미러로 만든 값끼리 비교하므로 "매핑이 잃는 것"은
//      before/after 양쪽에서 똑같이 잃어 통과한다)
//  3. `picker.account`·`codexModel` 같은 **리프**를 개별로 되찾을 수 있는지 본다.
//
//   node docs/critic/tools/critic-m2-migrate.mjs [--home <경로>]
//   (기본: 사용자 실홈의 크리틱 자체 복사본 — 실홈은 읽기만)
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'
import { canon, cli, cloneReal, filesOf, readJSON, sha, sourceUnits, v3Units, writeResult, REAL_HOME } from './critic-m2-lib.mjs'

// ── §4.2 매핑표에서 **따로 쓴** toRawIdentity (Rust·빌더 미러와 독립) ────────
const MODELS = ['fable', 'opus', 'sonnet', 'haiku']
const EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal']
const MODES = ['normal', 'plan', 'acceptEdits', 'auto', 'bypass']
const STYLES = ['Concise', 'Explanatory', 'Learning', 'Proactive']
const DEF = { chat: ['opus', 'xhigh', 'auto'], talk: ['opus', 'xhigh', 'auto'], panel: ['opus', 'xhigh', 'bypass'], session: ['opus', 'high', 'auto'] }

function globalsOf(home) {
  const prefs = readJSON(path.join(home, 'ui-prefs.json')) ?? {}
  const dis = (f) => {
    const v = readJSON(path.join(home, f))?.disabled
    return Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string'))].sort() : []
  }
  const style = prefs['claude.outputStyle']
  return {
    apiMode: prefs['api.mode'] === true,
    outputStyle: STYLES.includes(style) ? style : null,
    skills: dis('skills.json'),
    mcp: dis('mcp.json'),
    workspaceMulti: prefs['workspace.mode'] === 'multi',
    hold: prefs['limitResume.hold'] ?? null
  }
}

function myRawIdentity(rec, source, g) {
  const p = rec?.picker ?? {}
  const [dm, de, dmo] = DEF[source]
  const codex = p.engine === 'codex'
  const model = codex ? (typeof p.codexModel === 'string' ? p.codexModel : '') : MODELS.includes(p.model) ? p.model : dm
  const effort = EFFORTS.includes(p.effort) ? p.effort : de
  const mode = MODES.includes(p.mode) ? p.mode : dmo
  const api = source === 'panel' ? (typeof rec?.api === 'boolean' ? rec.api : g.apiMode) : g.apiMode
  const cwd = source === 'chat' ? (rec?.manualCwd ?? '') : source === 'talk' ? '' : (rec?.cwd ?? '')
  const addDirs = (Array.isArray(rec?.refDirs) ? rec.refDirs : []).filter((s) => typeof s === 'string' && s).slice(0, 8)
  const skillOverrides = {}
  for (const s of g.skills) skillOverrides[s] = 'disabled'
  return {
    engine: { kind: codex ? 'codex' : 'claude', model, effort, codexAccount: codex && p.codexAccount ? p.codexAccount : null },
    billing: api ? { kind: 'api_key' } : { kind: 'subscription', account: p.account ? p.account : null, dropEnvKey: !!process.env.ANTHROPIC_API_KEY },
    cwd: cwd ?? '',
    addDirs,
    mode,
    systemPrompt: null,
    outputStyle: g.outputStyle,
    tools: { skillOverrides, deniedMcp: g.mcp }
  }
}

// ── 원본 레코드의 **모든 리프**가 목적지에서 되찾아지는가 ────────────────────
// "매핑표에 없어서 조용히 사라진 값"을 잡는 그물. 값 자체가 아니라 **되찾을 수
// 있는가**를 본다(다른 이름·다른 자리라도 살아 있으면 통과).
function leafAudit(unit, target) {
  const lost = []
  const rec = unit.rec ?? {}
  const t = target?.rec ?? {}
  const idty = t.identity ?? {}
  const has = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)
  const p = rec.picker ?? {}

  // picker.account — 구독일 때만 identity.billing.account로 산다
  if (has(p.account)) {
    const kept = idty.billing?.account === p.account
    if (!kept) lost.push({ leaf: 'picker.account', value: p.account, whereGone: `billing.kind=${idty.billing?.kind}` })
  }
  // codex 채팅의 클로드 모델 — 역투영에서 되살아나지 않는다
  if (p.engine === 'codex' && has(p.model)) {
    if (idty.engine?.model !== p.model) lost.push({ leaf: 'picker.model(codex 채팅)', value: p.model, whereGone: `engine.model=${idty.engine?.model}` })
  }
  // refDirs 개수(2.6.2 sanitizeRefDirs가 8로 자르므로 8 초과분은 손실이 아니다)
  const refs = (Array.isArray(rec.refDirs) ? rec.refDirs : []).filter((s) => typeof s === 'string' && s)
  if (refs.length && canon(refs.slice(0, 8)) !== canon(idty.addDirs ?? [])) {
    lost.push({ leaf: 'refDirs', value: refs.slice(0, 8), whereGone: canon(idty.addDirs ?? []) })
  }
  // 알려진 매핑 키를 뺀 나머지 상위 키 — 목적지 어디에도 없으면 보고
  const mapped = new Set([
    'id', 'title', 'custom', 'locked', 'color', 'snapshot', 'picker', 'manualCwd', 'cwd', 'refDirs', 'api',
    'draft', 'draftImages', 'updatedAt', 'btwOf', 'btwSeed', 'btwPrompt', 'empty', 'status', 'unloaded'
  ])
  for (const k of Object.keys(rec)) {
    if (mapped.has(k)) continue
    if (!has(rec[k])) continue
    if (canon(t[k]) === canon(rec[k])) continue
    lost.push({ leaf: `미지 키 ${k}`, value: rec[k], whereGone: 'after 레코드에 없음' })
  }
  // 패널을 뺀 초안
  if (unit.source !== 'panel') {
    for (const k of ['draft', 'draftImages']) {
      if (has(rec[k]) && canon(rec[k]) !== canon(t[k])) lost.push({ leaf: k, value: rec[k], whereGone: canon(t[k]) })
    }
  }
  return lost
}

function main() {
  const argv = process.argv.slice(2)
  const hi = argv.indexOf('--home')
  const home = hi >= 0 ? path.resolve(argv[hi + 1]) : cloneReal('repro')
  if (path.resolve(home).toLowerCase() === REAL_HOME.toLowerCase()) {
    console.error('거부: 실홈')
    process.exit(2)
  }
  const rep = { at: new Date().toISOString(), home, source: hi >= 0 ? 'given' : 'real-home-clone', findings: [] }
  const fail = (item, d) => rep.findings.push({ item, ...d })

  const g = globalsOf(home)
  rep.globals = g
  const before = sourceUnits(home)
  rep.before = {
    units: before.length,
    broken: before.filter((u) => u.broken).length,
    bySource: before.reduce((m, u) => ((m[u.source] = (m[u.source] ?? 0) + 1), m), {}),
    messages: before.reduce((n, u) => n + (u.msgs ?? 0), 0),
    // 인덱스가 나열하지 않는 파일(= 마이그레이터가 못 보는 것)
    notInIndex: {
      chats: [...filesOf(path.join(home, 'chats')).keys()].filter((id) => !(readJSON(path.join(home, 'chats', 'index.json'))?.order ?? []).includes(id)),
      sessionChats: [...filesOf(path.join(home, 'session-chats')).keys()].filter(
        (id) => !(readJSON(path.join(home, 'session-chats', 'index.json'))?.order ?? []).includes(id)
      ),
      multiAgent: [...filesOf(path.join(home, 'multi-agent')).keys()].filter(
        (id) => !(readJSON(path.join(home, 'multi-agent', 'index.json'))?.order ?? []).includes(id)
      )
    }
  }

  const t0 = Date.now()
  const mig = cli(home, ['migrate'])
  rep.migrate = { status: mig.status, ok: mig.json?.ok ?? null, wallMs: Date.now() - t0, counts: mig.json?.counts ?? null, warnings: mig.json?.warnings ?? null, btw: mig.json?.btw ?? null }
  if (!mig.json?.ok) {
    fail('마이그레이션 실패', { status: mig.status, stderr: mig.stderr.slice(0, 500) })
    writeResult('m2-r1-migrate.json', rep)
    console.log(JSON.stringify(rep, null, 2))
    process.exit(1)
  }

  const after = v3Units(home)
  rep.after = { files: after.units.size, inIndex: after.order.length, orphanFiles: after.orphanFiles, missingFiles: after.missingFiles }

  // C1 — 원본 대화가 하나도 안 사라졌는가(스레드 바이트 기준)
  const lostThreads = []
  const leafLosses = []
  for (const u of before) {
    if (u.broken) continue
    const t = after.units.get(u.id)
    if (!t) {
      lostThreads.push({ key: u.key, id: u.id, msgs: u.msgs, why: '대상 파일 없음' })
      continue
    }
    if (t.threadBytes !== u.threadBytes) lostThreads.push({ key: u.key, id: u.id, before: u.msgs, after: t.msgs, why: '스레드 바이트 불일치' })
    const ll = leafAudit(u, t)
    if (ll.length) leafLosses.push({ key: u.key, id: u.id, lost: ll })
  }
  rep.threads = { compared: before.filter((u) => !u.broken).length, lost: lostThreads.length, detail: lostThreads.slice(0, 10) }
  if (lostThreads.length) fail('대화 소실', { count: lostThreads.length, sample: lostThreads.slice(0, 5) })
  rep.leafAudit = { chatsWithLoss: leafLosses.length, sample: leafLosses.slice(0, 8) }
  if (leafLosses.length) fail('원본 리프 소실(매핑표 밖)', { count: leafLosses.length, sample: leafLosses.slice(0, 5) })

  // C2 — 정체성 1차(내 미러 ↔ 디스크). 빌더 미러와 독립.
  const id1 = { compared: 0, mismatch: [] }
  for (const u of before) {
    if (u.broken) continue
    const t = after.units.get(u.id)
    if (!t) continue
    const mine = myRawIdentity(u.rec, u.source, g)
    id1.compared++
    if (canon(mine) !== canon(t.identity)) id1.mismatch.push({ id: u.id, mine, disk: t.identity })
  }
  rep.identityPrimary = { compared: id1.compared, mismatch: id1.mismatch.length, sample: id1.mismatch.slice(0, 3) }
  if (id1.mismatch.length) fail('정체성 1차 불일치(크리틱 미러)', { count: id1.mismatch.length, sample: id1.mismatch.slice(0, 2) })

  // C3 — 파일-인덱스 정합
  if (after.orphanFiles.length) fail('index에 없는 chats-v3 파일', { files: after.orphanFiles })
  if (after.missingFiles.length) fail('index가 가리키는데 없는 파일', { files: after.missingFiles })

  // C4 — 옛 디렉터리 보존 + 백업
  const backup = mig.json.backupDir
  rep.rollback = {
    oldDirsPresent: ['chats', 'multi-agent', 'session-chats'].filter((d) => fs.existsSync(path.join(home, d))),
    backupDir: backup ?? null,
    backupExists: !!backup && fs.existsSync(backup),
    backupHasChats: !!backup && fs.existsSync(path.join(backup, 'chats'))
  }
  if (!rep.rollback.backupExists) fail('백업 없음', rep.rollback)

  // C5 — status.json의 상태가 원본과 같은가(§5.2 마지막 행)
  const statuses = readJSON(path.join(home, 'chats-v3', 'status.json'))?.statuses ?? {}
  const statusBad = []
  for (const u of before) {
    if (u.broken) continue
    const want = u.source === 'session' ? (u.rec?.status ?? 'idle') : (u.rec?.snapshot?.status ?? 'idle')
    const got = statuses[u.id]?.status ?? null
    if (want !== got) statusBad.push({ id: u.id, want, got })
  }
  rep.status = { compared: before.length, mismatch: statusBad.length, sample: statusBad.slice(0, 5) }
  if (statusBad.length) fail('status.json 상태 불일치', { count: statusBad.length, sample: statusBad.slice(0, 3) })

  // C6 — 재마이그레이션이 3.0에서 바뀐 내용을 덮는가(멱등성의 **내용** 판정)
  //      빌더 하네스는 채팅 수·id 집합만 본다.
  const victim = [...after.units.keys()][0]
  let clobber = null
  if (victim) {
    const f = path.join(home, 'chats-v3', `${victim}.json`)
    const rec = readJSON(f)
    const marked = { ...rec, title: '★크리틱이 3.0에서 바꾼 제목', snapshot: { ...(rec.snapshot ?? {}), messages: [...(rec.snapshot?.messages ?? []), { id: 'critic-new', role: 'user', text: '3.0에서 추가한 메시지' }] } }
    fs.writeFileSync(f, JSON.stringify(marked))
    const before2 = sha(canon(marked))
    cli(home, ['migrate', '--no-backup']) // is_migrated 무시하고 강제 재실행(안내 카드 경로가 부를 코드)
    const rec2 = readJSON(f)
    clobber = {
      chatId: victim,
      titleAfter: rec2?.title ?? null,
      msgsBefore: marked.snapshot.messages.length,
      msgsAfter: Array.isArray(rec2?.snapshot?.messages) ? rec2.snapshot.messages.length : null,
      clobbered: sha(canon(rec2)) !== before2
    }
    if (clobber.clobbered) fail('재마이그레이션이 3.0의 변경을 덮어씀', clobber)
  }
  rep.remigrationClobber = clobber

  rep.ok = rep.findings.length === 0
  const out = writeResult('m2-r1-migrate.json', rep)
  console.log(JSON.stringify({ ok: rep.ok, findings: rep.findings.map((f) => f.item), out }, null, 2))
  process.exit(rep.ok ? 0 : 1)
}

main()
