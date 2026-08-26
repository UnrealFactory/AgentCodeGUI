# R28k M10 「대화 연결」 제거 — 확인 크리틱 **R2**

> **한 줄.** R1이 잡은 여섯은 **여섯 다 내 손에서 닫혔다** — 죽은 주석 넷은 진짜로
> 사라졌고(내가 grep했다), 장부 각주는 실제로 박혀 있고 그 내용이 **내 측정과 맞으며**
> (도구 `impl 210` · 컴파일러 `never used` 4 · 뜬 앱 넷 다 `{__unimplemented:true}`),
> 미룬 계약면 줄 목록은 **내가 `protocol.ts`를 한 줄씩 열어 대조해 여덟 칸 전부 맞았다**
> (`110/111`도 진짜 `TALK_GET`/`TALK_SAVE`다). 프롬프트 바이트는 내가 새로 빌드한 두
> exe에서 `afb039fc7966…`·161B로 **동일**하다.
> **그런데 봉투 한 통만 남은 채팅은 그 봉투를 화면에 그대로 띄운다.** 큐에 `origin:"talk"`
> 한 줄뿐이고 한도 대기표가 없는 채팅은 재장전 자체를 건너뛰어(`engine/mod.rs:168`)
> 필터가 **입도 못 대고**, 사이드바에 「1」이 붙은 채 예약 패널이
> `[대화 연결] <<<TALK-DATA …>>>` 전문을 보여 준다 — 부팅을 세 번 해도 그대로다.
> 나가지는 않는다(CLI stdin 0건). 즉 **안전은 닫혔고 화면이 안 닫혔다.**

- 판정: **불합격**(치명 0 · **중 1** · 낮음 3). 제품 **동작** 회귀는 이번에도 못 찾았다 —
  승인 카드·계정·한도 자동 재개·1.x 편입은 전부 살아 있다.
- 나는 코드를 **한 줄도 안 고쳤다.** 이 판정문 한 파일만 쓴다.

---

## 1. 무엇으로 쟀나 (전부 내가 새로 만든 것 — R1의 것은 하나도 재활용 안 했다)

| 축 | 값 |
|---|---|
| 워크트리(제거 후) | `D:/ccg-crit/r28k2-post` = **`273f7b5`**(detached · 새로 만든 것) |
| 워크트리(제거 전) | `D:/ccg-crit/r28k2-pre` = **`57e55e6`**(= `741bf57^`) |
| target(후) | `D:/ccg-crit/target-r28k2-crit` — **신규**(재활용 0) |
| target(전) | `D:/ccg-crit/target-r28k2-critpre` — **따로 신규**(대조군 재활용 금지) |
| 빌드 | 양쪽 `vite build` + `cargo build --release --features custom-protocol` · **둘 다 exit 0** |
| exe(후) | sha256 **`e82f0b31ff6074580eea06949f3e421158a521b8328b08182c0b89e29942fbb6`** · **7,066,624 B** |
| exe(전) | sha256 **`522cabfc11d302cc02d07b5682cfb486a74d4e7a4c463ced67f03c96a369d11e`** · **6,615,040 B** |
| 가짜 CLI | `ccg-fakecli.exe` sha256 `18dc0b72ecde6a9d…` · 200,192 B — **양쪽 주행에 같은 한 벌**(계기는 피검체가 아니다) |
| 홈 | 전부 격리 — `%TEMP%\ccg-crit2-m10rm-<tag>` · `%TEMP%\ccg-crit2-lone-<tag>` · 워크트리 안 `.poc-home-m10rm-critr2{pre,post}`(자동 삭제 확인) |
| CDP 포트 | 11050 · 11052(바이트) / 11060 · 11070 · 11080 · 11090 · 11100(화면, 각 +1) / 11110 · 11120 · 11130(봉투 한 줄, 각 +2) — R28j의 10900~10970과 안 겹친다 |
| 계기 | `C:/Temp/crit-r28k2/critic-m10rm-r2.mjs`(**내가 썼다** — R1 하네스에서 씨앗·어휘·포트를 전부 갈고 축 넷 D4·D9·D10·D11을 더했다) · `C:/Temp/crit-r28k2/probe-lone-envelope.mjs`(**신설** — §3 F1을 잡은 계기) · 바이트는 빌더 하네스를 **읽고 검증한 뒤** `--out`으로 내 파일에 |
| 산출물 | `C:/Temp/crit-r28k2/*.json`(기준 결과 파일 덮어쓰기 **0**) |
| 안 한 것 | 실계정·네트워크·이름 기반 kill·`git push`·태그·기준 파일 덮어쓰기 **전부 0**. 죽인 것은 내가 spawn한 PID 트리뿐 |

