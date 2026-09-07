// README screenshots — the real bundled app, an isolated home, a fictional demo project.
// No account data, no network, no model calls. Engine turns come from the fake CLI stub.
//
//   npm run tauri:build                      (or tauri:build:unsigned)
//   cargo build -p ccg-engine --features fakecli --bin ccg-fakecli --release
//   node scripts/readme-screenshots.mjs [--exe=target/release/AgentCodeGUI3.exe] [--lang=ko,en] [--only=hero,multi,live,dialogs,details]
//
// Korean captures go to docs/images/*.png, English captures to docs/images/en/*.png.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { connectMainPage, killTree, quietHome, REPO, sleep } from '../bench/lib.mjs'
import { HELPERS_JS, makeCtx } from '../bench/screens.mjs'

const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
const exe = path.resolve(arg('exe', 'target/release/AgentCodeGUI3.exe'))
const langs = arg('lang', 'ko,en').split(',')
const only = arg('only', 'hero,multi,live,dialogs,details').split(',')
const version = JSON.parse(fs.readFileSync(path.join(REPO, 'src-tauri/tauri.conf.json'))).version
const fakeCli = ['target/release/ccg-fakecli.exe', 'target/debug/ccg-fakecli.exe']
  .map(p => path.join(REPO, p)).filter(fs.existsSync)
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
const root = fs.mkdtempSync(path.join(REPO, '.poc-home-readme-'))
// The viewer and Git headers show the absolute project path, so the demo project lives at a
// clean top-level path for the captures and is removed afterwards. Never touch a pre-existing one.
const DEMO = 'C:\\Orbit'
if (fs.existsSync(DEMO)) throw new Error(`${DEMO} already exists — choose an unused DEMO path`)
const demoPath = path.resolve(DEMO)
if (demoPath !== 'C:\\Orbit') throw new Error('Unexpected demo cleanup path')
process.on('exit', () => fs.rmSync(demoPath, { recursive: true, force: true }))
const write = (base, name, data) => {
  const file = path.join(base, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data))
  return file
}
const time = { ko: '오후 2:30', en: '2:30 PM' }
let portSeq = 19420

