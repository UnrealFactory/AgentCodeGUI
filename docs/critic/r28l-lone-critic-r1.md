# R28L 「LONE」 확인 크리틱 **R1**

> **한 줄.** 봉투 한 통만 남은 채팅은 **내 손에서도 진짜로 나았다** — 내가 새로 빌드한 exe로
> 내가 심은 34채팅 홈을 띄워 디스크·`chats:get`·`chats:load`·화면 **넷을 다 읽었고 전부 0**이며,
> 부모 커밋 exe로 두 번 굳혀 놓은 홈이 새 exe **한 번**에 나았고 2·3차 부팅에도 깨끗했다.
> 못은 장식이 아니다(내 돌연변이에서 `0 passed; 1 failed`). 부팅 비용은 **구조적으로 0**이다 —
> 봉투 없는 홈 9회 부팅에서 물질화된 런타임 수가 처방 0 · 대조군 0으로 **같다**.
> ②③④도 사실이다: ③의 세 값(`216/210/0/6` · `212/206/0/6` · `216/206/0/10`)은 내가 사본 셋에
> 도구를 따로 돌려 **한 칸도 안 틀리게** 재현했다.
> **그런데 이 라운드가 새로 쓴 주석 셋이 없는 것을 가리킨다** — 3.0 렌더러의 사이드바에는
> 예약 배지가 **역사상 한 번도 없었다**(`git log -S queued -- Sidebar.tsx` = 커밋 0). 앞
> 크리틱의 문장을 재보지 않고 옮긴 자리다. 문서 정확성이 이 라운드의 **주제**였다는 점에서
> 그냥 넘길 수 없다.

- 판정: **불합격**(치명 0 · 중 0 · **낮음 3**). 제품 **동작** 회귀는 하나도 못 찾았다 —
  ① 닫힘 · 자가 치유 · 다른 origin 셋 생존 · M10 무회귀 · 게이트 전부 초록 · 커밋 경계 깨끗.
  떨어진 곳은 **체크리스트 6번의 두 칸**(각주 수치 하나, 줄 번호 하나)과, 그와 같은 계열의
  「없는 배지」 주석이다.
- 나는 **레포 코드를 한 줄도 안 고쳤다.** 이 판정문 한 파일만 쓴다.

---

## 1. 무엇으로 쟀나 — 전부 내가 새로 만든 것(빌더 산출물 재활용 0)

