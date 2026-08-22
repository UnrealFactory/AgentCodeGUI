// ── 화면 정의표 — docs/screen-inventory.md의 산문 도달 경로를 실행 코드로 옮긴 것 ──────
//
// 이 파일이 A/B 파리티 판정의 "저울"이다. 같은 id의 화면을 두 앱(2.6.2 Electron /
// 3.0 Tauri)에서 **같은 조작 순서로** 밟아 같은 셀렉터가 뜬 것을 확인한 뒤 캡처한다.
// 조작이 앱마다 다르면 비교가 아니라 우연이 되므로, reach는 앱을 분기하지 않는다.
//
// 각 항목:
//   id          안정 키 (파일명·짝짓기 키)
//   label       사람이 읽는 이름 (블라인드 페이지에 표시)
//   area        인벤토리의 절 (1~10)
//   surface     main-window | session-window | panel-window | toast | tray
//   needsEngine 실제 엔진 턴이 필요한가 (예산 5턴)
//   needsAccount 로그인 계정이 필요한가 (벤치 홈이 실계정 OSCrypt 키를 복사한다)
//   reach(cdp, ctx)  메인 창 CDP로 실제 조작
//   assert      도달 판정 CSS 셀렉터 (문자열) — 러너가 폴링
//   assertMin   그 셀렉터가 최소 몇 개여야 하는가 (기본 1)
//   win         캡처 대상이 독립 창이면 그 URL 조각 ('#session' / '#mapanel' / 'toast.html')
//   reset(cdp, ctx)  다음 화면을 오염시키지 않게 되돌리기 (기본: Esc 연타 + 오염 검사)
//   skip        자동화 불가 사유 (은폐 금지 — 배열에는 남기고 러너가 건너뛴다)
//   boot        별도 기동이 필요한 화면의 부팅 변형 키 (ab.mjs의 boot 페이즈가 처리)
//
// [최대 실패 모드] 모달이 겹쳐 다음 화면 판정이 깨지는 것. 그래서 reset은 "닫혔음"을
// 확인할 때까지 돌고, 러너는 화면 사이마다 오염 셀렉터를 검사해 남으면 강제 정리한다.
import fs from 'node:fs'
import path from 'node:path'

// ── 페이지 주입 헬퍼 (인벤토리의 __k/__c/__ctx/__type 문법 그대로) ────────────────
export const HELPERS_JS = `(() => {
  window.__k = (key, mods = {}, target) =>
    (target || window).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }))
  window.__c = (sel, n = 0) => { const e = document.querySelectorAll(sel)[n]; if (!e) return false; e.click(); return true }
  window.__ctx = (sel, n = 0) => {
    const e = document.querySelectorAll(sel)[n]; if (!e) return false
    const r = e.getBoundingClientRect()
    e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8, button: 2 }))
    return true
  }
  window.__type = (sel, v) => {
    const i = document.querySelector(sel); if (!i) return false
    const proto = i.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(i, v)
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }
  window.__txt = (sel, needle, n = 0) => {
    const els = [...document.querySelectorAll(sel)].filter((e) => (e.textContent || '').includes(needle))
    if (!els[n]) return false
    els[n].click(); return true
  }
  window.__n = (sel) => document.querySelectorAll(sel).length
  return true
})()`

// 화면 사이에 남으면 다음 판정을 망치는 오버레이·팝오버 전부
export const DIRTY_SEL = [
  '.sa-overlay', '.pr-overlay', '.fv-overlay', '.set-overlay', '.set-modal', '.gitm-overlay',
  '.q-overlay', '.nc-veil', '.sconfirm', '.set-dialog-overlay', '.ctx-menu', '.wb-pop',
  '.picker-pop', '.slash-menu', '.iv-overlay', '.chgm-overlay', '.ma-expand-overlay',
  '.chat-find', '.fv-find', '.plib-modal', '.mg-trail', '.zoom-badge.on', '.eb-card'
].join(',')

