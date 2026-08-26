# R28j UPDATER 수정 R1 — 앱 자동 업데이트 통로를 세운다 (최종 파리티 R5 §9.1 `N8`)

> 사용자가 결정한 것: **2.6.2와 같게 구현한다.**
> 최종 파리티 감사 R5가 「치명 0 · 출하 차단 해제」를 선언하고 남긴 **높음 둘** 중
> 하나(`N3` `app:open-directory`)는 R28i에서 닫혔다. 이 라운드는 **마지막 높음**이다.

---

## 0. 한 문장

`AppUpdateGate` 카드는 R28i까지 **어떤 경로로도 뜰 수 없었다**(방출자 0 · 업데이터 0 ·
`plugins` 설정 0). 이제 셸이 그 카드에 값을 넣는다 — 패키징 빌드에서 **조회 → 다운로드
진행률 → 「바로 적용돼요」 카드 → 「업데이트」 클릭 → 설치기 기동 + 앱 종료**까지
로컬 정적 피드로 화면에서 확인했고(§4), 개발 실행에서는 **피드에 한 번도 안 묻는다**(§6).
계약면 `missing`은 **9 → 6**(§7).

**렌더러는 한 글자도 안 고쳤다.** 이 라운드가 만진 것은 셸(`src-tauri/`)과 문서뿐이다.

> **★확인 크리틱 R1 뒤의 수정은 §11에 있다.** 여덟 항목 중 일곱은 크리틱의 손에서도
> 닫혔고, 남은 회귀 하나(`npm run tauri:build`가 종료 코드 1)와 부실한 못 하나를
> 고쳤다 — 재현·수정·재실측 전부 §11.

---

## 1. 무엇이 없었는가 (감사가 잰 것 · 내가 다시 확인한 것)

최종 파리티 R5 §9.0이 자기 exe로 재 둔 상태:

| 축 | R5 §9.0 실측 |
|---|---|
| 원시 `app:update-check` · `app:update-event` · `app:update-install` | 셋 다 `{"__unimplemented":true}` (**9/9** · install도 눌렀고 3초 뒤 앱 생존) |
| 셸의 방출자 · 업데이터 크레이트 · `tauri.conf.json` `plugins` | **전부 0** |
| 화면(`AppUpdateGate`) | **살아 있다** — 시드만 심으면 카드가 뜬다(ready 3/3 · downloading 3/3 대 bare 0/3) |
| 사용자 문장 | 출하된 3.0 사용자는 앱 안에서 새 버전을 **알 수도 받을 수도 없다** |

즉 결함은 하나 — **「앱 안에 갱신 통로가 없다」** — 이고 채널 셋이 그 하나를 이룬다.

---

## 2. 왜 Tauri 공식 플러그인인가 (직접 구현 대신)

`tauri-plugin-updater` 2.10.1 · `default-features = false` · `features = ["native-tls"]`.

**고른 이유.** 이 축에서 어려운 부분은 「조회」도 「다운로드」도 아니다. 둘이다.

1. **패키지 진위 판정.** 우리는 코드 서명서가 없다. 그러면 받은 바이트가 진짜 우리 것인지
   말해 주는 것은 **서명 검증 하나뿐**이다. 플러그인은 minisign 검증을 `download()` 안에
   갖고 있고(`updater.rs:1453 verify_signature` → `PublicKey::verify`), **검증에 실패하면
   바이트 자체를 안 돌려준다**. 이걸 손으로 다시 쓰면 틀렸을 때 조용한 쪽이 보안이다.
2. **NSIS 기동 규약.** 받은 `.exe`를 임시 경로에 쓰고 `ShellExecuteW`로
   `/P /R /UPDATE /ARGS …`를 붙여 띄운 뒤 `exit(0)` — 그 인자 조합이 tauri NSIS 템플릿과
   짝을 이룬다(우리 설치기가 그 템플릿이다). 실측으로 그대로 돌았다(§4.3).

**구조가 맞는가**(지시가 물은 것): 맞다. NSIS 설치본 · 트레이 상주 · 커스텀 스플래시 셋 다
걸림돌이 아니었다.

* **NSIS** — 플러그인의 Windows 경로가 곧 NSIS 경로다. `installMode: "passive"`(`/P /R`).
* **트레이 상주** — `exit(0)`이 `RunEvent::ExitRequested`를 건너뛰므로 트레이 아이콘을
  놓는 코드가 안 돈다(죽은 아이콘이 알림 영역에 남는다). 플러그인이 그 자리를 열어 뒀다:
  `UpdaterBuilder::on_before_exit` — **추출 성공 뒤 `ShellExecuteW` 바로 앞**에 불린다.
  거기서 `crash::begin_shutdown()` → `win::tray::release_icon()` → `engine::shutdown()`을
  `main.rs`의 정상 종료와 **같은 순서로** 부른다(`updater.rs` `build()`).
* **커스텀 스플래시** — 필요 없어졌다. 2.6.2가 스플래시를 만든 이유는 `/S`(무음)가 화면을
  통째로 비웠기 때문이고, `passive`는 NSIS가 자기 진행 막대를 그린다. 그 스플래시에 딸려
  있던 함정 둘(detached PowerShell 기동 불가 · cmd 8191자 한계 — 2.6.2 `updater.ts:210-216`)도
  같이 사라진다.

**피처 선택의 근거**(`src-tauri/Cargo.toml` 주석과 같다):
`rustls-tls` 대신 `native-tls`는 `ccg-auth`가 이미 내린 결정과 **같은 근거**다(OS 스토어=
schannel · 번들 루트 인증서 없음 · 바이너리 −890KB의 선례). `zip`은 끈다 — 업데이트
아티팩트가 NSIS `.exe` 한 장이고(v1 호환 zip을 안 만든다) 켜면 zip·tar·flate2가 따라온다.

**바이너리 비용**(**같은 부모 커밋** · 같은 프로파일 · **서로 다른 `CARGO_TARGET_DIR`** —
함정 9: 대조군에 target 재활용 금지):

| 빌드 | 트리 | exe 크기 |
|---|---|---|
| 업데이터 **없음**(대조군) | `971e3f7^` = `7c4494d` · `t2-base` | **6,474,240 B** |
| 업데이터 **있음** | `971e3f7`(이 라운드) · `t2-ship` | **7,066,112 B** |
| **차이** | | **+591,872 B (+578 KB)** |

---

## 3. 무엇을 배선했나

### 3.1 채널 셋 (계약면 `src/shared/protocol.ts` 그대로 · 새 채널 0)

| 채널 | 자리 | 하는 일 |
|---|---|---|
| `app:update-status` | `ipc/app_meta.rs` → `updater::status()` | 카드가 마운트 때 읽는 **시드**(구독 전 이벤트를 놓치지 않게). R28i까지 하드코딩 `idle`이었다 |
| `app:update-check` | 〃 → `updater::check(app)` | 조회를 건다(수동 방아쇠). 주기 확인은 셸이 스스로 돈다 |
| `app:update-install` | 〃 → `updater::install(app)` | 받아둔 설치본을 적용 = 카드의 「업데이트」 버튼. **설치를 부르는 유일한 통로** |
| `app:update-event` | `updater::emit()` → `emit_to(win::MAIN, …)` | 상태 푸시. 페이로드는 `UpdateStatus` 그대로 |