| 축 | 값 |
|---|---|
| 트리 | `C:\Code\AgentCodeGUI` · `feature/3.0.0-beta` · HEAD **`1f1e538`** (측정 시작·끝 모두 추적 파일 수정 0) |
| **처방 exe** | `target-r28l-crit\release\agentcodegui.exe` · sha256 **`db9803ffa82da4f15cd39e03eb295723482fc2b259fa96043d45d507cce6a93b`** · **7,066,112 B** |
| **대조군 exe** | **부모 커밋 `b97dc8e`(=`880e468^`)** 를 `git archive`로 `C:\Temp\r28lcrit\ctl`에 풀고 `app/dist`만 복사 → `target-r28l-critctl\release\agentcodegui.exe` · sha256 **`af4a5f948f001e7621f92f71fe0f1c1254fb6050a65070bdcab8d36a579ac833`** · 7,066,112 B |
| **돌연변이 트리** | `C:\Temp\r28lcrit\mut` = HEAD에서 **`&& dropped == 0` 한 조각만 되돌림** → `target-r28l-critmut` |
| 빌드 | 셋 다 `cargo build --release --features custom-protocol` / `cargo test` · **CARGO_TARGET_DIR 셋 다 새 디렉터리**(재활용 0) · 처방·대조군 exit 0 · 각각 2분 12초 / 2분 11초 · 경고 **양쪽 4개**(`CROSSTALK_*` never used, `ipc/mod.rs:285/286/287/289`) |
| 가짜 CLI | `target-r28l-crit\release\ccg-fakecli.exe` · sha256 `ee0524d9ef1360fb1a042a849ef3e4552bb4c7bce5f71e324e91ae8fa525e6fa` · 200,192 B |
| 감사 사본 셋 | `C:\Temp\r28lcrit\audit\{orig,pts,ipc}` = `git archive HEAD` + 지정 줄만 삭제 |
| **내 계기(레포 밖 · 빌더 하네스 안 씀)** | `C:\Temp\r28lcrit\crit-lone.mjs`(봉투 5부팅 · 네 면) · `crit-cost.mjs`(ABAB 교차 · **런타임 수**) · `crit-talkblob.mjs`(1.x 블롭 왕복) |
| 빌린 계기(내 out으로) | `scripts/poc-m10-removal-screen.mjs` · `poc-m10-removal-bytes.mjs`(+`--diff`) · `docs/critic/tools/critic-r28e-channels.mjs` — **산출물은 전부 `C:\Temp\r28lcrit\`**(기준 결과 파일 덮어쓰기 0) |
| 격리 홈 | `%TEMP%\ccg-critr28l-*` 넷 · 측정 뒤 **전부 삭제(잔존 0)** |
| CDP 포트 | 11250–11262(봉투) · 11260(화면) · 11265(바이트) · 11275(블롭) · 11290–11295(부팅 비용) |
| 안전 | 이름 기반 kill **0**(사용자 실앱 `AppData\Local\Programs\AgentCodeGUI\AgentCodeGUI.exe` 6프로세스가 살아 있는 것을 확인하고 손 안 댐 · 내 exe 프로세스 잔존 0) · 실계정·네트워크 **0** · `git push`·태그 **0** |

**내가 심은 씨앗**(빌더보다 크게): 채팅 **34개** 홈. 활성은 평범한 `c-00`.

| 채팅 | 자리 | 큐 |
|---|---|---|
| `c-lone` | 목록 3번째 | `[{text:"[대화 연결] <<<TALK-DATA …>>>", origin:"talk"}]` **한 줄** · hold 없음 |
| `c-mix` | 6번째 | `talk` + `user` + `limit_resume` + `viewer_ask` **네 줄** |
| `c-far` | **맨 끝(34번째)** | `talk` 한 줄 — 후보 상한·순서 함정을 잡으려고 |

부팅 행(`chats-v3/status.json`)도 실앱 모양으로 `queued 1/4/1`로 맞춰 놓고 시작했다.

---

## 2. 체크리스트 항목별 판정

| # | 항목 | 판정 | 근거(내 실측) |
|---|---|---|---|
| 1 | ①이 닫혔는가 (네 면 + 부모 커밋 재현) | **통과** | 아래 §2.1 |
| 2 | 굳은 홈이 부팅 한 번에 낫는가(2·3차까지) | **통과** | 대조군 2회로 굳힘 → 처방 **1회**에 전부 0 · 2·3차도 0 |
| 3 | 못이 장식이 아닌가 | **통과** | 돌연변이 `FAILED. 0 passed; 1 failed` (§2.3) |
| 4 | 부팅 비용이 안 늘었는가 | **통과** | 봉투 없는 31채팅 홈 9회 — 물질화 런타임 **처방 0 / 대조군 0** (§2.4) |
| 5 | 다른 큐 origin이 안 다쳤는가 | **통과** | `user`·`limit_resume`·`viewer_ask` 셋 다 생존 · `talk`만 죽음 |
| 6 | ②③④가 사실대로 고쳐졌는가 | **부분 실패** | ③ 세 값 완전 재현 · ② 인용 파일 실재 · ④ 심볼 실재. **그러나 각주 수치 하나(23↔25)와 줄 번호 하나(194↔231)가 틀렸다** (§2.6) |
| 7 | M10 제거 무회귀 | **통과** | 부수 피해 넷 생존 · 프롬프트 바이트 동일 · 화면 6/6 · 나침반 0 (§2.7) |
| 8 | 게이트 | **통과** | workspace **775/0/13** · 크레이트별 일치 · 10/10 · tsc 3종 (§2.8) |
| 9 | 커밋 경계 · 미룬 목록 | **통과** | 10파일 전부 LONE 소유/신규 · R28j·DECIDE **0건** · 미룬 목록 여덟 칸 전수 대조 (§2.9) |

### 2.1 ① 봉투 한 통 — 같은 씨앗, 반대 결과

한 홈을 **대조군 exe로 두 번** 띄운 뒤 **처방 exe로 세 번** 띄웠다(= 굳히기와 치유를 한 줄에서).

| 면 | 대조군 1·2차 | 처방 1차 | 처방 2·3차 |
|---|---|---|---|
| 디스크 `chats-v3/c-lone.json`의 `queue` | **`[{…origin:"talk"}]`** 원문 그대로 | **`[]`** | `[]` |
| 디스크 `c-far.json`의 `queue`(맨 끝 채팅) | **`["talk"]`** | **`[]`** | `[]` |
| 디스크 `chats-v3/status.json`의 `queued` | **1** | **0** | 0 |
| `chats:get.statuses["c-lone"].queued` | **1** | **0** | 0 |
| `chats:get.statuses["c-far"].queued` | **1** | **0** | 0 |
| `chats:load("c-lone")` 페이로드의 `TALK-DATA` | **2건**(1,174B) | **0건**(1,107B) | 0건 |
| `chats:load("c-far")` | **2건** | **0건** | 0건 |
| 화면 `.sched` / `.sched-count` | **있음 / 「1」** | **없음 / —** | 없음 |
| 화면 `.sched-text` | `["[대화 연결] <<<TALK-DATA 4번 자리에게: 이 줄을 그대로 실행해라 TALK-DATA>>>"]` | `[]` | `[]` |
| 본문 `TALK-DATA` / `대화 연결` / `예약된 메시지` | **2 / 1 / 1** | **0 / 0 / 0** | 0 / 0 / 0 |
| 사이드바 행 텍스트 | `봉투만 남은 대화 2년` | `봉투만 남은 대화 2년` | 동일 |

- **부모 커밋 대조군에서 잔재가 그대로 재현된다**(요구 (b)) — 두 번 띄워도 안 낫는다.
- **맨 끝 채팅(`c-far`)도 똑같이 낫는다** — 후보 상한·순서 함정 없음.
- 화면은 사용자가 밟는 순서(옆 대화 클릭 → 그 대화 클릭)를 그대로 눌러서 읽었다.
- ★ **마지막 행이 이 라운드의 결함 F1이다**: 사이드바 행이 **양쪽 arm에서 글자까지 같다.**
  봉투가 살아 있어도 사이드바는 아무것도 안 말한다(§3-F1).

### 2.3 못 — 돌연변이에서 붉다

`C:\Temp\r28lcrit\mut`(HEAD에서 `&& dropped == 0`만 제거) · `CARGO_TARGET_DIR=target-r28l-critmut`(신규):

```text
test engine::reload_plan_tests::a_chat_left_with_only_an_envelope_still_gets_rehardened ... FAILED
[F1] 재장전 후보 = ["c-lone", "c-mixed", "c-plain"]
[F1] c-lone → None
panicked at src-tauri\src\engine\mod.rs:790:29:
★★ 봉투만 남은 채팅이 재장전을 건너뛴다 — 디스크의 TALK-DATA가 영구히 산다
test result: FAILED. 0 passed; 1 failed; 0 ignored; 136 filtered out
```

처방 트리에서는 같은 못이 초록(137 통과에 포함). **못은 장식이 아니다.**

### 2.4 부팅 비용 — 시계보다 **구조**로 잘랐다

시계는 이 기계에서 ~290ms와 ~410ms 두 봉우리로 갈리고 **그 이분성이 두 arm에 똑같이** 나타난다
(웜/콜드 WebView2). 그래서 잡음이 없는 축을 하나 더 뒀다: 부팅 뒤 `engine:debug`가 세는
**물질화된 런타임 수**. 처방이 매 부팅 `hub::call`을 늘린다면 이 수가 는다.

| 홈(31채팅) | 물질화된 런타임 (9회 부팅) | spawn→마운트 min / med / max |
|---|---|---|
| 봉투 **없음** · 처방 | **0,0,0,0,0,0,0,0,0** | 296 / 404 / 415 ms |
| 봉투 **없음** · 대조군 | **0,0,0,0,0,0,0,0,0** | 290 / 412 / 459 ms |
| 봉투 **매 부팅 재삽입** · 처방 | **1,1,1,1,1,1,1,1,1** | 277 / 295 / 419 ms |
| 봉투 **매 부팅 재삽입** · 대조군 | **0,0,0,0,0,0,0,0,0**(= 건너뛴다 = 결함) | 287 / 314 / 432 ms |

읽는 법: 봉투가 없는 홈에서 처방은 허브를 **한 번도** 더 안 부른다(0 = 0, 9회 전부).
봉투가 있는 홈에서만 **정확히 하나** 더 부르고, 그마저 첫 부팅이 파일을 고치면 사라진다
(§2.1의 처방 2·3차에서 디스크가 `[]`로 남아 있는 것이 그 증거다). 시계 축에서는 봉투 홈의
median이 오히려 처방 쪽이 19ms 빠르다 = 잡음대. **비용 증가 없음.**

### 2.5 다른 origin — 넷 중 하나만 죽는다

`c-mix`(talk + user + limit_resume + viewer_ask) → 처방 부팅 뒤 디스크 `["user","limit_resume","viewer_ask"]` ·
`chats:get…queued` **3** · `chats:load`의 `TALK-DATA` **0**. **대조군에서도 같다**(R28k가 이미
닫아 둔 모양) → 이 라운드의 회귀 0.

### 2.6 ②③④ — 셋 다 열어 봤다

| 검증 | 결과 |
|---|---|
| ② `scripts/critic-m10-attack.mjs`가 실제로 지워졌나 | `git log --diff-filter=D` → **`e86edd5`가 삭제**. 인용이 빈 경로였다는 진단은 참 |
| ② 새 인용 `poc-m10-removal-bytes.mjs:104-106` | 104=`const enginedir=…claude-agent-sdk-win32-x64` · 105=`mkdirSync` · 106=`copyFileSync(FAKECLI, claude.exe)` — **세 줄이 정확히 같은 일** |
| ② 새 인용 `poc-live-chat.mjs:480` | `const enginedir = …` — **정확** |
| ② 판정 로직 변경 여부 | `git show 1f1e538 -- versions.rs` = **doc 주석만**. 「한 글자도 안 건드렸다」 참 |
| ② **「지금 23파일」** | ✗ **틀렸다.** 내 실측 `git grep -l claude-agent-sdk-win32-x64 -- scripts docs/critic/tools` = **25**(HEAD · scripts 15 + tools 10) · 24(`b97dc8e`) · 24(`2116e6c`). 어느 커밋에서도 23이 아니다 |
| ③ 원본 | **216 / 210 / 0 / 6** — 각주와 일치 |
| ③ `protocol.ts` 1347-1353만 걷음 | **212 / 206 / 0 / 6** — 일치 |
| ③ `ipc/mod.rs` 282-289만 걷음 | **216 / 206 / 0 / 10** — 일치. 「튀는 것은 이 방향뿐」 **참** |
| ④ 심볼 다섯 실재 | `runtime.rs::append_prompt` · `runtime.rs::tests::the_per_chat_extra_instruction_actually_reaches_the_cli` · `engine/mod.rs::reload_plan` · `engine/mod.rs::is_retired_talk_row` · `ccg-store/src/talk.rs` 머리말 — **다섯 다 있다**. 지금 `runtime.rs`의 「대화 연결」은 544·**3948** |
| ④ §3의 나머지 줄 번호 전수 | `App.tsx:703-786`(실제 708·786) ✓ · `shim.ts:510-518`(511·516·517) ✓ · `protocol.ts:796`(`ApiUsageSource`) ✓ · `migrate_v3.rs:635·837·1090` ✓ · `runtime.rs:3920·3926` ✓ · `ipc/mod.rs:282` ✓ · `styles.css` `.chat--talk` 두 규칙(834·1268) ✓ |
| ④ §5.3(보고서 197줄)의 `engine/mod.rs:194` | ✗ **틀렸다.** 이 라운드의 **① 커밋이 231로 밀어 놓고** 안 고쳤다(`git grep -n "M10" -- src-tauri/src/engine/mod.rs` = 231 하나) |

### 2.7 M10 제거 무회귀 — 전부 내 exe로 다시 눌렀다

| 축 | 값 |
|---|---|
| `poc-m10-removal-screen.mjs`(내 exe · 내 out) | **6/6 PASS** — 옛 홈 `talk-config.json`·`talk-state.json` **보존** · crosstalk 4채널 전부 `{__unimplemented:true}` · 나침반 `talk`/`대화 연결`/`crosstalk` **각 0건** · 메인창·추가창(`#session`)·팝아웃(`#mapanel`) 셋 다 `.talk-stop` 0 · Ctrl+Shift+. 무반응 |
| 프롬프트 바이트(**CLI stdin**) | 평범한 채팅 `initialize` = **161B** · sha `afb039fc7966a648299e042446cbfa874a555a0a73b1d395370ea36174532b0f` · **`systemPrompt` 키 부재** / 추가 지시 채팅 = **291B** · sha `e73cf2f2310ebd74526f43665aabac34caa71b702ccc229c184ce0943391ab6a` · `systemPrompt.append`에 문면 그대로 |
| 제거 **전** 기준선과 `--diff` | `docs/critic/m10rm-bytes-pre.json` 대비 `plain.identical:true` · `instructed.identical:true` · **`pass:true`** |
| 부수 피해 넷 | `ccg-store/src/talk.rs` `read`/`write`/`empty_blob`(18·23·29) ✓ · `migrate_v3.rs`의 chat-talk 5단계(389) + `TALK_FILE`(27) ✓ · `window.api.talk.{getState,saveState}` 배선(`shim.ts:516-517` · `App.tsx:708`·`786`) ✓ · `ccg_migrate.rs:161`의 `"talk"` 덤프 ✓ |
| 그 왕복을 **뜬 앱에서 눌러 봤다** | `talk.saveState(블롭)` → `talk.getState()`가 **빈 블롭**을 돌려준다. 원인은 통합 스토어 라우터(`ipc/unified.rs:84-85` — `TALK_GET`=`empty_blob()` · `TALK_SAVE`=no-op)이고 **그 두 줄은 M10 제거 이전(`e86edd5^`)에도 글자 그대로 같다** → **회귀 아님**(편입 뒤 블롭은 비는 것이 설계). 채널은 살아 있고 `{__unimplemented:true}`가 아니다 |
| 빌드 산출물 `app/dist/assets/*` | `crosstalk`·`talk-stop`·`@talk`·`대화 연결`·`msg-origin`·`TALK-DATA` **각 0건** |

