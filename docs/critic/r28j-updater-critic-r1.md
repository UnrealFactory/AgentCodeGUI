# R28j UPDATER 확인 크리틱 R1 — 카드는 **내 손에서도 스스로 떴다**. 그런데 그 함정을 막는다는 못은 진짜 종료 문을 안 보고, `npm run tauri:build`는 이제 **1로 끝난다**

측정자: 새 컨텍스트의 크리틱. 빌더 보고서(`docs/parity-fix-updater-r1.md`)와 커밋 메시지는
**근거로 쓰지 않았다** — 무엇을 확인할지 고르는 데만 읽고, 수치는 전부 내가 다시 구운 exe와
내가 새로 쓴 계기로 격리 홈에서 다시 쟀다. 레포 코드 수정 0(이 파일 한 장뿐).

---

## 0. 판정 요약

**여덟 항목 중 일곱은 내 손에서도 닫혔다.** 감사 R5 §9.1의 `N8`(높음)이 말한 것 —
「출하된 3.0 사용자는 앱 안에서 새 버전을 알 수도 받을 수도 없다」 — 는 더 이상 사실이 아니다.
시드를 **아무것도 심지 않고** 로컬 피드 하나만 세웠더니 카드가 스스로 떠서
(`class="upd show"` · 계산된 `opacity:1` · `pointer-events:auto`) 게이지가 14%→95%로 움직이고
「바로 적용돼요 [나중에] [업데이트]」까지 갔다. 「업데이트」를 누르니 받아진 바이트가 **진짜로
실행돼** `/P /R /UPDATE /ARGS`를 남기고 앱이 404ms 만에 죽었다. 2.6.2가 밟은 「종료 시 자동
설치」 사고는 **실측으로도 재현되지 않는다**(받아둔 채 완전히 종료 → 설치기 0 · 종료 +15초 후에도 0).

**닫히지 않은 것은 셋이고, 그중 하나는 이 라운드가 새로 만든 회귀다.**

| 등급 | 결함 |
|---|---|
| **중간** | **`npm run tauri:build`가 이제 종료 코드 1로 끝난다** — `TAURI_SIGNING_PRIVATE_KEY` 없이는 마지막 서명 단계에서 실패한다. 그런데 그 명령을 「써라」라고 시키는 `docs/HANDOFF-3.0.md:119`와 `src-tauri/Cargo.toml:13`에는 그 환경변수 이야기가 **한 줄도 없다** |
| 낮음 | 「종료 시 자동 설치 금지」를 지킨다는 못 `install_is_never_wired_to_exit`이 **`main.rs`만 읽는다.** 실제 종료 문인 `tray.rs::quit()`에 `updater::install`을 심어도 **못이 그대로 통과한다**(내가 격리 트리에서 실증) |
| 낮음 | 조회 단계 실패(네트워크 없음 · 피드 404)는 **화면에 아무것도 남기지 않는다.** 2.6.2와 **바이트가 같은 컴포넌트**라 회귀는 아니지만, 체크리스트 5번이 요구한 「셋을 눌러라」 중 둘은 화면에 안 나타난다 |
| 낮음 | 받아둔 설치본을 **세션 내내 메모리에 든다**(실측 `PrivateBytes` **+14.3MB** / `WorkingSet` **+9.3MB**, 8.0MB 페이로드 기준) |
| 낮음 | 출하 바이너리에 **업데이트 주소를 갈아끼우는 환경변수**(`CCG_UPDATE_FEED`)가 살아 있다 — 2.6.2에는 없던 문이다 |
| 낮음(장부) | **같은 라운드의 두 커밋 메시지가 서로 다른 수치를 적었다.** `971e3f7`은 「agentcodegui 179(+5) · workspace 807」, `55a4549`는 「136(+5) · 756」. 내 측정은 **136 / 756** — 앞 커밋 메시지가 틀렸고 정정되지 않았다 |
| 정보 | 새 문서·주석의 줄 번호 셋이 어긋난다(`App.tsx:2670`→실제 2651 · `AppUpdateGate.tsx:47`→48 · `:36`→38) |

---

## 1. 무엇으로 쟀나

### 1.1 내가 구운 exe (전부 새 `CARGO_TARGET_DIR` · 남의 target 재활용 0)

| 이름 | 빌드 | 크기(B) | sha256 | 쓴 곳 |
|---|---|---|---|---|
| **EXE-R**(출하 팔) | `cargo build --release --features custom-protocol`<br>`CARGO_TARGET_DIR=target-r28j-upd-crit` · 워킹트리 = `55a4549`(추적 파일 중 `bench/*.mjs` 둘만 남의 미커밋) | **7,066,112** | `47ae697b13e14a17f79ea004b62eb6ea3cec937dbe1ba80540513b9d11375782` | 크기·경고·콜드 스타트·원시 채널·**https 강제**·출하 엔드포인트 |
| **EXE-C**(대조군) | 같은 명령 · **새** `CARGO_TARGET_DIR=target-r28j-upd-critctl` · `git archive 7c4494d`(=`971e3f7^`) 격리 트리 | **6,474,240** | `5d1802bba41723fbe553469e8f4b1f21adcc3a2d6fdce41b123feb0fdfa16e30` | 크기·경고·테스트·콜드 스타트 대조 |
| **EXE-DA**(로컬 피드 팔) | `--release --features custom-protocol --config profile.release.debug-assertions=true` · `target-r28j-upd-critda` | 7,350,272 | `f092f4a38350c140dad85dbb8d52a73f632340f3859cd4ec05fdb8f81af1504e` | 로컬 피드 전 흐름·오류 넷·30분 재확인 |
| **EXE-DEV**(개발 팔) | `--release` (`custom-protocol` **없음**) · `target-r28j-upd-critdev` | 6,558,208 | `810205ad7d0b7069ccff3044f795b0d449c103a2b530bd5307b45a24a64fd5e5` | 개발 no-op A/B |
| 번들 | `npx tauri bundle` · `target-r28j-upd-critbundle` | setup.exe **2,813,261** | `2887bd4bd8229a863292e563337e41ec43d343b037855f4c1e30715c02e87f6c` | 릴리스 파이프라인 회귀(§3.1) |

