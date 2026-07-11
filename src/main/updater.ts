import { app } from 'electron'
import { spawn } from 'node:child_process'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/protocol'

// electron-updater is CommonJS — pull `autoUpdater` off the default export so it
// works under the ESM-bundled main process.
const { autoUpdater } = electronUpdater

// The authoritative update state lives here (not in the renderer), so the UI can
// fetch it on mount and never miss events fired before it subscribed. A running
// `log` mirrors the engine-install card's streamed output.
let state: UpdateStatus = { phase: 'idle', version: null, percent: 0, log: [], error: null }
let sender: ((s: UpdateStatus) => void) | null = null
let lastLoggedStep = -1
let wired = false
// 켜둔 채로 며칠을 쓰는 사용 패턴에서, 그 사이 올라온 릴리즈도 알아채도록 주기 재확인.
// 확인 한 번 = latest.yml(수백 바이트) GET 하나라 10분 주기여도 부담이 없다.
const RECHECK_MS = 10 * 60 * 1000 // 10분
let recheckTimer: ReturnType<typeof setInterval> | null = null

function emit(): void {
  sender?.(state)
}
function set(patch: Partial<UpdateStatus>, line?: string): void {
  state = { ...state, ...patch, log: line ? [...state.log, line] : state.log }
  emit()
}
function mb(bytes: number): string {
  return (bytes / 1048576).toFixed(1)
}

/** Current update state — used to seed the renderer on mount. */
export function getUpdateStatus(): UpdateStatus {
  return state
}

/**
 * Wire up auto-updates against the configured GitHub Releases provider. Only does
 * anything in a packaged build: electron-builder writes an `app-update.yml` into the
 * app resources at package time, and electron-updater needs it to know where to look.
 * In dev there's no metadata, so this is a no-op (no spurious errors).
 *
 * `send` pushes the full state to the renderer on every change.
 */
export function initAutoUpdater(send: (s: UpdateStatus) => void): void {
  sender = send
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true // download in the background as soon as one is found
  autoUpdater.autoInstallOnAppQuit = true // and install it on the next normal quit

  if (!wired) {
    wired = true
    autoUpdater.on('checking-for-update', () => {
      // 확인 사이클마다 로그·이전 오류를 새로 시작 — 주기 재확인으로 로그가 무한히 안 자라게
      state = { ...state, log: [] }
      lastLoggedStep = -1
      set({ phase: 'checking', error: null }, '업데이트를 확인하는 중…')
    })
    autoUpdater.on('update-available', (info) =>
      set({ phase: 'available', version: info.version }, `새 버전 v${info.version}을(를) 찾았어요 · 다운로드를 시작합니다`)
    )
    autoUpdater.on('update-not-available', () => set({ phase: 'none' }, '이미 최신 버전이에요'))
    autoUpdater.on('download-progress', (p) => {
      const percent = Math.max(0, Math.min(100, Math.round(p.percent)))
      // append a log line only every 5% so the log reads cleanly instead of flooding
      const step = Math.floor(percent / 5)
      const line = step !== lastLoggedStep ? `다운로드 ${percent}% · ${mb(p.transferred)} / ${mb(p.total)} MB` : undefined
      if (line) lastLoggedStep = step
      set({ phase: 'downloading', percent }, line)
    })
    autoUpdater.on('update-downloaded', (info) =>
      set({ phase: 'downloaded', version: info.version, percent: 100 }, '다운로드 완료 · 재시작하면 설치됩니다')
    )
    autoUpdater.on('error', (err) => set({ phase: 'error', error: err?.message ?? String(err) }, '업데이트 중 오류가 발생했어요'))
  }

  checkForUpdates()

  // 주기 재확인 — 단, 내려받는 중/받아둔 상태에선 쉰다. 같은 버전으로 phase가
  // 다시 구르면(available→downloaded 전이) 닫아둔 카드가 주기마다 되뜨기 때문.
  // 받아둔 버전은 재시작(또는 종료 시 자동 설치) 때 깔리고, 그보다 새 릴리즈는
  // 재시작 직후의 launch 확인이 이어받는다. 오류/최신 상태에서는 계속 재시도.
  if (!recheckTimer) {
    recheckTimer = setInterval(() => {
      if (state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'downloaded') return
      checkForUpdates()
    }, RECHECK_MS)
  }
}

/** Trigger an update check. Safe to call repeatedly; ignored outside a packaged build. */
export function checkForUpdates(): void {
  if (!app.isPackaged) return
  // offline, or no release published yet → the 'error' event already surfaces anything
  // worth showing, so just swallow the rejection here.
  autoUpdater.checkForUpdates().catch(() => {})
}