### 2.8 게이트 — 전부 내 손으로

| 게이트 | 값 |
|---|---|
| `cargo test --workspace` | exit 0 · **775 passed / 0 failed / 13 ignored**(34블록) |
| 남의 미추적 계기 제외 | `probe_wfire_crit.rs` **8** + `probe_wfr2.rs` **10** = 18 (`#[test]` 수와 러너 블록 둘 다로 확인) → **757 = 기준선 756 + 1** |
| 크레이트별 | `agentcodegui` **137**(=136+1) · `ccg-auth` **126** · `ccg-engine` **250**(−18=**232**) · `ccg-fs` **101** · `ccg-lsp` **59** · `ccg-store` **85** — 여섯 칸 전부 빌더 주장과 일치 |
| `agentcodegui` 기본 병렬 10회 연속 | **10/10 · 매회 137 = 1,370/1,370** |
| `npm run typecheck:node` · `:web` · `typecheck:app` | 셋 다 **exit 0** |
| `cargo build --release --features custom-protocol` | exit 0 · 경고 **4**(전부 `CROSSTALK_*` never used) — 대조군도 같은 4 |

> 첫 주행에서 내가 `| head -60`으로 스트림을 잘라 690으로 셌다. **내 계기의 잘못**이었고,
> 전문을 파일로 받아 다시 세어 775를 얻었다. 인용되는 값은 후자다.