> 두 exe는 M10 말고도 그 사이에 착지한 R28i/R28j 커밋만큼 다르다(그래서 후자가 더 크다 —
> 업데이터 플러그인). 아래에서 뒤집히는 축은 전부 M10 표면이고, 안 뒤집히는 축은 양쪽 다
> 초록이다 — **두 방향 다 확인했다.**

---

## 2. 체크리스트 항목별 실측

### 2-1) 잔재 사냥 — R1이 잡은 넷은 사라졌다. **다섯째를 내가 찾았다**

`app/src` · `src-tauri/src` · `crates` 직접 grep(29개 어휘):

| 어휘 | 건수 |
|---|---|
| `talk_guide`·`spawn_guide`·`talk_run`·`TalkStop`·`TalkConfig`·`TalkSent`·`TalkResult`·`QueueOrigin::Talk`·`require_picker`·`@talk`·`Ctrl+Shift+.`·`msg-origin`·`talk-stop`·`envelope` | **각 0** |
| `picker_unavailable`·`TALK-DATA`·`reply_only`·`maxHops`·`maxFanout`·`injectPolicy`·`noticeAckAt`·`stopVerdict`·`stoppedAt`·`unstoppable`·`hop_cap`·`talkpulse` | **각 0** |
| `crosstalk` | **4** — 전부 `src-tauri/src/ipc/mod.rs:285-289`(R28j 소유 · §3 참고) |
| `대화 연결` | **6** — 5는 이 갈래의 못, 1은 `ipc/mod.rs:282` |
| `M10`(주석 전수) | `migrate_v3.rs:635·837·1090`(살아 있는 로직) · `runtime.rs:3920·3926` · `engine/mod.rs:194` · `ipc/mod.rs:282` |
| 번들 `app/dist/assets/*` | `crosstalk`·`talk-stop`·`@talk`·`대화 연결`·`msg-origin`·`talkpulse`·`TalkStop`·`긴급 정지`·`TALK-DATA` **각 0** |

**R1의 F2·F3과 이 라운드의 F3+ 자리는 셋 다 실제로 비었다**(`SessionWindow.tsx:734` ·
`PanelWindow.tsx:450` · `runtime.rs:701` · `hub.rs:1113`을 열어 확인). `hub.rs`의 예외 목록은
이제 `LimitResume`·`ViewerAsk`·`NotifReplay` 셋이고, `queue.rs`의 `QueueOrigin`도 정확히
그 셋 + `User`다 — **주석과 열거가 이제 같은 말을 한다.**

**★그런데 삭제된 하네스를 근거로 인용하는 주석이 하나 남았다** — §3 **F2**
(`src-tauri/src/engine/versions.rs:106`). 빌더의 어휘 목록에도 R1의 목록에도 「자기가 지운
스크립트 이름」이 없어서 둘 다 못 봤다.

### 2-2) 부수 피해 — **넷 다 살아 있다**(★(d)는 바이트로)

| 지우면 안 되는 것 | 내 확인 | 결과 |
|---|---|---|
| (a) `crates/ccg-store/src/talk.rs` | 31줄 · `read`/`write`/`empty_blob` · 호출처 `ipc/unified.rs:84`·`stores.rs`·`bin/ccg_migrate.rs:161` | **산다** |
| (b) `window.api.talk.getState/saveState` + 1.x 편입 | 씨앗 `chat-talk.json`(대화 1건) → 부팅 뒤 `chats:get`에 제목 **편입** · 블롭 `chats:[]`로 비워짐 · `getState()` 정상 · **`saveState()`도 왕복**(D9) | **산다** |
| (c) `migrate_v3`의 chat-talk 5단계 | 위 편입이 그 단계의 실행 증거(`talkAbsorbed`) · 소스 `migrate_v3.rs:389-410·712-714` 잔존 | **산다** |
| ★(d) `RunIdentity::system_prompt` append | **가짜 CLI stdin 바이트** — 추가 지시 있는 채팅의 `initialize`에 `systemPrompt.append`로 그 문자열이 실려 나갔다(291B · sha `e73cf2f2310e…`) | **산다** |