> **`app:update-event`는 원시 `ipc_call`에 답하지 않는다** — 그것이 **방출 전용 채널의
> 모양**이다. 2.6.2도 `ipcRenderer.invoke('app:update-event')`는 "No handler registered"로
> 거절한다. 같은 성질의 **양성 대조**를 같은 주행에서 같이 쟀다:
>
> | 원시 `ipc_call(ch, [])` | 결과 |
> |---|---|
> | `app:update-status` | `{"phase":"idle",…}` → 나중에 `{"phase":"downloaded","version":"9.9.9",…}` |
> | `app:update-check` | **`null`** (R5에서는 `{"__unimplemented":true}`) |
> | `app:update-install` | **`null`**(받아둔 게 없을 때 · 앱 생존) / 받아둔 게 있으면 앱이 끝난다 |
> | `app:update-event` | `{"__unimplemented":true}` ← **방출 전용** |
> | **`engine:update-event`**(이미 구현된 엔진 축의 방출 전용 채널 · 양성 대조) | `{"__unimplemented":true}` ← **같은 모양** |
> | `engine:update-status`(양성 대조) | `{"active":false,…}` |
> | `ccg:no-such-channel-r28j`(음성 대조) | `{"__unimplemented":true}` |
>
> 즉 `app:update-event`의 `__unimplemented`는 「미구현」이 아니라 「invoke가 아니라 listen으로
> 쓰는 채널」이라는 뜻이고, 그 판별은 옆 칸의 `engine:update-event`가 해 준다.

### 3.2 상태기계 — 2.6.2의 이벤트 6종을 그대로 접는다

| 2.6.2 electron-updater | 3.0 `src-tauri/src/updater.rs` |
|---|---|
| `checking-for-update` | `run_check` 진입 — `phase:"checking"` · 로그 초기화 |
| `update-available` | `check().await == Ok(Some(_))` — `phase:"available"` + 버전 |
| `update-not-available` | `Ok(None)` — `phase:"none"` |
| `download-progress` | `Update::download`의 `on_chunk` — `phase:"downloading"` + % |
| `update-downloaded` | 다운로드 반환(= **서명 검증 통과**) — `phase:"downloaded"` |
| `error` | 위 어느 단계의 `Err` — `phase:"error"` + 사유 |

같이 이식한 규칙:

* `autoDownload = true` — 찾는 즉시 백그라운드 다운로드.
* **30분 주기 재확인** + `probing`(받아둔 뒤엔 조용한 재확인 — 같은 버전이면 상태를 일절
  안 건드려 '나중에'로 접은 카드가 되뜨지 않고, 더 새 버전이면 일반 흐름으로 복귀).
  「더 새 것인가」의 판정은 `ccg_engine::versions::cmp_desc`(= 2.6.2 `compareVersionsDesc`의
  이식본)를 **그대로 쓴다** — 사본을 만들지 않는다.
* 로그 한 줄은 **5%마다**(2.6.2와 같은 눈금). 실측 로그가 §4.2에 있다.

### 3.3 ★같이 피한 함정 — 「종료 시 자동 설치」

2.6.2 `updater.ts:59-65`가 주석으로 남긴 **실제 사고**: 종료 시 자동 설치는 화면 없이 NSIS가
「이전 버전 삭제 → 새 파일 복사」를 도는데 그 사이에 PC가 꺼지면 **앱이 통째로 사라진다**.

3.0에서 이 함정은 **구조적으로 없다**. `tauri-plugin-updater`에 `autoInstallOnAppQuit`에
해당하는 것이 아예 없고, 설치는 `Update::install()`을 **누군가 부를 때만** 일어난다.
그리고 그 호출부는 `updater::install()` **하나**다 — 종료 경로(`main.rs`의
`RunEvent::ExitRequested`)는 이 모듈을 아예 모른다.

그 성질을 **못으로 박았다**(`updater::tests::install_is_never_wired_to_exit`):
`updater.rs` 본문(테스트·주석 제외)에서 `.install(`을 부르는 줄이 **정확히 1개**여야 하고,
`main.rs`가 `updater::install`이라는 글자를 **포함하면 안 된다**. 다음 라운드가 "종료할 때
겸사겸사 설치하자"를 한 줄 더하는 순간 이 못이 먼저 부러진다.

---

## 4. 실측 — 패키징 빌드에서 **정말 도는가**

### 4.0 측정 재료

| 항목 | 값 |
|---|---|
| 판정 트리 | **`git archive 971e3f7`**(= 이 라운드의 코드 커밋) → `C:\Temp\ccg-r28j-upd\wt2`. 대조군은 **그 부모** `git archive 971e3f7^`(=`7c4494d`) → `wt2-base`. **같은 워킹트리에서 남의 미커밋 WIP를 안 들고 온다** — 이 라운드 도중 그 WIP가 실제로 컴파일 불가 상태였고(`engine/hub.rs`가 없는 `talk` 모듈을 참조), 레포에서 그냥 빌드했다면 내 결과가 남의 손에 좌우됐다 |
| 프론트 | `npm run app:build` — vite **✓ 2.13s** · 번들 `index-30PlNFFQ.js` |
| **출하 설정 exe** | `cargo build --release --features custom-protocol` · `CARGO_TARGET_DIR=…\t2-ship` · **2m19s** · **7,066,112 B** · sha256 `92d34c4689296e96c3e3a9a4e9c0106103bd2140fe9dcb0124a91264085f343d` |
| 대조군 exe(업데이터 없음) | `wt2-base` · `t2-base` · 2m11s · 6,474,240 B |
| **하네스 exe** | 같은 소스 · `tauri.conf.json`에 **키 하나만 더함**(`dangerousInsecureTransportProtocol: true` — 로컬 `http://` 피드를 쓰려고) · `wt2-h` · `t2-h` · 2m15s · 7,066,112 B |
| **개발 실행 exe**(no-op 대조군) | 같은 소스 · `cargo build -p agentcodegui`(**`custom-protocol` 없음** = `tauri::is_dev()`가 참) · `t2-dev` · 29,132,800 B |
| 경고 | 출하 4 · **대조군도 4**(전부 `ipc/mod.rs`의 `CROSSTALK_*` 미사용 상수 — R28k M10 제거가 남긴 것으로 **내 변경이 더한 경고는 0**) |
| `custom-protocol` 증표 | 방금 구운 번들 이름이 exe 바이트 안에 있다 — `index-30PlNFFQ.js` **FOUND**. 그리고 주행의 `location.href`가 **`http://tauri.localhost/`**(패키징) 대 **`http://localhost:5273/`**(개발) |
| 가짜 피드 | `C:\Temp\ccg-r28j-upd\feed.mjs` — 로컬 정적 릴리스(포트 10905 ok · 10907 404 · 10908 tamper · 10909 dev대조). **요청을 전부 기록**한다 |
| 가짜 설치본 | `AgentCodeGUI3_9.9.9_x64-setup.exe` **8,525,824 B** — 자기 argv를 파일에 적고 즉시 끝나는 rustc 단일 파일 exe + 8MB 패딩. **아무것도 설치하지 않는다**. `tauri signer sign`으로 서명 |
| 드라이버 | `C:\Temp\ccg-r28j-upd\drive.mjs` — CDP로 0.4초마다 **카드와 셸 상태를 같이** 찍는다. **시드는 아무것도 안 심는다** |
| CDP 포트 | **10900~10911**(UPDATER 배정표 준수) |
| 격리 | 홈은 드라이버가 직접 쓴다 — **실홈(`%USERPROFILE%\.agentcodegui`)을 읽지도 복사하지도 않는다** · 이름 기반 kill 0(내가 스폰한 PID만 · 종료 뒤 내 target 경로 잔류 프로세스 0) |
| 산출물 | `C:\Temp\ccg-r28j-upd\run-c-*.json` · `feed-log-*.json`(**레포에 안 남긴다** — 기준 결과 파일을 덮지 않으려고) |
| ★외부 GET | `https://github.com/UnrealFactory/AgentCodeGUI/releases/latest/download/latest.json` — **조회 2회**(초판·재측정 각 1 · §5의 「피드 404」 실측). **쓰기 0 · 릴리스 생성/삭제 0 · push 0 · 태그 0** |

