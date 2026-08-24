#!/usr/bin/env node
/* ============================================================================
 * poc-git-aimsg — `git:ai-message`(최종 파리티 M5)의 실물 실측.
 *
 * 크리틱 R2의 판정:
 *   > M5 git:ai-message는 여전히 {"__unimplemented":true}. 미룬 근거는 사실로 확인
 *   > (claude.exe 0.3.241 --help에 turns 0회, 도구는 허용/거부 목록뿐)이나
 *   > **화면 버튼은 죽어 있다.**
 *
 * R3에서 그 근거의 절반이 틀렸다는 것을 SDK 본체에서 확인했다:
 *   `sdk.mjs`  →  if (u) Y.push("--max-turns", u.toString())   ← CLI 플래그다(숨은 플래그)
 *                 if (St.length > 0) Y.push("--allowedTools", …) ← 빈 배열이면 **아무것도 안 붙는다**
 * 즉 2.6.2의 "도구 없는 1턴"을 실제로 만든 것은 `--max-turns 1` 하나이고, 그 플래그는
 * `--help`에 없을 뿐 **있다**. 이 하네스가 그 둘을 각각 잰다.
 *
 * 재는 것:
 *   A. 설치본 `claude.exe`가 `--max-turns`를 **받는가**(대조군: 진짜 없는 플래그).
 *      API 호출 0건 — 빈 stdin으로 플래그 파싱까지만 시킨다.
 *   B. `git:ai-message`가 `{ok:true, subject, body}`를 내는가(가짜 CLI 대본).
 *   C. 엔진에 **실제로 나간 argv**에 `--max-turns 1`·`--model`·`--permission-mode`가
 *      있고 `--allowedTools`는 **없는가**(2.6.2가 실제로 보낸 그대로인가).
 *   D. 프롬프트가 diff·톤(최근 커밋 제목)·마커 블록을 싣는가.
 *   E. 실패 경로가 **문장으로** 착지하는가(파일 0개 · 저장소 아님) — 침묵 금지(D7).
 *
 * ── 안전 규칙 ───────────────────────────────────────────────────────────────
 *  · 실계정 0건: 계정은 `ccg-auth-probe seed`가 만든 합성 자격이고 `CCG_NO_NET=1`이다.
 *  · 엔진은 **가짜 CLI**다 — 실 모델 호출 0건, 토큰 0원.
 *  · 이름 기반 kill 금지 — 죽이는 것은 spawn한 PID 트리뿐.
 *
 *   node scripts/poc-git-aimsg.mjs [--exe=…] [--keep] [--out=…]
 * ========================================================================== */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO } from '../bench/lib.mjs'

const args = process.argv.slice(2)
const KEEP = args.includes('--keep')
const argOf = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) ?? '').split('=')[1] || d
const HOME = path.join(REPO, '.poc-home-aimsg-t3t4')
const PORT = 9427
const OUT = argOf('out', path.join(REPO, 'docs', 'critic', 'git-aimsg-t3t4-r3.json'))
const EXE = argOf('exe', path.join(REPO, 'target-t3t4', 'release', 'agentcodegui.exe'))
const FAKECLI = argOf('fakecli', path.join(REPO, 'target-t3t4', 'release', 'ccg-fakecli.exe'))
const PROBE = argOf('probe', path.join(REPO, 'target-t3t4', 'release', 'ccg-auth-probe.exe'))
const EMAIL = 'aimsg-seed@t3t4.test'