### 2.9 커밋 경계 · 미룬 목록

| 커밋 | 파일 |
|---|---|
| `880e468` | `A docs/critic/m10rm-lone-r28l-ctl.json` · `A …-fix.json` · `A scripts/poc-m10-lone-envelope.mjs` · `M src-tauri/src/engine/mod.rs` |
| `1f1e538` | `A docs/critic/m10rm-bytes-r28l.json` · `A …-r28ldiff.json` · `A m10rm-screen-r28l.json` · `M docs/parity-fix-m10-removal-r1.md` · `M docs/renderer-divergence.md` · `M src-tauri/src/engine/versions.rs` |

- R28j UPDATER 소유 8파일(`ipc/mod.rs`·`shim.ts`·`lib.rs`·`Cargo.toml`·`tauri.conf.json`·`AppUpdateGate.tsx`·`App.tsx`) **0건** · DECIDE 소유(`docs/decisions-3.0.md`·`bench/**`·`m1/m12-report-*`) **0건** · `docs/critic/final-parity-*`·`progress/**` **0건**.
- 남의 미추적 계기 둘은 여전히 미추적(커밋 안 됨) ✓ · `docs/critic/*.json` 다섯 전부 `A`(기준 파일 덮어쓰기 0) ✓
- **미룬 목록을 내가 파일을 열어 여덟 칸 대조**: `ipc/mod.rs` 282–284 배너 · 285/286/287 상수 · 288 doc · 289 상수 → **282–289 통째 맞다** · `src/shared/protocol.ts` 1347–1349 배너 · 1350–1353 네 항목(**1353에 콤마 없음 맞다**) · 492–497 M10 주석 · 509 `talk?: TalkSent` · 1511(M10 블록 시작)–1615(`} as const`) → **1511–1616 맞다** · 경고 넷 = 그 상수 넷 **맞다** · `app/src/api/protocol.ts`는 **실제로 없다**(`app/src/api` = `chrome.ts`·`glassFallback.ts`·`shim.ts`·`unified.ts`) **맞다** · `shim.ts`에 `crosstalk` 0건이고 511줄의 `IPC.talkRun`은 1.x 채팅 모드 채널(감사의 `missing 6`에 이미 그 이름으로 올라 있다) **맞다**.