// ── Fixture copy ───────────────────────────────────────────────────────────────
const T = {
  ko: {
    session: 'Orbit · 팀 대시보드', panels: ['화면 제작', 'API 연결', '코드 리뷰'], nick: 'Orbit Studio',
    u1: '팀 작업을 한눈에 보는 대시보드를 만들어줘. 작업 목록, 주간 활동, 진행률을 넣고 초록색 포인트로 깔끔하게 정리해줘.',
    a1: '프로젝트 구조를 확인하고, 요약 카드와 작업 목록을 한 화면에 배치하겠습니다.',
    a2: '대시보드 화면을 정리했습니다.\n\n- **진행 상황** — 완료·진행 중·목표 달성률을 카드로 표시\n- **작업 목록** — 상태와 일정을 한눈에 확인\n- **주간 활동** — 요일별 작업량을 막대로 표시\n\n`index.html`을 열면 앱 안에서 바로 미리 볼 수 있습니다.',
    u2: '프로젝트 목록 API에 오류 처리와 빈 상태를 추가해줘.',
    a3: '응답 상태를 먼저 확인하고, 실패한 요청은 화면에서 다시 시도할 수 있도록 정리하겠습니다.',
    a4: 'API 연결을 정리했습니다.\n\n- 실패한 응답은 오류 상태로 전달\n- 프로젝트가 없으면 빈 목록 반환\n- 화면에서 다시 시도할 수 있도록 처리',
    u3: '대시보드 계산 로직을 검토하고 테스트 항목을 정리해줘.',
    a5: '작업이 없을 때와 모든 작업이 끝난 경우를 중심으로 확인하겠습니다.',
    a6: '확인할 항목을 정리했습니다.\n\n- 작업이 없으면 진행률 **0%**\n- 모든 작업이 완료되면 **100%**\n- 진행 중·완료 작업을 각각 집계\n\n이 세 경우를 테스트로 남기면 계산 로직을 바꿀 때 비교하기 쉽습니다.',
    lines: n => `${n}줄`, places: n => `${n}곳`, files3: '파일 3개 · +66 −4', passed: '3 passed',
    testOut: '✓ dashboard › 작업이 없으면 0%\n✓ dashboard › 모두 완료되면 100%\n✓ dashboard › 진행 중·완료 집계\n\n3 passed (1.2s)',
    todos: ['프로젝트 구조 파악', '요약 카드 구현', '작업 목록·주간 활동 구현', '테스트 작성', 'index.html 미리보기 확인'],
    subRole: '프로젝트 구조 조사', subAct: 'src/·tests/ 구조와 기존 스타일 토큰을 정리했어요',
    bgDesc: 'npm run dev — 개발 서버',
    commitMsg: '대시보드 요약 카드와 주간 활동 추가',
    commits: ['예제 프로젝트 시드', '프로젝트 API 스켈레톤', '대시보드 계산 로직 추가', '작업 목록 화면 정리'],
    // live workflow
    liveAsk: '대시보드 코드를 리뷰해줘. 접근성, 성능, 테스트를 각각 살펴보고 고쳐줘.',
    liveText: '리뷰를 세 단계 워크플로로 나눠서 진행할게요. 조사 → 개선 → 검증 순서로, 단계마다 에이전트를 나눠 띄우겠습니다.',
    liveTodos: ['접근성·성능 점검 에이전트 실행', '점검 결과 취합', '대비·포커스 링 수정', '차트 렌더 최적화', '회귀 테스트와 최종 리뷰'],
    liveTasks: [['접근성 점검', 'src/ 컴포넌트의 명도 대비와 포커스 표시를 점검하는 중'], ['성능 점검', '차트 렌더 횟수와 이미지 로딩을 측정하는 중']],
    liveBg: 'npm run dev — 개발 서버',
    wfSummary: '대시보드 리뷰 — 접근성·성능·테스트',
    phases: ['조사', '개선', '검증'],
    agents: [
      ['접근성 점검', 1, 'done', '대비 부족한 텍스트 4곳, 포커스 표시 누락 2곳'],
      ['성능 점검', 1, 'done', '차트 렌더 2회 중복, 이미지 지연 로딩 없음'],
      ['테스트 공백 조사', 1, 'done', '주간 경계·빈 데이터 케이스 미검증'],
      ['접근성 수정', 2, 'done', '대비 4곳·포커스 링 2곳 수정, 토큰 3개 추가'],
      ['성능 수정', 2, 'start', '차트 메모이즈, 이미지 lazy 로딩'],
      ['테스트 보강', 2, 'start', '주간 경계·빈 데이터 테스트 추가'],
      ['회귀 테스트', 3, 'queued', ''],
      ['최종 리뷰', 3, 'queued', '']
    ],
    // dialogs
    dlgAsk: '주간 활동 차트를 더 보기 좋게 다듬고 다크 모드도 검토해줘.',
    dlgText: '구현 전에 두 가지만 확인할게요.',
    q1: ['차트는 어떤 방식으로 그릴까요?', '차트', [['순수 SVG', '의존성 없음 · 가볍고 빠름'], ['Chart.js', '애니메이션·툴팁 내장'], ['Recharts', 'React 컴포넌트 · 반응형']]],
    q2: ['다크 모드도 함께 만들까요?', '테마', [['네, 시스템 설정 따라가기', 'prefers-color-scheme 사용'], ['아니요, 라이트만', '이번 작업은 차트만']]],
    dlgText2: '좋아요. 계획을 정리했습니다 — 검토해 주세요.',
    plan: `# 주간 활동 차트 개선 계획

## 목표
막대 차트를 **순수 SVG**로 다시 그리고, 시스템 설정을 따르는 다크 모드를 추가합니다.

## 단계
1. \`src/chart.ts\` — 막대·축·툴팁을 SVG로 렌더링하는 함수 작성
2. \`src/dashboard.css\` — \`prefers-color-scheme: dark\`용 색 토큰 추가
3. \`index.html\` — 차트 영역을 새 컴포넌트로 교체
4. \`tests/chart.test.ts\` — 빈 데이터·최대값·주간 경계 테스트

## 영향 범위
| 파일 | 변경 |
| --- | --- |
| src/chart.ts | 신규 |
| src/dashboard.css | +32 |
| index.html | ~20줄 |

승인하면 1단계부터 순서대로 진행합니다.
`
  },
  en: {
    session: 'Orbit · Team dashboard', panels: ['Screen', 'API', 'Review'], nick: 'Orbit Studio',
    u1: 'Build a dashboard that shows the team’s work at a glance: a task list, weekly activity, and progress, with clean green accents.',
    a1: 'I’ll check the project structure, then place summary cards and the task list on one screen.',
    a2: 'The dashboard is in place.\n\n- **Progress** — completed, active, and goal cards\n- **Task list** — status and schedule at a glance\n- **Weekly activity** — a bar per weekday\n\nOpen `index.html` to preview it right inside the app.',
    u2: 'Add error handling and an empty state to the projects API.',
    a3: 'I’ll check the response status first and make failed requests retryable from the screen.',
    a4: 'The API connection is tidied up.\n\n- Failed responses surface as an error state\n- No projects returns an empty list\n- The screen can retry the request',
    u3: 'Review the dashboard calculations and write down the test cases.',
    a5: 'I’ll focus on the empty case and the all-done case.',
    a6: 'Here is what to verify.\n\n- No tasks → progress **0%**\n- All tasks done → **100%**\n- Active and completed are counted separately\n\nKeeping these three as tests makes future changes easy to compare.',
    lines: n => `${n} lines`, places: n => `${n} matches`, files3: '3 files · +66 −4', passed: '3 passed',
    testOut: '✓ dashboard › 0% with no tasks\n✓ dashboard › 100% when all done\n✓ dashboard › counts active and completed\n\n3 passed (1.2s)',
    todos: ['Map the project structure', 'Build summary cards', 'Build task list and weekly activity', 'Write tests', 'Check the index.html preview'],
    subRole: 'Explore the project structure', subAct: 'Mapped src/ and tests/ and listed the existing style tokens',
    bgDesc: 'npm run dev — dev server',
    commitMsg: 'Add dashboard summary cards and weekly activity',
    commits: ['Seed example project', 'Project API skeleton', 'Add dashboard calculations', 'Tidy the task list screen'],
    liveAsk: 'Review the dashboard code. Check accessibility, performance, and tests separately, then fix what you find.',
    liveText: 'I’ll run this as a three-phase workflow: research → improve → verify, with separate agents in each phase.',
    liveTodos: ['Run accessibility and performance agents', 'Merge findings', 'Fix contrast and focus rings', 'Optimize chart rendering', 'Regression tests and final review'],
    liveTasks: [['Accessibility audit', 'Checking contrast ratios and focus indicators in src/ components'], ['Performance audit', 'Measuring chart render counts and image loading']],
    liveBg: 'npm run dev — dev server',
    wfSummary: 'Dashboard review — accessibility, performance, tests',
    phases: ['Research', 'Improve', 'Verify'],
    agents: [
      ['Accessibility audit', 1, 'done', '4 low-contrast texts, 2 missing focus indicators'],
      ['Performance audit', 1, 'done', 'Chart renders twice, images are not lazy-loaded'],
      ['Test gap survey', 1, 'done', 'Week-boundary and empty-data cases untested'],
      ['Accessibility fixes', 2, 'done', 'Fixed 4 contrast and 2 focus issues, added 3 tokens'],
      ['Performance fixes', 2, 'start', 'Memoize the chart, lazy-load images'],
      ['Test coverage', 2, 'start', 'Add week-boundary and empty-data tests'],
      ['Regression tests', 3, 'queued', ''],
      ['Final review', 3, 'queued', '']
    ],
    dlgAsk: 'Polish the weekly activity chart and look into dark mode.',
    dlgText: 'Two quick questions before I start.',
    q1: ['How should the chart be drawn?', 'Chart', [['Plain SVG', 'No dependencies · light and fast'], ['Chart.js', 'Built-in animation and tooltips'], ['Recharts', 'React components · responsive']]],
    q2: ['Should I add dark mode as well?', 'Theme', [['Yes, follow the system setting', 'Use prefers-color-scheme'], ['No, light only', 'Chart only for this task']]],
    dlgText2: 'Great. Here is the plan — please review it.',
    plan: `# Weekly activity chart plan

## Goal
Redraw the bar chart in **plain SVG** and add a dark mode that follows the system setting.

## Steps
1. \`src/chart.ts\` — render bars, axes, and tooltips as SVG
2. \`src/dashboard.css\` — add color tokens for \`prefers-color-scheme: dark\`
3. \`index.html\` — swap the chart area for the new component
4. \`tests/chart.test.ts\` — empty data, max value, and week-boundary cases

## Scope
| File | Change |
| --- | --- |
| src/chart.ts | new |
| src/dashboard.css | +32 |
| index.html | ~20 lines |

Once approved, I’ll work through the steps in order.
`
  }
}

// ── Demo project (Orbit) ───────────────────────────────────────────────────────
const dashboardHtml = lang => `<!doctype html><html lang="${lang}"><meta charset="utf-8"><title>Orbit — Team workspace</title>
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
${lang === 'ko'
    ? `<div class="head"><div><h1>팀의 오늘을 한눈에.</h1><p>아이디어에서 완료까지, 우리 팀의 작업 공간</p></div><button>+ 새 작업</button></div>
