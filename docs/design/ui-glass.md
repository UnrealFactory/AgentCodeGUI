# 유리(아크릴) 소실 — 조사 · 방어 · 관측

> M-UI / 3.0.0-beta. 사용자 제보: **"사이드바 유리가 특정 상황에서 갑자기 진한 회색으로 변한다."**
> 이 문서는 ① 그 증상이 무엇인지 픽셀로 확정하고 ② 3.0이 그걸 막는 방법과 실측 수치 ③ 재발 시
> 사용자가 돌릴 관측기 사용법을 적는다. **판정은 다음 크리틱이 한다 — 여기엔 사실만 적는다.**

측정 환경: Windows 11 Home **build 26200** · 단일 모니터 2560×1440 · 데스크톱(배터리 없음) ·
`EnableTransparency=1` · `AdvancedEffectsEnabled=True` · 원격 세션 아님.
(주의: 같은 날 오전 실험 로그에는 **모니터가 2개**였다 — 이 컴퓨터는 실제로 모니터 토폴로지가
바뀐다. 후보 트리거 목록의 §4를 볼 것.)

---

## 0. 왜 사이드바만 회색이 되나 (구조)

`styles.css:7-20`의 토큰 구조가 전부다.

```
--desktop:  #101010;                 /* 재질이 없을 때의 불투명 폴백 */
--panel:    rgba(21,21,21,.70);      /* 사이드바/레일 기조 — 벽지 30% 비침 */
--chat-bg:  rgba(16,16,16,.70);      /* 본문 */
```

사이드바에는 **자체 배경이 없다.** `body`의 `--panel` 틴트가 DWM이 그린 아크릴 위에 얹혀 있을
뿐이다. 그래서 DWM이 아크릴을 안 그리는 순간, 사이드바는 "틴트 + 그 아래 아무것도 없음"이 된다.
그 결과가 무엇인지는 **셸마다 다르다**(§2).

---

## 1. 신호 신뢰도 — 무엇으로 판정할 수 있고 무엇은 거짓말인가

유리가 죽었는지 알아내는 게 조사의 절반이다. 후보 넷을 재 봤다.

| 신호 | 이 컴퓨터에서의 실측 | 쓸 수 있나 |
|---|---|---|
| `DWMWA_SYSTEMBACKDROP_TYPE`(38) 되읽기 | 투명 효과를 껐던 앞선 실험(`docs/critic/glass-lab-electron.json` 09~11번 상태)에서도 **`3` 그대로** | **아니다.** 이건 "우리가 써 넣은 값"이지 "지금 그리고 있나"가 아니다. **드리프트 감지 용도로만** 쓴다 |
| `DwmGetColorizationColor` → `pfOpaqueBlend` | 투명 효과가 **켜져 있는데 `True`** (= 문서상 "불투명 블렌드", 실제와 반대) | **아니다.** 거짓을 돌려준다 |
| `DwmIsCompositionEnabled` | 항상 `True` | 아니다 (Win8+에서 상수) |
| **WinRT `UISettings.AdvancedEffectsEnabled`** | `True` — 설정과 일치 | **그렇다.** 설정 앱 토글 + 배터리 절약 + 원격 세션을 한 값에 반영하는 MS 권장 경로 |

부수 실측: **PowerShell 7에서는 WinRT 투영이 없어 이 타입을 못 찾는다**
(`Unable to find type [Windows.UI.ViewManagement.UISettings...]`, PS 7.6.5). Windows PowerShell
**5.1**에서는 그대로 뜬다 — 그래서 `scripts/poc-glass/glass.ps1`은 반드시 `powershell.exe`로 돈다.

2순위 신호(WinRT가 없을 때): 레지스트리
`HKCU\...\Themes\Personalize\EnableTransparency`. **배터리 절약은 이 값을 안 바꾼다**(런타임 오버라이드)
— 그래서 2순위다.

---

## 2. 재현 — 증상 = 아크릴 소실이 맞다

### 방법: "벽지를 따라가나"를 잰다 (회색 값을 맞히지 않는다)

