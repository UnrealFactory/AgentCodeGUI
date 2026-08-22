# M3 × M-LOGIC 빌드 보고 — R1 (엔진 코어 + 재생 하네스)

**범위**: `crates/ccg-engine/`(신설) · `crates/ccg-engine/tests/`(재생 하네스) ·
`scripts/import-wire-fixtures.mjs`(신설) · 이 문서.
**안 건드린 것**: `src-tauri/`(배선은 다음 라운드) · `src/shared/protocol.ts`(M2 소유) ·
`app/` · `docs/design/`(읽기만) · `scripts/poc-rs/`(그대로 둠 — 새로 짰다).

**계약 문서**: `docs/design/m-logic.md` R3 · `docs/design/m-logic-replay.md` R3 ·
`docs/protocol-claude-cli.md` · `docs/critic/m3-poc.md`.

---

## 0. 한 장 요약

> **R2 갱신**(2026-08-23) — 크리틱 R1(`docs/critic/m3-r1.md`)의 C1~C8을 전부 반영했다.
> 수치·주장이 R1에서 바뀐 자리는 각 절에 ★R2로 표시하고, 수정 요지와 뮤테이션 증거는 **§8**에 모았다.

| 항목 | 수치 |
|---|---|
| 테스트 | **97 green / 0 red**(+ 라이브 2건은 `#[ignore]`, 아래 §4에서 실행) · 경고 0 — ★R2(R1 86) |
| 필수 8조합 | **27/27 green**(변형 포함 실 시나리오 27개 = 설계 §7의 재계수와 동수) |
| 상시 회귀 | **24/26 green · 부분 1(#27) · 미구현 1(#15)** + 신설 8건(#34~#37 · ★R2 #38~#41) |
| 전이 커버리지 | **60/60**(A 38 + B 22) — ★R2 **실행 실적**으로 집계(`tests/zz_coverage_gate.rs`). R1은 `covers` **선언**을 셌고 `#[test]` 한 줄만 지우면 만점이 나왔다(크리틱 §2.2) |
| 병리 커버리지 | **15/15**(P1·P1b·P1c·P1d·P1e·P2·P3·P4·P5·P6·P7·P8·P8b·P8c·P9) |
| 픽스처 | 실와이어 **9파일 312프레임**(마스킹 + PROVENANCE) · 합성 **12파일**(등급 표기) |
| 합성 픽스처 의존 | ★R2 **29 시나리오 / `assumed` 등급 1건**(실측). R1의 "33 / 1"은 선언 집계였고 귀속이 8건 틀렸다(§8 C4) |
| 라이브 스모크 | 2턴 실행 성공 — **콜드 캐시 1회값** 1턴 $0.0505 / 승인 왕복 $0.0102(웜 캐시 재현치는 $0.0026 / $0.0056 — ★R2 §4), **잔존 프로세스 0** |
| 코드량 | ★R2 실측(`wc -l`) **src 5,965줄 · tests 4,383줄**. R1의 "src 3,526"은 틀린 수치였다(당시 실측 5,941). tests는 3,642 → 4,383 |

재현:

```bash
cargo test -p ccg-engine --offline                      # 97 green (게이트 포함)
cargo test -p ccg-engine --offline --test zz_coverage_gate -- --nocapture  # 실행 실적 커버리지 표
cargo test -p ccg-engine --offline --test frame_coverage -- --nocapture    # 구조 게이트(사영표 32행)
node scripts/import-wire-fixtures.mjs                   # %TEMP% 실덤프 → tests/fixtures/wire
CCG_LIVE=1 cargo test -p ccg-engine --offline --test live_smoke -- --ignored --nocapture
```

> 게이트는 **시나리오 바이너리 뒤에** 돌아야 실적을 본다(cargo는 테스트 타깃을 이름 순으로
> 실행한다 — 그래서 파일 이름이 `zz_`다). 순서가 어긋나도 거짓 초록은 안 난다: 실적에 시나리오·
> 하네스 소스 지문이 박혀 있어 소스가 바뀌면 지난 런의 실적이 전부 무효가 되고, 정적 층(L2)은
> 실행 순서와 무관하다(§8 C1).

---

## 1. 단계별 완료 상태 (m-logic §11)

| 단계 | 상태 | 실물 |
|---|---|---|
| 1. `identity.rs` + 골든 테스트 | ✅ | `src/identity.rs`(1,023줄) · `src/canon.rs` · `tests/identity_golden.rs`(11 테스트). 세 타입(`RawIdentity`/`RawIdentityPatch`/`RunIdentity`)을 **처음부터** 분리. 리프 15개·축 8개 동결, 해시 골든, `to_raw()` 왕복, **리프 충돌 판정**(seq vs `arm.at_seq`) |
| 2. `live.rs` + `clock.rs` | ✅ | 원장(`LiveKind` 10종 × 정착 사유 11종) · 프로브 등급(`CAN_SAY_ALIVE`/`CAN_SAY_DEAD`를 **컴파일 시점 assert**로 강제) · 워치독 루프(상태 가드·`evidence_bearing()`·플래그 리셋) · 능동 프로브 ⑥(30s 간격·3s 타임아웃·**비동기**라 tick을 막지 않음 = O18 대응) · `StreamGuard::drop` |
| 3. `state.rs` 전이표 | ✅ | **표가 데이터**다: `LIFECYCLE`(38행) · `FRAME_DIGEST`(22행) · `COMMANDS`(23×8, 빈칸 0) · `PROJECTION_8_4`(32행). 코드는 `set_state(id, …)`로만 상태를 바꾸고 **표에 없는 id면 `debug_assert`가 죽는다**. 전이 추가 = 표 1행 + 발화 1줄 |
| 4. `driver.rs` | ✅ | 상주 스폰(argv/env는 protocol §2.1 그대로) · **경계 안전 JSONL 리더**(누적 중 상한 검사 = 크리틱 §5-3 지적 반영) · 소프트 중단 · `StreamClosePolicy` 3값 · §3.4-a close 보류 · **job object는 크레이트 최초 커밋에** |
| 5. 재생 하네스 = `cargo test` | ✅ | `tests/replay.rs`(27) · `tests/replay_standing.rs`(**36** ★R2) · `tests/harness/`(러너·FakeCli·불변식 16종 + **실적 기록**) · `tests/frame_coverage.rs`(구조 게이트 5) · **`tests/zz_coverage_gate.rs`(실행 실적 게이트 5 ★R2)** |
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
| 4c | hold 중 interrupt | `s04c_…` | ✅ | 큐+hold 취소·되돌리기·**`hold.cancel`이 큐를 깨우지 않는다**(정확값: 취소 직후 전송 `["1"]`·큐 2건 유지, 60분 뒤에도 전송 1건) — ★R2로 **코드를 고쳤다**(R1은 여기서 큐 head가 자동 전송됐고 `<=3` 단언이 그걸 덮었다 — §8 C3) |
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
| **38** ★R2 중단 뒤 고아 통지 기상 턴 | ✅ | T12 가드의 **"중단 요청 없음"** — 중단 뒤 재주입 0회, 사용자가 손수 보내면 다시 1회(§8 C6) |
| **39** ★R2 init 기준선 | ✅ | 첫 assistant의 **무음 강등**이 배너 1개로 보인다(함정 A ② 잠금) |
| **40** ★R2 같은 모델 다른 표기 | ✅ | 배너 0 · **spawn 1**(재스폰 폭주 금지 — 함정 A ① 잠금) |
| **41** ★R2 모델 없는 init | ✅ | 첫 관측이 기준선 — `observe_model`의 `None` 가지를 처음으로 **밟는** 테스트(함정 A ③) |

### 2.3 기계 집계 출력 (그대로 붙임) — ★R2 **실행 실적** 집계

```
$ cargo test -p ccg-engine --offline --test zz_coverage_gate -- --nocapture
─ 전이 커버리지(실행) ........ 60/60 밟음
─ 안 밟은 전이 ............... []
─ 죽인 병리 커버리지 ......... 15/15 · 빈 병리 []
─ 합성 픽스처 의존(실측) ..... 29 (그중 `assumed` 등급 1)
─ 실행된 시나리오 ............ 62

$ cargo test -p ccg-engine --offline --test frame_coverage -- --nocapture
─ 사영표 ..................... 32행
─ close_policy 분포 .......... {"keep_open": 20, "linger_ms=30000": 1, "on_idle": 41}
─ 등록된 시나리오 ............ 62
```

세 층이 서로를 검산한다:

1. **선언 → 실적**(러너, R1부터 있던 것): 시나리오 종료 시 선언한 `covers`를 실제로 밟았는지
   대조한다 — 선언만 하고 안 밟으면 그 자리에서 실패(초기 구현에서 6번 걸렸다).
   ★R2로 `synth[]`에도 같은 대조를 붙였다(**8건이 틀려 있었다** — §8 C4).
2. **실적 → 게이트**(★R2 신설): 커버리지 수치의 입력이 **런타임 실적 파일**이다. 등록만 하고
   아무도 실행하지 않는 시나리오는 게이트가 이름으로 지목한다.
3. **정적 층 L2**(★R2 신설): 레지스트리의 모든 `Scen`이 **`#[test]` 안에서** 참조되는지 소스로
   확인한다. 실행 순서와 무관하게 같은 반증을 한 번 더 잡는다.

### 2.4 "재생 불가"로 남은 것

| 항목 | 왜 재생으로 못 보나 |
|---|---|
| O2(렌더러 세션 리듀서 소유권) | 하네스는 Rust만 때린다. #3이 초록이어도 **앱은 깨질 수 있다** |
| 셸 5s 유예 실제 값(O7) | CLI 내부 타이밍 — 라이브 계측 필요 |
| `set_model` 싼 경로(O15) | 앱→CLI 요청이 실제로 먹는지는 라이브 1턴 필요 |
| P1e 4축이 **argv/env에 실제로 실리는지** | 재생은 "정체성이 다르면 재스폰"만 본다 → 그래서 `driver.rs` 단위 테스트로 argv/env를 따로 잠갔다(`argv_matches_protocol_2_1`) |
| `rate_limit_event{blocked}` 모양 | **아무도 본 적 없다**(O14). `assumed` 등급 픽스처 1건에 **#4c가 의존**(★R2 — R1 표는 이 줄을 맞게 적었지만 `Scen` 선언은 #4에 달아 뒀다. 이제 로더가 대조한다) |
| 능동 프로브 ⑥의 실제 동작(O17) | `FakeCli.probe_reply`는 **우리가 정한 응답**이다 — §4의 라이브에서 닫지 못했다(아래) |

---

## 3. 불변식 (러너가 시나리오마다 자동 검사, 16종)

1 원장 빔 · 2 busy 해제 · 3 **run_id당 종결 status 1회** · 4 대기자 0 · 5 정착 사유 전원 보유 ·
6 게이팅 자격 · 7 이중 전송 없음 · 8 리비전 단조 · 9 **spawn==exit**(암묵 `app_quit` teardown 후) ·
10 미지 프레임 주입 · 11 **`process_alive`가 리스를 못 재장전** · 12 **추정 정착 직후 `close_input` 0건**
(단 `probe:active`는 대상 아님) · 13 전환당 배너 1개 · 14 큐 이벤트 정합 ·
15 **`watchdog_loop`는 `Resident` 밖에서 상태를 대입하지 않음** · 16 프로브 30s 간격.

★R2: 63개 시나리오 테스트 × 16 = **1,008 검사**가 시나리오 본문과 무관하게 매번 돌고,
종료 시 **실적 기록 + `synth[]` 대조**가 추가로 붙는다(§8 C1·C4).

---

## 4. 라이브 스모크 결과 (실 CLI · 실 계정)

`claude.exe 2.1.239`(`engines/0.3.239`) · 모델 `haiku` · `--thinking disabled` ·
`CLAUDE_CONFIG_DIR`은 기본 계정의 `.credentials.json`/`.claude.json`을 **복사한**
`%TEMP%\ccg-engine-live\config`(실홈 쓰기 0 — 아래 확인).

| # | 결과 | 수치 |
|---|---|---|
| L-1 init→턴→result | ✅ | 프레임 12개 · 1.6s · `total_cost_usd=0.050516`(**콜드 캐시 1회값** ★R2) · `terminal_reason=completed` · result `"SMOKE"` · 상태 궤적 `T1→T2→(§3.4)→T25→T26` · spawn 1 / exit 1 |
| L-2 승인 왕복 | ✅ | 프레임 40개 · 3.2s · `can_use_tool(Write)` → 응답(`toolUseID` 동봉) → `tool_result` → result `"DONE."` · `total_cost_usd=0.0102365`(**콜드 캐시 1회값** ★R2) · **파일 실제 생성**(`work/live-approve.txt` = `OK`) · **승인 응답 → 턴 종료 933ms** |

**★R2 — 비용 수치는 재현되지 않는다(크리틱 C7)**. 위 두 값은 **프롬프트 캐시가 비어 있는 첫
런의 1회 관측치**다. 크리틱이 같은 절차를 웜 캐시에서 재현하자 **$0.0025524 / $0.0055879**
(각각 20배 · 2배 차이)가 나왔다. 프레임 수·상태 궤적·승인 왕복 지연(933ms vs 834ms)은 재현됐다.
**비용은 헤드라인 수치로 쓰지 말 것** — 조건을 같이 적지 않으면 거짓말이 된다.

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
| **A** | **모델 별칭 함정** — 와이어 `assistant.message.model`은 해석된 id(`claude-haiku-4-5-20251001`)이고 정체성 model은 picker 별칭(`haiku`)이다. 그대로 비교하면 **매 턴이 폴백으로 보이고 모든 재사용이 Respawn**이 된다 | 실와이어 `interrupt.jsonl` 재생(#5a)에서 T16 주입이 0회로 나옴 | `model_alias()`로 별칭 접기 + **첫 관측은 기준선**. ★R2 정정: 실제 방어선은 **`system/init`이 기준선을 잡는 자리**(`Frame::SystemInit` 가지)이고, `#5a`는 init·assistant의 문자열이 같아서 **별칭 접기를 안 밟는다**(크리틱 §6-A). 이 함정을 실제로 잠그는 것은 ★R2 신설 #39·#40·#41이다(§8.2) |
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
| **9** ★R2 | §3.3 **T10** 가드 = `재장전<8 ∧ (프레임 흘렀음 ∨ delivered_notifs 있음)` | **`재장전<8`만** | 설계 문면을 그대로 넣으면 **아무 프레임도 안 온 무음 보류가 첫 2.5s에 무너진다**(곧바로 T11). 무음 보류의 존재 이유가 사라진다. 코드 표 주석에 어긋남을 적었다 |
| **10** ★R2 | §3.3 **T32** From = `Resident{Unverified\|Policy}` | From = `Resident` **전 변형** | `StateTag`가 `why`를 안 들고 다녀 표현할 수 없다. 실질 무해 — 6h 전에 T21이 `Unverified`로 내린다. 코드 표 주석에 적었다 |
| ~~11~~ | §3.3 **T12** 가드의 넷째 항 `중단 요청 없음` | ~~누락~~ → **설계대로 복원** | R1은 표에도 코드에도 없었다(**의도가 아니라 누락**). ★R2에서 표 문자열 + 런타임 가드 + 재생 #38로 채웠다 — §8 C6 |

> 9·10·11은 크리틱 R1 §3.3이 *"§7 목록에 없는 어긋남 3건"*으로 새로 찾아낸 것이다.
> 9·10은 판단이 옳았으므로 **어긋남으로 등재**하고, 11은 옳지 않았으므로 **고쳤다**.

---

## 8. R2 — 크리틱 R1 수정 (C1~C8)

크리틱 `docs/critic/m3-r1.md` §9의 결함 8건을 전부 고쳤다. **통과 판정은 크리틱의 방법으로**
했다 — 크리틱이 반증에 쓴 조작(§2.2의 `#[test]` 제거, §6의 3중 뮤테이션)을 그대로 재현해
**이제 붉어지는지**를 봤고, 그 조작들을 테스트로도 박아 뒀다.

### 8.0 한 줄 요약

| # | 결함(크리틱) | 조치 | 증거 |
|---|---|---|---|
| **C1** | 커버리지 게이트가 **선언**을 센다 | 게이트 입력을 **런타임 실적**으로 교체 + 정적 L2 층 + 반증 재현 테스트 2개 | 실제 `#[test]` 제거 런에서 게이트 5개 전부 RED(§8.1) |
| **C2** | 함정 A(모델 별칭)를 **아무 테스트도 안 잠근다** | 재생 #39·#40·#41 신설 | 뮤테이션 ①②③ **전부 사망**(§8.2) |
| **C3** | `#4c`의 SUT·이름·주석·보고서 불일치 + `<=3` 은폐 | **코드를 고쳤다**(`hold.cancel`은 드레인 안 깨움) + 정확값 단언 | 되돌리기 뮤테이션에 `s04c` 사망(§8.3) |
| **C4** | `synth[]` 무검증 · `S4`↔`S4C` 귀속 반전 | 로더가 실제 로드를 기록 → `finish()`가 **정확히** 대조 | 8건이 틀려 있었다(§8.4) |
| **C5** | `#7b′` 하한 없음 | `>= 90*SEC` 추가 | 리스 90→30s 뮤테이션에서 **상한만 있으면 살아남는다**는 대조군까지 실행(§8.5) |
| **C6** | T12 가드에 "중단 요청 없음" 누락 | 표 문자열 + 런타임 가드(`interrupt_marker`) + 재생 #38 | 가드 제거 뮤테이션에 `s38` 사망(§8.6) |
| **C7** | 라이브 비용이 콜드 캐시 1회값 | §0·§4에 조건 명기 + 크리틱 재현치 병기 | §4 |
| **C8** | 사영표·베이스라인 주석 stale, T10 어긋남 미기재 | 주석 정정 + §7 #9·#10 등재 | `state.rs`·`frame_coverage.rs` |

### 8.1 C1 — 게이트가 실행을 센다

R1 구조의 결함은 크리틱이 정확히 짚었다: `frame_coverage.rs`는 시나리오를 **실행하는 바이너리와
분리돼 있어** 런타임 실적을 원리적으로 볼 수 없었고, 그래서 `declared()`(정적 레지스트리)를
셌다. `#[test]` 한 줄을 지우면 그 전이를 밟는 테스트가 0개가 돼도 60/60이 나왔다.

바뀐 배관:

1. `Sim::finish()`가 **실적**을 남긴다 — `$CARGO_TARGET_TMPDIR/ccg-cov/<바이너리>/<이름해시>.json`
   에 `{name, fired[], kills[], synth[], src_fp, bin}`. 같은 `Scen`을 두 테스트가 공유하면 합집합.
2. 각 테스트 바이너리는 시작할 때 **자기 칸만 비운다**(`Once`) → 그 바이너리의 실적은 언제나
   "가장 최근 런에 실제로 돈 것"과 같다.
3. 실적에는 **시나리오·하네스 소스 지문**(`SRC_FP` = `harness/mod.rs` + `replay.rs` +
   `replay_standing.rs`의 컴파일 시점 FNV)이 박힌다. 소스가 바뀌면 지난 런의 실적은 자동 무효 —
   "지난번엔 밟았으니까"로 초록이 되는 구멍이 닫힌다.
4. 새 게이트 `tests/zz_coverage_gate.rs`(이름이 `zz_`인 이유 = cargo가 타깃을 이름 순으로 돌린다):
   - `every_registered_scen_actually_ran` — 등록됐는데 **실행 실적이 없는** 시나리오를 이름으로 지목
   - `transition_coverage_is_counted_from_runtime_evidence` — 60/60을 **실적 합집합**으로 계산
   - `every_registered_scen_has_a_test_fn` — **정적 L2**: 모든 `Scen`이 `#[test]` 안에서 참조되는가
   - `r1_refutation_is_now_caught_l1_runtime` / `…_l2_static` — **크리틱의 반증을 테스트로 재현**
     (전자는 S25 실적을 뺀 입력으로 판정 함수를 때리고 *"#25만 T3를 민다"*까지 확인, 후자는
     `replay_standing.rs` 소스에서 `s25_spawn_timeout`의 `#[test]`를 **텍스트로 제거**해 L2가
     잡는지 확인 + 원본은 깨끗하다는 대조군)
5. `frame_coverage.rs`는 **구조 게이트**로 남았다(사영표 닫힘 · 선언이 실재 전이/병리를 부르는가 ·
   선언한 합성 파일이 실존하는가). 스케일 다운이 아니라 **역할 분리**다.

**크리틱의 반증을 그대로 실행한 결과**(`s25_spawn_timeout`의 `#[test]` 한 줄만 제거, `S25`는 유지):

```
replay_standing: 31 passed          ← 시나리오가 하나 줄었다
zz_coverage_gate: 0 passed · 5 FAILED
  every_registered_scen_actually_ran
    레지스트리에만 있고 **실행되지 않은** 시나리오: ["#25 initialize 20s 무응답 → T3"]
  transition_coverage_is_counted_from_runtime_evidence
    ─ 전이 커버리지(실행) ........ 59/60 밟음
    ─ 안 밟은 전이 ............... ["T3"]
  every_registered_scen_has_a_test_fn        (정적 L2)
```

R1에서는 같은 조작이 **60/60 · 전체 초록**이었다. 조작은 즉시 원복했고
`git status --porcelain crates/ccg-engine`으로 확인했다.

> **정직하게 남는 전제**: L1은 게이트가 시나리오 바이너리 **뒤에** 도는 것을 전제한다(실측으로
> 그렇다 — 위 재현 로그의 실행 순서). 순서가 뒤집혀도 거짓 초록은 안 난다(소스 지문 + L2).
> 그리고 `kills[]`는 여전히 **런타임 대조 대상이 아니다** — 병리는 설계 주장이지 실행 흔적이
> 아니다. 대신 없는 병리 번호를 부르는 것만 구조 게이트가 막는다(`declared_kills_…`).

### 8.2 C2 — 함정 A(모델 별칭) 뮤테이션 잠금

크리틱이 옳았다. 보고서 §6-A가 방어선으로 지목한 `model_alias()`·"첫 관측은 기준선"을 무력화해도
86개 테스트가 전부 초록이었다. 실제 방어선은 `system/init`이 기준선을 잡는 자리인데, 그걸 지워도
죽는 테스트가 없었고 `observe_model`의 `None` 가지는 **전 테스트에서 사문**이었다.

신설 3건(전부 `replay_standing.rs`):

- **#39** `s39_init_model_is_the_baseline_for_the_first_observation` — 실와이어 `interrupt` 핸드셰이크
  (init `model=claude-haiku-4-5-20251001`)로 뜬 세션의 **첫 assistant가 sonnet**으로 온다 = 무음 강등.
  배너가 정확히 `("haiku","sonnet")` 하나, 리비전 2개, 정체성도 별칭 공간.
- **#40** `s40_same_model_other_spelling_is_not_a_fallback` — 같은 세션에서 assistant가 같은 모델을
  **다른 표기**(`claude-haiku-4-5`)로 부른다. 배너 0 · 정체성 `haiku` 유지 · **spawn 1** ·
  T16 주입 1회. 별칭 접기가 무너지면 정체성이 바뀌어 매 턴 재스폰이 된다.
- **#41** `s41_first_observation_is_the_baseline_when_init_has_no_model` — `model` 없는 `init`
  (파서가 허용하는 갈래 · **실와이어 관측 아님**, 등급 `parser_branch`)에서 첫 관측이 기준선이 되고
  picker 별칭과 표기가 달라도 폴백이 아니다. `None` 가지를 **처음으로 밟는** 테스트다.

뮤테이션 결과(전부 원복 확인):

| 뮤테이션 | R1에서 죽은 테스트 | **R2에서 죽은 테스트** |
|---|---|---|
| ① `model_alias` → 항등함수 | `s19`만 | `s19` · **`s39`** · **`s40`** (+ 게이트) |
| ② `system/init` 기준선 제거 | **없음(86 초록)** | **`s39`** (+ 게이트) |
| ③ `observe_model`의 `None` 가지에 `panic!` | **한 번도 안 터짐** | **`s41`** (+ 게이트) |

("+ 게이트"는 실패한 시나리오가 `finish()`에 도달하지 못해 실적이 안 남고, 그래서
`every_registered_scen_actually_ran`이 함께 붉어지는 연쇄다 — 의도한 동작이다.)

### 8.3 C3 — `hold.cancel`은 드레인을 깨우지 않는다 (코드 수정)

크리틱이 잰 값이 맞다: R1은 `되돌리기 → 자동 이어서 끄기`에서 큐 head가 **그 자리에서 전송**됐고
(`texts == ["1","2"]`), `assert!(sent_after <= 3)`이 그 2건을 통과시켰다. 60분 뒤 추가 전송이 0인
진짜 이유도 hold 의미론이 아니라 **바로 앞 `StopAll`이 큐를 비웠기 때문**이었다.

**설계로 판정했다 — 코드가 틀렸다.**

- §7.2 드레인 게이트: `hold.is_some() && !hold.ready` → 대기표는 **큐 게이트**다.
- §7.3 소진: 드레인을 여는 hold 경로는 **`ready`(자동 이어서 발화)** 하나뿐이고, 그때는 재개
  항목을 head에 넣고 일반 드레인이 돈다. `hold.cancel`은 그 반대쪽(포기)이다.
- §7.4: 같은 이유로 `queue.restore`가 드레인을 안 돈다 — *"되돌리기가 곧 전송이면 위험하다"*.
- §7.3: interrupt/stop_all이 대기표를 함께 끄는 이유가 *"안 그러면 중지했는데 몇 시간 뒤 혼자
  이어서 보낸다"*이다. 그 직후의 `hold.cancel` 클릭이 전송을 유발하면 **같은 병을 문 하나 옆에서**
  다시 만든다(L1의 최악 형태).

수정: `Cmd::HoldCancel`은 `hold = None` + 큐 계획 브로드캐스트만 한다(`drain_if_possible()` 호출
제거). `#4c`는 은폐 단언을 걷고 **정확값**으로 박았다 — 취소 직후 `sent_user_texts() == ["1"]` ∧
`queue_len == 2`, 그 뒤 `StopAll` + 60분에도 전송 1건. Scen 이름·주석·보고서 §2.1이 이제 SUT와 같다.

**뮤테이션**: `HoldCancel`에 `drain_if_possible()`을 되돌리면 → `s04c_interrupt_during_hold_cancels_auto_resume`
**사망**. R1 단언(`<=3`)이었다면 초록이었을 자리다.

### 8.4 C4 — `synth[]` 귀속 교정 + 로더 대조

`synth()` 로더가 실제 로드를 스레드 로컬에 기록하고, `Sim::finish()`가 선언과 **양방향으로**
대조한다(선언만 함 / 안 적고 읽음 둘 다 실패). 러너가 자동 주입하는 `unknown-frame`은 로더를
우회한다(시나리오 선언 대상이 아니다).

대조를 켠 첫 런에서 **8건**이 틀려 있었다 — 크리틱이 찾은 2건 + 6건:

| Scen | R1 선언 | 실제 |
|---|---|---|
| `S4` #4 | `rate-limit-blocked(assumed)` | **안 읽는다**(문구 분류 경로) → `[]` |
| `S4C` #4c | `[]` | **읽는다** → `rate-limit-blocked(assumed)` |
| `S1B` #1b | `bg-shell` | 인라인 `f_bg` → `[]` |
| `S2` #2 | `bg-shell` · `refusal-fallback` · `model-delta` | `refusal-fallback`만 |
| `S9` #9 | `bg-shell` · `task-notification` | 인라인 헬퍼 → `[]` |
| `S17` #17 | `task-notification` | 인라인 헬퍼 → `[]` |
| `S33` #33 | `bg-shell` | 인라인 헬퍼 → `[]` |
| `S34` #34 | `workflow` | 인라인 헬퍼 → `[]` |

그래서 헤드라인이 **33 → 29**로 내려갔다(그중 `assumed` 1건은 그대로, 다만 이제 **#4c에 붙어
있다**). `synth[]`의 의미도 문서화했다: **합성 픽스처 파일 의존**이고, 인라인 `f_*` 헬퍼는
스펙 §5의 모양을 코드로 적은 것이라 파일 등급 표기가 없는 별도 범주다.

### 8.5 C5 — `#7b′` 하한

`*at >= 90 * SEC && *at <= 95 * SEC`로 형제(`s06c_iii`)와 대칭을 맞췄다.

**대조군까지 실행했다**(크리틱 주장의 정밀 확인): `LEASE_WORKFLOW`를 90s→30s로 줄이는 조기 정착
회귀를 넣고,

- R1 단언(상한만) → `s07b_prime` **살아남음**(죽는 건 무관한 `s07b` 하나뿐)
- R2 단언(양쪽) → `s07b_prime` **사망**

### 8.6 C6 — T12 가드의 "중단 요청 없음"

설계 §3.3 T12는 가드 넷째 항으로 **중단 요청 없음**을 요구하고, T14의 note는 그 표식을
*"재주입 금지 표식"*이라 부른다. R1은 코드 표에도 런타임에도 없었고 `Turn.interrupt_requested`는
**쓰기만 하고 아무도 읽지 않는 필드**였다.

수정:

- 표식을 **턴이 아니라 스트림**에 둔다(`Stream.interrupt_marker`). 중단은 턴을 끝내지만(T14)
  그 뒤 **CLI가 고아 통지로 스스로 깨는 턴**(T19)이 남고, 그 턴이 무음이면 T12가
  *"이어서 진행해 주세요"*를 자동으로 밀어 넣는다 — 사용자가 방금 세운 것을 기계가 다시 켜는
  자리다(메모리의 실버그 *"중단 1회 → 고아 통지 → 턴마다 CLI 사망 루프"*와 인접).
- T13 · T23 · T35에서 세우고, **사용자가 손수 시작한 턴**(T16)에서 내린다. T19/T19b(CLI 기상 턴)는
  내리지 않는다.
- `state.rs`의 T12 행 문자열을 설계 문면 그대로 복원("활동 없음"은 HeldResult 진입 조건 T8이
  이미 보장한다는 사실을 note에 적었다).
- 재생 **#38**이 사용자 동선 전체를 재생한다: 중단 → `result(aborted)` → 고아 통지 기상 턴 →
  무음 → **재주입 0회**(stdin에 실린 것은 `["작업"]`뿐) → 사용자가 손수 보내면 **다시 1회**
  (`["작업","이어서","이어서 진행해 주세요(통지 재주입)"]`). 가드가 T12 자체를 죽이지 않았다는
  두 번째 단언이 있어야 #11(통지 삼킴)이 조용히 되살아나지 않는다.

**뮤테이션**: 가드에서 `&& !interrupted`를 빼면 → `s38` **사망**.

### 8.7 검증 로그 (요약)

```
cargo test -p ccg-engine --offline
  lib 13 · frame_coverage 5 · identity_golden 11 · replay 27 · replay_standing 36
  · zz_coverage_gate 5  = 97 green · 0 red · 경고 0   (live_smoke 2 = #[ignore])

node docs/critic/tools/critic-m3-wfkeys.mjs        ← 크리틱 도구, 그대로 실행
  type:"workflow_agent" 사이트 = 6 · 최상위 키 24
  effort 계열 = [] → hasEffort=false · fallbackModel=true · model=true
```

**안전**: 이름 기반 kill 0회 · 프로세스 스폰 0(재생은 `FakeCli`) · 사용자 실홈 읽기 0 ·
뮤테이션은 전부 원복 후 `git status --porcelain crates/ccg-engine` 확인.

---

## 9. 남은 것 (다음 라운드 후보)

**엔진 내부**

1. **`ClaudeDriver::mtime_fresh`가 항상 `false`** — 프로브 ④가 출하 경로에서 무력하다.
   (재생은 `FakeCli`가 답해서 초록이다.) `subagents/**`·`outputFile`·전사 mtime 스캔
   (`engine.ts:685-713` 이식)이 필요하다. **지금 상태로 출하하면 조용한 dev 서버는 ⑥에만 의존한다.**
   ★R2 — 위험도 재평가(크리틱 §8): ⑥이 실물에서 닫혔으므로 "⑥에만 의존"은 **안전한 의존**이고
   비용은 오탐 사망이 아니라 30s 왕복 1회(33~35ms)의 **지연**이다. 다만 `s07e`가 `FakeCli`에
   ④를 심어 `probe_count == 0`을 단언하는 것은 **출하 경로에 없는 성질**이다(출하에서는 1이 된다).
   ④를 구현할 때 그 단언을 함께 손봐야 한다 — R2 범위에서는 손대지 않고 여기 적어 둔다.
2. `ControlWaiters` LRU 1024 미구현 — 현재는 "우리가 보낸 id인가"를 접두로 판정하고
   미매칭을 이벤트로만 남긴다(§5.7 규약 1·4는 구현, 2의 LRU 기록·3의 카운터는 미구현).
3. 원장에 `CmdCard`/`Thinking`/`StreamingMsg` 미이관(O2 선행 조건). 지금 원장은
   `Workflow`·`BgShell`·`BgAgent`·`PendingSettle`·`AskCard`·`RunningTool`만 든다.
4. `#15` 첨부 파일 수명(O11) · `Codex` 축 정규화(O4) · `NeedsConfirm` 이후의 `confirmToken` 왕복.
5. 영속(부팅 hold/큐 재장전 §5.8)은 `ccg-store` 접점 — 크레이트 경계를 넘는다.

**열린 문제 갱신**

| # | 상태 |
|---|---|
| O17 능동 프로브 | ★R2 **닫혔다 — 크리틱이 실물로 실증**(`m3-r1.md` §5.4): bypass 모드 + 실 백그라운드 `ping`으로 양방향 확인. 프로브마다 REPLACE가 정확히 하나 따라오고(33·35ms, 3s 타임아웃의 100배 여유), 항목이 있으면 `rearm(ActiveProbe)`·없으면 **T21b** 정착. `FakeCli.probe_reply`가 실동작을 옳게 모형화한다 → §4가 "실패하면 되돌릴 대상"으로 특정해 둔 `live.rs`의 `ActiveInitProbe` 행 + `s06c_ii`·`s06c_iii`·`s07b_prime`·`s33`은 **되돌릴 필요 없다** |
| O18 프로브가 tick을 막는가 | **닫힘(구현)** — 채팅당 1회로 합치고 비동기(전송 → 다음 tick에서 응답 소화). 불변식 16이 상시 검사 |
| O7 셸 5s 유예 | 미실측(상수만 존재) |
| O13 `close_policy` 기본값 | `OnIdle`로 구현. 실측 전 확정 안 함 |
| O14 한도 blocked 프레임 | 여전히 미관측 — 출하 경로는 **문구 분류**(2순위) |
| O16 6h | 상수로만 존재 |
| O12 마이그레이션 2단 비교 | 1차 키(`RawIdentity::raw_hash()`)·2차 키(`RunIdentity::hash()`) 둘 다 제공. 실행 주체는 M-UX |

---

## 10. 파일 목록

```
crates/ccg-engine/
  Cargo.toml
  src/  canon.rs  clock.rs  driver.rs  event.rs  frames.rs  identity.rs
        ids.rs  job.rs  lib.rs  live.rs  queue.rs  runtime.rs  state.rs
  tests/ harness/mod.rs        러너·FakeCli·불변식 16종·시나리오 레지스트리 62
                               + ★R2 실적 기록(cov)·synth 대조
         replay.rs             필수 8조합 27
         replay_standing.rs    상시 회귀 36 (★R2 #38~#41 신설)
         identity_golden.rs    골든 11
         frame_coverage.rs     구조 게이트 5 (사영표·선언 실재성)
         zz_coverage_gate.rs   ★R2 실행 실적 게이트 5 (L1 런타임 + L2 정적 + 반증 재현)
         live_smoke.rs         라이브 2(#[ignore] + CCG_LIVE=1)
         fixtures/wire/        실와이어 9 + PROVENANCE.json
         fixtures/synth/       합성 12(파일 머리에 근거·등급)
scripts/import-wire-fixtures.mjs
docs/m3-report-r1.md            ← 이 문서(§8 = R2 수정)
```