### 1.2 ★ EXE-DA를 왜 따로 구웠나 — 그리고 무엇을 포기했나

**순정 릴리즈 exe는 `http://` 피드를 아예 거절한다.** 플러그인의
`config.rs:145 validate_endpoints`가 `#[cfg(not(debug_assertions))] return Err(InsecureTransportProtocol)`
이기 때문이다(내가 크레이트 소스에서 확인 · **그리고 EXE-R로 실측했다** — §2.5의 음성 대조).
그래서 로컬 가짜 피드로 전 흐름을 재려면 둘 중 하나다:

1. **https 로컬 서버 + 임시 자기서명 인증서를 사용자 신뢰 저장소에 넣기** — 시도했다가 **접었다.**
   `Import-Certificate … -CertStoreLocation Cert:\CurrentUser\Root`가 **사용자 화면에 모달 확인
   대화상자를 띄우고 멈췄다**(120초 무응답). 즉시 그 PowerShell을 죽였고, 확인했다:
   `Cert:\CurrentUser\Root`에 **아무것도 안 들어갔다**(`ROOT_localhost=0`). `CurrentUser\My`에
   생겼던 임시 인증서와 `tmp.pfx`/`tmp.cer`는 **지웠고 지워진 것을 재확인했다**(`MY_after=0`).
   → **사용자 기계의 신뢰 저장소는 이 크리틱이 건드리지 않았다.**
2. **같은 소스·같은 피처로 굽되 `debug-assertions`만 켠 릴리즈** — 이걸 골랐다. 바뀌는 것은
   `cfg(debug_assertions)` 두 자리뿐이다: ① 위의 엔드포인트 스킴 게이트 ②
   `main.rs:2`의 `windows_subsystem`(콘솔 팔로 바뀌어 stderr를 그대로 받을 수 있다 — 오히려 이득).
   `minisign` 검증도 `install` 경로도 **debug_assertions와 무관**하다(크레이트 소스 확인).

**그래서 이 판정문이 정직하게 말할 수 있는 범위**: 「카드가 뜬다 · 게이지가 움직인다 · 설치기가
실제로 뜬다 · 서명 불일치가 거부된다 · 종료가 설치를 안 부른다」는 **EXE-DA**에서 실측했고,
「출하 exe가 https를 강제한다 · 출하 엔드포인트에 실제로 닿는다 · 원시 채널 셋이 구현됐다 ·
크기·경고·콜드 스타트」는 **EXE-R**에서 실측했다. **진짜 GitHub 릴리스는 만들지 않았다.**

### 1.3 격리 홈 · 포트 · 격리 트리

* 홈: `C:\Temp\ccg-r28j-updcrit\home-*`(주행마다 새로 판다) · 테스트 홈 `…\testhome2`.
  사용자 실홈(`%USERPROFILE%\.agentcodegui`)은 **읽지도 않았다**. 이름 기반 kill 0 —
  죽인 것은 내가 스폰한 PID뿐(`taskkill /PID <내 pid> /T /F`).
* CDP: **10950~10960 · 10964~10968**(UPDATER 10900~ + 크리틱 50).
  피드 서버는 처음 10970/10972/10973에 세웠다가 **10974가 남의 것**이라는 걸 보고(내 것이 아닌
  PID가 LISTENING) 전부 **10961~10963**으로 옮겼다. 남의 포트를 뺏은 시간은 있었고 여기 적는다.
* 격리 트리: `git archive b20111d` → `C:\Temp\ccg-r28j-updcrit\head`(테스트·못 실증) ·
  `git archive 7c4494d` → `…\ctl`(대조군). 둘 다 `app/dist`를 복사해 넣었다.
  `b20111d`와 `55a4549`는 **Rust가 한 글자도 다르지 않다**(그 사이 셋은 문서·벤치 커밋).

### 1.4 내가 새로 쓴 계기 (전부 레포 밖 · `C:\Temp\ccg-r28j-updcrit\`)

| 파일 | 하는 일 |
|---|---|
| `chanscan.mjs` | 계약면 채널 **독립** 스캐너 — `protocol.ts`의 `IPC` 맵을 줄 파서로 뽑고, Rust의 `pub const … &str = "…"`과 **match 팔 위치의 참조**를 따로 세어 `impl`/`codeRef`/`comment`/`missing`으로 가른다. 감사·빌더 도구는 안 썼다 |
| `rawprobe.mjs` | 같은 질문을 **다른 방법으로** — 실행 중인 exe에 `__TAURI_INTERNALS__.invoke('ipc_call', …)`로 채널을 직접 눌러 `{__unimplemented:true}`인지 본다(양성·음성 대조 포함) |
| `feed.mjs` / `feed-tls.mjs` | 로컬 가짜 피드(ok/404/tamper/badjson · 첫 바이트 지연 · 청크 스로틀 · 모든 히트를 UA와 함께 기록) |
| `fake_installer.rs` → `setup-ok.exe` | argv/pid/시각만 적고 끝나는 **가짜 NSIS**. 8.0MiB로 패딩한 뒤 **진짜 개인키로 서명**했다(`npx tauri signer sign -f %USERPROFILE%\.tauri\agentcodegui3-updater.key`). `setup-tampered.exe`는 마지막 1바이트만 바꾼 것 |
| `drive.mjs` | CDP 드라이버 — 0.4초마다 **화면(`.upd`의 클래스·계산된 opacity·문구·게이지 폭·버튼)** 과 **셸(`app:update-status`)** 을 같이 찍어 변화만 타임라인에 남긴다 |
| `quitprobe.mjs` | 「받아둔 채 완전히 종료」 실측 — X(트레이 숨김) → 첫 숨김 안내 카드를 CDP로 찾아 **「완전히 종료」를 그 창에서** 누른다 |
| `coldstart.mjs` | 콜드 스타트 A/B(두 팔 **번갈아** · 홈은 매 반복 새로) |
| `memprobe.mjs` | 「받아둔 설치본을 메모리에 든다」의 값 — 프로세스 트리 전체의 WorkingSet/PrivateBytes |

