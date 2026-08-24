# M12 R2 — 포장을 마감하고, 하네스의 거짓 통과를 걷어냈다

라운드: M12 R2 · 2026-08-24 · `feature/3.0.0-beta`
근거 문서: `docs/m12-report-r1.md` §남은것·§6 · `docs/critic/final-parity-r1.md` §5

R1이 설치본을 만들었다(656MB → 6.0MB). R2는 그 포장의 **마감**과, 파리티 감사가 남긴
**하네스 숙제 6건**을 처리한다. 두 갈래가 한 라운드에 묶인 이유는 둘 다 「측정과 배포가
진실을 말하게 하는 일」이고, 코드 표면이 겹치지 않기 때문이다.

## 0. 한 문단

포장 쪽: 3.0을 눈으로 가르는 **teal 「3」 배지 아이콘**과 트레이 툴팁, 탐색기 **우클릭
「AgentCodeGUI3으로 열기」**, **패치노트 3.0.0 항목**(ko/en), 보수적인 **WebView2 캐시 정리**를
얹었다. 전부 2.6.2와 **키·이름·폴더를 갈라** 공존하게 했다 — R1이 하마터면 사용자의
2.6.2를 죽일 뻔한 자리라 이번엔 정적 바이트 검증까지 했다.
하네스 쪽: 설정 레일 인덱스 드리프트로 **6화면이 거짓 실패하고 2화면이 거짓 통과**하던 것을
라벨 기반으로 바꿔 **3.0에서 인덱스 드리프트 5/11**을 실증하고 19/19 통과로 되돌렸다.

---

## 1. 착지한 것

| # | 무엇 | 커밋 |
|---|---|---|
| 1 | teal 「3」 배지 아이콘 + 트레이 툴팁 분리 | `4050e99` |
| 2 | 하네스 exe 이름 둘 정식 탐색 · `tauri:compat-exe` 제거 | `249cd4a` |
| 3 | 파리티 하네스 숙제 6건 + `--tag` + 부팅 패스 캔버스 함정 | `581a27c` |
| 4 | 우클릭 「AgentCodeGUI3으로 열기」 + WebView2 캐시 정리 | `60022e0` |
| 5 | 패치노트 `3.0.0` 덩이(ko/en 각 5항목) | `792c7e2` |
| 6 | 자동 업데이트 **설계 문서만**(구현 금지) | `docs/design/app-update-3.0.md` |

---

## 2. exe 이름 — 임시방편을 걷었다

R1이 `mainBinaryName: AgentCodeGUI3`을 켜면서 `tauri build`가 산출물을 rename했고,
`target/release/agentcodegui.exe`를 물고 있던 하네스 전부가 죽었다. R1은 빌드 끝에
6MB를 한 번 더 복사하는 `tauri:compat-exe`로 막았는데, 그건 **어느 쪽이 최신인지 모르게
만드는** 방식이었다.

`bench/lib.mjs`에 `resolveTauriExe(explicit, {targetDir, only, quiet})`를 두고
**mtime이 가장 최신인 후보**를 고른다. 이름을 고정하지 않은 이유는 두 이름이 동시에
살아 있을 수 있어서다 — `npm run tauri:build` → `AgentCodeGUI3.exe`,
인수인계 문서가 시키는 `cargo build --release --features custom-protocol` → `agentcodegui.exe`.
새 이름만 보면 **방금 손으로 빌드한 exe를 놓친다.**

격리 타깃에 일부러 지은 바이너리를 재는 m7 계열 6개는 `only: true`로 루트를 잠갔다 —
공용 `target/`이 더 새것이라는 이유로 끌려가면 **다른 빌드를 재고도 통과**한다.

실측: 해석 규칙 7종 **7/7 PASS**(스크래치 디렉터리 — 공용 target에 가짜 exe를 만들지 않았다) ·
바뀐 `.mjs` **38개 전부 `node --check` 통과** · 대표 하네스 `poc-tauri-stores` 스모크
(격리 홈, `tauri.localhost` 확인 = dev 빌드 아님, `window.api` 왕복 정상).

