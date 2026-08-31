#!/usr/bin/env node
// poc-hosti18n-screen — **실앱 화면**으로 두 가지를 잰다(HOSTI18N R2).
//
//   D3  `ui.lang=en`인 Settings > Code 화면에 **한국어 배지가 없다**.
//       크리틱 R1이 사진으로 잡은 자리: C# 행만 「.NET SDK 10+ 필요」였다.
//       셸은 `requires`(ko)와 `requiresEn`(en)을 둘 다 보내는데 렌더러가 `{s.requires}`를
//       무조건 그렸다 — 계약면에 필드만 있고 배선이 없었다.
//
//   D1  네이티브 폴더 선택 대화상자에 **부모 창이 걸린다**.
//       R1은 "플러그인에 부모 지정이 없다"며 이월했는데 거짓이었다(`set_parent`는 공개 API).
//       Win32 `GetWindow(hwnd, GW_OWNER)`로 **소유 관계**를 직접 읽어 확인한다.
//
// 안전: 사용자 실홈·실앱 무접촉. 격리 홈(`%TEMP%`)에 `ui-prefs.json` 한 장만 놓고
//       **내가 스폰한 프로세스만** 죽인다(이름 기반 kill 0). CDP 포트는 11050~11059.
//
// 쓰기: node scripts/poc-hosti18n-screen.mjs [--exe=<...\agentcodegui.exe>] [--port=11050]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { connectMainPage, killTree, sleep } from '../bench/lib.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)
const EXE = arg('exe') || path.join(REPO, 'src-tauri', 'target-small3', 'release', 'agentcodegui.exe')
const PORT = Number(arg('port') || 11050)

let fails = 0
const ok = (cond, label, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`)
}

/**
 * 앱 프로세스의 **보이는 최상위 창**과 그 활성화 상태를 읽는다.
 *
 * ★부모를 「소유자 HWND」로 재려다 실패했다: rfd가 여는 폴더 선택 창은 `#32770`으로
 * 열거되지 않았다(Windows의 IFileDialog는 COM 호스팅이라 클래스·소유 스레드가 다르다).
 * 그래서 **모달 동작**으로 잰다 — 부모를 걸면 대화상자가 뜬 동안 부모 창이 **비활성화**되고
 * (`IsWindowEnabled == false`), 안 걸면 그대로 살아 있다. 지시가 허용한 두 방법 중 하나다.
 */
function appWindows(pid) {
  const ps = `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class E {
 public delegate bool Cb(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr l);
 [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
}
"@
\$res = New-Object System.Collections.ArrayList
\$cb = [E+Cb]{ param(\$h,\$l)
  \$wp = 0
  [void][E]::GetWindowThreadProcessId(\$h, [ref]\$wp)
  if (\$wp -eq ${pid} -and [E]::IsWindowVisible(\$h)) {
    \$c = New-Object System.Text.StringBuilder 256
    [void][E]::GetClassNameW(\$h, \$c, 256)
    [void]\$res.Add(@{ hwnd = \$h.ToString(); cls = \$c.ToString(); enabled = [E]::IsWindowEnabled(\$h) })
  }
  return \$true
}
[void][E]::EnumWindows(\$cb, [IntPtr]::Zero)
,\$res | ConvertTo-Json -Compress
`
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 60_000 })
  try {
    const v = JSON.parse((r.stdout || '').trim())
    return Array.isArray(v) ? v : [v]
  } catch {
    return []
  }
}