// ── CDP 키 입력 (진짜 키 — 포커스된 요소로 간다) ─────────────────────────────────
const VK = {
  Escape: 27, Enter: 13, Tab: 9, Backspace: 8, Delete: 46, F2: 113, ' ': 32,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, '`': 192, '/': 191, '@': 50, '0': 48
}
const CODE = {
  Escape: 'Escape', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', F2: 'F2',
  ' ': 'Space', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  '`': 'Backquote', '/': 'Slash', '0': 'Digit0'
}
const vkOf = (k) => VK[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0)
const codeOf = (k) => CODE[k] ?? (k.length === 1 && /[a-z]/i.test(k) ? 'Key' + k.toUpperCase() : k)

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 화면 정의가 쓰는 조작·대기 도구 모음. reach(cdp, ctx)의 ctx. */
export function makeCtx(cdp, extra = {}) {
  // Page.reload(에러 안전망 복구·부팅 화면 재현)이 실행 컨텍스트를 갈아치우면 주입해 둔
  // __k/__c/__n이 통째로 사라진다. 그걸 모르고 폴링하면 "eval: ReferenceError: __n is not
  // defined"가 계속 나면서 화면이 떠 있는데도 못 잡는다 — 이 하네스의 조용한 오진 1번.
  // 그래서 ev가 헬퍼 소실을 감지하면 스스로 다시 주입하고 한 번 더 시도한다.
  const rawEval = (expr, awaitPromise = false) => cdp.eval(expr, { awaitPromise })
  const ev = async (expr, awaitPromise = false) => {
    try {
      return await rawEval(expr, awaitPromise)
    } catch (e) {
      if (!/__\w+ is not defined/.test(String(e.message ?? e))) throw e
      await rawEval(HELPERS_JS).catch(() => {})
      return await rawEval(expr, awaitPromise)
    }
  }
  const S = (v) => JSON.stringify(v)

  const ctx = {
    cdp,
    sleep,
    ...extra,
    ev,
    /** 진짜 키 입력 — mods: {ctrl,shift,alt,meta}, printable이면 text도 실어 보낸다 */
    async key(k, mods = {}) {
      const m = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0)
      const printable = k.length === 1 && !mods.ctrl && !mods.alt && !mods.meta
      const base = { modifiers: m, key: k, code: codeOf(k), windowsVirtualKeyCode: vkOf(k), nativeVirtualKeyCode: vkOf(k) }
      await cdp.send('Input.dispatchKeyEvent', { type: printable ? 'keyDown' : 'rawKeyDown', ...base, ...(printable ? { text: k } : {}) })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      await sleep(40)
    },
    /** 합성 keydown (window 레벨 훅 전용 — 인벤토리의 __k) */
    pageKey: (k, mods = {}) => ev(`__k(${S(k)}, ${JSON.stringify(mods)})`),
    /** DOM .click() — 인벤토리의 __c */
    async click(sel, n = 0) {
      const ok = await ev(`__c(${S(sel)}, ${n})`)
      if (!ok) throw new Error(`click: no element ${sel}[${n}]`)
      await sleep(120)
    },
    /** 텍스트가 들어 있는 첫 요소 클릭 (메뉴 항목처럼 순서가 흔들리는 것) */
    async clickText(sel, needle, n = 0) {
      const ok = await ev(`__txt(${S(sel)}, ${S(needle)}, ${n})`)
      if (!ok) throw new Error(`clickText: no ${sel} containing ${needle}`)
      await sleep(120)
    },
    /** 있으면 클릭, 없으면 조용히 false (reset 경로 전용) */
    async tryClickText(sel, needle) {
      const ok = await ev(`__txt(${S(sel)}, ${S(needle)})`).catch(() => false)
      if (ok) await sleep(120)
      return !!ok
    },
    /** 실제 마우스 클릭 — hover/pointer 경로가 필요한 곳 */
    async realClick(sel, n = 0) {
      const r = await ev(`(() => { const e = document.querySelectorAll(${S(sel)})[${n}]; if (!e) return null
        const b = e.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } })()`)
      if (!r) throw new Error(`realClick: no element ${sel}[${n}]`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none', buttons: 0 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 })
      await sleep(150)
      return r
    },
    /** 실제 마우스 호버 (툴팁·peek) */
    async hover(sel, n = 0, holdMs = 600) {
      const r = await ev(`(() => { const e = document.querySelectorAll(${S(sel)})[${n}]; if (!e) return null
        const b = e.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } })()`)
      if (!r) throw new Error(`hover: no element ${sel}[${n}]`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x - 4, y: r.y, button: 'none', buttons: 0 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none', buttons: 0 })
      await sleep(holdMs)
      return r
    },
    /** React 제어 입력에 값 넣기 — 인벤토리의 __type */
    async type(sel, v) {
      const ok = await ev(`__type(${S(sel)}, ${S(v)})`)
      if (!ok) throw new Error(`type: no input ${sel}`)
      await sleep(160)
    },
    ctxMenu: async (sel, n = 0) => {
      const ok = await ev(`__ctx(${S(sel)}, ${n})`)
      if (!ok) throw new Error(`ctxMenu: no element ${sel}[${n}]`)
      await sleep(180)
    },
    count: (sel) => ev(`__n(${S(sel)})`),
    has: async (sel) => (await ev(`__n(${S(sel)})`)) > 0,
    /** 셀렉터가 나타날 때까지 폴링 */
    async waitFor(sel, ms = 6000, min = 1) {
      const t0 = Date.now()
      for (;;) {
        const n = await ev(`__n(${S(sel)})`).catch(() => 0)
        if (n >= min) return n
        if (Date.now() - t0 > ms) throw new Error(`waitFor timeout: ${sel} (${min})`)
        await sleep(80)
      }
    },
    /** 셀렉터가 사라질 때까지 폴링 (없어도 조용히 통과) */
    async waitGone(sel, ms = 4000) {
      const t0 = Date.now()
      for (;;) {
        const n = await ev(`__n(${S(sel)})`).catch(() => 0)
        if (!n) return true
        if (Date.now() - t0 > ms) return false
        await sleep(80)
      }
    },
    async esc(times = 1) {
      for (let i = 0; i < times; i++) { await ctxKeyEsc(cdp); await sleep(140) }
    },
    blur: () => ev(`(document.activeElement && document.activeElement.blur(), true)`),
    /** 컴포저 비우기 — 슬래시/멘션 팔레트·2줄 승격의 뒷정리 */
    async clearComposer() {
      await ev(`__type('.composer textarea', '')`).catch(() => false)
      await sleep(120)
    },
    /** 탐색기 열기 (백쿼트 — 입력 포커스가 있으면 먹지 않으니 먼저 blur) */
    async openExplorer() {
      if (await ctx.has('.lcol .explorer')) return
      await ctx.blur()
      await ctx.key('`')
      await ctx.waitFor('.lcol .explorer', 5000)
      await sleep(300)
    },
    async closeExplorer() {
      if (!(await ctx.has('.lcol .explorer'))) return
      await ctx.blur()
      await ctx.key('`')
      await sleep(300)
    },
    /** 탐색기 검색으로 파일을 찾아 뷰어에 연다 */
    async openFile(needle) {
      await ctx.openExplorer()
      await ctx.type('.fxs input', needle)
      await ctx.waitFor('.explorer .fxtree .fxr', 8000)
      await sleep(400)
      const ok = await ev(`(() => {
        const rows = [...document.querySelectorAll('.explorer .fxtree .fxr')]
        const hit = rows.find((r) => (r.textContent || '').includes(${S(needle)}))
        if (!hit) return false
        hit.click(); return true
      })()`)
      if (!ok) throw new Error(`openFile: ${needle} not in search results`)
      await ctx.waitFor('.fv-overlay .fv-modal', 12000)
      await sleep(700)
    },
    /** 뷰어 닫기 — 미저장 확인 카드가 뜨면 '저장 안 함'으로 빠져나온다 */
    async closeViewer() {
      if (!(await ctx.has('.fv-overlay'))) return
      await ctx.esc(1)
      await sleep(250)
      if (await ctx.has('.set-dialog-overlay')) {
        if (!(await ctx.tryClickText('.set-dialog button', '저장 안 함'))) {
          if (!(await ctx.tryClickText('.set-dialog button', "Don't save"))) await ctx.esc(1)
        }
        await sleep(250)
      }
      await ctx.waitGone('.fv-overlay', 4000)
    },
    async clearSearch() {
      if (await ctx.has('.fxs input')) { await ev(`__type('.fxs input', '')`).catch(() => false); await sleep(250) }
    },
    /** 트리 행 개수 — 텍스트로 찾는다 (검색 결과 행에는 우클릭 메뉴가 없어 트리를 써야 한다) */
    treeRowCount: (text) => ev(`[...document.querySelectorAll('.explorer .fxtree .fxr')].filter((r) => (r.textContent || '').includes(${S(text)})).length`),
    /**
     * 트리를 chain 순서로 펼쳐 until 텍스트의 행이 보이게 한다.
     * 폴더 행 클릭은 토글이라(이미 열려 있으면 닫힌다) until이 보일 때까지 최대 3바퀴 돈다.
     */
    async revealInTree(chain, until) {
      await ctx.openExplorer()
      await ctx.clearSearch()
      await sleep(400)
      for (let round = 0; round < 4; round++) {
        for (let i = 0; i < chain.length; i++) {
          const child = chain[i + 1] ?? until
          // 자식이 이미 보이면 그 폴더는 펼쳐진 것 — 여기서 누르면 도로 접힌다(토글)
          if (child && (await ctx.treeRowCount(child)) > 0) continue
          await ev(`(() => {
            const rows = [...document.querySelectorAll('.explorer .fxtree .fxr')]
            const hit = rows.find((r) => (r.textContent || '').trim() === ${S(chain[i])})
            if (!hit) return false
            hit.click(); return true
          })()`).catch(() => false)
          await sleep(700)
        }
        if (!until) return true
        if ((await ctx.treeRowCount(until)) > 0) return true
      }
      throw new Error(`revealInTree: ${until} 행이 안 보임 (${chain.join('/')})`)
    },
    /** 트리 행에 우클릭 (텍스트 매칭) */
    async ctxTreeRow(text) {
      const ok = await ev(`(() => {
        const rows = [...document.querySelectorAll('.explorer .fxtree .fxr')]
        const hit = rows.find((r) => (r.textContent || '').includes(${S(text)}))
        if (!hit) return false
        const b = hit.getBoundingClientRect()
        hit.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 8, clientY: b.top + 8, button: 2 }))
        return true
      })()`)
      if (!ok) throw new Error(`ctxTreeRow: ${text} 행 없음`)
      await sleep(250)
    },
    /** 설정 모달 열기 + 레일 N번 탭 */
    async openSettings(tab = 0) {
      if (!(await ctx.has('.set-modal'))) {
        await ctx.click('.sb-foot')
        await ctx.waitFor('.set-modal', 6000)
        await sleep(350)
      }
      if (tab > 0) { await ctx.click('.set-ni', tab); await sleep(350) }
    },
    /** 사이드바에서 채팅 고르기 (제목 매칭) */
    async selectChat(title) {
      await ctx.closeExplorer()
      await ctx.waitFor('.sidebar .sb-item', 5000)
      await ctx.clickText('.sidebar .sb-item', title)
      await sleep(600)
    }
  }
  return ctx
}

async function ctxKeyEsc(cdp) {
  const base = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, modifiers: 0 }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

// ── 픽스처 증강 — 실행(엔진) 없이 도달할 수 있는 화면을 늘린다 ──────────────────
// sanitizeSnapshot(실측: src/renderer/src/store/session.ts:336)이 todos/files/diffs/
// subagents/bgTasks/messages를 그대로 살려 복원하므로, 스냅샷에 심어 두면 워크바 팝오버
// 행·상세 카드·뷰어 diff 마킹이 엔진 턴 없이 뜬다. workflows는 복원되지 않아(초기값으로
// 덮인다) 워크플로 화면만은 실행이 필요하다.
const SCRATCH_REL = 'bench/scratch'

export function scratchFiles(repo) {
  const dir = path.join(repo, 'bench', 'scratch')
  return {
    dir,
    sample: path.join(dir, 'ccgbench-sample.ts'),
    doc: path.join(dir, 'ccgbench-doc.md'),
    page: path.join(dir, 'ccgbench-page.html'),
    icon: path.join(dir, 'ccgbench-icon.svg'),
    blank: path.join(dir, 'ccgbench-blank.txt'),
    bin: path.join(dir, 'ccgbench-binary.dat'),
    huge: path.join(dir, 'ccgbench-huge.ts'),
    ro: path.join(dir, 'ccgbench-ro.txt'),
    img: path.join(dir, 'ccgbench-shot.png')
  }
}

/** 뷰어 화면이 쓸 스크래치 파일 — 레포 소스는 절대 건드리지 않는다(다른 에이전트가 동시 작업 중). */
export function makeScratch(repo) {
  const f = scratchFiles(repo)
  fs.mkdirSync(f.dir, { recursive: true })
  fs.writeFileSync(f.sample, SAMPLE_TS)
  fs.writeFileSync(f.doc, SAMPLE_MD)
  fs.writeFileSync(f.page, SAMPLE_HTML)
  fs.writeFileSync(f.icon, SAMPLE_SVG)
  fs.writeFileSync(f.blank, '')
  // 미리보기 불가 파일 — main/index.ts의 isBinary가 앞 8000바이트의 NUL로 판정한다
  fs.writeFileSync(f.bin, Buffer.concat([Buffer.from('CCGBENCH\0BINARY'), Buffer.alloc(4096)]))
  // 읽기 상한(1.5MB, main/index.ts) 초과 — '일부만 표시' 칩
  fs.writeFileSync(f.huge, Array.from({ length: 45000 }, (_, i) =>
    `export const row${i} = { id: ${i}, name: 'huge-${i}', note: '캐시 세대 비교 샘플 행 ${i}' }`).join('\n'))
  try { fs.chmodSync(f.ro, 0o666) } catch { /* 아직 없음 */ }
  fs.writeFileSync(f.ro, 'read-only sample for the save-error card\n')
  try { fs.chmodSync(f.ro, 0o444) } catch { /* 무시 */ }
  const src = path.join(repo, 'docs', 'chat.png')
  if (fs.existsSync(src)) fs.copyFileSync(src, f.img)
  return f
}

// 뷰어 창보다 길어야 diff 오버뷰 룰러(rulerOverflows 조건)가 그려진다 — 200줄로 채운다
const SAMPLE_TS = `// 벤치 스크래치 — 뷰어(읽기/편집/diff/찾기) 화면 캡처 전용 샘플.
export interface CacheEntry {
  key: string
  rev: number
  tokens: string[]
}

export function invalidate(rev: number, entries: CacheEntry[]): CacheEntry[] {
  return entries.filter((e) => e.rev >= rev)
}

export function summarize(entries: CacheEntry[]): string {
  const total = entries.reduce((a, e) => a + e.tokens.length, 0)
  return \`\${entries.length} entries / \${total} tokens\`
}

export const DEFAULTS = { rev: 0, tokens: [] as string[] }

${Array.from({ length: 36 }, (_, i) => `
/** 구간 ${i} — 무효화 경로의 세대 비교 스텝 */
export function step${i}(rev: number, entries: CacheEntry[]): CacheEntry | null {
  const hit = entries.find((e) => e.rev === rev && e.key.startsWith('s${i}'))
  if (!hit) return null
  return { ...hit, tokens: [...hit.tokens, 'step-${i}'] }
}`).join('\n')}
`

const SAMPLE_MD = `# 벤치 스크래치 문서

뷰어의 **마크다운 렌더 뷰**와 *변경 소스 보기*를 캡처하려고 둔 파일이다.

## 규칙

1. 세대 비교로만 무효화한다
2. 소비자는 폴링하지 않는다
3. 실패는 상위로 전파한다

\`\`\`ts
export function step(rev: number) {
  return registry.at(rev)
}
\`\`\`

> 인용 — 이 문단은 렌더 스타일 비교용이다.

| 항목 | 값 |
| --- | --- |
| 무효화 | 세대 비교 |
| 전파 | 상위 |
`

const SAMPLE_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>벤치 페이지</title>
<style>body{background:#12141a;color:#e6e8ee;font:14px/1.6 system-ui;margin:0;padding:28px}
h1{font-size:20px;margin:0 0 12px}.card{background:#191c24;border:1px solid #262a34;border-radius:12px;padding:16px;max-width:420px}
.b{display:inline-block;background:#0EA5E9;color:#04121a;border-radius:999px;padding:2px 10px;font-size:12px}</style>
</head><body><h1>HTML 미리보기 샘플</h1>
<div class="card"><span class="b">ccg-page</span><p>뷰어의 페이지 미리보기(ccg-page 스킴)와 코드 보기 토글 캡처용.</p></div>
</body></html>
`

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <rect x="4" y="4" width="40" height="40" rx="10" fill="#0EA5E9"/>
  <path d="M16 30 L24 16 L32 30 Z" fill="#04121a"/>
</svg>
`

function diffFor(rel, tag, add, del) {
  return {
    path: rel, tag, add, del,
    // 훙크 머리(@@ -N)를 넣으면 안 된다 — FileModal의 fragment 가드가 "조각 diff"로 보고
    // marks를 통째로 버려(변경 보기 토글·룰러가 사라짐) 실측으로 확인한 함정.
    lines: [
      { t: 'ctx', text: '// 벤치 스크래치 — 뷰어(읽기/편집/diff/찾기) 화면 캡처 전용 샘플.' },
      { t: 'del', text: 'export interface Cache {' },
      { t: 'add', text: 'export interface CacheEntry {' },
      { t: 'ctx', text: '  key: string' },
      { t: 'ctx', text: '  rev: number' },
      { t: 'del', text: '  tokens: Array<string>' },
      { t: 'add', text: '  tokens: string[]' },
      { t: 'ctx', text: '}' },
      { t: 'ctx', text: '' },
      { t: 'add', text: 'export function invalidate(rev: number, entries: CacheEntry[]): CacheEntry[] {' },
      { t: 'add', text: '  return entries.filter((e) => e.rev >= rev)' },
      { t: 'add', text: '}' }
    ]
  }
}

/**
 * 픽스처 홈을 화면 캡처용으로 증강한다 (bench/fixture.mjs는 다른 벤치의 기준선이라 손대지 않는다).
 *  - fix-long-thread 스냅샷에 todos/files/diffs/subagents/bgTasks/cmdresult/qa/interrupted 주입
 *  - fix-empty (빈 채팅 — 웰컴·빈 탐색기), fix-boom (렌더 예외 — 에러 안전망) 추가
 */
export function augmentFixture(home, { repo }) {
  const chatsDir = path.join(home, 'chats')
  const file = path.join(chatsDir, 'fix-long-thread.json')
  const chat = JSON.parse(fs.readFileSync(file, 'utf8'))
  const s = chat.snapshot
  const time = '오후 3:00'

  s.todos = [
    { id: 'td1', text: '캐시 무효화 규칙 정리', status: 'done' },
    { id: 'td2', text: '소비자 폴링을 이벤트 구독으로 교체', status: 'in_progress' },
    { id: 'td3', text: '실패 경로 전파 테스트 추가', status: 'pending' },
    { id: 'td4', text: '벤치 스크래치 정리', status: 'pending' }
  ]
  const relSample = `${SCRATCH_REL}/ccgbench-sample.ts`
  const relDoc = `${SCRATCH_REL}/ccgbench-doc.md`
  s.files = [
    { path: relSample, add: 3, del: 2, tag: 'edit' },
    { path: relDoc, add: 12, del: 0, tag: 'new' }
  ]
  s.diffs = {
    [relSample]: diffFor(relSample, 'edit', 3, 2),
    [relDoc]: diffFor(relDoc, 'new', 12, 0)
  }
  s.subagents = [
    {
      id: 'sa1', name: 'Explore', role: 'explore', status: 'done', model: 'Haiku 4.5',
      activity: '캐시 경로 3곳을 훑어 무효화 지점을 좁혔어요',
      durationMs: 18400,
      log: ['registry.at 호출부 수집', 'invalidate 경로 비교', '폴링 소비자 2곳 확인'],
      tools: [
        { id: 'sat1', verb: 'Search', kind: 'search', target: 'invalidate\\(rev', status: 'done', result: '7건', durationMs: 60 },
        { id: 'sat2', verb: 'Read', kind: 'read', target: 'src/store/registry.ts', status: 'done', result: '311줄', durationMs: 22 }
      ]
    },
    {
      id: 'sa2', name: 'Plan', role: 'plan', status: 'done', model: 'Haiku 4.5',
      activity: '교체 순서를 3단계로 나눴어요', durationMs: 9100, tools: []
    }
  ]
  s.bgTasks = [
    { id: 'bg1', kind: 'local_bash', description: 'npm run build -- --watch', status: 'running', outputFile: 'C:\\\\tmp\\\\ccg-bg1.log' },
    { id: 'bg2', kind: 'local_bash', description: 'vitest --watch cache', status: 'completed', summary: '24 passed', outputFile: 'C:\\\\tmp\\\\ccg-bg2.log' }
  ]
  // 스레드 꼬리에 카드류를 심어 둔다 — 꼬리 윈도잉이 마지막 60개를 그리므로 바로 보인다
  const tail = [
    { kind: 'cmdresult', id: 'cmd1', name: 'init', title: 'CLAUDE.md를 만들었어요', sub: '프로젝트 구조·빌드 명령·규약 요약', stats: '12.4s · 3 파일 읽음', time, running: false },
    { kind: 'qa', id: 'qa1', pairs: [{ q: '캐시 무효화를 어느 층에서 할까요?', a: ['레지스트리 층'] }] },
    { kind: 'notice', id: 'nz1', text: '정책 거부로 모델을 자동 전환했어요', time },
    { kind: 'interrupted', id: 'itr1' }
  ]
  const last = s.messages[s.messages.length - 1]
  s.messages = [...s.messages.slice(0, -1), ...tail, last]
  chat.snapshot = s
  fs.writeFileSync(file, JSON.stringify(chat))

  // 빈 채팅 — 웰컴 화면 / 빈 탐색기
  fs.writeFileSync(path.join(chatsDir, 'fix-empty.json'), JSON.stringify({
    id: 'fix-empty', title: '벤치 빈 채팅', custom: true, updatedAt: Date.now() - 1000,
    picker: { model: 'haiku', effort: 'minimal', mode: 'bypass' },
    snapshot: { status: 'idle', messages: [], todos: [], files: [], diffs: {}, subagents: [], bgTasks: [], session: null, result: null, spentUsd: 0, tokenTotals: {}, seq: 0, shownNotices: [] }
  }))

  // 렌더 예외 채팅 — 메시지 text가 객체라 React가 자식 렌더에서 던진다 → ErrorBoundary
  fs.writeFileSync(path.join(chatsDir, 'fix-boom.json'), JSON.stringify({
    id: 'fix-boom', title: '벤치 예외 채팅', custom: true, updatedAt: Date.now() - 2000,
    manualCwd: repo,
    picker: { model: 'haiku', effort: 'minimal', mode: 'bypass' },
    snapshot: {
      status: 'idle',
      messages: [{ kind: 'msg', id: 'boom1', role: 'assistant', text: { boom: true }, animate: false, time }],
      todos: [], files: [], diffs: {}, subagents: [], bgTasks: [], session: null, result: null,
      spentUsd: 0, tokenTotals: {}, seq: 1, shownNotices: []
    }
  }))

  const idx = path.join(chatsDir, 'index.json')
  fs.writeFileSync(idx, JSON.stringify({ version: 1, order: ['fix-long-thread', 'fix-empty', 'fix-boom'], activeChatId: 'fix-long-thread' }))
  return { relSample, relDoc }
}

/** localStorage 시드 (최근 폴더 2곳·저장 프롬프트 2건) — 폴더 변경 확인 카드·프롬프트 삭제 확인용. */
export function primeJs(repo) {
  const dirs = [
    { p: repo, t: Date.now() },
    { p: path.join(repo, 'src'), t: Date.now() - 60000 },
    { p: path.join(repo, 'bench'), t: Date.now() - 120000 }
  ]
  const prompts = [
    { id: 'pb1', title: '리팩터 요청', text: '이 파일의 중복을 줄이고 이름을 규약에 맞춰 정리해줘.', t: Date.now() },
    { id: 'pb2', title: '', text: '실패 재현 절차를 먼저 쓰고, 그다음 최소 수정안을 제시해줘.', t: Date.now() - 3600_000 }
  ]
  return `(() => {
    localStorage.setItem('recent.workdirs', ${JSON.stringify(JSON.stringify(dirs))})
    localStorage.setItem('prompt.library', ${JSON.stringify(JSON.stringify(prompts))})
    return true
  })()`
}

// ── 페이지-사이드 조작 스니펫 ────────────────────────────────────────────────────
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAWklEQVR42u3QMQEAAAgDoJnc6BpjDyQg' +
  'dWZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZm' +
  '9m0Bx1cAAWnFrGgAAAAASUVORK5CYII='

const dropJs = (count) => `(async () => {
  const el = document.querySelector('.composer'); if (!el) return false
  const bin = atob(${JSON.stringify(TINY_PNG)})
  const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  const dt = new DataTransfer()
  for (let i = 0; i < ${count}; i++) dt.items.add(new File([arr], 'bench-shot-' + (i + 1) + '.png', { type: 'image/png' }))
  el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
  el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
  el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  return true
})()`

const DRAG_ENTER_JS = `(() => {
  const el = document.querySelector('.composer'); if (!el) return false
  const bin = atob(${JSON.stringify(TINY_PNG)})
  const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  const dt = new DataTransfer(); dt.items.add(new File([arr], 'bench-drop.png', { type: 'image/png' }))
  el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }))
  el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
  return true
})()`

const DRAG_LEAVE_JS = `(() => {
  const el = document.querySelector('.composer'); if (!el) return true
  el.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))
  return true
})()`

const selectJs = (root) => `(() => {
  const host = document.querySelector(${JSON.stringify(root)}); if (!host) return false
  const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  let node = null, n
  while ((n = w.nextNode())) { if ((n.textContent || '').trim().length > 20) { node = n; break } }
  if (!node) return false
  const r = document.createRange()
  r.setStart(node, 0); r.setEnd(node, Math.min(48, node.textContent.length))
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r)
  const b = r.getBoundingClientRect()
  const el = node.parentElement
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: b.left + 6, clientY: b.top + 6 }))
  document.dispatchEvent(new Event('selectionchange'))
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 6, clientY: b.top + 6, button: 2 }))
  return true
})()`

const CLEAR_SEL_JS = `(() => { const s = window.getSelection(); if (s) s.removeAllRanges(); return true })()`

const gestureJs = `(() => {
  const el = document.querySelector('.chat-scroll'); if (!el) return false
  const b = el.getBoundingClientRect()
  let x = Math.round(b.left + b.width / 2), y = Math.round(b.top + b.height / 2)
  const pe = (type) => el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2, pointerId: 1, pointerType: 'mouse'
  }))
  pe('pointerdown')
  for (let i = 0; i < 12; i++) { y -= 16; pe('pointermove') }
  return true
})()`

const gestureEndJs = `(() => {
  const el = document.querySelector('.chat-scroll'); if (!el) return true
  const b = el.getBoundingClientRect()
  el.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, cancelable: true, clientX: Math.round(b.left + b.width / 2), clientY: Math.round(b.top + b.height / 2),
    button: 2, buttons: 0, pointerId: 1, pointerType: 'mouse'
  }))
  return true
})()`

const wheelZoomJs = (deltaY) => `(() => {
  const el = document.querySelector('.chat-scroll'); if (!el) return false
  const b = el.getBoundingClientRect()
  el.dispatchEvent(new WheelEvent('wheel', {
    bubbles: true, cancelable: true, ctrlKey: true, deltaY: ${deltaY},
    clientX: Math.round(b.left + b.width / 2), clientY: Math.round(b.top + b.height / 2)
  }))
  return true
})()`

/**
 * /btw 창 열기 — 세 화면(btw-dock · multi-panel-btw-dock · session-window-btw)의 공통 조작.
 *
 * [함정] '/btw'는 실제 슬래시 명령이라(Chat.tsx의 commands에 name:'btw') 그대로 치면
 * 슬래시 팔레트가 열리고, 그 상태의 Enter는 **전송이 아니라 항목 선택**이다
 * (handleKey: slashOpen이면 pickSlash 후 return). 그래서 창이 안 뜨고 컴포저엔 '/btw '만
 * 남는다 — 이 하네스가 실제로 밟은 오진. 뒤에 공백을 붙여 넣으면 slashQuery가 null이 돼
 * (`value.startsWith('/') && !/\s/.test(value)`) 팔레트가 애초에 안 열린다.
 * parseBtw는 trim 후 판정하므로 '/btw '는 인라인 질문 없는 정상 명령이다.
 */
async function openBtw(ctx, composerSel = '.composer textarea') {
  await ctx.closeSubWindows('#session')
  await ctx.realClick(composerSel)
  await ctx.type(composerSel, '/btw ')
  await sleep(350)
  const seen = await ctx.windowIds('#session')
  await ctx.key('Enter')
  try {
    return await ctx.waitForNewWindow('#session', seen, 9000)
  } catch {
    // 그래도 안 떴으면 팔레트가 먹은 것 — 컴포저에 남은 '/btw '를 한 번 더 보낸다
    await ctx.realClick(composerSel)
    await ctx.key('Enter')
    return await ctx.waitForNewWindow('#session', seen, 12000)
  }
}

/**
 * 작업 폴더 팝오버 열기 — 헤더의 폴더 칩은 **토글**이라 한 번의 클릭이 늘 '열기'가 아니다.
 * (앞 화면의 뒷정리 Esc 타이밍에 따라 클릭이 먹지 않거나 열자마자 닫히는 걸 실측했다:
 *  folder-switch-dialog가 `waitFor timeout: .hfold .wb-pop.hpop`으로 떨어진 원인.)
 * 그래서 열릴 때까지 __c → 진짜 마우스 클릭 순으로 최대 4바퀴 돈다.
 */
async function openFolderPop(ctx, chip = '.chat-head .fsel', pop = '.hfold .wb-pop.hpop') {
  await ctx.blur()
  for (let i = 0; i < 4; i++) {
    if (await ctx.has(pop)) return true
    await ctx.click(chip).catch(() => {})
    await sleep(400)
    if (await ctx.has(pop)) return true
    await ctx.realClick(chip).catch(() => {})
    await sleep(400)
  }
  if (await ctx.has(pop)) return true
  throw new Error(`폴더 팝오버가 열리지 않음: ${pop}`)
}

/** 방금 뜬 btw/추가 채팅 창을 최소화 — 도크 알약은 shown=false인 창만 그린다 */
async function minimizeWindow(ctx, target) {
  const sub = await ctx.attachTarget(target)
  await sub.eval(`(window.api && window.api.win ? window.api.win.minimize() : null, true)`).catch(() => {})
  sub.close()
  await sleep(500)
}

// ── 화면 정의 ────────────────────────────────────────────────────────────────────
// 순서 = 실행 순서. 상태를 크게 흔드는 묶음(멀티·설정 자동숨김·독립 창)은 뒤로 뺐다.
export const SCREENS = [
  // ══ 1. 부팅 · 안전망 ══════════════════════════════════════════════════════════
  {
    id: 'boot-splash-native', label: '네이티브 시작 스플래시', area: '1. 부팅', surface: 'panel-window',
    needsEngine: false, needsAccount: false, boot: 'splash',
    assert: '.card .spin',
    note: '앱 스폰 직후 data: 타깃 — ab.mjs의 boot 페이즈가 기동과 동시에 폴링해 잡는다'
  },
  {
    id: 'boot-loading', label: '렌더러 로딩 화면', area: '1. 부팅', surface: 'main-window',
    needsEngine: false, needsAccount: false,
    // 프로덕션에선 수십 ms — CPU 스로틀로 늘려 잡는다.
    // reload가 실행 컨텍스트를 갈아치우므로 이 화면의 폴링은 주입 헬퍼(__n)를 절대 쓰지
    // 않는다 — 순수 document.querySelectorAll만 본다(헬퍼는 reset에서 다시 심는다).
    reach: async (cdp, ctx) => {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 30 }).catch(() => {})
      await cdp.send('Page.reload', { ignoreCache: true })
      const t0 = Date.now()
      for (;;) {
        const hit = await cdp
          .eval(`document.querySelectorAll('.win .boot .boot-spin').length > 0`)
          .catch(() => false)
        if (hit) break
        if (Date.now() - t0 > 60000) throw new Error('boot 화면을 잡지 못함')
        await sleep(20)
      }
    },
    assert: '.win .boot .boot-spin',
    reset: async (cdp, ctx) => {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {})
      // 헬퍼는 reload에 날아갔다 — 먼저 다시 심어야 waitFor가 산다
      await cdp.eval(HELPERS_JS).catch(() => {})
      await ctx.waitFor('.chat .thread, .chat-scroll', 40000)
      await cdp.eval(HELPERS_JS).catch(() => {})
      await sleep(1200)
    }
  },
  {
    id: 'error-boundary', label: '에러 안전망 카드', area: '1. 부팅', surface: 'main-window',
    needsEngine: false, needsAccount: false,
    // 픽스처의 fix-boom 채팅 = 메시지 text가 객체 → 렌더 중 throw → ErrorBoundary
    reach: async (cdp, ctx) => { await ctx.selectChat('벤치 예외 채팅'); await ctx.waitFor('.eb .eb-card .eb-title', 6000) },
    assert: '.eb .eb-card .eb-title',
    reset: async (cdp, ctx) => {
      await cdp.send('Page.reload', {})
      await ctx.waitFor('.win', 30000)
      await sleep(1500)
      // 활성 채팅이 예외 채팅으로 남으면 이후 전부 깨진다 — 긴 스레드로 되돌린다
      await ctx.selectChat('벤치 긴 스레드').catch(() => {})
      await sleep(600)
    }
  },

  // ══ 2. 본채팅 ═════════════════════════════════════════════════════════════════
  { id: 'chat-thread', label: '대화 스레드(코드 뷰)', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false, reach: async () => {}, assert: '.chat.chat--code .thread' },
  { id: 'chat-header', label: '채팅 헤더', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false, reach: async () => {}, assert: '.chat-head .hfold' },
  { id: 'composer', label: '컴포저(한 줄 고스트 필)', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false, reach: async () => {}, assert: '.composer .composer-row' },
  { id: 'workbar', label: '작업 바(5칩)', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false, reach: async () => {}, assert: '.workbar .wb-chip', assertMin: 5 },
  {
    id: 'chat-welcome', label: '웰컴(빈 채팅)', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.selectChat('벤치 빈 채팅'); await ctx.waitFor('.chat-scroll .welcome .wc-grid', 6000) },
    assert: '.chat-scroll .welcome .wc-grid',
    reset: async (cdp, ctx) => { await ctx.selectChat('벤치 긴 스레드') }
  },
  {
    id: 'chat-jump-bottom', label: '맨 아래로 점프 버튼', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.ev(`(() => { const e = document.querySelector('.chat-scroll'); e.scrollTop -= 2400; return true })()`)
      await ctx.waitFor('.jump-bottom-wrap .jump-bottom', 5000)
    },
    assert: '.jump-bottom-wrap .jump-bottom',
    reset: async (cdp, ctx) => {
      await ctx.ev(`(() => { const e = document.querySelector('.chat-scroll'); e.scrollTop = e.scrollHeight; return true })()`)
      await sleep(500)
    }
  },
  {
    id: 'chat-find', label: '대화에서 찾기 바', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.ev(`(window.dispatchEvent(new Event('ccg:chat-find')), true)`); await ctx.waitFor('.chat-find', 5000) },
    assert: '.chat-find',
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.chat-find', 3000) }
  },
  {
    id: 'chat-selection-bar', label: '선택 툴바(복사/더 자세히)', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.ev(selectJs('.thread')); await ctx.waitFor('.sel-bar .sel-act', 5000) },
    assert: '.sel-bar .sel-act',
    reset: async (cdp, ctx) => { await ctx.ev(CLEAR_SEL_JS); await ctx.esc(2); await ctx.waitGone('.sel-bar', 3000) }
  },
  {
    id: 'chat-gesture-overlay', label: '마우스 제스처 궤적·라벨', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.ev(gestureJs); await ctx.waitFor('.mg-trail', 4000) },
    assert: '.mg-trail',
    reset: async (cdp, ctx) => { await ctx.ev(gestureEndJs); await sleep(400); await ctx.waitGone('.mg-trail', 3000) }
  },
  {
    id: 'chat-zoom-badge', label: '줌 배지', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.ev(wheelZoomJs(-120)); await ctx.waitFor('.zoom-badge.on', 4000) },
    // 줌은 이후 모든 캡처를 오염시킨다 — 반대 휠로 되돌리고 배지가 꺼질 때까지 기다린다
    reset: async (cdp, ctx) => {
      await ctx.ev(wheelZoomJs(120)); await sleep(300)
      await ctx.ev(wheelZoomJs(120)); await sleep(300)
      await ctx.waitGone('.zoom-badge.on', 4000)
    },
    assert: '.zoom-badge.on'
  },
  {
    id: 'chat-folder-pop', label: '작업 폴더 팝오버', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await openFolderPop(ctx); await ctx.waitFor('.hfold .wb-pop.hpop', 5000) },
    assert: '.hfold .wb-pop.hpop',
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.wb-pop', 3000) }
  },
  {
    id: 'composer-two-line', label: '컴포저 2줄 승격', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.type('.composer textarea', '캐시 무효화 규칙을 세대 비교 기준으로 정리하고, 소비자 쪽 폴링 두 곳을 이벤트 구독으로 바꾸는 변경안을 파일 단위로 나눠서 제안해줘. 각 단계마다 되돌리기 방법도 같이.')
      await ctx.waitFor('.composer-row.two-line', 5000)
    },
    assert: '.composer-row.two-line',
    reset: async (cdp, ctx) => { await ctx.clearComposer() }
  },
  {
    id: 'composer-picker-pop', label: '모델·모드·과금·계정 통합 팝오버', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.click('.composer .model-chip'); await ctx.waitFor('.picker-pop .pprov', 5000) },
    assert: '.picker-pop .pprov',
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.picker-pop', 3000) }
  },
  {
    id: 'composer-slash-palette', label: '"/" 명령 팔레트(+스킬)', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.type('.composer textarea', '/'); await ctx.waitFor('.slash-menu .slash-opt', 6000) },
    assert: '.slash-menu .slash-opt',
    reset: async (cdp, ctx) => { await ctx.clearComposer(); await ctx.esc(1); await ctx.waitGone('.slash-menu', 3000) }
  },
  {
    id: 'composer-mention-palette', label: '"@" 파일 멘션 팔레트', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.type('.composer textarea', '@'); await ctx.waitFor('.slash-menu .mention-loc', 8000) },
    assert: '.slash-menu .mention-loc',
    reset: async (cdp, ctx) => { await ctx.clearComposer(); await ctx.esc(1); await ctx.waitGone('.slash-menu', 3000) }
  },
  {
    id: 'composer-drop-hint', label: '파일 드롭 힌트 오버레이', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.ev(DRAG_ENTER_JS); await ctx.waitFor('.composer .drop-hint', 4000) },
    assert: '.composer .drop-hint',
    reset: async (cdp, ctx) => { await ctx.ev(DRAG_LEAVE_JS); await ctx.waitGone('.composer .drop-hint', 3000) }
  },
  {
    id: 'composer-attachments', label: '첨부 트레이(이미지 썸네일)', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.ev(dropJs(1), true); await ctx.waitFor('.composer .img-tray .img-thumb', 8000) },
    assert: '.composer .img-tray .img-thumb',
    reset: async (cdp, ctx) => { await clearAttachments(ctx) }
  },
  {
    id: 'image-lightbox', label: '이미지 라이트박스', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.ev(dropJs(1), true)
      await ctx.waitFor('.composer .img-tray .img-thumb-open', 8000)
      await ctx.click('.img-thumb-open')
      await ctx.waitFor('.iv-overlay .iv-stage', 6000)
    },
    assert: '.iv-overlay .iv-stage',
    reset: async (cdp, ctx) => { await ctx.esc(1); await ctx.waitGone('.iv-overlay', 3000); await clearAttachments(ctx) }
  },
  {
    id: 'image-lightbox-strip', label: '라이트박스 — 여러 장(썸네일 스트립)', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.ev(dropJs(3), true)
      await ctx.waitFor('.composer .img-tray .img-thumb-open', 10000, 3)
      await ctx.click('.img-thumb-open')
      await ctx.waitFor('.iv-overlay .iv-strip', 6000)
    },
    assert: '.iv-overlay .iv-strip',
    reset: async (cdp, ctx) => { await ctx.esc(1); await ctx.waitGone('.iv-overlay', 3000); await clearAttachments(ctx) }
  },
  {
    id: 'folder-switch-dialog', label: '작업 폴더 변경 확인 카드', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await openFolderPop(ctx)
      await ctx.waitFor('.hfold .wb-pop.hpop', 5000)
      // 최근 목록(프라임으로 3곳 시드)에서 현재 폴더(.pcheck 달린 행)가 아닌 행을 고른다
      const ok = await ctx.ev(`(() => {
        const rows = [...document.querySelectorAll('.hfold .wb-pop.hpop .wb-prow')]
        const hit = rows.find((r) => !r.querySelector('.pcheck'))
        if (!hit) return false
        hit.click(); return true
      })()`)
      if (!ok) throw new Error('folder-switch: 다른 최근 폴더 행을 찾지 못함')
      await ctx.waitFor('.set-dialog-overlay .set-dialog .sd-title', 6000)
    },
    assert: '.set-dialog-overlay .set-dialog .sd-title',
    // 반드시 취소 — 확인하면 활성 채팅의 작업 폴더가 바뀌어 이후 탐색기/Git 화면이 전부 어긋난다
    reset: async (cdp, ctx) => {
      if (!(await ctx.tryClickText('.set-dialog button', '취소'))) await ctx.esc(1)
      await ctx.waitGone('.set-dialog-overlay', 3000)
      await ctx.esc(1)
      await ctx.waitGone('.wb-pop', 3000)
    }
  },
  {
    id: 'workbar-todo-pop', label: '할 일 팝오버', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.click('.workbar .wb-chip', 0); await ctx.waitFor('.wb-cell .wb-pop .wb-pop-h', 5000) },
    assert: '.wb-cell .wb-pop .wb-pop-h',
    reset: popReset
  },
  {
    id: 'workbar-subagent-pop', label: '서브에이전트 팝오버', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.click('.workbar .wb-chip', 1); await ctx.waitFor('.wb-cell .wb-pop .wb-pop-h', 5000) },
    assert: '.wb-cell .wb-pop .wb-pop-h',
    reset: popReset
  },
  {
    id: 'workbar-shell-pop', label: '백그라운드 셸 팝오버', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.click('.workbar .wb-chip', 2); await ctx.waitFor('.wb-cell .wb-pop .wb-pop-h', 5000) },
    assert: '.wb-cell .wb-pop .wb-pop-h',
    reset: popReset
  },
  {
    id: 'workbar-file-pop', label: '변경된 파일 팝오버', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.click('.workbar .wb-chip', 3); await ctx.waitFor('.wb-cell .wb-pop .wb-pop-h', 5000) },
    assert: '.wb-cell .wb-pop .wb-pop-h',
    reset: popReset
  },
  {
    id: 'workbar-context-pop', label: '컨텍스트·한도 팝오버', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: true,
    reach: async (cdp, ctx) => { await ctx.click('.workbar .wb-chip', 4); await ctx.waitFor('.wb-cell .wb-pop.r .wb-prow', 6000) },
    assert: '.wb-cell .wb-pop.r .wb-prow',
    reset: popReset
  },
  {
    id: 'workbar-context-pop-api', label: '컨텍스트 팝오버 — API 과금 모드', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: true,
    skip: '과금 모드를 API로 바꾸는 조작이 사용자 실계정 api-config.json(키·예산·누적 사용액)을 건드린다 — 벤치에서 과금 경로 조작 금지'
  },
  {
    id: 'subagent-modal', label: '서브에이전트 상세 카드', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.click('.workbar .wb-chip', 1)
      await ctx.waitFor('.wb-cell .wb-pop .wb-pop-h', 5000)
      await ctx.click('.wb-cell .wb-pop .wb-prow, .wb-cell .wb-pop .wb-row', 0)
      await ctx.waitFor('.sa-overlay .dc-card .dc-tool', 6000)
    },
    assert: '.sa-overlay .dc-card .dc-tool',
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.sa-overlay', 3000); await popReset(cdp, ctx) }
  },
  {
    id: 'bgtask-modal', label: '백그라운드 셸 카드(중지)', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.click('.workbar .wb-chip', 2)
      await ctx.waitFor('.wb-cell .wb-pop .wb-pop-h', 5000)
      await ctx.click('.wb-cell .wb-pop .wb-prow, .wb-cell .wb-pop .wb-row', 0)
      await ctx.waitFor('.sa-overlay .dc-card', 6000)
    },
    assert: '.sa-overlay .dc-card',
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.sa-overlay', 3000); await popReset(cdp, ctx) }
  },
  {
    id: 'bash-log-modal', label: 'Bash 출력 카드', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      // 픽스처 toolgroup의 Bash 행 — output이 있어야 openable(BashRow의 clickable 조건)
      await ctx.waitFor('.thread .t-row.bash.openable', 8000)
      const ok = await ctx.ev(`(() => {
        const rows = [...document.querySelectorAll('.thread .t-row.bash.openable')]
        const r = rows[rows.length - 1]; if (!r) return false
        r.scrollIntoView({ block: 'center' })
        r.click(); return true
      })()`)
      if (!ok) throw new Error('bash-log: .t-row.bash 없음')
      await ctx.waitFor('.sa-overlay .dc-card .dc-term', 6000)
    },
    assert: '.sa-overlay .dc-card .dc-term',
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.sa-overlay', 3000) }
  },
  {
    id: 'cmd-result-card', label: '내장 명령 결과 카드(/init 등)', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    // 픽스처 증강이 kind:'cmdresult' 스레드 항목을 꼬리에 심는다 (엔진 턴 없이 같은 렌더)
    reach: async (cdp, ctx) => {
      await ctx.ev(`(() => { const e = document.querySelector('.chat-scroll'); e.scrollTop = e.scrollHeight; return true })()`)
      await ctx.waitFor('.thread .cmd-card .cmd-card-title', 6000)
      await ctx.ev(`(() => { const c = document.querySelector('.thread .cmd-card'); if (c) c.scrollIntoView({ block: 'center' }); return true })()`)
      await sleep(400)
    },
    assert: '.thread .cmd-card .cmd-card-title',
    reset: async (cdp, ctx) => { await ctx.ev(`(() => { const e = document.querySelector('.chat-scroll'); e.scrollTop = e.scrollHeight; return true })()`) }
  },
  {
    id: 'btw-dock', label: '/btw 질문 창 알약 도크', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      const t = await openBtw(ctx)
      await minimizeWindow(ctx, t)
      await ctx.waitFor('.btw-dock .btw-mini', 10000)
    },
    assert: '.btw-dock .btw-mini',
    reset: async (cdp, ctx) => { await ctx.closeSubWindows('#btw', '#session'); await ctx.clearComposer(); await sleep(600) }
  },
  {
    id: 'chat-working', label: '작업 인디케이터(마스코트+경과)', area: '2. 본채팅', surface: 'main-window', needsEngine: true, needsAccount: true,
    engineTurn: 1,
    reach: async (cdp, ctx) => {
      await ctx.type('.composer textarea', '1+1은? 숫자만 한 글자로 답해줘.')
      await sleep(250)
      await ctx.key('Enter')
      await ctx.waitFor('.thread .working-line', 25000)
    },
    assert: '.thread .working-line',
    reset: async (cdp, ctx) => { await ctx.waitTurnIdle(90000) }
  },
  {
    id: 'composer-queue', label: '예약 큐(작업 중 보낸 메시지)', area: '2. 본채팅', surface: 'main-window', needsEngine: true, needsAccount: true,
    engineTurn: 2,
    reach: async (cdp, ctx) => {
      await ctx.type('.composer textarea', '2+2는? 숫자만 한 글자로.')
      await sleep(250)
      await ctx.key('Enter')
      await ctx.waitFor('.thread .working-line', 25000)
      await ctx.type('.composer textarea', '그리고 3+3도 알려줘')
      await sleep(250)
      await ctx.key('Enter')
      await ctx.waitFor('.composer .sched .sched-list', 12000)
    },
    assert: '.composer .sched .sched-list',
    reset: async (cdp, ctx) => { await ctx.waitTurnIdle(120000); await ctx.clearComposer() }
  },
  {
    id: 'permission-card', label: '도구 승인 요청 카드', area: '2. 본채팅', surface: 'main-window', needsEngine: true, needsAccount: true,
    engineTurn: 3,
    reach: async (cdp, ctx) => {
      // 승인 모드를 normal로 바꾼 뒤 쓰기 도구를 유도 (대상은 벤치 스크래치 파일만)
      await ctx.click('.composer .model-chip')
      await ctx.waitFor('.picker-pop .pprov', 5000)
      await ctx.tryClickText('.picker-pop button', '승인 요청')
      await ctx.esc(1)
      await ctx.waitGone('.picker-pop', 3000)
      await ctx.type('.composer textarea', 'bench/scratch/ccgbench-perm.txt 파일에 ok 한 줄만 써줘. 설명은 하지 마.')
      await sleep(250)
      await ctx.key('Enter')
      await ctx.waitFor('.q-overlay .qcard .qopt-deny', 90000)
    },
    assert: '.q-overlay .qcard .qopt-deny',
    reset: async (cdp, ctx) => {
      // 거부로 끝낸다 — 승인하면 파일이 실제로 쓰이고, 폴백 확인 카드가 뜨면 그것도 닫는다
      await ctx.tryClickText('.q-overlay .qopt-deny', '거부')
      await sleep(800)
      await ctx.esc(2)
      await ctx.waitTurnIdle(60000)
      await ctx.clearComposer()
    }
  },
  {
    id: 'question-mini', label: '질문 내려두기 알약', area: '2. 본채팅', surface: 'main-window', needsEngine: true, needsAccount: true,
    skip: '질문/승인 카드가 살아 있는 동안에만 존재 — permission-card 턴을 거부로 닫는 벤치 정책과 충돌(승인 카드를 남긴 채 알약으로 내리면 다음 화면이 전부 오염)'
  },
  { id: 'question-card', label: 'AI 질문 카드', area: '2. 본채팅', surface: 'main-window', needsEngine: true, needsAccount: true, skip: 'AskUserQuestion 도구 호출은 모델 재량이라 결정적 재현 불가 — 5턴 예산 안에서 안정적으로 뽑히지 않는다' },
  { id: 'question-card-multistep', label: 'AI 질문 카드 — 다단계(N/M)', area: '2. 본채팅', surface: 'main-window', needsEngine: true, needsAccount: true, skip: '질문 2개 이상을 모델이 한 번에 내야 함 — 재현 비결정적' },
  { id: 'workflow-dock', label: '워크플로 알약 도크', area: '2. 본채팅', surface: 'main-window', needsEngine: true, needsAccount: true, skip: 'workflows는 sanitizeSnapshot이 복원하지 않아 픽스처로 심을 수 없고(초기값으로 덮임), 상주 워크플로 실행은 5턴 예산 밖' },
  { id: 'workflow-card', label: '워크플로 펼침 카드', area: '2. 본채팅', surface: 'main-window', needsEngine: true, needsAccount: true, skip: '위와 같음 — 워크플로 상주 실행 필요' },
  {
    id: 'limit-hold-bar', label: '한도 자동 이어서 대기표 바', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    boot: 'limit-hold',
    assert: '.limit-hold-wrap .limit-hold',
    note: 'ui-prefs의 limitResume.hold를 심고 재기동 — ab.mjs boot 페이즈'
  },
  {
    id: 'autohide-preview', label: '사이드바 감지 폭 미리보기 띠', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openSettings(6)
      await ctx.waitFor('.set-inner .set-sec', 5000)
      await setAutohide(ctx, true)
      await sleep(500)
      // 띠는 슬라이더 래퍼의 onPointerEnter가 띄운다(previewTrigger) — 진짜 호버가 필요
      const idx = await ctx.ev(`(() => {
        const secs = [...document.querySelectorAll('.set-inner .sc2')]
        return secs.findIndex((s) => !!s.querySelector('input[type=range]') && /감지 폭|Trigger width/.test(s.textContent || ''))
      })()`)
      if (idx < 0) throw new Error('autohide-preview: 감지 폭 슬라이더 없음')
      await ctx.hover('.set-inner .sc2', idx, 700)
      await ctx.waitFor('.autohide-trigger-preview .atp-lbl', 5000)
    },
    assert: '.autohide-trigger-preview .atp-lbl',
    reset: async (cdp, ctx) => {
      await ctx.ev(`(() => { const s = [...document.querySelectorAll('.set-inner .sc2')].find((x) => x.querySelector('input[type=range]'))
        if (s) s.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false })); return true })()`).catch(() => {})
      await sleep(300)
    }
  },
  {
    id: 'sidebar-autohide-edge', label: '사이드바 자동 숨김 — 접힘/가장자리 띠', area: '2. 본채팅', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openSettings(6)
      await setAutohide(ctx, true)
      await ctx.esc(2)
      await ctx.waitGone('.set-modal', 4000)
      await ctx.waitFor('.lcol.autohide', 6000)
    },
    assert: '.lcol.autohide',
    // 켜 둔 채로 넘어가면 이후 사이드바 화면이 전부 접힌 상태로 찍힌다 — 반드시 끈다
    reset: async (cdp, ctx) => {
      await ctx.openSettings(6)
      await setAutohide(ctx, false)
      await ctx.esc(2)
      await ctx.waitGone('.set-modal', 4000)
      await ctx.waitGone('.lcol.autohide', 4000)
      await sleep(400)
    }
  },

  // ══ 3. 사이드바 · 새 채팅 · 프롬프트 ═══════════════════════════════════════════
  // ★ 3.0 M-UX — 2.6.2는 3섹션(일반/멀티/추가), 3.0은 2섹션(채팅/배치)이다. 도달 경로와
  // 판정 셀렉터는 같고(섹션이 하나라도 있으면 통과) **화면만 다르다** — 의도된 변경 화면.
  { id: 'sidebar', label: '채팅 사이드바(2.6.2=3섹션 / 3.0=채팅·배치 2섹션)', area: '3. 사이드바', surface: 'main-window', needsEngine: false, needsAccount: false, reach: async (cdp, ctx) => { await ctx.closeExplorer() }, assert: '.lcol .sidebar .sb-sec' },
  {
    id: 'sidebar-empty', label: '섹션 빈 상태', area: '3. 사이드바', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.closeExplorer(); await ctx.waitFor('.sb-list .sb-empty', 5000) },
    assert: '.sb-list .sb-empty'
  },
  {
    id: 'sidebar-section-search', label: '섹션 검색 입력', area: '3. 사이드바', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.closeExplorer(); await ctx.click('.sb-sec .slb'); await ctx.waitFor('.sb-search2 input', 5000) },
    assert: '.sb-search2 input',
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.sb-search2', 3000) }
  },
  {
    id: 'sidebar-ctx-menu', label: '채팅 우클릭 메뉴', area: '3. 사이드바', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.closeExplorer(); await ctx.ctxMenu('.sb-item'); await ctx.waitFor('.ctx-menu .ctx-item', 5000) },
    assert: '.ctx-menu .ctx-item',
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.ctx-menu', 3000) }
  },
  {
    id: 'sidebar-rename-inline', label: '채팅 이름 인라인 편집', area: '3. 사이드바', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.closeExplorer()
      await ctx.ctxMenu('.sb-item')
      await ctx.waitFor('.ctx-menu .ctx-item', 5000)
      await ctx.clickText('.ctx-menu .ctx-item', '이름 변경')
      await ctx.waitFor('.sb-item .sb-edit', 5000)
    },
    assert: '.sb-item .sb-edit',
    // Esc로 취소 — 커밋되면 채팅 제목이 바뀌어 이후 selectChat이 전부 어긋난다
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.sb-item .sb-edit', 3000) }
  },
  {
    id: 'sidebar-delete-confirm', label: '채팅 삭제 확인 카드', area: '3. 사이드바', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.closeExplorer()
      await ctx.ctxMenu('.sb-item')
      await ctx.waitFor('.ctx-menu .ctx-item', 5000)
      await ctx.click('.ctx-menu .ctx-item.danger')
      await ctx.waitFor('.sconfirm .sccard', 5000)
    },
    assert: '.sconfirm .sccard',
    reset: confirmCancelReset
  },
  {
    id: 'sidebar-deleteall-confirm', label: '섹션 전체 삭제 확인 카드', area: '3. 사이드바', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.closeExplorer()
      await ctx.click('.sb-sec .slb.has-tip')
      await ctx.waitFor('.sconfirm .sccard', 5000)
    },
    assert: '.sconfirm .sccard',
    reset: confirmCancelReset
  },
  {
    id: 'new-chat-step1', label: '새 채팅 — 일반/멀티 선택', area: '3. 사이드바', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.blur(); await ctx.key('n', { ctrl: true }); await ctx.waitFor('.nc-veil .nctiles', 5000) },
    assert: '.nc-veil .nctiles',
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.nc-veil', 3000) }
  },
  {
    id: 'new-chat-step2', label: '새 채팅 — 패널 수(2~6)', area: '3. 사이드바', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.blur(); await ctx.key('n', { ctrl: true })
      await ctx.waitFor('.nc-veil .nctiles', 5000)
      await ctx.click('.nctile', 1)
      await ctx.waitFor('.nc-veil .nccnts .ncnt', 5000)
    },
    assert: '.nc-veil .nccnts .ncnt',
    reset: async (cdp, ctx) => { await ctx.esc(3); await ctx.waitGone('.nc-veil', 3000) }
  },
  {
    id: 'prompt-library-list', label: '프롬프트 라이브러리 — 목록', area: '3. 사이드바', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.closeExplorer()
      await ctx.clickText('.lcol button', '프롬프트')
      await ctx.waitFor('.pr-overlay .plib-modal .plib-list', 6000)
    },
    assert: '.pr-overlay .plib-modal .plib-list',
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.plib-modal', 3000) }
  },
  {
    id: 'prompt-library-editor', label: '프롬프트 편집(제목+본문)', area: '3. 사이드바', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.closeExplorer()
      await ctx.clickText('.lcol button', '프롬프트')
      await ctx.waitFor('.plib-modal .plib-add', 6000)
      await ctx.click('.plib-add')
      await ctx.waitFor('.plib-modal .plib-ed .tx', 5000)
    },
    assert: '.plib-modal .plib-ed .tx',
    reset: async (cdp, ctx) => { await ctx.esc(3); await ctx.waitGone('.plib-modal', 3000) }
  },
  {
    id: 'prompt-library-delete', label: '프롬프트 삭제 확인', area: '3. 사이드바', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.closeExplorer()
      await ctx.clickText('.lcol button', '프롬프트')
      await ctx.waitFor('.plib-modal .plib-row', 6000)
      await ctx.click('.plib-modal .plib-act.danger')
      await ctx.waitFor('.sconfirm.up .sccard', 5000)
    },
    assert: '.sconfirm.up .sccard',
    reset: async (cdp, ctx) => {
      if (!(await ctx.tryClickText('.sconfirm .sccard button', '취소'))) await ctx.esc(1)
      await ctx.waitGone('.sconfirm', 3000)
      await ctx.esc(2)
      await ctx.waitGone('.plib-modal', 3000)
    }
  },

  // ══ 4. 파일 탐색기 ════════════════════════════════════════════════════════════
  {
    id: 'explorer-tree', label: '탐색기 트리', area: '4. 탐색기', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.openExplorer(); await ctx.waitFor('.lcol .explorer .fxtree .fxr', 8000) },
    assert: '.lcol .explorer .fxtree .fxr'
  },
  { id: 'explorer-settings-foot', label: '탐색기 하단 프로필/설정 행', area: '4. 탐색기', surface: 'main-window', needsEngine: false, needsAccount: false, reach: async (cdp, ctx) => { await ctx.openExplorer() }, assert: '.explorer .sb-foot' },
  { id: 'explorer-git-strip', label: 'Git 상태 스트립', area: '4. 탐색기', surface: 'main-window', needsEngine: false, needsAccount: false, reach: async (cdp, ctx) => { await ctx.openExplorer(); await ctx.waitFor('.explorer .git-strip .br', 12000) }, assert: '.explorer .git-strip .br' },
  {
    id: 'explorer-search', label: '파일 검색 결과', area: '4. 탐색기', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.openExplorer(); await ctx.type('.fxs input', 'index.ts'); await ctx.waitFor('.explorer .fxtree .fxr .pth', 10000) },
    assert: '.explorer .fxtree .fxr .pth',
    reset: async (cdp, ctx) => { await ctx.clearSearch() }
  },
  {
    id: 'explorer-search-empty', label: '검색 결과 없음', area: '4. 탐색기', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.openExplorer(); await ctx.type('.fxs input', 'zzqqxx-no-such-file'); await ctx.waitFor('.explorer .fx-empty', 8000) },
    assert: '.explorer .fx-empty',
    reset: async (cdp, ctx) => { await ctx.clearSearch() }
  },
  {
    id: 'explorer-hidden-on', label: '숨긴 항목 보기 ON', area: '4. 탐색기', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.openExplorer(); await ctx.click('.fxh button', 1); await ctx.waitFor('.fxh button.on', 5000) },
    assert: '.fxh button.on',
    reset: async (cdp, ctx) => { if (await ctx.has('.fxh button.on')) { await ctx.click('.fxh button', 1); await sleep(400) } }
  },
  {
    id: 'explorer-ctx-menu', label: '탐색기 우클릭 메뉴', area: '4. 탐색기', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.openExplorer(); await ctx.ctxMenu('.explorer .fxr', 1); await ctx.waitFor('.ctx-menu .ctx-item', 5000) },
    assert: '.ctx-menu .ctx-item',
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.ctx-menu', 3000) }
  },
  {
    id: 'explorer-fileop', label: '파일 작업 카드(새 파일)', area: '4. 탐색기', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.revealInTree(['bench'], 'scratch')
      await ctx.ctxTreeRow('scratch')
      await ctx.waitFor('.ctx-menu .ctx-item', 5000)
      await ctx.clickText('.ctx-menu .ctx-item', '새 파일')
      await ctx.waitFor('.pr-overlay .fop-modal .pr-input', 5000)
    },
    assert: '.pr-overlay .fop-modal .pr-input',
    // 취소만 — 레포에 실제 파일을 만들지 않는다
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.pr-overlay', 3000) }
  },
  {
    id: 'explorer-notice', label: '파일 작업 오류 알림 카드', area: '4. 탐색기', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.revealInTree(['bench', 'scratch'], 'ccgbench-blank')
      await ctx.ctxTreeRow('scratch')
      await ctx.waitFor('.ctx-menu .ctx-item', 5000)
      await ctx.clickText('.ctx-menu .ctx-item', '새 파일')
      await ctx.waitFor('.pr-overlay .fop-modal .pr-input', 5000)
      // 이미 있는 이름 → 생성 실패 알림 (파일은 만들어지지 않는다)
      // Windows에서 만들 수 없는 이름 → 생성 실패(ENOENT). 대상 폴더는 벤치 스크래치뿐.
      await ctx.type('.fop-modal .pr-input', 'bad<>name?.txt')
      await sleep(300)
      await ctx.ev(`(() => { const b = [...document.querySelectorAll('.fop-modal button')].find((x) => /만들기|Create/.test(x.textContent || '')); if (!b || b.disabled) return false; b.click(); return true })()`)
      await ctx.waitFor('.pr-overlay .fop-modal .fop-err', 10000)
    },
    // [인벤토리 정정] 2.6.2 실측: 파일 작업 실패는 fop 카드 **안**의 인라인 줄(.fop-err)이다.
    // 인벤토리가 적은 .pr-ic.danger(Explorer의 NoticeModal)는 '새 파일 실패'로는 뜨지 않는다.
    assert: '.pr-overlay .fop-modal .fop-err',
    reset: async (cdp, ctx) => { await ctx.esc(3); await ctx.waitGone('.pr-overlay', 3000) }
  },
  {
    id: 'explorer-fileop-delete', label: '탐색기 삭제 확인 카드', area: '4. 탐색기', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      // 대상은 벤치 스크래치 파일로 고정 — 취소하더라도 레포 소스에 조준하지 않는다.
      // 검색 결과 행(button.fxr)에는 onContextMenu가 없으므로 반드시 트리 행이어야 한다.
      await ctx.revealInTree(['bench', 'scratch'], 'ccgbench-blank')
      await ctx.ctxTreeRow('ccgbench-blank')
      await ctx.waitFor('.ctx-menu .ctx-item', 5000)
      await ctx.clickText('.ctx-menu .ctx-item', '삭제')
      await ctx.waitFor('.sconfirm .sccard', 5000)
    },
    assert: '.sconfirm .sccard',
    reset: async (cdp, ctx) => { await confirmCancelReset(cdp, ctx); await ctx.clearSearch() }
  },
  {
    id: 'explorer-blank', label: '탐색기 — 폴더 없음', area: '4. 탐색기', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.closeExplorer()
      await ctx.selectChat('벤치 빈 채팅')
      await ctx.openExplorer()
      await ctx.waitFor('.explorer .exp-blank .exp-blank-btn', 8000)
    },
    assert: '.explorer .exp-blank .exp-blank-btn',
    reset: async (cdp, ctx) => { await ctx.closeExplorer(); await ctx.selectChat('벤치 긴 스레드') }
  },
  {
    id: 'changed-files-modal', label: '변경된 파일 카드(스코프 폴더)', area: '4. 탐색기', surface: 'main-window', needsEngine: false, needsAccount: false,
    // 픽스처 증강이 files/diffs를 심어 메뉴 항목이 살아난다 (원래는 실행 후에만 활성)
    reach: async (cdp, ctx) => {
      await ctx.revealInTree(['bench'], 'scratch')
      await ctx.ctxTreeRow('scratch')
      await ctx.waitFor('.ctx-menu .ctx-item', 5000)
      await ctx.clickText('.ctx-menu .ctx-item', '변경된 파일')
      await ctx.waitFor('.chgm-overlay .chgm-modal .chgm-list', 8000)
    },
    assert: '.chgm-overlay .chgm-modal .chgm-list',
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.chgm-overlay', 3000) }
  },
  { id: 'explorer-verse-section', label: 'Verse API digest 접이식 묶음', area: '4. 탐색기', surface: 'main-window', needsEngine: false, needsAccount: false, skip: 'Verse 프로젝트(.vproject/.uefnproject) 작업 폴더가 필요 — 이 레포에 없고, 벤치가 외부 UEFN 프로젝트를 여는 건 파일 경계 밖' },
  { id: 'explorer-verse-digest', label: 'Verse digest 뷰', area: '4. 탐색기', surface: 'main-window', needsEngine: false, needsAccount: false, skip: '위와 같음 — UEFN 프로젝트 필요' },

  // ══ 5. 코드 뷰어 ══════════════════════════════════════════════════════════════
  {
    id: 'viewer-code-read', label: '코드 뷰어 — 읽기 모드', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.openFile('ccgbench-sample.ts'); await ctx.waitFor('.fv-overlay .fv-modal .fv-body .cm-mount', 12000) },
    assert: '.fv-overlay .fv-modal .fv-body .cm-mount',
    reset: viewerReset
  },
  {
    id: 'viewer-diff-on', label: '변경 마킹(diff) 표시', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    // 픽스처 증강의 diffs[bench/scratch/ccgbench-sample.ts] — AI가 바꾼 파일과 같은 경로로 뜬다.
    // viewer.diffView 기본값이 false(전역 유지 설정)라 토글을 눌러야 마킹이 켜진다.
    // CM(코드) 뷰라 오버뷰 룰러(.diff-ruler)는 비-CM 경로 전용 — 판정은 토글의 .on으로 한다.
    reach: async (cdp, ctx) => {
      await ctx.openFile('ccgbench-sample.ts')
      await ctx.waitFor('.vtool button[aria-label="변경 보기"]', 10000)
      if (!(await ctx.has('.vtool button[aria-label="변경 보기"].on'))) await ctx.click('.vtool button[aria-label="변경 보기"]')
      await ctx.waitFor('.vtool button[aria-label="변경 보기"].on', 6000)
    },
    assert: '.vtool button[aria-label="변경 보기"].on',
    reset: viewerReset
  },
  {
    id: 'viewer-code-edit', label: '코드 뷰어 — 편집 모드(Ctrl+E)', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openFile('ccgbench-sample.ts')
      await ctx.click('.vtool button[aria-label="편집 모드"]')
      await ctx.waitFor('.vtool button[aria-label="편집 모드"].on', 6000)
    },
    assert: '.vtool button[aria-label="편집 모드"].on',
    reset: viewerReset
  },
  {
    id: 'viewer-cm-find', label: 'CM 편집기 찾기 바', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openFile('ccgbench-sample.ts')
      await ctx.realClick('.fv-body .cm-mount')
      await ctx.key('f', { ctrl: true })
      await ctx.waitFor('.fv-find.cm-find', 6000)
    },
    assert: '.fv-find.cm-find',
    reset: viewerReset
  },
  {
    id: 'viewer-code-dirty', label: '편집 중 미저장(● 저장 칩)', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openFile('ccgbench-sample.ts')
      await ctx.click('.vtool button[aria-label="편집 모드"]')
      await ctx.waitFor('.vtool button[aria-label="편집 모드"].on', 6000)
      await ctx.realClick('.fv-body .cm-content, .fv-body .cm-mount')
      await ctx.key('x'); await ctx.key('y')
      await ctx.waitFor('.diff-head .fv-lsp.install', 6000)
    },
    assert: '.diff-head .fv-lsp.install',
    reset: viewerReset
  },
  {
    id: 'viewer-close-confirm', label: '미저장 편집 닫기 확인', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openFile('ccgbench-sample.ts')
      await ctx.click('.vtool button[aria-label="편집 모드"]')
      await ctx.waitFor('.vtool button[aria-label="편집 모드"].on', 6000)
      await ctx.realClick('.fv-body .cm-content, .fv-body .cm-mount')
      await ctx.key('z'); await ctx.key('z')
      await ctx.waitFor('.diff-head .fv-lsp.install', 6000)
      await ctx.esc(1)
      await ctx.waitFor('.set-dialog-overlay .set-dialog .sd-title', 6000)
    },
    assert: '.set-dialog-overlay .set-dialog .sd-title',
    reset: async (cdp, ctx) => {
      if (!(await ctx.tryClickText('.set-dialog button', '저장 안 함'))) await ctx.esc(1)
      await ctx.waitGone('.set-dialog-overlay', 4000)
      await viewerReset(cdp, ctx)
    }
  },
  {
    id: 'viewer-code-saved', label: '저장됨 칩', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    // 저장 대상은 벤치 스크래치 파일뿐 — 레포 소스는 절대 쓰지 않는다
    reach: async (cdp, ctx) => {
      await ctx.openFile('ccgbench-sample.ts')
      await ctx.click('.vtool button[aria-label="편집 모드"]')
      await ctx.waitFor('.vtool button[aria-label="편집 모드"].on', 6000)
      await ctx.realClick('.fv-body .cm-content, .fv-body .cm-mount')
      await ctx.key('q')
      await ctx.waitFor('.diff-head .fv-lsp.install', 6000)
      await ctx.key('s', { ctrl: true })
      await ctx.waitFor('.diff-head .fv-lsp.ready', 6000)
    },
    assert: '.diff-head .fv-lsp.ready',
    reset: viewerReset
  },
  {
    id: 'viewer-save-error', label: '저장 실패 카드', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openFile('ccgbench-ro.txt')
      await ctx.click('.vtool button[aria-label="편집 모드"]')
      await ctx.waitFor('.vtool button[aria-label="편집 모드"].on', 6000)
      await ctx.realClick('.fv-body .cm-content, .fv-body .cm-mount')
      await ctx.key('x')
      await ctx.key('s', { ctrl: true })
      await ctx.waitFor('.set-dialog-overlay .set-dialog .sd-title', 8000)
    },
    assert: '.set-dialog-overlay .set-dialog .sd-title',
    reset: async (cdp, ctx) => { await ctx.esc(1); await ctx.waitGone('.set-dialog-overlay', 4000); await viewerReset(cdp, ctx) }
  },
  {
    id: 'viewer-markdown-preview', label: '마크다운 렌더 뷰', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.openFile('ccgbench-doc.md'); await ctx.waitFor('.fv-body .fv-md .content', 10000) },
    assert: '.fv-body .fv-md .content',
    reset: viewerReset
  },
  {
    id: 'viewer-markdown-source', label: '마크다운 — 변경 소스 보기', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    // mdCanToggle = isMdFile && !!diff — 픽스처 증강의 doc diff가 토글을 살린다
    reach: async (cdp, ctx) => {
      await ctx.openFile('ccgbench-doc.md')
      await ctx.waitFor('.vtool button[aria-label="변경 소스"]', 8000)
      await ctx.click('.vtool button[aria-label="변경 소스"]')
      await ctx.waitFor('.vtool button[aria-label="변경 소스"].on', 6000)
    },
    assert: '.vtool button[aria-label="변경 소스"].on',
    reset: viewerReset
  },
  {
    id: 'viewer-find', label: '뷰어 찾기 바(비-CM)', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openFile('ccgbench-doc.md')
      await ctx.realClick('.fv-body')
      await ctx.key('f', { ctrl: true })
      await ctx.waitFor('.fv-find', 6000)
    },
    assert: '.fv-find',
    reset: viewerReset
  },
  {
    id: 'viewer-image', label: '이미지 뷰(뷰어 안)', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.openFile('ccgbench-shot.png'); await ctx.waitFor('.fv-body .fv-imgview .fv-imgel', 10000) },
    assert: '.fv-body .fv-imgview .fv-imgel',
    reset: viewerReset
  },
  {
    id: 'viewer-html-preview', label: 'HTML 페이지 미리보기(ccg-page)', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.openFile('ccgbench-page.html'); await ctx.waitFor('.fv-body iframe.fv-htmlframe', 12000); await sleep(900) },
    assert: '.fv-body iframe.fv-htmlframe',
    reset: viewerReset
  },
  {
    id: 'viewer-html-code', label: 'HTML 코드 보기(Ctrl+D)', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openFile('ccgbench-page.html')
      await ctx.waitFor('.vtool button[aria-label="코드 보기"]', 10000)
      await ctx.click('.vtool button[aria-label="코드 보기"]')
      await ctx.waitFor('.vtool button[aria-label="코드 보기"].on', 6000)
    },
    assert: '.vtool button[aria-label="코드 보기"].on',
    reset: viewerReset
  },
  {
    id: 'viewer-svg-preview', label: 'SVG 렌더 미리보기', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.openFile('ccgbench-icon.svg'); await ctx.waitFor('.fv-body .fv-imgview', 10000) },
    assert: '.fv-body .fv-imgview',
    reset: viewerReset
  },
  {
    id: 'viewer-svg-source', label: 'SVG 마크업 소스', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openFile('ccgbench-icon.svg')
      await ctx.waitFor('.vtool button[aria-label="SVG 소스"]', 10000)
      await ctx.click('.vtool button[aria-label="SVG 소스"]')
      await ctx.waitFor('.vtool button[aria-label="SVG 소스"].on', 6000)
    },
    assert: '.vtool button[aria-label="SVG 소스"].on',
    reset: viewerReset
  },
  {
    id: 'viewer-empty', label: '뷰어 — 내용 없음/오류', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.openFile('ccgbench-binary.dat'); await ctx.waitFor('.fv-body .fv-empty', 12000) },
    assert: '.fv-body .fv-empty',
    reset: viewerReset
  },
  {
    id: 'viewer-truncated', label: '일부만 표시 칩', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.openFile('ccgbench-huge.ts'); await ctx.waitFor('.diff-head .fv-trunc', 20000) },
    assert: '.diff-head .fv-trunc',
    reset: viewerReset
  },
  {
    id: 'viewer-loading', label: '뷰어 로딩 스피너', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    // [한 프레임 화면] res==null인 동안만 뜬다. window.api는 contextBridge가 얼려 둔
    // 객체라(실측: Object.isFrozen(window.api)===true, window.api 자체도
    // configurable:false) readFile을 지연 래핑할 수 없고, 메인 쪽 readFile은 1.5MB에서
    // 잘라 읽으므로 파일을 키워도 응답이 느려지지 않는다. 그래서 CPU 스로틀로 렌더를
    // 늘리고, **판정과 촬영을 같은 순간에** 한다(selfShot + ctx.snapWhen).
    selfShot: true,
    reach: async (cdp, ctx) => {
      await ctx.openExplorer()
      await ctx.type('.fxs input', 'ccgbench-huge')
      await ctx.waitFor('.explorer .fxtree .fxr', 8000)
      await sleep(400)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 50 }).catch(() => {})
      await ctx.ev(`(() => { const r = [...document.querySelectorAll('.explorer .fxtree .fxr')].find((x) => (x.textContent||'').includes('ccgbench-huge')); if (!r) return false; r.click(); return true })()`)
      await ctx.snapWhen('viewer-loading', '.fv-body .fv-loading .spin', { ms: 25000, interval: 10 })
    },
    assert: '.fv-body .fv-loading .spin',
    reset: async (cdp, ctx) => {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {})
      await sleep(1500)
      await viewerReset(cdp, ctx)
    }
  },
  {
    id: 'viewer-selection-ask-bar', label: '코드 선택 툴바(복사/질문)', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openFile('ccgbench-doc.md')
      await ctx.ev(selectJs('.fv-body .fv-md .content'))
      await ctx.waitFor('.sel-bar .sel-act', 8000)
    },
    assert: '.sel-bar .sel-act',
    reset: async (cdp, ctx) => { await ctx.ev(CLEAR_SEL_JS); await viewerReset(cdp, ctx) }
  },
  {
    id: 'viewer-ask-panel', label: '선택 코드 질문 패널', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openFile('ccgbench-doc.md')
      await ctx.ev(selectJs('.fv-body .fv-md .content'))
      await ctx.waitFor('.sel-bar .sel-act', 8000)
      await ctx.clickText('.sel-bar .sel-act', '질문')
      await ctx.waitFor('.fv-modal .fv-ask .fv-ask-row textarea', 6000)
    },
    assert: '.fv-modal .fv-ask .fv-ask-row textarea',
    reset: async (cdp, ctx) => { await ctx.ev(CLEAR_SEL_JS); await ctx.esc(1); await viewerReset(cdp, ctx) }
  },
  {
    id: 'viewer-header-ctx-menu', label: '뷰어 헤더 우클릭 메뉴', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openFile('ccgbench-sample.ts')
      await ctx.ctxMenu('.fv-modal .diff-head')
      await ctx.waitFor('.ctx-menu .ctx-item', 5000)
    },
    assert: '.ctx-menu .ctx-item',
    reset: async (cdp, ctx) => { await ctx.esc(1); await ctx.waitGone('.ctx-menu', 3000); await viewerReset(cdp, ctx) }
  },
  {
    id: 'viewer-maximized', label: '뷰어 최대화', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openFile('ccgbench-sample.ts')
      // 창 폭에 따라 처음부터 최대화로 열리기도 한다(useResizableModal이 크기를 기억) —
      // 그럴 땐 그대로 두고, 아니면 최대화 버튼을 눌러 같은 상태로 맞춘다
      if (!(await ctx.has('.fv-modal button[aria-label="이전 크기로"]'))) {
        const ok = await ctx.ev(`(() => {
          const b = [...document.querySelectorAll('.fv-modal button')].find((x) => /^(최대화|Maximize)$/.test(x.getAttribute('aria-label') || ''))
          if (!b) return false
          b.click(); return true
        })()`)
        if (!ok) throw new Error('viewer-maximized: 최대화/이전 크기로 버튼이 둘 다 없음')
      }
      await ctx.waitFor('.fv-modal button[aria-label="이전 크기로"]', 6000)
    },
    assert: '.fv-modal button[aria-label="이전 크기로"]',
    reset: async (cdp, ctx) => {
      await ctx.ev(`(() => { const b = [...document.querySelectorAll('.fv-modal button')].find((x) => /^(이전 크기로|Restore)$/.test(x.getAttribute('aria-label') || '')); if (b) b.click(); return true })()`)
      await sleep(400)
      await viewerReset(cdp, ctx)
    }
  },
  {
    id: 'viewer-git-snapshot', label: 'Git 커밋 스냅샷 뷰어', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openExplorer()
      await ctx.click('.explorer .git-strip')
      await ctx.waitFor('.gitm-overlay .gitm-modal', 12000)
      await ctx.clickText('.gitm-nav .gitm-item, .gitm-nav button', '히스토리')
      await ctx.waitFor('.gitm-modal .gitm-list .c-line', 15000)
      await ctx.click('.gitm-modal .gitm-list .c-line', 0)
      await ctx.waitFor('.gitm-detail .gd-msg', 12000)
      await ctx.waitFor('.gitm-detail .gitm-file', 10000)
      await ctx.click('.gitm-detail .gitm-file', 0)
      await ctx.waitFor('.fv-modal .fv-glabel', 12000)
    },
    assert: '.fv-modal .fv-glabel',
    reset: async (cdp, ctx) => { await viewerReset(cdp, ctx); await ctx.esc(2); await ctx.waitGone('.gitm-overlay', 4000) }
  },
  { id: 'viewer-hover-card', label: 'LSP 호버 타입 카드', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false, skip: 'typescript-language-server의 준비·인덱싱 시점이 비결정적(.fv-lsp.starting 소멸 시각이 레포 크기·디스크 캐시에 따라 수십 초 편차) — 캡처 타이밍을 고정할 수 없다' },
  { id: 'viewer-back-forward', label: '뷰어 파일 히스토리(뒤로/앞으로)', area: '5. 뷰어', surface: 'main-window', needsEngine: false, needsAccount: false, skip: '심볼 정의 점프(Ctrl+클릭)가 LSP 준비를 전제 — viewer-hover-card와 같은 사유' },

  // ══ 6. Git 카드 ═══════════════════════════════════════════════════════════════
  {
    id: 'git-changes', label: 'Git — 변경 목록 + 커밋 컴포저', area: '6. Git', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ctx.openExplorer(); await ctx.click('.explorer .git-strip'); await ctx.waitFor('.gitm-overlay .gitm-modal .gitm-list', 15000) },
    assert: '.gitm-overlay .gitm-modal .gitm-list',
    reset: gitReset
  },
  {
    id: 'git-history', label: 'Git — 히스토리(커밋 리스트)', area: '6. Git', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openExplorer(); await ctx.click('.explorer .git-strip')
      await ctx.waitFor('.gitm-overlay .gitm-modal', 15000)
      await ctx.clickText('.gitm-nav .gitm-item, .gitm-nav button', '히스토리')
      await ctx.waitFor('.gitm-modal .gitm-list .c-line', 15000)
    },
    assert: '.gitm-modal .gitm-list .c-line',
    reset: gitReset
  },
  {
    id: 'git-commit-detail', label: 'Git — 커밋 상세(우측 패널)', area: '6. Git', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openExplorer(); await ctx.click('.explorer .git-strip')
      await ctx.waitFor('.gitm-overlay .gitm-modal', 15000)
      await ctx.clickText('.gitm-nav .gitm-item, .gitm-nav button', '히스토리')
      await ctx.waitFor('.gitm-modal .gitm-list .c-line', 15000)
      await ctx.click('.gitm-modal .gitm-list .c-line', 0)
      await ctx.waitFor('.gitm-detail .gd-msg', 12000)
    },
    assert: '.gitm-detail .gd-msg',
    reset: gitReset
  },
  {
    id: 'git-new-branch', label: 'Git — 새 브랜치 입력', area: '6. Git', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openExplorer(); await ctx.click('.explorer .git-strip')
      await ctx.waitFor('.gitm-overlay .gitm-modal', 15000)
      await ctx.clickText('.gitm-nav .gitm-item, .gitm-nav button', '새 브랜치')
      await ctx.waitFor('.gitm-item .gitm-newbr', 6000)
    },
    assert: '.gitm-item .gitm-newbr',
    // 입력만 열고 만들지 않는다 (Enter 금지)
    reset: gitReset
  },
  {
    id: 'git-ai-commit-step1', label: 'AI 커밋 메시지 — 1/2 계정', area: '6. Git', surface: 'main-window', needsEngine: false, needsAccount: true,
    reach: async (cdp, ctx) => {
      await ctx.openExplorer(); await ctx.click('.explorer .git-strip')
      await ctx.waitFor('.gitm-overlay .gitm-modal .gitm-list', 15000)
      await ctx.ev(`(() => { const c = document.querySelector('.gitm-list input[type=checkbox], .gitm-list .gitm-check'); if (!c) return false; c.click(); return true })()`)
      await sleep(400)
      const ok = await ctx.ev(`(() => {
        const b = [...document.querySelectorAll('.gitm-modal button')].find((x) => /AI/.test(x.textContent || '') || /AI/.test(x.getAttribute('aria-label') || ''))
        if (!b) return false
        b.click(); return true
      })()`)
      if (!ok) throw new Error('git-ai-commit: AI 버튼 없음')
      await ctx.waitFor('.set-dialog-overlay .qcard .qstep-b .qopts', 8000)
    },
    assert: '.set-dialog-overlay .qcard .qstep-b .qopts',
    reset: async (cdp, ctx) => { await ctx.esc(1); await ctx.waitGone('.set-dialog-overlay', 4000); await gitReset(cdp, ctx) }
  },
  {
    id: 'git-ai-commit-step2', label: 'AI 커밋 메시지 — 2/2 모델·effort', area: '6. Git', surface: 'main-window', needsEngine: false, needsAccount: true,
    reach: async (cdp, ctx) => {
      await ctx.openExplorer(); await ctx.click('.explorer .git-strip')
      await ctx.waitFor('.gitm-overlay .gitm-modal .gitm-list', 15000)
      await ctx.ev(`(() => { const c = document.querySelector('.gitm-list input[type=checkbox], .gitm-list .gitm-check'); if (!c) return false; c.click(); return true })()`)
      await sleep(400)
      await ctx.ev(`(() => { const b = [...document.querySelectorAll('.gitm-modal button')].find((x) => /AI/.test(x.textContent || '')); if (!b) return false; b.click(); return true })()`)
      await ctx.waitFor('.set-dialog-overlay .qcard .qopts', 8000)
      await ctx.click('.set-dialog-overlay .qcard .qopts button, .set-dialog-overlay .qcard .qopt', 0)
      await ctx.waitFor('.set-dialog-overlay .qcard .gai-seg', 8000)
    },
    assert: '.set-dialog-overlay .qcard .gai-seg',
    // 실행 직전에서 멈춘다 — 확인을 누르면 실제 AI 커밋 메시지 생성 턴이 돈다
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.set-dialog-overlay', 4000); await gitReset(cdp, ctx) }
  },
  { id: 'git-repo-list', label: 'Git — 저장소 선택(2곳 이상)', area: '6. Git', surface: 'main-window', needsEngine: false, needsAccount: false, skip: '하위 저장소가 2곳 이상인 작업 폴더가 필요 — 이 레포에는 중첩 .git이 없다(실측)' },
  { id: 'git-discard-confirm', label: '변경 되돌리기 확인', area: '6. Git', surface: 'main-window', needsEngine: false, needsAccount: false, skip: '되돌리기 카드에 도달하려면 실제 워킹트리 변경을 조준해야 하는데, 지금 트리는 다른 에이전트가 동시 편집 중 — 오조작 한 번이 남의 작업을 파괴한다' },
  { id: 'git-switch-confirm', label: '더티 브랜치 전환 확인', area: '6. Git', surface: 'main-window', needsEngine: false, needsAccount: false, skip: '더티 트리에서 브랜치 전환을 유도해야 함 — 위와 같은 파괴 위험' },
  { id: 'git-error', label: 'Git 오류 칩', area: '6. Git', surface: 'main-window', needsEngine: false, needsAccount: false, skip: 'Pull/Push 등 원격 조작을 실제로 일으켜야 재현 — 벤치에서 원격 조작 금지' },

  // ══ 7. 설정 모달 ══════════════════════════════════════════════════════════════
  { id: 'settings-profile', label: '설정 — Profile', area: '7. 설정', surface: 'main-window', needsEngine: false, needsAccount: false, reach: async (cdp, ctx) => { await ctx.openSettings(0); await ctx.waitFor('.set-modal .set-inner .sc2.hero2', 6000) }, assert: '.set-modal .set-inner .sc2.hero2', reset: settingsReset },
  { id: 'settings-account', label: '설정 — Account', area: '7. 설정', surface: 'main-window', needsEngine: false, needsAccount: true, reach: async (cdp, ctx) => { await ctx.openSettings(1); await ctx.waitFor('.set-inner .sc2.acct', 8000) }, assert: '.set-inner .sc2.acct', reset: settingsReset },
  {
    id: 'settings-account-logout-confirm', label: 'Account — 로그아웃 확인 카드', area: '7. 설정', surface: 'main-window',
    needsEngine: false, needsAccount: true,
    // [인벤토리 정정] 2.6.2 실측(Settings.tsx doDelete): 계정 카드의 '삭제'는 확인 카드를 거치지
    // 않고 곧바로 window.api.auth.logout(email) — 사용자 실계정 토큰이 서버에서 해지된다.
    // 자동화로 밟을 수 있는 확인 카드가 존재하지 않으므로 도달 자체가 불가능하고, 눌러 보는 것도 금지.
    skip: '실측 결과 확인 카드가 없다 — 계정 카드의 삭제 버튼이 곧바로 실계정 토큰을 해지한다(Settings.tsx doDelete). 인벤토리 행 정정 필요'
  },
  { id: 'settings-engine', label: '설정 — Engine', area: '7. 설정', surface: 'main-window', needsEngine: false, needsAccount: false, reach: async (cdp, ctx) => { await ctx.openSettings(2); await ctx.waitFor('.set-inner .sc2.row2.eng', 8000) }, assert: '.set-inner .sc2.row2.eng', reset: settingsReset },
  {
    id: 'settings-engine-confirm', label: 'Engine — 이전 버전 정리 확인', area: '7. 설정', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openSettings(2)
      await ctx.waitFor('.set-inner .sc2.row2.eng', 8000)
      await ctx.clickText('.set-inner button', '정리')
      await ctx.waitFor('.set-dialog-overlay .set-dialog .sd-btns', 6000)
    },
    assert: '.set-dialog-overlay .set-dialog .sd-btns',
    // 취소만 — 확인하면 실홈과 정션으로 공유하는 엔진 설치본이 지워진다
    reset: async (cdp, ctx) => { await ctx.esc(1); await ctx.waitGone('.set-dialog-overlay', 4000); await settingsReset(cdp, ctx) }
  },
  { id: 'settings-api', label: '설정 — API', area: '7. 설정', surface: 'main-window', needsEngine: false, needsAccount: false, reach: async (cdp, ctx) => { await ctx.openSettings(3); await ctx.waitFor('.set-inner .sc2.api', 8000) }, assert: '.set-inner .sc2.api', reset: settingsReset },
  { id: 'settings-mcp', label: '설정 — MCP', area: '7. 설정', surface: 'main-window', needsEngine: false, needsAccount: false, reach: async (cdp, ctx) => { await ctx.openSettings(4); await ctx.waitFor('.set-inner .set-tabs .set-tab', 8000) }, assert: '.set-inner .set-tabs .set-tab', reset: settingsReset },
  { id: 'settings-skill', label: '설정 — Skill', area: '7. 설정', surface: 'main-window', needsEngine: false, needsAccount: false, reach: async (cdp, ctx) => { await ctx.openSettings(5); await ctx.waitFor('.set-inner .set-tabs .set-tab', 8000) }, assert: '.set-inner .set-tabs .set-tab', reset: settingsReset },
  { id: 'settings-display', label: '설정 — Display', area: '7. 설정', surface: 'main-window', needsEngine: false, needsAccount: false, reach: async (cdp, ctx) => { await ctx.openSettings(6); await ctx.waitFor('.set-inner .set-sec', 8000) }, assert: '.set-inner .set-sec', reset: settingsReset },
  { id: 'settings-language', label: '설정 — Language', area: '7. 설정', surface: 'main-window', needsEngine: false, needsAccount: false, reach: async (cdp, ctx) => { await ctx.openSettings(7); await ctx.waitFor('.set-inner .sc2.row2.pick.on', 8000) }, assert: '.set-inner .sc2.row2.pick.on', reset: settingsReset },
  { id: 'settings-code-lsp', label: '설정 — Code(언어 서버)', area: '7. 설정', surface: 'main-window', needsEngine: false, needsAccount: false, reach: async (cdp, ctx) => { await ctx.openSettings(8); await ctx.waitFor('.set-inner .sc2.row2', 8000) }, assert: '.set-inner .sc2.row2', reset: settingsReset },
  {
    id: 'settings-code-expanded', label: 'Code — 행 펼침', area: '7. 설정', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openSettings(8)
      const before = await ctx.waitFor('.set-inner .sc2.row2', 8000)
      await ctx.click('.set-inner .sc2.row2', 0)
      await sleep(500)
      const after = await ctx.count('.set-inner .sc2.row2')
      if (after <= before) { await ctx.click('.set-inner .sc2.row2', 4); await sleep(500) }
      await ctx.waitFor('.set-inner .sc2.row2', 6000, before + 1)
    },
    assert: '.set-inner .sc2.row2',
    reset: settingsReset
  },
  { id: 'settings-explorer', label: '설정 — Explorer', area: '7. 설정', surface: 'main-window', needsEngine: false, needsAccount: false, reach: async (cdp, ctx) => { await ctx.openSettings(9); await ctx.waitFor('.set-inner .sc2.tgl', 8000) }, assert: '.set-inner .sc2.tgl', reset: settingsReset },
  { id: 'settings-gestures', label: '설정 — Gestures', area: '7. 설정', surface: 'main-window', needsEngine: false, needsAccount: false, reach: async (cdp, ctx) => { await ctx.openSettings(10); await ctx.waitFor('.set-inner .set-sec', 8000) }, assert: '.set-inner .set-sec', reset: settingsReset },
  {
    id: 'settings-rail-search', label: '설정 — 레일 검색 필터', area: '7. 설정', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.openSettings(0)
      await ctx.type('.set-search input', '제스처')
      await sleep(400)
      const n = await ctx.count('.set-nav .set-ni')
      if (n > 3) throw new Error(`rail-search: 레일이 줄지 않음 (${n})`)
      await ctx.waitFor('.set-nav .set-ni', 4000)
    },
    assert: '.set-nav .set-ni',
    reset: async (cdp, ctx) => { await ctx.ev(`__type('.set-search input','')`).catch(() => false); await sleep(300); await settingsReset(cdp, ctx) }
  },
  { id: 'settings-account-login', label: 'Account — 로그인 진행', area: '7. 설정', surface: 'main-window', needsEngine: false, needsAccount: false, skip: '계정 추가를 누르면 실제 OAuth 플로우가 시작돼 외부 브라우저가 열리고 사용자 실계정 스토어를 건드린다 — 벤치 금지' },
  { id: 'settings-engine-install-card', label: 'Engine — 설치/정리 로그 카드', area: '7. 설정', surface: 'main-window', needsEngine: false, needsAccount: false, skip: '다른 엔진 버전을 실제로 내려받아 설치해야 재현(네트워크·디스크) — 게다가 engines는 실홈과 정션 공유라 실사용 설치본을 오염시킨다' },
  { id: 'settings-code-install-card', label: 'Code — 분석 서버 설치 로그 카드', area: '7. 설정', surface: 'main-window', needsEngine: false, needsAccount: false, skip: 'LSP 서버 실제 설치(네트워크·수백 MB) 유발 — 벤치 금지' },
  { id: 'settings-code-delete-confirm', label: 'Code — 분석 서버 삭제 확인', area: '7. 설정', surface: 'main-window', needsEngine: false, needsAccount: false, skip: '삭제 확인 카드는 사용자가 실제로 설치해 둔 LSP 서버를 조준한다 — 오조작 시 실사용 환경 파괴' },

  // ══ 8. 멀티 채팅 ══════════════════════════════════════════════════════════════
  // 여기부터 workspace.mode가 multi로 바뀐다 — 묶음 끝에서 single로 되돌린다.
  {
    id: 'multi-grid-empty', label: '멀티 — 빈 패널 그리드(4분할)', area: '8. 멀티', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ctx.blur(); await ctx.key('n', { ctrl: true })
      await ctx.waitFor('.nc-veil .nctiles', 5000)
      await ctx.click('.nctile', 1)
      await ctx.waitFor('.nc-veil .nccnts .ncnt', 5000)
      await ctx.click('.ncnt', 2)
      await ctx.waitFor('.multi .ma-grid.n4 .ma-panel', 12000)
      await sleep(800)
    },
    assert: '.multi .ma-grid.n4 .ma-panel'
  },
  {
    id: 'multi-grid-counts', label: '멀티 — 패널 수 배치(n6)', area: '8. 멀티', surface: 'main-window', needsEngine: false, needsAccount: false,
    // ★ 3.0 M-UX — 다이얼에 1이 들어와 **버튼 인덱스가 한 칸 밀렸다**(2.6.2: 0=2‥4=6 /
    // 3.0: 0=1‥5=6). 인덱스로 집으면 두 앱이 다른 배치를 찍는다 = 비교가 아니라 우연.
    // 라벨 텍스트로 집으면 앱을 분기하지 않고도 같은 화면에 도달한다(reach 무분기 규약).
    reach: async (cdp, ctx) => {
      await ensureMulti(ctx)
      await ctx.clickText('.ma-count-btn', '6')
      await ctx.waitFor('.ma-grid.n6', 8000)
      await sleep(600)
    },
    assert: '.ma-grid.n6',
    reset: async (cdp, ctx) => { await ctx.clickText('.ma-count-btn', '4').catch(() => {}); await sleep(600) }
  },
  {
    id: 'multi-panel-expanded', label: '멀티 — 크게 보기 오버레이 카드', area: '8. 멀티', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ensureMulti(ctx)
      await ctx.ev(`(() => { const b = [...document.querySelectorAll('.ma-panel button')].find((x) => /크게 보기|Expand/.test(x.getAttribute('aria-label') || '')); if (!b) return false; b.click(); return true })()`)
      await ctx.waitFor('.ma-expand-overlay .ma-expand-card .ma-panel', 8000)
    },
    assert: '.ma-expand-overlay .ma-expand-card .ma-panel',
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.ma-expand-overlay', 4000) }
  },
  {
    id: 'multi-panel-ghost-expanded', label: '멀티 — 크게 보는 중 그리드 자리지킴', area: '8. 멀티', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ensureMulti(ctx)
      await ctx.ev(`(() => { const b = [...document.querySelectorAll('.ma-panel button')].find((x) => /크게 보기|Expand/.test(x.getAttribute('aria-label') || '')); if (!b) return false; b.click(); return true })()`)
      await ctx.waitFor('.ma-grid .ma-panel.ma-ghost', 8000)
    },
    assert: '.ma-grid .ma-panel.ma-ghost',
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.ma-expand-overlay', 4000) }
  },
  {
    id: 'multi-panel-rename', label: '멀티 — 패널 제목 인라인 편집(F2)', area: '8. 멀티', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ensureMulti(ctx); await ctx.click('.ma-panel .ma-p-tedit'); await ctx.waitFor('.ma-panel .ma-p-tin', 6000) },
    assert: '.ma-panel .ma-p-tin',
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.ma-p-tin', 3000) }
  },
  {
    id: 'multi-panel-folder-pop', label: '멀티 — 패널 폴더 팝오버', area: '8. 멀티', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => { await ensureMulti(ctx); await ctx.click('.ma-panel .ma-p-folder'); await ctx.waitFor('.ma-panel .wb-pop.hpop.r', 6000) },
    assert: '.ma-panel .wb-pop.hpop.r',
    reset: async (cdp, ctx) => { await ctx.esc(2); await ctx.waitGone('.wb-pop', 3000) }
  },
  {
    id: 'multi-explorer', label: '멀티 — 포커스 패널을 따라가는 탐색기', area: '8. 멀티', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ensureMulti(ctx)
      await ctx.realClick('.ma-panel', 0)
      // 빈 패널은 cwd가 없어 multiExp가 null → 탐색기가 아예 안 그려진다. 폴더부터 준다.
      await ctx.click('.ma-panel .ma-p-folder')
      await ctx.waitFor('.ma-panel .wb-pop.hpop.r .wb-prow', 8000)
      // 반드시 '최근 폴더' 행만 고른다. 인덱스로 집으면 최근이 비었을 때 마지막 행
      // ('폴더 찾아보기…')을 눌러 **네이티브 폴더 대화상자**가 뜨고, 그 순간 이 실행 전체가
      // 사람 손을 기다리며 멈춘다 — 하네스가 절대 밟으면 안 되는 함정.
      const picked = await ctx.ev(`(() => {
        const rows = [...document.querySelectorAll('.ma-panel .wb-pop.hpop.r .wb-prow')]
        const hit = rows.find((r) => (r.textContent || '').includes('AgentCodeGUI') && !/찾아보기|Browse|참조 폴더 추가|Add reference/.test(r.textContent || ''))
        if (!hit) return false
        hit.click(); return true
      })()`)
      if (!picked) throw new Error('multi-explorer: 최근 폴더 행(AgentCodeGUI)이 팝오버에 없음')
      await sleep(1500)
      await ctx.esc(1)
      await ctx.waitGone('.wb-pop', 3000)
      // 멀티 헤더의 '파일 탐색기' **토글** — 앞 화면이 탐색기를 열어 둔 채로 왔으면
      // 한 번 누르는 게 곧 '닫기'가 된다(실측 실패 원인). 열릴 때까지 눌러 본다.
      for (let i = 0; i < 3; i++) {
        if (await ctx.has('.lcol .explorer .fxtree')) break
        const ok = await ctx.ev(`(() => { const b = [...document.querySelectorAll('.multi button')].find((x) => /파일 탐색기|File explorer/.test(x.getAttribute('aria-label') || '')); if (!b) return false; b.click(); return true })()`)
        if (!ok) throw new Error('multi-explorer: 헤더 탐색기 토글 없음')
        await sleep(1500)
      }
      await ctx.waitFor('.lcol .explorer .fxtree', 20000)
    },
    assert: '.lcol .explorer .fxtree',
    reset: async (cdp, ctx) => {
      for (let i = 0; i < 2; i++) {
        if (!(await ctx.has('.lcol .explorer'))) break
        await ctx.ev(`(() => { const b = [...document.querySelectorAll('.multi button')].find((x) => /파일 탐색기|File explorer/.test(x.getAttribute('aria-label') || '')); if (b) b.click(); return true })()`).catch(() => {})
        await sleep(700)
      }
    }
  },
  {
    id: 'multi-reorder', label: '멀티 — 패널 자리 드래그 재배치', area: '8. 멀티', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ensureMulti(ctx)
      const p = await ctx.ev(`(() => { const h = document.querySelectorAll('.ma-panel .ma-p-head, .ma-panel .ma-p-tw')[0]; if (!h) return null
        const b = h.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } })()`)
      if (!p) throw new Error('multi-reorder: 패널 헤더 없음')
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
      await sleep(800)
      for (let i = 1; i <= 8; i++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + i * 24, y: p.y + i * 10, button: 'left', buttons: 1 })
        await sleep(40)
      }
      await ctx.waitFor('.ma-grid.reordering', 6000)
      ctx._reorderPt = p
    },
    assert: '.ma-grid.reordering',
    reset: async (cdp, ctx) => {
      const p = ctx._reorderPt ?? { x: 400, y: 300 }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 })
      await sleep(600)
      await ctx.waitGone('.ma-grid.reordering', 4000)
    }
  },
  {
    id: 'multi-panel-ghost-popped', label: '멀티 — 팝아웃 중 그리드 유령', area: '8. 멀티', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ensureMulti(ctx)
      await ctx.ev(`(() => { const b = [...document.querySelectorAll('.ma-panel button')].find((x) => /별도 창으로|own window/.test(x.getAttribute('aria-label') || '')); if (!b) return false; b.click(); return true })()`)
      await ctx.waitFor('.ma-grid .ma-panel.ma-ghost.pop', 12000)
    },
    assert: '.ma-grid .ma-panel.ma-ghost.pop'
    // reset 없음 — 바로 다음 화면(panel-window)이 이 팝아웃 창을 캡처한다
  },
  {
    id: 'panel-window', label: '멀티 패널 팝아웃 창', area: '9. 독립 창', surface: 'panel-window', needsEngine: false, needsAccount: false,
    win: '#mapanel',
    reach: async (cdp, ctx) => {
      await ensureMulti(ctx)
      if (!(await ctx.has('.ma-grid .ma-panel.ma-ghost.pop'))) {
        await ctx.ev(`(() => { const b = [...document.querySelectorAll('.ma-panel button')].find((x) => /별도 창으로|own window/.test(x.getAttribute('aria-label') || '')); if (!b) return false; b.click(); return true })()`)
      }
      await ctx.waitForWindow('#mapanel', 15000)
      await sleep(1200)
    },
    assert: '.sw.pwin .pw-body .ma-panel',
    reset: async (cdp, ctx) => { await ctx.closeSubWindows('#mapanel'); await sleep(1000) }
  },
  {
    id: 'multi-panel-btw-dock', label: '멀티 — 패널 btw 알약 도크', area: '8. 멀티', surface: 'main-window', needsEngine: false, needsAccount: false,
    reach: async (cdp, ctx) => {
      await ensureMulti(ctx)
      const t = await openBtw(ctx, '.ma-panel .composer textarea')
      await minimizeWindow(ctx, t)
      await ctx.waitFor('.ma-panel .btw-dock .btw-mini', 12000)
    },
    assert: '.ma-panel .btw-dock .btw-mini',
    reset: async (cdp, ctx) => { await ctx.closeSubWindows('#btw', '#session'); await sleep(800) }
  },
  { id: 'multi-hydrate', label: '멀티 — 세션 복원 스피너', area: '8. 멀티', surface: 'main-window', needsEngine: false, needsAccount: false, boot: 'multi', assert: '.multi .ma-hydrate .ma-hydrate-spin', note: 'workspace.mode=multi로 기동한 직후 프레임 — ab.mjs boot 페이즈(CPU 스로틀)' },
  { id: 'multi-panel-peek', label: '멀티 — 첫 지시 호버 peek', area: '8. 멀티', surface: 'main-window', needsEngine: false, needsAccount: false, skip: 'peek은 그 패널의 첫 지시(대화)가 있어야 그린다 — 빈 그리드에선 미표시이고, 채우려면 패널마다 엔진 턴이 필요(5턴 예산 밖)' },
  { id: 'multi-panel-running', label: '멀티 — 패널 실행 중', area: '8. 멀티', surface: 'main-window', needsEngine: true, needsAccount: true, skip: '패널 실행 턴 필요 — 엔진 예산은 본채팅 대표 3화면에 배정' },
  { id: 'multi-panel-done-ring', label: '멀티 — 진짜 완료 링', area: '8. 멀티', surface: 'main-window', needsEngine: true, needsAccount: true, skip: '위와 같음 — 턴 종료+bg 정리까지 필요' },
  { id: 'multi-panel-question', label: '멀티 — 패널 스코프 질문 카드', area: '8. 멀티', surface: 'main-window', needsEngine: true, needsAccount: true, skip: 'AskUserQuestion 재현 비결정적 + 패널 실행 턴 필요' },
  { id: 'multi-panel-permission', label: '멀티 — 패널 스코프 승인 카드', area: '8. 멀티', surface: 'main-window', needsEngine: true, needsAccount: true, skip: '패널 실행 턴 필요 — 엔진 예산 밖(본채팅 permission-card로 대표)' },
  { id: 'multi-panel-workflow-dock', label: '멀티 — 패널 워크플로 도크', area: '8. 멀티', surface: 'main-window', needsEngine: true, needsAccount: true, skip: '워크플로 상주 실행 필요 — workflow-dock과 같은 사유' },
  {
    id: 'multi-exit', label: '(정리) 단일 뷰 복귀', area: '8. 멀티', surface: 'main-window', needsEngine: false, needsAccount: false,
    internal: true,
    reach: async (cdp, ctx) => { await exitMulti(ctx) },
    assert: '.chat.chat--code'
  },

  // ══ 9. 독립 창 ════════════════════════════════════════════════════════════════
  {
    id: 'session-window-welcome', label: '추가 채팅 창 — 웰컴', area: '9. 독립 창', surface: 'session-window', needsEngine: false, needsAccount: false,
    win: '#session',
    reach: async (cdp, ctx) => {
      await ctx.blur()
      await ctx.key('N', { ctrl: true, shift: true })
      await ctx.waitForWindow('#session', 15000)
      await sleep(1200)
    },
    assert: '.sw .chat--code .welcome',
    reset: async (cdp, ctx) => { await ctx.closeSubWindows('#session'); await sleep(800) }
  },
  {
    id: 'session-window-btw', label: 'btw 질문 창 — 이어받기 안내 웰컴', area: '9. 독립 창', surface: 'session-window', needsEngine: false, needsAccount: false,
    win: '#session',
    reach: async (cdp, ctx) => {
      await openBtw(ctx)
      await sleep(1500)
    },
    assert: '.sw .welcome .wc-btw',
    reset: async (cdp, ctx) => { await ctx.closeSubWindows('#btw', '#session'); await ctx.clearComposer(); await sleep(800) }
  },
  { id: 'session-window-thread', label: '추가 채팅 창 — 대화 스레드', area: '9. 독립 창', surface: 'session-window', needsEngine: true, needsAccount: true, skip: '추가 채팅 창에서 실제 턴을 돌려야 스레드가 생긴다 — 엔진 예산 밖' },
  { id: 'panel-window-viewer', label: '팝아웃 창 안의 코드 뷰어', area: '9. 독립 창', surface: 'panel-window', needsEngine: false, needsAccount: false, skip: '팝아웃 창엔 탐색기가 없어 파일을 여는 진입점이 스레드의 파일 링크뿐 — 그 링크를 만들려면 그 패널에서 실행 턴이 필요' },

  // ══ 10. 알림 · 트레이 · 업데이트 ══════════════════════════════════════════════
  {
    id: 'toast-single', label: '알림 토스트 — 단건 상세 카드', area: '10. 알림', surface: 'toast', needsEngine: false, needsAccount: false,
    win: 'toast.html',
    reach: async (cdp, ctx) => {
      // 토스트는 메인 창이 포커스면 뜨지 않는다 (notifyToast.ts: owner.isFocused() → return)
      await ctx.ev(`(window.api.win.minimize(), true)`)
      await sleep(900)
      await ctx.ev(`(window.api.notify.event({ kind: 'done', title: '벤치 긴 스레드', preview: '구간 정리를 마쳤어요 — 폴링 두 곳을 이벤트 구독으로 바꾸면 프레임당 호출이 3회 줄어요.', target: { surface: 'single', id: 'fix-long-thread' } }), true)`)
      try {
        await ctx.waitForWindow('toast.html', 12000)
      } catch (e) {
        const diag = await ctx.ev(`({ focus: document.hasFocus(), vis: document.visibilityState })`).catch(() => null)
        const wins = await ctx.listWindows().catch(() => [])
        throw new Error(`toast 창 미생성 — diag=${JSON.stringify(diag)} wins=${JSON.stringify(wins)}`)
      }
      await sleep(900)
    },
    assert: '#card .t-body',
    reset: async (cdp, ctx) => {
      await ctx.ev(`(window.api.notify.close(), true)`).catch(() => {})
      await sleep(600)
      await cdp.send('Page.bringToFront').catch(() => {})
      await sleep(700)
    }
  },
  {
    id: 'toast-aggregate', label: '알림 토스트 — 집계 행', area: '10. 알림', surface: 'toast', needsEngine: false, needsAccount: false,
    win: 'toast.html',
    reach: async (cdp, ctx) => {
      await ctx.ev(`(window.api.win.minimize(), true)`)
      await sleep(900)
      await ctx.ev(`(window.api.notify.event({ kind: 'done', title: '벤치 긴 스레드', preview: '첫 번째 턴이 끝났어요.', target: { surface: 'single', id: 'fix-long-thread' } }), true)`)
      await sleep(700)
      await ctx.ev(`(window.api.notify.event({ kind: 'done', title: '벤치 빈 채팅', preview: '두 번째 알림 — 키가 달라 집계 행으로 접힌다.', target: { surface: 'single', id: 'fix-empty' } }), true)`)
      await sleep(700)
      await ctx.ev(`(window.api.notify.event({ kind: 'ask', title: '패널 2', preview: '승인 요청이 기다리고 있어요.', target: { surface: 'multi', id: 'panel-2' } }), true)`)
      await ctx.waitForWindow('toast.html', 12000)
      await sleep(900)
    },
    assert: '#card .t-agg .t-rows',
    reset: async (cdp, ctx) => {
      await ctx.ev(`(window.api.notify.close(), true)`).catch(() => {})
      await sleep(600)
      await cdp.send('Page.bringToFront').catch(() => {})
      await sleep(700)
    }
  },
  { id: 'tray-menu', label: '트레이 우클릭 메뉴 창', area: '10. 알림', surface: 'tray', needsEngine: false, needsAccount: false, skip: '트레이 아이콘 우클릭은 셸(Explorer) 알림 영역의 OS 이벤트라 CDP로 합성 불가 — Win32 자동화(UIAutomation) 없이는 트리거 자체가 안 된다' },
  { id: 'engine-gate-prompt', label: '엔진 미설치 안내 카드', area: '10. 알림', surface: 'main-window', needsEngine: false, needsAccount: false, boot: 'no-engines', assert: '.set-dialog-overlay .set-dialog .sd-title', note: 'engines 정션을 뺀 홈으로 별도 기동 — ab.mjs boot 페이즈' },
  { id: 'engine-gate-install', label: '엔진 설치 로그 카드', area: '10. 알림', surface: 'main-window', needsEngine: false, needsAccount: false, skip: '게이트에서 설치를 누르면 실제로 엔진을 내려받는다(네트워크·수백 MB) — 벤치 금지' },
  { id: 'engine-update-gate', label: '엔진 자동 업데이트 카드', area: '10. 알림', surface: 'main-window', needsEngine: false, needsAccount: false, skip: 'engine-auto-update.enabled + 구버전 엔진 조합이 필요한데, engines는 실홈과 정션 공유라 버전을 조작하면 사용자 실사용 설치본이 바뀐다' },
  { id: 'app-update-gate', label: '앱 업데이트 바', area: '10. 알림', surface: 'main-window', needsEngine: false, needsAccount: false, skip: '업데이트 서버가 새 버전을 보고해야 뜬다 — 서버 응답을 벤치가 위조하려면 네트워크 가로채기가 필요' },
  { id: 'update-splash', label: '업데이트 적용 스플래시', area: '10. 알림', surface: 'panel-window', needsEngine: false, needsAccount: false, skip: 'Electron 밖 프로세스(cmd /c powershell WPF 창)라 CDP 타깃이 없다 — 데스크톱 캡처로만 판정 가능' }
]

