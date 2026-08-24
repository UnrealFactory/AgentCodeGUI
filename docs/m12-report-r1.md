# M12 R1 — 설치본을 만든다: 656MB → 6.0MB, 그리고 하마터면 사용자의 2.6.2를 죽일 뻔했다

라운드 R26 · 2026-08-24 · 브랜치 `feature/3.0.0-beta` · 기준 커밋 `076bf8c`

3.0은 M1 R1(§7-9)에서 `bundle.active:false`로 못을 박은 뒤 지금까지 **exe 한 개**만 만들어
왔다. 벤치도 하네스도 전부 `target/release/agentcodegui.exe`를 직접 띄웠다. 이 라운드는
그 exe를 **설치본**으로 감싸고, 설치·실행·제거를 실제로 돌려 숫자를 남긴다.

자기 채점은 하지 않는다. 무엇을 켰고, 무엇이 관측됐고, 무엇이 아직 없는지의 기록이다.

**측정 조건**: 이 세션 내내 다른 두 라운드가 같은 워크스페이스를 컴파일하고 있었고,
사용자의 2.6.2 설치본이 5개 프로세스로 떠 있었다. 그래서 (a) 빌드는 **격리
`CARGO_TARGET_DIR`**(`C:\Code\ccg-m12-target`)로 돌렸고 — 공용 `target/release/agentcodegui.exe`가
다른 라운드의 실행으로 잠겨 있었다(`EBUSY` 실측) —, (b) 시간 값은 그 부하 위에서 잰
것이며, (c) 사용자 실앱은 **한 번도 죽이지 않았다**(아래 §5가 그걸 어떻게 지켰는지의
기록이고, 지키지 않았으면 어떻게 됐을지의 기록이기도 하다).

---

## 0. 한 문단 요약

NSIS를 켰다(MSI는 **버전 문자열 때문에 실측으로 탈락** — §2). 설치본
`AgentCodeGUI3_3.0.0-beta.1_x64-setup.exe`는 **2.38 MB**(2.6.2: 157.5 MB · 0.0151배),
설치 후 디스크는 **6.0 MB**(2.6.2: 633.7 MB 논리 / 656.2 MB 할당 · 0.0095배) —
**627.7 MB가 사라졌고 파일 수는 8,141 → 2개**다. 사용자가 든 지표(650MB)의 정체는
할당 크기 656.2 MB였고, 그 자리에 6.0 MB가 앉았다. 게이트인 `poc-live-chat`을
**설치본 exe로** 8단계 전부 돌려 **PASS(결함 0)** — 실 CLI 1턴이 스트리밍되고 승인 카드가
뜨고 파일이 실제로 생겼다(`docs/critic/m3-r4-live-m12r1c.json`). 콜드 스타트는
설치본 **paint 290ms**로 빌드 디렉터리 exe(307ms)와 사실상 같다 — 설치가 비용을 더하지
않는다. 제거는 앱 홈을 **한 항목도** 건드리지 않았고 2.6.2의 설치·레지스트리·우클릭
메뉴·프로세스 5개가 전부 그대로였다. 같은 앱 홈 공유는 **복사본 홈**으로 확인했다:
계정 6개가 그대로 보이고(복호화 실패 문구 없음) 2.6.2가 쓴 대화 **646 메시지**가
마이그레이션돼 화면에 떴다.

그리고 이 라운드에서 가장 중요한 것은 숫자가 아니라 **막은 사고** 하나다: 기본 설정대로
구우면 설치 프로그램이 **사용자의 실행 중인 2.6.2(`AgentCodeGUI.exe`)를 죽인다.**
Tauri NSIS가 `MAINBINARYNAME.exe`와 같은 이름의 프로세스를 무인 모드에서 조용히 죽이는데,
그 매칭이 **대소문자 구분이 없다**는 걸 실측했다(§5). 설치도 하기 전에 잡았다.

---

## 1. 켠 것 — `tauri.conf.json` 한 덩어리

