/**
 * PoC — 3.0 창 껍데기(숨김 타이틀바 + 네이티브 Snap/리사이즈 + 아크릴)의 동시 성립을
 * Win32/DWM 실측으로 판정한다. 2.6.2(Electron)의 frame:false + backgroundMaterial:'acrylic'
 * 조합을 Tauri에서 재현할 수 있는지가 M1 최대 리스크라서, 후보를 CCG_CHROME으로 갈아
 * 끼우며 같은 항목을 잰다.
 *
 *   node scripts/poc-tauri-chrome.mjs [a|b|c]
 *     a = decorations:true (OS 캡션 유지)
 *     b = decorations:false + shadow + transparent + Acrylic   ← 채택 후보
 *     c = b에서 아크릴/투명 제거 (대조군)
 *
 * 재는 것:
 *   1) 창 스타일 비트: WS_THICKFRAME(엣지 리사이즈)·WS_MAXIMIZEBOX(스냅/최대화)·WS_CAPTION
 *   2) DWM 시스템 백드롭 타입(38) == 3(DWMSBT_TRANSIENTWINDOW) → Electron의 acrylic과 동일 경로
 *   3) 최대화 결과 rect == 모니터 작업 영역(작업 표시줄을 덮지 않는가 — 프레임리스 고질병)
 *   4) Aero Snap(Win+←) 후 rect == 작업 영역 좌반
 *   5) 창 영역 OS 스크린샷 (아크릴이 실제로 보이는지 눈으로)
 *
 * 앱 홈은 .poc-home-tauri로 격리한다 — 이 스크립트는 창을 최대화/스냅하므로 벤치 홈의
 * window-state.json을 오염시키면 안 된다.
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { Cdp, connectMainPage, sleep, killTree, REPO } from '../bench/lib.mjs'

const mode = (process.argv[2] || 'b').toLowerCase()
const EXE = path.join(REPO, 'target', 'release', 'agentcodegui.exe')
const DEBUG_EXE = path.join(REPO, 'target', 'debug', 'agentcodegui.exe')
const HOME = path.join(REPO, '.poc-home-tauri')
const PORT = 9336

const exe = fs.existsSync(EXE) ? EXE : DEBUG_EXE
if (!fs.existsSync(exe)) {
  console.error('빌드된 exe가 없다 — cargo build [--release] -p agentcodegui 먼저')
  process.exit(1)
}
fs.mkdirSync(HOME, { recursive: true })
// 실행마다 같은 출발점 — 앞 실행이 스냅/최대화로 남긴 window-state가 판정을 흔들지 않게
fs.rmSync(path.join(HOME, 'window-state.json'), { force: true })

const ps = (script) => {
  const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    timeout: 60000
  })
  return out.trim()
}

const WIN32 = String.raw`
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Drawing;
public class P {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetWindowLongPtrW(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  /** 클라이언트(실제 콘텐츠) 영역을 화면 좌표로 — 프레임리스 창은 이게 "보이는 창"이다 */
  public static RECT ClientScreen(IntPtr h){
    RECT c; GetClientRect(h, out c);
    POINT tl; tl.X=c.Left; tl.Y=c.Top; ClientToScreen(h, ref tl);
    RECT r; r.Left=tl.X; r.Top=tl.Y; r.Right=tl.X+(c.Right-c.Left); r.Bottom=tl.Y+(c.Bottom-c.Top);
    return r;
  }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  /** 입력 실측 전에 창을 확실히 맨 위로 (다른 창이 덮고 있으면 클릭이 그리로 샌다) */
  public static void ToTop(IntPtr h, bool on){
    SetWindowPos(h, new IntPtr(on ? -1 : -2), 0, 0, 0, 0, 0x0043); // NOMOVE|NOSIZE|SHOWWINDOW
  }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int cb);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr ex; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
  static INPUT Mk(uint flags, int x, int y){ INPUT i=new INPUT(); i.type=0; i.mi.dwFlags=flags; i.mi.dx=x; i.mi.dy=y; return i; }
  // SendInput(절대 좌표)만이 창 이동 모달 루프를 실제로 몬다 — SetCursorPos/mouse_event(상대 0,0)로는
  // 커서만 움직이고 루프가 따라오지 않아 "드래그가 안 되는 것처럼" 보인다(실측 함정).
  public static void MoveAbs(int sx,int sy){
    int W=GetSystemMetrics(78), H=GetSystemMetrics(79);
    INPUT[] a = new INPUT[]{ Mk(0x8001, (int)(sx*65535.0/(W-1)), (int)(sy*65535.0/(H-1))) };
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Btn(bool down){ INPUT[] a = new INPUT[]{ Mk(down?0x0002u:0x0004u,0,0) }; SendInput(1, a, Marshal.SizeOf(typeof(INPUT))); }
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static System.Collections.Generic.List<IntPtr> All(uint target){
    var list = new System.Collections.Generic.List<IntPtr>();
    EnumWindows((h,l)=>{
      if(!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      if(p==target){ list.Add(h); }
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static string Cls(IntPtr h){ var sb=new System.Text.StringBuilder(256); GetClassNameW(h,sb,256); return sb.ToString(); }
  /** 가장 큰 가시 창 = 진짜 앱 창 (16x16 헬퍼 팝업 등을 배제) */
  public static IntPtr Find(uint target){
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    foreach(var h in All(target)){
      RECT r; GetWindowRect(h, out r);
      long area = (long)(r.Right-r.Left) * (r.Bottom-r.Top);
      if(area > bestArea){ bestArea = area; best = h; }
    }
    return bestArea >= 40000 ? best : IntPtr.Zero;   // 200x200 미만은 앱 창이 아니다
  }
}
"@
`

function findWindow(pid, timeoutMs = 30000) {
  const t0 = Date.now()
  for (;;) {
    const h = ps(`${WIN32}
$h=[P]::Find(${pid}); if($h -eq [IntPtr]::Zero){ '0' } else { $h.ToInt64() }`)
    if (h && h !== '0') return h
    if (Date.now() - t0 > timeoutMs) return null
    execFileSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 200'])
  }
}

function probe(hwnd) {
  const out = ps(`${WIN32}
$h=[IntPtr]::new(${hwnd})
$style=[P]::GetWindowLongPtrW($h,-16).ToInt64()
$ex=[P]::GetWindowLongPtrW($h,-20).ToInt64()
$bd=0; $hr=[P]::DwmGetWindowAttribute($h,38,[ref]$bd,4)
$r=New-Object P+RECT; [void][P]::GetWindowRect($h,[ref]$r)
$c=[P]::ClientScreen($h)
$scr=[System.Windows.Forms.Screen]::FromHandle($h)
@{ style=$style; ex=$ex; backdropHr=$hr; backdrop=$bd;
   rect=@($r.Left,$r.Top,$r.Right,$r.Bottom);
   client=@($c.Left,$c.Top,$c.Right,$c.Bottom);
   work=@($scr.WorkingArea.Left,$scr.WorkingArea.Top,$scr.WorkingArea.Right,$scr.WorkingArea.Bottom)
} | ConvertTo-Json -Compress`)
  return JSON.parse(out)
}

function shot(hwnd, file) {
  ps(`${WIN32}
$h=[IntPtr]::new(${hwnd})
$r=New-Object P+RECT; [void][P]::GetWindowRect($h,[ref]$r)
$w=$r.Right-$r.Left; $hh=$r.Bottom-$r.Top
$bmp=New-Object System.Drawing.Bitmap($w,$hh)
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left,$r.Top,0,0,(New-Object System.Drawing.Size($w,$hh)))
$bmp.Save('${file.replace(/\\/g, '\\\\')}',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()`)
}

/**
 * 진짜 마우스로 드래그 영역을 끌어 창이 따라오는지 — 심의 mousedown → startDragging
 * (ReleaseCapture + WM_NCLBUTTONDOWN/HTCAPTION) 경로를 OS 입력으로 끝까지 검증한다.
 * CDP의 합성 이벤트로는 실제 창 이동이 일어나지 않아(버튼이 눌린 상태가 아니라) 의미가 없다.
 */
function dragBy(hwnd, sx, sy, dx, dy) {
  return ps(`${WIN32}
$h=[IntPtr]::new(${hwnd})
[P]::ToTop($h, $true)
[void][P]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 400
# 포그라운드 탈취가 막혀도 진행한다 — 그 자리를 실제로 클릭하면 창이 활성화된다.
# (클릭 뒤에도 포그라운드가 우리 창이 아니면 다른 창이 위를 덮은 것이므로 중단)
[P]::MoveAbs(${sx}, ${sy})
Start-Sleep -Milliseconds 250
[P]::Btn($true)
Start-Sleep -Milliseconds 250
if([P]::GetForegroundWindow() -ne $h){ [P]::Btn($false); 'not-foreground'; exit }
foreach($i in 1..10){
  [P]::MoveAbs(${sx} + [int](${dx}*$i/10), ${sy} + [int](${dy}*$i/10))
  Start-Sleep -Milliseconds 70
}
Start-Sleep -Milliseconds 250
[P]::Btn($false)
Start-Sleep -Milliseconds 500
'ok'`)
}

/** Win+← 스냅. 내 창이 포그라운드일 때만 보낸다(사용자 실앱을 건드리지 않게). */
function snapLeft(hwnd) {
  return ps(`${WIN32}
$h=[IntPtr]::new(${hwnd})
[P]::ToTop($h, $true)
[void][P]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 400
if([P]::GetForegroundWindow() -ne $h){ 'not-foreground'; exit }
[P]::keybd_event(0x5B,0,0,[UIntPtr]::Zero)   # LWIN down
[P]::keybd_event(0x25,0,0,[UIntPtr]::Zero)   # LEFT down
[P]::keybd_event(0x25,0,2,[UIntPtr]::Zero)   # LEFT up
[P]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)   # LWIN up
Start-Sleep -Milliseconds 900
# 스냅 레이아웃 제안 UI가 뜨면 Esc로 닫는다
[System.Windows.Forms.SendKeys]::SendWait('{ESC}')
Start-Sleep -Milliseconds 300
'ok'`)
}

const bit = (v, m) => (BigInt(v) & BigInt(m)) !== 0n

const child = spawn(exe, [], {
  env: {
    ...process.env,
    CCG_HOME: HOME,
    CCG_CHROME: mode,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`
  },
  stdio: 'ignore'
})