// ── 공용 reset 조각 ─────────────────────────────────────────────────────────────
async function popReset(cdp, ctx) {
  await ctx.esc(1)
  if (await ctx.has('.wb-pop')) { await ctx.click('.workbar .wb-chip', 0).catch(() => {}) }
  await ctx.esc(1)
  await ctx.waitGone('.wb-pop', 3000)
}

async function confirmCancelReset(cdp, ctx) {
  if (!(await ctx.tryClickText('.sconfirm .sccard button', '취소'))) await ctx.esc(1)
  await ctx.waitGone('.sconfirm', 4000)
  await ctx.esc(1)
  await ctx.waitGone('.ctx-menu', 3000)
}

async function viewerReset(cdp, ctx) {
  await ctx.closeViewer()
  await ctx.clearSearch()
}

async function gitReset(cdp, ctx) {
  await ctx.esc(2)
  await ctx.waitGone('.gitm-overlay', 5000)
}

async function settingsReset(cdp, ctx) {
  await ctx.esc(2)
  await ctx.waitGone('.set-modal', 5000)
}

async function clearAttachments(ctx) {
  for (let i = 0; i < 6; i++) {
    const gone = await ctx.ev(`(() => {
      const b = document.querySelector('.composer .img-tray .img-thumb-x')
      if (!b) return true
      b.click(); return false
    })()`).catch(() => true)
    if (gone) break
    await sleep(180)
  }
  await ctx.waitGone('.composer .img-tray .img-thumb', 3000)
}