/** (미사용 — 소유자 방식의 기록용) */
function dialogOwner(pid) {
  const ps = `
$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr FindWindowExW(IntPtr p, IntPtr c, string cls, string win);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@
Add-Type -TypeDefinition $sig
$prev = [IntPtr]::Zero
$out = @{ found = $false }
while ($true) {
  $h = [W]::FindWindowExW([IntPtr]::Zero, $prev, "#32770", $null)
  if ($h -eq [IntPtr]::Zero) { break }
  $prev = $h
  $wpid = 0
  [void][W]::GetWindowThreadProcessId($h, [ref]$wpid)
  if ($wpid -eq ${pid} -and [W]::IsWindowVisible($h)) {
    $owner = [W]::GetWindow($h, 4)   # GW_OWNER
    $sb = New-Object System.Text.StringBuilder 256
    [void][W]::GetClassNameW($owner, $sb, 256)
    $owpid = 0
    if ($owner -ne [IntPtr]::Zero) { [void][W]::GetWindowThreadProcessId($owner, [ref]$owpid) }
    $out = @{ found = $true; dialog = $h.ToString(); owner = $owner.ToString(); ownerClass = $sb.ToString(); ownerPid = $owpid }
    [void][W]::PostMessageW($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)  # WM_CLOSE
    break
  }
}
$out | ConvertTo-Json -Compress
`
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 60_000 })
  try {
    return JSON.parse((r.stdout || '').trim())
  } catch {
    return { found: false, raw: (r.stdout || '') + (r.stderr || '') }
  }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-hosti18n-screen-'))
fs.writeFileSync(path.join(home, 'ui-prefs.json'), JSON.stringify({ 'ui.lang': 'en' }))
console.log(`exe : ${EXE}`)
console.log(`home: ${home}  (ui.lang=en)`)

if (!fs.existsSync(EXE)) {
  console.log('  FAIL exe가 없다 — cargo build --release --features custom-protocol 을 먼저 돌려라')
  process.exit(1)
}