const result = { mode, pid: child.pid }
try {
  const hwnd = findWindow(child.pid)
  // 이 PID의 모든 가시 창(클래스·크기) — 벤치의 "첫 가시 창"이 무엇을 잡는지도 여기서 드러난다
  result.visibleWindows = JSON.parse(
    ps(`${WIN32}
@([P]::All(${child.pid}) | ForEach-Object { $r=New-Object P+RECT; [void][P]::GetWindowRect($_,[ref]$r);
  @{ hwnd=$_.ToInt64(); cls=[P]::Cls($_); w=($r.Right-$r.Left); h=($r.Bottom-$r.Top) } }) | ConvertTo-Json -Compress -Depth 3`) ||
      '[]'
  )
  if (!hwnd) throw new Error('앱 창(200x200 이상 가시 창)을 찾지 못했다')
  result.hwnd = hwnd
  await sleep(1200)

  const p = probe(hwnd)
  result.style = {
    WS_CAPTION: bit(p.style, 0x00c00000),
    WS_THICKFRAME: bit(p.style, 0x00040000),
    WS_MAXIMIZEBOX: bit(p.style, 0x00010000),
    WS_MINIMIZEBOX: bit(p.style, 0x00020000),
    WS_POPUP: bit(p.style, 0x80000000),
    WS_EX_LAYERED: bit(p.ex, 0x00080000),
    WS_EX_NOREDIRECTIONBITMAP: bit(p.ex, 0x00200000)
  }
  result.dwmBackdrop = { hr: p.backdropHr, value: p.backdrop, isAcrylic: p.backdrop === 3 }
  result.rect = p.rect
  result.work = p.work

  // 렌더러가 실제로 떴는지 + 창 컨트롤 왕복
  const cdp = await connectMainPage(PORT, { timeoutMs: 30000 }).catch(() => null)
  if (cdp) {
    result.rootMounted = await cdp.eval(`!!document.getElementById('root')?.children.length`).catch(() => null)
    result.apiPresent = await cdp.eval(`typeof window.api === 'object'`).catch(() => null)
    result.appRegionComputed = await cdp
      .eval(
        `(() => { const d=document.createElement('div'); d.style.setProperty('-webkit-app-region','drag');
          document.body.appendChild(d); const v=getComputedStyle(d).getPropertyValue('-webkit-app-region');
          d.remove(); return v.trim() })()`
      )
      .catch(() => null)
    // 렌더러 CSS의 드래그 영역이 WebView2에서도 계산값으로 읽히는가 (심의 빠른 경로)
    result.dragRegions = await cdp
      .eval(
        `(() => { const q = (s) => { const el = document.querySelector(s); return el ? getComputedStyle(el).getPropertyValue('-webkit-app-region').trim() : 'no-element' };
          return { titlebar: q('.titlebar'), sbTop: q('.sb-top'), winCtlBtn: q('.win-ctl button') } })()`
      )
      .catch(() => null)
    // 패치노트 카드(전면 오버레이)를 먼저 닫는다 — 안 닫으면 드래그 클릭이 카드로 간다
    // (2.6.2 실측 때도 같은 함정을 밟았다). 닫기는 whatsnew.seenVersion을 uiPrefs에
    // 저장하므로 ui-prefs 저장 경로까지 함께 검증된다.
    result.patchNotesClosed = await cdp
      .eval(
        `(() => { const btns = [...document.querySelectorAll('button')];
          const go = btns.find((b) => /시작하기|Get started/.test(b.textContent || ''));
          if (go) { go.click(); return true } return !document.querySelector('.set-dialog-overlay') })()`
      )
      .catch(() => null)
    await sleep(500)
    result.overlayGone = await cdp.eval(`!document.querySelector('.set-dialog-overlay')`).catch(() => null)
    // 실드래그에 쓸 좌표 — **화면에 실제로 보이는** 드래그 영역의 한 점.
    // (사이드바 자동 숨김이면 .sb-top은 화면 밖 x<0에 있다 — 그걸 찍으면 클릭이
    //  다른 창으로 샌다. elementFromPoint가 그 점에서 'drag'를 돌려주는지로 고른다.)
    result.dragRegionBox = await cdp
      .eval(
        `(() => {
          const dpr = window.devicePixelRatio || 1
          for (const s of ['.chat-head', '.ma-head', '.sb-top', '.fxh', '.titlebar']) {
            const el = document.querySelector(s); if (!el) continue
            const r = el.getBoundingClientRect()
            if (r.width < 80 || r.height < 8 || r.x < 0 || r.y < 0) continue
            for (let f = 0.2; f <= 0.8; f += 0.1) {
              const px = r.x + r.width * f, py = r.y + r.height / 2
              const hit = document.elementFromPoint(px, py)
              if (hit && getComputedStyle(hit).getPropertyValue('-webkit-app-region').trim() === 'drag')
                return { sel: s, px: Math.round(px * dpr), py: Math.round(py * dpr), dpr }
            }
          }
          return null
        })()`
      )
      .catch(() => null)
    // 최대화가 작업 영역을 지키는가 (작업 표시줄을 덮으면 프레임리스 고질병)
    await cdp.eval(`window.api.win.toggleMaximize()`, { awaitPromise: true }).catch(() => {})
    await sleep(700)
    shot(hwnd, path.join(HOME, `shot-${mode}-max.png`))
    const m = probe(hwnd)
    // 프레임리스 창의 "보이는 영역"은 클라이언트 rect다 — 창 rect는 최대화 때 프레임
    // 두께만큼 부풀어 나온다(장식 창도 똑같다). 작업 표시줄을 덮는지는 클라이언트
    // rect == 작업 영역으로 판정해야 맞다.
    result.maximized = {
      rect: m.rect,
      client: m.client,
      work: m.work,
      clientFitsWorkArea: JSON.stringify(m.client) === JSON.stringify(m.work)
    }
    await cdp.eval(`window.api.win.toggleMaximize()`, { awaitPromise: true }).catch(() => {})
    await sleep(600)
    cdp.close()
  }

  const file = path.join(HOME, `shot-${mode}.png`)
  shot(hwnd, file)
  result.screenshot = file

  // 드래그 영역 실드래그 — CSS의 -webkit-app-region:drag가 실제 창 이동으로 이어지는가
  if (result.dragRegionBox) {
    const before = probe(hwnd)
    const sx = before.client[0] + result.dragRegionBox.px
    const sy = before.client[1] + result.dragRegionBox.py
    const r = dragBy(hwnd, sx, sy, 160, 90)
    if (r === 'ok') {
      const after = probe(hwnd)
      const mx = after.rect[0] - before.rect[0]
      const my = after.rect[1] - before.rect[1]
      result.dragTest = {
        from: before.rect,
        to: after.rect,
        askedX: 160,
        askedY: 90,
        movedX: mx,
        movedY: my,
        // 스냅 해제 드래그면 X는 커서 기준으로 재배치돼 요청 델타와 다를 수 있다 —
        // "창이 마우스를 따라 실제로 움직였는가"가 판정 대상이다
        moved: Math.abs(mx) > 20 && Math.abs(my - 90) <= 24
      }
    } else {
      result.dragTest = { skipped: r }
    }
  }

  const snap = snapLeft(hwnd)
  if (snap === 'ok') {
    await sleep(400)
    const s = probe(hwnd)
    const [wl, wt, wr, wb] = s.work
    const halfW = Math.round((wr - wl) / 2)
    const [l, t, r, b] = s.rect
    const [cl, ct, cr, cb] = s.client
    result.snapLeft = {
      rect: s.rect,
      client: s.client,
      work: s.work,
      // 좌반 스냅 판정(창 rect는 그림자 여백 ±12px 허용, 클라이언트는 딱 맞아야 한다)
      snapped:
        Math.abs(l - wl) <= 12 && Math.abs(t - wt) <= 12 && Math.abs(r - (wl + halfW)) <= 12 && Math.abs(b - wb) <= 12,
      clientSnapped:
        Math.abs(cl - wl) <= 2 && Math.abs(ct - wt) <= 2 && Math.abs(cr - (wl + halfW)) <= 2 && Math.abs(cb - wb) <= 2
    }
  } else {
    result.snapLeft = { skipped: snap }
  }
} catch (e) {
  result.error = String(e?.message ?? e)
} finally {
  killTree(child.pid)
}

console.log(JSON.stringify(result, null, 2))