<div class="stats"><div class="card"><div class="label">이번 주 완료</div><div class="num">24 <span class="small">개</span></div><div class="small">지난주보다 6개 더 완료했어요</div></div><div class="card"><div class="label">진행 중인 작업</div><div class="num">8 <span class="small">개</span></div><div class="small">3개의 프로젝트에서 작업 중</div></div><div class="card"><div class="label">목표 달성률</div><div class="num">75<span class="small">%</span></div><div class="small">이번 주 목표에 가까워지고 있어요</div></div></div>
<div class="columns"><div class="card"><h2>진행 중인 작업</h2><div class="row"><span class="check">✓</span><span class="name">대시보드 레이아웃<small>디자인 · 오늘</small></span><span class="pill">완료</span></div><div class="row"><span class="check">↗</span><span class="name">프로젝트 API 연결<small>개발 · 내일</small></span><span class="pill">진행 중</span></div><div class="row"><span class="check">○</span><span class="name">모바일 화면 점검<small>리뷰 · 금요일</small></span><span class="pill">예정</span></div></div>
<div class="card"><h2>이번 주 활동</h2><div class="bars"><div class="bar" style="height:40%"></div><div class="bar" style="height:62%"></div><div class="bar" style="height:48%"></div><div class="bar" style="height:78%"></div><div class="bar" style="height:96%"></div></div><div class="days"><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span></div></div></div>`
    : `<div class="head"><div><h1>Your team’s day at a glance.</h1><p>From idea to done — the team workspace</p></div><button>+ New task</button></div>
<div class="stats"><div class="card"><div class="label">Done this week</div><div class="num">24</div><div class="small">6 more than last week</div></div><div class="card"><div class="label">In progress</div><div class="num">8</div><div class="small">Across 3 projects</div></div><div class="card"><div class="label">Goal progress</div><div class="num">75<span class="small">%</span></div><div class="small">Closing in on this week’s goal</div></div></div>
<div class="columns"><div class="card"><h2>In progress</h2><div class="row"><span class="check">✓</span><span class="name">Dashboard layout<small>Design · today</small></span><span class="pill">Done</span></div><div class="row"><span class="check">↗</span><span class="name">Connect projects API<small>Dev · tomorrow</small></span><span class="pill">Active</span></div><div class="row"><span class="check">○</span><span class="name">Mobile screen check<small>Review · Friday</small></span><span class="pill">Planned</span></div></div>
<div class="card"><h2>Weekly activity</h2><div class="bars"><div class="bar" style="height:40%"></div><div class="bar" style="height:62%"></div><div class="bar" style="height:48%"></div><div class="bar" style="height:78%"></div><div class="bar" style="height:96%"></div></div><div class="days"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span></div></div></div>`}
<div class="foot">ORBIT · EXAMPLE PROJECT</div></main></html>`

// One authored diff for src/dashboard.ts — file content and diff are derived from the same ops.
const dashboardOps = [
  ['ctx', 'export interface Task {'], ['ctx', '  id: string'], ['ctx', '  title: string'],
  ['add', "  status: 'planned' | 'active' | 'done'"], ['ctx', '}'], ['ctx', ''],
  ['add', 'export interface Summary {'], ['add', '  total: number'], ['add', '  completed: number'], ['add', '  active: number'], ['add', '  progress: number'], ['add', '}'], ['add', ''],
  ['del', 'export function summarize(tasks: Task[]) {'],
  ['add', 'export function summarize(tasks: Task[]): Summary {'],
  ['add', "  const completed = tasks.filter(task => task.status === 'done')"],
  ['add', "  const active = tasks.filter(task => task.status === 'active')"],
  ['add', '  const progress = tasks.length === 0'], ['add', '    ? 0'], ['add', '    : Math.round(completed.length / tasks.length * 100)'], ['add', ''],
  ['del', '  return { total: tasks.length }'],
  ['add', '  return { total: tasks.length, completed: completed.length, active: active.length, progress }'],
  ['ctx', '}']
]
const dashboardTs = dashboardOps.filter(([t]) => t !== 'del').map(([, s]) => s).join('\n') + '\n'
const dashboardTsOld = dashboardOps.filter(([t]) => t !== 'add').map(([, s]) => s).join('\n') + '\n'
const dashboardDiff = {
  path: 'src/dashboard.ts', tag: 'edit',
  add: dashboardOps.filter(([t]) => t === 'add').length, del: dashboardOps.filter(([t]) => t === 'del').length,
  lines: dashboardOps.map(([t, text]) => ({ t, text }))
}

function makeProject(work, lang) {
  const c = T[lang]
  fs.rmSync(work, { recursive: true, force: true })
  const git = (...args) => execFileSync('git', args, { cwd: work, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'Orbit Demo', GIT_AUTHOR_EMAIL: 'demo@example.invalid', GIT_COMMITTER_NAME: 'Orbit Demo', GIT_COMMITTER_EMAIL: 'demo@example.invalid' } })
  const commit = (msg, daysAgo) => {
    const d = new Date(Date.now() - daysAgo * 86400000).toISOString()
    execFileSync('git', ['add', '.'], { cwd: work, stdio: 'ignore' })
    execFileSync('git', ['commit', '--allow-empty', '-m', msg], { cwd: work, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'Orbit Demo', GIT_AUTHOR_EMAIL: 'demo@example.invalid', GIT_COMMITTER_NAME: 'Orbit Demo', GIT_COMMITTER_EMAIL: 'demo@example.invalid', GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d } })
  }
  write(work, 'README.md', lang === 'ko' ? '# Orbit\n\n팀 작업을 정리하는 대시보드 예제입니다.\n\n- 작업 목록\n- 주간 활동\n- 프로젝트 진행률\n' : '# Orbit\n\nAn example dashboard that keeps team work in one place.\n\n- Task list\n- Weekly activity\n- Project progress\n')
  write(work, 'package.json', { name: 'orbit-web', version: '1.0.0', private: true, scripts: { dev: 'vite', test: 'vitest run' } })
  write(work, 'src/dashboard.ts', dashboardTsOld)
  write(work, 'src/dashboard.css', ':root { --accent: #218c70; --surface: #f5f6f8; }\n.dashboard { display: grid; gap: 24px; }\n')
  git('init', '-b', 'main')
  commit(c.commits[0], 9)
  write(work, 'src/api/projects.ts', 'export async function getProjects() {\n  const response = await fetch("/api/projects")\n  return response.json()\n}\n')
  commit(c.commits[1], 6)
  write(work, 'tests/dashboard.test.ts', '// Orbit demo: empty state, completed tasks, active tasks.\n')
  commit(c.commits[2], 3)
  write(work, 'docs/plan.md', c.plan)
  write(work, 'src/components/TaskList.ts', 'export function renderTaskList(tasks: { title: string }[]) {\n  return tasks.map(task => `<li>${task.title}</li>`).join("")\n}\n')
  commit(c.commits[3], 1)
  // Working-tree changes for the hero and Git captures.
  write(work, 'src/dashboard.ts', dashboardTs)
  write(work, 'index.html', dashboardHtml(lang))
  fs.appendFileSync(path.join(work, 'src/dashboard.css'), '.summary-card { border-radius: 14px; }\n.summary-card .num { font-weight: 650; }\n')
  write(work, 'src/api/projects.ts', 'export async function getProjects() {\n  const response = await fetch("/api/projects")\n  if (!response.ok) throw new Error("Projects unavailable")\n  const projects = await response.json()\n  return Array.isArray(projects) ? projects : []\n}\n')
  write(work, 'src/chart.ts', 'export function bars(values: number[]) {\n  const max = Math.max(1, ...values)\n  return values.map(v => Math.round(v / max * 100))\n}\n')
}