### 4.1 카드가 **스스로** 뜬다 (감사의 스텁 대조군과 정반대 방향)

감사 R5 §9.0.4는 **시드를 심어** 화면이 살아 있음을 증명했다. 여기서 증명할 것은 반대다 —
**셸이 값을 만든다**. 그래서 이 하네스는 아무것도 안 심는다. 심는 것은 피드뿐이다.

`c-full-ok` 주행(하네스 exe · 로컬 ok 피드) 타임라인 — 0.4초마다 **카드와 셸 상태를 같이** 찍은 것:

```
ms     phase        %    .upd  .upbar  barW    button.go   화면 문구
5      available     0     1      0      -         0        새 버전이 나왔어요 3.0.0-beta.1 → 9.9.9 · 받는 중 — 0%
409    downloading  14     1      1     14%        0        … 받는 중 — 14%
814    downloading  28     1      1     26%        0        … 받는 중 — 26%
1223   downloading  40     1      1     40%        0        … 받는 중 — 40%
1633   downloading  54     1      1     54%        0        … 받는 중 — 54%
2041   downloading  68     1      1     66%        0        … 받는 중 — 66%
2450   downloading  80     1      1     80%        0        … 받는 중 — 80%
2860   downloading  94     1      1     94%        0        … 받는 중 — 94%
3267   downloaded  100     1      0      -         1        새 버전이 나왔어요 3.0.0-beta.1 → 9.9.9 · 바로 적용돼요 [나중에] [업데이트]
```

게이지(`.upbar i`의 width)가 **14% → 94%로 실제로 움직였고**, 다 받으면 게이지가 사라지고
「업데이트」 버튼이 생긴다(`goBtn 0 → 1`). 이 모든 값의 출처는 셸이다 — 심은 것은 없다.
8.1MB를 받는 데 **약 3.3초**(피드가 128KB/45ms로 흘렸다).

### 4.2 로그(카드가 펼쳐 보여 주는 줄) — 5% 눈금

```
업데이트를 확인하는 중…
새 버전 v9.9.9을(를) 찾았어요 · 다운로드를 시작합니다
다운로드 0% · 0.0 / 8.1 MB
다운로드 5% · 0.4 / 8.1 MB
…
다운로드 95% · 7.8 / 8.1 MB
다운로드 100% · 8.1 / 8.1 MB
다운로드 완료 · 업데이트 버튼으로 적용할 수 있어요
```

### 4.3 ★「업데이트」를 누르면 (`c-full-click` 주행)

```
ms=3297  phase=downloaded  카드 = 「… 바로 적용돼요 [나중에] [업데이트]」  → click
ms=3709  프로세스 사망 (dead=true)
가짜 설치기가 남긴 argv:
  C:\Users\User\AppData\Local\Temp\AgentCodeGUI3-9.9.9-updater-L7OJgi\AgentCodeGUI3-9.9.9-installer.exe
  /P  /R  /UPDATE  /ARGS
```

**설치기가 실제로 떴고 앱은 그 직후 끝났다**(클릭 → 사망 **412ms**). 인자 `/P /R /UPDATE`가
tauri NSIS 템플릿의 「passive · 설치 후 재시작 · 업데이트 모드」 그대로다.

감사 R5 §9.0.5가 잰 자리(「적용하는 중…」에서 **영원히 멈춘다**)가 이 칸으로 바뀌었다.

> 진짜 설치는 안 했다 — 받아지는 것이 **아무것도 설치하지 않는 가짜 설치기**다.
> 이 주행이 증명하는 것은 「받은 바이트가 검증을 통과했고, 추출되어, 올바른 인자로
> 실행됐고, 앱이 자리를 비켜 줬다」까지다. 실제 NSIS 덮어쓰기는 릴리스 리허설의 몫이다(§9).

---

## 5. 오류 네 경로 — **무엇이 화면에 뜨는가** (전부 실측)

| 경우 | 어떻게 만들었나 | `phase` 이동 | 카드 | 화면 문구 / 상태의 `error` |
|---|---|---|---|---|
| **네트워크 없음** | 피드 포트에 아무도 안 듣게(`:10906`) | `checking` → `error` | **안 뜬다**(`.upd` 0) | 상태 `error`: `error sending request for url (http://127.0.0.1:10906/latest.json)` · 로그 「업데이트를 확인하는 중… / 업데이트 중 오류가 발생했어요」 · stderr `[updater] …` |
| **피드 404** | 로컬 피드 `mode=404`(`:10907`) · **그리고 출하 설정으로 진짜 GitHub 주소에 1회** | → `error` | **안 뜬다**(`.upd` 0) | 상태 `error`: `Could not fetch a valid release JSON from the remote` — **두 경우 같은 문구** |
| **서명 불일치** | 로컬 피드 `mode=tamper`(`:10908`) — 매니페스트는 정상, **페이로드 마지막 바이트를 뒤집는다**(길이 동일 → 진행률은 100%까지 간다) | `available` → `downloading` → `error` | **뜬다**(`.upd` 1 · `.uic.err` 1) | 카드: **「업데이트 오류 · The signature verification failed · [확인]」** |
| **디스크(설치기 임시 파일) 실패** | `TEMP`/`TMP`를 **파일 경로**로 돌려 `tempfile`이 임시 폴더를 못 만들게 | `downloading` → `downloaded` → (클릭) → `error` | **뜬다**(`.uic.err` 1 · `[확인]` 1) | 카드: **「업데이트 오류 · 지정된 경로를 찾을 수 없습니다. (os error 3) at path "…\temp-is-a-file.txt\AgentCodeGUI3-9.9.9-updater-209alG" · [확인]」** · **앱은 살아 있다** |
| (음성 대조) 출하 설정 + `http://` 피드 | 출하 exe에 `CCG_UPDATE_FEED=http://…` | → `error` | 안 뜬다 | 상태 `error`: ``The configured updater endpoint must use a secure protocol like `https`.`` · **피드 히트 0**(요청 자체를 안 보낸다) |

**「안 뜬다」가 왜 정답인가 — 그리고 그것이 침묵은 아니라는 것.**
카드가 뜨는 조건은 `AppUpdateGate.tsx:47-48`이고 **2.6.2와 같은 컴포넌트·같은 조건**이다:
`error`는 **`version != null`일 때만** 카드가 된다. 즉 「업데이트가 진행되던 중」의 실패는
말하고, 「그냥 조회가 안 됐다」는 말하지 않는다 — 오프라인일 때마다 오류 카드가 뜨는 앱이
더 나쁘기 때문이고, 그 판단은 2.6.2가 이미 내려 둔 것이다. 여기서 바꾸면 그게 회귀다.