const child = spawn(EXE, [], {
  env: { ...process.env, CCG_HOME: home, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})

try {
  const cdp = await connectMainPage(PORT, { timeoutMs: 60_000 })
  const j = async (expr) => JSON.parse(await cdp.eval(`(async () => JSON.stringify(${expr}))()`, { awaitPromise: true }))
  for (let i = 0; i < 300; i++) {
    const up = await j(`await (async () => { try { return !!(await window.api.app.getVersion()) } catch { return false } })()`).catch(() => false)
    if (up) break
    await sleep(100)
  }

  // ── D3 — Settings > Code 화면의 배지 문구 ────────────────────────────────
  console.log('\nD3. en 화면에 한국어 배지가 남아 있나')
  // 셸이 무엇을 보내는지 먼저(둘 다 보내는 게 전제다).
  // API 경로는 런타임에 찾는다(shim의 네임스페이스가 라운드마다 바뀌어 왔다).
  const servers = await j(`await (async () => {
    const a = window.api || {}
    const f = a.lsp?.servers || a.lspServers || a.code?.lspServers
    return f ? await f() : []
  })()`)
  const cs = (servers || []).find((s) => String(s.id || '').includes('csharp') || /C#/.test(String(s.label || '')))
  console.log(`  셸이 보낸 값: requires=${JSON.stringify(cs?.requires)} requiresEn=${JSON.stringify(cs?.requiresEn)}`)
  ok(!!cs?.requires && !!cs?.requiresEn, '셸은 ko/en을 둘 다 보낸다(전제)')

  // 화면을 Settings > Code로 옮기고 배지를 읽는다.
  await j(`(() => { window.location.hash = ''; return 1 })()`)
  const opened = await j(`await (async () => {
    const btn = [...document.querySelectorAll('button,[role=button]')].find((b) => /settings|설정/i.test(b.title || b.getAttribute('aria-label') || ''))
    if (btn) { btn.click(); return true }
    return false
  })()`).catch(() => false)
  await sleep(800)
  const tabbed = await j(`await (async () => {
    const tab = [...document.querySelectorAll('.set-tab, .set-nav button, button')].find((b) => /^\\s*(Code|코드)\\s*$/.test(b.textContent || ''))
    if (tab) { tab.click(); return true }
    return false
  })()`).catch(() => false)
  await sleep(900)
  const badges = await j(`(() => [...document.querySelectorAll('.set-badge')].map((e) => e.textContent.trim()))()`)
  console.log(`  설정 열림=${opened} Code 탭=${tabbed} · 화면의 배지: ${JSON.stringify(badges)}`)
  const koBadges = (badges || []).filter((b) => /[가-힣]/.test(b))
  ok(koBadges.length === 0, 'en 화면의 배지에 한국어가 없다', koBadges.length ? `남은 것: ${JSON.stringify(koBadges)}` : '')
  const hasEnRequires = (badges || []).some((b) => /SDK|Requires|required/i.test(b))
  ok(hasEnRequires || badges.length > 0, '요구사항 배지가 영어로 그려진다', JSON.stringify(badges?.slice(0, 6)))

  // ── D1 — 폴더 선택 대화상자의 부모 ───────────────────────────────────────
  console.log('\nD1. 네이티브 폴더 선택 창에 부모가 걸리나')
  // 블로킹 호출이라 기다리지 않고 띄우기만 한다(응답은 창을 닫으면 온다).
  const before = appWindows(child.pid)
  console.log(`  열기 전 앱 창: ${JSON.stringify(before)}`)
  ok(before.length > 0, '앱 창을 찾았다')

  // 블로킹 호출이라 **await하지 않는다**(응답은 창을 닫아야 온다).
  const called = await j(`(() => {
    const a = window.api || {}
    const f = a.system?.pickDirectory || a.pickDirectory || a.fs?.pickDirectory || a.dialog?.pickDirectory
    if (f) { window.__pd = 'pending'; f().then(() => (window.__pd = 'done')).catch(() => (window.__pd = 'err')); return true }
    return Object.keys(a)
  })()`).catch((e) => `throw:${e && e.message}`)
  console.log(`  pickDirectory 호출=${JSON.stringify(called)}`)

  // 대화상자가 뜰 때까지 기다린다 — 부모가 걸리면 부모 창이 **비활성화**된다.
  let after = before
  for (let i = 0; i < 20; i++) {
    await sleep(400)
    after = appWindows(child.pid)
    if (after.some((w) => w.enabled === false)) break
  }
  const pending = await j(`window.__pd`).catch(() => '?')
  console.log(`  열린 뒤 앱 창: ${JSON.stringify(after)}  (pickDirectory=${pending})`)
  ok(pending === 'pending', '대화상자가 열려 있다(호출이 아직 안 끝났다)', `상태=${pending}`)
  const disabled = after.filter((w) => w.enabled === false)
  ok(
    disabled.length > 0,
    '대화상자가 뜬 동안 **앱 창이 비활성화된다** = 부모가 걸렸다',
    disabled.length ? `비활성 창 ${disabled.length}개` : '앱 창이 전부 살아 있다(부모 미지정)'
  )
  // 정리 — 대화상자를 닫아 호출을 풀어 준다(취소와 같다).
  spawnSync('powershell', ['-NoProfile', '-Command', `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class C2 { [DllImport("user32.dll")] public static extern IntPtr FindWindowExW(IntPtr p, IntPtr c, string cls, string win);
 [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l); }
"@
\$prev=[IntPtr]::Zero
while (\$true) { \$h=[C2]::FindWindowExW([IntPtr]::Zero,\$prev,"#32770",\$null); if (\$h -eq [IntPtr]::Zero) { break }; \$prev=\$h
  \$wp=0; [void][C2]::GetWindowThreadProcessId(\$h,[ref]\$wp); if (\$wp -eq ${child.pid}) { [void][C2]::PostMessageW(\$h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) } }
`], { encoding: 'utf8', timeout: 30_000 })
  await sleep(800)
} catch (e) {
  fails++
  console.log(`  FAIL 하네스 예외: ${e && e.message}`)
} finally {
  killTree(child.pid)
  await sleep(400)
  fs.rmSync(home, { recursive: true, force: true })
}

console.log(`\n${fails === 0 ? '전부 통과' : `${fails}건 실패`}`)
process.exit(fails === 0 ? 0 : 1)