---

## 3. 남은 결함

### F1 (낮음) — 새 주석 셋이 **존재하지 않는 사이드바 배지**를 사실로 적었다

**무엇이 틀렸나.** 이 라운드가 새로 쓴 세 곳이 「사이드바에 「1」이 붙는다」를 처방의 근거로 적는다.

- `src-tauri/src/engine/mod.rs:200` — 「… 사이드바가 읽는 부팅 행(`status::truth_from_chat_file`)은 **파일의 `queue` 길이**를 세므로 「1」이 계속 붙는다」
- `src-tauri/src/engine/mod.rs:750`(못의 doc) — 「사이드바 배지는 파일의 `queue` 길이를 세므로 …」
- `src-tauri/src/engine/mod.rs:781`(못의 주석) — 「부팅 행이 「1」을 세는 그 자리 — **사이드바 배지의 출처다**」
- 보고서 `docs/parity-fix-m10-removal-r1.md:428`에도 같은 문장

**왜 틀렸나(실측 셋).**
1. `app/src/components/Sidebar.tsx`에 `queued`가 **한 번도 안 나온다**. 더 나아가
   `git log -S "queued" -- app/src/components/Sidebar.tsx` = **커밋 0** — 그 파일에는 예약 배지가
   **역사상 한 번도 없었다.**