다만 그 실패가 **사라지지는 않는다**. 위 표의 모든 칸에서 확인한 것:
`app:update-status`가 `phase:"error"` + `error` 문구를 들고 있고(카드가 아니어도 조회하면
보인다), `log`에 「업데이트 중 오류가 발생했어요」가 남고, 셸 stderr에 `[updater] <사유>`가
찍힌다. **조용히 사라지는 칸은 없다.**

**디스크 실패 뒤의 회복도 쟀다.** 설치가 실패하면 받아둔 설치본을 **되돌려 놓으므로**
그 다음 확인 주기에 카드가 다시 「바로 적용돼요 [업데이트]」로 돌아온다(같은 주행의
`finalStatus.phase = "downloaded"` · `goBtn = 1`). 그리고 그 실패 경로에서는
`on_before_exit`가 **아직 안 돌았다**(플러그인은 추출 성공 뒤에 부른다) — 그래서 엔진도
트레이도 멀쩡한 채로 앱이 계속 산다.

---

## 6. 개발 실행은 **no-op이다** (A/B · 판별력 있는 계기)

「가짜 오류 카드가 뜨면 안 된다」를 증명하려면 「안 뜬다」만으로는 부족하다 —
**가설이 거짓인 세계에서는 켜지는** 계기여야 한다. 그래서 **같은 계기·같은 피드**로 둘을 잰다.

| 팔 | exe | `location.href` | 주행 내내 본 `phase` | `.upd` 카드 | **피드 서버 히트** | stderr `[updater]` |
|---|---|---|---|---|---|---|
| **개발 실행**(30초) | `t2-dev\debug`(**`custom-protocol` 없음**) | `http://localhost:5273/` | **`idle` 하나뿐** | **0** (모든 프레임) | **0** | **없음** |
| **패키징**(같은 계기·같은 피드 소스) | `t2-h\release`(`custom-protocol`) | `http://tauri.localhost/` | `available → downloading → downloaded` | **1** | **10**(매니페스트 5 · 페이로드 5) | 있음 |

개발 실행에서 제품 경로도 같이 눌렀다: `window.api.app.checkForUpdate()` → `null`(throw 없음),
원시 `app:update-install` → `null` + **앱 생존**, `app:update-status` → `{"phase":"idle",…}` 유지.
**아무 일도 안 일어난다** — 2.6.2의 `app.isPackaged` 게이트와 같은 성질이다.

게이트의 정체: `tauri::is_dev()`이고, 그 정의가 정확히 이 레포의 규약이다 —
`tauri-2.11.5/src/lib.rs:308` `pub const fn is_dev() -> bool { !cfg!(feature = "custom-protocol") }`.
`custom-protocol`은 이 레포가 이미 「프로덕션 빌드 표식」으로 쓰는 그 피처다.

---

## 7. 계약면 재고

`node docs/critic/tools/critic-r28e-channels.mjs` (감사와 **같은 계기**):

| 시점 | total | impl | commentOnly | **missing** | 남은 것 |
|---|---|---|---|---|---|
| 감사 R5 기준선(`31fd975`) | 216 | 206 | 0 | **10** | `talk` 6 + `app` 4 |
| R28i N3 착지 뒤(`57e55e6` · 내가 직접 재확인) | 216 | 207 | 0 | **9** | `talk` 6 + `app:update-*` 3 |
| **이 라운드 뒤**(`7c4494d` 트리 + 내 변경) | 216 | **210** | 0 | **6** | **`talk` 여섯뿐** |

채널 **수(216)는 안 움직였다** — 새 계약면 채널을 만들지 않았다.

> 남은 6은 `talk:{run,cancel,permission-respond,question-respond,bg-task,event}`이다.
> R28k가 M10(「대화 연결」)을 **제거하는 중**이라 Rust 구현이 통째로 걷혔고, 계약면
> (`src/shared/protocol.ts` = 2.6.2 원본)에는 상수가 남아 있어 스캐너가 `missing`으로 센다.
> **내 축이 아니다** — 그 6의 처분은 M10 제거 갈래의 몫이다.

---

## 8. 릴리스 절차 · 키 관리 (★리드가 읽을 자리)

### 8.1 키

`tauri signer generate`로 minisign 키 한 쌍을 만들었다.

| 무엇 | 어디 | 커밋 |
|---|---|---|
| **개인키** | `%USERPROFILE%\.tauri\agentcodegui3-updater.key` (**암호 없음**) | **절대 금지**. 레포 어디에도 없다 |
| 공개키 | `%USERPROFILE%\.tauri\agentcodegui3-updater.key.pub` | 내용이 `tauri.conf.json` `plugins.updater.pubkey`에 들어갔다(공개키는 공개해도 되는 값이다) |
| 키 ID | `E6F4DF7236E55E46` | — |

> **개인키를 잃으면 그 뒤로 자동 업데이트가 끊긴다** — 이미 깔린 앱은 새 공개키를 모르므로
> 새 키로 서명한 패키지를 전부 거절한다(그때는 수동 재설치 안내가 유일한 길이다).
> 그러니 이 파일은 **백업 대상**이고, 팀 릴리스로 넘어가면 CI 시크릿
> (`TAURI_SIGNING_PRIVATE_KEY` · `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`)으로 옮긴다.
> 옮길 때 **암호를 새로 걸어 다시 만드는 편이 낫다**(지금 것은 로컬 단독용이라 암호가 없다).

### 8.2 릴리스 한 번의 순서

1. 버전 상승(두 곳: `src-tauri/tauri.conf.json` `version` · `Cargo.toml` `workspace.package.version`).
2. 번들:
   ```
   npm run tauri:build
   ```
   ★**서명 키를 손으로 얹을 필요가 없다**(수정 R1 · §11.1). `scripts/tauri-build.mjs`가
   `%USERPROFILE%\.tauri\agentcodegui3-updater.key`를 찾아 `TAURI_SIGNING_PRIVATE_KEY`로
   실어 준다 — **내용이 아니라 경로**를 넘기므로 키가 로그에 남을 자리가 없다.
   키가 다른 자리에 있으면 `set CCG_UPDATER_KEY=<키 경로>`.
   `bundle.createUpdaterArtifacts: true`라 NSIS `*-setup.exe`와 **짝이 되는 `*-setup.exe.sig`**가
   같이 나온다(실측 **436 B**).
   ★**키가 없으면 빌드는 시작조차 하지 않는다**(0.62초 만에 종료 코드 1 + 사유 · §11.1).
   그렇게 만든 이유는 「서명 없는 릴리스」가 **조용한 고장**이기 때문이다 — `.sig`가 없으면
   `latest.json`을 쓸 수 없고, 깔린 앱들은 영원히 「최신입니다」만 본다. 서명 없이 설치기만
   필요한 자리(로컬 확인)는 `npm run tauri:build:unsigned`로 **명시적으로** 간다.
3. GitHub Release에 **셋**을 올린다: `*-setup.exe` · `*-setup.exe.sig` · **`latest.json`**.
   `latest.json`의 모양(플러그인이 요구하는 정적 형식 · 하네스가 실제로 먹인 것과 같다):
   ```json
   {
     "version": "3.0.0",
     "notes": "…",
     "pub_date": "2026-…T…Z",
     "platforms": {
       "windows-x86_64": {
         "signature": "<*-setup.exe.sig 파일의 내용 전체>",
         "url": "https://github.com/UnrealFactory/AgentCodeGUI/releases/download/v3.0.0/AgentCodeGUI3_3.0.0_x64-setup.exe"
       }
     }
   }
   ```