`ident.rs:199-200`이 `chat:run`의 `systemPrompt`를 읽어 정체성에 앉히므로 이 하네스가
**제품 경로 그대로**라는 것도 소스로 확인했다(파리티 못 둘의 이름도 바뀐 채 살아 있다:
`the_per_chat_extra_instruction_actually_reaches_the_cli`).

### 2-3) 프롬프트 바이트 — **동일** ✔ (내가 새로 빌드한 두 exe)

| 축 | 제거 전 exe | 제거 후 exe | 판정 |
|---|---|---|---|
| 추가 지시 **없는** 채팅 | sha `afb039fc7966a648…` · **161 B** · `systemPrompt` 키 **부재** | 같은 sha · 161 B · 키 부재 | **바이트 동일** |
| 추가 지시 **있는** 채팅 | sha `e73cf2f2310e…` · **291 B** · append에 그 문자열 | 같은 sha · 291 B | **바이트 동일** |

`--diff` → `pass:true` · `plain.identical:true` · `instructed.identical:true`
(`C:/Temp/crit-r28k2/bytes-{pre,post}.json`). **계기 흠도 닫혔다** — 보고서가 적은
`exe.sha256`이 이제 내 `sha256sum` 값과 **글자까지 같다**(`e82f0b31ff607458…`).

### 2-4) 옛 홈 관용 — **초록**(홈은 내가 지었다)

씨앗: `talk-config.json`(`enabled:true` · 보드 옵트인 · `injectPolicy:'ask'` · `noticeAckAt` ·
`interrupted`·`unstoppable`·`stopVerdict`) + `talk-state.json`(연쇄 1건) + `ui-prefs.json`의
`talk.enabled`·`crosstalk.board`·`talk.injectPolicy` + `chat-talk.json` + 손으로 심은 큐 **네 줄**.

부팅 ✔ · `#root` 마운트 ✔ · `getVersion()` ✔ · 설정 모달 개시 ✔ · **옛 두 파일 바이트 그대로**
(제거가 사용자 홈을 뒤지지 않는다) · 설정 탭 열한 개(대조군은 열두 개 = `Talk` 포함).

### 2-5) 화면 잔재 — 세 창 전부 초록, **대조군은 전부 반대**

| 축 | 제거 후 | 제거 전(대조군) |
|---|---|---|
| 나침반 `talk`·`대화 연결`·`crosstalk`·`긴급`·`협업`·`@talk`·`세션 간`·`collaboration` | 여덟 다 **`[]`** | 다섯이 **`["Talk"]`** |
| 대조 검색어 `계정` | `["Account"]`(눈멀지 않았다) | 같음 |
| 메인 창 알약 · Ctrl+Shift+. | 없음 · 무반응 · 본문 문자열 0 | 알약 **처음부터 떠 있고** 본문에도 문구 |
| 추가 채팅 창(`#session`) | 없음 · 무반응 | 키 누르니 알약 **뜸** |
| 팝아웃(`#mapanel`) | 없음 · 무반응 | 키 누르니 알약 **뜸** |
| `crosstalk:{config,set,stop,state}` | **넷 다 `{__unimplemented:true}`** | 넷 다 **설정 전문**을 돌려준다 |
| `engine:debug`의 talk 회계(내가 더한 축) | **없음** | **있음** |

> **대조군을 재는 사람에게 못 하나.** `crosstalk:stop`을 먼저 눌러 보면 그 호출이 큐의 봉투를
> **걷어간다**. 나는 첫 대조 주행에서 그것 때문에 「대조군인데 봉투가 안 살아났다」를 봤고,
> 채널 축을 끄고(`--nod1`) 다시 재서 `queued:4`를 얻었다. 계기의 자기 오염이다.

### 2-6) 봉투 재장전 — 필터는 정확하고 **과잉도 아니다**(네 줄로 재봤다)

씨앗 `talk`(죽어야) · `user` · `limit_resume` · `viewer_ask`(셋 다 살아야):

| 축 | 제거 후 | 대조군 |
|---|---|---|
| 런타임 큐 | **`queued:3`** — 봉투만 죽고 셋은 산다 | **`queued:4`** — 봉투가 그대로 되살아난다 |
| 디스크(`chats-v3/<id>.json`) | `["user","limit_resume","viewer_ask"]`로 **다시 굳는다** | `["talk","user",…]` 그대로 |
| 계약면(`chats:load`) | `TALK-DATA` **0건** | `TALK-DATA` **있음** |