async function setAutohide(ctx, on) {
  // 실측: 토글은 button.sw2이고 aria-label이 "다음 동작"을 말한다('자동 숨김 켜기' = 지금 꺼짐)
  const ok = await ctx.ev(`(() => {
    const b = [...document.querySelectorAll('.set-inner button.sw2')].find((x) => /자동 숨김|Auto-hide/.test(x.getAttribute('aria-label') || ''))
    if (!b) return false
    const isOn = /끄기|Turn off/.test(b.getAttribute('aria-label') || '')
    if (isOn !== ${on ? 'true' : 'false'}) b.click()
    return true
  })()`)
  if (!ok) throw new Error('setAutohide: 자동 숨김 토글 없음')
  await sleep(700)
}

async function ensureMulti(ctx) {
  if (await ctx.has('.multi .ma-grid .ma-panel')) return
  await ctx.blur()
  await ctx.key('n', { ctrl: true })
  await ctx.waitFor('.nc-veil .nctiles', 6000)
  await ctx.click('.nctile', 1)
  await ctx.waitFor('.nc-veil .nccnts .ncnt', 6000)
  await ctx.click('.ncnt', 2)
  await ctx.waitFor('.multi .ma-grid .ma-panel', 15000)
  await sleep(900)
}

async function exitMulti(ctx) {
  if (!(await ctx.has('.multi'))) return
  await ctx.closeExplorer()
  await ctx.waitFor('.sidebar .sb-item', 8000)
  await ctx.clickText('.sidebar .sb-item', '벤치 긴 스레드')
  await sleep(1200)
  await ctx.waitFor('.chat.chat--code', 12000)
}

