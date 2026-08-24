# R28 「M12 R2」 확인 크리틱 R1 — 여섯 조각은 전부 진짜다. 다만 증거 파일 하나가 자기 수치를 배신한다

판정자: 확인 크리틱(새 컨텍스트) · 2026-08-24 · `feature/3.0.0-beta`
대상 커밋: `4050e99` `249cd4a` `581a27c` `60022e0` `792c7e2` `94a3e8a`
**판정: PASS** — 체크리스트 6항목 전부 실측 통과, 규약 위반 0.

빌더 보고서는 근거로 쓰지 않았다. **전부 다시 빌드하고 다시 돌렸다.**
특히 빌더가 「안 했다」고 적은 두 가지(**exe 재빌드 · 작업 표시줄/트레이 실물**)를
이 라운드에서 직접 했다 — 그 둘이 이 라운드 산출물의 절반이기 때문이다.

---

## 0. 왜 재빌드부터 했나

빌더는 아이콘(`4050e99`)과 패치노트(`792c7e2`)를 **한 번도 눈으로 보지 않고** 커밋했다.
3.0은 아이콘이 링크 타임에, 렌더러 번들이 컴파일 타임에 exe로 들어간다 — 즉 설정만
바꾼 상태로는 **아무 것도 증명되지 않는다.** 빌더의 이유(「다른 갈래의 미커밋 Rust가
섞인다」)는 당시엔 절반만 맞았다(§7-G2).

판정 시점의 트리는 Rust 미커밋 0이라 재빌드가 안전했다.

```
npm run app:build                                              ✓ 2.17s
cargo build --release --features custom-protocol  (CARGO_TARGET_DIR=target)
                                                               ✓ 1m37s → agentcodegui.exe 6,344,192B
npx tauri build --no-bundle && npx tauri bundle --bundles nsis ✓ → AgentCodeGUI3.exe + 설치기
```

실앱(2.6.2, `%LOCALAPPDATA%\Programs\AgentCodeGUI`, pid 6644/12924/23792/24836/26924)은
계속 떠 있는 상태로 두었고, 이름 기반 kill은 한 번도 쓰지 않았다(내가 스폰한 PID만 `Stop-Process`).
실행·측정은 전부 `CCG_HOME` 격리.

---

## 1. 아이콘 · 툴팁 (체크리스트 1) — **PASS**

### 1.1 생성기 재현성 — 2.6.2 산출물 무접촉

레포 밖 스크래치(`%TEMP%\ccg-critic-m12r2-genicon\{scripts,build}`)에 `gen-icon.cjs`만
복사해 두 번 돌렸다(공용 `build/`를 덮지 않기 위해).

| 파일 | 스크래치 sha256 | 레포 sha256 | |
|---|---|---|---|
| `icon.ico` | `a43774c6…62f0` | `a43774c6…62f0` | **동일** |
| `icon.png` | `1924263c…8746` | `1924263c…8746` | **동일** |
| `icon3.ico` | `51e97782…caaf` | `51e97782…caaf` | 동일 |
| `icon3.png` | `986d9f18…a1e4` | `986d9f18…a1e4` | 동일 |

→ 플래그 없이 돌려도 **2.6.2 electron-builder가 물고 있는 두 파일이 바이트 그대로**다. 빌더 주장 확인.

### 1.2 exe에 무엇이 박혔나 — 재빌드 전/후

```
재빌드 전  target/release/agentcodegui.exe (08-24 11:40)
   icon.ico  프레임 일치 [48 64 128 256]   icon3.ico 프레임 일치 []      ← 옛 아이콘
재빌드 후  target/release/agentcodegui.exe (08-24 17:50)
   icon.ico  프레임 일치 []                icon3.ico 프레임 [16 24 32 48 64 128 256]
   build/icon3.png 바이트 in-exe: true     build/icon.png 바이트 in-exe: false  (트레이 원본)
   "AgentCodeGUI3"(UTF-8) in-exe: true                                        (트레이 툴팁)
```