---

## 2. 체크리스트 8항목 — 실측

### 2.1 ① 세 채널이 더 이상 미구현 표식이 아닌가 — **닫혔다**

**내 정적 스캐너**(`chanscan.mjs`, `b20111d` 트리):

```
total 216 · impl 163 · codeRef 47 · comment 0 · missing 6
missing = ["talk:run","talk:cancel","talk:permission-respond","talk:question-respond","talk:bg-task","talk:event"]
app:update-status  impl     app:update-check  impl
app:update-install impl     app:update-event  codeRef(방출 전용)
```

**내 원시 호출**(`rawprobe.mjs` · **EXE-R** · 격리 홈):

| 채널 | 돌아온 값 | 판정 |
|---|---|---|
| `app:update-status` | `{"phase":"idle","version":null,"percent":0,"log":[],"error":null}` | 구현 |
| `app:update-check` | `null` | 구현 |
| `app:update-install` | `null` | 구현 |
| `app:update-event` | `{"__unimplemented":true}` | 방출 전용 |
| ★양성 대조 `engine:update-event` | `{"__unimplemented":true}` | **이미 구현된** 방출 전용도 같은 모양 |
| ★양성 대조 `engine:update-status` | `{"active":false,"items":[],…}` | 구현된 조회 채널은 값을 준다 |
| ★대조 `crosstalk:state` | `{"__unimplemented":true}` | 상수만 남은 죽은 채널(M10 잔여) |
| ★대조 `talk:run` | `{"__unimplemented":true}` | 알려진 missing |
| ★대조 `app:get-version` | `"3.0.0-beta.1"` | 구현 |

빌더의 「방출 전용 채널은 원래 이 모양」이라는 판별은 **양성 대조로 확인된다.**
`missing 6`도 내 스캐너에서 같은 값·같은 목록이고, 그 여섯은 M10 제거 갈래의 몫이다.
(부수: `crosstalk:*` 넷은 내 스캐너에서 `impl`이 아니라 `codeRef`로 떨어진다 — 감사 도구가
`impl`로 세는 자리다. R28k 크리틱의 각주와 같은 결론이고, **UPDATER의 몫이 아니다.**)

### 2.2 ② 패키징 빌드에서 **실제로 카드가 뜨는가** — **뜬다. 시드 0.**

`drive.mjs` · **EXE-DA** · 로컬 피드 `http://127.0.0.1:10963/latest.json`(v9.9.9 · 8.0MiB · 진짜 서명) ·
홈 `home-vis` · 시드·주입 **0**. 화면과 셸을 같이 찍은 타임라인:

| t | `.upd` class | 계산된 opacity | pointer-events | phase | 화면 문구 |
|---|---|---|---|---|---|
| 0.5s | (요소 없음) | — | — | `idle` | — |
| 5.5s | `upd show` | **1** | **auto** | `downloading` | 새 버전이 나왔어요 / `3.0.0-beta.1 → 9.9.9 · 받는 중 — 14%` |
| 5.9s | `upd show` | 1 | auto | `downloading` | … 34% |
| 6.4s | `upd show` | 1 | auto | `downloading` | … 55% |
| 6.8s | `upd show` | 1 | auto | `downloading` | … 75% |
| 7.2s | `upd show` | 1 | auto | `downloading` | … 95% |
| **7.6s** | `upd show` | 1 | auto | **`downloaded`** | **「3.0.0-beta.1 → 9.9.9 · 바로 적용돼요」 + `button.go`(업데이트) + `.later`(나중에)** |
| 7.6s | ← 「나중에」 클릭 | | | | |
| 8.0s | `upd` | **0** | **none** | `downloaded` | (화면에서 사라짐 — DOM은 남고 `.show`만 빠진다) |

`available` 단계는 첫 바이트를 3초 늦춘 피드로 따로 잡았다(별 주행): 5.6s에 `phase:"available"` ·
카드 뜸 · 게이지 0%. `.upbar i`의 `style.width`도 `16% → 36% → 56% → 77% → 97%`로 실제로 움직였다.
로그는 5%마다 한 줄(0%…100% 21줄 + 앞뒤 안내 = 24줄).

> **주의(내 계기의 한계를 먼저 적는다)**: 초반 주행에서 나는 `.upd` **요소의 존재**만 「카드」로
> 셌다. 이 컴포넌트는 접어도 DOM이 남고 `.show`만 빠지므로 그 지표는 「보인다」와 다르다.
> 그래서 위 표는 **클래스와 계산된 opacity/pointer-events를 다시 찍어** 얻은 것이다.

**「업데이트」 클릭**(별 주행 `run-s2.json` · EXE-DA):

* 클릭 **7,575ms** → 프로세스 사망 **7,979ms 이전**(관측 간격 404ms).
* 받아진 바이트가 **진짜로 실행됐다**. 가짜 설치기가 남긴 것:
  `argv = ["C:\Users\User\AppData\Local\Temp\AgentCodeGUI3-9.9.9-updater-CH1nMx\AgentCodeGUI3-9.9.9-installer.exe","/P","/R","/UPDATE","/ARGS"]`
  — tauri NSIS 템플릿의 `passive` + 재시작 + 업데이트 모드 그대로다.
  감사가 잰 「‘적용하는 중…’에서 영원히 멈춘다」는 이 칸으로 바뀌었다.

### 2.3 ③ 2.6.2가 피한 함정 — **꺼져 있다(코드 · 실측 둘 다)**