`scripts/poc-glass/repro.ps1`. 창 뒤에 **원색 3띠 판**(마젠타/시안/흰색)을 깔고, 창을 세 띠 위로
옮기며 사이드바 픽셀을 잰다.

- 아크릴 살아 있음 → 사이드바 색이 **띠를 따라 움직인다**(스윙 큼)
- 아크릴 죽음 → 사이드바가 **어디서나 같은 값**(스윙 0)

폴백 회색이 몇이든, 벽지가 어둡든 밝든 갈린다. **레버는 per-window**
(`DwmSetWindowAttribute(hwnd, 38, v)`) — OS 전역 투명 효과는 사용자 데스크톱이므로 건드리지 않았다.

### 결과

| 셸 | 백드롭 | magenta | cyan | white | 스윙 | 판정 |
|---|---|---|---|---|---|---|
| **2.6.2 셸** (electron-lab, `backgroundMaterial:'acrylic'`) | ACRYLIC(3) | 85,15,62 | 15,60,69 | 58,58,58 | **70** | 유리 살아 있음 |
| 〃 | NONE(1) | 15,15,15 | 15,15,15 | 15,15,15 | **0** | **평탄 단색** |
| 〃 | AUTO(0) | 15,15,15 | 15,15,15 | 15,15,15 | 0 | NONE과 동일 |
| 〃 | MICA(2) | 23,25,26 | 23,25,28 | 23,25,29 | 3 | 사실상 안 비침 |
| **3.0 셸** (tauri, `transparent(true)` + Acrylic) | ACRYLIC(3) | 36,15,29 | 15,29,31 | 21,21,21 | 21 | 유리 살아 있음 |
| 〃 | NONE(1) | 38,15,30 | 15,34,38 | 18,18,18 | **23** | **벽지가 생으로 비침** |
| 〃 | AUTO(0) | 38,15,30 | 15,34,38 | 18,18,18 | 23 | NONE과 동일 |
| 〃 | MICA(2) | 17,18,18 | 17,18,19 | 17,18,19 | 1 | 사실상 안 비침 |

**원본 수치: `docs/design/ui-glass-repro.json`** (이 문서의 모든 표가 거기서 왔다).
PNG는 `docs/design/glass-shots/`에 있지만 그 폴더는 **`.gitignore` 51행에 걸려 커밋되지 않는다** —
`repro.ps1` 재실행으로 다시 만들 수 있다.

### 확정된 것과, 확정 못 한 것

**확정:** 아크릴이 죽으면 2.6.2 셸의 사이드바는 **벽지와 무관한 평탄면 (15,15,15)** 이 된다.
사용자가 말한 "갑자기 진한 회색"의 픽셀이 이것이다 — 색이 바뀌는 게 아니라 **벽지가 사라지고
틴트만 남는다**. 흰 벽지 위에서는 58 → 15로 떨어지므로 변화가 극적이다.

**확정 못 함:** 정확한 회색 값은 **소실 경로마다 다르다.** 내가 쓴 per-window 레버(NONE)는
15,15,15로 떨어졌지만, OS 전역 투명 효과를 껐던 앞선 실험은 40,40,40을 기록했다
(`glass-lab-electron.json` 10번 — 투명 끔 **+ 비활성**). 두 값은 다른 폴백 경로다:
NONE은 백드롭을 없애고(검정 위 틴트), 전역 끔은 백드롭을 **단색으로 그린다**(밝은 회색 위 틴트).
**증상 계열은 같고 값은 다르다** — 방어는 둘 다 덮는다.

### 3.0이 2.6.2보다 나쁜 지점 (리드 판단 필요)

3.0 창은 `transparent(true)`다(`win.rs` b안). 그래서 재질이 죽으면 불투명 회색이 아니라
**벽지가 블러 없이 그대로 비친다**(스윙 23 — 아크릴일 때 21보다 오히려 크다).
글자 뒤로 사진·아이콘이 지나가 **읽을 수 없다.** 2.6.2의 실패(칙칙한 회색)보다 나쁘다.

