# R28f SHIPBLOCK 확인 크리틱 R2 — 「취소」는 내 손에서도 518ms가 아니라 58ms에 풀린다. 그런데 그것을 지키는 회귀 테스트가 전체 주행의 절반에서 붉다

판정 대상: `1e47a06`(R2 본체) + `8dd4678`(R2b · 요구 3의 뒷절반).
규율대로 **빌더의 보고서·커밋 메시지·하네스를 근거로 쓰지 않았다** — 계기를 새로 쓰고
(`C:\Temp\ccg-r28f-shipcrit2\tools\*.mjs`), exe를 새로 굽고, 격리 홈에서 눌러 쟀다.
대조군 exe는 **새 `CARGO_TARGET_DIR`** 에서 따로 구웠다(재활용 금지 — R28d 실증).

---

## 1. 무엇으로 쟀나

| 자리 | 값 |
|---|---|
| 판정 트리 | `git archive 37afd55` → `C:\Temp\ccg-r28f-shipcrit2\src`<br>핵심 6파일(`ipc/accounts.rs`·`ipc/lsp.rs`·`shim.ts`·`Settings.tsx`·`App.tsx`·`chats_v3.rs`)이 HEAD 블롭과 **줄끝 제외 0줄 차이** — 이웃의 미커밋 변경이 안 섞였다 |
| **판정 exe** | `…\tgt-judge\release\agentcodegui.exe` · sha256 `156ace09d6acd7c923d6da9566d0be9d287e155ba523d6aee2664de562e24b2e`<br>`--features custom-protocol` 확인: exe 안에 **내가 구운 번들 이름** `FileModal-BINIkZEe.js` 1회 · 문자열 `localhost:5273` **0회** |
| **대조군 exe**(R2 **직전** HEAD `90765ad`) | `…\tgt-ctlr2\release\agentcodegui.exe` · sha256 `d30c62d8e95c70f80d3c223022db2afbbe53fcc1e36ac872497fb7aea73fff69`<br>**새 CARGO_TARGET_DIR**(`tgt-ctlr2`)에서 vite→cargo 전부 새로 구움 |
| 파괴 대조군 셋 | `saba` `9ac2adb4…`(처방 ①·② **둘 다** 무력화) · `sabb` `abb66f83…`(② `kill_wrapped_child`만 무력화) · `sabc` `05aa282b…`(`CODEX_SET_DEFAULT_ACCOUNT` 팔 하나 제거) |
| 2.6.2 대조군 | `node_modules/electron/dist/electron.exe` + `out/main/index.js` md5 `5d4356fd84ca42ee6411289ac7167f7c` |
| CCG_HOME | `C:\Temp\ccg-r28f-shipcrit2\home-*` — 계정은 전부 `@crit.invalid` **합성**, 사용자 실홈은 **읽지도 복사하지도 않았다** |
| CDP 포트 | 10561 ~ 10599 (SHIPBLOCK 10520 + 50 대역) |
| CARGO_TARGET_DIR | `…\tgt-judge` · `tgt-saba` · `tgt-sabb` · `tgt-sabc` · `tgt-ctlr2` (전부 크리틱 전용, 다른 갈래와 안 겹침) |
| 내 계기 | `tools\{lib,n1,cancel,cycle,n2,doors,setdoor,boot,addok,churn}.mjs` + 내가 쓴 가짜 CLI `tools\fakecli.rs`(컴파일본) · 셰임 `.cmd`는 스크립트가 생성 |
| 안전 | 이름 기반 kill **0회**(내가 스폰한 PID / 내 태그가 커맨드라인에 있는 것만) · `CCG_NO_NET=1` · 2.6.2 주행은 `USERPROFILE`을 빈 임시 폴더로 갈아끼움(그쪽 codex 모듈이 `os.homedir()`를 하드코딩) |

주: 주행 중 레포 HEAD가 `37afd55` → `76fe1aa`(M10 착지)로 움직였다.
`git diff 37afd55 HEAD -- src-tauri/src/ipc app/src crates/ccg-store/src/chats_v3.rs docs/renderer-divergence.md`
= **빈 출력**(SHIPBLOCK 소유 파일은 한 줄도 안 움직였다). 내 측정은 `37afd55`에 고정돼 있고 그대로 유효하다.

---

## 2. 체크리스트 항목별 실측

### (1) N1 화면 재현 — 「맨 위로」 · 판정 exe