---

## 3. 파리티 하네스 숙제 6건 — 「거짓 통과가 거짓 실패보다 나쁘다」

### 3.1 레일 인덱스 드리프트 (§5-1) — 수치

`bench/scratch/raildrift.mjs`(격리 홈·자기 PID만 정리):

```
3.0   레일 12: Profile Account Engine API MCP Skill [Talk] Display Language Code Explorer Gestures
2.6.2 레일 11: (Talk 없음)

           옛 인덱스 → 실제로 켜진 탭      (의도)
 idx 6  →  Talk                            (Display)   ← settings-display 가 **Talk 를 찍고 통과**하고 있었다
 idx 7  →  Display                         (Language)
 idx 8  →  Language                        (Code)      ← settings-code-lsp 가 **Language 를 찍고 통과**
 idx 9  →  Code                            (Explorer)
 idx10  →  Explorer                        (Gestures)

인덱스 드리프트 : 3.0 = 5/11 · 2.6.2 = 0/11
라벨 정확       : 3.0 = 11/11 · 2.6.2 = 11/11
```

라벨은 두 앱이 같고 **i18n 대상도 아니다**(`Settings.tsx navGroups()`가 리터럴로 박는다).
`openSettings`는 이제 문자열만 받고(숫자는 즉시 예외), 누른 뒤 **선택된 탭이 정말 그
라벨인지 확인**한다 — 눌렀는데 안 바뀌는 경우까지 잡아야 같은 종류의 거짓 통과가 다시 안 생긴다.

### 3.2 나머지 다섯

| 숙제 | 무엇이 틀렸었나 | 어떻게 고쳤나 |
|---|---|---|
| §5-2 `.sc2.row2[4]` | 인덱스 4 = **2.6.2의 Verse 행**. 3.0엔 없다 | `.sc2.row2.disc` 첫 행(두 앱 공통) · 판정도 `.disc.open` |
| §5-3 픽스처 hold | `at`만이 아니라 **스키마가 통째로 달랐다**(`resetAt/text/prompt/window` — 실제 필드가 하나도 아니다) | `{key, at, engine, resetsAt(초), fable, lastPrompt}`. `limitResume.on`은 **일부러 끈다**(켜면 3.0만 usage 조회 실패로 「풀렸다」로 갈 수 있다 = 픽스처가 앱별로 다른 화면을 만든다) |
| §5-4 codex 정션 | 2.6.2가 `APP_HOME`을 하드코딩해 실홈 codex 엔진을 봤다 | `codex-engines` 정션 + `codex-config.json` 복사 |
| §5-5 스플래시 | `early:'data:'` 하나만 봤다. 3.0은 그 **창을 없앤 구조 변경** | 합집합 셀렉터 `.card .spin, #__ccg_splash .sp` + 러너가 1단 별도 창 → 2단 창 안 오버레이(리로드+CPU×20)로 내려간다. 리포트에 `via` 기록 |
| §5-6 error-boundary | 이 화면 하나가 뒤따르는 100화면을 연쇄로 죽였다 | 배열 맨 끝(=실행 맨 끝)으로 이동 · reset 실패 허용 |

### 3.3 재주행 결과

```
node bench/ab.mjs {tauri,electron} --tag=m12r2 --only=<19화면>
  3.0    19/19 (100%)      2.6.2  19/19 (100%)
```
`found` 개수도 한 곳 빼고 동일 — `settings-code-lsp` 4(3.0) vs 5(2.6.2)는 Verse 제외로
**의도된 차이**. `boot-splash-native`는 2.6.2 `via=separate-window`(300×240) ·
3.0 `via=in-window-overlay`(1440×900) — 둘 다 캡처됐고, 구조가 다르다는 사실이 리포트에 남는다.
R1 기준 이 묶음은 3.0에서 **6실패 · 2거짓통과**였다.

