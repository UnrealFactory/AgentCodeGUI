# R28k — M10 「대화 연결」 제거 R1

> **한 줄.** 사용자 결정으로 세션 간 소통(M10)을 3.0에서 **통째로 들어냈다**. 제품 코드
> **10,279줄**이 사라졌고(28파일 · 그중 통째 삭제 11파일), 남긴 것은 셋뿐이다 —
> 은퇴한 1.x 「채팅 모드」 블롭 스토어, 그 편입 마이그레이션, 그리고 같은 자리에 얹혀
> 있던 **파리티 수선 한 칸**(채팅별 추가 지시가 Claude CLI까지 가는 배선).
> 제거 전후로 평범한 채팅의 `initialize` 프레임은 **바이트가 같고**(sha
> `afb039fc7966…` · 161B), 추가 지시가 있는 채팅은 그 문자열을 여전히 싣는다
> (sha `e73cf2f2310e…` · 291B).

- 커밋: `741bf57`(Rust) · `fe626b3`(렌더러) · `e86edd5`(하네스) · 이 문서
- 브랜치: `feature/3.0.0-beta` · 기준 HEAD: `57e55e6`
- 계기: `scripts/poc-m10-removal-bytes.mjs` · `scripts/poc-m10-removal-screen.mjs`
- 산출물: `docs/critic/m10rm-bytes-{pre,post,diff}.json` ·
  `docs/critic/m10rm-screen-{r3,ctl}.json`
- **확인 크리틱 R1 수정 라운드**(§9): 판정문 `docs/critic/r28k-m10rm-critic-r1.md` ·
  재실측 산출물 `docs/critic/m10rm-{screen-critfix1,bytes-critfix1,bytes-critfix1diff}.json`

---

## 1. 왜 뺐나

사용자 결정(2026-08-26): *"이 기능 자체가 역시 좀 위험한 거 같은데 그냥 깔끔하게 코드 다
빼자."* **숨기는 것이 아니라 빼는 것**이다.

다섯 라운드의 실측이 남긴 그림은 이랬다.

| 축 | 실측 | 읽는 법 |
|---|---|---|
| 안전 | 실 CLI 공격 **26표본 0뚫림** · N6 순종 **0/3** · K 상대배달 **0/10** · 결정적 벽 32칸 **PASS 0건** | 안전 축은 실제로 닫혔다 |
| 기능 | 정당한 왕복 완성률 **18%~93%** (Fisher 양측 **p=1.2e-3**) | 같은 exe·같은 봉투 문면·같은 엔진인데 결과가 흔들린다 |
| 원인 | **모델 재량** | 코드가 아니라서 코드로 못 잡는다 |
| 부작용 | R28h 크리틱 — 제품 기본값(`readonly`) 팔에서 **거짓 거절 3/11** | 「이 보드에서 당신이 맡은 역할을 한 문장으로」라는 인사에 앱의 고정 거절 문장이 붙었고, 한 판은 모델이 사유까지 지어냈다(요구된 적 없는 계정·환경 공개) |

그리고 이 갈래의 일관된 결론: **프롬프트 인젝션은 원리적으로 안 닫힌다.** 안전을 다섯
라운드 갈아 넣어 닫아 놓고도 기능이 미덥지 않다면, 남길 이유가 없다.

기록은 지우지 않았다 — `docs/design/m10-talk.md`와 `docs/m10-report-r{1,5,6,7}.md`에
**철회 헤더**를 달았고 본문은 그대로다. `docs/critic/*.json` 산출물도 전부 남았다.

---

## 2. 뺀 것 (파일 · 줄 수)

### 2.1 Rust — 커밋 `741bf57` (9파일 · +101 / −3,673)

| 파일 | +/− | 무엇 |
|---|---|---|
| `src-tauri/src/engine/talk.rs` | 0 / **2,864** | **통째 삭제.** 봉투 조립·발신 문법 파서·라우터·연쇄 회계·회신 전용 잠금·거절 문장 17종·문면 지문·권한 하한(`InjectPolicy`)·테스트 **43개** |
| `src-tauri/src/engine/hub.rs` | 3 / **332** | `Op::TalkConfig`/`TalkStop` · `Slot.talk_run` · `Hub.talk`/`stop_watch` · `StopWatch` · `STOP_VERIFY` · `talk_settle` · `purge_talk_queues` · `interrupt_talk_turns` · `verify_stop` · `note_human` · 안내 배선 · `observe` · `engine:debug`의 `talk` 칸 |
| `src-tauri/src/engine/mod.rs` | 15 / 19 | `mod talk` · `crosstalk:{config,set,stop}` 세 채널 · `origin_of`의 `"talk"` 어휘 (+ 재장전 필터 신설) |
| `crates/ccg-engine/src/runtime.rs` | 71 / 144 | `talk_guide` 필드 · `set_talk_guide` · `Stream.spawn_guide` · `reuse_decision`의 안내 축 · `append_prompt`의 `guide` 인자 · M10 테스트 1개 |
| `crates/ccg-engine/src/queue.rs` | 1 / 20 | `QueueOrigin::Talk` + 그 wire 어휘 · `QueueInput.require_picker` |
| `crates/ccg-store/src/talk.rs` | 5 / **289** | `talk-config.json`·`talk-state.json`의 설정·연쇄 회계 전부 + 테스트 **7개**. 위쪽 1.x 블롭 3함수는 **유지** |
| `crates/ccg-store/src/status.rs` | 4 / 3 | `QueuedText.origin` 주석의 M10 어휘 |
| `crates/ccg-store/src/lib.rs`·`testhome.rs` | 2 / 2 | 사라진 테스트 이름을 가리키던 서사 주석 |