**코드**: `tauri-plugin-updater` 2.10.1에는 `autoInstallOnAppQuit` 대응물이 **없다**(크레이트 소스
`updater.rs` 전수 · 설치는 `Update::install_inner`를 **누가 부를 때만**). 셸에서 그것을 부르는
줄은 `src-tauri/src/updater.rs:294`의 `update.install(&bytes)` **하나**이고, 그 함수를 부르는 곳은
`ipc/app_meta.rs`의 `ch::UPDATE_INSTALL` 팔 하나다. `main.rs`의 `RunEvent::ExitRequested`는
업데이터를 모른다. → **참이다.** (다만 그 성질을 지킨다는 못은 §3.2에서 깨진다.)

**실측**(`quitprobe.mjs` · EXE-DA · 홈 `home-q`):

| t | 한 일 | 프로세스 | **설치기 실행 흔적** |
|---|---|---|---|
| 7.3s | `downloaded` 도달(설치본 받아둠) | 살아 있음 | **없음** |
| 7.3s | **X = 창 닫기** | | |
| 10.4s | (3초 뒤) | **살아 있음**(트레이로 숨음) | **없음** |
| 10.4s | 첫 숨김 안내 카드가 떴다 — `tray.html` · 「앱이 트레이에서 계속 실행돼요 — 눌러서 다시 열기」 / 「**완전히 종료**」 | | |
| 25.4s | **그 창에서** `trayMenu.action('quit')` | | |
| 25.9s | | **사망** | **없음** |
| 40.9s | 종료 +15초 | 사망 | **없음** |

「받아둔 채 앱을 닫아도 설치기가 백그라운드로 돌지 않는다」 — **재현됨.**
(부수로 무회귀 두 칸도 같이 확인됐다: **X = 트레이 숨김** · **트레이 안내 카드에서 완전히 종료**.)

### 2.4 ④ 개발 실행에서 no-op인가 — **완전한 0**

같은 계기·같은 피드(mode 404 = 조회 1회면 끝나는 팔)로 두 팔을 번갈아 잰 A/B:

| 팔 | exe | `location.href` | 관측된 phase | 카드 | **피드 서버 히트** | stderr `[updater]` |
|---|---|---|---|---|---|---|
| **개발**(`custom-protocol` 없음) | EXE-DEV | `http://localhost:5273/` | **`idle` 하나뿐** | **0** | **0** | **0** |
| **패키징** | EXE-DA | `http://tauri.localhost/` | `idle` → `error` | 0(조회 실패라 안 뜬다) | **1** (`/latest.json` · UA `tauri-plugin-updater/2.10.1`) | 1 |

30초 주행 두 벌에서 개발 팔의 상태는 처음부터 끝까지
`{"phase":"idle","version":null,"percent":0,"log":[],"error":null}` — **가짜 오류 카드가 뜰 자리가 없다.**
(개발 팔은 사용자가 이미 띄워 둔 vite dev 서버(:5273)를 **읽기만** 했다. 그 프로세스는 안 건드렸다.)

### 2.5 ⑤ 오류 경로가 화면에 나타나는가 — **셋 중 하나만 화면에 뜬다(2.6.2와 같은 규칙)**