→ 그래서 3.0에는 **CSS 폴백이 선택이 아니라 필수**다(§3-c).
→ 별건으로, `transparent(true)`가 정말 필요한지는 M1 소관이다. 여기서는 건드리지 않았다.

---

## 3. 방어 — `src-tauri/src/glass.rs`

2.6.2에는 `keepAcrylicWhenBlurred`(blur + 50ms 뒤 `setBackgroundMaterial` 재적용,
`src/main/index.ts:518`)가 있었다. **3.0에는 대응물이 없었다** — `.effects(Acrylic)`은 창을
만들 때 한 번 걸릴 뿐이라, 그 뒤 OS가 합성을 갈아엎으면 아무도 되돌려 주지 않는다.

### (a) 사건 기반 재단언

창마다 `SetWindowSubclass`로 tao의 wndproc에 **체인**을 건다(tauri는 메시지 훅을 안 준다).
잡는 메시지:

| 메시지 | 노리는 사건 |
|---|---|
| `WM_SETTINGCHANGE` · `WM_THEMECHANGED` · `WM_DWMCOLORIZATIONCOLORCHANGED` | 테마 · 투명 효과 · 강조색 변경 |
| `WM_DWMCOMPOSITIONCHANGED` | DWM 합성 재시작(드라이버 리셋 · explorer 재시작) |
| `WM_DISPLAYCHANGE` · `WM_DPICHANGED` | 모니터 추가/제거 · 해상도 · 배율 |
| `WM_WTSSESSION_CHANGE` | 잠금/해제 · 사용자 전환 (`WTSRegisterSessionNotification`으로 구독) |
| `WM_POWERBROADCAST` | 절전/최대 절전 복귀 |
| `WM_ACTIVATE`(WA_INACTIVE) | 비활성 전환 — 2.6.2 `keepAcrylicWhenBlurred`가 잡던 자리 |

서브클래스 프로시저는 **플래그만 세우고 즉시 반환**한다(UI 스레드를 잡지 않는다).
감시 스레드가 깨어나 **60 · 400 · 1200ms 세 박자**로 나눠 단언한다 — 사건 순간에는 OS가 아직
상태를 다 바꾸지 않아 **한 번만 쓰면 그냥 흘러간다**.

### (b) 주기 검증

메시지를 하나도 못 받아도 돌아오게. 두 층으로 나눴다:

- **싼 검사 700ms** — 백드롭 값 읽기/쓰기(로컬 호출 두 번).
- **비싼 검사 4s** — WinRT `UISettings` 활성화 + 레지스트리. 사람이 바꾸는 값이고, 진짜 바뀌면
  `WM_SETTINGCHANGE`가 먼저 온다.

### (c) 못 살릴 때 = 렌더러 폴백

`glass_possible()`이 거짓이면(전역 효과 꺼짐 · 원격 세션) 셸이 `ui-glass:state`를 쏜다.
심(`app/src/api/glassFallback.ts`)이 `<html>`에 `ccg-glass-off`를 걸고, 주입한 `<style>`이
`--panel`/`--chat-bg`를 **불투명 값**으로 덮는다(`#1d1d1d` / `#141414` — 사이드바가 본문보다
밝은 위계를 아크릴 때와 같은 순서로 유지). 아크릴의 광량 낙차를 흉내 낸 아주 옅은 좌상단
그라디언트를 얹어 **의도된 다크 배경**으로 보이게 한다.

- `styles.css`는 **한 글자도 안 고친다**(클래스 주입 방식). 장부: `docs/renderer-divergence.md` §2·**§3.6**.
- `!important`가 필요한 이유: 설정 › Display '벽지 비침' 슬라이더가 `--panel`/`--chat-bg`를
  **documentElement 인라인**으로 덮는다(`lib/glass.ts`). 인라인은 어떤 셀렉터보다 세다 —
  없으면 유리가 죽었는데 사용자가 비침 100으로 둔 창은 벽지가 **더** 비치는 최악이 된다.