```jsonc
"mainBinaryName": "AgentCodeGUI3",        // ★ §5 — 안 넣으면 사용자의 2.6.2를 죽인다
"bundle": {
  "active": true,
  "targets": ["nsis"],
  "icon": ["../build/icon.ico"],          // 2.6.2와 같은 마크(scripts/gen-icon.cjs 산출물)
  "publisher": "AgentCodeGUI",
  "homepage": "https://github.com/UnrealFactory/AgentCodeGUI",
  "copyright": "Copyright (c) 2026 AgentCodeGUI",
  "category": "DeveloperTool",
  "shortDescription": "…", "longDescription": "…",
  "windows": {
    "webviewInstallMode": { "type": "downloadBootstrapper", "silent": true },
    "nsis": {
      "installMode": "currentUser",       // 2.6.2와 같은 per-user(관리자 권한·UAC 없음)
      "installerIcon": "../build/icon.ico",
      "headerImage": "../build/installerHeader.bmp",   // 150×57  (실측 확인)
      "sidebarImage": "../build/installerSidebar.bmp", // 164×314 (실측 확인)
      "languages": ["Korean", "English"],
      "displayLanguageSelector": false,
      "compression": "lzma"
    }
  }
}
```

**설치 자산은 새로 만들지 않았다.** 2.6.2가 쓰던 `build/icon.ico`·`installerHeader.bmp`·
`installerSidebar.bmp`를 그대로 물려받는다 — 두 BMP의 실제 픽셀 크기가 MUI2 규격
(150×57 / 164×314)과 정확히 일치해 Tauri NSIS에서도 그대로 쓰인다(바이트를 읽어 확인).

생성된 설치 스크립트(`<target>/release/nsis/x64/installer.nsi`)가 확정한 값들:

| 항목 | 값 |
|---|---|
| 설치 경로 | `%LOCALAPPDATA%\AgentCodeGUI3` (per-user · UAC 없음) |
| 실행 파일 | `AgentCodeGUI3.exe` (6,202,880 B) + `uninstall.exe` (82,436 B) |
| 바로가기 | 시작 메뉴 `AgentCodeGUI3.lnk` · 바탕화면 `AgentCodeGUI3.lnk` (둘 다 무인 설치에서도 생성 확인) |
| 언인스톨 키 | `HKCU\…\Uninstall\AgentCodeGUI3` (2.6.2는 GUID 키 `f2fb66d4-…` — **충돌 없음**) |
| 설치 위치 기억 | `HKCU\Software\AgentCodeGUI\AgentCodeGUI3` |
| 버전 | `VERSION 3.0.0-beta.1` · `VIProductVersion 3.0.0.0` (프리릴리즈를 알아서 접는다) |
| exe 버전 리소스 | FileDescription/ProductName `AgentCodeGUI3` · FileVersion `3.0.0-beta.1` · Company `AgentCodeGUI` |
| WebView2 | `downloadBootstrapper /silent` — 이미 깔려 있으면 **건너뛴다**(이 기계: `pv 151.0.4129.101` 확인) |
| 파일 연결·딥링크 | **없음**(스크립트의 해당 절이 비어 있다 — §5.3) |

`package.json` 스크립트도 손봤다:

```
"tauri:build": "tauri build && npm run tauri:compat-exe",
"tauri:bundle": "tauri bundle",
"tauri:compat-exe": "<AgentCodeGUI3.exe를 agentcodegui.exe로 복사>"
```

`tauri:compat-exe`의 존재 이유는 §5.2에 있다(한 줄 요약: `mainBinaryName`을 넣으면
tauri CLI가 산출물을 **rename** 해서 `target/release/agentcodegui.exe`가 사라지고,
그 경로를 기본값으로 박아 둔 `bench/lib.mjs`·`scripts/poc-live-chat.mjs`가 동시에 깨진다).

---

## 2. NSIS냐 MSI냐 — 실측으로 갈렸다

둘 다 구워 봤다(툴체인은 `%LOCALAPPDATA%\tauri\{NSIS,WixTools314}`에 이미 받아져 있었다).

| | NSIS | MSI(WiX v3) |
|---|---|---|
| **우리 버전(`3.0.0-beta.1`)로 빌드** | 성공 | **실패** |
| 실패 메시지 | — | `optional pre-release identifier in app version must be numeric-only and cannot be greater than 65535 for msi target` |
| 크기(버전을 `3.0.0`으로 강제해 비교) | **2,492,395 B** | 3,272,704 B (+31%) |
| 설치 모드 | per-user(UAC 없음) | 기본 perMachine(UAC) |
| 2.6.2와의 계열 | 같다(electron-builder NSIS) | 다르다 |