소스로도 확인했다 — `is_retired_talk_row`는 `q.origin == Some("talk")` **하나뿐**이고 본문
매칭이 없다(사용자가 그 문구를 인용해도 안 죽는다). 큐를 디스크에서 읽는 자리는
`engine/mod.rs:130` **단 하나**이고 필터가 거기 걸린다.
**★그런데 그 자리 여덟 줄 아래(`:168`)에 §3 F1의 구멍이 있다.**

### 2-7) 게이트 — **전부 초록**

| 게이트 | 값 |
|---|---|
| `cargo build --release --features custom-protocol` | exit 0 (양쪽) · 경고 **전 0개 → 후 4개**(`CROSSTALK_*` never used) |
| `cargo test --workspace`(제거 후 워크트리 · 남의 미추적 계기 없음) | **exit 0 · 756 passed / 0 failed / 13 ignored** |
| `agentcodegui` 기본 병렬 **10회 연속** | **10/10 · 매회 136 = 1,360/1,360** |
| `tsc` node · web · app | **셋 다 exit 0** |
| `vite build` | exit 0 (양쪽) |

**크레이트별 — 줄어든 수를 이름까지 `comm`으로 대조했다**(같은 방법을 두 워크트리에):

| 크레이트 | 전(`57e55e6`) | 후(`273f7b5`) | 차 | 사라진 이름 |
|---|---|---|---|---|
| `agentcodegui` | **174** | **136** | −38 | `engine::talk::tests::*` **43개 전부** / 새로 생긴 5는 R28j `updater::tests::*` |
| `ccg-engine` | 233 | 232 | −1 | `turning_the_board_off_respawns_the_resident_cli` 순삭 + 이름만 바뀐 둘 |
| `ccg-store` | 92 | 85 | −7 | `talk::m10_tests::*` 7개 전부 |
| `ccg-auth`·`ccg-fs`·`ccg-lsp` | 126·101·59 | 126·101·59 | 0 | — |
| 합 | **785** | **739** | −46 | = M10 **51** − R28j 신설 **5** |

**사라진 51개는 하나도 빠짐없이 M10 것이고, 그 밖에 사라진 테스트는 0이다.**
(인계 기준선의 `agentcodegui 170`은 내 깨끗한 제거 전 측정 **174**와 4 차이가 난다 —
기준선 쪽이 낡았다. 이 갈래 몫이 아니라 적어만 둔다.)

### 2-8) 부수 피해 실사용 — **셋 다 닫힌다**(대조군도 초록 = 제거와 무관)

| 축 | 확인 | 결과 |
|---|---|---|
| 승인 카드 왕복 | `can_use_tool{Write}` → `permission-request` ✔ → `chat:permission{allow}` → **CLI stdin에 `control_response` 도착(바이트)** → `status:done` | **닫힌다** |
| 계정 축 | `auth.listAccounts()` = 두 계정 · `isDefault` 정상 | **산다** |
| 한도 자동 재개 | 재장전이 대기표를 그대로 날랐다 — `resetsAt`·`attempts:1`·**`episodeFires:3`**·`autoPaused:false`·`autoResume:true` · 큐의 `limit_resume` 줄 생존 | **산다** |

### 2-9) 계약면 재고 — 수치 재현 + **각주가 사실인지 내가 실험했다**

| 트리 | total | impl | commentOnly | missing |
|---|---|---|---|---|
| `r28k2-pre`(`57e55e6`) | 216 | 207 | 0 | **9** |
| `r28k2-post`(`273f7b5`) | 216 | 210 | 0 | **6** |

원자료도 열었다 — `crosstalk:*` 넷 다 `verdict:"impl"` · `code:["…ipc/mod.rs:285|286|287|289"]` ·
**`codeN:1`** · `commentN:0`. 도구 본문을 읽어 **왜** 관대한지도 확인했다: 머리말은 「디스패처
match 팔에 걸리는지 본다」고 적혀 있지만 실제 판정은 `hits('"채널"')`의 **비주석 한 줄이면
`impl`**이다(§ `critic-r28e-channels.mjs:98-102`). 뜬 앱은 넷 다 `{__unimplemented:true}`
(내가 눌렀다) → **각주의 「참값 10」은 사실이다.**