| 경우 | 만든 법 | phase | **화면 카드** | 사유가 어디에 남나 |
|---|---|---|---|---|
| **네트워크 없음** | 아무도 안 듣는 포트(`:10979`)를 피드로 | `checking`→`error` | **안 뜸** | 상태 `error: "error sending request for url (http://127.0.0.1:10979/latest.json)"` · 로그 2줄 · stderr `[updater] …` |
| **피드 404** | 로컬 피드 mode=404 | `error` | **안 뜸** | 상태 `error: "Could not fetch a valid release JSON from the remote"` · 로그 2줄 · stderr 1줄 |
| **서명 불일치** | 매니페스트는 진짜 서명, 바이트는 **마지막 1바이트만 바꾼** 파일 | `downloading`→`error` | **뜸** (`.uic.err`) | 「**업데이트 오류** / **The signature verification failed** / [확인]」 · `version:"9.9.9"` · stderr 1줄 |
| ★음성 대조: 출하 exe + `http://` | **EXE-R** + `CCG_UPDATE_FEED=http://…` | `error` | 안 뜸 | `The configured updater endpoint must use a secure protocol like` \`https\`. · **피드 히트 0**(요청 자체를 안 보낸다) |
| ★출하 설정 그대로 | **EXE-R** · `CCG_UPDATE_FEED` 없음 | `error` | 안 뜸 | `Could not fetch a valid release JSON from the remote` — **진짜 GitHub 엔드포인트에 닿았다**(외부 GET 1회) |

**서명 검증은 진짜로 작동한다**: 1바이트 바꾼 8MiB를 받아 놓고도 바이트를 안 돌려주고 카드에
사유를 띄운다. 「받아둔 파일 바꿔치기 = 임의 코드 설치」가 막히는 자리를 실측으로 확인했다.

**「조회 실패는 카드를 안 띄운다」는 회귀가 아니다.** 3.0의 `app/src/components/AppUpdateGate.tsx`는
2.6.2 `src/renderer/src/components/AppUpdateGate.tsx`와 **바이트가 같다**(`diff` 결과 0). 카드 조건
`phase==='error' && status?.version != null`이 2.6.2가 정한 규칙이다. 다만 체크리스트 5번이 요구한
「셋을 눌러라」 중 **둘은 화면에 아무것도 남기지 않는다** — 이 사실은 §3.3에 결함으로 적는다.

### 2.6 ⑥ 2.6.2와 의미가 같은가 — **`UpdateStatus` 5칸 · 이벤트 6종 전부 대조됨**

3.0은 **실제 방출**로, 2.6.2는 소스(`src/main/updater.ts`)로 대조했다.
`app:update-status`가 돌려준 객체의 키는 언제나 정확히 `phase, version, percent, log, error`
(= `src/shared/protocol.ts:1073` `UpdateStatus`. 추가 필드 0).

| 2.6.2 electron-updater 이벤트 | 2.6.2 상태 | 3.0에서 **내가 관측한** phase | 관측 주행 |
|---|---|---|---|
| `checking-for-update` | `checking` + 「업데이트를 확인하는 중…」 | ✅ `checking` + **같은 문구** | `run-e3` · `run-none` |
| `update-available` | `available` + 「새 버전 v{v}을(를) 찾았어요 · 다운로드를 시작합니다」 | ✅ `available` + **같은 문구** | `run-avail`(첫 바이트 3초 지연 피드) |
| `update-not-available` | `none` + 「이미 최신 버전이에요」 | ✅ `none` + **같은 문구** (피드 버전을 1.0.0으로 낮춰서) | `run-none` |
| `download-progress` | `downloading` + `percent` + 5%마다 「다운로드 {p}% · {a} / {b} MB」 | ✅ `downloading` · `percent` 0→100 · **5%마다 21줄, 같은 서식** | `run-s1` |
| `update-downloaded` | `downloaded` + 「다운로드 완료 · 업데이트 버튼으로 적용할 수 있어요」 | ✅ `downloaded` + **같은 문구** | `run-s1` |
| `error` | `error` + 사유 + 「업데이트 중 오류가 발생했어요」 | ✅ `error` + 사유 + **같은 문구** | `run-e1/e2/e3` |
| (`idle` 시드) | 마운트 시드 | ✅ `idle` | 전 주행 |

**「더 새 버전인가」의 판정도 같은 코드다**: 3.0은 `ccg_engine::versions::cmp_desc`를 쓰고, 그 함수는
2.6.2 `src/main/engine/versions.ts:117 compareVersionsDesc`의 **줄 대 줄 이식본**이다(내가 두 소스를
나란히 읽고 확인: 같은 분해·같은 `(pb[i]??0)-(pa[i]??0)`·같은 조기 반환). 사본을 만들지 않았다는
주장은 참이다.

**★30분 주기 재확인 + `probing` 침묵 규칙 — 37분 주행으로 실측했다.**
(2.6.2가 `probing`을 만든 이유가 「'나중에'로 접은 카드가 30분마다 되뜨는 것」이므로, 이 축은
30분을 실제로 기다리지 않으면 한 줄도 검증되지 않는다. 단위 테스트는 `is_newer`만 덮는다.)

| 시각(피드 기준) | 무슨 일 |
|---|---|
| 15s | 첫 조회 `/latest.json` + `/setup.exe` — 카드 뜸 → `downloaded` |
| 7.3s(앱 기준) | **「나중에」 클릭**(카드 접음) |
| **1815s = 정확히 30:00 뒤** | **`/latest.json` 1회만.** `/setup.exe` **0회** |
| 7.3s ~ 2250s(37.5분) | phase `downloaded` **불변** · `version`·`percent`·문구·게이지·버튼 **전부 불변** · 로그 24줄 **불변**(재확인이 로그를 지우지 않았다) · stderr `[updater]` **0줄** |

phase가 다시 구르지 않았으므로 `AppUpdateGate`의 `setDismissed(false)`(phase 전이에서만 발화)도
안 불렸다 — **접은 카드가 되뜨지 않았고, 같은 설치본을 다시 받지도 않았다.** 2.6.2와 같은 값(30분),
같은 침묵.

### 2.7 ⑦ 키·토큰이 샜는가 — **안 샜다. 외부 쓰기 0.**

| 검사 | 결과 |
|---|---|
| `git log --all --diff-filter=A -- "*.key" "*.pem" "*.pfx" "*.p12"` | **빈 결과** — 그런 파일이 레포에 들어온 적이 없다 |
| `git show 971e3f7 55a4549`에서 `secret key`/`private key`/`rsign encrypted`/`BEGIN .*PRIVATE`/`ghp_`/`github_pat_`/`gho_`/`ghs_` | **0건** |
| 두 커밋이 더한 100자 이상 base64 | **딱 하나** — `dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6…` = 디코드하면 `untrusted comment: minisign public key: E6F4DF7236E55E46`. **공개키다** |
| 레포 안의 개인키 흔적 | 경로 문자열(`%USERPROFILE%\.tauri\agentcodegui3-updater.key`)만 문서에 있고, 내용은 없다. 실제 키 파일은 레포 **밖**에 있다(존재 확인만 했고 내용은 읽지도 출력하지도 않았다) |
| **push 여부** | `git log origin/feature/3.0.0-beta..HEAD` = **142 커밋**. 이 브랜치는 원격에 **한 번도 안 올라갔다** → push 0 |
| 태그 | `v3*` 태그 **0개** |
| 외부 행위 | **GET만 2회** — ① 내 `curl`이 `https://github.com/UnrealFactory/AgentCodeGUI/releases/latest/download/latest.json`(→ **404** · `releases/latest`가 지금 **v2.6.2**로 풀린다) ② EXE-R 주행이 같은 주소를 1회. **릴리스 생성/삭제 0 · 태그 푸시 0 · 원격 쓰기 0** |
| 내가 개인키를 쓴 곳 | 가짜 설치기 1개를 **로컬에서** 서명(`npx tauri signer sign -f <경로>`)했다. 출력은 서명(공개값)뿐이고 키 내용은 화면·파일·커밋 어디에도 안 남았다 |

### 2.8 ⑧ 무회귀