**결론: NSIS.** MSI는 "조금 크다"가 아니라 **우리 버전 문자열로는 아예 빌드가 안 된다** —
쓰려면 `3.0.0-beta.1`을 버리고 `3.0.0-1` 같은 숫자 프리릴리즈로 바꾸거나 WiX 전용 버전
오버라이드를 둬야 한다. 베타 라벨을 버릴 이유가 없다. per-user·무UAC·2.6.2와 같은 계열이라
사용자 경험도 그대로다.

---

## 3. 풋프린트 — `bench/footprint.mjs`(신설) · `bench/results/footprint.json`

하네스로 만든 이유: 인수인계 문서의 기준 "650MB"에 **어떻게 잰 650인지**가 없다.
탐색기 속성창(할당)·`du`(논리)·「앱 및 기능」(설치 프로그램이 레지스트리에 **써 넣은**
값)이 전부 다른 수를 준다. 그래서 셋을 **같은 코드로 두 앱에** 돌려 한 파일에 남긴다.
정션/심볼릭은 따라가지 않고(앱 홈에 엔진 정션이 있다) 개수만 센다.

| 지표 | 2.6.2 (Electron) | 3.0.0-beta.1 (Tauri) | 비 |
|---|---:|---:|---:|
| 설치본 파일 | 165,119,775 B (157.5 MB) | **2,492,395 B (2.38 MB)** | **0.0151** (66배 작다) |
| 설치 폴더 · 논리 | 664,461,448 B (633.7 MB) | **6,285,316 B (5.99 MB)** | **0.0095** (106배) |
| 설치 폴더 · 할당(4K) | 688,041,984 B (656.2 MB) | 6,291,456 B (6.0 MB) | 0.0091 |
| 「앱 및 기능」 EstimatedSize | 648,712 KB (633.5 MB) | 6,137 KB (6.0 MB) | 0.0095 |
| 파일 수 / 폴더 수 | 8,141 / 1,184 | **2 / 0** | — |

**절감 627.7 MB.** 사용자가 말한 650은 할당 크기(656.2 MB)와 「앱 및 기능」 표시값
(633.5 MB) 사이의 값이고, 어느 쪽으로 재도 3.0은 **6.0 MB**다.

2.6.2의 633.7 MB가 어디였는지도 같이 남긴다: `resources/` 287.5 MB · `AgentCodeGUI.exe`
213.6 MB · `locales/` 47.2 MB · `dxcompiler.dll` 24.5 MB · `LICENSES.chromium.html` 19.4 MB ·
`icudtl.dat` 10.4 MB. 즉 **Chromium 한 벌을 앱 폴더에 통째로 넣었던 값**이다.

### 정직한 상한 — WebView2 런타임을 3.0 몫으로 쳐도

3.0은 Chromium을 넣지 않고 **OS의 WebView2 런타임**을 빌려 쓴다. 그 런타임은 이 기계에
`151.0.4129.{86,93,101}` 세 판이 깔려 있고 최신 판 하나가 **853.0 MB**다(Edge와 공유하는
OS 구성요소 · Win10/11에 기본 탑재 · WebView2 앱이면 전부 같은 걸 쓴다). **전부를 3.0
몫으로 계산하면 2.6.2 대비 1.356배**가 된다. 이 수를 `footprint.json`의
`compare.tauriPlusRuntimeRatio`에 그대로 박아 뒀다 — 숨기면 거짓말이고, 그렇다고 앱
설치 크기에 더하는 것도 사실이 아니다(2.6.2를 쓰는 지금 이 기계에도 이미 깔려 있다).
판단은 읽는 사람 몫으로 남긴다.

앱 홈(`~/.agentcodegui`, 7.5 GB)은 **어느 쪽 몫도 아니다** — 두 앱이 공유한다(§4).

---

## 4. 게이트 — 설치본으로 돌린 실증

### 4.1 `poc-live-chat` 8단계 PASS (결함 0)

```
node scripts/poc-live-chat.mjs --tag=m12r1c \
     --exe=C:\Users\User\AppData\Local\AgentCodeGUI3\AgentCodeGUI3.exe
→ 판정: PASS · 결함 0건 · docs/critic/m3-r4-live-m12r1c.json
```

R8-1 브로드캐스트 · 폴백 확인 카드 · 추가 채팅 창 영속 · EngineEvent 9종 · error 말풍선 ·
부팅 재장전/한도 이어서 · `win:chat-*` 4채널 · **실 CLI 1턴**까지 전부. 라이브 턴은
스트리밍(`deltas 1`) → 승인 카드(`Write live-approve.txt`) → 승인 → **파일이 디스크에
생김**(6,438 ms) → 재시작 후 대화 4건·세션 유지가 관측됐다.