**다만 각주의 마지막 문장은 반만 맞다** — §3 **F3**. 내 실험: 내 워크트리에서
`protocol.ts`의 IPC 항목 **넷만** 지우고 도구를 돌리면
**`total 212 · impl 206 · missing 6`** — 각주가 「두 파일을 같은 커밋에서 걷어야 나온다」고
적은 바로 그 값이 **한쪽만으로 나온다.**

### 2-10) 문서 — **열두 장 전부 도장, 인계 두 줄 철회, 줄 목록 여덟 칸 전수 대조 통과**

- 철회 헤더: `design/m10-talk.md` · `m10-report-r{1,5,6,7}.md` · `critic/m10-r{1,2,3}.md` ·
  `critic/r28f-m10-critic-r{1,2}.md` · `critic/r28h-m10-critic-r{1,2}.md` = **12장 전부**.
  판정문 일곱 장에는 「아래의 『고쳐라』는 전부 효력이 없다」 한 문단이 **더** 붙어 있다.
- `HANDOFF-3.0.md:198` 취소선 + 「만들지 마라」 + 사유 + 기록 위치 + 「제안이 오면 이 문단을
  먼저 보여 줘라」 ✔ · `ARCHITECTURE-3.0.md:42` `(ccg-peer)` + 「만들어진 적 없다」 ✔
- **F6 정정을 내가 파일을 열어 전수 확인했다**(전부 맞다):
  `492–497`(497 = 「사용자는 두 세션이 왜…」) · `509` · `1347–1349`/`1350–1353`(1353에 콤마
  없음) · `1511–1540`(1540 = `'picker_unavailable'`) · `1542–1572`(1572 = 닫는 `}`) ·
  `1574–1607` · `1609–1615`(1615 = `} as const`) · 「1511–1616 통째」(1510·1616 빈 줄, 1617 =
  `ChatStatusLite` doc) · `ipc/mod.rs` **110/111 = `TALK_GET`/`TALK_SAVE`**(98/99는 진짜로
  `PROFILE_GET`/`PROFILE_SAVE`다 — **그대로 지웠으면 프로필 저장이 죽었다**) ·
  `1117–1123`(이름 7개 = 7줄) · `1275` · `796` · `282–289`(290 빈 줄).
- **한 칸이 낡았다** — §3 마지막 행의 `runtime.rs:3946`. §3 F4.

### 2-11) 커밋 경계 — **깨끗**

`df32df6`(6파일) · `273f7b5`(14파일) 전수:

- R28j UPDATER 소유 7파일(`ipc/mod.rs`·`api/shim.ts`·`protocol.ts`·`lib.rs`·`Cargo.toml`·
  `tauri.conf.json`·`AppUpdateGate.tsx`) **0건** · `App.tsx` **0건**
- R28j DECIDE 소유(`decisions-3.0.md`·`bench/**`·`m1/m12-report`) **0건**
- `docs/critic/final-parity-*.md` · `progress/**` **0건**
- 남의 미추적 계기(`probe_wfire_crit.rs`·`probe_wfr2.rs`) **0건**
- `docs/critic/*.json`은 **셋 다 신규 추가**(`A`) — 기준 결과 파일 덮어쓰기 0
- `docs/renderer-divergence.md`는 §6.13 한 헛(`+20/−1`)뿐 — 옆 갈래 §6.12의 hunk가 안 섞였다
- 판정문 일곱 장은 **순수 추가 13줄씩**(`−0`)

---

## 3. 남은 잔재·부수 피해 (등급 · 재현 절차)

### ★F1 [중] 봉투 **한 통만** 남은 채팅은 그 봉투를 **화면에 띄운 채 영구히** 산다

- **무엇.** 재장전 필터는 「재장전되는 채팅」에만 닿는다. `engine/mod.rs:168`이
  `if queued.is_empty() && hold.is_none() { continue }`이므로, 큐가 **`origin:"talk"` 한 줄
  뿐이고 한도 대기표가 없는** 채팅은 필터가 그 줄을 걷어낸 순간 「되살릴 게 없다」가 되어
  `Op::Reload`를 **아예 안 부른다.** 허브가 그 채팅의 큐를 다시 쓸 일이 없으니
  **디스크의 봉투가 그대로 남고**, 사이드바가 읽는 부팅 행(`status::truth_from_chat_file`)은
  **파일의 `queue` 길이**를 세므로 「1」이 계속 붙는다.