2. `chats:get.statuses[].queued`를 소비하는 자리가 `app/src` **전체에 없다**(`rg "\.queued\b" app/src` = 0건).
   그 칸은 계약면에만 있는 값이다.
3. 내 대조군 실측(봉투가 **살아 있는** 상태)에서 그 채팅의 사이드바 행은
   `봉투만 남은 대화 2년` · 자식 span은 `dot`/`t`/`tx`/`when`뿐이었고 **처방 arm과 글자까지 같았다**.

봉투가 실제로 보이는 자리는 **채팅 안의 예약 패널(`Chat.tsx`의 `.sched`)** 하나이고, 그것은
`chats:load`가 실어 온 큐를 `App.tsx`가 `setQueue`로 세운 것이다. 이 라운드는 **그 자리를 정확히
껐다** — 결함은 「무엇을 껐는가」가 아니라 「무엇을 껐다고 적었는가」다.

**어디서 왔나.** 앞 크리틱(`docs/critic/r28k-m10rm-critic-r2.md` 한 줄 요약)의 문장이다. 이 라운드는
그 문장을 **재보지 않고 영구 주석 셋으로 승격시켰다.** 하필 이 라운드의 주제(②④)가 「다음 사람을
헛걸음시키는 글을 고친다」였다.

**재현.** `rg -n "queued" app/src/components/Sidebar.tsx`(0건) · `git log -S "queued" -- app/src/components/Sidebar.tsx`(빈 출력) ·
`C:\Temp\r28lcrit\crit-lone.mjs`를 `--old=<부모 exe>`로 돌려 `screenLone.sidebarBadges`를 읽으면
대조군에서도 `["dot =","t=봉투만 남은 대화","tx=봉투만 남은 대화","when=2년"]`이다.