**첫 주행은 FAIL이었고, 원인은 패키징이 아니었다.** 하네스는 실홈의
`accounts.defaultEmail`(`lmg56634@gmail.com`)로 도는데 그 계정이 **주간 한도 100%**였다
(`usage-cache.json` 확인). 앱은 그 상황을 정확히 보고했다 — `model-fallback`+`notice`
이벤트, hold 등록, 결과 말풍선 `You've hit your weekly limit · resets Aug 26, 11pm`
(`docs/critic/m3-r4-live-m12r1.json`). 즉 **7/8단계는 그 주행에서 이미 초록**이었고,
라이브 턴만 계정 사정으로 못 돌았다.

여유 있는 계정(`lmg56632@gmail.com` · 주간 15%)으로 다시 돌리기 위해 **하네스는 한 줄도
고치지 않았다.** 대신 `os.homedir()`만 갈아 끼우는 프리로드
(`bench/scratch/m12-homedir-shim.cjs`)로 하네스가 읽는 "실홈"을 **복사본 스테이징**으로
돌렸다(실홈은 읽기만 · 자격증명은 복사 · 엔진은 정션). 그 조합에서 8/8 PASS.

> **함정 하나 기록**: 처음엔 `USERPROFILE` 환경변수를 바꿨는데, 그러면 **WebView2가
> `--remote-debugging-port`를 열지 않는다.** 같은 exe·같은 `CCG_HOME`으로 A/B —
> `USERPROFILE`만 바꾸면 CDP가 `ECONNREFUSED`, 원래대로면 정상. CDP로 붙는 하네스는
> 전부 이 함정을 밟는다. 그래서 환경변수가 아니라 노드 프로세스의 `os.homedir()`만 바꾼다.

### 4.2 같은 앱 홈 공유 — **복사본 홈**으로 확인

`bench/scratch/m12-sharedhome.mjs` · `bench/results/m12-sharedhome.json`.
실홈의 루트 파일 14개 + `chats/`·`session-chats/`·`multi-agent/`·`accounts/`를 **복사**해
(무거운 `engines`·`lsp`·`shared`는 제외) 설치본을 그 홈으로 띄웠다. 실홈은 읽기만 했다.

- 계정 **6개 전부** 앱의 IPC(`auth.listAccounts`)로 보인다. 화면에 복호화 실패 문구 없음.
  → OSCrypt 키는 앱 홈이 아니라 `%APPDATA%\agent-code-gui\Local State`(2.6.2 userData)로
  **폴백**해서 읽는다(`ccg-store/src/safe_storage.rs:100-107`). 나란히 깔아도 **재로그인이
  필요 없다**는 뜻이고, 그 폴백을 타는 상태 그대로 재현하려고 `Local State`는 일부러
  복사하지 않았다.
- 부팅 마이그레이션 집계: `chats 1 · maSessions 1 · maPanels 4 · total 5 · messages 646 ·
  boards 2`. 즉 2.6.2가 쓴 대화가 통째로 넘어와 화면에 떴다(본문 텍스트 94,960자).

> 여기서 하나 배웠다: 이 홈에서는 좌측 `.sidebar` 목록이 **비어 있다**(통합 채팅의 보드
> 구성 때문). 그걸 "채팅이 없다"로 읽으면 오진이다 — 판정을 선택자 하나에 걸지 말고
> 마이그레이션 집계와 본문 분량으로 봐야 한다.

### 4.3 콜드 스타트 — 설치본으로 재측정

`bench/scratch/m12-coldstart.mjs`(=`bench/coldstart.mjs`와 같은 방법: 같은 픽스처 홈 시드 ·
6회 · 첫 회 웜업 제외 · 중앙값).

| | winMs | **paintMs**(대표) | rootMs | exe |
|---|---:|---:|---:|---|
| 2.6.2 (r4 기준) | 381 | 584 | 425 | 223.9 MB |
| 3.0 r4 기준(`target/release`) | 241 | 279 | 350 | 3.8 MB · `2ced4fa` |
| **3.0 설치본** | 269 | **290** | 373 | 6.2 MB · `076bf8c` |
| 3.0 빌드 디렉터리(같은 비트) | 270 | 307 | 364 | 6.2 MB · `076bf8c` |