| 축 | 대조군(EXE-C / `7c4494d` 격리 트리) | 이 라운드(`b20111d` 격리 트리) | 판정 |
|---|---|---|---|
| exe 크기 | **6,474,240 B** | **7,066,112 B** (**+591,872 B = +578 KiB**) | 빌더 주장과 일치 |
| 컴파일 경고 | **4** (`CROSSTALK_*` 미사용 상수 넷 — M10 제거 잔여) | **4** (**같은 넷**) | 더한 것 **0** |
| `cargo test --workspace` | **751 passed · 0 failed · 13 ignored** | **756 passed · 0 failed · 13 ignored** · **exit 0** | **+5** |
| 크레이트별(이 라운드) | — | agentcodegui **136** · ccg-auth **126** · ccg-engine **232** · ccg-fs **101** · ccg-lsp **59** · ccg-store **85** | 실패 0 |
| ★`agentcodegui` 기본 병렬 10회 연속 | — | **136 / 136 / 136 / 136 / 136 / 136 / 136 / 136 / 136 / 136 = 1360/1360 · 실패 0** | R28g의 240/240에서 **후퇴 없음** |
| typecheck | — | `typecheck:node` ✅ · `typecheck:web` ✅ · `typecheck:app` ✅ | 3종 초록 |
| **콜드 스타트**(spawn→`#root` 마운트 · 두 팔 번갈아 · **16회씩**) | median **517 ms** (min 451 / max 3300) | median **522 ms** (min 480 / max 912) | **+5 ms** — 잡음 안. 업데이터는 부팅을 안 늦춘다(첫 조회가 5초 뒤 자기 스레드에서 일어나므로 임계 경로 밖) |
| 트레이 · X=숨김 | — | X → 앱 생존 + 트레이 안내 카드 → 「완전히 종료」로 정상 종료(§2.3) | 정상 |

> 지시서 기준선(agentcodegui 170 · ccg-engine 233 · ccg-store 92 · workspace 798)은 **M10 제거
> 이전** 값이라 이 트리와 직접 비교되지 않는다. 그래서 부모 커밋을 **같은 방식·새 target으로 내가
> 직접 재서** 대조군을 만들었다. 남의 미추적 계기(`probe_wfire_crit.rs` 8 + `probe_wfr2.rs` 10 = 18)는
> `git archive` 트리에 없어 위 수에 **안 들어 있다**.
>
> (부수 사고 하나: 측정 도중 C: 여유가 620MB까지 떨어져 한 차례 테스트가 ENOSPC로 흔들렸다.
> 내 target 둘(11GB)을 지우고 **전부 다시 돌린 값이 위 표다.** 흔들린 회차는 버렸다.)

---

## 3. 남은 결함 — 등급 · 재현 절차

### 3.1 【중간】 `npm run tauri:build`가 **종료 코드 1**로 끝난다 — 그리고 그걸 시키는 문서엔 새 조건이 없다

`tauri.conf.json`에 `plugins.updater.pubkey`와 `bundle.createUpdaterArtifacts: true`가 들어가면서,
tauri CLI가 번들 끝에 **서명 단계를 필수로** 돈다. 개인키 환경변수가 없으면 **실패한다.**

**재현**(내가 실제로 돌린 그대로):

```
cd C:\Code\AgentCodeGUI
set CARGO_TARGET_DIR=C:\Code\AgentCodeGUI\target-r28j-upd-critbundle
npx tauri bundle
```

```
    Finished 1 bundle at:
        …\bundle\nsis\AgentCodeGUI3_3.0.0-beta.1_x64-setup.exe

A public key has been found, but no private key. Make sure to set `TAURI_SIGNING_PRIVATE_KEY` environment variable.
       Error A public key has been found, but no private key. …
```
→ **종료 코드 1.** (`echo %ERRORLEVEL%` 대신 `EXITCODE_NOKEY=1`로 확인)