// ── 부팅 변형 (ab.mjs의 boot 페이즈가 홈을 이렇게 손보고 재기동한다) ─────────────
export const BOOT_VARIANTS = {
  splash: {
    label: '스플래시 — 기동 순간 data: 타깃 캡처',
    prepare: () => {},
    early: 'data:' // 기동 직후 폴링해 잡을 타깃 URL 조각
  },
  'no-engines': {
    label: '엔진 없는 홈',
    prepare: (home) => {
      const j = path.join(home, 'engines')
      try { fs.rmSync(j, { recursive: true, force: true }) } catch { /* 없음 */ }
    }
  },
  multi: {
    label: '멀티 모드로 기동',
    prepare: (home) => {
      const f = path.join(home, 'ui-prefs.json')
      const p = JSON.parse(fs.readFileSync(f, 'utf8'))
      p['workspace.mode'] = 'multi'
      fs.writeFileSync(f, JSON.stringify(p))
    },
    throttle: 12
  },
  'limit-hold': {
    label: '한도 대기표를 심은 홈',
    prepare: (home) => {
      const f = path.join(home, 'ui-prefs.json')
      const p = JSON.parse(fs.readFileSync(f, 'utf8'))
      p['limitResume.hold'] = {
        key: 'fix-long-thread',
        resetAt: Date.now() + 42 * 60 * 1000,
        text: '5시간 한도에 걸렸어요',
        prompt: '구간 12의 캐시 무효화 규칙을 이어서 정리해줘.',
        window: '5h'
      }
      fs.writeFileSync(f, JSON.stringify(p))
    }
  }
}

export const SCREEN_COUNT = SCREENS.filter((s) => !s.internal).length