**설치가 시작 시간을 더하지 않는다** — 같은 비트를 설치 경로/빌드 경로에서 각각 재면
290 vs 307ms로 회차 산포 안이다. 2.6.2 대비 paint **0.50배**(290/584).

r4 기준(279ms)보다 11ms 느린데, 이 표로는 **회귀라고 말할 수 없다**: exe가 3.8→6.2 MB로
커졌고(그 사이 M5~M11이 들어갔다) 측정 내내 다른 라운드 두 개가 같은 기계에서 컴파일과
벤치를 돌렸다. 조용한 기계에서 다시 재야 판정이 된다.

### 4.4 제거가 사용자 데이터를 지우지 않는가 — PASS

`bench/scratch/m12-uninstall.mjs` · `bench/results/m12-uninstall.json`.
`uninstall.exe /S` → 확인 → 재설치까지 한 주행.

- 앱 홈 최상위 **24개 항목 전부 그대로**, `accounts.json`·`ui-prefs.json`·`chats`·
  `multi-agent`·`session-chats`·`engines` 존재, `accounts.json` 크기 불변(10,324 B).
- 설치 폴더 삭제 · 바로가기 2개 삭제 · `HKCU\…\Uninstall\AgentCodeGUI3` 삭제.
- **2.6.2는 전부 무사**: 설치 폴더 · 언인스톨 키 · 시작메뉴 바로가기 ·
  우클릭 메뉴(`HKCU\Software\Classes\Directory\shell\AgentCodeGUI`) · 프로세스 5개(PID 동일).
- 재설치 성공(같은 두 파일), 그 과정에서도 2.6.2 PID 5개 불변.

코드 근거도 같이 남긴다: 제거기가 "앱 데이터 삭제"를 체크했을 때조차 지우는 것은
`%APPDATA%\com.agentcodegui.app`와 `%LOCALAPPDATA%\com.agentcodegui.app`뿐이다
(생성된 `installer.nsi:822-837`). 우리 데이터는 `%USERPROFILE%\.agentcodegui`라
**그 목록에 아예 없다.** 무인 모드에서는 체크박스가 뜨지도 않아 기본값 0으로 지나간다.

---

## 5. 나란히 설치 — 충돌 세 곳

### 5.1 ★ 이름 기반 프로세스 죽이기 — 기본값대로면 사용자의 2.6.2가 죽는다

Tauri NSIS의 설치·제거 섹션은 시작하자마자 `CheckIfAppIsRunning "${MAINBINARYNAME}.exe"`를
부르고, **무인(`/S`) 모드에서는 확인 없이 곧장 `KillProcessCurrentUser`** 로 간다
(`installer.nsi:637,754` · `utils.nsh:22-67`).

`MAINBINARYNAME`의 기본값은 **cargo 바이너리 이름 `agentcodegui`** 다. 그리고 사용자의
2.6.2 프로세스 이름은 `AgentCodeGUI.exe`다. 대소문자만 다르다.

그래서 **매칭이 대소문자를 구분하는지**를 남의 프로세스가 아니라 **내가 띄운 프로세스로**
갈랐다(`bench/scratch/m12probe/`): `node.exe`를 `CcgCaseProbe.exe`로 복사해 띄우고,
`nsis_tauri_utils::FindProcessCurrentUser`(찾기만 하고 죽이지 않는 함수)를 세 가지 표기로 호출.

```
exact=0  lower=0  upper=0        (0 = 찾음)
CcgCaseProbe.exe / ccgcaseprobe.exe / CCGCASEPROBE.exe → 전부 같은 프로세스를 찾는다
```

**대소문자 무시다.** 즉 `MAINBINARYNAME=agentcodegui`인 설치본을 `/S`로 돌렸다면 사용자의
`AgentCodeGUI.exe` 5개가 조용히 죽었다. 대화 중이었다면 그대로 날아간다.

**대응**: `mainBinaryName: "AgentCodeGUI3"`. 그러면 설치기가 찾는 이름이 `AgentCodeGUI3.exe`가
되어 2.6.2와 **문자열이 다르다**. 설치 전후로 실측 확인 — 2.6.2 PID
`6644,12924,23792,24836,26924`가 설치·제거·재설치를 통과해 **하나도 안 바뀌었다**.