같은 명령에 `TAURI_SIGNING_PRIVATE_KEY=%USERPROFILE%\.tauri\agentcodegui3-updater.key` ·
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD=` 를 얹으면 **종료 코드 0**이고
`AgentCodeGUI3_3.0.0-beta.1_x64-setup.exe.sig`(436 B)가 같이 나온다. **문서의 릴리스 절차 자체는 옳다.**

**무엇이 문제인가.**

1. `docs/HANDOFF-3.0.md:119`는 다음 라운드에게 「**`npm run tauri:build`를 써라**」라고 시킨다.
   `src-tauri/Cargo.toml:13`도 같은 말을 한다. **둘 다 이 새 조건을 모른다.**
   그 명령을 그대로 따르는 사람·스크립트는 **성공한 빌드를 실패로 읽는다**(설치기는 나온다).
2. 반대로 오류를 무시하고 `.sig` 없이 릴리스를 올리면 **`latest.json`을 쓸 수가 없고**, 그러면
   깔린 앱들은 영원히 「최신입니다」만 본다 — 조용한 쪽으로 망가진다.
3. 빌더 보고서 §8.2는 이 환경변수를 **「릴리스 절차」 안에만** 적었다. 「이제 **모든** 번들 빌드가
   이걸 요구한다」는 문장은 없다.

**고칠 자리**(빌더 몫): `docs/HANDOFF-3.0.md`의 빌드 지시와 `src-tauri/Cargo.toml`의 빌드 주석에
한 줄씩. 또는 `package.json`의 `tauri:build`가 키를 env로 실어 주게.

### 3.2 【낮음】 「종료 시 자동 설치 금지」를 지킨다는 못이 **진짜 종료 문을 안 본다**

`src-tauri/src/updater.rs:554 install_is_never_wired_to_exit`은 두 가지를 본다:
① 이 파일 안의 `.install(` 호출이 정확히 하나 ② **`main.rs`** 가 `updater::install`을 모른다.

그런데 사용자가 실제로 앱을 끝내는 문은 `src-tauri/src/tray.rs:160 fn quit()`이다
(트레이 메뉴 「완전히 종료」와 첫 숨김 안내 카드 둘 다 여기로 온다 → `app.exit(0)`).
`main.rs`는 그 뒤에 오는 `RunEvent` 핸들러일 뿐이다.

**재현**(레포가 아니라 내 격리 트리 `C:\Temp\ccg-r28j-updcrit\head`에서):

```rust
 fn quit(app: &AppHandle) {
     QUITTING.store(true, Ordering::SeqCst);
+    crate::updater::install(app);   // ← 2.6.2가 밟은 바로 그 사고
     app.exit(0);
 }
```

```
$ cargo test -p agentcodegui install_is_never_wired_to_exit
running 1 test
test updater::tests::install_is_never_wired_to_exit ... ok      ← 통과한다
test result: ok. 1 passed; 0 failed; …
```

컴파일 경고도 안 붙는다(기존 4개 그대로). **못이 막겠다고 선언한 바로 그 회귀가 못을 그냥 지나간다.**
(실증 뒤 격리 트리는 원상복구했고, 레포 `src-tauri/src/tray.rs`는 처음부터 손대지 않았다 —
`git status`로 확인.)

**고칠 자리**: 못이 읽을 파일에 `tray.rs`를 더하거나(같은 `include_str!` 한 줄), 더 낫게는
`src-tauri/src` 전체에서 `updater::install`을 부르는 곳이 **`ipc/app_meta.rs` 하나뿐**임을 세는 형태로.

### 3.3 【낮음】 오류 셋 중 둘은 **화면에 아무 흔적이 없다**

네트워크 없음 · 피드 404 → 카드 0. 사용자가 볼 수 있는 곳은 없다(설정 화면에 업데이트 상태를
보여 주는 자리가 없다 — `app:update-status`를 읽는 곳은 `AppUpdateGate` 하나다). 남는 곳은
셸 stderr와 인메모리 상태뿐이고, **둘 다 사용자에게 안 보인다.**

이것은 **2.6.2와 바이트가 같은 컴포넌트의 규칙**이므로 파리티 회귀가 아니다(그래서 「낮음」이다).
그러나 체크리스트 5번의 문장(「셋을 만들어 눌러라 · 조용히 사라지면 불합격」)을 글자대로 읽으면
둘은 화면에서 조용히 사라진다. **판정: 파리티로는 합격, 사용자 관점에서는 미해결.**
2.6.2와 같이 가는 것이 이 라운드의 계약이므로 **고치라고 요구하지 않는다** — 다만
「3.0에서도 오프라인 조회 실패는 화면에 안 뜬다」가 알려진 성질로 장부에 남아야 한다.

**재현**: 피드를 죽인 포트로 두고(`CCG_UPDATE_FEED=http://127.0.0.1:10979/latest.json`) EXE-DA를 띄운 뒤
`window.api.app.getUpdateStatus()` → `phase:"error"`인데 `document.querySelector('.upd')` → `null`.

### 3.4 【낮음】 받아둔 설치본이 **세션 내내 메모리에 산다**

`updater.rs:111 pending: Option<(Box<Update>, Vec<u8>)>`. `Vec`은 청크마다 `extend`로 자라므로
용량이 **파일 크기의 최대 2배**까지 잡힌다.

**실측**(`memprobe.mjs` · EXE-DA · 같은 계기로 두 팔 · 프로세스 트리 합):

| 시점 | 팔 A(mode=ok · 8.0MiB 받음) | 팔 B(mode=404 · 안 받음) | 차이 |
|---|---|---|---|
| 정착 후(양쪽 프로세스 5개) | WS 441.0 MB · PV 230.7 MB | WS 431.2 MB · PV 215.7 MB | **WS +9.3 MB · PV +14.3 MB** |

1회 측정이라 잡음이 섞여 있다. **공정하게 덧붙인다**: 내 가짜 설치기는 8.0MiB지만
**진짜 NSIS 설치기는 2,813,261 B**(내가 방금 구운 것)라, 실제 유지량은 ~3~6MB급이다.
2.6.2는 이 파일을 디스크 캐시에 두었다. 빌더는 이 갈라짐을 **알면서** 했고 이유(재검증 경로가
비공개라 검증 없는 재사용은 임의 코드 설치가 된다)도 타당하다 — 다만 **값이 장부에 없었다.**
같은 이유로 **앱을 껐다 켤 때마다 2.8MB를 다시 받는다**(30분마다가 아니라 실행마다 한 번).

### 3.5 【낮음】 출하 바이너리에 **업데이트 주소 갈아끼우는 문**이 있다

`updater.rs:79 pub const FEED_ENV: &str = "CCG_UPDATE_FEED"` — 릴리즈 exe에서도 살아 있고,
내가 이 크리틱의 모든 실측에 그 문을 썼다(그러니 유용하다). 방어는 두 겹이다:
`https` 강제(§2.5 음성 대조로 실측) + minisign 검증(§2.5 tamper로 실측) + 플러그인의
`release.version > current_version`(다운그레이드 차단). 그래서 **실효 공격은 「그 사용자의 환경변수를
이미 쥔 자가, 우리 개인키로 서명된 더 높은 버전을 골라 설치시키는 것」**으로 좁다.

그래도 2.6.2에는 없던 문이고, 「이 축을 실측할 수 있어야 한다」는 이유는 **테스트 편의**다.
남겨 둘 거라면 그 판단이 장부에 있어야 하고(현재 `updater.rs` 주석에는 있다 · `renderer-divergence.md`
§6.12의 「알면서 다르게 한 것 둘」에는 **없다**), 지울 거라면 `#[cfg(debug_assertions)]`가 자연스럽다.

### 3.6 【낮음 · 장부】 같은 라운드의 두 커밋 메시지가 **서로 다른 수치**를 적었다

| 출처 | agentcodegui | workspace |
|---|---|---|
| `971e3f7` 커밋 메시지 「■ 검증」 | **179 (+5)** | **807** |
| `55a4549` 커밋 메시지 「■ 수치」 | **136 (+5)** | **756** |
| **내 측정**(`b20111d` 격리 트리 · 깨끗한 디스크) | **136** | **756** |

앞 커밋의 두 수는 틀렸고 정정되지 않았다. 커밋 메시지는 되돌릴 수 없는 장부이므로,
다음 문서 커밋에서 「971e3f7의 179/807은 오기이며 참값은 136/756」이라고 한 줄 박아야 한다.
(대조군 `7c4494d`도 내가 직접 쟀다: **131 / 751**. `+5`라는 증분 자체는 두 메시지 다 맞다.)

### 3.7 【정보】 새 주석·문서의 줄 번호 셋이 어긋난다

| 적힌 곳 | 적힌 값 | 실제(`55a4549`) |
|---|---|---|
| `renderer-divergence.md` §6.12 | `App.tsx:2670` | **2651** |
| `updater.rs` 헤더 · §6.12 | `AppUpdateGate.tsx:47` (카드 조건) | **48** |
| `updater.rs:104` | `AppUpdateGate.tsx:36` (dismissed 해제) | **38** |

(`AppUpdateGate.tsx:108`(설치 버튼)·`protocol.ts:1074`(phase 유니온)은 정확했다.)

---

## 4. 진짜로 닫힌 것 — 요약표

| 체크리스트 | 판정 | 근거 |
|---|---|---|
| ① 세 채널이 미구현 표식이 아닌가 | **닫힘** | 내 스캐너 missing 6(전부 `talk`) + 원시 호출 9칸(양성·음성 대조 포함) |
| ② 패키징 빌드에서 카드가 진짜 경로로 뜨는가 | **닫힘** | 시드 0 · `class="upd show"` · `opacity:1` · 게이지 14%→95% · 「바로 적용돼요」 · 클릭 → 설치기 `/P /R /UPDATE /ARGS` 실행 + 앱 404ms 내 사망 |
| ③ 종료 시 자동 설치가 꺼져 있는가 | **닫힘**(코드·실측) — 단 **못은 부실**(§3.2) | 받아둔 채 X→트레이→완전히 종료 → 설치기 0 · +15초 후에도 0 |
| ④ 개발 실행 no-op | **닫힘** | phase `idle` 하나 · 카드 0 · **피드 히트 0** · `[updater]` 0 (패키징 팔은 히트 1) |
| ⑤ 오류 경로가 화면에 | **부분** | 서명 불일치는 카드로 뜬다. 네트워크 없음·404는 안 뜬다(2.6.2와 같은 규칙 · §3.3) |
| ⑥ 2.6.2와 의미가 같은가 | **닫힘** | `UpdateStatus` 5칸 일치 · 이벤트 6종 전부 **실제 방출로** 관측 · 문구 글자 일치 · `cmp_desc` = `compareVersionsDesc` · **30분 재확인/probing 침묵을 37분 주행으로 실측** |
| ⑦ 키·토큰 유출 · 외부 행위 | **닫힘** | 키 파일 커밋 이력 0 · 공개키만 · push 0(142 커밋 미푸시) · 태그 0 · 릴리스 생성 0 · 외부는 GET 2회 |
| ⑧ 무회귀 | **닫힘** — 단 **빌드 명령은 회귀**(§3.1) | 크기 +578KiB · 경고 4→4 · 테스트 751→756 · 크레이트별 실패 0 · 10회 연속 1360/1360 · typecheck 3종 · 콜드 스타트 +5ms(잡음 안) · 트레이/X=숨김 정상 |

---

## 5. 내가 만진 것

* **레포 코드 수정 0.** 커밋하는 것은 **이 파일 한 장**뿐(`docs/critic/r28j-updater-critic-r1.md`).
* 남의 소유 파일(`src-tauri/**` · `app/**` · `bench/**` · `docs/critic/*.json` ·
  `docs/parity-fix-*` · `progress/**` · `engine/talk.rs`)은 **읽기만** 했다.
  §3.2의 못 실증은 **레포가 아니라** `C:\Temp\ccg-r28j-updcrit\head`(git archive 사본)에서 했고
  원상복구했다. `git status`로 `src-tauri/src/tray.rs`가 안 건드려졌음을 확인했다.
* 남의 미커밋 변경은 `reset`·`checkout`·`stash`·`restore` 하지 않았다.
  (라운드 도중 HEAD가 두 번 움직였고 — `b9f5701`·`b20111d` — 남의 WIP가 워킹트리에 다시 나타났다.
  그래서 **모든 최종 수치는 `git archive` 격리 트리에서 다시 낸 것**이다.)
* 기준 결과 파일(`bench/results/*` · `bench/shots/*/report.json` · `docs/critic/*.json`)은
  **하나도 안 덮었다.** 내 계기 출력은 전부 `C:\Temp\ccg-r28j-updcrit\`에 있다.
* 새로 만든 것(레포 밖 · 미커밋): `chanscan.mjs` · `rawprobe.mjs` · `feed.mjs` · `feed-tls.mjs` ·
  `drive.mjs` · `quitprobe.mjs` · `coldstart.mjs` · `memprobe.mjs` · `fake_installer.rs` ·
  `setup-ok.exe(+.sig)` · `setup-tampered.exe` · 주행 JSON(`run-*.json` · `feed-*.json` ·
  `coldstart*.json` · `mem.json` · `rawprobe.json`) · 격리 트리 `head`/`ctl` ·
  exe 사본 `exe-head-release.exe`/`exe-ctl-release.exe`.
* target: `target-r28j-upd-crit`(주 팔) · `-critctl`(대조군) · `-critda` · `-critdev` ·
  `-crit2`(테스트) · `-critbundle`(번들). **남의 target은 하나도 안 썼다.** 측정이 끝난 두 개
  (`-crit`·`-critctl`, 11GB)는 exe를 떠 놓고 지웠다 — C: 여유가 620MB였다.
* 사용자 기계: 이름 기반 kill **0**(내가 스폰한 PID만) · 실홈 `accounts/`·`codex-accounts.json`
  **읽지도 않음** · **인증서 저장소 변경 0**(§1.2의 시도는 Root에 들어가기 전에 취소했고
  `CurrentUser\My`에 생긴 임시본과 키 파일까지 지운 것을 확인했다) · 사용자가 띄워 둔 앱과
  vite dev 서버(:5273)는 **읽기만** 했다.
* 외부: **GET 2회**(위 §2.7). push · 태그 · 릴리스 생성/삭제 · 원격 쓰기 **0**.