| | 값 |
|---|---|
| 클릭 → 화면 정착 | **1ms**, OpenAI 목록 `[critr2-two, critr2-one]` **2행 유지**(증발 없음) |
| 배지 | `critr2-two`(= 새 0번) |
| 디스크 `codex-accounts.json` | `[two, one]` · `defaultEmail: critr2-two` · **446바이트**(클릭 전과 같은 크기, 순서만 뒤집힘) |
| 실패 안내 | 성공이라 없음 — 실패 판은 (3)에서 별도 exe로 강제해 확인 |

**「계정 추가」 해피패스도 R2 뒤에 살아 있다**(완료 신호를 둘로 만든 것이 자연 완료를 안 깨뜨렸는가):
로그인이 **빨리 성공하는** `.cmd` 셰임(auth.json을 `%CODEX_HOME%`에 떨구고 exit 0)으로
새 행 **108ms** 도착 · 화면 3행 · 디스크 3개(446 → **926바이트**) · 스피너 0 · CLI 로그
`login|…\home-addok-j\codex\login`(실홈으로 안 샌다). 산출물 `out-addok-j.json`.

### (2) N1 원시 호출 · 계약면 채널 전수

원시 `ipc_call`(내 화면에서 직접, 판정 exe):

| 채널 | 결과 | `__unimplemented` |
|---|---|---|
| `codex-auth:login-cancel` | `null` | 아니오 |
| `codex-auth:reorder-accounts` | `array:2` | 아니오 |
| `codex-auth:set-default-account` | `array:2` (첫 칸이 `two`) | 아니오 |
| `codex-auth:list-accounts` | `array:2` | 아니오 |
| `codex-auth:logout` | `array:1` · 디스크 446 → **264바이트** | 아니오 |
| (`codex-auth:login`은 5분을 붙잡으므로 원시로 안 부르고 화면 경로로 잰다 — (4)·§3) | | |

계약면 도구(`docs/critic/tools/critic-r28e-channels.mjs`)를 **내가 세 트리에** 돌렸다(216채널):

```
R28f 이전 트리(ctl-pre28f)  impl 198 · missing 18
R2 직전 트리 (ctl-prer2)    impl 203 · missing 13
판정 트리   (HEAD)          impl 206 · missing 10
```

세 트리의 신원도 확인했다(`kill_wrapped_child` 0/2/8회 · `callPathOrNull` 0/0/2회).
**18 → 10.** 남은 10 = `talk:*` 여섯(**M10 소유**) + `app:{update-check,update-install,open-directory,update-event}` 넷.

### (3) 구조적 처방 — 일부러 미구현으로 만든 채널로 · 그리고 「다른 화면」

**파괴 대조군 `sabc`**(`CODEX_SET_DEFAULT_ACCOUNT` 팔 **하나만** 제거 = 그 채널만 진짜 `__unimplemented`):

| | 판정 exe | `sabc`(같은 코드 + 그 채널만 미구현) |
|---|---|---|
| 「맨 위로」 후 목록 | `[two, one]` 2행 | **2행 유지**(서버 순서 `[one, two]`로 복원) |
| 문구 | 없음 | **「순서를 바꾸지 못했어요 — 앱을 재시작한 뒤 다시 시도해 주세요」** |
| 디스크 | `[two, one]` | 안 바뀜 |
| 원시 호출 | `array:2` | `{__unimplemented:true}` |

**빈 배열이 목록 setter에 안 앉는다**는 요구는 내 손에서도 닫혔다.

**「다른 목록 화면에도 걸려 있는가」 — R1의 「아니오」가 R2b에서 절반 닫혔다**(전부 API 층에서 직접 호출):

| 호출 | R1 판정 때 | **판정 exe(HEAD)** |
|---|---|---|
| `window.api.lsp.pickVerseServer()` | resolve `null`(침묵) | **reject** · `ShimUnavailableError` · `detail="Verse 서버 지정은 3.0에서 아직 제공하지 않아요"` |
| `lsp.setVersePath('…')` | `{ok:false,error:"unimplemented"}` | `{ok:false,error:"Verse 서버 지정은…"}` |
| `lsp.clearVersePath()` | 〃 | `{ok:true}` |
| `app.checkForUpdate()` / `installUpdate()` | 조용한 resolve | **여전히 조용한 resolve** |
| `app.getUpdateStatus()` | — | `{phase:"idle",version:null,…}` |