> 이건 개발 환경만의 문제가 아니다. 실사용자도 2.6.2와 3.0을 나란히 깔면 같은 일을 당한다.
> 그리고 "설치 중 실행 중인 앱을 닫는다"는 동작 자체는 **옳다** — 닫아야 할 대상이
> 자기 자신뿐이어야 할 뿐이다.

### 5.2 `mainBinaryName`의 대가 — `target/release/agentcodegui.exe`가 사라진다

`tauri build`는 `mainBinaryName`이 있으면 산출물을 **rename** 한다(복사가 아니다 — 실측:
빌드 후 `AgentCodeGUI3.exe` 하나만 남는다). 그런데 `bench/lib.mjs`의 `tauriProfile`과
`scripts/poc-live-chat.mjs`의 기본 `EXE`가 **둘 다 `target/release/agentcodegui.exe`를
하드코딩**한다. 지금 이 레포에서는 다른 라운드 둘이 그 경로로 벤치를 돌리고 있다.

그래서 `tauri:build` 끝에 **호환 복사** 한 줄을 붙였다(`tauri:compat-exe`). 6 MB를 한 번 더
쓰는 대신 기존 하네스 기본값이 안 깨진다. 사용 중이면 조용히 건너뛴다(EBUSY 허용).

**이건 임시 조치다.** 다음 라운드의 결정 항목: 하네스 기본 경로를 `AgentCodeGUI3.exe`로
옮기고 이 복사를 지울지, 아니면 `src-tauri/Cargo.toml`의 `[[bin]] name`을 바꿔 rename 자체를
없앨지. 둘 다 이 라운드의 경계(=`bench/lib.mjs`·`Cargo.toml`) 밖이라 손대지 않았다.

### 5.3 단일 인스턴스 락 · 트레이 · 파일 연결

**단일 인스턴스 락** — `bench/scratch/m12-instlock.mjs` · `bench/results/m12-instlock.json` · PASS.

| 확인 | 결과 |
|---|---|
| 같은 앱 홈으로 3.0 두 번 | 두 번째가 **1,702 ms에 exit 0**, 프로세스는 1개 유지, `.instance-lock` 존재 |
| 홈이 다르면 | 둘 다 산다(프로세스 2개) — 벤치·dev가 나란히 도는 성질 유지 |
| 그동안 2.6.2 | PID 5개 불변 |

기전이 애초에 겹치지 않는다: 3.0은 **앱 홈 안의 `.instance-lock`** 을 공유 금지로 열어
잡고(`src-tauri/src/main.rs:18-37`), 2.6.2는 Electron이 **userData의 `lockfile`**
(`%APPDATA%\agent-code-gui\lockfile`, 실물 확인)로 잡는다. 경로도 방식도 달라서 서로를
모른다. 두 번째 인스턴스가 앞 창을 올리는 브로드캐스트도 **앱 홈 해시를 이름에 넣은**
등록 메시지라(`tray.rs:555-563`) 남의 앱에 안 닿는다.

**트레이 아이콘** — 충돌은 아니지만 **구분이 안 된다.** 3.0의 툴팁이
`.tooltip("AgentCodeGUI")`(`src-tauri/src/tray.rs:184`)라 2.6.2와 **글자가 같다.**
나란히 띄우면 알림 영역에 같은 이름 두 개가 뜬다. `tray.rs`는 이 라운드의 경계 밖이라
고치지 않았다 — 다음 라운드에서 `"AgentCodeGUI3"`으로 바꾸는 게 맞다(1줄).

**파일 연결 / 셸 확장** — 충돌 **없음**, 그리고 **파리티 구멍**이다.
생성된 `installer.nsi`의 "Create file associations"·"Register deep links" 절이 **비어 있다**
(3.0은 아무것도 등록하지 않는다). 반면 2.6.2는 `build/installer.nsh`에서
`HKCU\Software\Classes\Directory\shell\AgentCodeGUI`와 `…\Directory\Background\shell\AgentCodeGUI`에
**"AgentCodeGUI로 열기"** 우클릭 항목을 등록한다. 즉:
- 충돌: 없다(3.0이 그 키를 안 건드린다 — 제거 주행에서 2.6.2 키 생존 확인).
- 구멍: **3.0에는 "AgentCodeGUI로 열기"가 없다.** 이식하려면 `nsis.installerHooks`로
  같은 문법의 `NSIS_HOOK_POSTINSTALL`/`POSTUNINSTALL`을 붙이면 되고, **키 이름은 반드시
  `AgentCodeGUI3`** 여야 한다(같은 이름을 쓰면 3.0을 지울 때 2.6.2의 우클릭 항목이 사라진다).
  이번 라운드에서는 하지 않았다 — 나란히 설치 검증을 먼저 통과시키는 게 우선이었고,
  셸 키를 건드리는 변경은 되돌리기가 비싸다.

