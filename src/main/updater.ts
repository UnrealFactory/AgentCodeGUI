import { app } from 'electron'
import { spawn } from 'node:child_process'
import electronUpdater from 'electron-updater'
import { t } from './lang'
import { compareVersionsDesc } from './engine/versions'
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
// 받아둔(downloaded) 상태의 '조용한 재확인' 표식 — 받아둔 뒤에 더 새 릴리즈가 올라왔는지만
// 본다. 같은 버전이 다시 잡히는 동안엔 상태를 일절 건드리지 않아('나중에'로 접은 카드는
// phase가 downloaded로 다시 구르는 순간 되뜨므로), 침묵이 곧 카드 보호다. 더 새 버전이
// 발견되면 표식을 내리고 일반 흐름(available→downloading→downloaded)으로 복귀한다 —
// v2.3.1을 받아둔 채 v2.3.2가 올라와도 업데이트 버튼은 항상 가장 마지막 패치본을 설치.
let probing = false

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
  // 종료 시 자동 설치는 쓰지 않는다: 그 경로는 아무 화면 없이 NSIS 설치기가 "이전 버전
  // 삭제 → 새 파일 복사"를 백그라운드로 도는데, 사용자가 앱을 닫고 곧바로 PC를 끄면
  // 삭제 단계와 복사 단계 사이에서 설치기가 죽어 앱이 통째로 사라진다(재현 보고 —
  // Claude로 오래 작업한 세션일수록 그 사이 업데이트가 받아져 있어 종료가 곧 발동이었다).
  // 설치는 업데이트 카드의 버튼(quitAndInstall — 스플래시로 진행이 보이는 경로)만 쓰고,
  // 받아둔 파일은 pending 캐시에 남아 다음 실행에서 검증 후 그대로 재사용된다.
  autoUpdater.autoInstallOnAppQuit = false

  if (!wired) {
    wired = true
    autoUpdater.on('checking-for-update', () => {
      if (probing) return // 조용한 재확인 — 받아둔 카드·로그를 건드리지 않는다
      // 확인 사이클마다 로그·이전 오류를 새로 시작 — 주기 재확인으로 로그가 무한히 안 자라게
      state = { ...state, log: [] }
      lastLoggedStep = -1
      set({ phase: 'checking', error: null }, t('업데이트를 확인하는 중…', 'Checking for updates…'))
    })
    autoUpdater.on('update-available', (info) => {
      if (probing) {
        // 받아둔 버전과 같으면(또는 아래면) 침묵 유지 — autoDownload가 pending 캐시를
        // 재검증하고 update-downloaded를 다시 쏘지만 그 역시 아래에서 삼켜진다.
        // 더 새 버전이 올라왔을 때만 일반 흐름으로 복귀해 새로 받는다.
        if (state.version && compareVersionsDesc(info.version, state.version) >= 0) return
        probing = false
        state = { ...state, log: [] }
        lastLoggedStep = -1
      }
      set(
        { phase: 'available', version: info.version },
        t(`새 버전 v${info.version}을(를) 찾았어요 · 다운로드를 시작합니다`, `Found new version v${info.version} · starting download`)
      )
    })
    autoUpdater.on('update-not-available', () => {
      if (probing) {
        probing = false // 받아둔 상태 그대로 — 카드·설치본 불변
        return
      }
      set({ phase: 'none' }, t('이미 최신 버전이에요', 'Already up to date'))
    })
    autoUpdater.on('download-progress', (p) => {
      if (probing) return // 같은 버전 재검증(캐시 소실 시 재다운로드) — 침묵
      const percent = Math.max(0, Math.min(100, Math.round(p.percent)))
      // append a log line only every 5% so the log reads cleanly instead of flooding
      const step = Math.floor(percent / 5)
      const line =
        step !== lastLoggedStep
          ? `${t('다운로드', 'Downloading')} ${percent}% · ${mb(p.transferred)} / ${mb(p.total)} MB`
          : undefined
      if (line) lastLoggedStep = step
      set({ phase: 'downloading', percent }, line)
    })
    autoUpdater.on('update-downloaded', (info) => {
      if (probing) {
        probing = false // 같은 버전 재확인 완료 — 이미 downloaded, 아무것도 안 바뀐다
        return
      }
      set(
        { phase: 'downloaded', version: info.version, percent: 100 },
        t('다운로드 완료 · 업데이트 버튼으로 적용할 수 있어요', 'Download complete · press Update to apply')
      )
    })
    autoUpdater.on('error', (err) => {
      if (probing) {
        probing = false // 받아둔 설치본은 그대로 유효 — 조용히 다음 주기에 재시도
        return
      }
      set({ phase: 'error', error: err?.message ?? String(err) }, t('업데이트 중 오류가 발생했어요', 'Something went wrong while updating'))
    })
  }

  checkForUpdates()

  // 주기 재확인 — 확인 중/내려받는 중에만 쉰다. 받아둔(downloaded) 상태는 조용한
  // 재확인(probing)으로 계속 본다: 같은 버전이면 상태를 일절 건드리지 않아 '나중에'로
  // 접은 카드가 되뜨지 않고, 그 사이 더 새 패치본이 올라왔으면 일반 흐름으로 복귀해
  // 최신을 다시 받는다 — 업데이트 버튼이 낡은 버전을 설치하는 일이 없게.
  if (!recheckTimer) {
    recheckTimer = setInterval(() => {
      if (state.phase === 'checking' || state.phase === 'downloading') return
      probing = state.phase === 'downloaded'
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
  const sub = ver
    ? t(`v${ver} 설치가 끝나면 자동으로 다시 열려요`, `Reopens automatically once v${ver} is installed`)
    : t('설치가 끝나면 자동으로 다시 열려요', 'Reopens automatically once the install finishes')
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
        <Border Width="31" Height="31" CornerRadius="9" Background="#E9E9E9">
          <Viewbox Width="18" Height="18">
            <Canvas Width="24" Height="24">
              <Path Stroke="#161616" StrokeThickness="1.5" StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round"
                    Data="M10 8h4a4.5 4.5 0 0 1 4.5 4.5v1a4.5 4.5 0 0 1 -4.5 4.5h-4a4.5 4.5 0 0 1 -4.5 -4.5v-1a4.5 4.5 0 0 1 4.5 -4.5z M9.5 8Q9 5.8 7.3 4.9 M14.5 8Q15 5.8 16.7 4.9 M4.4 10.6C3 11.5 3 14.5 4.4 15.4 M19.6 10.6C21 11.5 21 14.5 19.6 15.4"/>
              <Path Fill="#161616" Data="M10.2 13m-.95 0a.95 .95 0 1 0 1.9 0a.95 .95 0 1 0 -1.9 0M13.8 13m-.95 0a.95 .95 0 1 0 1.9 0a.95 .95 0 1 0 -1.9 0M7 4.7m-.85 0a.85 .85 0 1 0 1.7 0a.85 .85 0 1 0 -1.7 0M17 4.7m-.85 0a.85 .85 0 1 0 1.7 0a.85 .85 0 1 0 -1.7 0"/>
            </Canvas>
          </Viewbox>
        </Border>
        <StackPanel Margin="12,0,0,0" VerticalAlignment="Center">
          <TextBlock Text="${t('새 버전으로 업데이트하는 중', 'Updating to the new version')}" Foreground="#F2F2F2" FontSize="14" FontWeight="SemiBold" FontFamily="Segoe UI"/>
          <TextBlock Text="${sub}" Foreground="#9A9A9A" FontSize="11.5" Margin="0,3,0,0" FontFamily="Segoe UI"/>
        </StackPanel>
      </StackPanel>
      <ProgressBar IsIndeterminate="True" Height="4" Foreground="#E9E9E9" Background="#2E2E2E" BorderThickness="0"/>
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
  // 주의: cmd 커맨드라인은 8191자 한계 — 현재 EncodedCommand ~7.1k(마스코트 XAML 포함)라
  // 여유가 크지 않다. 수정하면 splash-poc.cjs(poc-update-harness)로 길이를 실측할 것.
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