남은 침묵 둘(`update-check`·`update-install`)이 **화면에 닿는가**를 따로 쟀다:
`AppUpdateGate`는 `phase ∈ {available,downloading,downloaded,error+version}`일 때만 카드를 그리고
「업데이트」 버튼은 `phase==='downloaded'`에서만 난다. 실측 `phase="idle"` → **버튼이 존재하지 않는다.**
즉 남은 넷은 「눌렀는데 침묵」이 아니라 「누를 자리가 없다」다.

### (3-보) 빌더의 반박 — 나도 같은 값을 얻었다

*"「Verse 서버 고르기」 무반응의 뒷절반(화면 증상)은 3.0에서 재현되지 않는다."* — **맞다.**
판정 exe에서 설정 ▸ Code를 열어 세니 서버 4행뿐:

```
servers() → [ts:bundled, py:bundled, cs:download, cpp:download]   ← kind==='external' 0개
행 텍스트   TypeScript·JavaScript / Python / C#(설치) / C·C++(설치)
버튼        ["설치","설치"]                                        ← verseRows = 0
```

R1 판정문의 그 문장은 **채널 사실은 맞고 화면 증상은 틀렸다.** 내 문장을 여기서 정정한다.

### (4) N2 두 앱 나란히 — 다섯 값

같은 픽스처(`r2-good`·`r2-plain`·`r2-boom`, 활성=`r2-good`), 같은 순서로 눌렀다.
`r2-boom`은 `text`가 객체라 자식 렌더에서 던진다.

| 상태 | **3.0(판정 exe)** | 2.6.2 |
|---|---|---|
| 부팅 | eb 0 · sb 3 · win 1 · chat 1 · disk `r2-good` | eb 0 · sb 3 · win 1 · chat 1 · disk `r2-good` |
| 폭탄 채팅 선택 직후 | eb 1 · **sb 3 · win 1** · chat 0 · disk **`r2-boom`** | eb 1 · **sb 0 · win 0** · chat 0 · disk `r2-good` |
| 「앱 새로고침」(탈출 시도 **없이**) | eb 0 · sb 3 · win 1 · chat 1 · disk `r2-good` | eb 0 · sb 3 · win 1 · chat 1 · disk `r2-good` |
| 표식(localStorage) | 새로고침 뒤 `null` = 1회 소비 | (해당 없음) |
| 사이드바로 탈출 | **가능** → eb 0 · chat 1 | **불가**(sb 0) |
| 폭탄 활성인 채로 재시작 ×2 | eb 0 · disk `r2-good` (둘 다) | eb 0 (애초에 폭탄이 활성으로 안 남는다) |

**3.0이 감옥에서 나온다.** 2.6.2 대비 열등한 칸은 없다 — 카드가 뜬 동안에도 사이드바·창 크롬이
살아 있는 쪽은 3.0뿐이고(3/1 vs 0/0), 대신 3.0만 폭탄을 활성으로 **즉시 영속**하므로(U3)
탈출구가 없으면 부팅 루프가 될 자리였다. 그 탈출구가 이 라운드 이전에 놓였고, 지금 돈다.

### (5) N2의 다른 문

* **멀티 보드**(0번 패널이 던진다) — 두 앱 다 `eb 1` 이지만 **사이드바가 산다**:
  3.0 `sb 6 · win 1` / 2.6.2 `sb 4 · win 1`. 정상 채팅을 누르면 둘 다 탈출(`eb 0 · chat 1`).
  **「앱 새로고침」은 멀티 축에서 두 앱 다 카드로 되돌아온다**(3.0 eb 1 · 2.6.2 eb 1) —
  채팅 축의 표식 처방이 멀티 축을 **안 덮는다**. 다만 감옥은 아니다(사이드바 탈출이 항상 된다) =
  2.6.2와 파리티. 이 라운드가 고칠 것이 없던 자리라는 빌더 주장과 일치.
* **설정 모달** — 모달을 열고 탭을 옮긴 뒤 `ui-prefs.json`을 읽으니 키가 그대로 6개
  (`workspace.mode`·`explorer.swap`·`chat.zoom`·`sidebar.autohide`·`whatsnew.seenVersion`·`ui.lang`) =
  모달 상태가 어떤 pref에도 안 실린다. 새로고침 뒤 착지: `setNav=false · eb 0 · sb 3 · win 1 · chat 1`.
  **설정은 부팅 루프의 문이 될 수 없다.**

### (6) N2가 무엇을 잃었는가

* **재시작 후 활성 복원** — 정상 채팅(`r2-plain`)을 고르고 프로세스 재시작 → `r2-plain`으로 착지,
  디스크도 같음. **산다.**
