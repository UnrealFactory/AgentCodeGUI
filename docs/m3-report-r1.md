# M3 × M-LOGIC 빌드 보고 — R1 (엔진 코어 + 재생 하네스)

**범위**: `crates/ccg-engine/`(신설) · `crates/ccg-engine/tests/`(재생 하네스) ·
`scripts/import-wire-fixtures.mjs`(신설) · 이 문서.
**안 건드린 것**: `src-tauri/`(배선은 다음 라운드) · `src/shared/protocol.ts`(M2 소유) ·
`app/` · `docs/design/`(읽기만) · `scripts/poc-rs/`(그대로 둠 — 새로 짰다).

**계약 문서**: `docs/design/m-logic.md` R3 · `docs/design/m-logic-replay.md` R3 ·
`docs/protocol-claude-cli.md` · `docs/critic/m3-poc.md`.

---

## 0. 한 장 요약

| 항목 | 수치 |
|---|---|
| 테스트 | **86 green / 0 red**(+ 라이브 2건은 `#[ignore]`, 아래 §4에서 실행) · 경고 0 |
| 필수 8조합 | **27/27 green**(변형 포함 실 시나리오 27개 = 설계 §7의 재계수와 동수) |
| 상시 회귀 | **24/26 green · 부분 1(#27) · 미구현 1(#15)** + 신설 4건(#34~#37) |
| 전이 커버리지 | **60/60**(A 38 + B 22) — `tests/frame_coverage.rs`가 기계 집계, 베이스라인 60으로 잠금 |
| 병리 커버리지 | **15/15**(P1·P1b·P1c·P1d·P1e·P2·P3·P4·P5·P6·P7·P8·P8b·P8c·P9) |
| 픽스처 | 실와이어 **9파일 312프레임**(마스킹 + PROVENANCE) · 합성 **12파일**(등급 표기) |
| 라이브 스모크 | 2턴 실행 성공 — 1턴 $0.0505 / 승인 왕복 $0.0102, **잔존 프로세스 0** |
| 코드량 | src 3,526줄 · tests 3,642줄 |

재현:

```bash
cargo test -p ccg-engine --offline                      # 86 green
cargo test -p ccg-engine --offline --test frame_coverage -- --nocapture   # 커버리지 표
node scripts/import-wire-fixtures.mjs                   # %TEMP% 실덤프 → tests/fixtures/wire
CCG_LIVE=1 cargo test -p ccg-engine --offline --test live_smoke -- --ignored --nocapture
```

---

## 1. 단계별 완료 상태 (m-logic §11)

| 단계 | 상태 | 실물 |
|---|---|---|
| 1. `identity.rs` + 골든 테스트 | ✅ | `src/identity.rs`(1,023줄) · `src/canon.rs` · `tests/identity_golden.rs`(11 테스트). 세 타입(`RawIdentity`/`RawIdentityPatch`/`RunIdentity`)을 **처음부터** 분리. 리프 15개·축 8개 동결, 해시 골든, `to_raw()` 왕복, **리프 충돌 판정**(seq vs `arm.at_seq`) |
| 2. `live.rs` + `clock.rs` | ✅ | 원장(`LiveKind` 10종 × 정착 사유 11종) · 프로브 등급(`CAN_SAY_ALIVE`/`CAN_SAY_DEAD`를 **컴파일 시점 assert**로 강제) · 워치독 루프(상태 가드·`evidence_bearing()`·플래그 리셋) · 능동 프로브 ⑥(30s 간격·3s 타임아웃·**비동기**라 tick을 막지 않음 = O18 대응) · `StreamGuard::drop` |
| 3. `state.rs` 전이표 | ✅ | **표가 데이터**다: `LIFECYCLE`(38행) · `FRAME_DIGEST`(22행) · `COMMANDS`(23×8, 빈칸 0) · `PROJECTION_8_4`(32행). 코드는 `set_state(id, …)`로만 상태를 바꾸고 **표에 없는 id면 `debug_assert`가 죽는다**. 전이 추가 = 표 1행 + 발화 1줄 |
| 4. `driver.rs` | ✅ | 상주 스폰(argv/env는 protocol §2.1 그대로) · **경계 안전 JSONL 리더**(누적 중 상한 검사 = 크리틱 §5-3 지적 반영) · 소프트 중단 · `StreamClosePolicy` 3값 · §3.4-a close 보류 · **job object는 크레이트 최초 커밋에** |
| 5. 재생 하네스 = `cargo test` | ✅ | `tests/replay.rs`(27) · `tests/replay_standing.rs`(32) · `tests/harness/`(러너·FakeCli·불변식 16종) · `tests/frame_coverage.rs`(게이트) |
| 6. 라이브 스모크 | ✅ | `tests/live_smoke.rs` — init→턴→result, 승인 왕복 1회, 프레임 덤프 보존 |
| 7. M-WF effort 실측 | ✅ | §5 — **실려 오지 않는다**(정적 근거 + 덤프 확인) |
| 8. 배선(src-tauri) | ⛔ 범위 밖 | 다음 라운드 |

---

## 2. 재생 커버리지 표 (정직판)

### 2.1 필수 8조합 — 27/27 green

| # | 시나리오 | 테스트 | 상태 | 무엇을 잠갔나 |
|---|---|---|---|---|
| 1 | 계정 변경 중 턴 시작(라이브 항목 없음) | `s01_…coldstart` | ✅ | 진행 턴은 옛 계정(`CLAUDE_CONFIG_DIR` 실검), 착지 적용, **재스폰 안내 없음**(정리할 게 0개) |
| 1b | + 라이브 셸 1개 | `s01b_…respawns` | ✅ | `Respawn{IdentityChanged['billing.account']}` · 정착 사유 · "1개" 문장 |
| 2 | 폴백 직후 계정 변경 | `s02_…` | ✅ | 리비전 3개(Default→EngineFallback→DeferredApply) · **배너 1개** · 사유 두 리프 |
| 2b | 드리프트 가시화 | `s02b_…` | ✅ | `driftedFields=['engine.model']` |
| 2c | **effort만** 변경 + 폴백 | `s02c_…` | ✅ | **N2 잠금** — 착지 model이 `opus`로 남는다 |
| 2d-i/ii | 같은 리프 충돌 | `s02d_i/ii` | ✅ | 접수 순서로 결정론(`keptByFallback` / 패치 승) |
| 3 | busy 중 채팅 전환 | `s03_…` | ✅ | 두 런타임 독립 · `switch_chat`/`new_chat` accepted (**하네스는 Rust만 때린다** — O2는 범위 밖) |
| 4 | 예약 큐 + 한도 소진 → 자동 이어서 | `s04_…` | ✅ | **총 spawn 3 · T16 주입 정확히 1회 · Linger(0) 비방출** = §3.4-a 회귀 잠금 |
| 4b | hold 중 계정 변경 | `s04b_…` | ✅ | 대기표 **즉시** 무효 · 큐 항목은 옛 계정 스냅샷 유지(keep_snapshot) |
| 4c | hold 중 interrupt | `s04c_…` | ✅ | 큐+hold 취소·되돌리기·**몇 시간 뒤 자동 전송 0건** |
| 5a | 중단 후 같은 프로세스 3턴(`keep_open`) | `s05a_…` | ✅ | 실와이어 `interrupt.jsonl` 그대로 · 재스폰 0 · session_id 불변 · 종결 status 3회 |
| 5b | 같은 중단, `on_idle` | `s05b_…` | ✅ | ColdStart + `--resume=<실측 id>` |
| 6 | bg 살아있는 중단 | `s06_…` | ✅ | 셸 2개 생존 · `Resident{LiveItems}` · **큐 0건**(L1) · 이어서 send는 T16 |
| 6b | + 모델 변경 | `s06b_…` | ✅ | T17 재스폰 · 셸 정착 사유 |
| 6c-i | 조용한 셸 + mtime | `s06c_i_…` | ✅ | ④가 답하므로 ⑥ 호출 0회 |
| 6c-ii | 출력 없는 정상 셸 | `s06c_ii_…` | ✅ | ⑥ Alive → 알약 유지(**2.6.2 파리티 복원** = N6) |
| 6c-iii | 진짜 죽음 | `s06c_iii_…` | ✅ | ⑥ Dead → ~93s 정착 + T20 회수 |
| 7 | 워크플로 중 CLI 강제 종료 | `s07_…` | ✅ | 원장 전부 `StreamClosed{ExternalKill}` · 게이팅 0 · 사이드바 안 잠김 |
| 7b | 행(hang)한 CLI | `s07b_…` | ✅ | 90s 게이팅 상실 → 30분 `watchdog:none` → `Resident{Unverified}` · **close_input 0건** |
| 7b′ | 외부에서 죽은 워크플로 | `s07b_prime_…` | ✅ | ~93s `watchdog:active` + T20 회수(**30분이 아니다**) |
| 7c | 강제 해제 | `s07c_…` | ✅ | `forced_by_user` 즉시 · 나머지는 30분 경로 유지 |
| 7d | 6h 유휴 회수 | `s07d_…` | ✅ | T32 → Idle · spawn==exit |
| 7e | 진짜 도는 dev 서버 | `s07e_…` | ✅ | 35분 내내 정착 0 · ⑥ 호출 0회 |
| 8 | 승인 카드 뜬 채 사망 | `s08_…` | ✅ | AskCard 정착 · 종결 status 1회 · 늦은 응답 폐기 |
| 8b | 앱 종료 | `s08b_…` | ✅ | 정착 사유 `AppQuit`(2.6.2는 조용히 stopped) |
| 8c | 중복 응답 | `s08c_…` | ✅ | 멱등 · **응답에 `toolUseID` 실림 실검** |

### 2.2 상시 회귀 — 24 green · 부분 1 · 미구현 1 (+ 신설 4)

| # | 상태 | 비고 |
|---|---|---|
| 9 순서 뒤집기 | ✅ | 두 순열 최종 원장 동일 |
| 10 / 10b 무음 보류 | ✅ | 슬라이딩 재장전 → 진짜 토큰 복구 / 소진 마감 |
| 11 통지 재주입 1회 | ✅ | **구현 버그 1건을 여기서 잡았다**(§6-C) |
| 12 addDirs 순서 | ✅ | `Noop` — 재스폰 없음 |
| 13 / 13b 전역 pref | ✅ | 물질화라 해시 불변 / 일괄 적용 3판정 |
| 14 Resident interrupt | ✅ | #32로 흡수 |
| **15 첨부 파일 수명** | ❌ **미구현** | `QueuedMessage.attachments`는 타입에만 있고 드레인 시 존재 확인·`rejected{attachment_missing}` 경로가 없다(O11). 재생 불가가 아니라 **안 만든 것** |
| 16 delete_chat 확인 | ✅ | `NeedsConfirm` + 비용 재료 |
| 17 통지 중복 | ✅ | 멱등 |
| 18 init 재도착 | ✅ | 실와이어 3턴 |
| 19 / 19b 폴백 순열 | ✅ | 3경로 · 거절이면 리비전 0 |
| 20 중단·되돌리기 | ✅ | 복원이 전송을 유발하지 않음 |
| 21 프로세스 생존 | ✅ | 불변식 11 전용 |
| 22 도구 정책 토글 | ✅ | `skillOverrides` 1건(나머지 3축 — `deniedMcp`·키 지문·`dropEnvKey` — 은 **골든 테스트**가 잠근다) |
| 23 Unverified에서 send | ✅ | confidence가 send를 막지 않음 |
| 24 늦은 control_response | ✅ | 조용히 버림 |
| 25 spawn 20s 타임아웃 | ✅ | **큐를 안 비운다**(L1과 구별) |
| 26 카드 회수(T6) | ✅ | **실와이어 `park.jsonl`의 실측 `control_cancel_request`** |
| **27 T15 + 부팅 재장전** | ⚠️ **부분** | T15(6s 하드 강등) ✅ / **부팅 hold·큐 재장전은 미구현** — 영속 계층(`chats-v3`·`status.json`)이 이 크레이트 밖(ccg-store·M-UX §5.8)이라 여기서 재생할 대상이 없다 |
| 28 /btw 포크(T18) | ✅ | 사유가 `thread_changed` · argv에 `--fork-session` |
| 29 / 29b compact | ✅ | 다음 usage와 짝맞춤 / 턴 먼저 끝나면 `after=null` |
| 30 Starting 중 interrupt | ✅ | T34 |
| 31 자동응답·통과 3종 | ✅ | F14·F18·F22 · UI 카드 0건 |
| 32a/b Resident interrupt | ✅ | 관측(`stopped:by_user`)/추정(`forced_by_user`) 두 갈래 |
| 33 프로브 예산 | ✅ | 항목 3개 → 왕복 1회 · 중복 카드 0 |
| **34** 프레임 소화 전수(신설) | ✅ | F3·F4·F5·F7·F8·F11·F16·F20·F21 |
| **35** T19 / T19b(신설) | ✅ | CLI 자발 기상·정리 턴 재개 = **새 run_id** |
| **36** Linger 정책(신설) | ✅ | T20b → T33 |
| **37** stop_all(신설) | ✅ | T23 |

### 2.3 기계 집계 출력 (그대로 붙임)

```
─ 프레임 커버리지 ............ 전이 60/60 밟음
─ 안 밟은 전이 ............... []
─ 죽인 병리 커버리지 ......... 15/15 · 빈 병리 []
─ close_policy 분포 .......... {"keep_open": 17, "linger_ms=30000": 1, "on_idle": 40}
─ 시나리오 수 ................ 58            (선언 수. 테스트 함수는 59개 — 일부 Scen을 두 테스트가 공유)
─ 합성 의존 시나리오 ......... 33 (그중 `assumed` 등급 의존 1)
```

`covers` 선언은 **거짓말을 할 수 없다**: 러너가 시나리오 종료 시 실제로 밟은 전이 집합과
대조해 선언만 하고 안 밟으면 그 자리에서 실패한다(초기 구현에서 실제로 6번 걸렸다).

### 2.4 "재생 불가"로 남은 것

| 항목 | 왜 재생으로 못 보나 |
|---|---|
| O2(렌더러 세션 리듀서 소유권) | 하네스는 Rust만 때린다. #3이 초록이어도 **앱은 깨질 수 있다** |
| 셸 5s 유예 실제 값(O7) | CLI 내부 타이밍 — 라이브 계측 필요 |
| `set_model` 싼 경로(O15) | 앱→CLI 요청이 실제로 먹는지는 라이브 1턴 필요 |
| P1e 4축이 **argv/env에 실제로 실리는지** | 재생은 "정체성이 다르면 재스폰"만 본다 → 그래서 `driver.rs` 단위 테스트로 argv/env를 따로 잠갔다(`argv_matches_protocol_2_1`) |
| `rate_limit_event{blocked}` 모양 | **아무도 본 적 없다**(O14). `assumed` 등급 픽스처 1건에 #4c가 의존 |
| 능동 프로브 ⑥의 실제 동작(O17) | `FakeCli.probe_reply`는 **우리가 정한 응답**이다 — §4의 라이브에서 닫지 못했다(아래) |

---

## 3. 불변식 (러너가 시나리오마다 자동 검사, 16종)

1 원장 빔 · 2 busy 해제 · 3 **run_id당 종결 status 1회** · 4 대기자 0 · 5 정착 사유 전원 보유 ·
6 게이팅 자격 · 7 이중 전송 없음 · 8 리비전 단조 · 9 **spawn==exit**(암묵 `app_quit` teardown 후) ·
10 미지 프레임 주입 · 11 **`process_alive`가 리스를 못 재장전** · 12 **추정 정착 직후 `close_input` 0건**
(단 `probe:active`는 대상 아님) · 13 전환당 배너 1개 · 14 큐 이벤트 정합 ·
15 **`watchdog_loop`는 `Resident` 밖에서 상태를 대입하지 않음** · 16 프로브 30s 간격.

59개 테스트 × 16 = **944 검사**가 시나리오 본문과 무관하게 매번 돈다.

---

## 4. 라이브 스모크 결과 (실 CLI · 실 계정)

`claude.exe 2.1.239`(`engines/0.3.239`) · 모델 `haiku` · `--thinking disabled` ·
`CLAUDE_CONFIG_DIR`은 기본 계정의 `.credentials.json`/`.claude.json`을 **복사한**
`%TEMP%\ccg-engine-live\config`(실홈 쓰기 0 — 아래 확인).

| # | 결과 | 수치 |
|---|---|---|
| L-1 init→턴→result | ✅ | 프레임 12개 · 1.6s · `total_cost_usd=0.050516` · `terminal_reason=completed` · result `"SMOKE"` · 상태 궤적 `T1→T2→(§3.4)→T25→T26` · spawn 1 / exit 1 |
| L-2 승인 왕복 | ✅ | 프레임 40개 · 3.2s · `can_use_tool(Write)` → 응답(`toolUseID` 동봉) → `tool_result` → result `"DONE."` · `total_cost_usd=0.0102365` · **파일 실제 생성**(`work/live-approve.txt` = `OK`) · **승인 응답 → 턴 종료 933ms** |

덤프: `%TEMP%\ccg-engine-live\live-1turn.jsonl`, `live-approve.jsonl`.

**안전 확인**

- 잔존 `claude.exe` 2개 = 둘 다 PPID **24836(사용자 실앱)**, 생성 시각이 내 런보다 앞섬 → **내 스폰 잔존 0**.
- 이름 기반 kill 0회. 죽인 것은 자기 자식뿐이고 job object가 손자까지 보증.
- 사용자 실홈 `.credentials.json` mtime 불변(08-22 19:41, 런은 08-23 01:0x).

**닫지 못한 라이브 항목**: O17(능동 프로브 ⑥ 실동작) · O7(셸 5s 유예) · O15(`set_model`).
셋 다 **백그라운드 셸/워크플로를 실제로 띄우는 턴**이 필요해 이번 스모크(2턴) 범위 밖으로 뒀다.
⑥이 실패하면 되돌릴 대상은 이미 특정돼 있다: `live.rs`의 `ActiveInitProbe` 행 + 시나리오
`s06c_ii`·`s06c_iii`·`s07b_prime`·`s33` 4건.

---

## 5. M-WF — `workflow_progress[].workflow_agent`가 effort를 싣는가 → **아니다**

### (a) 설치된 CLI 바이너리 정적 조사 (읽기 전용)

`~/.agentcodegui/engines/0.3.239/.../claude.exe`(2.1.239, 337,672,352 B)에서
`data:{type:"workflow_agent"` 를 전수 추출 → **emitter 6개**, 키 집합:

```
index · label · phaseIndex · phaseTitle · agentType · isolation · model · fallbackModel
state · blocked · error · message · agentId · cached · remoteSessionId
queuedAt · startedAt · attempt · lastAttemptReason · lastToolName · lastToolSummary
promptPreview · resultPreview · lastProgressAt
```

**6개 중 어느 것에도 `effort`가 없다.** 상위 프레임(`system/task_progress`) emitter도 마찬가지다:

```js
{type:"system",subtype:"task_progress",task_id,tool_use_id,description,subagent_type,
 usage:{total_tokens,tool_uses,duration_ms},last_tool_name,summary,workflow_progress}
```

### (b) 확보된 프레임 덤프 검사

실덤프 11개(PoC 9 + 라이브 2)에 `task_progress`/`workflow_progress` 프레임은 **0건**이다
(워크플로를 돌린 런이 없다). 덤프에서 잡히는 `"effort"` 문자열은 전부 `initialize` 응답과
`system/init`의 **슬래시 명령 목록**(`/effort`)일 뿐, 값이 실린 필드가 아니다.
→ (b)는 (a)를 반증하지 못하지만 **독립 증거도 아니다**. 판정의 무게는 (a)에 있다.

### 그래서 무엇을 할 수 있나 (대안 — 지어내지 않은 것만)

| 대안 | 근거 | 제약 |
|---|---|---|
| **모델 칩만 표시** | `model`(+ 재시도 시 `fallbackModel`)은 **항상 실려 온다** | effort는 못 보여준다. 가장 정직한 선택 |
| 훅 입력의 `effort.level` | 바이너리 문자열: *"Active effort level for the current turn (e.g. low/medium/high/xhigh/max), after any silent downgrade for the selected model. Also exposed to hook commands and Bash as the `CLAUDE_EFFORT` env var."* + `StatusLineCommandInput.effort` | **메인 스레드 턴의 값**이지 워크플로 에이전트별 값이 아니다. 훅을 걸어야 얻는다(3.0 범위 밖) |
| 에이전트 정의에서 읽기 | 워크플로 에이전트 스펙 스키마에 `effort` 키가 **있다**(`{schema, model, effort, isolation, agentType, disallowedTools, bashCommandClamp}`), 그리고 도움말이 *"Each agent type's model, reasoning effort, and tools come from its definition (`.claude/agents/*.md` frontmatter …)"* | **입력 쪽**이다. 우리가 `.claude/agents/*.md`를 직접 파싱해야 하고, 워크플로가 인라인으로 덮으면 어긋난다 |

**하지 말아야 할 것**: 세션 effort(사용자 picker 값)를 에이전트 칩에 표시하는 것.
워크플로 에이전트는 자기 정의의 effort로 돌고 **모델별 무음 강등**까지 받으므로,
세션 값을 갖다 붙이면 화면이 거짓을 말한다.

---

## 6. 구현이 잡아낸 실제 함정 (설계 문서엔 없던 것)

| # | 무엇 | 어떻게 드러났나 | 조치 |
|---|---|---|---|
| **A** | **모델 별칭 함정** — 와이어 `assistant.message.model`은 해석된 id(`claude-haiku-4-5-20251001`)이고 정체성 model은 picker 별칭(`haiku`)이다. 그대로 비교하면 **매 턴이 폴백으로 보이고 모든 재사용이 Respawn**이 된다 | 실와이어 `interrupt.jsonl` 재생(#5a)에서 T16 주입이 0회로 나옴 | `model_alias()`로 별칭 접기 + **첫 관측은 기준선**(2.6.2 `curModelDisplay` 초기화 규약과 동형) |
| **B** | **드레인 재진입** — T17 재스폰의 종료 처리(T25/T26)가 그 자리에서 **다음 큐 항목을 먼저 집어가** 순서가 뒤집히고 스폰이 하나 더 났다 | #4가 `spawn 4 / texts ["1","이어서","3","2"]`로 잡음 | `suspend_drain` 가드 |
| **C** | `<task-notification` 파서가 **속성 붙은 여는 태그**를 못 잡아 T12 재주입이 영영 발동하지 않음 | #11 | `contains("<task-notification")`로 완화 |
| **D** | 워치독 tick(5s)이 **2.5s 슬라이딩 보류를 삼킨다** — 5s 고정 스텝만으로는 T10/T12가 설계대로 발화하지 않는다 | #10b·#11 | `ChatRuntime::next_deadline()` 신설(실앱은 개별 타이머 + 5s 워치독) |
| **E** | `account_dir` — 실물 폴더는 `<slug>-<임의 접미사>`(`lmg…_gmail.com-68e935`)라 슬러그 조립만으로는 **없는 폴더**를 가리켜 CLI가 미로그인으로 뜬다 | 라이브 스모크 준비 중 | 접두 스캔 1순위 + 조립 폴백 |
| **F** | 설계 §3.4-a의 주장(#4 spawn 3)은 **참이다** — 다만 A/B를 고치기 전에는 4가 나왔다 | #4 | 그대로 잠금(`T16 주입 정확히 1회` 단언) |

---

## 7. 설계 문서와 어긋난 지점 — 내가 고른 계약 (전부 의도적)

| # | 설계 문면 | 채택한 것 | 왜 |
|---|---|---|---|
| 1 | 시나리오 = TOML 파일 | **Rust DSL** | 이 환경 오프라인 레지스트리에 `toml` 의존 트리가 없다. TOML이 주려던 셋(`close_policy` 선언·`covers`·`kills`)은 `Scen`으로 그대로 남기고 **선언 검증**까지 추가했다 |
| 2 | 해시 = canonical CBOR → blake3 | **정준 JSON → sha256[..16]** | blake3·CBOR 크레이트가 캐시에 없다. 성질(결정적·키 순서 무관·릴리즈 간 안정) 동일, 교체 지점은 `canon.rs` 하나 |
| 3 | §2.3 골든 테스트가 축 이름을 snake_case로 나열 | **camelCase** | 같은 문서 §2.5의 TS 계약면과 리프 경로(`addDirs`)가 camelCase다. 두 표기가 동시에 참일 수 없어 **렌더러가 읽는 쪽**을 골랐다 |
| 4 | `RawIdentityPatch::leaf_paths() == IdentityField::ALL`(15) | **14**(파생 리프 `billing.keyFp` 제외) | 같은 문서 §2.2가 "`key_fp`는 패치로 줄 수 없다"고 못박는다. **모순**이라 후자를 계약으로 채택하고 나머지 전부를 잠갔다 |
| 5 | #5a "중단 시점에 `queue_cleared` 1회" | **0회**(그 픽스처엔 큐가 없다) | 0건을 "3건 취소했어요"라고 말할 수 없다. 큐가 있는 경우는 #6·#4c·#20·#30이 잠근다 |
| 6 | #4c "`advance(resets_at+90s)` 뒤 `restore`" | **만료(`undo_expired`)를 잠금** | §7.4의 토큰 유효기간은 5분인데 hold는 몇 시간짜리다 — **두 규칙이 동시에 참일 수 없다**. 복원 성공 경로는 #20·#4c 전반부가 따로 잠근다 |
| 7 | `ModeId`(값 미지정) | `normal\|plan\|acceptEdits\|auto\|bypass` | M-UX 매핑 함수(`ccg-store/src/raw_identity.rs`)가 이 문자열을 파일에 쓴다. CLI 이름은 `driver.rs`가 변환(`modeToPermission` 파리티) |
| 8 | — | `RunIdentity`에 **`Deserialize` 미구현** | 디스크에서 되싣는 경로가 생기는 순간 정규화를 건너뛴 값이 들어온다. 저장은 `RawIdentity`로만(§2.4 물질화) |

---

## 8. 남은 것 (다음 라운드 후보)

**엔진 내부**

1. **`ClaudeDriver::mtime_fresh`가 항상 `false`** — 프로브 ④가 출하 경로에서 무력하다.
   (재생은 `FakeCli`가 답해서 초록이다.) `subagents/**`·`outputFile`·전사 mtime 스캔
   (`engine.ts:685-713` 이식)이 필요하다. **지금 상태로 출하하면 조용한 dev 서버는 ⑥에만 의존한다.**
2. `ControlWaiters` LRU 1024 미구현 — 현재는 "우리가 보낸 id인가"를 접두로 판정하고
   미매칭을 이벤트로만 남긴다(§5.7 규약 1·4는 구현, 2의 LRU 기록·3의 카운터는 미구현).
3. 원장에 `CmdCard`/`Thinking`/`StreamingMsg` 미이관(O2 선행 조건). 지금 원장은
   `Workflow`·`BgShell`·`BgAgent`·`PendingSettle`·`AskCard`·`RunningTool`만 든다.
4. `#15` 첨부 파일 수명(O11) · `Codex` 축 정규화(O4) · `NeedsConfirm` 이후의 `confirmToken` 왕복.
5. 영속(부팅 hold/큐 재장전 §5.8)은 `ccg-store` 접점 — 크레이트 경계를 넘는다.

**열린 문제 갱신**

| # | 상태 |
|---|---|
| O17 능동 프로브 | **미확인** — 재생은 우리가 정한 응답 위에서 초록. 라이브 절차·되돌릴 대상 특정 완료 |
| O18 프로브가 tick을 막는가 | **닫힘(구현)** — 채팅당 1회로 합치고 비동기(전송 → 다음 tick에서 응답 소화). 불변식 16이 상시 검사 |
| O7 셸 5s 유예 | 미실측(상수만 존재) |
| O13 `close_policy` 기본값 | `OnIdle`로 구현. 실측 전 확정 안 함 |
| O14 한도 blocked 프레임 | 여전히 미관측 — 출하 경로는 **문구 분류**(2순위) |
| O16 6h | 상수로만 존재 |
| O12 마이그레이션 2단 비교 | 1차 키(`RawIdentity::raw_hash()`)·2차 키(`RunIdentity::hash()`) 둘 다 제공. 실행 주체는 M-UX |

---

## 9. 파일 목록

```
crates/ccg-engine/
  Cargo.toml
  src/  canon.rs  clock.rs  driver.rs  event.rs  frames.rs  identity.rs
        ids.rs  job.rs  lib.rs  live.rs  queue.rs  runtime.rs  state.rs
  tests/ harness/mod.rs        러너·FakeCli·불변식 16종·시나리오 레지스트리
         replay.rs             필수 8조합 27
         replay_standing.rs    상시 회귀 32
         identity_golden.rs    골든 11
         frame_coverage.rs     커버리지 게이트 3
         live_smoke.rs         라이브 2(#[ignore] + CCG_LIVE=1)
         fixtures/wire/        실와이어 9 + PROVENANCE.json
         fixtures/synth/       합성 12(파일 머리에 근거·등급)
scripts/import-wire-fixtures.mjs
docs/m3-report-r1.md            ← 이 문서
```
