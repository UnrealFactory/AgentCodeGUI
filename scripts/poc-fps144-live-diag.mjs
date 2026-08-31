// 진단 — 3.0 라이브 스트리밍 팔이 314ms 만에 끝나는 이유(2폴이면 busy가 이미 내려갔다).
// 2.6.2는 같은 프롬프트로 4046ms를 돈다. 두 앱의 busy 판정자가 다르면 스트리밍 팔은
// **서로 다른 것을 재고 있는** 것이라, 눈금이 성립하지 않는다.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { tauriProfile, connectMainPage, killTree, sleep, REPO } from '../bench/lib.mjs'
import { makeMultiFixture } from '../bench/fixture.mjs'

const SIM = path.join(process.env.LOCALAPPDATA, 'ccg-fps144')
const profile = tauriProfile({ exe: process.env.DIAG_EXE || path.join(SIM, 'AgentCodeGUI3.exe'), port: 11113 })
profile.env.CCG_HOME = path.join(REPO, '.bench-home-fps144diag')
profile.cwd = SIM
fs.rmSync(profile.env.CCG_HOME, { recursive: true, force: true })
makeMultiFixture(profile.env.CCG_HOME, '3.0.0-beta.1', { panels: 4 })
// R1 가설(**기각됨**): 「토큰 복호화가 실패해 CLI가 빈 설정 폴더를 받는다」 — 아니다.
// 복호화는 이 경로에서 **호출되지도 않는다**(`ccg-engine`은 `ccg-auth` 의존조차 없다).
// 그리고 지워도 실 `~/.claude`로 안 떨어진다 — `ident.rs`가 default_account를 못 찾아
// `IdentityError::AccountUnavailable`로 스폰이 **거절**된다(그래서 턴이 아예 안 열린다).
// 진짜 기전은 아래 DIAG_ACCTDIR 팔의 머리말에 있다.
if (process.env.DIAG_NOACCT) {
  for (const f of ['accounts.json', 'codex-accounts.json', 'api-config.json']) {
    fs.rmSync(path.join(profile.env.CCG_HOME, f), { force: true })
  }
  console.log('accounts.json 제거 팔')
}

// ── ★R2 팔: 계정 **설정 폴더**를 격리 홈에 심는다 ────────────────────────────
// R1은 「격리 홈에서 실계정 턴은 3.0에서 못 쓴다」로 닫았고, 크리틱은 safe_storage가
// 격리 홈 키를 먼저 읽도록 **설계돼 있다**며 오분류를 의심했다. 둘 다 빗나갔다 —
// 진짜 기전은 **슬러그 불일치**다:
//   · `ccg-auth::account_slug()`      → `lmg56632_gmail.com-1to4267` (이메일 + base36 해시)
//   · `ccg-engine::Runtime::account_dir()` (runtime.rs:606-621) → 해시 **없는** 이름을 만들고
//     `<home>/accounts`를 훑어 `slug-`로 시작하는 폴더를 찾는 폴백에 기댄다.
// 실홈에는 로그인이 만들어 둔 폴더가 있어 폴백이 맞고, **격리 홈에는 `accounts/`가 아예
// 없어** 폴백이 실패한다. 그러면 존재하지 않는 경로가 그대로 `CLAUDE_CONFIG_DIR`로 나가고
// (driver.rs:141) CLI가 그걸 빈 폴더로 만들며 "Not logged in"을 찍는다. 복호화는 애초에
// 호출되지도 않는다(ccg-engine은 ccg-auth 의존조차 없다).
//
// 그래서 이 팔은 **로그인 파일만** 같은 슬러그 이름으로 복사한다(sessions/projects 등
// 커다란 산출물은 제외 — 실홈은 읽기만 하고 절대 안 건드린다).
if (process.env.DIAG_ACCTDIR) {
  const realAccts = path.join(os.homedir(), '.agentcodegui', 'accounts')
  const dst = path.join(profile.env.CCG_HOME, 'accounts')
  let n = 0
  for (const slug of (fs.existsSync(realAccts) ? fs.readdirSync(realAccts) : [])) {
    const from = path.join(realAccts, slug)
    if (!fs.statSync(from).isDirectory()) continue
    fs.mkdirSync(path.join(dst, slug), { recursive: true })
    for (const f of ['.credentials.json', '.claude.json', 'settings.json', 'settings.local.json']) {
      const src = path.join(from, f)
      if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dst, slug, f)); n++ }
    }
  }
  console.log(`계정 설정 폴더 이식 팔 — ${n}개 파일`)
}

const child = spawn(profile.cmd, profile.args, { env: { ...process.env, ...profile.env }, cwd: profile.cwd, stdio: 'ignore' })
const cdp = await connectMainPage(profile.port, { timeoutMs: 45000 })
for (;;) { if (await cdp.eval(profile.mountExpr).catch(() => false)) break; await sleep(100) }
await sleep(6000)

const sent = await cdp.eval(`(async () => {
  const p = document.querySelector('.ma-panel')
  const ta = p.querySelector('textarea'); const btn = p.querySelector('button.send')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '1부터 200까지 한 줄에 하나씩, 설명 없이 숫자만 세어줘.')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 200))
  const dis = btn.disabled
  if (!dis) btn.click()
  return { disabled: dis }
})()`, { awaitPromise: true })
console.log('sent:', JSON.stringify(sent))

for (let i = 0; i < 40; i++) {
  const s = await cdp.eval(`(() => {
    const p = document.querySelector('.ma-panel')
    const c = p.querySelector('.composer')
    const msgs = p.querySelectorAll('.ma-p-thread .msg')
    const last = msgs[msgs.length - 1]
    return {
      composerCls: c ? c.className : null,
      scheduling: document.querySelectorAll('.ma-panel .composer.scheduling').length,
      msgs: msgs.length,
      lastLen: last ? last.textContent.length : 0,
      lastTail: last ? last.textContent.slice(-60) : null
    }
  })()`)
  console.log(i, JSON.stringify(s))
  await sleep(1000)
}

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)
if (shot) fs.writeFileSync(path.join(REPO, 'bench', 'scratch', 'fps144-diag-live.png'), Buffer.from(shot.data, 'base64'))
cdp.close()
await sleep(500)
killTree(child.pid)