* **창 간 활성 채팅 동기화의 진실 소스** — 내가 잰 3.0의 12개 상태 전부에서
  **디스크 `activeChatId` == 화면이 그린 채팅**이었다(선택 직후·새로고침 뒤·탈출 직후·재시작 ×3 포함).
  격리가 셸 몰래 다른 채팅을 그리는 상태를 만들지 않는다.

### (7) 무회귀 — **여기 한 칸이 붉다**

| 검사 | 결과 |
|---|---|
| `cargo test` 크레이트별(판정 트리·내 target) | ccg-auth **124** · ccg-engine **231** · ccg-fs **101** · ccg-lsp **59** · ccg-store **90**(다섯 크레이트 전부 0 failed) · agentcodegui **158**(초록으로 끝난 주행 기준 — 아래 두 줄) — 합 **763** |
| **`cargo test -p agentcodegui --bin agentcodegui`(기본 병렬) ×6** | **초록 3 / 붉음 3** — `156 passed;2 failed` · `157;1` · `156;2` |
| 같은 것 `--test-threads=1` ×2 | **158 / 0** 초록 ×2 |
| 같은 것, 새 테스트 셋만 필터 ×8 | 초록 ×8 |
| **대조군 트리(`90765ad`) 같은 명령 ×3** | **154 / 0** 초록 ×3 |
| `cargo test --workspace` 1회 | **FAILED** — exit 101 (`agentcodegui` 156 passed / 2 failed) |
| `npm run typecheck`(node·web) | exit **0** |
| `npm run typecheck:app` | exit **0** |
| `poc-account-switch`(내 판정 exe · `--out=-shipcritr2`) | **PASS 6/6** (pick·none·off·dirty·chain·toggle) |
| 콜드 부팅 A/B(판정 vs 대조군, 같은 픽스처, A/B 교대, 웜업 1회 제외 4회씩 · 2세션) | 1세션 mount 399 vs 359 · ready 561 vs 509 / **2세션 mount 340 vs 356 · ready 528 vs 536** — 부호가 세션마다 뒤집힌다 = **회귀 아님**(회차 산포 ±130ms 안) |

붉은 두 테스트는 **이 라운드가 새로 쓴 것**(`git log -S` → `1e47a06`):
`cancelling_a_wrapped_login_kills_the_program_inside_the_wrapper` ·
`cancelling_an_unwrapped_login_leaves_what_the_cli_launched_alone`.
실패 문구는 둘 다 픽스처 단정 — `★래퍼 안의 프로그램이 안 떴다 — 픽스처가 무의미하다(자식 [])`
(`src-tauri/src/ipc/accounts.rs:939`). 자세한 것은 §3-A.

부수 사실 하나: 빌더가 인용한 **780**은 내 트리에서 **763**이다. 차이 17~18은 이웃(WFIRE)의
**미커밋 probe 파일 둘**(`crates/ccg-engine/tests/probe_wfire_crit.rs` 8개 +
`probe_wfr2.rs` 10개 = 18)이다 — 함정 10 그대로. `agentcodegui` 154 → 158(+4)은 내 손에서도 같다.

### (8) 장부 정직성

| 확인 | 결과 |
|---|---|
| §6.5의 거짓 두 문장 | **정정돼 있다** — 「3.0 화면은 안 부른다 / reorderAccounts로 같은 결과를 저장한다」가 「둘 다 핸들러가 없었다」로 바뀌었고, **왜 거짓이었는지**까지 적혀 있다 |
| `set-default-account = move_account_to_top`의 근거 | **셋 다 적혀 있다**(동결 2.6.2가 같은 홈에서 부른다 · Anthropic 축과 같은 규약 · no-op은 성공처럼 보이는 실패) |
| §6.9(취소) 표 | 내 실측과 **방향이 전부 일치**(대조군 안 풀림/손자 생존 → R2 즉시 풀림/손자 0, 브라우저만 생존). 절대값만 다르다(내 픽스처가 더 빨리 죽어 58ms vs 518ms) |
| §6.10(Verse) | **범위까지 정직하다** — 「그 버튼은 3.0 화면에 없다」를 스스로 적었고 내 실측(`verseRows=0`)과 같다 |
| 빠진 것 | 새 회귀 테스트의 **불안정성**(§3-A)과, 손자가 살아남는 판에서 앱이 **스레드·핸들을 흘린다**는 사실(§3-B)이 장부·보고서 어디에도 없다 |

---

## 3. 남은 결함