### 3.4 덤 — 부팅 패스의 캔버스 함정(이번에 원인까지 팠다)

`Browser.setWindowBounds`는 **Electron에서 안 먹는다**(`report.windowSized=false`).
두 앱의 캡처 캔버스가 같아지는 진짜 이유는 CDP가 아니라 **같은 기본 창 크기**다
(2.6.2 `src/main/index.ts:293` `DEFAULT_STATE` 1320×880을 3.0이 승계).
그래서 캡처 직전에 크기를 다시 강제하면 **3.0만 1440×900으로 끌려간다.**
실측: `limit-hold-bar`가 tauri 1440×900 / electron 1320×880으로 어긋나 있었고
(120px 넓으면 줄바꿈이 달라져 A/B가 아니다 — R1이 설정 재측정에서 이미 밟은 함정),
「앱이 자기 상태를 적용할 때까지 기다렸다 찍는다」로 바꾸니 **양쪽 1320×880**이 됐다.
행마다 `viewport`를 기록해 다음 라운드가 눈으로 안 찾아도 되게 했다.

`--tag=<name>`도 넣었다 — `bench/shots/<kind>/report.json`은 R1의 **증거 파일**이라
몇 화면 재주행으로 덮으면 안 되고, 같은 워크트리에서 3갈래가 동시에 도니 홈·포트도 갈려야 한다.

---

## 4. 포장 마감

### 4.1 아이콘 — 실물 판독

`bench/scratch/icon3/taskbar.png`(작업 표시줄 실제 크기: 24px/버튼 44px/표시줄 48px = 100%,
32px/58px/64px = 150%)에 2.6.2와 3.0을 번갈아 놓고 확인했다.

- **24px(100%)**: teal 점이 1:1에서도 즉시 구분된다. 숫자는 안 보이지만 필요 없다.
- **32px(150%)**: 「3」이 판독된다.
- 배지+모트 반경 51 < 카드 코너 아크 r 54 → 실루엣을 바꾸지 않는다.

**아직 못 한 것 — 진짜 작업 표시줄 스크린샷.** 아이콘은 **링크 타임에 exe에 박힌다.**
현재 `target/release/agentcodegui.exe`(08-24 11:40)를 뜯어보니
`icon.ico` 프레임 [48 64 128 256]이 그대로 들어 있고 `icon3.ico` 프레임은 **0개**다 —
설정을 바꾼 `4050e99`가 16:56이라 그 빌드는 옛 아이콘을 안고 있다. 재빌드하면
**다른 갈래(T3T4·T1T2)의 미커밋 Rust 변경까지 exe에 들어가** 그들의 하네스가 반쯤 만든
코드를 재게 되므로(병렬 규율), 다음 정식 빌드 뒤에 확인해야 한다.
확인용 스크립트는 `bench/scratch/icon3/taskbar.cjs`에 남겼다(exe 안 아이콘 판정까지 한다).

> 남은 위험: `bundle.identifier`가 2.6.2 `build.appId`와 **같다**(`com.agentcodegui.app`).
> Windows가 AppUserModelID로 작업 표시줄을 묶으므로 두 앱 버튼이 한 그룹으로 붙을 수 있다.
> 파리티 R1 §4.5의 「식별자 승계」 결정과 같은 자리라 함께 판단해야 한다.

### 4.2 우클릭 「AgentCodeGUI3으로 열기」

`src-tauri/nsis/hooks.nsh`(UTF-8+BOM·CRLF) + `tauri.conf.json`의 `nsis.installerHooks`.
키는 `…\Directory\shell\**AgentCodeGUI3**`과 `…\Directory\Background\shell\AgentCodeGUI3`,
전부 HKCU(installMode=currentUser라 관리자 권한 불필요).
파일 머리에 2.6.2가 쓰는 키 두 줄을 **금지 목록**으로 적어 뒀다.

**정적 검증(레지스트리 무접촉)** — tauri가 받아 둔 `makensis.exe` v3.11로,
템플릿과 **같은 include 순서**(hooks가 `MAINBINARYNAME` define보다 앞)를 재현해 컴파일:

```
컴파일 성공(경고 1건은 하네스가 WriteUninstaller를 안 부른 것뿐)
무압축 재빌드 후 exe 바이트 직접 검사:
  한국어 라벨 「AgentCodeGUI3으로 열기」(UTF-16LE)        ✔  ← BOM 규약이 실제로 작동
  …\shell\AgentCodeGUI3 · …\Background\shell\AgentCodeGUI3 ✔
  $INSTDIR\AgentCodeGUI3.exe · \Default\Code Cache          ✔
  ★ 2.6.2 키(뒤에 3 없는 AgentCodeGUI) 등장 = 0건
  ★ 앱 홈·chats·accounts를 가리키는 문자열 = 0건
```

실제 무인 설치→검사→언인스톨은 **하지 않았다.** 사용자의 실머신 HKCU에 쓰는 순간
되돌릴 수 없는 상태가 생기고, 이 라운드의 계약은 「실머신 레지스트리·실설치 2.6.2 절대
비접촉」이다. 실설치 확인은 사용자 승인 아래 별도로 도는 게 옳다.

### 4.3 WebView2 캐시 정리 — 왜 「보수적」인가

3.0은 WebView2 사용자 데이터 폴더를 앱 홈 안(`<home>/webview2`)으로 끌어왔다
(`win.rs` `shared_env` — 기본값은 CCG_HOME 격리를 벗어나고 벤치 콜드 스타트도 왜곡한다).
그 대가로 제거 후 잔여물이 앱 홈에 남는데:

- **앱 홈 자체는 2.6.2와 공유한다 — 절대 못 지운다.**
- `webview2\` 통째로도 못 지운다. 그 안 `Local Storage`에 **사용자가 쓴 프롬프트
  라이브러리**가 산다(`app/src/lib/prompts.ts`의 `prompt.library` — **파일 저장소가 없다.
  localStorage가 유일한 원본이다**). 최근 작업 폴더·창별 picker 기본값·언어 미러도 같은 자리다.

→ 순수 캐시 폴더 11개만 이름으로 지목한다. 실측(격리 벤치 홈 12MB):
`Cache 5.2M · Code Cache 1.4M · BrowserMetrics 1.3M · GPUCache/Dawn*/​*ShaderCache 각 548K`
⇒ **캐시 ~10.7M(89%)**를 걷고 `Local Storage` 9K는 남는다.

> **다음 라운드에 넘기는 지적**: `prompt.library`가 localStorage에만 있는 것은 그 자체로
> 취약하다. WebView2 프로필이 어떤 이유로든 초기화되면(사용자 데이터 폴더 이동·손상·
> 수동 삭제) **사용자가 쓴 프롬프트가 통째로 사라진다.** 앱 홈의 JSON으로 옮기는 것이
> 옳지만 계약면·2.6.2 호환이 걸려 이번 경계 밖이다.

### 4.4 패치노트 3.0.0

`app/src/components/PatchNotes.tsx`에 `'3.0.0'`(ko/en 각 5항목) 추가 + 가장 오래된
`'2.5.1'` 삭제(`MAX_VERSIONS=5`). **동결 구역 `src/renderer/`의 같은 파일은 안 건드렸다.**
인용 수치 15개(157.5MB·2.4MB·633.7MB·6.0MB·8,141·627.7MB·110.7MB·25.1MB·505MB·253MB·
336ms·290ms·422ms·373ms·0.45초) **전부 실측**이고, 재협상 중인 목표(WS·콜드 하한)는
**약속으로 쓰지 않았다.** 구조 점검은 `bench/scratch/patchnotes-check.mjs`.

카드를 실물로 띄워 보지는 못했다 — 3.0은 렌더러 번들을 exe에 굽기 때문에 §4.1과 같은
이유로 다음 정식 빌드 뒤에 찍어야 한다.

---

## 5. 자동 업데이트 — 설계만 (`docs/design/app-update-3.0.md`)

구현 금지 지시대로 **코드 0줄**. 문서가 담은 것 중 새로 판 사실 둘:

1. **2.6.2의 detached PowerShell 함정이 3.0엔 없다.** `tauri-plugin-updater`는 설치기를
   `ShellExecuteW`로 띄운다(`updater.rs:855`) — job object에도 프로세스 트리에도 안 묶인다.
   게다가 `passive`(기본)가 NSIS 진행창을 띄우고 `/R`이 앱을 다시 켜므로,
   **WPF 스플래시 자체가 필요 없을 수 있다**(그건 `/S` 무음 때문에 생긴 구멍이었다).
2. **이행기의 진짜 함정**: 같은 GitHub 저장소의 `latest.yml`을 3.0으로 갱신하면 사용자의
   2.6.2가 3.0을 「업데이트」로 자동 내려받고, 설치해도 제품명이 달라 **옆에 깔리고**,
   3.0 설치본엔 `latest.yml`이 없어 2.6.2가 **매 실행마다 같은 것을 또 받는다.**

결정 요청 3건(D1 갈래 · D2 Authenticode 구입 · D3 2.6.2 자동 승격)은 문서 §6.
minisign(0원)과 Authenticode(유료)가 **별개 결정**이라는 점을 분리해 적었다.

---

## 6. 만진 파일 / 안 만진 것

만진 것: `bench/{lib,ab,screens,fixture,attrib,lsp,lspwire,m6,m6r3}.mjs` ·
`docs/critic/tools/*.mjs`(18) · `scripts/*.mjs`(14) · `package.json`(hunk 1: compat-exe 제거) ·
`src-tauri/nsis/hooks.nsh`(신설) · `src-tauri/tauri.conf.json`(hunk 1) ·
`app/src/components/PatchNotes.tsx` · `bench/shots/{tauri,electron}-m12r2/report.json`(신설) ·
`docs/design/app-update-3.0.md`(신설) · `docs/m12-report-r2.md`(이 문서).
`4050e99`에서: `scripts/gen-icon.cjs` · `build/icon3.{ico,png}` · `src-tauri/src/tray.rs`.

안 만진 것: 동결 구역 `src/`·`out/`·`dist/` **전부 무접촉**(git diff 0) ·
다른 갈래의 미커밋 변경(`src-tauri/src/ipc/**`·`crates/**`·`src-tauri/src/win.rs`) 무접촉 ·
`bench/results/*`·`docs/critic/*.json`·`bench/shots/{tauri,electron}/report.json` 무손상.

---

## 7. 다음 라운드가 이어받을 것

1. **정식 빌드 뒤 실물 확인 2건**: 작업 표시줄 아이콘 스크린샷 · 패치노트 3.0.0 카드 캡처.
   둘 다 exe 재빌드가 전제다.
2. **`limit-hold-bar`의 앱별 분기** — 하네스 문제가 아니다(§3.2 아래 상자 참조):
   2.6.2는 `.lh-x` 1개 + 「과금 메뉴의 …를 켜면」(렌더러 소유·꺼짐),
   3.0은 `.lh-x` 0개 + 「약 42분 뒤 **자동으로 이어서 계속해요**」(managed 가지).
   `limitResume.on`은 **양쪽 다 꺼짐**인데 3.0만 자동 재개를 약속한다.
   원인은 `app/src/lib/resumeOwner.ts:36` — `resumeOwner`가 안 실려 오면 **대기표의 존재만으로**
   엔진 소유로 판정하고, `autoResume`이 undefined면 `auto !== false`라 자동 문장이 나온다.
   엔진이 실제로 안 쏘면 거짓말이고 취소(✕)도 사라진다. **판정 필요.**
3. `prompt.library`의 localStorage 단일 원본(§4.3 상자).
4. `bundle.identifier` 공유로 인한 작업 표시줄 그룹 병합 가능성(§4.1 상자).
5. 자동 업데이트 D1~D3 결정(§5).