### 2.2 렌더러 — 커밋 `fe626b3` (9파일 · +7 / −706)

| 파일 | +/− | 무엇 |
|---|---|---|
| `app/src/lib/crosstalk.ts` | 0 / **157** | **통째 삭제.** `crosstalk:{config,set,stop,state}` 창구 · `TALK_OFF` · `useTalkConfig` · `readTalkBoards` · `STOP_HOTKEY`(Ctrl+Shift+.)·`isStopHotkey` |
| `app/src/components/TalkStop.tsx` | 0 / **150** | **통째 삭제.** `stopSaid` · `useTalkStop`(단축키 캡처 리스너) · `TalkStopPill` |
| `app/src/components/Settings.tsx` | 2 / 308 | `TalkView` **298줄** · 나침반 항목 · `SettingsView` 유니온의 `'talk'` · 렌더 분기 · import 2 · `IconMessage` import |
| `app/src/styles.css` | 0 / 47 | `.talk-stop*` 5규칙 + `@keyframes talkpulse` + `.msg.user.injected`·`.msg-origin` |
| `app/src/App.tsx` | 0 / 19 | `TalkStopPill` 자리 + import + 주석 |
| `app/src/store/session.ts` | 4 / 15 | `ThreadItem.origin` · `user-echo` 액션의 `origin` · `engineAction`의 `origin` 파싱 |
| `app/src/components/Chat.tsx` | 1 / 6 | `origin === 'talk'` 주입 배지 |
| `PanelWindow.tsx`·`SessionWindow.tsx` | 0 / 4 | `TalkStopPill` 두 자리 + import |

### 2.3 하네스 — 커밋 `e86edd5` (10파일 · +276 / −5,900)

`poc-talk.mjs`(1,447) · `critic-m10-r3-attack.mjs`(1,112) · `critic-m10-r2-attack.mjs`(1,082) ·
`critic-m10-attack.mjs`(855) · `critic-m10-r6-bytes.mjs`(565) · `critic-m10-corpus.mjs`(317) ·
`critic-m10-stamp.mjs`(273) · `critic-m10-live-account.mjs`(168) · `score-m10-leak.mjs`(81).
새로 쓴 것: `poc-m10-removal-bytes.mjs`(276).

**합계: 28파일 · +384 / −10,279.** 통째 삭제 11파일.

---

## 3. 일부러 남긴 것 — 이름이 같지만 다른 물건이다

| 남긴 것 | 왜 |
|---|---|
| `crates/ccg-store/src/talk.rs`의 `read`/`write`/`empty_blob` (26줄) | 은퇴한 **1.x 「채팅 모드」**의 `chat-talk.json` 블롭 스토어(원본 `src/main/talkStore.ts`). M10과 무관하고, 2.6.2도 하던 **1회 편입 마이그레이션**의 재료다 = 파리티 항목 |
| `crates/ccg-store/src/migrate_v3.rs`의 chat-talk 5단계 | 같은 이유. 2.6.2 `App.tsx:558-566`의 채택 규칙 그대로 |
| `src-tauri/src/ipc/stores.rs`·`unified.rs`의 `talk:get`/`talk:save` · `bin/ccg_migrate.rs`의 `"talk"` 덤프 | 같은 이유(1.x 블롭의 읽기/쓰기 창구) |
| `window.api.talk.{getState,saveState}` + `app/src/App.tsx:703-786`의 편입 코드 | 같은 이유. 2.6.2도 하는 일이고 **파리티 항목** |
| `app/src/api/shim.ts:510-518`의 `talk:{run,cancel,permission-respond,question-respond,bg-task,event}` | 1.x 「채팅 (순수 대화) 엔진」의 채널이다. **M10이 아니다** — 감사의 계약면 `missing` 목록에 이미 그 이름으로 올라 있다 |
| `app/src/styles.css`의 `.chat--talk` 두 규칙 | 같은 1.x 채팅 모드의 컴포저 폭. M0(`d7f87e3`)부터 있었고 **M10보다 앞선다** |
| `src/shared/protocol.ts:796` `ApiUsageSource = 'chat' \| 'talk' \| 'ma'` | 위 1.x 엔진의 사용 통계 분류 축 |
| ★ `crates/ccg-engine/src/runtime.rs`의 `append_prompt` = `RunIdentity::system_prompt` | **파리티 수선이다(§4)** |
| 내가 새로 쓴 주석 5줄에 남은 「대화 연결」 낱말 (`runtime.rs:544`·`3946`, `engine/mod.rs:132`·`194`, `ccg-store/talk.rs:8`) | 무엇을 왜 뺐고 무엇을 왜 남겼는지를 가리키는 **못**이다. 이 낱말을 지우면 다음 사람이 §4의 수선을 M10 잔재로 오해하고 다시 걷어낸다 |