### A. 〈중〉 이 라운드가 더한 회귀 테스트 둘이 **전체 주행의 절반에서 붉다**

R1의 ★최대 격차를 지키라고 놓은 자물쇠가, 정작 **자기 크레이트를 통째로 돌리면 반은 실패한다.**

| 주행 방식 | 판정 트리(HEAD) | 대조군 트리(`90765ad`) |
|---|---|---|
| `cargo test -p agentcodegui --bin agentcodegui` (기본 병렬) | **6회 중 3회 실패**(2·1·2개) | 3회 중 **0회** 실패 |
| 같은 것 `-- --test-threads=1` | 2회 중 0회 실패(158/158) | — |
| 새 테스트 셋만 필터 | 8회 중 0회 실패 | — |
| `cargo test --workspace` | **실패**(exit 101) | — |

실패는 **제품 단정이 아니라 픽스처 단정**에서 난다:

```
thread 'ipc::accounts::tests::cancelling_a_wrapped_login_kills_the_program_inside_the_wrapper'
panicked at src-tauri\src\ipc\accounts.rs:939:
★래퍼 안의 프로그램이 안 떴다 — 픽스처가 무의미하다(자식 [])
```

즉 `spawn_wrapped_fixture`가 6초를 폴링하고도 `cmd.exe`의 직속 자식을 **하나도** 못 봤다.
빌더가 §6에서 잡은 두 함정(파이프 위치·conhost)은 진짜로 잡혔지만, **세 번째 함정**이 남았다 —
그 대기 루프는 「자식 수가 늘기를 멈출 때까지」인데, 스냅샷이 한 번이라도 빈 목록을 돌려주면
`kids`가 `[]`로 덮이고 그대로 끝난다(`now.len() > kids.len()`이 아니면 `kids = now`).
동시 실행 중인 158개 테스트가 프로세스를 쉴 새 없이 만들고 죽이는 판이 그 조건을 만든다.

**제품 경로는 같은 부하에서 멀쩡했다** — 내가 초당 ~500개 프로세스를 만들고 죽이는 부하
(`tools/churn.mjs --par=20`)를 깔아 놓고 같은 취소 시나리오를 돌리니 스피너 **57ms**,
손자 **0**(`out-cancel-j-cmd-load.json`). 그러니 이것은 **제품의 붉음이 아니라 게이트의 붉음**이다.
다만 게이트가 반은 붉으면 다음 라운드부터 아무도 그 붉음을 안 믿는다 — 출하 차단 갈래에서
그건 가벼운 일이 아니다.

재현:
```
cd <HEAD 아카이브 트리>
for i in 1..6: CARGO_TARGET_DIR=<격리> cargo test -p agentcodegui --bin agentcodegui
# 3회 안에 「자식 []」로 1~2개 실패한다. --test-threads=1 로 바꾸면 안 난다.
```

### B. 〈하〉 파이프를 쥔 손자가 살아남는 판에서 앱이 **스레드·핸들을 흘린다**

처방 ②는 「CLI가 연 브라우저는 살린다」가 설계다(동의한다). 그런데 그 브라우저가 우리 파이프의
쓰기 끝을 함께 쥐고 있으면, 취소로 화면은 풀려도 `pump_login`이 띄운 **읽기 스레드 둘**은
`read()`에 걸린 채 남는다(`rx`가 사라져도 그 스레드는 다음 `read` 반환 전에는 못 깨어난다).

깊이 2 픽스처(CLI가 「브라우저」를 낳고 그것이 stdio를 상속)에서 취소를 **6회** 반복:

| | 시작 | 6회 뒤 |
|---|---|---|
| 앱 스레드 | 47 | **54** |
| 앱 핸들 | 414 | **421** |
| 살아남은 「브라우저」 | 0 | **4**(앱 종료 뒤에도) |
| 스피너 해제 | — | 매 회 41~145ms(안 서는 회차 없음) |

같은 6회를 브라우저 없는 픽스처로 돌리면 스레드 47 → 46, 핸들 418 → 419, 생존자 0.
사용자 손으로 만들 수 있는 최대치는 「취소를 여러 번 누른다」 정도라 등급은 하.
다만 **장부에 이 대가가 안 적혀 있다** — 「브라우저는 산다」의 값과 함께 적혀야 할 값이다.
재현: `node tools/cycle.mjs --which=judge --n=6 --browser=1`(산출물 `out-cycle-cyc-br.json`).