- 채널을 `ipc.rs`에 등록하지 않는다: 단방향 브로드캐스트라 `dispatch()` 항목이 필요 없다
  (M2가 분할 중인 파일을 안 건드린다). 기존 `ui-glass:changed`(사용자 슬라이더)와 **다른 채널**이다.

### 실측 — 방어가 실제로 도는가

`glass.ps1 -Action knock`: 백드롭을 **밖에서 걷어차고** 앱이 스스로 3으로 되돌리는 시간을 잰다.
릴리즈 빌드(`npm run tauri:build`), 격리 홈(`CCG_HOME=.glass-home-tauri`), 8회씩.

| 경로 | 복구 | 최소 | 최대 | 평균 |
|---|---|---|---|---|
| **조용한 드리프트**(메시지 없이 값만 바뀜) — 폴링만 | **8/8** | 309ms | 637ms | **359ms** |
| **메시지 경로**(`WM_SETTINGCHANGE`를 그 창에만 전송) | **8/8** | 61ms | 95ms | **72ms** |

실제 트리거(테마·세션·모니터·절전)는 전부 메시지를 동반하므로 **72ms 쪽**이 현실 경로다.
폴링은 "메시지를 놓쳤을 때"의 바닥이다.

**측정 중 잡은 것 둘 (둘 다 실측이 없었으면 못 봤다):**

1. **조건변수 신호 유실.** 감시 스레드가 대기 중이 아닐 때(직전 사건의 단언 슬립 중) 온
   `notify_all`은 사라지고 플래그만 남는다 → 그 사건이 700ms 늦게 처리됐다(넛지 8회 중 1회가
   73ms가 아니라 693ms). 대기 전에 플래그를 먼저 보게 고쳤다.
2. **측정 자체의 함정.** 시행 간격을 900ms로 뒀더니 다음 시행이 **앞 시행의 단언 열차**
   (60+400+1200 = 1660ms) 안에 떨어져, 앱 반응 속도가 아니라 열차 잔여 시간이 찍혔다
   (76ms → 750ms로 보였다). `-GapMs` 기본값을 2500ms로 올렸다.

### 실측 — 폴백이 실제로 켜지는가

전역 투명 효과를 끌 수 없으므로(사용자 데스크톱) 테스트 레버를 뒀다:
`CCG_GLASS_FORCE_OFF=1`. 기본값에서는 아무 일도 안 한다.

```
CCG_HOME=.glass-home-tauri CCG_GLASS_FORCE_OFF=1 ./target/release/agentcodegui.exe
```

3띠 판 위에서 잰 결과: 백드롭은 여전히 3(단언은 정상)인데 사이드바가
**(20,20,20) · 세 띠 전부 동일 · 스윙 0** — 벽지가 완전히 차단됐다.
(폴백 전 같은 창은 스윙 21~23이었다.) 스크린샷: `docs/design/glass-shots/tauri-30-fallback-on.png`
(gitignore 대상 — 재생성 가능).

---

## 4. 트리거 — 확정 / 미확정

### 확정 (이 조사에서 직접 재현)

| # | 트리거 | 증거 |
|---|---|---|
| C1 | 창의 백드롭 속성이 3이 아닌 값으로 바뀜 | `repro.ps1` — 스윙 70→0(electron) / 벽지 생비침(tauri). 3.0은 359ms(폴링)·72ms(메시지)에 복구 |

### 강한 정황 (앞선 실험 기록 · 재현은 못 함 — OS 전역 설정 금지)

| # | 트리거 | 증거 | 왜 미확정인가 |
|---|---|---|---|
| P1 | **설정 › 개인 설정 › 색 › 투명 효과 = 끔** | `glass-lab-electron.json` 10번: 사이드바 40,40,40(완전 무채색·평탄) | 같은 실행의 09번(끔 + 활성)은 **안 변했다** — 설정 전파 타이밍이 섞여 인과가 깨끗하지 않다 |
| P2 | **비활성(blur) 전환** | 2.6.2가 이미 `keepAcrylicWhenBlurred`로 막고 있다(그 주석의 실측: "흰 배경·글래스100에서 사이드바 81→51로 꺼지던 것") | 3.0에서 blur만으로 재현하지 못했다. 방어에는 포함했다 |