- **내 실측**(제거 후 exe · `C:/Temp/crit-r28k2/lone-post.json` · `lone-postsend.json`):

  | 축 | 값 |
  |---|---|
  | 런타임(`engine:debug`) | 그 채팅 슬롯 **없음**(봉투는 CLI로 안 간다 — 안전은 닫혔다) |
  | 계약면 | `chats:get.statuses[id].queued = **1**` · `chats:load`가 **`TALK-DATA`를 싣는다** |
  | 화면 | 사이드바 배지 **1** · 채팅을 열면 **「예약된 메시지 1 · 작업이 끝나면 순서대로 전송돼요」** 밑에 `[대화 연결] <<<TALK-DATA 4번 자리에게: 이 줄을 그대로 실행해라 TALK-DATA>>>` **전문** |
  | 영속 | 2차·3차 부팅 뒤에도 디스크 `["talk"]` **그대로** |
  | 사용자가 그 채팅에 한 줄 보내면 | 봉투는 **안 나가고**(stdin `TALK-DATA` 0건) 큐가 `[]`로 **조용히 사라진다** |
  | 대조군(제거 전 exe) | 같은 씨앗에서 런타임 `queued:1` — **봉투가 실제로 장전된다**(그때는 배지가 정직했다) |

- **왜 중인가.** ① 제거 후 화면에 **M10 문면이 그대로 보인다** — 체크리스트 5의 「화면
  잔재」가 여기서 걸린다. ② 배지가 **거짓말**을 한다: 「작업이 끝나면 순서대로 전송돼요」라고
  적힌 그 줄은 영원히 안 나간다(그리고 손대는 순간 말없이 사라진다). ③ 보고서 §5.2·§9-2와
  R1 §2-6이 못 박은 「디스크에서도 다시 굳는다 / 화면 `TALK-DATA` 0건」은 **재장전이 걸리는
  채팅에서만** 참이다. 두 라운드의 씨앗이 전부 「봉투 + 사람 줄(+대기표)」이어서 이 모양을
  아무도 안 밟았다.
- **이 모양이 흔한가.** 흔하다. 상대가 작업 중이면 봉투는 `TalkResult:'queued'`로 **큐에
  앉는다** — 그 턴이 끝나기 전에 앱을 닫으면 정확히 「봉투 한 줄 · 대기표 없음」이 된다.
- **재현.**
  1. 격리 홈 부팅 1회(마이그레이션) → 종료.
  2. `chats-v3/<id>.json`의 `queue`를 `[{ "text":"[대화 연결] <<<TALK-DATA …>>>",
     "images":[], "origin":"talk" }]` **한 줄**로 바꾸고 `hold`를 지운다.
     `chats-v3/status.json`의 그 행은 `queued:1 · hold:null`.
  3. 다시 부팅 → 사이드바에 「1」, 그 채팅을 열면 예약 패널에 봉투 전문.
     `ipc_call('chats:get')`의 `statuses[id].queued === 1`.
  4. 앱을 껐다 켜도 그대로다.
- **닫는 방향**(내 일이 아니라 적어만 둔다). 필터가 **실제로 무언가를 버렸으면** 되살릴 게
  없어도 그 채팅의 큐를 한 번 다시 쓰게 하면 된다(`Reload`를 부르든, 그 자리에서
  `persist_queue`를 부르든). 지금은 「버렸다」는 사실이 런타임 밖으로 안 나간다.

### F2 [낮음] `versions.rs:106`이 **이 라운드가 지운 하네스**를 근거로 인용한다

- **어디.** `src-tauri/src/engine/versions.rs:106` —
  *「가짜 CLI를 꽂는 스크립트들은 … `claude.exe` 하나만 심고 SDK 패키지는 안 깐다
  (`scripts/critic-m10-attack.mjs:124`). 엄격하게 바꾸면 그 하네스가 전부 PATH 폴백으로
  떨어져 조용히 다른 것을 재게 된다.」*
- **왜 잔재인가.** `scripts/critic-m10-attack.mjs`는 **이 갈래의 `e86edd5`가 삭제했다.**
  `claude_bin()`이 일부러 느슨한 **유일한 근거**가 지금 없는 파일을 가리킨다. 다음 사람이
  그 판정을 조이려고 근거를 확인하러 가면 파일이 없다. 이 라운드가 자랑한 **F3+와 정확히
  같은 종류**(없어진 것을 가리키는 주석)이고, 파일도 이 갈래 소유(`src-tauri/src/engine/**`)다.
  빌더의 어휘 목록에도 R1의 목록에도 「내가 지운 스크립트 이름」이 없어서 둘 다 못 봤다.