---

## 4. ★ 같이 걷어내면 안 되는 것 — `append_prompt`의 `system_prompt` 몫

R28f 이전에는 `initialize_request(…, append)`의 `append` 인자가 **두 호출처 모두 무조건
`None`**이었다(`t1_spawn` · 능동 프로브 ⑥). 그래서 사용자가 채팅에 적어 둔 **추가 지시가
Claude 엔진에서는 한 번도 안 나갔다** — Codex는 `developerInstructions`로 이미 싣고
있었으므로, **같은 설정이 엔진에 따라 사문**이었다는 뜻이다. R28f/M10 R6이 그 자리를
배선하면서 자기 안내(`talk_guide`)와 이 수선을 **함께** 얹었다.

M10을 걷어낼 때 이 수선까지 걷어내면 그 파리티 결함이 되살아난다. 그래서 **guide 몫만
빼고 system_prompt 몫은 남겼고**, 함수를 그 하나만 하는 모양으로 좁혔다:

```rust
fn append_prompt(id: &RunIdentity) -> Option<String> {
    id.system_prompt().filter(|p| !p.trim().is_empty()).map(str::to_string)
}
```

**못 셋을 박았다.**

1. `runtime.rs::tests::the_per_chat_extra_instruction_actually_reaches_the_cli` —
   추가 지시를 얹은 정체성으로 실제 `Cmd::Send`를 돌려 `initialize` 프레임의
   `systemPrompt.append`에 그 문자열이 있는지 본다. 없거나 공백뿐이면 **키 자체가 없다**도
   함께 잰다(빈 문자열을 실으면 CLI가 `claude_code` 프리셋을 죽인다 — driver §4.2).
2. `runtime.rs::tests::a_chat_without_extra_instructions_changes_no_prompt_bytes` —
   반대 방향. 추가 지시가 없으면 `systemPrompt` **키가 없다**.
3. 프로세스 밖 실측 — §5.1.

---

## 5. 실측

### 5.1 프롬프트 바이트 — 제거 전후로 **안 변한다**

계기: `scripts/poc-m10-removal-bytes.mjs`. 가짜 CLI(`ccg-fakecli.exe`)의 `CCG_FAKECLI_IN`은
받은 stdin 줄을 한 글자도 안 고치고 파일에 덧붙인다 = 프로세스 밖에서 재는 바이트다.
같은 스크립트가 **제거 전 exe와 제거 후 exe 양쪽에서** 돈다(M10 설정을 아예 안 만진다).

| 축 | 제거 전 (`target-r28k-rm-pre`) | 제거 후 (`target-r28k-rm`) | 판정 |
|---|---|---|---|
| 추가 지시 **없는** 채팅의 `initialize` | sha256 `afb039fc7966…` · **161B** · `systemPrompt` 키 **부재** | sha256 `afb039fc7966…` · **161B** · 키 **부재** | **바이트 동일** |
| 추가 지시 **있는** 채팅의 `initialize` | sha256 `e73cf2f2310e…` · **291B** · `append` = `"너는 코드 리뷰어다. 답은 한 문장으로만 한다."` | sha256 `e73cf2f2310e…` · **291B** · 같은 `append` | **바이트 동일** |

전문(제거 후):

```
{"type":"control_request","request_id":"init-1","request":{"subtype":"initialize","forwardSubagentText":true,"supportedDialogKinds":["refusal_fallback_prompt"]}}
{"type":"control_request","request_id":"init-1","request":{"subtype":"initialize","forwardSubagentText":true,"supportedDialogKinds":["refusal_fallback_prompt"],"systemPrompt":{"type":"preset","preset":"claude_code","append":"너는 코드 리뷰어다. 답은 한 문장으로만 한다."}}}
```

판정 산출물 `docs/critic/m10rm-bytes-diff.json` — `pass:true` · `plain.identical:true` ·
`instructed.identical:true`.

> **정직하게 적어 둘 것.** 두 exe는 내 제거 말고도 그 사이에 착지한 R28i 커밋 여섯과
> R28j의 미커밋 업데이터 작업만큼 다르다(같은 워킹트리에서 두 갈래가 돈다). 그 축들은
> `initialize` 프레임을 안 지나므로 바이트가 같은 것이 맞고, 단위 못 둘(§4)이 그 성질을
> 프로세스 안쪽에서 따로 잠근다.

### 5.2 화면·옛 홈 — 여섯 축, **대조군이 여섯 다 뒤집힌다**

계기: `scripts/poc-m10-removal-screen.mjs`. 씨앗은 **M10을 켜 두고 쓰던 홈**이다
(`talk-config.json` = `enabled:true` + 보드 옵트인 + `injectPolicy:'ask'` + `noticeAckAt`,
`talk-state.json` = 연쇄 회계, 그리고 마이그레이션된 채팅 파일에 손으로 심은
`origin:"talk"` 봉투 한 통 + 사람 예약 한 줄).

> **★확인 크리틱 R1 뒤 이 하네스의 두 축을 더 조였다**(§9-2). S0은 채널을 **넷 다** 누르고,
> S1은 씨앗을 **세 줄**(봉투 · 사람 · 한도 이어서)로 늘려 필터가 **과잉이 아닌지**까지
> 본다. 아래 표는 원판 주행이고, 조인 뒤의 값은 §9-2에 있다.