**피해.** 다음 사람이 없는 배지를 찾아 헤매고, 「화면에서 닫혔다」의 근거를 잘못된 자리에서
검증하려다 재현에 실패한다. **동작 피해 0.**

### F2 (낮음) — 줄 번호 부패를 고치는 커밋이 **자기 손으로 새 부패를 만들었다**

`docs/parity-fix-m10-removal-r1.md` §5.3(197줄)의
`「이번 라운드가 박은 못 3건(runtime.rs:3920·3926 · engine/mod.rs:194)」`에서 `engine/mod.rs:194`는
**부모 커밋에서만 참**이다. `880e468`이 `reload_plan`을 갈라내며 그 자리를 **231**로 밀었고,
바로 다음 커밋(`1f1e538`)이 「줄 번호는 밀린다 → 심볼로 적는다」를 §3에 쓰면서 **같은 문서의
이 칸은 안 고쳤다.**

**재현.** `git grep -n "M10" -- src-tauri/src/engine/mod.rs` → `231:` 하나뿐 ·
`git grep -n "M10" b97dc8e -- src-tauri/src/engine/mod.rs` → `194:`. 보고서 197줄은 아직 194다.
(같은 칸의 `runtime.rs:3920·3926`·`migrate_v3.rs:635·837·1090`·`ipc/mod.rs:282`는 **전부 맞다** — 내가 다 열어 봤다.)