// ── Conversation fixtures ──────────────────────────────────────────────────────
const msg = (lang, id, role, text) => ({ kind: 'msg', id, role, text, animate: false, time: time[lang] })
const tool = (id, verb, kind, target, result, extra = {}) => ({ id, verb, kind, target, result, status: 'done', ...extra })
const changedFiles = [{ path: 'src/dashboard.ts', add: dashboardDiff.add, del: dashboardDiff.del, tag: 'edit' }, { path: 'src/dashboard.css', add: 8, del: 2, tag: 'edit' }, { path: 'index.html', add: 42, del: 0, tag: 'new' }]

function heroSnapshot(lang) {
  const c = T[lang]
  const files = changedFiles
  return {
    status: 'done', seq: 40, shownNotices: [], session: null,
    messages: [
      msg(lang, 'u1', 'user', c.u1),
      msg(lang, 'a1', 'assistant', c.a1),
      { kind: 'toolgroup', id: 'tg1', time: time[lang], tools: [
        tool('read', 'Read', 'read', 'src/dashboard.ts', c.lines(8)),
        tool('search', 'Search', 'search', 'summarize', c.places(3)),
        tool('edit', 'Edit', 'edit', files.map(f => f.path).join(', '), c.files3, { files }),
        tool('bash', 'Bash', 'bash', 'npm test', c.passed, { output: c.testOut, durationMs: 2100 })
      ] },
      { kind: 'worked', id: 'w1', ms: 38000, time: time[lang] },
      msg(lang, 'a2', 'assistant', c.a2)
    ],
    files,
    diffs: { 'src/dashboard.ts': dashboardDiff },
    todos: c.todos.map((label, i) => ({ id: String(i + 1), label, status: i < 3 ? 'done' : i === 3 ? 'running' : 'pending' })),
    subagents: [{ id: 'sa-1', name: 'Explore', role: c.subRole, status: 'done', activity: c.subAct, tools: [], model: 'Sonnet 5', durationMs: 12400 }],
    bgTasks: [{ id: 'bg-1', kind: 'local_bash', description: c.bgDesc, status: 'running' }],
    result: { costUsd: null, durationMs: 38000, numTurns: 1, contextTokens: 182000, contextWindow: 1000000 },
    tokenTotals: { 'Opus 5': { inTok: 148200, outTok: 31400, cacheRead: 512000, cacheWrite: 84000 } }
  }
}

function panelSnapshot(lang, i) {
  const c = T[lang]
  if (i === 0) return heroSnapshot(lang)
  const convo = i === 1
    ? [msg(lang, 'u2', 'user', c.u2), msg(lang, 'a3', 'assistant', c.a3),
      { kind: 'toolgroup', id: 'tg2', time: time[lang], tools: [tool('api-read', 'Read', 'read', 'src/api/projects.ts', c.lines(6)), tool('api-edit', 'Edit', 'edit', 'src/api/projects.ts', '+12 −3')] },
      { kind: 'worked', id: 'w2', ms: 21000, time: time[lang] }, msg(lang, 'a4', 'assistant', c.a4)]
    : [msg(lang, 'u3', 'user', c.u3), msg(lang, 'a5', 'assistant', c.a5),
      { kind: 'toolgroup', id: 'tg3', time: time[lang], tools: [tool('test-read', 'Read', 'read', 'src/dashboard.ts', c.lines(24)), tool('test-edit', 'Edit', 'edit', 'tests/dashboard.test.ts', '+24')] },
      { kind: 'worked', id: 'w3', ms: 16000, time: time[lang] }, msg(lang, 'a6', 'assistant', c.a6)]
  return { status: 'done', messages: convo, files: [], diffs: {}, todos: [], subagents: [], bgTasks: [], session: null, seq: 20, shownNotices: [] }
}