- **재현.** `git grep -n "critic-m10" -- src-tauri crates app scripts bench` → **1건**.
  `ls scripts/critic-m10-attack.mjs` → 없음.
- **영향.** 동작 0. 보고서 §5.3의 「제품 코드 잔재 목록」이 이 한 줄만큼 사실이 아니다.
  (살아 있는 하네스로 근거를 옮기면 닫힌다 — `scripts/poc-m10-removal-bytes.mjs:104-106`이
  같은 일을 한다.)

### F3 [낮음] 각주의 「한쪽만 걷으면 6 → 10으로 튄다」는 **한 방향에서만** 참이다

- `docs/renderer-divergence.md` §6.13 각주와 보고서 §9-3이 「`ipc/mod.rs` 282-289와
  `protocol.ts` 1347-1353을 **같은 커밋에서** 걷어야 `212/206/6`이 된다 — 한쪽만 걷으면
  `missing`이 6 → 10으로 튄다」고 못 박았다.
- **내 실험.** `protocol.ts`의 IPC 항목 **넷만** 지우고 도구를 돌렸다 →
  **`total 212 · impl 206 · commentOnly 0 · missing 6`.** 즉 「튄다」는 `ipc/mod.rs`만 걷는
  방향에서만 참이고, `protocol.ts`만 걷으면 그 순간 **장부가 사실이 된다**(죽은 상수 넷은
  경고만 남긴다). 도구의 재고는 `protocol.ts`의 `IPC` 맵에서 나오기 때문이다.
- 곁가지: 보고서 §7 머리말은 *「`src-tauri/src/ipc/mod.rs`·`app/src/api/shim.ts`·
  `src/shared/protocol.ts`의 계약면은 **R28j UPDATER가 쥐고 있어**」*라고 적는데, 소유권 표가
  적은 이름은 **`app/src/api/protocol.ts`**이고 그 경로는 **레포에 없다**(`app/src/api/`에는
  `chrome.ts`·`glassFallback.ts`·`shim.ts`·`unified.ts`뿐). `src/shared/protocol.ts`를 마지막으로
  만진 커밋은 `6891372`(R28b)이고 **R28j는 그 파일을 한 번도 안 만졌다**. 「protocol.ts」를
  그 파일로 읽는 것은 합리적이라 **미룬 것 자체를 탓하지는 않는다** — 다만 뒷정리 라운드가
  이 두 문장을 그대로 믿으면 **할 수 있는 절반을 못 할 이유로 삼는다.**
- **재현.** 워크트리 사본에서 `src/shared/protocol.ts`의 1347–1353을 지우고
  `node docs/critic/tools/critic-r28e-channels.mjs --tree=<사본>`.

### F4 [낮음] 보고서 §3의 못 목록 줄 번호 하나가 **이 라운드 자신의 커밋** 때문에 밀렸다

- §3 마지막 행: *「내가 새로 쓴 주석 5줄 … (`runtime.rs:544`·**`3946`**, …)」*.
  `df32df6`이 `runtime.rs:698` 근처에서 +2줄을 넣었으므로 그 낱말은 지금 **3948**이다
  (3946은 「R28f 이전에는…」 줄이다). 같은 문서 §5.3은 갱신됐다(`3920·3926` — 내 grep과 일치).
- **재현.** `git grep -n "대화 연결" -- crates/ccg-engine/src/runtime.rs` → `544`·**`3948`**.

### 확인했으나 **이 갈래의 결함이 아닌 것**(다음 크리틱이 다시 파지 않게)

- `ipc/mod.rs:282-289`의 죽은 상수 넷(경고 4개)과 `src/shared/protocol.ts`의 M10 블록
  (492–497·509·1347–1353·1511–1615) — **알려진 미룬 몫**이고 장부에 각주가 있다. 코드 잔재는
  남았지만 이 라운드가 「모른다」고 하지 않는다.
- `docs/renderer-divergence.md:939`(§6.12)가 아직 남은 여섯을 「`talk` 여섯 · M10」이라고
  적는다 — 바로 아래 §6.13이 그것을 정정한다. **§6.12는 옆 갈래(R28j)의 절이다.**