4. **★프리릴리스로 올리지 마라.** 설정의 주소가
   `…/releases/latest/download/latest.json`인데 GitHub의 `latest`는 **프리릴리스를 제외한다**.
   베타 채널을 쓰려면 그 주소를 태그 고정(`…/releases/download/v3.0.0-beta.2/latest.json`)으로
   바꾸거나, 정식 릴리스로 올려야 한다. (이 판정은 문서로만 적는다 — 이 라운드는 릴리스를
   만들지 않았으므로 실측이 아니다.)

### 8.3 리허설 통로

`CCG_UPDATE_FEED=<매니페스트 URL>`을 주면 설정의 주소 대신 그것을 쓴다. 스테이징 피드로
리허설할 때 쓰는 문이고, 이 라운드의 §4~§6 실측이 전부 그 문으로 들어갔다.
**릴리즈 빌드에서 `https://`가 아닌 값을 주면 플러그인 자신이 거절하고**(§5 음성 대조)
그 사유가 그대로 카드/상태에 올라온다 — 조용히 무시되지 않는다.

---

## 9. 남은 것 · 정직하게

1. **실제 NSIS 덮어쓰기 설치는 안 쟀다.** 받아진 것이 가짜 설치기라 「추출 → 올바른 인자로
   기동 → 앱 종료」까지가 이 라운드의 사실이고, 「이전 버전 위에 덮어쓰고 다시 뜬다」는
   릴리스 리허설(진짜 설치본 두 벌 + 로컬 피드)의 몫이다. 그것을 하려면 **설치기를 실제로
   돌려야** 하므로 사용자 기계 상태를 바꾼다 — 이 라운드의 범위 밖으로 뒀다.
2. **GitHub Releases에서 실제로 받아 본 적은 없다.** 진짜 릴리스를 만드는 것이 금지라
   출하 설정으로 잰 것은 **404 응답**뿐이다(§5). 자산이 올라간 뒤 첫 릴리스에서
   §8.2의 4번(프리릴리스 함정)을 반드시 확인해야 한다.
3. **받아둔 설치본은 다음 실행으로 안 넘어간다**(설계 · `renderer-divergence.md` §6.12).
   2.6.2는 pending 캐시로 재사용했다. 앱을 껐다 켜면 다시 받는다(실측 8.1MB에 ~4초).
4. **`app:update-check`를 이미 받아둔 상태에서 또 부르면 다시 받는다**(`probing`이 아닌
   일반 사이클로 돈다). 화면에서 그 채널을 부르는 곳은 **0**이고(2.6.2도 같다) 주기 확인은
   `probing`으로 돌므로 제품 경로에는 안 나타난다. 하네스에서 관측한 그대로 적어 둔다.
5. **다국어 문구는 표시 시점에 고른다**(`ui.lang`). 실행 중에 언어를 바꾸면 **이미 쌓인
   로그 줄은 옛 언어로 남는다** — 2.6.2도 같다.
6. `src-tauri/src/updater.rs`의 `en_ui()`는 `tray.rs`의 같은 이름 함수와 **같은 한 줄**이다
   (`ui-prefs`의 `"ui.lang"`). 원본 데이터는 한 곳이지만 술어가 두 벌이다 — `tray.rs`가 내
   소유 밖이라 이번엔 합치지 않았다. 셋째 벌이 생기면 그때 합치는 것이 맞다.
7. **(수정 R1)** 조회 단계 실패는 **화면에 아무 흔적이 없다**(§11.3) · 받아둔 설치본이
   세션 내내 메모리에 산다(§11.4 · `PV +14.3MB`) · 출하 바이너리에 `CCG_UPDATE_FEED`가
   살아 있다(§11.5 · 남기는 근거와 방어 세 겹). 셋 다 **알면서 남긴 것**이고 장부로 옮길
   문장은 §11.9에 있다.
8. **(수정 R1)** 이제 `npm run tauri:build`는 **서명 개인키가 있어야 초록**이다(§11.1).
   개인키를 잃으면 릴리스가 막히고(§8.1), CI로 옮길 때는 `TAURI_SIGNING_PRIVATE_KEY`를
   시크릿으로 넣으면 래퍼가 그것을 그대로 쓴다(래퍼가 덮지 않는다).

---

## 10. 만진 것

### 10.1 빌드·테스트 수치

**타입체크 3종 초록**: `npm run typecheck`(node·web) · `npm run typecheck:app`.

**cargo test** — 격리 트리(`git archive`)에서 크레이트별로. 대조군은 **같은 방식으로 잰
부모 커밋**이다. 지시서의 기준선(agentcodegui 170 · ccg-engine 233 · ccg-store 92 ·
workspace 798)은 **R28k M10 제거 이전 값**이라 이 트리와 직접 비교되지 않는다 —
그래서 부모를 직접 쟀다.

| 크레이트 | `971e3f7^`(=`7c4494d`) | **`971e3f7`(이 라운드)** | 차이 |
|---|---|---|---|
| agentcodegui | 131 | **136** | **+5**(이 라운드의 못) |
| ccg-auth | — | 126 | 0 |
| ccg-engine | — | 232 | 0 |
| ccg-fs | — | 101 | 0 |
| ccg-lsp | — | 59 | 0 |
| ccg-store | — | 85 | 0 |
| **workspace** | — | **756 passed · 0 failed** | **+5** |

**바이너리**: 6,474,240 B(대조군) → **7,066,112 B** = **+591,872 B (+578 KB)**.
**경고**: 4 → 4(더한 것 0 · 넷 다 M10 제거가 남긴 `CROSSTALK_*` 미사용 상수).

**못 다섯**(`src-tauri/src/updater.rs`):
`snapshot_is_the_contract_shape`(계약면 키 다섯) ·
`phase_names_match_the_renderer`(화면이 읽는 문자열) ·
`probing_stays_silent_unless_a_newer_one_appears`(조용한 재확인) ·
`percent_and_log_steps`(게이지·5% 눈금 · `Content-Length` 없음/과소 방어) ·
**`install_is_never_wired_to_exit`**(2.6.2의 「종료 시 자동 설치」 사고 재발 방지 · §3.3).

**미추적 계기 제외**: `crates/ccg-engine/tests/probe_wfire_crit.rs`·`probe_wfr2.rs`는
남의 것이라 커밋하지 않았고, 격리 트리(`git archive`)에는 애초에 안 들어가므로
위 수치에도 **안 들어 있다**.

### 10.2 파일

| 파일 | 무엇 |
|---|---|
| `src-tauri/src/updater.rs` | **신규** — 상태기계 + 3채널 몸통 + 못 5개 |
| `src-tauri/Cargo.toml` | `tauri-plugin-updater` (default-features off · native-tls) + 선택 근거 |
| `Cargo.lock` | 위 해결(새 크레이트 11 — 대부분 macOS/Linux 타깃 한정) |
| `src-tauri/tauri.conf.json` | `plugins.updater`(endpoints · pubkey · installMode passive) + `bundle.createUpdaterArtifacts` |
| `src-tauri/src/main.rs` | `mod updater` · 플러그인 등록 · `setup`에서 `updater::init` |
| `src-tauri/src/ipc/mod.rs` | `ch::UPDATE_{CHECK,INSTALL,EVENT}` 상수 · `app_meta::dispatch`에 `AppHandle` 전달 |
| `src-tauri/src/ipc/app_meta.rs` | 3채널 팔(하드코딩 `idle` 제거) |
| `docs/renderer-divergence.md` | §6.12 신설 |
| `docs/parity-fix-updater-r1.md` | 이 문서 |