**7개 프레임 전부** 들어간다(빌더 판정 스크립트는 `data.length > 512` 필터 탓에
16px 318B·24px 471B를 못 세서 5개로 보고했다 — §7-G4).

### 1.3 실물 — 실기 작업 표시줄·트레이(2.6.2와 나란히)

격리 홈으로 3.0을 띄우고(pid 21920, 창 제목 `AgentCodeGUI3`) 데스크톱 5120×1440을
캡처해 작업 표시줄(y=1392, 48px)을 1:1로 오려 봤다.

- 2.6.2 = 무채색 마스코트 / 3.0 = **마스코트 + teal 점**. 24px 1:1에서 즉시 갈린다.
- 두 앱은 **한 버튼으로 묶이지 않는다.** UI Automation 실측:
  `AgentCodeGUI - 1개의 실행 중인 창` · `AgentCodeGUI3 - 1개의 실행 중인 창` (별개 `Taskbar.TaskListButtonAutomationPeer`).
  → 빌더가 「남은 위험」으로 넘긴 **`bundle.identifier` 동일 → AppUserModelID 그룹 병합**은
  적어도 exe 직접 기동에서는 **일어나지 않는다.** 실측으로 닫는다.
- 트레이(숨김 영역 플라이아웃) UIA 열거:
  `AgentCodeGUI3 @2266,1215` · ` AgentCodeGUI @2346,1215` — **툴팁 글자가 갈린다.**

> 부작용 고지: 트레이 열거 중 IME 표시기 버튼을 한 번 잘못 눌러 한/영이 뒤집혔고,
> 즉시 되돌려 「한국어 입력 모드」로 복구했다. 그 외 사용자 상태 변경 없음.

---

## 2. compat-exe 걷힘 · 구/신 이름 스모크 (체크리스트 2) — **PASS**

- `package.json`: `tauri:build`가 `tauri build` 한 줄, `tauri:compat-exe` 스크립트 삭제 확인.
  살아 있는 참조 0(주석·문서 언급만).
- `resolveTauriExe` 규칙 4종 직접 실측:

| 조건 | 결과 |
|---|---|
| 기본(둘 다 존재) | `target/release/agentcodegui.exe` (mtime 최신) |
| `CARGO_TARGET_DIR=<격리>` | `<격리>/release/AgentCodeGUI3.exe` + stderr 「후보 2개 중 최신」 |
| `only:true, targetDir=<격리>` | 공용 target으로 안 샌다 |
| `CCG_EXE` | 무조건 우선(존재 안 해도) |

- **poc 하네스**(`scripts/poc-tauri-stores.mjs`) 격리 홈 스모크
  - 새 이름(`AgentCodeGUI3.exe`): `href=http://tauri.localhost/`(dev 아님) · `version=3.0.0-beta.1` · IPC 왕복 정상
  - 옛 이름(`agentcodegui.exe`): 동일
- **bench 하네스**: `npx tauri build`가 산출물을 rename 해 **옛 이름이 사라진 상태**에서
  `node bench/ab.mjs tauri --tag=critnew` → `AgentCodeGUI3.exe`로 해석되어 3/3 OK
  (`chat-thread` 450ms · `settings-display` · `settings-code-lsp`).
- `249cd4a`가 바꾼 `.mjs` **38개 전부 `node --check` 통과**. `only:true`는 m7 계열 6개에만.

---

## 3. NSIS (체크리스트 3) — **PASS** · 실레지스트리 무접촉 확인

### 3.1 빌더의 하네스가 아니라 **진짜 설치기**로 검증했다

빌더는 tauri 템플릿을 「재현한」 스크립트로 컴파일했다. 나는 실제 파이프라인을 돌렸다.

```
target/release/bundle/nsis/AgentCodeGUI3_3.0.0-beta.1_x64-setup.exe   2,549,447 B (2.43MB)
target/release/nsis/x64/installer.nsi (tauri 생성본, 31,086B)
   31: !include "C:\Code\AgentCodeGUI\src-tauri\nsis\hooks.nsh"
   41: !define INSTALLERICON "…\build\icon3.ico"
   47: !define MAINBINARYNAME "AgentCodeGUI3"        ← include보다 **뒤**
  707: !insertmacro NSIS_HOOK_POSTINSTALL
  840: !insertmacro NSIS_HOOK_POSTUNINSTALL
```

