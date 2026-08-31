// 진단 — 3.0 라이브 스트리밍 팔이 314ms 만에 끝나는 이유(2폴이면 busy가 이미 내려갔다).
// 2.6.2는 같은 프롬프트로 4046ms를 돈다. 두 앱의 busy 판정자가 다르면 스트리밍 팔은
// **서로 다른 것을 재고 있는** 것이라, 눈금이 성립하지 않는다.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { tauriProfile, connectMainPage, killTree, sleep, REPO } from '../bench/lib.mjs'
import { makeMultiFixture } from '../bench/fixture.mjs'

const SIM = path.join(process.env.LOCALAPPDATA, 'ccg-fps144')
const profile = tauriProfile({ exe: path.join(SIM, 'AgentCodeGUI3.exe'), port: 11113 })
profile.env.CCG_HOME = path.join(REPO, '.bench-home-fps144diag')
profile.cwd = SIM
fs.rmSync(profile.env.CCG_HOME, { recursive: true, force: true })
makeMultiFixture(profile.env.CCG_HOME, '3.0.0-beta.1', { panels: 4 })
// 가설: 3.0은 accounts.json이 있으면 CLAUDE_CONFIG_DIR을 물질화하는데, 격리 userData엔
// safeStorage 키가 없어 토큰 복호화가 실패 → CLI가 빈 설정 폴더를 받아 "Not logged in".
// 지우면 오버라이드가 없어 CLI가 사용자의 실 ~/.claude로 떨어진다(2.6.2 팔과 같은 상태).
if (process.env.DIAG_NOACCT) {
  for (const f of ['accounts.json', 'codex-accounts.json', 'api-config.json']) {
    fs.rmSync(path.join(profile.env.CCG_HOME, f), { force: true })
  }
  console.log('accounts.json 제거 팔')
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