### C. 〈하〉 `direct_children()`는 실패를 **조용한 빈 목록**으로 돌려준다

```rust
let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
```

스냅샷이 실패하면(프로세스 표가 흔들릴 때 Windows가 흔히 그런다) `kill_wrapped_child`는
**아무것도 안 죽이고 성공한 것처럼 돌아온다**. §3-A의 `자식 []`가 같은 코드 경로에서 나온 값이다
(원인이 스냅샷 실패인지 그 순간 자식이 정말 없었는지까지는 못 갈랐다 — 그래서 등급 하).
화면은 처방 ①이 어차피 푸니 사용자 피해는 「셰임 안 CLI가 가끔 살아남는다」에서 멈춘다.
재시도 한 번(또는 실패 로그 한 줄)이면 닫히는 자리다.

### D. 〈참고〉 5분 상한·`busy` 두 축 묶기는 그대로다

빌더가 「남은 리스크 2·3」으로 적은 그대로였다. 취소를 누르면 58ms에 풀리므로 탈출구는 있다.
실 OAuth 왕복은 이 라운드도 검증되지 않았다(나도 가짜 CLI로만 왕복했다 — 실홈 무접촉이 규율이다).

---

## 4. 내가 만진 것

* **레포 수정 0.** 소스·설정·하네스 어느 것도 안 고쳤다. 계기는 전부 레포 밖
  `C:\Temp\ccg-r28f-shipcrit2\tools\`(`lib.mjs`·`n1.mjs`·`cancel.mjs`·`cycle.mjs`·`n2.mjs`·
  `doors.mjs`·`setdoor.mjs`·`boot.mjs`·`addok.mjs`·`churn.mjs`·`fakecli.rs`)에 있고,
  산출물도 그 아래 `out-*.json`이다.
* 파괴 대조군 셋과 R2 직전 대조군은 레포가 아니라 `C:\Temp\ccg-r28f-shipcrit2\{saba,sabb,sabc,ctlr2src}`
  (아카이브 사본)에서 만들었고, 각각 **자기 CARGO_TARGET_DIR**에서 구웠다.
* 레포에 새로 생긴 파일 하나는 `poc-account-switch`가 규약대로 남긴 것이다(기준 파일 보호를 위해
  `--out=-shipcritr2`): `docs/critic/m11-r1-switch-shipcritr2.json`. **커밋하지 않는다.**
* 커밋하는 파일은 이 판정문 하나(`docs/critic/r28f-shipblock-critic-r2.md`).
* 사용자 실홈(`%USERPROFILE%\.agentcodegui`)은 읽지도 복사하지도 않았다. 이름 기반 kill 0회.
  기준 결과 파일(`bench/results/*`·`bench/shots/*/report.json`·`docs/critic/*.json`) 덮어쓰기 0회.

---

## 5. 판정

**★최대 격차는 내 손에서도 진짜로 닫혔다.** R2 직전 HEAD를 새 target에서 따로 구운 대조군은
`.cmd` 셰임에서 **45초 내내 스피너가 안 풀리고**(계정 추가·삭제 전부 disabled) 손자가 앱 종료
뒤에도 살아 있었는데, 판정 exe는 같은 픽스처에서 **58ms**에 풀리고 손자가 **0**이다.
처방이 둘로 갈려 있다는 주장도 사실이다 — `kill_wrapped_child`만 무력화한 `sabb`에서도
화면은 **178ms**에 풀렸고(손자는 살았다), 둘 다 무력화한 `saba`에서만 90초 감옥이 재현됐다.
네이티브 `.exe` 갈래는 대조군 66ms / 판정 55ms로 파리티다.
요구 3의 뒷절반도 채널 층에서는 닫혔고(`pickVerseServer()`가 **사유를 실어 reject**한다),
「그 버튼은 3.0에 없다」는 빌더의 반박은 내 실측에서도 맞다(`verseRows=0`) — R1 판정문의 그
문장은 여기서 내가 정정했다.

체크리스트 8항목 중 **7항목이 초록**이다. 붉은 하나는 **(7) 무회귀** —
이 라운드가 자물쇠로 놓은 회귀 테스트 둘이 자기 크레이트 전체 주행에서 **3/6 실패**하고
(`cargo test --workspace`도 함께 붉다), 대조군 트리는 같은 명령에서 3/3 초록이다.
제품은 내 부하 시험에서도 멀쩡했다. 붉은 것은 제품이 아니라 **그 제품을 지키는 게이트**다.

— 확인 크리틱 R2 (Claude Fable 5)