### 미확정 — 이 기계·이 규약에서 만들 수 없었던 것

| # | 트리거 | 왜 못 쟀나 | 방어에 포함? |
|---|---|---|---|
| U1 | 배터리 절약 | **데스크톱이라 배터리가 없다**(`Win32_Battery` 0개) | 예 — `AdvancedEffectsEnabled`가 반영한다 |
| U2 | Win11 24H2+ 데스크톱 **에너지 세이버** | OS 전역 토글 = 금지 | 예 — 같은 신호 |
| U3 | 원격 데스크톱 세션 | 세션을 만들 수 없다 | 예 — `SM_REMOTESESSION` |
| U4 | **잠금/해제 · 사용자 전환** | 사용자 PC를 잠글 수 없다 | 예 — `WM_WTSSESSION_CHANGE` |
| U5 | **절전/최대 절전 복귀** | 사용자 PC를 재울 수 없다 | 예 — `WM_POWERBROADCAST` |
| U6 | **모니터 추가/제거** | 케이블을 뽑을 수 없다. **단, 이 컴퓨터는 오늘 실제로 2→1로 바뀌었다** (오전 로그의 rect가 x=2680, 지금은 단일 2560×1440) — 후보로 가장 유력한 축 | 예 — `WM_DISPLAYCHANGE` |
| U7 | GPU 드라이버 리셋(TDR) · explorer 재시작 · DWM 재시작 | 유발하면 사용자 세션이 흔들린다 | 예 — `WM_DWMCOMPOSITIONCHANGED` |
| U8 | 전체 화면 독점 앱(게임) 실행 중 | 사용자 화면을 뺏는다 | **아니오** — 이때는 창이 안 보이므로 복귀 시 U7/U6 경로로 덮인다고 **가정**했다. 검증 안 됨 |
| U9 | 다른 앱이 우리 창에 `SetWindowCompositionAttribute` 등을 건다 | 유발 대상이 없다 | 예 — C1과 같은 경로(드리프트 감지) |

**정직한 요약:** 사용자가 실제로 밟은 트리거가 무엇인지는 **아직 모른다.** 확정한 것은
"증상 = 아크릴 소실"이라는 **증상의 정체**와, 소실이 어떤 경로로 오든 3.0이 **72~359ms 안에
되돌리거나, 못 되돌리면 의도된 불투명 배경으로 갈아탄다**는 것이다. 트리거를 특정하려면
재발 순간의 로그가 필요하다 — 그게 §5다.

---

## 5. 관측기 — 재발하면 이걸 돌린다

증상이 다시 나면, **그 순간의 창 상태 + OS 상태**를 같은 줄에 남긴다.

```bash
# 1) 증상이 난 창의 PID를 찾는다 (작업 관리자 또는)
powershell -NoProfile -Command "Get-Process AgentCodeGUI,agentcodegui | Where-Object MainWindowTitle | Select Id,MainWindowTitle"

# 2) 관측 시작 — 읽기 전용. 아무것도 바꾸지 않는다.
powershell -NoProfile -File scripts/poc-glass/glass.ps1 `
  -Action observe -TargetPid <PID> -Seconds 28800 -IntervalMs 1000 `
  -Out docs/critic/glass-observe.jsonl
```

- **반드시 `powershell.exe`(5.1)** — `pwsh`(7)에는 WinRT가 없어 진실 소스를 못 읽는다.
- **변화가 있을 때만** 한 줄 쓴다(+60초 하트비트). 8시간 돌려도 파일이 작다.
- 각 줄의 `flags`:
  - `attr-lost` — 백드롭 값이 3이 아니게 됐다(누가 되돌렸다)
  - `render-lost` — 값은 3인데 화면이 평탄 단색이다(DWM이 안 그린다)
  - `effects-off` — 전역 투명 효과가 꺼졌다