컴파일이 실제로 성공했다 = 「매크로 본문은 삽입 시점에 파싱된다」는 빌더의 논거가
**실물 템플릿에서 성립**한다. (실 템플릿은 `LogicLib.nsh`를 직접 include하지 않지만
MUI2가 물고 들어와 `${If}`·`${FileExists}`가 선다.)

### 3.2 바이트 검증 — 실 `installer.nsi`를 무압축으로 다시 컴파일

`target/release/nsis/x64/*`를 임시 폴더로 복사해 `SetCompressor /SOLID "lzma"` → `SetCompress off`,
`OutFile` → `NOCOMP-DO-NOT-RUN.bin`(**확장자를 .bin으로 두고 실행하지 않았다. 검사 후 삭제**).

| 검사 | 결과 |
|---|---|
| 한국어 라벨 `AgentCodeGUI3으로 열기` (UTF-16LE) | **있다** → BOM+CRLF 규약이 실 템플릿에서도 작동 |
| 한국어 안내 `탐색기 우클릭 메뉴 등록` | 있다 |
| `Software\Classes\Directory\shell\AgentCodeGUI3` | 있다 |
| `Software\Classes\Directory\Background\shell\AgentCodeGUI3` | 있다 |
| `Directory\shell\AgentCodeGUI` 총 등장 3 → 뒤에 `3` 없는 것 | **0** |
| `Background\shell\AgentCodeGUI` 총 등장 3 → 뒤에 `3` 없는 것 | **0** |
| `\.agentcodegui\chats` · `\accounts` · `\ui-prefs` | 0건 |
| `.agentcodegui` 문자열 6건 | 5건은 `com.agentcodegui.app`(번들 id), 1건은 `\.agentcodegui\webview2\EBWebView` |
| `\Default\Code Cache` 등 캐시 경로 | 있다 |

`hooks.nsh` 자체: UTF-8 **BOM 있음**, 86줄 **전부 CRLF**(순수 LF 0), 5,855B.

### 3.3 「2.6.2를 안 죽인다」의 나머지 축

- `CheckIfAppIsRunning "${MAINBINARYNAME}.exe"` = **`AgentCodeGUI3.exe` 정확 일치**
  (`FindProcessCurrentUser`) → 사용자의 `AgentCodeGUI.exe`를 잡지 않는다. M12 R1의 사고 자리 닫힘.
- `UNINSTKEY` = `…\Uninstall\AgentCodeGUI3` (2.6.2는 GUID 키 `f2fb66d4-…` = 별개).
- 템플릿의 옵트인 앱데이터 삭제는 `$APPDATA\com.agentcodegui.app`·`$LOCALAPPDATA\com.agentcodegui.app`.
  2.6.2의 userData는 `%APPDATA%\agent-code-gui`(또는 `src/main/index.ts:64`의 `<CCG_HOME>/userData`) —
  **겹치지 않는다.** 디스크 확인: `%LOCALAPPDATA%\com.agentcodegui.app\EBWebView`는 3.0 자신의 것,
  `%APPDATA%\com.agentcodegui.app`는 아예 없다.
- `MANUKEY` = `HKCU\Software\AgentCodeGUI` → 하위에 `AgentCodeGUI3` 하나뿐(2.6.2는 안 쓴다).
  삭제도 `/ifempty`.

### 3.4 실머신 비접촉 — **위반 없음**

```
HKCU\Software\Classes\Directory\shell            → AgentCodeGUI       (2.6.2 것만)
HKCU\Software\Classes\Directory\Background\shell → AgentCodeGUI       (2.6.2 것만)
```
→ 이 라운드의 훅은 **한 번도 실행되지 않았다.**