**레포에 안 남긴 것**(하네스 · `C:\Temp\ccg-r28j-upd\`): `feed.mjs`(로컬 정적 피드) ·
`drive.mjs`(CDP 드라이버) · `fake_installer.rs`(가짜 설치기) · `run-c-*.json`(주행 기록) ·
`feed-log-*.json`(피드 히트) · `wt2`/`wt2-base`/`wt2-h`(격리 트리) · `t2-*`(타깃 디렉터리).
기준 결과 파일(`bench/results/*` · `bench/shots/*/report.json` · `docs/critic/*.json`)은
**하나도 안 건드렸다**.

### 10.3 커밋

| 해시 | 무엇 |
|---|---|
| `971e3f7` | 코드 — 업데이터 본체 + 3채널 배선 + 설정 |
| `55a4549` | 문서 — `renderer-divergence.md` §6.12 + 이 보고서 |
| (수정 R1 · §11) | 빌드 파이프라인 · 못 · 장부 |

---

## 11. ★확인 크리틱 R1 대응 — 수정 R1

판정문: `docs/critic/r28j-updater-critic-r1.md`(커밋 `2116e6c` · 1파일 467줄 · 레포 코드 수정 0).
**여덟 항목 중 일곱은 크리틱의 손에서도 닫혔다** — 시드 0으로 카드가 스스로 떴고, 「업데이트」가
진짜 설치기를 `/P /R /UPDATE /ARGS`로 띄웠고, 받아둔 채 완전히 종료해도 설치기가 0이었고,
개발 팔은 피드에 한 번도 안 물었다(히트 0 대 패키징 1). 이 절은 **닫히지 않은 목록**을 받는다.

> **이 절의 수치는 전부 내가 다시 냈다.** 크리틱의 값을 인용한 자리는 「크리틱 실측」이라고
> 적었다. 빌드는 `CARGO_TARGET_DIR=target-r28j-upd`(UPDATER 몫), 로그는
> `C:\Temp\ccg-r28j-updr2\`에 있다.

### 11.1 【중간】 `npm run tauri:build`가 종료 코드 1 — **고쳤다**

**먼저 내 손으로 재현했다**(고치기 **전** 워킹트리 · 그때의 `tauri:build` = `tauri build`):

| 팔 | 명령 | 종료 코드 | `*-setup.exe` | `*-setup.exe.sig` | 걸린 시간 |
|---|---|---|---|---|---|
| **고치기 전** | `npm run tauri:build` | **1** | **2,811,711 B — 나온다** | **없다** | 전체 빌드 |
| 고친 뒤 · 키 있음 | `npm run tauri:build` | **0** | 2,810,332 B | **436 B** | 전체 빌드 |
| 고친 뒤 · 키 없음 | `CCG_UPDATER_KEY=C:\nope\missing-key.key npm run tauri:build` | **1** | — (cargo를 **켜지도 않는다**) | — | **0.62초** |
| 고친 뒤 · 서명 안 함 | `npm run tauri:build:unsigned` | **0** | 2,811,784 B | **안 만든다**(의도 · 미리 지워 두고 확인) | 전체 빌드 |

「고치기 전」 팔의 마지막 두 줄(내 로그 그대로):

```
    Finished 1 bundle at:
        …\bundle\nsis\AgentCodeGUI3_3.0.0-beta.1_x64-setup.exe

A public key has been found, but no private key. Make sure to set `TAURI_SIGNING_PRIVATE_KEY` environment variable.
       Error A public key has been found, but no private key. …
```

**즉 크리틱이 옳다.** 설치기는 다 나온 뒤에 죽으므로 그 명령을 시키는 문서를 따르는 사람·스크립트는
**성공한 빌드를 실패로 읽고**, 반대로 오류를 무시하고 올리면 `.sig` 없는 릴리스가 나가
`latest.json`을 쓸 수 없게 되어 깔린 앱들이 영원히 「최신입니다」만 본다.

**무엇을 넣었나** — `scripts/tauri-build.mjs`(신규 · `package.json`의 `tauri:build`·`tauri:bundle`이
이걸 거친다):

1. **키를 찾아 env로 실어 준다.** 순서는 `TAURI_SIGNING_PRIVATE_KEY`(이미 설정됨) →
   `CCG_UPDATER_KEY`(경로) → `~/.tauri/agentcodegui3-updater.key`. ★**키 내용을 읽지 않는다** —
   CLI가 경로도 받으므로 **경로만** 넘긴다(로그·콘솔에 키가 실릴 자리가 아예 없다).
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`가 없으면 빈 문자열을 넣는다 — 없으면 CLI가 **대화형으로
   물어보고 그 자리에서 멈추기** 때문이다(이 레포가 이미 밟은 「모달이 스크립트를 잡아먹는」 함정).
2. **키가 없으면 cargo를 켜기 전에 끝낸다**(0.62초). 10분을 태우고 마지막 줄에서 죽는 대신
   0초에 무엇을 해야 하는지 세 갈래로 말한다. **조용한 성공(=서명 없는 릴리스)은 만들지 않는다.**
3. 서명 없이 설치기만 필요한 자리에는 **명시적인 문**을 준다 — `npm run tauri:build:unsigned`가
   `--config {"bundle":{"createUpdaterArtifacts":false}}`를 얹어 서명 단계 자체를 없애고,
   「이 설치기는 릴리스에 올리지 마라」를 세 줄 찍는다.

**그 조건을 적은 자리**(크리틱이 「한 줄도 없다」고 지적한 두 곳 + 절차):
`docs/HANDOFF-3.0.md` 함정 2번 · `src-tauri/Cargo.toml`의 빌드 주석 · 이 문서 §8.2.

**★그런데 「exit 0 + `.sig`가 나온다」로는 부족하다.** 래퍼가 **엉뚱한 키**를 골라도
`.sig`는 나온다(`~/.tauri`에는 다른 프로젝트의 키 쌍이 두 벌 더 있다). 그러면 릴리스는
「성공」한 채로 나가고 깔린 앱들은 **서명 검증 실패**로 영원히 못 올라온다 — 내가 막겠다던
바로 그 조용한 고장이다. 그래서 **산출물 자체를 검사했다**:

| 검사 | 값 |
|---|---|
| 래퍼가 고른 키의 공개 반쪽(`…key.pub`) 대 `tauri.conf.json`의 `pubkey` | **base64까지 바이트 동일**(`untrusted comment: minisign public key: E6F4DF7236E55E46`) |
| `.sig`의 키 ID 대 공개키의 키 ID | `465ee53672dff4e6` = `465ee53672dff4e6` — **일치** |
| 서명 알고리즘 | `ED`(prehashed) → 메시지 = `BLAKE2b-512(setup.exe)` |
| **Ed25519 검증**(출하 공개키로 · 내가 손으로) | `setup.exe` 2,811,474 B · `.sig` 436 B → **true** |
| 음성 대조: 설치기 **마지막 1바이트만** 뒤집고 같은 검증 | **false** |

즉 이 명령이 만든 릴리스는 **깔린 앱이 실제로 받아들일 수 있는 서명**을 갖는다.
(검증은 레포 밖 한 줄짜리 node 스크립트로 했다 — 개인키는 쓰지도 읽지도 않았다.
공개키·서명·설치기 바이트만 있으면 되는 계산이다.)

`npm run tauri:bundle`(번들만 다시 굽는 길)도 같은 래퍼를 거친다 — **exit 0 + `.sig` 436 B**로
확인했다(크리틱이 `npx tauri bundle`로 exit 1을 잡았던 바로 그 명령이다).

### 11.2 【낮음】 「종료 시 자동 설치 금지」 못이 진짜 종료 문을 안 본다 — **고쳤고, 부러지는 것을 눈으로 봤다**

크리틱이 옳다. 옛 못은 `main.rs` **한 파일만** 읽었는데, 사용자가 실제로 앱을 끝내는 문은
`tray.rs`의 `quit()`이다(트레이 메뉴 「완전히 종료」와 첫 숨김 안내 카드가 **둘 다** 거기로 온다
→ `app.exit(0)`). `main.rs`의 `RunEvent::ExitRequested`는 그 **뒤에** 오는 핸들러일 뿐이다.

**새 못은 파일을 고르지 않는다**: `src-tauri/src` 전수를 걸어 `updater::install`을 부르는
**파일의 집합**을 세고 그 집합이 `ipc/app_meta.rs` 하나임을 박는다(`include_str!`은 컴파일 시각
상수라 전수를 못 한다 — 그래서 테스트 실행 시각에 `CARGO_MANIFEST_DIR`부터 디렉터리를 걷는다).
빈 트리를 보고 「통과」하지 않도록 파일 수 하한과, **진짜 종료 문 둘의 앵커**
(`main.rs`의 `RunEvent::ExitRequested` · `tray.rs`의 `app.exit(0)`)도 같이 확인한다.

**실증** — 격리 사본(`git archive HEAD` → `C:\Temp\ccg-r28j-updr2\nailtree`)에서
`tray.rs::quit()`에 크리틱과 **같은 한 줄**을 심고, 옛 못과 새 못을 **같은 바이너리에 나란히**
넣어 한 번에 돌렸다(이렇게 하면 「스테일 바이너리를 본 것 아니냐」가 원천 봉쇄된다 —
새 못의 실패 메시지가 doctored 파일 이름을 그대로 뱉으므로 그 회차가 doctored 트리를 읽었다는
증거가 된다):

```rust
 fn quit(app: &AppHandle) {
     QUITTING.store(true, Ordering::SeqCst);
+    crate::updater::install(app); // ← 2.6.2가 밟은 바로 그 사고
     app.exit(0);
 }
```

```
test updater::tests::old_nail_reads_only_main_rs ... ok        ← 옛 못은 **그냥 통과한다**(크리틱 §3.2 재현)
test updater::tests::install_is_never_wired_to_exit ... FAILED ← 새 못은 부러진다

assertion `left == right` failed: 설치를 부르는 파일이 카드 한 곳이 아니다
  left: ["ipc/app_meta.rs", "tray.rs"]
 right: ["ipc/app_meta.rs"]
```

깨끗한 레포 트리에서는 다시 초록이다(`updater::tests` 5/5 · `-p agentcodegui` 137/137).
실증 뒤 격리 사본은 그대로 두고 **레포 `src-tauri/src/tray.rs`는 한 글자도 안 건드렸다**
(`git status`로 확인 — 이 라운드가 만진 Rust 파일은 `updater.rs` 하나다).

### 11.3 【낮음】 조회 단계 실패는 화면에 안 뜬다 — **고치지 않는다. 알려진 성질로 장부에 박는다**

크리틱의 판정(파리티로는 합격 · 사용자 관점에서는 미해결)에 동의한다. 카드 조건
`phase==='error' && version != null`은 **2.6.2와 바이트가 같은 컴포넌트**가 정한 규칙이고
(오프라인일 때마다 오류 카드가 뜨는 쪽이 더 나쁘다), 이 라운드의 계약은 「2.6.2와 같게」다.
그래서 코드를 안 고치고 **장부에 알려진 성질로 적었다**(`renderer-divergence.md` §6.12):
네트워크 없음·피드 404는 `app:update-status`의 `phase:"error"`+사유+로그와 셸 stderr
`[updater] …`에만 남고 **화면에는 아무것도 안 남는다.** 바꾸려면 그것은 **2.6.2에서 갈라지는
결정**이므로 리드의 몫이다(설정 화면에 업데이트 상태 칸을 만드는 쪽이 자연스럽다).

### 11.4 【낮음】 받아둔 설치본이 세션 내내 메모리에 산다 — **값을 장부에 넣었다**

크리틱 실측: 팔 A(8.0MiB 받음) 대 팔 B(404) = **WorkingSet +9.3MB · PrivateBytes +14.3MB**
(1회 측정 · 프로세스 트리 합). 갈라짐 자체(§10.1 ①: 디스크 캐시 대신 세션 메모리)는 검증
경로가 비공개라서 한 선택이고 크리틱도 「이유는 타당하다」고 적었다 — **없던 것은 값이었다.**
그 값과, 실제 설치기가 **2.81MB**(내가 방금 구운 NSIS setup.exe)라 유지량이 ~3~6MB급이라는
것, 그리고 **앱을 껐다 켤 때마다 한 번 다시 받는다**는 것을 §6.12에 적었다.

### 11.5 【낮음】 출하 바이너리의 `CCG_UPDATE_FEED` — **남긴다. 판단을 장부에 적었다**

크리틱이 준 두 갈래(장부에 적기 / `#[cfg(debug_assertions)]`로 지우기) 중 **남기기**를 골랐다.
근거:

* **지우면 출하 exe를 검사할 길이 같이 사라진다.** 크리틱 자신이 §2.5의 **음성 대조**
  (「출하 exe는 `http://` 피드를 아예 거절한다 · 요청 히트 0」)와 「출하 엔드포인트에 실제로
  닿는다」를 그 문으로 쟀다. `cfg(debug_assertions)`로 가리면 그 두 칸은 **출하 바이너리에서**
  다시는 못 잰다.
* **실효 공격면이 좁다.** 세 겹이 이미 있다 — `https` 강제(플러그인 · 실측) · minisign 서명 검증
  (실측: 1바이트 변조를 8MiB 받아 놓고도 거절) · `release.version > current_version`(다운그레이드
  차단). 남는 것은 **「그 사용자의 환경변수를 이미 쥔 자」가 우리 개인키로 서명된 더 높은
  버전을 골라 설치시키는 것**뿐이고, 그 전제(임의 env 주입)를 가진 자는 이미 더 나쁜 짓을 할 수 있다.
* 2.6.2에 없던 문인 것은 사실이므로 **§6.12의 「알면서 다르게 한 것」에 ③으로 올렸다** —
  크리틱이 「거기에 없다」고 지적한 바로 그 자리다.

### 11.6 【낮음 · 장부】 `971e3f7` 커밋 메시지의 수치 오기 — **정정한다**

**`971e3f7`의 「agentcodegui 179(+5) · workspace 807」은 오기다. 참값은 136 / 756이다**
(`55a4549`가 적은 값이 맞다). 커밋 메시지는 되돌릴 수 없으니 여기에 박아 둔다.

내가 이 라운드에서 다시 잰 값과 그 분해:

| 크레이트 | 내 워킹트리(수정 R1) | 크리틱의 HEAD 측정 | 차이의 정체 |
|---|---|---|---|
| `agentcodegui` | **137** | 136 | **+1 = 남의 미커밋**(`src-tauri/src/engine/mod.rs`에 `#[test]` 하나) |
| `ccg-auth` | 143 | 126 | 크리틱의 크레이트별 값이 통합 테스트 셋(14+2+1=**17**)을 빼고 세어졌다 — 워크스페이스 합계끼리는 맞는다 |
| `ccg-engine` | **250** | 232 | **+18 = 남의 미추적 계기** `probe_wfire_crit.rs`(8) + `probe_wfr2.rs`(10) |
| `ccg-fs` | 101 | 101 | 같음 |
| `ccg-lsp` | 59 | 59 | 같음 |
| `ccg-store` | 85 | 85 | 같음 |
| **workspace** | **775 passed · 0 failed · 13 ignored · exit 0** | 756 | **775 = 756 + 18 + 1** — **이 라운드가 더한 테스트는 0개다**(못을 제자리에서 갈아 끼웠다) |

### 11.7 【정보】 줄 번호 셋 — 정정했다

| 자리 | 옛 값 | 새 값 |
|---|---|---|
| `updater.rs` 헤더 · `renderer-divergence.md` §6.12 | `App.tsx:2670` | **`App.tsx:2651`**(`<AppUpdateGate />`) |
| `updater.rs` `phase` 주석 · 못 주석 | `AppUpdateGate.tsx:47` | **`:47-48`**(`const active`) · 못 쪽은 **`:48`** |
| `updater.rs:104`(`probing`) | `AppUpdateGate.tsx:36` | **`:38`**(`setDismissed(false)`) |

셋 다 **가리키는 심볼 이름을 같이 적었다** — 다음에 또 밀려도 읽는 사람이 스스로 찾을 수 있게.

### 11.8 무회귀 (수정 R1)

| 축 | 값 | 판정 |
|---|---|---|
| `cargo test --workspace` | **775 passed · 0 failed · 13 ignored · exit 0** | 초록(분해는 §11.6) |
| `cargo test -p agentcodegui` | **137 / 137** | 초록 |
| 컴파일 경고 | **4**(같은 `CROSSTALK_*` 넷) | 더한 것 0 |
| `typecheck:node` · `:web` · `:app` | **3종 초록** | — |
| 릴리스 번들 | setup.exe **2,810,332 B** + `.sig` **436 B** · exit 0 | §11.1 |
| 이 라운드가 더한 테스트 | **0**(못 하나를 제자리에서 교체) | — |

**Rust 코드 변경은 `src-tauri/src/updater.rs` 한 파일 · 그중 실행 코드는 0줄이다** —
바뀐 것은 `#[cfg(test)]` 안의 못과 주석뿐이라 **출하 바이너리는 의미상 무변**이다.

> 참고로 내가 구운 릴리스 exe는 **7,096,832 B**(sha256 `b3ad2df3…`)로 크리틱의 EXE-R
> (7,066,112 B)보다 **+30,720 B**다. 내 Rust 변경은 테스트 전용이므로 그 차이는 이 라운드의
> 것이 아니다 — 워킹트리에 **남의 미커밋 변경**(`src-tauri/src/engine/mod.rs` 210줄 ·
> `versions.rs` 12줄)이 함께 컴파일된 결과다. 같은 이유로 이 절의 exe 크기는 무회귀 축으로
> 쓰지 않았다(테스트·경고·타입체크·번들 산출물로 잰다).

### 11.9 ★장부(`renderer-divergence.md` §6.12)에 옮겨야 할 것 — **이 라운드는 그 파일을 못 만졌다**

§11.3~11.7의 내용은 원래 장부 §6.12에 들어가야 한다. **그런데 이 라운드는 그 파일을
커밋하지 않았다.** 이유는 규율이다: 같은 워킹트리에서 도는 **다른 갈래(R28L)의 미커밋 hunk가
같은 파일 §6.13에 살아 있고**(「한쪽만 걷으면 6→10으로 튄다」 정정 · 20줄),
`git commit --only <파일>`은 **인덱스가 아니라 워킹트리 내용을 통째로** 가져간다
(내가 빈 레포로 확인했다: 부분 스테이징을 해 둬도 커밋된 것은 워킹트리 전체였다).
즉 그 파일을 건드리는 순간 **남의 문단을 내 커밋이 삼킨다** — 이 레포가 R28에서 두 번 밟은 사고다.

**그래서 다음에 그 파일을 커밋하는 갈래가 §6.12에 아래를 그대로 넣어 달라**(내용은 전부
이 문서 §11에 실측과 함께 있다):

1. `App.tsx:2670` → **`App.tsx:2651`**(`<AppUpdateGate />`) — 유일한 좌표 오기.
2. **「알면서 다르게 한 것」에 ③ 추가** — `CCG_UPDATE_FEED`(2.6.2에 없던 문). 남기는 근거와
   방어 세 겹은 §11.5.
3. **①(세션 메모리)에 실측값 한 줄** — 크리틱 실측 `PrivateBytes +14.3MB` /
   `WorkingSet +9.3MB`(8.0MiB 페이로드 · 진짜 설치기는 2.81MB라 실제 유지량은 ~3~6MB급) ·
   **앱을 껐다 켤 때마다 한 번 다시 받는다**.
4. **「오류가 화면에 뜨는 규칙」 문단에 알려진 성질 한 줄** — 조회 단계 실패(오프라인·404)는
   상태·로그·stderr에만 남고 **화면에는 아무 흔적이 없다**. 파리티로는 합격, 사용자
   관점에서는 미해결(§11.3).
5. **빌드 절차 한 줄** — 이제 `npm run tauri:build`는 서명 개인키를 요구한다(§11.1).

### 11.10 수정 R1이 만진 것 · 커밋

| 파일 | 무엇 |
|---|---|
| `scripts/tauri-build.mjs` | **신규** — 서명 키를 찾아 실어 주는 빌드 래퍼(§11.1) |
| `package.json` | `tauri:build`·`tauri:bundle`이 래퍼를 거친다 + `tauri:build:unsigned` 신설 |
| `src-tauri/Cargo.toml` | 빌드 주석에 「이제 서명 키를 요구한다」 |
| `docs/HANDOFF-3.0.md` | 함정 2번에 같은 조건(그 명령을 시키는 자리) |
| `src-tauri/src/updater.rs` | 못을 전수 스캔으로 · 좌표 셋 정정. **실행 코드 0줄** |
| `docs/parity-fix-updater-r1.md` | 이 §11 + §8.2 릴리스 절차 갱신 |

| 해시 | 무엇 |
|---|---|
| `51446c6` | ① 빌드 파이프라인 — 래퍼 + 두 문서 |
| `4409097` | ② 못을 전수 스캔으로 + 좌표 셋 정정 |
| `d66d84d` | ③ 이 §11(보고서) |
| (이 커밋 = ④) | ④ 서명 실검증(§11.1의 마지막 표) |

**안 만진 것**: `src-tauri/src/tray.rs`(못 실증은 격리 사본에서만) ·
`app/**`(렌더러 무변) · `docs/renderer-divergence.md`(§11.9의 이유) ·
`bench/results/*`·`bench/shots/*/report.json`·`docs/critic/*.json`(기준 결과 파일 무변) ·
남의 미커밋 변경(`src-tauri/src/engine/{mod,versions}.rs` · `docs/parity-fix-m10-removal-r1.md`).
**외부 행위 0** — push · 태그 · 릴리스 생성/삭제 · 원격 API 쓰기 전부 없다. 이 라운드는
네트워크로 나간 GET조차 없다(로컬 피드도 안 세웠다 — 이번에 잰 것은 빌드·못·테스트다).