---

## 6. 서명 — 없다. 그리고 그건 회귀가 아니다

`Get-AuthenticodeSignature` 실측:

| 파일 | 서명 |
|---|---|
| `AgentCodeGUI3_3.0.0-beta.1_x64-setup.exe` | **NotSigned** |
| `AgentCodeGUI3.exe` (설치본) | **NotSigned** |
| `uninstall.exe` | **NotSigned** |
| `AgentCodeGUI-Setup-2.6.2.exe` | **NotSigned** |
| `AgentCodeGUI.exe` (2.6.2 설치본) | **NotSigned** |

**2.6.2도 서명이 없다.** 따라서 SmartScreen 경고는 3.0이 새로 만든 문제가 아니라 지금도
있는 문제다. 정확히 무슨 일이 생기는지:

- 로컬에서 만든 파일에는 MOTW(Zone.Identifier)가 없어 **지금 이 기계에서는 경고가 안 뜬다**
  (실측: 다섯 파일 모두 MOTW=False). 사용자가 **GitHub Releases에서 내려받으면** MOTW가
  붙고, 서명 없음 + 평판 없음이라 **"Windows의 PC 보호" 파란 창**이 뜬다. 사용자는
  「추가 정보 → 실행」을 눌러야 한다.
- 배포마다 새 파일 해시라 평판이 쌓이지 않는다(서명이 없으면 평판은 파일 단위다).

**사용자 결정 항목**(이 라운드에서 고를 수 없는 것):
1. **아무것도 안 한다** — 2.6.2와 같은 상태. 릴리즈 노트에 "경고가 뜨면 추가 정보→실행"을
   적는다. 비용 0.
2. **OV 코드 서명 인증서**(연 10~30만원대, 개인/사업자 실사) — 서명은 되지만 **평판은
   처음부터 쌓아야 한다.** 초기 몇 주는 경고가 계속 뜰 수 있다.
3. **EV 코드 서명 인증서**(연 40만원대~ + HSM/USB 토큰) — 즉시 평판을 받는 유일한 길.
   CI에서 자동 서명하려면 클라우드 HSM(Azure Trusted Signing 등)이 필요하다.
4. **Azure Trusted Signing**(월 $9.99부터, 개인도 3년 이상 이력 요건) — 실질적으로 가장
   싼 자동화 경로. 국내 개인 자격 요건 확인이 필요하다.

**결정되면 붙이는 자리는 이미 있다**: `bundle.windows.certificateThumbprint` 또는
`bundle.windows.signCommand`. 설정 두 줄이고, 이 라운드의 산출물은 그대로 쓴다.

---

## 7. 아직 없는 것 (다음 라운드로)

1. **자동 업데이트 경로가 없다.** 2.6.2는 `electron-updater` + GitHub `latest.yml` +
   blockmap 차등 다운로드였고, `scripts/patch-latest-yml.cjs`·`release.bat`가 그 파이프라인이다.
   3.0에는 대응물이 **아직 없다** — `ipc/app_meta.rs:12`가 "업데이트는 아직 없다 — 정직하게
   idle"로 답하고 있고, 렌더러의 `checkForUpdate`는 그 idle을 받는다.
   붙이려면 (a) `tauri-plugin-updater` 의존성 추가(=`src-tauri/Cargo.toml`, 이 라운드 경계 밖),
   (b) `tauri signer generate`로 **업데이트 서명 키쌍**(코드 서명과 별개다) 생성,
   (c) `bundle.createUpdaterArtifacts: true` + `plugins.updater.endpoints`,
   (d) 릴리즈에 `latest.json` 발행. **(b)의 개인키를 어디에 둘지가 사용자 결정 항목**이다.
   키 없이 `createUpdaterArtifacts`만 켜면 빌드가 실패한다(그래서 켜지 않았다).