`HKCU\…\Uninstall\AgentCodeGUI3`(`%LOCALAPPDATA%\AgentCodeGUI3`, exe 08-24 **11:59** · uninstall.exe **12:40**)는
**M12 R1**의 설치본이다 — R2의 첫 커밋은 **16:56**이라 시간상 R2가 만든 것이 아니다.
빌더도 나도 무인 설치를 하지 않았으므로 「언인스톨 잔재」 항목은 해당 없음.

---

## 4. 패치노트 (체크리스트 4) — **PASS** · 실물 카드로 확인

동결 구역 `src/`·`out/`·`dist/`의 `4050e99~1..HEAD` diff = **0줄**(`src/renderer/PatchNotes.tsx` 무접촉).

재빌드한 exe를 **도장 없는 빈 격리 홈**으로 띄워 CDP로 카드를 실제로 열었다.

```
hasCard   true
verPill   v3.0.0-beta.1        hero 3.0        eyebrow REBUILT
버전 레일 v3.0.0  v2.6.2  v2.6.1  v2.6.0  v2.5.2      ← 정확히 5개, 2.5.1 삭제 확인
ko 노트   5개 (용량/메모리/안정성/속도/탐색기)
en 전환(ccg.lang=en) → eyebrow REBUILT · "Everything under the hood is new…" · en 노트 5개
```

풀버전 키 `3.0.0` + 「현재 버전 노트 없으면 최신」 폴백이 **실제로 그렇게 동작**한다
(앱 버전 `3.0.0-beta.1`인데 `3.0.0` 덩이가 열리고 히어로는 `3.0`).
`npm run typecheck`(node·web) + `typecheck:app` **3종 초록**(내가 다시 돌렸다).

---

## 5. 자동 업데이트 (체크리스트 5) — **PASS** · 설계 문서만

- `94a3e8a` 변경 파일 = `docs/design/app-update-3.0.md`(187줄) + `docs/m12-report-r2.md`. **코드 0줄.**
- Rust: `app:update-check|install|event` 핸들러 **0**. `UPDATE_GET_STATUS`는 여전히 `idle`(이식 시점 그대로).
- `tauri-plugin-updater` = `src-tauri/Cargo.toml` 없음 · **`Cargo.lock`에도 없음**.
- `tauri.conf.json`에 `updater` 키 없음. `app/src/api/shim.ts`는 이 구간에서 **손대지 않았다**(git log 0건).
- 문서에 결정 요청 3건(D1 갈래 A · D2 서명 보류 · D3 자동 승격 안 함)이 **권고만** 적혀 있다.

---

## 6. 하네스 숙제 6건 + 재주행 (체크리스트 6) — **PASS**

### 6.1 6건 전수 확인 (코드로)

| # | 숙제 | 확인 |
|---|---|---|
| 1 | `openSettings` 라벨 기반 | 문자열만 받고 숫자는 **즉시 예외**. 누른 뒤 `.set-ni.on` 텍스트 재확인. 레일 검색어 선비움. 17자리 전환 |
| 2 | `.sc2.row2[4]` → `.disc` | reach가 `.set-inner .sc2.row2.disc` 첫 행 클릭, assert `= .disc.open` |
| 3 | 픽스처 hold 스키마 | `{key, at, engine, resetsAt(초), fable, lastPrompt}` — `sanitizeHold`(`app/src/lib/limitResume.ts:101`)와 **필드 정확 일치** |
| 4 | `codex-engines` 정션 | `['engines','codex-engines']` 루프 + `config.json`·`codex-config.json` 복사 |
| 5 | 스플래시 2구현 | 합집합 셀렉터 `.card .spin, #__ccg_splash .sp` + `selfShot:true` + 러너 2단(별도창 → 리로드·CPU×20 오버레이) |
| 6 | `error-boundary` 맨 끝 | `SCREENS` 인덱스 **156 / 156** = 배열 마지막 |

### 6.2 내가 다시 돌린 19화면 (`--tag=critm12r2`, 포트 9611/9613 격리)

```
3.0    정의 156 · 시도 19 · 성공 19 · 실패 0   (100%)
2.6.2  정의 156 · 시도 19 · 성공 19 · 실패 0   (100%)
```