const rep = { at: new Date().toISOString(), exe: EXE, steps: {}, findings: [] }
let pass = 0
const ok = (id, detail) => {
  pass++
  console.log(`  ✓ ${id}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
}
const fail = (id, why, extra) => {
  rep.findings.push({ id, why, ...(extra ?? {}) })
  console.error(`  ✗ ${id} — ${why}${extra ? ` ${JSON.stringify(extra)}` : ''}`)
}
const check = (id, cond, why, extra) => (cond ? ok(id, extra) : fail(id, why, extra))

const rmrf = (p) => {
  for (let i = 0; i < 10; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
      return
    } catch {
      spawnSync('cmd', ['/c', 'ping', '127.0.0.1', '-n', '2'], { stdio: 'ignore' })
    }
  }
}
const write = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2))
}
const REPO_DIR = path.join(HOME, 'repo')
const git = (...a) => spawnSync('git', a, { cwd: REPO_DIR, encoding: 'utf8' })

/** 실 API 0건으로 플래그의 존재만 가른다 — 빈 stdin이면 CLI는 파싱만 하고 죽는다. */
function flagAccepted(bin, extra) {
  const r = spawnSync(bin, ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...extra], {
    input: '',
    encoding: 'utf8',
    timeout: 45_000,
    env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(HOME, 'flagprobe') }
  })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  return { accepted: !/unknown option/i.test(out), out: out.slice(0, 200) }
}

function seedHome() {
  rmrf(HOME)
  fs.mkdirSync(HOME, { recursive: true })
  // 합성 계정의 credEnc는 Chromium OSCrypt 키로 풀린다 — 격리 userData로 옮겨야 한다.
  const ls = path.join(process.env.APPDATA ?? '', 'agent-code-gui', 'Local State')
  if (fs.existsSync(ls)) {
    const ud = path.join(HOME, 'userData')
    fs.mkdirSync(ud, { recursive: true })
    fs.copyFileSync(ls, path.join(ud, 'Local State'))
  }
  const r = spawnSync(PROBE, ['seed', EMAIL], { env: { ...process.env, CCG_HOME: HOME, CCG_NO_NET: '1' }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`ccg-auth-probe seed 실패: ${r.stderr || r.stdout}`)

  // 가짜 CLI를 엔진 자리에 — 실 모델 호출 0건.
  const engd = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(engd, { recursive: true })
  fs.copyFileSync(FAKECLI, path.join(engd, 'claude.exe'))
  write(path.join(HOME, 'config.json'), { activeVersion: 'fake' })
  write(path.join(HOME, 'ui-prefs.json'), { 'ui.lang': 'ko' })
  // 대본 — 모델이 서두를 붙이는 실제 습관까지 흉내 낸다(마커 밖 잡담).
  write(
    path.join(HOME, 'fake.jsonl'),
    [
      JSON.stringify({ emit: { type: 'system', subtype: 'init', session_id: 'S1', model: 'sonnet' } }),
      JSON.stringify({
        emit: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'S1',
          result: '아래와 같이 제안합니다.\n<commit>\n한도 재검증을 엔진에 배선한다\n\n조회 실패를 「풀림」으로 읽던 자리를 없앴다.\n대신 재확인 사다리를 붙였다.\n</commit>'
        },
        afterMs: 120
      }),
      JSON.stringify({ exit: 0 })
    ].join('\n')
  )

  // 톤이 있는 작은 저장소 하나 + 변경 하나.
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git('init', '-q')
  git('config', 'user.email', 'poc@t3t4.test')
  git('config', 'user.name', 'poc')
  write(path.join(REPO_DIR, 'a.txt'), '첫 줄\n둘째 줄\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'M11 R1 — 대기표를 세운다')
  write(path.join(REPO_DIR, 'b.txt'), 'b\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'M12 R1 — 설치본을 만든다')
  // 커밋 안 한 변경 = AI 메시지의 재료.
  write(path.join(REPO_DIR, 'a.txt'), '첫 줄\n바뀐 둘째 줄\n셋째 줄 추가\n')
}

const IPC = (channel, payload = []) =>
  `await window.__TAURI_INTERNALS__.invoke('ipc_call', { channel: ${JSON.stringify(channel)}, payload: ${JSON.stringify(payload)} })`

async function boot() {
  for (const [what, p] of [
    ['빌드된 exe', EXE],
    ['가짜 CLI', FAKECLI],
    ['auth probe', PROBE]
  ])
    if (!fs.existsSync(p)) throw new Error(`${what}가 없다: ${p}`)
  const child = spawn(EXE, [], {
    cwd: REPO,
    env: {
      ...process.env,
      CCG_HOME: HOME,
      CCG_CDP_PORT: String(PORT),
      CCG_NO_NET: '1',
      CCG_FAKECLI_SCRIPT: path.join(HOME, 'fake.jsonl'),
      CCG_FAKECLI_IN: path.join(HOME, 'stdin.log'),
      CCG_FAKECLI_ARGV: path.join(HOME, 'argv.json')
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  let log = ''
  child.stdout.on('data', (d) => (log += d.toString()))
  child.stderr.on('data', (d) => (log += d.toString()))
  const cdp = await connectMainPage(PORT, { timeoutMs: 60_000 })
  for (let i = 0; i < 400; i++) {
    const up = await cdp
      .eval(`(async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`, { awaitPromise: true })
      .catch(() => false)
    if (up) break
    await sleep(100)
  }
  const j = async (expr) =>
    JSON.parse(await cdp.eval(`(async () => JSON.stringify(await (${expr})) ?? 'null')()`, { awaitPromise: true, timeoutMs: 120_000 }))
  return { child, cdp, j, log: () => log }
}

const readOr = (p, d) => {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return d
  }
}

async function main() {
  seedHome()

  console.log('\n① 설치본이 --max-turns를 받는가 (실 API 0건 · 대조군 포함)')
  const real = path.join(process.env.USERPROFILE ?? '', '.agentcodegui', 'engines')
  const cand = fs.existsSync(real)
    ? fs
        .readdirSync(real)
        .map((v) => path.join(real, v, 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'))
        .filter((p) => fs.existsSync(p))
    : []
  if (!cand.length) {
    console.log('   (설치본 없음 — ①은 건너뛴다)')
    rep.steps.flagProbe = { skipped: true }
  } else {
    const bin = cand[cand.length - 1]
    const bogus = flagAccepted(bin, ['--ccg-bogus-flag', '1'])
    const turns = flagAccepted(bin, ['--max-turns', '1'])
    rep.steps.flagProbe = { bin, bogus, turns }
    check('A1 대조군: 없는 플래그는 거절된다', bogus.accepted === false, `대조군이 통과했다 — 이 검사는 무의미하다: ${bogus.out}`, { bogus })
    check('A2 ★ --max-turns는 --help에 없어도 실재한다', turns.accepted === true, `거절됐다: ${turns.out}`, { turns })
  }

  const app = await boot()
  const pid = app.child.pid
  try {
    console.log('\n② git:ai-message — 실제 호출')
    const r = await app.j(IPC('git:ai-message', [{ cwd: REPO_DIR, files: ['a.txt'], account: EMAIL, model: 'sonnet', effort: 'low' }]))
    rep.steps.result = r
    check('B1 ★ 미구현이 아니다', !r?.__unimplemented, '아직 __unimplemented다 — 버튼은 여전히 죽어 있다', { r })
    check('B2 ★ ok:true로 착지한다', r?.ok === true, JSON.stringify(r), { r })
    check('B3 제목은 마커 안의 한 줄이다(서두를 안 삼킨다)', r?.subject === '한도 재검증을 엔진에 배선한다', JSON.stringify(r?.subject), {
      subject: r?.subject
    })
    check('B4 본문은 마커 안의 나머지다', /재확인 사다리/.test(r?.body ?? ''), JSON.stringify(r?.body), { body: r?.body })

    console.log('\n③ 엔진에 실제로 나간 argv')
    const argv = JSON.parse(readOr(path.join(HOME, 'argv.json'), '[]'))
    rep.steps.argv = argv
    const a = argv.join(' ')
    check('C1 ★ --max-turns 1 (2.6.2의 「1턴」을 만든 유일한 레버)', / --max-turns 1(?: |$)/.test(` ${a} `), a, { argv })
    check('C2 --model sonnet', / --model sonnet(?: |$)/.test(` ${a} `), a, {})
    check('C3 --effort low (2.6.2 기본값)', / --effort low(?: |$)/.test(` ${a} `), a, {})
    check('C4 --permission-mode default', / --permission-mode default(?: |$)/.test(` ${a} `), a, {})
    check('C5 ★ --allowedTools는 **안 붙는다**(2.6.2의 빈 배열과 같은 바이트)', !/allowedTools/i.test(a), a, {})
    check('C6 stream-json 입출력(2.6.2 SDK와 같은 골격)', /--output-format stream-json/.test(a) && /--input-format stream-json/.test(a), a, {})

    console.log('\n④ 프롬프트가 실은 것')
    const stdin = readOr(path.join(HOME, 'stdin.log'), '')
    rep.steps.stdinHead = stdin.slice(0, 1500)
    check('D1 diff 헤더(+N −M)를 싣는다', /### a\.txt \(\+/.test(stdin), stdin.slice(0, 300), {})
    check('D2 변경 줄을 싣는다', /바뀐 둘째 줄/.test(stdin), '변경 줄이 없다', {})
    check('D3 ★ 저장소 톤(최근 커밋 제목)을 싣는다', /M12 R1 — 설치본을 만든다/.test(stdin), '톤 블록이 비었다', {})
    check('D4 마커 블록을 요구한다', /<commit>/.test(stdin) && /<\/commit>/.test(stdin), '마커 지시가 없다', {})
    check('D5 ctx 줄은 안 싣는다(프롬프트 예산)', !/\+첫 줄/.test(stdin), '안 바뀐 줄까지 실었다', {})

    console.log('\n⑤ 실패 경로도 문장으로 착지하는가 (침묵 금지)')
    const noFiles = await app.j(IPC('git:ai-message', [{ cwd: REPO_DIR, files: [] }]))
    const noRepo = await app.j(IPC('git:ai-message', [{ cwd: path.join(HOME, 'not-a-repo'), files: ['x'] }]))
    rep.steps.failures = { noFiles, noRepo }
    check('E1 파일 0개 → 이유가 있는 실패', noFiles?.ok === false && (noFiles?.error ?? '').length > 3, JSON.stringify(noFiles), { noFiles })
    check('E2 저장소 아님 → 이유가 있는 실패', noRepo?.ok === false && (noRepo?.error ?? '').length > 3, JSON.stringify(noRepo), { noRepo })
    check('E3 그 실패들은 엔진을 안 띄운다', JSON.parse(readOr(path.join(HOME, 'argv.json'), '[]')).join(' ') === argv.join(' '), 'argv가 갈렸다 = 또 스폰했다', {})
  } finally {
    try {
      app.cdp.close?.()
    } catch {
      /* ignore */
    }
    rep.steps.appLog = app.log().slice(-3000)
    killTree(pid)
    await sleep(500)
    if (!KEEP) rmrf(HOME)
  }
  rep.pass = pass
  rep.fail = rep.findings.length
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 2))
  console.log(`\n${rep.findings.length === 0 ? 'PASS' : 'FAIL'} — ${pass} 통과, ${rep.findings.length} 실패`)
  console.log(`리포트: ${OUT}`)
  process.exit(rep.findings.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