| 축 | 제거 후(`m10rm-screen-r3.json`) | 제거 전 대조군(`m10rm-screen-ctl.json`) |
|---|---|---|
| **S0 옛 홈 관용** | 부팅 ✔ · `#root` 마운트 ✔ · `crosstalk:config` → `{__unimplemented:true}` · 옛 두 파일 **그대로 남음**(`enabled:true` 유지) | 채널이 살아 있어 설정 전문을 돌려준다 |
| **S1 봉투 재장전** | `queued:1` — **봉투는 버려지고 사람 예약만 산다** | `queued:2` — 봉투 `[대화 연결] <<<TALK-DATA …>>>`가 **큐에 되살아난다**(그 다음 발화에 사람 것인 척 CLI로 들어간다) |
| **S2 나침반** | `talk` → `[]` · `대화 연결` → `[]` · `crosstalk` → `[]` | 셋 다 `["Talk"]` |
| **S3a 메인 창** | `.talk-stop` 없음 · Ctrl+Shift+. 눌러도 `.talk-stop-said` 없음 | 알약 **있음** · 키를 누르니 결과 문장이 **뜬다** |
| **S3b 추가 채팅 창(#session)** | 없음 · 무반응 | 키를 누르니 결과 문장이 **뜬다** |
| **S3c 팝아웃(#mapanel)** | 없음 · 무반응 | 키를 누르니 결과 문장이 **뜬다** |

대조군이 여섯 축 전부에서 반대로 나온다 = **이 하네스는 눈이 멀지 않았다**. 특히 S1은
「어휘만 지우면 되지 않나」에 대한 답이다: `origin_of`에서 `"talk"`를 지우기만 하면 그
줄은 `None`(= 사람)으로 떨어져 **사람의 이름표를 달고 되살아난다**. 그래서 재장전
단계에서 통째로 버린다(`engine/mod.rs::is_retired_talk_row`).

### 5.3 grep — 제품 코드 0건

| 어휘 | `app/src` · `src-tauri/src` · `crates/*/src` | 비고 |
|---|---|---|
| `crosstalk` | **4건** — 전부 `src-tauri/src/ipc/mod.rs:285-289`의 상수 | §7(다른 갈래 소유) |
| `talk_guide` · `spawn_guide` · `talk_run` · `TalkStop` · `TalkConfig` · `TalkSent` · `TalkResult` · `QueueOrigin::Talk` · `require_picker` | **0건** | |
| `picker_unavailable` · `TALK-DATA` · `reply_only` · `maxHops` · `maxFanout` · `injectPolicy` · `noticeAckAt` · `stopVerdict` · `unstoppable` · `hop_cap` · `msg-origin` · `talk-stop` | **0건** | ★확인 크리틱 R1이 더 훑은 어휘를 내 손으로도 다시 셌다 |
| `@talk` | **0건** | |
| `대화 연결` | **6건** — 5는 이번 라운드가 쓴 「무엇을 뺐나」 주석, 1은 `ipc/mod.rs:282` | §3 마지막 행 · §7 |
| `봉투` | 다수 — 전부 IPC **이벤트 봉투**(`chat:event`·`ma:event`)·컨트롤 프레임의 일반 낱말 | M10 아님 |
| `M10`(주석 전수) | **살아 있는 로직의 역사 귀속 3건**(`migrate_v3.rs:635·837·1090`) + **이번 라운드가 박은 못 3건**(`runtime.rs:3920·3926` · `engine/mod.rs:194`) + `ipc/mod.rs:282` | ★확인 크리틱 R1 F2·F3으로 **죽은 주석 3건을 걷어냈다**(§9-1) |

빌드 산출물(`app/dist/assets/*.{js,css}`)에서 `crosstalk` · `talk-stop` · `@talk` ·
`대화 연결` · `msg-origin` **각 0건**.

### 5.4 게이트

| 게이트 | 값 |
|---|---|
| `cargo check --workspace --all-targets --features custom-protocol` | exit 0 (경고 4 = §7) |
| `cargo test --workspace` | exit 0 · 실패 0 |
| `cargo build --release --features custom-protocol -p agentcodegui` | exit 0 |
| `agentcodegui` 기본 병렬 **10회 연속** | **10/10 초록 · 매회 136 통과 = 1,360/1,360** |
| `npm run typecheck:node` · `:web` · `typecheck:app` | 세 개 다 exit 0 |
| `npm run app:build`(vite 프로덕션) | exit 0 |

### 5.5 테스트 수 — 줄어든 수를 이름까지 대조했다

「제거 전」은 **같은 HEAD(`57e55e6`)의 detached 워크트리**에서 잰 값이다(같은 트리에서
다른 갈래가 동시에 커밋하고 있어, 인수인계 문서의 숫자와 시점이 다르다).

| 크레이트 | 제거 전(대조 워크트리) | 제거 후(작업 트리) | 차 | 설명 |
|---|---|---|---|---|
| `agentcodegui` | **174** | **136** | −38 | 사라진 것 = `engine::talk::tests::*` **43개 전부**. 늘어난 것 = R28j UPDATER의 **미커밋** `updater::tests::*` 5개(내 것이 아니다). −43 +5 = −38 |
| `ccg-engine` | **233** | **250** | +17 | 미추적 남의 계기 `probe_wfire_crit.rs`·`probe_wfr2.rs` **+18** · 내가 뺀 `turning_the_board_off_respawns_the_resident_cli` **−1**. 그 둘을 빼면 233 → **232** |
| `ccg-store` | **92** | **85** | −7 | `talk.rs`의 `m10_tests` 7개 |
| `ccg-auth` | 126 | 126 | 0 | |
| `ccg-fs` | 101 | 101 | 0 | |
| `ccg-lsp` | 59 | 59 | 0 | |

사라진 51개(43 + 7 + 1)는 **하나도 빠짐없이 M10 것**이다. 이름 목록은
`cargo test -p agentcodegui -- --list`의 전후 `comm -23`으로 대조했다.

---

## 6. 파리티는 안 깨진다

M10은 **2.6.2에 없던 3.0 전용 신기능**이다. 2.6.2에는 세션 간 소통이 아예 없었고
(그 아이디어는 2.6.2에서 만들었다가 *"자동으로 대화하는 게 위험하다"*로 **롤백**된 적이
있다 — 사용자 메모리 `peer-messaging-app-router`), 3.0이 다시 세운 것이 M10이었다.
따라서 **없애도 2.6.2 대비 격차가 생기지 않는다.** 장부에서 확인한 사실 셋:

1. `docs/renderer-divergence.md`의 M10 항목은 **§6 「의도적 분기」에 없었다** — 이 기능은
   2.6.2 렌더러를 고쳐서 만든 것이 아니라 3.0 전용 화면(`app/src`)에만 있었다.
2. 계약면 `missing` 목록의 `talk` 여섯(`talk:{run,cancel,permission-respond,
   question-respond,bg-task,event}`)은 **1.x 「채팅 모드」**의 것이다 — 2.6.2가
   `src/main/index.ts:1128`에서 `talkEngine`으로 구현해 두었지만 **2.6.2 렌더러에서
   그 여섯을 부르는 자리는 0**이다(모드가 은퇴했다). M10의 채널은 `crosstalk:*` 넷이고
   `missing`에 없었다.

   **감사 도구로 직접 쟀다**(`docs/critic/tools/critic-r28e-channels.mjs`):

   | 트리 | total | impl | commentOnly | missing |
   |---|---|---|---|---|
   | 제거 전 대조 워크트리(`57e55e6`) | 216 | 207 | 0 | **9** (`talk:*` 6 + `app:update-*` 3) |
   | 제거 후 작업 트리 | 216 | 210 | 0 | **6** (`talk:*` 6) |

   줄어든 셋은 R28j UPDATER의 몫이다. **내 제거는 이 면을 한 칸도 안 움직였다.**

   > **감사 도구의 한 가지 관대함을 적어 둔다.** 스캐너는 `crosstalk:*` 넷을 아직
   > `impl`로 센다 — 근거가 `src-tauri/src/ipc/mod.rs:285-289`의 **상수 정의 한 줄씩**
   > 뿐이고, 디스패처 팔은 이미 없다. 뜬 앱의 실측은 다르다: `crosstalk:config`를 부르면
   > **`{__unimplemented:true}`**가 온다(§5.2 S0). 그래서 §7.1의 뒷정리는
   > **protocol.ts의 IPC 항목 넷과 Rust 상수 넷을 반드시 같은 커밋에서** 걷어야 한다 —
   > 한쪽만 걷으면 그 순간 `missing`이 6 → 10으로 뛴다.

   그리고 최종 파리티 감사 R5 §6은 그 여섯을 **「M10 소유」**라고 적었는데, 그건
   이름이 같아서 생긴 오분류다(M10은 `crosstalk:*`를 썼고, 그 이유가 바로 이 이름
   충돌이었다 — 지금 지운 `ipc/mod.rs:283-284` 주석이 그렇게 적혀 있었다). 그 문서는
   기록이라 안 고치고 여기 적어 둔다.
3. 화면 축: 제거된 설정 탭 `Talk` 하나는 2.6.2 설정에 대응물이 없다(2.6.2 설정 탭은
   Profile/Account/Engine/API/MCP/Skill/Display/Language/Code/Explorer/Gestures).

---

## 7. ★ 다른 갈래 소유라 이 라운드에서 못 뺀 것 — 뒷정리 목록

`src-tauri/src/ipc/mod.rs` · `app/src/api/shim.ts` · `src/shared/protocol.ts`의 계약면은
**R28j UPDATER가 쥐고 있어** 이 라운드에서 못 만졌다. 아래가 그 정확한 목록이다
(줄 번호는 `e86edd5` 시점 · 두 갈래가 같은 파일을 만지므로 **식별자로도** 적는다).

### 7.1 `src-tauri/src/ipc/mod.rs` — 지금 `never used` 경고 4개를 내고 있다

| 줄 | 내용 |
|---|---|
| 282–284 | `// ── M10 대화 연결(세션 간 소통) ───` 배너 주석 3줄 |
| 285 | `pub const CROSSTALK_CONFIG: &str = "crosstalk:config";` |
| 286 | `pub const CROSSTALK_SET: &str = "crosstalk:set";` |
| 287 | `pub const CROSSTALK_STOP: &str = "crosstalk:stop";` |
| 288 | `/// 브로드캐스트 — 설정이 바뀌었다(긴급 정지 포함)…` (289줄의 doc) |
| 289 | `pub const CROSSTALK_STATE: &str = "crosstalk:state";` |

**282–289 통째 삭제**가 답이다(290은 빈 줄이라 남겨도 되고 같이 지워도 된다).
`TALK_GET`(**110**) · `TALK_SAVE`(**111**)와 22줄의 `talk:*(은퇴)` 언급은 **1.x 블롭**
이므로 **건드리지 마라**. (★확인 크리틱 R1 뒤 다시 셌다 — 원본이 적은 `98`·`99`는
`PROFILE_GET`/`PROFILE_SAVE` 줄이다. 그 줄을 지웠으면 **프로필 저장이 죽었다**.)

**이 넷은 지금 계약면 장부를 거짓말하게 만들고 있다.** 감사 도구
(`docs/critic/tools/critic-r28e-channels.mjs`)는 이 죽은 상수 정의 한 줄씩을 근거로
`crosstalk:*` 넷을 아직 `verdict:"impl"`(`codeN:1`)로 세지만, **뜬 앱은 넷 다
`{__unimplemented:true}`**를 돌려준다. 자세한 것은 `docs/renderer-divergence.md` §6.13의
각주 — 그 표의 `missing 6`은 도구의 관대함이고 **참값은 10**이다.

### 7.2 `src/shared/protocol.ts`

**★확인 크리틱 R1 F6으로 세 칸을 정정했다**(아래 표는 정정본이다 — 원본은 `492–496` ·
`1542–1571` · `1610–1616`이었고 세 군데 다 한 줄씩 짧아 지우면 고아가 남았다). 줄 번호는
`b9f5701` 시점의 `src/shared/protocol.ts`이고, **내가 파일을 한 줄씩 열어 다시 셌다.**

| 줄 | 내용 | 끝 줄이 무엇인가(정정의 근거) |
|---|---|---|
| **492–497** | `// ★ M10 — talk이 붙어 오면 …` 주석 **6줄** (`notice` 변형에 붙어 있다) | 497 = `// 사용자는 두 세션이 왜 안 붙는지 알 수 없고, 모델은 같은 줄을 …` |
| 509 | `talk?: TalkSent` — `EngineEvent{type:'notice'}`의 선택 필드 | — |
| 1347–1349 | `// ── 대화 연결 (4) — M10 …` 배너 주석 3줄 | 1349 = `//    호출이 새 라우터로 떨어진다.` |
| 1350–1353 | `crosstalkConfig` · `crosstalkSet` · `crosstalkStop` · `crosstalkState` (`IPC` 표) | 1353 = `crosstalkState: 'crosstalk:state'` (**뒤에 콤마 없음** — 1346 `chatFlushReq` 줄의 콤마는 그대로 둔다) |
| 1511–1540 | `/* ── M10 대화 연결 … */` 블록 주석 + `export type TalkResult` (17값) | 1540 = `| 'picker_unavailable'` |
| **1542–1572** | `TalkSent` doc + `export interface TalkSent` | 1572 = 인터페이스 닫는 `}` |
| 1574–**1607** | `TalkConfig` doc + `export interface TalkConfig` | 1607 = 인터페이스 닫는 `}` |
| **1609**–1615 | `/** 긴급 정지 상수 … */` doc(1609) + `export const CROSSTALK = { … } as const`(1610–1615) | 1615 = `} as const` |

> **더 간단한 길.** 1511부터 1616까지는 M10 블록 넷과 그 사이 빈 줄뿐이다(1541 · 1573 ·
> 1608 · 1616이 빈 줄). **1511–1616을 통째로 지우면** 1510(빈 줄)과 1617(`ChatStatusLite`
> doc) 사이가 빈 줄 하나로 정확히 맞는다 — 위 네 칸을 따로 셀 필요가 없다.

**건드리면 안 되는 것**: 1117–1123의 `talkRun`/`talkCancel`/`talkPermissionRespond`/
`talkQuestionRespond`/`talkBgTask`/`talkGet`/`talkSave` · 1275의 `talkEvent` · 796의
`ApiUsageSource`의 `'talk'` — 전부 **1.x 채팅 모드**다.

### 7.3 `app/src/api/shim.ts`

**뺄 것 없음.** 510–518의 `talk: { … }` 블록은 1.x 채팅 모드의 창구이고, 그중
`getState`/`saveState`는 App.tsx의 편입 마이그레이션이 **지금도 쓴다**(파리티 항목).

### 7.4 계약면 삭제 뒤 확인할 것

`TalkResult`의 `'picker_unavailable'`(1540)은 **엔진 쪽에서 이미 사라졌다**
(`QueueInput.require_picker`가 M10 전용 fail-closed 게이트였고 함께 뺐다). 계약면을
정리하는 라운드는 그 값이 어디에도 안 남는지 함께 확인하면 된다.

---

## 8. 만진 파일 (28 + 문서)

**삭제(11)**: `src-tauri/src/engine/talk.rs` · `app/src/lib/crosstalk.ts` ·
`app/src/components/TalkStop.tsx` · `scripts/{poc-talk,critic-m10-attack,critic-m10-corpus,
critic-m10-live-account,critic-m10-r2-attack,critic-m10-r3-attack,critic-m10-r6-bytes,
critic-m10-stamp,score-m10-leak}.mjs`(9)

**수정(17)**: `src-tauri/src/engine/{hub,mod}.rs` ·
`crates/ccg-engine/src/{runtime,queue}.rs` ·
`crates/ccg-store/src/{talk,status,lib,testhome}.rs` ·
`app/src/App.tsx` · `app/src/components/{Settings,Chat,PanelWindow,SessionWindow}.tsx` ·
`app/src/store/session.ts` · `app/src/styles.css`

**신설(2)**: `scripts/poc-m10-removal-bytes.mjs` · `scripts/poc-m10-removal-screen.mjs`

**문서**: `docs/design/m10-talk.md` · `docs/m10-report-r{1,5,6,7}.md`(철회 헤더) ·
`docs/renderer-divergence.md`(장부) · 이 문서

---

## 9. 확인 크리틱 R1 뒤 — 잔재 여섯을 걷었다 (수정 R1)

판정문 `docs/critic/r28k-m10rm-critic-r1.md`(**불합격** · 치명 0 · 중 1 · 낮음 5).
크리틱이 **제품 동작 회귀는 하나도 못 찾았다** — 걸린 것은 전부 「죽은 채 남은 것」과
「장부가 실제와 다른 것」이다. 여섯 다 고쳤고, **여섯 다 내 손으로 다시 쟀다.**

### 9-1 무엇을 고쳤나

| # | 등급 | 무엇이 틀렸나 | 어떻게 고쳤나 |
|---|---|---|---|
| **F1** | 중 | 장부 §6.13이 `missing 6`을 표로 못 박았는데 **뜬 앱의 사실이 아니다**(참값 10). 감사 도구가 죽은 상수 넷을 근거로 `crosstalk:*`를 아직 `impl`로 센다 | `docs/renderer-divergence.md` §6.13에 **각주**를 달았다 — 표 칸에 「★아래 각주. **뜬 앱의 참값은 10이다**」를 박고, 왜 이 라운드가 코드를 못 고치는지(UPDATER 소유)와 뒷정리가 **두 파일을 같은 커밋에서** 걷어야 하는 이유까지 적었다. §7.1에도 같은 경고를 옮겼다 |
| **F2** | 낮 | 지운 `<TalkStopPill />`을 **설명하는 주석**이 그 자리에 남아 「이 창에도 정지가 있다」고 거짓을 말했다(`SessionWindow.tsx:737` · `PanelWindow.tsx:452`) | 두 주석 덩이 **삭제**. 남은 주석은 그 자리 원래 주인(「본채팅 화면 그대로…」 · 「창 드래그 띠…」)뿐이다 |
| **F3** | 낮 | `runtime.rs:701`의 주석이 **불가능해진 시나리오**(`talk`으로 앉아 있던 예약)를 설명했다 | 쌍둥이 주석(`status.rs`의 `QueuedText.origin`)과 서사를 맞췄다 — 지금 살아 있는 이름표 셋(`limit_resume`·`viewer_ask`·`notif_replay`)을 적고 `talk`을 뺐다 |
| **F3+** | — | **크리틱이 못 본 넷째 자리.** `src-tauri/src/engine/hub.rs:1113`의 주석이 억제 예외를 `` (`Talk`·`LimitResume`…) ``라고 적어 **없어진 열거 값**을 가리켰다 | 살아 있는 셋(`LimitResume`·`ViewerAsk`·`NotifReplay`)으로 고치고 「봉투」 어휘를 「기계 예약」으로 바꿨다. 규칙 자체는 그대로 산다 |
| **F4** | 낮 | 인수인계서가 아직 **「M10을 새로 짜라」**고 말했다(`HANDOFF-3.0.md:198`) · `ARCHITECTURE-3.0.md:42`의 `ccg-peer`도 철회 표시 없음 | 두 줄 다 **철회 문단**으로 바꿨다. HANDOFF는 취소선 + 사유(왕복 18~93% · 거짓 거절 3/11) + 기록 위치 + 「다시 하자는 제안이 오면 이 문단을 먼저 보여 줘라」. ARCHITECTURE는 그 크레이트가 **만들어진 적 없다**는 사실까지 같이 적었다 |
| **F5** | 낮 | `docs/critic/`의 M10 판정문 **일곱 장**에 철회 헤더가 없었다 | 일곱 장 전부에 다섯 장과 같은 헤더를 달았다(`m10-r{1,2,3}.md` · `r28f-m10-critic-r{1,2}.md` · `r28h-m10-critic-r{1,2}.md`). 판정문에는 한 문단을 더 붙였다 — **「아래의 『고쳐라』는 전부 효력이 없다」** |
| **F6** | 낮 | 미룬 계약면 줄 목록이 **세 군데 한 줄씩** 어긋났다(§7.2) | 셋 다 정정하고 **끝 줄이 무엇인지**를 근거 칸으로 붙였다. 「**1511–1616 통째 삭제**」라는 더 간단한 길도 적었다. 덤으로 §7.1의 `TALK_GET(98)/TALK_SAVE(99)`가 실은 **`PROFILE_GET`/`PROFILE_SAVE`** 줄이라는 것을 잡아 **110/111**로 고쳤다(그 줄을 지웠으면 프로필 저장이 죽었다). §7.2의 「건드리지 마라」도 7개 이름에 6줄이던 것을 **1117–1123**으로 맞췄다 |
| **계기 흠** | — | 크리틱이 지적한 `poc-m10-removal-bytes.mjs`의 `exe.sha256`이 **파일의 sha256이 아니었다**(latin1 왕복) | 버퍼를 그대로 해싱하도록 고치고 `bytes`(파일 크기)도 같이 싣는다. 이제 `sha256sum`과 값이 맞는다 |

### 9-2 무엇을 다시 쟀나 (전부 내 손, 새 빌드)

빌드: `vite build` + `cargo build --release --features custom-protocol`
(`CARGO_TARGET_DIR=target-r28k-rm`) 둘 다 **exit 0**.
exe `agentcodegui.exe` sha256 **`9b36cdd09c6fe6537147d0352c926f60e05683c08969c09e09a2c9ff39a12097`** ·
7,066,112 B. 가짜 CLI `ccg-fakecli.exe` sha256 `c7592a8f53a9…`.

| 축 | 값 | 무엇을 말하나 |
|---|---|---|
| **★F1 라이브 — 네 채널을 다 눌렀다** | `crosstalk:{config,set,stop,state}` → **넷 다 `{__unimplemented:true}`** (`m10rm-screen-critfix1.json` S0) | 감사 도구의 `impl`은 **죽은 상수**를 본 것이고, 사용자가 겪는 계약면은 `missing`이다 |
| **★F1 도구 — 원자료를 열었다** | 넷 다 `verdict:"impl"` · `code:["src-tauri/src/ipc/mod.rs:285|286|287|289"]` · **`codeN:1`** · `commentN:0` | 근거가 상수 정의 **한 줄씩**뿐이다 — 디스패처 팔은 없다 |
| **★F1 컴파일러 — 셋째 증인** | `never used` **정확히 4개**(`CROSSTALK_{CONFIG,SET,STOP,STATE}`) · 그 밖의 경고 0 | 컴파일러도 「죽었다」고 말한다 |
| 계약면 재고 | `total 216 · impl 210 · commentOnly 0 · missing 6` (`C:/Temp/r28k-fix/chan-post.json`) | 빌더·크리틱 수치 재현. **그 수치의 뜻은 §6.13 각주가 말한다** |
| 프롬프트 바이트 | 추가 지시 **없는** 채팅 `initialize` = sha `afb039fc7966…` · **161B** · `systemPrompt` 키 부재 → 제거 전 exe와 **`identical:true`** · 있는 채팅 = `e73cf2f2310e…` · 291B · append에 그 문자열 · **`pass:true`** (`m10rm-bytes-critfix1.json` + `--diff`) | 주석을 세 자리 고쳤는데 **선 위 바이트는 한 글자도 안 변했다** |
| 화면 잔재 | **6/6 PASS** — S0 옛 홈(부팅 ✔ · 옛 두 파일 그대로 · `enabled:true` 유지) · S1 · S2 나침반(`talk`·`대화 연결`·`crosstalk` 셋 다 `[]`) · S3a 메인 · S3b `#session` · S3c `#mapanel` | 세 창 전부 알약 없음 · Ctrl+Shift+. 무반응 |
| **S1 — 필터가 과잉이 아니다** | 씨앗 **세 줄**(`talk` · `user` · `limit_resume`) → 런타임 `queued:2`, 디스크 `queue`가 **`["user","limit_resume"]`로 다시 굳는다** | 봉투만 죽고 사람·한도 예약은 산다. 런타임에서만 거른 게 아니라 **파일에서도 사라진다** |
| grep | `crosstalk` 4(전부 `ipc/mod.rs`) · `대화 연결` 6(5 = 내 못, 1 = `ipc/mod.rs`) · 나머지 22개 어휘 **각 0** · 번들 **각 0** | §5.3 표 갱신 |
| 게이트 | `cargo test --workspace` **exit 0 · 0 failed** · `agentcodegui` 기본 병렬 **10회 연속 10/10** · `tsc` node·web·app **셋 다 exit 0** · `vite build` exit 0 | 후퇴 0 |

### 9-3 그래도 안 닫힌 것 — 다음 라운드가 받는다

**코드로는 `ipc/mod.rs` 282–289와 `src/shared/protocol.ts`의 IPC 항목 넷이 남는다.**
이 라운드가 못 만지는 것이 규율상 옳고(R28j UPDATER 소유), 그래서 **장부에 각주로**
못을 박았다. 뒷정리 라운드가 §7.1 + §7.2의 목록으로 **한 커밋에** 걷으면
`total 212 / impl 206 / missing 6`으로 맞는다 — 한쪽만 걷으면 `missing`이 6 → 10으로
**튄다**.