`found` 개수 19행 중 18행 완전 일치, 유일한 차이 `settings-code-lsp` **3.0=4 / 2.6.2=5**
(Verse 제외 — 의도된 차이). 캡처 크기: 본 패스 **양쪽 전부 1320×880**.
`boot-splash-native`만 3.0 1440×900(창 안 오버레이) / 2.6.2 300×240(별도 창) — 구현이 다르니 당연.

거짓 통과 2건이 진짜로 고쳐졌는지 스크린샷으로 눈으로 확인했다:
`tauri settings-display.png` = **Display 탭**(레일 12개, Talk 포함, Display 하이라이트),
`tauri settings-code-lsp.png` = **Code 탭**(TS·Python·C#·C/C++ 4행, Verse 없음).

### 6.3 기준 결과 파일 무손상

`git status` 기준 `bench/results/*` · `docs/critic/*.json` · `bench/shots/{tauri,electron}/report.json`
**전부 미변경**. 내 재주행은 `--tag`로 갈랐고, 판정 후 내가 만든 태그 디렉터리는 삭제했다.

### 6.4 경계 규율

- 동결 구역 diff 0(§4).
- 공유 파일 자기 훅만: `tauri.conf.json` 전 구간 diff = 아이콘 2줄 + `installerHooks` 1줄뿐.
  `package.json` = compat-exe 제거 훅 하나뿐.
- 다른 갈래의 `crates/**`·`src-tauri/src/ipc/**`·`win.rs` 무접촉.

---

## 7. 남은 격차 (전부 PASS 판정 안쪽 — 그러나 다음 라운드가 볼 것)

### G1 ★ 태그 리포트가 자기 수치를 배신한다 (이 라운드의 주제와 정확히 같은 죄)

`bench/shots/{tauri,electron}-m12r2/report.json`은 **커밋된 증거 파일**인데 내용이 이렇다.

```json
"screens": [ { "id": "limit-hold-bar", "ok": true, … } ],
"summary": { "defined":156, "attempted":1, "ok":1, "failed":0, "successRatePct":100 }
```

**행이 하나다.** 커밋 메시지와 `docs/m12-report-r2.md:95`는 「19화면 19/19」라고 적는데,
그걸 뒷받침하라고 만든 파일이 「1/1」이라고 말한다. 마지막 `limit-hold-bar` 단독 재주행을
`--merge` 없이 돌려 덮은 것이다. 19장의 PNG는 디스크에 있지만 `.gitignore` 대상이라
**레포에는 19/19의 흔적이 하나도 안 남았다.**

수치 자체는 내가 재현했으니 **거짓말은 아니다.** 그러나 이 라운드가 스스로 세운 명제가
「거짓 통과가 거짓 실패보다 나쁘다 — 아무도 안 본다」였다. 같은 함정을 증거 파일에서 밟았다.

처방(다음 라운드): `--tag` 재주행은 **항상 `--merge`**, 또는 마지막에 전 묶음 한 번 더.
`ab.mjs`가 `summary.attempted < ONLY.size`일 때 경고 한 줄을 찍게 하는 것도 값싸다.

### G2 산출물 둘을 「보지 않고」 커밋했다

아이콘(`4050e99` 16:56)과 패치노트(`792c7e2` 17:34)는 **exe에 들어가야 존재하는 것**인데
재빌드 없이 커밋됐다. 사유는 「다른 갈래 미커밋 Rust」였지만, 17:34 시점에 T3/T4는
이미 커밋(`e581b2a` 17:28)했고 마지막 커밋(17:41) 시점엔 T1/T2도 커밋(`06ac40b` 17:39)했다.
**마지막에 한 번은 볼 수 있었다.** 결과적으로 둘 다 맞았지만, 맞았다는 사실은
이번 라운드가 아니라 이 크리틱이 증명했다.

### G3 `viewport` 기록은 부팅 패스에만 있다

커밋 메시지는 「각 행에 `viewport`도 기록」이라 적었지만 `ab.mjs:506`은 `bootPass` 안이고,
`settleSize`도 `limit-hold` 변형에만 붙었다. 본 패스 19행 중 18행이 `viewport: null`이다.
(본 패스는 실측상 양쪽 1320×880이라 지금 당장의 피해는 없다.)

### G4 아이콘 판정 스크립트가 프레임을 과소 보고

`bench/scratch/icon3/taskbar.cjs:whichIconInExe`의 `data.length > 512` 필터가
16px(318B)·24px(471B)를 통째로 건너뛴다. 실제로는 **7프레임 전부** exe에 있다.
`>512`는 「BMP로 재인코딩됐을 때의 오검출 방지」로는 과하다.

### G5 (경계 밖 · 확인됨) `limit-hold-bar`가 앱마다 다른 문장을 말한다

빌더가 「다음 크리틱이 볼 것」으로 넘긴 발견을 **내 재주행 스크린샷으로 재현**했다.

```
2.6.2 : ⚠ 사용 한도에 도달했어요  과금 메뉴의 '한도 소진 시 자동 이어서'를 켜면 풀릴 때 자동으로 계속해요   [✕]
3.0   : ⚠ 사용 한도에 도달했어요  약 42분 뒤 자동으로 이어서 계속해요                                        (✕ 없음)
```

두 앱 모두 `limitResume.on`은 **꺼짐**인데 3.0만 자동 재개를 약속하고, 취소 수단(`.lh-x`)까지
사라진다. 원인은 `app/src/lib/resumeOwner.ts:36` — `resumeOwner`가 안 실려 오면 대기표 존재만으로
엔진 소유로 보고, `autoResume`이 `undefined`면 `auto !== false`라 자동 문장으로 간다.
**사용자에게 하는 거짓말이고 되돌릴 버튼도 없다.** 이 라운드 경계 밖이라 그대로 둔다 — 배정 필요.

### G6 (참고) 사용자 기계에 깔린 3.0은 아직 옛 아이콘이다

`%LOCALAPPDATA%\AgentCodeGUI3\AgentCodeGUI3.exe`(08-24 11:59, M12 R1 설치본)에는
`icon.ico` 프레임이 박혀 있고 우클릭 메뉴 키도 없다. 이번 라운드의 두 성과는
**다음 설치본부터** 사용자 눈에 닿는다. 새 설치기는 이 라운드에서 만들어 뒀다
(`AgentCodeGUI3_3.0.0-beta.1_x64-setup.exe`, 2.43MB — 패치노트가 인용한 「2.4MB」와 일치).

---

## 8. 종합

| 체크리스트 | 판정 | 핵심 실측 |
|---|---|---|
| 1 아이콘·툴팁 | **PASS** | 재빌드 후 icon3 7프레임 in-exe · 실기 작업 표시줄에서 teal 점으로 갈림 · 트레이 툴팁 `AgentCodeGUI3`/`AgentCodeGUI` 별개 · 버튼 그룹 **안 묶임** |
| 2 compat-exe · 두 이름 | **PASS** | 해석 규칙 4/4 · poc 두 이름 모두 `tauri.localhost` 부팅 · 옛 이름 소멸 상태에서 bench 3/3 · 38 mjs `node --check` |
| 3 NSIS | **PASS** | 진짜 설치기 컴파일 성공 · 무압축 바이트에 한국어 라벨 ✔ · 2.6.2 키 **0건** · 실 HKCU 무접촉(훅 미실행) |
| 4 패치노트 | **PASS** | 실물 카드 ko/en 각 5항목 · 버전 레일 정확히 5 · `2.5.1` 삭제 · 동결 `src/renderer` diff 0 |
| 5 자동 업데이트 | **PASS** | 문서 2개 외 코드 0 · `Cargo.lock`에 updater 없음 |
| 6 하네스 숙제 + 재주행 | **PASS** | 6/6 코드 확인 · **내 재주행 19/19 · 19/19** · 기준 파일 무손상 |

**남은 최대 격차**: G1 — 커밋된 태그 리포트(`bench/shots/{tauri,electron}-m12r2/report.json`)가
`attempted:1`이라 이 라운드의 대표 수치 「19/19」를 레포 안에서 되짚을 수 없다.
