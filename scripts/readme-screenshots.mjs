// Capture the actual bundled app with an isolated, fictional demo project.
// No account data or model requests. Run after npm run tauri:build.
// node scripts/readme-screenshots.mjs [--exe=target/release/AgentCodeGUI3.exe]
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { connectMainPage, killTree, quietHome, REPO, sleep } from '../bench/lib.mjs'
import { HELPERS_JS, makeCtx } from '../bench/screens.mjs'

const exe = path.resolve(process.argv.find(a => a.startsWith('--exe='))?.slice(6) ?? 'target/release/AgentCodeGUI3.exe')
const version = JSON.parse(fs.readFileSync(path.join(REPO, 'src-tauri/tauri.conf.json'))).version
const output = path.join(REPO, 'docs/images')
fs.mkdirSync(output, { recursive: true })
const root = fs.mkdtempSync(path.join(REPO, '.poc-home-readme-'))
const work = path.join(REPO, 'target/readme-demo/Orbit')
const write = (base, name, data) => {
  const file = path.join(base, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data))
}
const dashboard = `<!doctype html><html lang="ko"><meta charset="utf-8"><title>Orbit — Team workspace</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f6f8;color:#172422;font:14px/1.6 'Segoe UI',sans-serif}
main{max-width:1080px;margin:auto;padding:38px 42px}nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:42px}
.logo{font-size:23px;font-weight:800;letter-spacing:-1px}.logo i{color:#218c70;font-style:normal}nav span{color:#65756d;font-size:12px}
h1{font-size:31px;letter-spacing:-1.2px;margin:0}p{color:#748079;margin:7px 0 28px}.head{display:flex;justify-content:space-between;align-items:center}
button{background:#1e705a;color:white;border:0;border-radius:9px;padding:11px 18px;font-weight:600}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:24px 0}
.card{background:white;border:1px solid #e5eae7;border-radius:14px;padding:20px}.label{font-size:12px;color:#718078}.num{font-size:32px;font-weight:650;margin:7px 0}.small{font-size:12px;color:#218567}
.columns{display:grid;grid-template-columns:1.65fr 1fr;gap:18px}h2{font-size:16px;margin:0 0 16px}.row{display:flex;align-items:center;gap:12px;padding:13px 0;border-top:1px solid #eff2f0}
.check{color:#248b6b;width:22px;height:22px;border-radius:7px;background:#e9f5ef;text-align:center}.name{flex:1}.name small{display:block;font-size:11px;color:#829087}.pill{background:#edf7f1;color:#298666;border-radius:5px;font-size:10px;padding:3px 7px}
.bars{height:145px;display:flex;gap:14px;align-items:end;padding-top:16px}.bar{flex:1;background:#d7e9e0;border-radius:5px 5px 0 0}.bar:last-child{background:#338b6d}.days{display:flex;justify-content:space-around;font-size:10px;color:#8a9690;margin-top:8px}
.foot{margin-top:24px;color:#89948f;font-size:11px}
</style><main><nav><div class="logo"><i>◉</i> orbit</div><span>WORKSPACE &nbsp; / &nbsp; PRODUCT TEAM</span></nav>
<div class="head"><div><h1>팀의 오늘을 한눈에.</h1><p>아이디어에서 완료까지, 우리 팀의 작업 공간</p></div><button>+ 새 작업</button></div>
<div class="stats"><div class="card"><div class="label">이번 주 완료</div><div class="num">24 <span class="small">개</span></div><div class="small">지난주보다 6개 더 완료했어요</div></div><div class="card"><div class="label">진행 중인 작업</div><div class="num">8 <span class="small">개</span></div><div class="small">3개의 프로젝트에서 작업 중</div></div><div class="card"><div class="label">목표 달성률</div><div class="num">75<span class="small">%</span></div><div class="small">이번 주 목표에 가까워지고 있어요</div></div></div>
<div class="columns"><div class="card"><h2>진행 중인 작업</h2><div class="row"><span class="check">✓</span><span class="name">대시보드 레이아웃<small>디자인 · 오늘</small></span><span class="pill">완료</span></div><div class="row"><span class="check">↗</span><span class="name">프로젝트 API 연결<small>개발 · 내일</small></span><span class="pill">진행 중</span></div><div class="row"><span class="check">○</span><span class="name">모바일 화면 점검<small>리뷰 · 금요일</small></span><span class="pill">예정</span></div></div>
<div class="card"><h2>이번 주 활동</h2><div class="bars"><div class="bar" style="height:40%"></div><div class="bar" style="height:62%"></div><div class="bar" style="height:48%"></div><div class="bar" style="height:78%"></div><div class="bar" style="height:96%"></div></div><div class="days"><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span></div></div></div><div class="foot">ORBIT · EXAMPLE PROJECT</div></main></html>`
write(work, 'index.html', dashboard)
write(work, 'src/dashboard.ts', `export interface Task {\n  id: string\n  title: string\n  status: 'planned' | 'active' | 'done'\n}\n\nexport function summarize(tasks: Task[]) {\n  const completed = tasks.filter(task => task.status === 'done')\n  const active = tasks.filter(task => task.status === 'active')\n\n  return {\n    total: tasks.length,\n    completed: completed.length,\n    active: active.length,\n    progress: tasks.length === 0\n      ? 0\n      : Math.round(completed.length / tasks.length * 100)\n  }\n}\n`)
write(work, 'src/dashboard.css', ':root { --accent: #218c70; --surface: #f5f6f8; }\n.dashboard { display: grid; gap: 24px; }\n')
write(work, 'src/api/projects.ts', 'export async function getProjects() {\n  const response = await fetch("/api/projects")\n  if (!response.ok) throw new Error("Projects unavailable")\n  return response.json()\n}\n')
write(work, 'tests/dashboard.test.ts', '// Orbit demo: empty state, completed tasks, active tasks.\n')
write(work, 'README.md', '# Orbit\n\n팀 작업을 정리하는 대시보드 예제입니다.\n\n- 작업 목록\n- 주간 활동\n- 프로젝트 진행률\n')
write(work, 'package.json', { name: 'orbit-web', version: '1.0.0', private: true })
for (const args of [['init', '-b', 'main'], ['add', '.'], ['-c', 'user.name=Orbit Demo', '-c', 'user.email=demo@example.invalid', 'commit', '--allow-empty', '-m', 'Seed example project']]) {
  execFileSync('git', args, { cwd: work, stdio: 'ignore' })
}
fs.appendFileSync(path.join(work, 'src/dashboard.css'), '.summary-card { border-radius: 14px; }\n')
const time = '오후 2:30'
const message = (id, role, text) => ({ kind: 'msg', id, role, text, animate: false, time })
const files = [{ path: 'src/dashboard.ts', add: 19, del: 3, tag: 'edit' }, { path: 'src/dashboard.css', add: 8, del: 2, tag: 'edit' }, { path: 'index.html', add: 42, del: 0, tag: 'new' }]
const tool = (id, verb, kind, target, result, extra = {}) => ({ id, verb, kind, target, result, status: 'done', ...extra })
const conversations = [
  [message('u1', 'user', '팀 작업을 한눈에 보는 대시보드를 만들어줘. 작업 목록, 주간 활동, 진행률을 넣고 초록색 포인트로 깔끔하게 정리해줘.'),
    message('a1', 'assistant', '프로젝트 구조를 확인하고, 요약 카드와 작업 목록을 한 화면에 배치하겠습니다.'),
    { kind: 'toolgroup', id: 'tg1', time, tools: [tool('read', 'Read', 'read', 'src/dashboard.ts', '19줄'), tool('edit', 'Edit', 'edit', files.map(f => f.path).join(', '), '파일 3개 · +69 −5', { files })] },
    { kind: 'worked', id: 'w1', ms: 38000, time },
    message('a2', 'assistant', '대시보드 화면을 정리했습니다.\n\n- **진행 상황** — 완료·진행 중·목표 달성률을 카드로 표시\n- **작업 목록** — 상태와 일정을 한눈에 확인\n- **주간 활동** — 요일별 작업량을 막대로 표시\n\n`index.html`을 열면 앱 안에서 바로 미리 볼 수 있습니다.')],
  [message('u2', 'user', '프로젝트 목록 API에 오류 처리와 빈 상태를 추가해줘.'),
    message('a3', 'assistant', '응답 상태를 먼저 확인하고, 실패한 요청은 화면에서 다시 시도할 수 있도록 정리하겠습니다.'),
    { kind: 'toolgroup', id: 'tg2', time, tools: [tool('api-read', 'Read', 'read', 'src/api/projects.ts', '6줄'), tool('api-edit', 'Edit', 'edit', 'src/api/projects.ts', '+12 −3')] },
    { kind: 'worked', id: 'w2', ms: 21000, time },
    message('a4', 'assistant', 'API 연결을 정리했습니다.\n\n- 실패한 응답은 오류 상태로 전달\n- 프로젝트가 없으면 빈 목록 반환\n- 화면에서 다시 시도할 수 있도록 처리')],
  [message('u3', 'user', '대시보드 계산 로직을 검토하고 테스트 항목을 정리해줘.'),
    message('a5', 'assistant', '작업이 없을 때와 모든 작업이 끝난 경우를 중심으로 확인하겠습니다.'),
    { kind: 'toolgroup', id: 'tg3', time, tools: [tool('test-read', 'Read', 'read', 'src/dashboard.ts', '19줄'), tool('test-edit', 'Edit', 'edit', 'tests/dashboard.test.ts', '+24')] },
    { kind: 'worked', id: 'w3', ms: 16000, time },
    message('a6', 'assistant', '확인할 항목을 정리했습니다.\n\n- 작업이 없으면 진행률 **0%**\n- 모든 작업이 완료되면 **100%**\n- 진행 중·완료 작업을 각각 집계\n\n이 세 경우를 테스트로 남기면 계산 로직을 바꿀 때 비교하기 쉽습니다.')]
]
const snapshot = i => ({ status: 'done', messages: conversations[i], files: i === 0 ? files : [], diffs: {}, todos: [], subagents: [], bgTasks: [], session: null, seq: 20, shownNotices: [] })

