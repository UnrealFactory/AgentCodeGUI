/**
 * PoC — 채팅 스토어 병합 의미론(ccg-store::chats)이 2.6.2와 같은지 실측한다.
 * **여기가 깨지면 사용자의 대화가 통째로 증발한다.** 2.6.2에도 같은 이유로
 * scripts/poc-chats-merge.mjs가 있다 — 이건 그 Rust판(앱을 실제로 띄워 왕복시킨다).
 *
 *   node scripts/poc-tauri-chats.mjs
 *
 * 검사:
 *   1) 부팅 조회(light) → 그대로 저장하면 파일이 바뀌지 않는다(내용 동일 = 저장 스킵)
 *   2) unloaded 마커(스냅샷 없이 메타만)를 저장해도 디스크의 스냅샷이 살아남는다
 *   3) 새 채팅 추가 → 파일 생성 + index.order 반영
 *   4) 채팅 제거 → 그 파일이 지워진다(prune)
 * 홈은 .poc-home-chats로 매번 새로 만든다(픽스처는 .bench-home-tauri에서 복사).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { connectMainPage, sleep, killTree, REPO } from '../bench/lib.mjs'

const SRC = path.join(REPO, '.bench-home-tauri')
const HOME = path.join(REPO, '.poc-home-chats')
const EXE = path.join(REPO, 'target', 'release', 'agentcodegui.exe')
const PORT = 9349

fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(path.join(HOME, 'chats'), { recursive: true })
for (const f of fs.readdirSync(path.join(SRC, 'chats'))) {
  fs.copyFileSync(path.join(SRC, 'chats', f), path.join(HOME, 'chats', f))
}
fs.copyFileSync(path.join(SRC, 'profile.json'), path.join(HOME, 'profile.json'))

const chatFile = (id) => path.join(HOME, 'chats', `${id}.json`)
const msgCount = (id) => {
  try {
    return JSON.parse(fs.readFileSync(chatFile(id), 'utf8')).snapshot?.messages?.length ?? null
  } catch {
    return null
  }
}
const indexOf = () => JSON.parse(fs.readFileSync(path.join(HOME, 'chats', 'index.json'), 'utf8'))

const child = spawn(EXE, [], {
  env: { ...process.env, CCG_HOME: HOME, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: 'ignore'
})
const out = {}
try {
  const cdp = await connectMainPage(PORT, { timeoutMs: 45000 })
  for (let i = 0; i < 150; i++) {
    if (await cdp.eval(`typeof window.api === 'object'`).catch(() => false)) break
    await sleep(100)
  }
  const run = async (expr) => JSON.parse(await cdp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))

  const id = indexOf().order[0]
  out.fixture = { id, msgsOnDisk: msgCount(id) }

  // 1) 그대로 저장 = 파일 무변경
  const before = fs.readFileSync(chatFile(id), 'utf8')
  out.roundTrip = await run('((c) => ({ ids: c.chats.map(x => x.id), msgs: c.chats.map(x => x.snapshot?.messages?.length ?? null) }))(window.__blob = await window.api.getChats())')
  await run('(await window.api.saveChats(window.__blob), "saved")')
  await sleep(400)
  out.unchangedAfterIdenticalSave = fs.readFileSync(chatFile(id), 'utf8') === before

  // 2) unloaded 마커 저장 → 디스크 스냅샷 보존
  await run(
    '(await window.api.saveChats({ ...window.__blob, chats: window.__blob.chats.map((c) => ({ ...c, snapshot: null, unloaded: true })) }), "saved")'
  )
  await sleep(400)
  out.snapshotSurvivesUnloadedSave = msgCount(id)
  out.unloadedKeyNotPersisted = !('unloaded' in JSON.parse(fs.readFileSync(chatFile(id), 'utf8')))

  // 3) 새 채팅 추가
  await run(
    '(await window.api.saveChats({ ...window.__blob, chats: [...window.__blob.chats, { id: "poc-new-chat", title: "새 채팅", snapshot: { messages: [{ id: "m1", role: "user", text: "hi" }] } }] }), "saved")'
  )
  await sleep(400)
  out.newChatWritten = { file: fs.existsSync(chatFile('poc-new-chat')), msgs: msgCount('poc-new-chat'), order: indexOf().order }
  out.originalStillIntact = msgCount(id)

  // 4) 제거 → prune
  await run('(await window.api.saveChats({ ...window.__blob, chats: window.__blob.chats }), "saved")')
  await sleep(400)
  out.prunedRemovedChat = !fs.existsSync(chatFile('poc-new-chat'))
  out.afterPrune = { order: indexOf().order, msgs: msgCount(id) }
  cdp.close()
} catch (e) {
  out.error = String(e?.message ?? e)
} finally {
  killTree(child.pid)
}
console.log(JSON.stringify(out, null, 2))