- 인계 기준선 `agentcodegui 170` vs 내 깨끗한 제거 전 측정 **174**(기준선이 낡았다).
- 옛 빌드가 저장한 `origin:'talk'` 말풍선이 화면에 안 뜬 축(D11)은 **양쪽 exe에서 똑같이**
  안 떴다 = 내 씨앗 모양의 한계이지 제거의 부수 피해가 아니다.
- 대조군에서 `crosstalk:stop`을 먼저 누르면 큐의 봉투가 걷힌다 — **계기의 자기 오염**.

---

## 4. 내가 만진 것

- 레포 **코드 수정 0**. 새 파일은 이 판정문 하나(`docs/critic/r28k-m10rm-critic-r2.md`)뿐이고
  `git commit --only`로 그 한 파일만 굳힌다.
- 레포 밖: 워크트리 둘(`D:/ccg-crit/r28k2-{pre,post}`) · target 둘
  (`D:/ccg-crit/target-r28k2-crit{,pre}`) · 계기와 산출물(`C:/Temp/crit-r28k2/`).
  `node_modules`는 레포 것에 **정션**으로 붙였다(복사·삭제 0 · `npm ci` 0).
- 남의 미커밋/미추적(`probe_wfire_crit.rs`·`probe_wfr2.rs` 등)은 `reset`·`checkout`·`stash`·
  `restore` **전부 안 했다**. 워크트리 안 사본의 `protocol.ts`만 실험 뒤 `checkout`으로
  되돌렸다(내 워크트리 · 레포 본체 아님).
- 기준 결과 파일(`docs/critic/*.json` · `bench/**`)은 **하나도 안 덮었다** — 내 산출물은 전부
  `C:/Temp/crit-r28k2/` 아래 새 이름이다.
- 격리 홈 잔존 0(자동 삭제 확인) · `git push`·태그·릴리스 0 · 이름 기반 kill 0.

---

## 5. 판정

**불합격 — 그러나 되돌릴 것은 없고, 남은 것은 화면 한 자리와 주석 셋이다.**

R1의 여섯은 여섯 다 닫혔고, 그것을 **내가 새로 빌드한 두 exe로** 확인했다. 라우터·봉투·
회신 잠금·설정 탭·알약·단축키·주입 배지는 세 창 전부에서 사라졌고, 대조군은 일곱 축에서
정확히 반대로 나오며, 지우면 안 되는 넷은 넷 다 살아 있고, `initialize` 바이트는 제거 전후로
같으며, 사라진 테스트 51개는 이름까지 M10 것이고, 게이트는 크레이트별·워크스페이스·
10회 병렬·타입체크 3종까지 전부 초록이다. **제품 동작 회귀는 이번에도 0이다.**

불합격은 **화면 잔재 한 자리**에서 온다.

1. **F1(중)** — 봉투 한 통만 남은 채팅에서는 필터가 **입도 못 댄다**(`engine/mod.rs:168`).
   그 채팅은 사이드바에 「1」을 달고, 열면 「작업이 끝나면 순서대로 전송돼요」 아래에
   `[대화 연결] <<<TALK-DATA …>>>` 전문을 보여 주며, 부팅을 세 번 해도 그대로다.
   나가지는 않으니 안전은 닫혔지만, **「통째로 들어냈다」는 문장이 그 화면 앞에서는 거짓**
   이고, 보고서·R1이 못 박은 「디스크에서도 지워진다 / 화면 0건」이 이 모양에서 깨진다.
2. **F2(낮)** — 이 라운드가 지운 하네스를 근거로 인용하는 주석이 자기 소유 파일에 남았다
   (`versions.rs:106`). F3+와 같은 종류인데, 「내가 지운 스크립트 이름」을 아무도 안 grep했다.
3. **F3·F4(낮)** — 각주의 「한쪽만 걷으면 튄다」는 반만 참이고(내가 실험했다:
   `protocol.ts`만 걷으면 `212/206/6`), §3의 줄 번호 한 칸은 이 라운드 자신의 커밋으로 밀렸다.

**가장 치명적인 하나: F1.** 나머지 셋은 주석과 장부라 다음 사람이 웃고 지나가지만, F1은
**사용자가 실제로 보는 화면**이다 — 기능을 뺀 이유가 「사람 자리를 대신 차지하는 한 줄」
이었는데, 그 한 줄이 아직 사람의 예약 목록에 앉아 있다.