2. **"AgentCodeGUI로 열기" 우클릭 항목**(§5.3) — `installerHooks`로 이식, 키 이름 분리 필수.
3. **트레이 툴팁 `AgentCodeGUI3`**(§5.3) — `tray.rs` 1줄.
4. **`mainBinaryName` 임시 복사 정리**(§5.2) — 하네스 기본 경로 이전 또는 `[[bin]] name` 변경.
5. **앱 홈 안의 WebView2 캐시** — 3.0은 WebView2 사용자 데이터를 `<앱 홈>/webview2`에 둔다
   (`win.rs:160-168`, 격리 홈을 벗어나지 않게 하려는 의도적 선택). 공유 홈으로 쓰면
   `~/.agentcodegui/webview2`가 생기고, **제거해도 안 지워진다**(사용자 데이터 취급이라
   맞는 동작이지만, 3.0을 지운 사용자에게는 남는 짐이다). 정리 UI나 제거기 훅을 둘지 결정 필요.
6. **아이콘은 2.6.2 것 그대로다.** 3.0 리뉴얼(M-UI)의 마크가 정해지면 `gen-icon.cjs`를
   다시 돌려 교체해야 한다. 지금은 두 앱의 아이콘이 **똑같아** 작업 표시줄에서 구분되지 않는다.
7. **재현성**: NSIS 산출물은 완전히 결정적이지 않다(같은 입력으로 두 번 구워
   2,492,776 B / 2,492,395 B — 381 B 차). 해시로 검증하려면 그 사실을 감안해야 한다.

---

## 8. 재현 방법

```bash
# 빌드(+설치본). 공용 target이 잠겨 있으면 CARGO_TARGET_DIR을 갈라라.
CARGO_TARGET_DIR=C:/Code/ccg-m12-target npm run tauri:build
#   → <target>/release/bundle/nsis/AgentCodeGUI3_3.0.0-beta.1_x64-setup.exe

# 설치(무인). ★ git bash에서는 `/S`가 경로로 변환된다 — MSYS2_ARG_CONV_EXCL 필수.
MSYS2_ARG_CONV_EXCL='*' ".../AgentCodeGUI3_3.0.0-beta.1_x64-setup.exe" /S

# 풋프린트
node bench/footprint.mjs                    # → bench/results/footprint.json
node bench/footprint.mjs --out=footprint-x  # 기준 파일 보호

# 게이트(설치본으로)
node scripts/poc-live-chat.mjs --tag=… --exe="%LOCALAPPDATA%\AgentCodeGUI3\AgentCodeGUI3.exe"
```

만든 설치본은 찾기 쉽게 `dist/AgentCodeGUI3_3.0.0-beta.1_x64-setup.exe`에도 복사해 뒀다
(`dist/`는 gitignore — 2.6.2 설치본들이 있는 그 폴더다).

스크래치 하네스(gitignore 대상 · `bench/scratch/`): `m12-coldstart.mjs`(콜드 스타트) ·
`m12-sharedhome.mjs`(홈 공유) · `m12-instlock.mjs`(단일 인스턴스) · `m12-uninstall.mjs`(제거) ·
`m12-homedir-shim.cjs`(계정 우회) · `m12probe/`(대소문자 매칭 실증).

## 9. 산출물

| 파일 | 내용 |
|---|---|
| `src-tauri/tauri.conf.json` | 번들러 on(NSIS) · `mainBinaryName` · 아이콘/설치 자산/언어/설치 모드 |
| `package.json` | `tauri:build` 체인 · `tauri:bundle` · `tauri:compat-exe` |
| `bench/footprint.mjs` (신설) | 두 앱 같은 방법의 풋프린트 측정 |
| `bench/results/footprint.json` | §3의 수치 |
| `bench/results/coldstart-m12-{installed,buildir}.json` | §4.3 |
| `bench/results/m12-{sharedhome,instlock,uninstall}.json` | §4.2 · §5.3 · §4.4 |
| `docs/critic/m3-r4-live-m12r1c.json` | 게이트 PASS(8/8) — 설치본 exe |
| `docs/critic/m3-r4-live-m12r1.json` | 첫 주행(7/8 + 계정 한도) — 실패 원인의 근거 |
| `docs/m12-report-r1.md` | 이 문서 |

빌드 기준: 커밋 `076bf8c` · exe SHA-256 `2DD62093C9D270F7…` (6,202,880 B) ·
설치본 SHA-256은 §7-7의 비결정성 때문에 값을 못 박지 않는다.