// ── Accounts (fictional) ───────────────────────────────────────────────────────
const CLAUDE_ACCOUNTS = [
  { email: 'mina@orbit.example', subscriptionType: 'max' },
  { email: 'dev@orbit.example', subscriptionType: 'pro' },
  { email: 'studio@orbit.example', subscriptionType: 'max' }
]
const CODEX_ACCOUNTS = [
  { email: 'mina@orbit.example', plan: 'plus', isDefault: true },
  { email: 'ops@orbit.example', plan: 'pro' }
]
function usageFixtures() {
  const now = Math.floor(Date.now() / 1000)
  const claude = [
    { email: 'mina@orbit.example', fiveHourPct: 38, weeklyPct: 61, fablePct: 44, fiveHourResetsAt: now + 3 * 3600 + 900, weeklyResetsAt: now + 3 * 86400, fableResetsAt: now + 3 * 86400 },
    { email: 'dev@orbit.example', fiveHourPct: 7, weeklyPct: 22, fablePct: null, fiveHourResetsAt: now + 4 * 3600, weeklyResetsAt: now + 5 * 86400, fableResetsAt: null },
    { email: 'studio@orbit.example', fiveHourPct: 100, weeklyPct: 100, fablePct: 96, fiveHourResetsAt: now + 1800, weeklyResetsAt: now + 86400 + 7200, fableResetsAt: now + 86400 + 7200 }
  ]
  const codex = [
    { email: 'mina@orbit.example', planType: 'plus', windows: [{ label: '5시간', usedPct: 18, resetsAt: now + 2 * 3600 }, { label: '주간', usedPct: 47, resetsAt: now + 4 * 86400 }] },
    { email: 'ops@orbit.example', planType: 'pro', windows: [{ label: '5시간', usedPct: 3, resetsAt: now + 4 * 3600 }, { label: '주간', usedPct: 12, resetsAt: now + 6 * 86400 }] }
  ]
  return { claude, codex }
}
function usageInfo() {
  const [u] = usageFixtures().claude
  return { fiveHour: { pct: u.fiveHourPct, resetsAt: u.fiveHourResetsAt }, weekly: { pct: u.weeklyPct, resetsAt: u.weeklyResetsAt }, weeklyFable: { pct: u.fablePct, resetsAt: u.fableResetsAt }, extraCredit: null }
}
// Tool lists (MCP servers, skills) and usage queries are swapped for fixtures before the
// page scripts run: a setter trap on window.api patches the shim the moment it is assigned.
function apiTrap(lang) {
  const { claude, codex } = usageFixtures()
  const mcp = [
    { name: 'github', scope: 'global', origin: 'user', transport: 'stdio', detail: 'npx -y @modelcontextprotocol/server-github', enabled: true },
    { name: 'playwright', scope: 'local', origin: 'project', transport: 'stdio', detail: 'npx -y @playwright/mcp@latest', enabled: true },
    { name: 'sentry', scope: 'global', origin: 'user', transport: 'http', detail: 'https://mcp.sentry.dev/mcp', enabled: false }
  ]
  const skill = (name, description, scope, enabled = true, extra = {}) => ({ name, description, scope, enabled, path: scope === 'local' ? `C:\Code\Orbit\.claude\skills\${name}\SKILL.md` : `C:\Users\you\.claude\skills\${name}\SKILL.md`, ...extra })
  const skills = [
    skill('commit', lang === 'ko' ? '변경 내용을 요약해 커밋 메시지를 작성' : 'Diff to commit message', 'global'),
    skill('review-pr', lang === 'ko' ? '이 저장소 규칙으로 PR 검토' : 'Review a PR by repo rules', 'local'),
    skill('deploy', lang === 'ko' ? '스테이징 배포 절차' : 'Staging deploy runbook', 'local', false)
  ]
  return `(() => {
    const over = {
      mcp: { list: async () => (${JSON.stringify(mcp)}) },
      skill: { list: async () => (${JSON.stringify(skills)}) },
      auth: { accountsUsage: async () => (${JSON.stringify(claude)}) },
      codexAuth: { accountsUsage: async () => (${JSON.stringify(codex)}) },
      codexModels: async () => [],
      codexContext: { get: async () => ({settings:{management:false,preset:'default',models:{},fallback:null},
        defaults:Object.fromEntries(['gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna'].map(id=>[id,{contextWindow:272000,compactTokenLimit:244800}]))}) },
      getUsage: async () => (${JSON.stringify(usageInfo())})
    }
    // Proxies read through to the live shim, so properties added after assignment stay visible.
    const wrap = (target, o) => new Proxy(target, { get: (t, k) => (k in o ? (typeof o[k] === 'function' ? o[k] : wrap(t[k], o[k])) : Reflect.get(t, k)) })
    let cur
    Object.defineProperty(window, 'api', { configurable: true, get: () => cur, set: v => { cur = wrap(v, over) } })
  })()`
}
function seedSystemEngine(home) {
  if (!fakeCli) throw new Error('fake CLI missing: cargo build -p ccg-engine --features fakecli --bin ccg-fakecli --release')
  const configDir = path.join(home, 'claude-config')
  fs.mkdirSync(configDir, { recursive: true })
  write(home, 'engine-environments.json', { claude: { mode: 'system', cliPath: fakeCli, configDir } })
}
function seedAccounts(home) {
  write(home, 'accounts.json', { version: 3, defaultEmail: CLAUDE_ACCOUNTS[0].email, accounts: CLAUDE_ACCOUNTS })
  for (const a of CLAUDE_ACCOUNTS) fs.mkdirSync(path.join(home, 'accounts', a.email.replace('@', '_')), { recursive: true })
  write(home, 'codex-accounts.json', { version: 1, defaultEmail: CODEX_ACCOUNTS[0].email, accounts: CODEX_ACCOUNTS })
  const { claude } = usageFixtures()
  write(home, 'usage-cache.json', Object.fromEntries(claude.map(u => [u.email, { at: Date.now(), data: u }])))
}
function seedFakeEngine(home) {
  if (!fakeCli) throw new Error('fake CLI missing: cargo build -p ccg-engine --features fakecli --bin ccg-fakecli --release')
  const dir = path.join(home, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(fakeCli, path.join(dir, 'claude.exe'))
  write(home, 'config.json', { activeVersion: 'fake' })
}
// ── Fake CLI scripts ───────────────────────────────────────────────────────────
const ack = { type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: {} } }
const init = (sid, cwd) => ({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5', cwd, tools: [], apiKeySource: 'none' })
const assistant = (sid, content, extra = {}) => ({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { role: 'assistant', content, usage: { input_tokens: 24000 } }, ...extra })
const text = t => ({ type: 'text', text: t })

function liveScript(lang, work) {
  const c = T[lang]
  const sid = 'orbit-live'
  const agents = c.agents.map(([label, phase, state, note], i) => ({
    type: 'workflow_agent', label, phaseIndex: phase, phaseTitle: c.phases[phase - 1],
    model: state === 'queued' ? (i === 6 ? 'claude-haiku-4-5' : 'claude-opus-5') : phase === 1 ? 'claude-sonnet-5' : 'claude-opus-5',
    state, ...(state === 'done' ? { resultPreview: note, tokens: 8120 + i * 1300, toolCalls: 6 + i, durationMs: 41000 + i * 9000 } : state === 'start' ? { promptPreview: note, tokens: 3900 + i * 700, toolCalls: 2 + i } : {})
  }))
  const progress = (dur) => ({ type: 'system', subtype: 'task_progress', session_id: sid, task_id: 'wf-1', summary: c.wfSummary,
    usage: { total_tokens: 48210, tool_uses: 27, duration_ms: dur },
    workflow_progress: [...c.phases.map((title, i) => ({ type: 'workflow_phase', index: i + 1, title })), ...agents] })
  const steps = [
    { afterMs: 100, emit: ack },
    { emit: init(sid, work) },
    { afterMs: 200, emit: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: c.liveText } } } },
    { afterMs: 300, emit: assistant(sid, [text(c.liveText)]) },
    { afterMs: 200, emit: assistant(sid, [{ type: 'tool_use', id: 'tu_todo', name: 'TodoWrite', input: { todos: c.liveTodos.map((content, i) => ({ content, status: i < 2 ? 'completed' : i === 2 ? 'in_progress' : 'pending' })) } }]) },
    { afterMs: 150, emit: { type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_todo', content: 'ok' }] } } },
    { afterMs: 150, emit: assistant(sid, [{ type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: path.join(work, 'src/dashboard.ts') } }]) },
    { afterMs: 150, emit: { type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_read', content: dashboardTs }] } } },
    { afterMs: 150, emit: assistant(sid, [{ type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'npm run dev', run_in_background: true, description: c.liveBg } }]) },
    { afterMs: 150, emit: { type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_bash', content: 'Command running in background with ID: bg-1' }] } } },
    ...c.liveTasks.flatMap(([desc, narration], i) => [
      { afterMs: 150, emit: assistant(sid, [{ type: 'tool_use', id: `tu_task${i}`, name: 'Task', input: { subagent_type: 'Explore', description: desc, prompt: narration } }]) },
      { afterMs: 200, emit: { type: 'assistant', session_id: sid, parent_tool_use_id: `tu_task${i}`, message: { role: 'assistant', model: 'claude-sonnet-5', content: [text(narration)], usage: { input_tokens: 5200 } } } },
      { afterMs: 120, emit: { type: 'assistant', session_id: sid, parent_tool_use_id: `tu_task${i}`, message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: `tu_task${i}_grep`, name: 'Grep', input: { pattern: i ? 'useMemo|render' : 'color|outline', path: 'src' } }], usage: { input_tokens: 5400 } } } }
    ]),
    { afterMs: 150, emit: assistant(sid, [{ type: 'tool_use', id: 'tu_wf', name: 'Workflow', input: { script: 'review-dashboard' } }]) },
    { afterMs: 120, emit: { type: 'system', subtype: 'task_started', session_id: sid, task_id: 'wf-1', tool_use_id: 'tu_wf' } },
    { afterMs: 120, emit: { type: 'system', subtype: 'background_tasks_changed', session_id: sid, tasks: [
      { task_id: 'bg-1', task_type: 'local_bash', description: c.liveBg },
      { task_id: 'wf-1', task_type: 'local_workflow', description: c.wfSummary }] } },
    { afterMs: 200, emit: progress(214000) }
  ]
  for (let i = 1; i <= 12; i++) steps.push({ afterMs: 15000, emit: progress(214000 + i * 15000) })
  return steps
}