- 같이 찍히는 것: 포커스/최대화/최소화/cloaked/rect · `advancedEffects` · `regTransparency` ·
  `dwmComposition` · `remoteSession` · `powerSaver` · **모니터 수** · 포그라운드 프로세스 이름.

**픽셀 판정의 한계(중요):** `flat` 플래그는 사이드바 세로 띠의 표준편차와 채도로 판정한다.
**벽지가 균일한 단색이면 아크릴이 살아 있어도 `flat=true`가 뜬다** — 이 컴퓨터의 바탕에서
실제로 그랬다(아크릴 정상인데 `stdev=0, chroma=1`). 그러니 `flat`은 보조 신호로만 읽고,
`advancedEffects`와 `backdrop`을 먼저 본다.

### 그 밖의 액션

```bash
# 지금 상태 한 줄 (창 + OS + 픽셀)
powershell -NoProfile -File scripts/poc-glass/glass.ps1 -Action read -TargetPid <PID>

# OS 레벨 화면 캡처 (CDP/PrintWindow는 DWM 합성 결과를 못 담는다)
powershell -NoProfile -File scripts/poc-glass/glass.ps1 -Action shot -TargetPid <PID> -Out out.png

# 방어 실측 — 걷어차고 복구 시간 재기
powershell -NoProfile -File scripts/poc-glass/glass.ps1 -Action knock -TargetPid <PID> -Backdrop 1 -Seconds 8
powershell -NoProfile -File scripts/poc-glass/glass.ps1 -Action knock -TargetPid <PID> -Backdrop 1 -Seconds 8 -Nudge

# 이 창 하나의 백드롭을 강제로 바꾼다(되돌리려면 -Backdrop 3)
powershell -NoProfile -File scripts/poc-glass/glass.ps1 -Action force -TargetPid <PID> -Backdrop 1

# 3띠 판 위에서 백드롭 A/B (증상 재현)
powershell -NoProfile -File scripts/poc-glass/repro.ps1 -TargetPid <PID> -Prefix myrun -OutDir docs/design/glass-shots
```

**이 도구들이 지키는 안전 규약:** OS 전역 설정을 바꾸지 않는다(투명 효과 토글·전원 계획·디스플레이
설정 없음). `force`/`knock`/`repro`는 **지정한 hwnd 하나**의 DWM 속성만 만지고 끝나면 되돌린다.
`observe`/`read`/`shot`은 완전 읽기 전용. 어떤 프로세스도 죽이지 않는다.

> 앞선 실험대 스크립트 `scripts/poc-glass/lab.ps1`은 **OS 투명 효과를 토글한다**(§7 절).
> 사용자 데스크톱에서는 반드시 `-SkipTransparencyToggle`을 붙여 돌릴 것.

---

## 6. 파일

| 경로 | 무엇 |
|---|---|
| `src-tauri/src/glass.rs` | 방어 본체 — 재단언 · 서브클래스 · 감시 스레드 · 폴백 통지 |
| `src-tauri/src/win.rs` | 훅 3곳: `glass::arm()`(메인/추가 채팅 창) · `glass::clear()`(크래시 복구) + 모듈 매달기 |
| `src-tauri/Cargo.toml` | `windows` 피처 5개 추가(Dwm · Shell · RemoteDesktop · Registry · UI_ViewManagement) |
| `app/src/api/glassFallback.ts` | 렌더러 폴백 수신 — 클래스 주입 |
| `app/src/api/shim.ts` | `initGlassFallback()` 호출 1줄 |
| `scripts/poc-glass/glass.ps1` | 관측·강제·캡처·복구시간 측정 (PS 5.1) |
| `scripts/poc-glass/repro.ps1` | 3띠 판 위 백드롭 A/B (PS 5.1) |
| `docs/design/ui-glass-repro.json` | **실측 원본**(신호 신뢰도 · 재현 표 · 방어 수치 · 목업 밀도) — 판정은 이 파일로 |
| `docs/design/glass-shots/` | 재현·폴백 스크린샷 (**gitignore 대상** — `repro.ps1`로 재생성) |