// ── 업데이트 스플래시 ────────────────────────────────────────
// 조용한 설치(/S) 동안 앱이 완전히 내려가 화면이 몇 초 비므로, 앱 밖 프로세스로
// 자체 디자인 스플래시를 띄워 그 공백을 메꾼다. 앱 자신(AgentCodeGUI.exe)을 다시
// 띄워 쓰면 실행 파일이 잠겨 설치가 실패하므로, Windows 내장 PowerShell + WPF를
// 쓴다(-EncodedCommand는 실행 정책(Restricted)의 적용 대상이 아니라 어디서나 돈다).
// 스플래시는 새로 뜬 앱 프로세스(StartTime > 스플래시 시작)를 감지하면 스스로
// 닫히고, 90초가 지나면(설치 실패 등) 포기하고 닫히는 안전장치를 둔다.
function showUpdateSplash(version: string | null): void {
  if (process.platform !== 'win32') return
  const ver = (version || '').replace(/[^0-9A-Za-z.\-]/g, '')
  const sub = ver ? `v${ver} 설치가 끝나면 자동으로 다시 열려요` : '설치가 끝나면 자동으로 다시 열려요'
  const ps = `Add-Type -AssemblyName PresentationFramework
$script:t0 = Get-Date
$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        SizeToContent="Height" Width="392" WindowStyle="None" AllowsTransparency="True"
        Background="Transparent" WindowStartupLocation="CenterScreen" Topmost="True"
        ShowInTaskbar="False" ResizeMode="NoResize">
  <Border Background="#F21B1B1B" CornerRadius="14" BorderBrush="#26FFFFFF" BorderThickness="1" Padding="22,20,22,22" Margin="14">
    <Border.Effect>
      <DropShadowEffect BlurRadius="26" ShadowDepth="6" Opacity="0.45" Color="#000000"/>
    </Border.Effect>
    <StackPanel>
      <StackPanel Orientation="Horizontal" Margin="0,0,0,15">
        <Border Width="31" Height="31" CornerRadius="9" Background="#C4633E">
          <TextBlock Text="&lt;/&gt;" Foreground="#FFF8F2" FontFamily="Consolas" FontSize="12" FontWeight="Bold"
                     HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
        <StackPanel Margin="12,0,0,0" VerticalAlignment="Center">
          <TextBlock Text="새 버전으로 업데이트하는 중" Foreground="#F2F2F2" FontSize="14" FontWeight="SemiBold" FontFamily="Segoe UI"/>
          <TextBlock Text="${sub}" Foreground="#9A9A9A" FontSize="11.5" Margin="0,3,0,0" FontFamily="Segoe UI"/>
        </StackPanel>
      </StackPanel>
      <ProgressBar IsIndeterminate="True" Height="4" Foreground="#C4633E" Background="#2E2E2E" BorderThickness="0"/>
    </StackPanel>
  </Border>
</Window>
'@
$script:w = [Windows.Markup.XamlReader]::Parse($xaml)
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({
  $done = $false
  foreach ($p in @(Get-Process AgentCodeGUI -ErrorAction SilentlyContinue)) {
    try { if ($p.StartTime -gt $script:t0) { $done = $true } } catch {}
  }
  if ($done -or ((Get-Date) - $script:t0).TotalSeconds -gt 90) { $script:w.Close() }
})
$timer.Start()
$null = $script:w.ShowDialog()
`
  // cmd /c 한 다리를 거쳐 띄운다 (직접 spawn의 두 함정, PoC 실측):
  //  · detached:true → DETACHED_PROCESS(콘솔 없음)인데 powershell.exe는 콘솔 앱이라 기동 자체를 못 한다
  //  · detached 없음 → libuv job object(KILL_ON_JOB_CLOSE)가 앱 종료와 함께 자식을 죽인다
  // cmd(자식)는 job 안에서 앱과 함께 죽지만, 손자 PS는 SILENT_BREAKAWAY_OK로 job 밖이라
  // 설치 내내 생존하고, 콘솔은 cmd의 숨은 콘솔(windowsHide)을 물려받아 번쩍임이 없다.
  // 주의: cmd 커맨드라인은 8191자 한계 — 현재 EncodedCommand ~6.2k라 여유가 크지 않다.
  try {
    spawn(
      'cmd.exe',
      ['/d', '/s', '/c', 'powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      { stdio: 'ignore', windowsHide: true }
    ).unref()
  } catch {
    /* 스플래시는 장식 — 실패해도 설치는 그대로 진행 */
  }
}

/** Quit and install an already-downloaded update, then relaunch the app. */
export function quitAndInstall(): void {
  if (!app.isPackaged) return
  // isSilent=true: NSIS를 /S로 돌려 설치 마법사 없이 이전 위치에 그대로 덮어쓴다
  // (사용자별 설치라 UAC도 없음) — 앱이 꺼졌다가 새 버전으로 바로 돌아오는 경험.
  // 첫 설치의 마법사(폴더 선택)는 oneClick:false 그대로라 영향 없다.
  showUpdateSplash(state.version)
  // 스플래시(PowerShell+WPF)가 그려지기까지 1~2초 걸린다 — 앱이 사라지기 전에
  // 겹쳐 나타나도록 한 박자 늦게 종료해, 화면에 아무것도 없는 순간을 줄인다.
  setTimeout(() => autoUpdater.quitAndInstall(true, true), 1200)
}