function dialogScript(lang, work) {
  const c = T[lang]
  const sid = 'orbit-plan'
  const q = ([question, header, options]) => ({ question, header, multiSelect: false, options: options.map(([label, description]) => ({ label, description })) })
  return [
    { afterMs: 100, emit: ack },
    { emit: init(sid, work) },
    { afterMs: 300, emit: assistant(sid, [text(c.dlgText)]) },
    { afterMs: 300, emit: { type: 'control_request', request_id: 'q-1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'tu_q1', input: { questions: [q(c.q1), q(c.q2)] } } } },
    { awaitResponse: 'q-1' },
    { afterMs: 400, emit: assistant(sid, [text(c.dlgText2)]) },
    { afterMs: 300, emit: { type: 'control_request', request_id: 'plan-1', request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', tool_use_id: 'tu_plan', input: { planFilePath: 'docs/plan.md' } } } },
    { awaitResponse: 'plan-1' },
    { afterMs: 300, emit: { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sid, total_cost_usd: 0, duration_ms: 1, num_turns: 1 } }
  ]
}

// ── App boot + capture helpers ─────────────────────────────────────────────────
function seedHome(home, lang, { count, picker, title }) {
  quietHome(home)
  const c = T[lang]
  write(home, 'profile.json', { nickname: c.nick, color: '#4baf91' })
  write(home, 'ui-prefs.json', { 'ui.lang': lang, 'workspace.mode': 'multi', 'whatsnew.seenVersion': version, 'sidebar.autohide': false, 'chat.zoom': 1, 'viewer.size': { w: 1080, h: 740 }, 'viewer.diffView': true })
  write(home, 'multi-agent/index.json', { version: 2, order: ['orbit'], activeSessionId: 'orbit' })
  write(home, 'multi-agent/orbit.json', { id: 'orbit', title: title ?? c.session, count, panels: [0, 1, 2].slice(0, count).map(i => ({
    title: c.panels[i], custom: true, cwd: DEMO, picker: picker(i), snapshot: panelSnapshot(lang, i)
  })) })
  seedAccounts(home)
  seedFakeEngine(home)
}

async function boot(home, lang, { width = 1440, height = 820, env = {} } = {}) {
  const port = portSeq++
  const app = spawn(exe, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, CCG_HOME: home, CCG_NO_NET: '1', ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` } })
  const cdp = await connectMainPage(port)
  await sleep(2500)
  await cdp.send('Page.enable')
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: apiTrap(lang) })
  await cdp.send('Page.reload')
  await sleep(1500)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false })
  await cdp.eval(HELPERS_JS)
  const ctx = makeCtx(cdp)
  const out = lang === 'ko' ? path.join(REPO, 'docs/images') : path.join(REPO, 'docs/images', lang)
  fs.mkdirSync(out, { recursive: true })
  const resize = (w, h) => cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false })
  // sel: clip to that element (+pad). maxH caps the clip height from the top;
  // bottom: keep only the last N CSS px of the element (work-bar popovers).
  const rectOf = async sel => {
    const r = await cdp.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height } })()`)
    if (!r) throw new Error(`shot: no element ${sel}`)
    return r
  }
  // union: also cover a second element (popover + its chip). The device scale factor
  // already doubles the pixels, so the clip itself stays at scale 1.
  // Hide chat content behind popovers and cards so crops show the control on a plain backdrop.
  const hide = (sels, keep = []) => cdp.eval(`(() => { let st = document.getElementById('ccg-shot-hide'); if (!st) { st = document.createElement('style'); st.id = 'ccg-shot-hide'; document.head.appendChild(st) }
    st.textContent = ${JSON.stringify((sels.length ? sels.join(', ') + ' { visibility: hidden !important } ' : '') + (keep.length ? keep.join(', ') + ', ' + keep.map(k => k + ' *').join(', ') + ' { visibility: visible !important }' : ''))}; return true })()`)
  const shot = async (name, sel, pad = 14, { maxH, union, rect, fixedW, padTop, within } = {}) => {
    await cdp.eval('document.activeElement?.blur()')
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4, button: 'none', buttons: 0 })
    await sleep(420)
    let clip
    if (sel) {
      let r = rect ?? await rectOf(sel)
      for (const other of [].concat(union ?? [])) {
        const u = await rectOf(other)
        const x0 = Math.min(r.x, u.x), y0 = Math.min(r.y, u.y)
        r = { x: x0, y: y0, w: Math.max(r.x + r.w, u.x + u.w) - x0, h: Math.max(r.y + r.h, u.y + u.h) - y0 }
      }
      const top = padTop ?? pad
      let h = r.h + top + pad
      if (maxH && h > maxH) h = maxH
      let x = fixedW ? r.x + r.w / 2 - fixedW / 2 : r.x - pad
      const width = fixedW ?? r.w + pad * 2
      const bounds = within ? await rectOf(within) : { x: 0, y: 0, w: await cdp.eval('window.innerWidth'), h: await cdp.eval('window.innerHeight') }
      x = Math.min(Math.max(x, bounds.x), bounds.x + bounds.w - width)
      clip = { x: Math.max(0, x), y: Math.max(0, r.y - top), width, height: h, scale: 1 }
    }
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip } : {}) })
    fs.writeFileSync(path.join(out, name), Buffer.from(data, 'base64'))
    console.log(`${lang}/${name}`)
  }
  // Wait for the panels, swap the usage queries for fixtures, and close first-run dialogs.
  const ready = async (panels = 1) => {
    await ctx.waitFor('.ma-panel .composer textarea', 20000, panels)
    await sleep(1200)
    for (const t of ['나중에', 'Later', '시작하기', 'Get started']) await ctx.tryClickText('button', t)
  }
  const send = async textToSend => {
    await ctx.type('.ma-panel .composer textarea', textToSend)
    await sleep(150)
    await ctx.realClick('.ma-panel .composer .send')
  }
  return { app, cdp, ctx, shot, hide, rectOf, resize, ready, send, close: () => { cdp.close(); killTree(app.pid) } }
}