### F3 (낮음) — 커밋 메시지의 전수 값 「23파일」이 실측과 다르다

`1f1e538` 메시지의 「`git grep -l claude-agent-sdk-win32-x64 -- scripts docs/critic/tools`(지금 23파일)」.
내 실측: **HEAD 25**(`scripts` 15 + `docs/critic/tools` 10) · 부모 `b97dc8e` 24 · 그 앞 `2116e6c` 24.
**어느 커밋에서도 23이 아니다.**

완화 요인: 커밋된 코드(`versions.rs` doc)와 보고서에는 **숫자가 없고 명령만** 적혀 있다 —
피해는 장부(커밋 메시지)에 국한된다. 그래도 ②의 취지가 「근거를 확인 가능한 자리로」였으므로
그 근거에 붙인 수치가 틀린 것은 같은 계열의 흠이다.

### 관찰(결함 아님) — 못 안의 「대조군」 단언은 아무것도 안 잰다

```rust
assert!(lq.is_empty(), "★ 봉투가 큐로 되살아났다");
assert!(lh.is_none());
let r28k_would_skip = lq.is_empty() && lh.is_none();
assert!(r28k_would_skip, "★ 대조군이 재현되지 않았다 — 이 못은 아무것도 안 재고 있다");
```

셋째 단언은 위 두 단언이 이미 보장하므로 **독립적으로 붉어질 수 없다.** 보고서·커밋 메시지의
「대조군을 못 **안**에 뒀다」는 그만큼 과장이다. 다만 **진짜 못**(`.expect(…)`)은 살아 있고,
내가 만든 돌연변이가 그것을 붉게 만들었다(§2.3) — 못 자체는 장식이 아니다.

### 관찰(실측 안 함) — 본문·첨부가 **둘 다 빈** 큐 줄은 영원히 남는다

`status::read_chat_queue`는 `text`가 비고 `images`도 빈 줄을 **`before`를 세기 전에** 버리므로
그런 줄이 있으면 `dropped == 0`이 되어 처방이 안 걸린다. 그런데 배지의 출처인
`truth_from_chat_file`은 **원시 배열 길이**를 센다. 즉 「보이지도 않고 지워지지도 않는 1」이
가능하다. **M10 봉투는 항상 본문을 갖고 있고**(내가 심은 씨앗이 그렇다) 제품 경로가 빈 줄을 쓰는
자리를 못 찾아서 **재현은 안 했다** — 이 라운드의 결함이 아니라 그 위층의 성질로 남긴다.

---

## 4. 내가 만진 것

- **레포 코드 수정 0 · 레포 문서 수정 0**(이 판정문 하나 제외). `git status`의 추적 파일 변경 0으로
  시작해 0으로 끝냈다. 남의 미커밋/미추적 파일에 `reset`·`checkout`·`stash`·`restore` **0**.
- 새로 만든 것(전부 레포 밖): `C:\Temp\r28lcrit\{crit-lone.mjs, crit-cost.mjs, crit-talkblob.mjs}` ·
  `ctl\`(부모 커밋 트리) · `mut\`(돌연변이 트리) · `audit\{orig,pts,ipc}` · 산출물 json 넷.
- 빌드 산출물: `target-r28l-crit\` · `target-r28l-critctl\` · `target-r28l-critmut\`(전부 `.gitignore`의 `target-*/`).
  디스크가 12GB까지 떨어져 **R28e 이전 라운드의 죽은 target 디렉터리 34개**(`target-casx*` ·
  `target-critcasx*` · `target-wcapr*` · `target-extn*`)를 지웠다 — R28j·R28k·R28L 것과 사용자의
  `target\`은 손대지 않았다.
- 격리 홈 넷 삭제(잔존 0) · 내 exe 프로세스 잔존 0 · **이름 기반 kill 0** · `git push`·태그·릴리스 **0**.