for (const count of [1, 3]) {
  const home = path.join(root, `home-${count}`)
  quietHome(home)
  write(home, 'profile.json', { nickname: 'Orbit Studio', color: '#4baf91' })
  write(home, 'ui-prefs.json', { 'ui.lang': 'ko', 'workspace.mode': 'multi', 'whatsnew.seenVersion': version, 'sidebar.autohide': false, 'chat.zoom': 1, 'viewer.size': { w: 1080, h: 740 } })
  write(home, 'multi-agent/index.json', { version: 2, order: ['orbit'], activeSessionId: 'orbit' })
  write(home, 'multi-agent/orbit.json', { id: 'orbit', title: 'Orbit · 팀 대시보드', count, panels: [0, 1, 2].map(i => ({
    title: ['화면 제작', 'API 연결', '코드 리뷰'][i], custom: true, cwd: work,
    picker: { engine: i === 1 ? 'codex' : 'claude', codexModel: 'gpt-5.6-terra', model: i === 2 ? 'sonnet' : 'opus', effort: 'medium', mode: 'normal' }, snapshot: snapshot(i)
  })) })
  const port = 19393 + count
  const app = spawn(exe, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, CCG_HOME: home, CCG_NO_NET: '1', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } })
  let cdp
  try {
    cdp = await connectMainPage(port)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: count === 1 ? 1440 : 1680, height: 820, deviceScaleFactor: 2, mobile: false })
    await cdp.eval(HELPERS_JS)
    const ctx = makeCtx(cdp)
    await ctx.waitFor('.ma-panel .composer textarea', 15000, count)
    await sleep(1300)
    await ctx.tryClickText('button', '나중에')
    await ctx.tryClickText('button', '시작하기')
    await ctx.click('[data-tool-id="edit"]')
    await sleep(350)
    async function shot(name) {
      await cdp.eval('document.activeElement?.blur()')
      await sleep(350)
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(output, name), Buffer.from(data, 'base64'))
      console.log(name)
    }
    if (count === 1) {
      await ctx.openExplorer()
      await shot('workspace.png')
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false })
      await ctx.click('.t-file', 2)
      await ctx.waitFor('.fv-overlay iframe', 12000)
      await sleep(700)
      await shot('preview.png')
      await ctx.esc()
      await cdp.eval(`window.dispatchEvent(new CustomEvent('ccg-open-patchnotes'))`)
      await ctx.waitFor('.pncard')
      for (const v of ['3.0.10', '3.0.9', '3.0.8', '3.0.7']) {
        await ctx.clickText('.pn-vbtn', `v${v}`)
        const lengths = await cdp.eval(`Array.from(document.querySelectorAll('.pn-desc')).map(el=>el.textContent.length)`)
        if (!lengths.length || lengths.some(n => n > 240)) throw new Error(`Patch notes too long: ${v}`)
      }
      console.log('Patch note tabs 3.0.7–3.0.10 verified')
    } else {
      await shot('multi-agent.png')
    }
  } finally {
    cdp?.close()
    killTree(app.pid)
  }
}
console.log(JSON.stringify({ output, fixture: root, version }))