const heroPicker = i => ({ engine: i === 1 ? 'codex' : 'claude', codexModel: 'gpt-5.6-terra', model: i === 2 ? 'sonnet' : 'opus', effort: 'medium', mode: 'normal', account: 'mina@orbit.example', codexAccount: 'mina@orbit.example' })

// ── Scenes ─────────────────────────────────────────────────────────────────────
async function sceneHero(lang) {
  const home = path.join(root, `hero-${lang}`)
  seedHome(home, lang, { count: 1, picker: heroPicker })
  makeProject(DEMO, lang)
  const a = await boot(home, lang, { width: 1200, height: 760 })
  try {
    const { ctx, shot, resize, cdp, hide } = a
    await a.ready()
    await ctx.click('[data-tool-id="edit"]')
    await sleep(300)
    await ctx.openExplorer()
    await shot('workspace.png')

    // Code viewer with change marks (Edit row → src/dashboard.ts)
    await resize(1000, 700)
    await ctx.click('.t-file', 0)
    await ctx.waitFor('.fv-overlay .cm-mount', 12000)
    await sleep(1200)
    await hide(['.thread'])
    await shot('viewer-diff.png', '.fv-modal', 0)
    await hide([])
    await ctx.closeViewer()

    // HTML preview
    await resize(1000, 740)
    await ctx.click('.t-file', 2)
    await ctx.waitFor('.fv-overlay iframe', 12000)
    await sleep(800)
    await hide(['.thread'])
    await shot('preview.png', '.fv-modal', 0)
    await hide([])
    await ctx.closeViewer()
    await resize(1200, 800)
    await sleep(300)

    // Work bar: context + limits popover
    await ctx.click('.workbar .wb-chip', 4)
    await ctx.waitFor('.wb-cell .wb-pop', 4000)
    await sleep(500)
    await hide(['.thread', '.workbar .wb-chip', '.composer'])
    await shot('context.png', '.wb-cell .wb-pop', 24, { fixedW: 420, within: '.ma-panel' })
    await hide([])
    await ctx.click('.workbar .wb-chip', 4)
    await sleep(200)

    // MCP & Skill popover (fixture list)
    await ctx.clickText('.ma-panel .ma-p-folder', 'MCP')
    await ctx.waitFor('.hfold .wb-pop', 5000)
    await sleep(900)
    await hide(['.thread'])
    await shot('mcp-skill.png', '.hfold .wb-pop', 24, { fixedW: 420, padTop: 2 })
    await hide([])
    await ctx.esc()
    await resize(1100, 640)
    await sleep(300)

    // Git card — crop the modal without its side navigation
    await ctx.click('.explorer .git-strip')
    await ctx.waitFor('.gitm-modal', 8000)
    await sleep(900)
    await cdp.eval(`(() => { const i = [...document.querySelectorAll('.gitm-modal input')].find(x => /커밋 메시지|Commit message/.test(x.placeholder)); if (!i) return false
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(T[lang].commitMsg)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(400)
    await hide(['.thread'])
    await shot('git-changes.png', '.gitm-modal', 0)
    await hide([])
    await ctx.clickText('.gitm-modal .gitm-item', lang === 'ko' ? '히스토리' : 'History')
    await ctx.waitFor('.gitm-list .c-line', 8000)
    await sleep(600)
    await cdp.eval(`(() => { const el = document.querySelector('.gitm-list .c-line'); (el.closest('button') || el.parentElement).click(); return true })()`)
    await ctx.waitFor('.gitm-detail', 8000)
    await sleep(900)
    await hide(['.thread'])
    await shot('git-history.png', '.gitm-modal', 0)
    await hide([])
    await ctx.esc()
    await resize(1200, 800)
    await sleep(300)

    // Settings → Account
    await ctx.openSettings('Account')
    await sleep(1200)
    await hide(['.thread'])
    await shot('settings-account.png')
    await hide([])
    await ctx.esc()
  } finally { a.close() }
}

async function sceneMulti(lang) {
  const home = path.join(root, `multi-${lang}`)
  seedHome(home, lang, { count: 2, picker: heroPicker })
  makeProject(DEMO, lang)
  const a = await boot(home, lang, { width: 1280, height: 920 })
  try {
    const { ctx, cdp, shot, hide } = a
    await a.ready(2)
    await ctx.click('[data-tool-id="edit"]')
    await sleep(300)
    await cdp.eval(`document.querySelectorAll('.chat-scroll, .thread').forEach(e => { e.scrollTop = 0; e.scrollTo?.({ top: 0 }) })`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY: -4000 })
    await sleep(300)
    await shot('multi-agent.png')

    // Account picker of the second panel: the first panel already uses the same account.
    await a.resize(1280, 1500)
    await sleep(400)
    await ctx.click('.ma-panel .composer .model-chip', 0)
    await ctx.waitFor('.picker-pop', 5000)
    await sleep(1200)
    // Collapse everything above the account section so the popover shrinks to it.
    await cdp.eval(`(() => { const p = document.querySelector('.picker-pop')
      const h = [...p.querySelectorAll('.pp-h4')].find(e => /^(계정|Accounts?)/.test(e.textContent.trim()))
      if (!h) return false
      let node = h
      while (node && node !== p) { let el = node.previousElementSibling; while (el) { el.style.display = 'none'; el = el.previousElementSibling } node = node.parentElement }
      return true })()`)
    await sleep(500)
    await hide(['.thread', '.workbar', '.composer-row'], ['.picker-pop'])
    await shot('accounts.png', '.picker-pop', 4, { padTop: 14 })
    await hide([])
  } finally { a.close() }
}

async function sceneLive(lang) {
  const home = path.join(root, `live-${lang}`)
  const work = DEMO
  const c = T[lang]
  seedHome(home, lang, { count: 1, picker: heroPicker, title: c.session })
  // Fresh thread for the live turn.
  const ma = JSON.parse(fs.readFileSync(path.join(home, 'multi-agent/orbit.json')))
  ma.panels[0].snapshot = { messages: [] }
  ma.panels[0].title = c.panels[2]
  write(home, 'multi-agent/orbit.json', ma)
  makeProject(work, lang)
  seedSystemEngine(home)
  const script = write(home, 'script.jsonl', liveScript(lang, work).map(s => JSON.stringify(s)).join('\n') + '\n')
  const a = await boot(home, lang, { width: 1200, height: 800, env: { CCG_FAKECLI_SCRIPT: script } })
  try {
    const { ctx, shot, hide } = a
    await a.ready()
    await a.send(c.liveAsk)
    await ctx.waitFor('.wf-dock .wf-mini', 40000)
    await sleep(1500)
    await a.resize(1200, 560)
    await sleep(400)
    await ctx.click('.wf-dock .wf-mini')
    await ctx.waitFor('.wf-card .wf-cols', 5000)
    await sleep(700)
    await hide(['.thread'])
    await shot('workflow.png', '.wf-card', 12)
    await hide([])
    await ctx.esc()
    await a.resize(1200, 800)
    await sleep(400)
    await ctx.click('.workbar .wb-chip', 1)
    await ctx.waitFor('.wb-cell .wb-pop', 4000)
    await sleep(500)
    await hide(['.thread', '.wf-dock', '.workbar .wb-chip', '.composer'])
    await shot('subagents.png', '.wb-cell .wb-pop', 20, { within: '.ma-panel' })
    await hide([])
    await ctx.click('.workbar .wb-chip', 1)
    await sleep(200)
    await ctx.click('.workbar .wb-chip', 0)
    await ctx.waitFor('.wb-cell .wb-pop', 4000)
    await sleep(500)
    await hide(['.thread', '.wf-dock', '.workbar .wb-chip', '.composer'])
    await shot('todos.png', '.wb-cell .wb-pop', 20, { within: '.ma-panel' })
    await hide([])
    await ctx.click('.workbar .wb-chip', 0)
    await sleep(200)
    await ctx.click('.workbar .wb-chip', 2)
    await ctx.waitFor('.wb-cell .wb-pop', 4000)
    await sleep(500)
    await hide(['.thread', '.wf-dock', '.workbar .wb-chip', '.composer'])
    await shot('background.png', '.wb-cell .wb-pop', 20, { within: '.ma-panel' })
    await hide([])
    await ctx.click('.workbar .wb-chip', 2)
  } finally { a.close() }
}

async function sceneDialogs(lang) {
  const home = path.join(root, `dialogs-${lang}`)
  const work = DEMO
  const c = T[lang]
  seedHome(home, lang, { count: 1, picker: i => ({ ...heroPicker(i), mode: 'plan' }) })
  const ma = JSON.parse(fs.readFileSync(path.join(home, 'multi-agent/orbit.json')))
  ma.panels[0].snapshot = { messages: [] }
  write(home, 'multi-agent/orbit.json', ma)
  makeProject(work, lang)
  seedSystemEngine(home)
  const script = write(home, 'script.jsonl', dialogScript(lang, work).map(s => JSON.stringify(s)).join('\n') + '\n')
  const a = await boot(home, lang, { width: 1200, height: 800, env: { CCG_FAKECLI_SCRIPT: script } })
  try {
    const { ctx, shot, hide } = a
    await a.ready()
    await a.send(c.dlgAsk)
    await ctx.waitFor('.q-overlay .qcard .qopts', 40000)
    await sleep(700)
    await hide(['.thread', '.workbar', '.composer'])
    await shot('question.png', '.q-overlay .qcard', 28)
    await hide([])
    // Single-select questions advance as soon as an option is chosen.
    for (let step = 0; step < 2; step++) {
      await ctx.realClick('.qcard .qopts .qopt', 0)
      await sleep(600)
    }
    await ctx.waitFor('.plan-approval', 40000)
    await ctx.waitFor('.plan-approval-body .md-table', 15000)
    await sleep(900)
    await hide(['.thread', '.workbar', '.composer'])
    await shot('plan-review.png', '.q-overlay .qcard', 28)
    await hide([])
    await ctx.realClick('.plan-approval-actions .go')
    await sleep(800)
  } finally { a.close() }
}

async function sceneDetails(lang) {
  const home = path.join(root, `details-${lang}`)
  seedHome(home, lang, { count: 1, picker: heroPicker })
  makeProject(DEMO, lang)
  const boardPath = path.join(home, 'multi-agent/orbit.json')
  const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'))
  board.panels[0].snapshot.subagents = [{
    id:'review-details', name:'Explore', status:'done', model:'Sonnet 5', durationMs:42000, tokens:12480,
    role:lang === 'ko' ? '대시보드 접근성 검토' : 'Dashboard accessibility review',
    activity:lang === 'ko' ? '키보드 탐색과 빈 상태를 확인했습니다. 포커스 표시를 보강하고 테스트 12개를 통과했습니다.' : 'Reviewed keyboard navigation and empty states. Improved focus indicators and passed all 12 tests.',
    tools:[
      tool('review-read','Read','read','src/dashboard.ts',lang === 'ko' ? '48줄' : '48 lines'),
      tool('review-web','Web','web','accessible dashboard keyboard navigation','2 results',{
        args:JSON.stringify({queries:['accessible dashboard keyboard navigation']}),
        links:[{title:'Keyboard accessibility — MDN',url:'https://developer.mozilla.org/en-US/docs/Web/Accessibility/Guides/Understanding_WCAG/Keyboard'},
          {title:'Keyboard Interface — WAI',url:'https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html'}]
      }),
      tool('review-search','Search','search','focus-visible|aria-label','4 hits',{args:JSON.stringify({pattern:'focus-visible|aria-label',path:'src'}),output:'src/dashboard.css:22: .card:focus-visible { outline: 2px solid var(--accent); }\nindex.html:14: <nav aria-label="Projects">'}),
      tool('review-test','Bash','bash','npm test','12 passed',{command:'npm test',output:'Test Files  2 passed (2)\nTests       12 passed (12)',outputLines:2,exitCode:0,durationMs:2100})
    ]
  }]
  fs.writeFileSync(boardPath, JSON.stringify(board))
  const a = await boot(home, lang, {width:1200,height:900})
  try {
    await a.ready()
    await a.ctx.click('.workbar .wb-chip',1)
    await a.ctx.waitFor('.wb-pop-list button',4000)
    await a.ctx.click('.wb-pop-list button')
    await a.ctx.waitFor('.sa-overlay',4000)
    await a.ctx.click('[data-tool-id="review-web"]')
    await a.hide(['.thread','.composer','.workbar'])
    await a.shot('tool-history.png','.sa-overlay .dc-card',20)
    await a.hide([])
    await a.ctx.esc()
    await a.ctx.openSettings('Engine')
    await a.ctx.waitFor('.cx-context .cx-model-table',10000)
    await a.cdp.eval(`document.querySelector('.cx-context').scrollIntoView({block:'center'})`)
    await a.hide(['.thread','.composer','.workbar'])
    await a.shot('codex-context.png','.cx-context',8)
  } finally { a.close() }
}

const scenes = { hero: sceneHero, multi: sceneMulti, live: sceneLive, dialogs: sceneDialogs, details: sceneDetails }
for (const lang of langs) {
  for (const name of only) {
    console.log(`── ${name} (${lang})`)
    await scenes[name](lang)
  }
}
console.log(JSON.stringify({ fixture: root, version, langs, only }))
