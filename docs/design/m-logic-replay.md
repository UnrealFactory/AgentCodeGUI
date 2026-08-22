# M-LOGIC 회귀 하네스 — 상태기계 재생 테스트

> 본문: `docs/design/m-logic.md`. 이 문서는 그 §9(D10)의 상세다.
>
> **원칙**: 상태기계는 **라이브 CLI 없이** 검증한다. 프레임은 실와이어 박제 + 스펙 기반 합성,
> 시계는 가상, 프로세스는 없다 → **$0 · 결정적 · CI 가능 · 수 ms**.
> 라이브가 꼭 필요한 3가지(§6)만 `#[ignore]` 표시로 따로 둔다.

---

## 1. 왜 재생인가

`docs/protocol-claude-cli.md` §9-②가 못박은 위험: *"레벨과 에지의 순서는 미정의"* 인데
2.6.2의 상주 회계는 순서 휴리스틱 덩어리다(`frameSeq/turnStartSeq/wfNotifySeq` 3중 비교,
슬라이딩 무음 정착, hold-idle 10/30분). Rust로 옮기면 **파싱 속도·채널 지연·스레드 스케줄링이
달라 같은 코드를 옮겨도 같은 순서가 안 나온다.**

라이브 테스트로는 이 순서를 **의도적으로 뒤집을 수 없다**. 재생 하네스는 뒤집을 수 있다.
그게 이 하네스의 존재 이유다. (부수 효과로 시나리오당 비용 $0.)

크리틱이 남긴 구멍도 여기서 메운다 — `docs/critic/m3-poc.md` §3 범위 한정:
*"백그라운드 셸/에이전트가 살아 있는 상태의 interrupt는 한 번도 시험되지 않았다."*

---

## 2. 배치

```
crates/ccg-engine/
  src/
    identity.rs         # RunIdentity (m-logic.md §2)
    state.rs            # StreamState 전이표 (§3.3)
    live.rs             # LiveLedger · StreamGuard · 워치독 (§5)
    queue.rs            # 큐 · LimitHold (§7)
    clock.rs            # trait Clock { now(), sleep_until() } — 실시계/가상시계
    driver.rs           # trait CliDriver { send(Frame), recv() -> Frame, kill() }
  tests/
    replay.rs           # 시나리오 러너 (#[test] × N)
    fixtures/
      wire/             # ★ 실와이어 박제 (scripts/import-wire-fixtures.mjs가 채운다)
        smoke.jsonl  approve.jsonl  approve-noid.jsonl  ask.jsonl
        park.jsonl   interrupt.jsonl  resume-1.jsonl  resume-2.jsonl  resume-3-fork.jsonl
      synth/            # 스펙(§5 사전) 기반 손합성 — 실계정 없이 만들 수 있는 것들
        bg-shell.jsonl  workflow.jsonl  task-notification.jsonl
        rate-limit-blocked.jsonl  refusal-fallback.jsonl  compact.jsonl
      scenarios/
        01-account-change-midturn.toml … 13-*.toml
scripts/
  import-wire-fixtures.mjs   # %TEMP%\ccg-poc-rs\*.jsonl → tests/fixtures/wire/ (마스킹 포함)
```

### 2.1 실와이어 박제 규칙 (`import-wire-fixtures.mjs`)

`scripts/poc-rs`가 남긴 `%TEMP%\ccg-poc-rs\*.jsonl`은 **덮어써지는 스크래치**다. 레포에
박제하되 개인정보/환경을 지운다:

| 대상 | 처리 |
|---|---|
| `session_id`, `uuid` | 결정적 가짜 UUID로 치환(같은 값 → 같은 대체값, 맵 유지) |
| 절대경로(`C:\Users\<user>\…`) | `C:\ccg-fixture\…`로 치환 |
| 계정 이메일 | `fixture@example.com` |
| `slash_commands`/`commands` 배열(초대형 init 응답) | 3개만 남기고 절삭 — 프레이밍 테스트가 아니면 불필요 |
| `total_cost_usd`/`duration_ms` | 그대로(회계 테스트가 쓴다) |
| 그 외 | **바이트 그대로** — 스키마를 "정리"하지 말 것. CLI가 실제로 보낸 모양이 자산이다 |

임포터는 원본 SHA-256을 `fixtures/wire/PROVENANCE.json`에 기록한다(어느 런에서 왔는지,
CLI 버전, 계정 종류, 채취 일시). 크리틱이 출처를 되짚을 수 있어야 한다.

### 2.2 합성 프레임은 스펙에서 만든다

실와이어에 없는 것(워크플로·백그라운드 셸·정착 통지·한도 차단·거부 폴백·compact)은
`docs/protocol-claude-cli.md` §5.8·§5.11~§5.15의 **문서화된 모양 그대로** 손으로 쓴다.
합성 파일 머리에 근거 줄을 남긴다:

```jsonc
// synth/workflow.jsonl — 근거: docs/protocol-claude-cli.md §5.13 (claude.exe @312434010 emitter)
// ★ 합성이다. 라이브 관측이 생기면 wire/로 승격하고 이 파일을 지운다.
{"type":"system","subtype":"task_progress","task_id":"wf-1","description":"Critic",
 "usage":{"total_tokens":1200,"tool_uses":3,"duration_ms":4000},
 "workflow_progress":[
   {"type":"workflow_phase","index":0,"title":"분석"},
   {"type":"workflow_agent","index":0,"label":"Critic","phaseIndex":0,"phaseTitle":"분석",
    "model":"claude-opus-5","state":"running","promptPreview":"…"}],
 "session_id":"S1","uuid":"U-wf-1"}
```

> **합성 프레임은 "가정"이다.** 시나리오가 초록이어도 그건 *우리 가정 위에서* 초록이다.
> `PROVENANCE.json`이 wire/synth를 구분하고, 리포트는 항상 이 구분을 표시한다.

---

## 3. 러너

### 3.1 시나리오 파일 (TOML)

```toml
# tests/fixtures/scenarios/07-workflow-cli-killed.toml
name = "워크플로 도는 중 CLI 강제 종료 (P8 유령 재현)"
kills  = ["P8", "P8b", "P9"]        # m-logic.md §1의 병리 번호 — 리포트가 이걸 집계한다
identity = { engine = { engine = "claude", model = "fable", effort = "medium" },
             billing = { kind = "subscription", account = "fixture@example.com" },
             cwd = "C:\\ccg-fixture\\work", mode = "default" }

[[step]]                            # 사용자 명령
at_ms = 0
cmd   = { send = { text = "워크플로 돌려줘" } }

[[step]]                            # 실와이어 재생 (초반 핸드셰이크 + 턴 시작)
at_ms = 10
frames = { file = "wire/smoke.jsonl", range = "0..3" }   # control_response(init), system/init, status

[[step]]                            # 합성: 워크플로 시작 + 백그라운드 목록 REPLACE
at_ms = 500
frames = { file = "synth/workflow.jsonl", range = "0..1" }
[[step]]
at_ms = 520
frames = { inline = '''
{"type":"system","subtype":"background_tasks_changed","tasks":[
  {"task_id":"wf-1","task_type":"local_workflow","description":"Critic"},
  {"task_id":"wf-2","task_type":"local_workflow","description":"Build"}],
 "session_id":"S1","uuid":"U1"}
''' }

[[step]]                            # 턴 종료 — 워크플로가 살아 있으니 Resident로 착지
at_ms = 900
frames = { file = "wire/smoke.jsonl", range = "last_result" }

[[assert]]
at_ms = 950
state = "resident"
live  = [ { id = "wf-1", kind = "workflow", liveness = "observed" },
          { id = "wf-2", kind = "workflow", liveness = "observed" } ]
busy  = false

[[step]]                            # ★ 폴트: CLI가 외부에서 강제 종료됨 (프레임 없이 stdout EOF)
at_ms = 1000
fault = { kill_process = { cause = "external_kill" } }

[[assert]]
at_ms = 1010
state = "idle"                                    # Terminating → Ended → Idle
live  = []                                        # ★ 원장이 비었다
settled = [ { id = "wf-1", reason = "stream_closed:external_kill" },
            { id = "wf-2", reason = "stream_closed:external_kill" } ]
busy  = false
gating_blocks = []                                # ★ 어떤 조작도 막히지 않는다

[[assert]]                                        # 유령이 UI를 잠그지 않는지 직접 확인
at_ms = 1011
verdict_of = { cmd = "switch_chat" } 
expect     = "accepted"
[[assert]]
at_ms = 1012
verdict_of = { cmd = "new_chat" }
expect     = "accepted"

[[assert]]                                        # 종결 status 정확히 1회
at_ms = 1020
emitted_exactly_once = ["status:done|status:error"]
```

### 3.2 러너 골격

```rust
pub struct Replay {
    clock: VirtualClock,          // 스텝의 at_ms로 결정적으로 전진
    engine: ChatRuntime<FakeCli>,
    events: Vec<Event>,           // 방출 이벤트 전체 기록 (코얼레싱 전 원본)
}

impl Replay {
    fn run(scenario: &Scenario) -> Report {
        for step in &scenario.steps {
            self.clock.advance_to(step.at_ms);      // 만료 타이머가 여기서 정확히 발화
            match &step.kind {
                Kind::Cmd(c)    => self.engine.dispatch(c),      // verdict 기록
                Kind::Frames(f) => for fr in f.load() { self.engine.on_frame(fr) },
                Kind::Fault(x)  => self.engine.inject_fault(x),
                Kind::Assert(a) => self.check(a),
            }
        }
        self.final_invariants();   // ★ 모든 시나리오 공통 (§3.4)
        self.report()
    }
}
```

### 3.3 폴트 목록

| 폴트 | 뜻 | 재현하는 실제 사건 |
|---|---|---|
| `kill_process{cause}` | stdout EOF + exit code, 프레임 없음 | 작업관리자 종료·크래시·CLI 급사 |
| `freeze{ms}` | 프로세스는 살아 있는데 프레임이 전혀 안 옴 | 행(hang)·워크플로 외부 사망 (**P8 본체**) |
| `stream_close` | stdin/stdout 정상 EOF | 정상 종료 경로 |
| `app_quit` | 앱 종료 훅 | T24 |
| `reorder{window}` | 다음 N프레임을 뒤섞어 배달 | **위험 #2 — 레벨/에지 순서 미정의** |
| `drop_frame{match}` | 특정 프레임을 삼킴 | 북엔드 유실(REPLACE만 진실인지 확인) |
| `delay{ms, match}` | 특정 프레임만 늦게 배달 | 정착 통지가 재기동 턴보다 늦게 오는 실측 사고 |
| `duplicate{match}` | 같은 프레임 두 번 | 멱등성 확인 |

### 3.4 모든 시나리오 공통 불변식 (러너가 자동 검사 — 시나리오가 안 적어도 돈다)

1. **원장 비었음**: 시나리오 끝에 `live == []`.
2. **busy 해제**: 최종 `busy == false`.
3. **종결 status 1회**: 각 `run_id`마다 `status:done|error`가 **정확히 한 번**.
4. **대기자 0**: 미해제 `AskCard`/`control_request` 없음.
5. **정착 사유 전원 보유**: 정착한 항목 중 `reason` 없는 것 0개.
6. **게이팅 자격**: `liveness != observed`인 항목이 `gating_blocks`에 등장하지 않음.
7. **이중 전송 없음**: 같은 큐 항목 id가 두 번 `send`되지 않음.
8. **정체성 단조성**: 리비전 번호가 증가만 하고, 각 리비전에 `origin`이 있음.
9. **프로세스 누수 없음**(FakeCli 회계): spawn 수 == exit 수.
10. **모르는 프레임에 죽지 않음**: 러너가 시나리오마다 무작위 위치에 미지 `type` 프레임을
    1개 주입한다(§5.16 규약 — "조용히 버린다").

> 불변식 1·2·3이 바로 **P8(유령)·busy 잠김·스피너 굳음**의 자동 감시다. 시나리오를
> 무엇으로 짜든 이 셋은 항상 검사된다.

---

## 4. 필수 8조합

각 항목: **재현하는 병리 → 스텝 뼈대 → 이게 없으면 놓치는 것**.

### #1 계정 변경 중 턴 시작 (P4)

```
send("작업")                    → Starting → Streaming
identity_set{ billing.account = b@x }   @턴 중
   ⇒ verdict = deferred{ at: turn_end }
result                          → 턴종료 판정에서 pending 적용
assert: 이 턴의 스폰 env = a@x (옛 계정),
        chat:identity 브로드캐스트 2회 (deferred 통지 + deferred_apply),
        다음 send의 재사용 판정 = Respawn{ IdentityChanged[billing] }
```
없으면 놓치는 것: 진행 중 턴이 새 계정으로 조용히 갈아타거나(토큰 되싱크 사고),
판정이 UI에 안 보여 사용자가 "바꿨는데 안 바뀌었네"를 겪는 경로.

### #2 폴백 직후 계정 변경 (P3+P4)

```
send → Streaming
frames: synth/refusal-fallback.jsonl   (system/model_refusal_fallback fable→opus)
   ⇒ 리비전 #1 origin=EngineFallback, 배너 이벤트 1회, revertTo 존재
identity_set{ billing.account = b@x }  @턴 중  ⇒ deferred
result → 적용 ⇒ 리비전 #2 origin=DeferredApply
send → 재사용 판정 = Respawn{ IdentityChanged[engine, billing] }
assert: 사유 문구에 "모델 자동 전환"과 "계정 변경"이 **둘 다** 들어감
        identity_revert(1) 가능하고, revert가 리비전 #3을 만든다(히스토리 삭제 아님)
```
없으면 놓치는 것: 폴백과 사용자 변경이 겹쳤을 때 어느 쪽이 이겼는지 모르는 상태
(2.6.2에서 `setPicker`와 `restore`가 서로 덮어쓰던 자리).

### #3 busy 중 채팅 전환 (P7)

```
chat A: send → Streaming
switch_chat(B)  ⇒ verdict = accepted           ★ 2.6.2는 침묵 no-op
chat B: send    ⇒ accepted (독립 스트림)
frames: A의 result / B의 result 를 **인터리브**로 배달
assert: A·B의 run-state가 서로 오염되지 않음, 각자 busy가 정확히 풀림,
        A로 돌아왔을 때 A의 스레드·큐·정체성 그대로
```
없으면 놓치는 것: 리듀서 하나를 갈아타던 구조에서 이벤트가 엉뚱한 채팅에 붙는 사고.

### #4 예약 큐 + 한도 소진 → 자동 이어서 (P5+P6)

```
send("1")                      → Streaming
enqueue("2"), enqueue("3")     ⇒ queued (정체성 스냅샷 동봉)
identity_set{ model = opus }   ⇒ deferred  ★ 큐 항목은 여전히 fable 스냅샷
frames: rate-limit-blocked (result is_error + 한도 문구) ⇒ hold 장전, 상태 Idle
clock.advance(resets_at + 90s) ⇒ 재검증 → ready
   ⇒ 큐 head에 origin=limit_resume 항목 삽입
drain ⇒ 재개 항목 → "2"(fable 스냅샷) → "3"(fable 스냅샷)
assert: hold 중 드레인 0건, 순서 = [resume, 2, 3], 이중 전송 없음,
        "2"의 스폰 정체성 = fable(예약 시점) ≠ opus(현재),
        UI 이벤트에 드리프트 배지 플래그가 실려 있음
변형 4b: hold 중 identity_set{ account = b@x } ⇒ hold 무효화 + 사유 통지
```
없으면 놓치는 것: 2.6.2에서 훅과 드레인 effect가 같은 전이에 경합하던 자리(ref로 때운 곳).

### #5 중단 직후 재개 (소프트 중단)

```
frames: wire/interrupt.jsonl 를 **그대로** 재생
  (실측: control_response{still_queued:[]} → user"[Request interrupted by user]"
   → result/error_during_execution terminal_reason=aborted_streaming
   → 같은 프로세스에서 2·3턴 정상, session_id 불변)
assert: 상태 Interrupting → (result) → Terminating{AllClear} 또는 Resident,
        프로세스 생존, 2턴이 **재스폰 없이** 같은 스트림에서,
        interrupt_requested=true 라서 T12(통지 재주입)가 발동하지 않음,
        total_cost_usd는 **프로세스 누적** → 델타 가산 (m3-poc.md §3 실측)
```

### #6 백그라운드 살아있는 상태의 중단 (**PoC 미검증 구간 · 위험 #2**)

```
send → Streaming
frames: synth/bg-shell.jsonl (background_tasks_changed: local_bash 2개)
interrupt  ⇒ T13: 카드 해제 → control_request{interrupt}
frames: result(aborted_streaming)
assert: 셸 2개가 **정착하지 않는다**(중단은 턴만 죽인다), 상태 = Resident,
        원장 = 셸 2개 observed, 리스가 장전돼 있다(★ 2.6.2는 타이머를 안 걸었다),
        이어서 send ⇒ 정체성 동일 → T16 주입(재스폰 아님) ⇒ 셸 생존
변형 6b: 중단 후 identity_set{model} → send ⇒ T17 재스폰,
        셸 2개 정착 사유 = IdentityChanged[engine], 안내 문구 1회
```
없으면 놓치는 것: **2026-08-03 릴리즈 사고(중단 1회 → 매 턴 CLI 사망 루프)의 연료 그 자체.**
크리틱이 "한 번도 시험되지 않았다"고 지적한 정확히 그 조합.

### #7 워크플로 도는 중 CLI 강제 종료 (**P8 유령 재현**)

§3.1의 전문 참조. 추가 변형:

```
7b: fault=freeze{35분}  (프로세스는 살아 있는데 프레임 없음 — 워크플로 외부 사망)
    assert: 90s 리스 만료 → 증거 프로브(REPLACE 멤버십·전사 mtime) 실패
            → liveness=unverified (★ 여기서 이미 게이팅 자격 상실)
            → hard_limit(30분) → settle(Watchdog) → 알약 소멸 → 상태 Terminating
            도중 어느 시점에도 switch_chat/new_chat이 거부되지 않음
7c: 7b 도중 force_settle(wf-1) ⇒ 즉시 정착 ForcedByUser, 표시 "강제로 정리함"
```
**이 세 변형이 사용자 스크린샷 버그의 전부다** — 재시작 없이 빠져나오는 경로가 셋 생긴다.

### #8 승인 카드 뜬 채 CLI 사망 (P8 + 대기자 누수)

```
frames: wire/approve.jsonl 를 can_use_tool 직전까지 재생
   ⇒ AwaitingUser, 원장에 AskCard{request_id, tool_use_id}
fault = kill_process{cause: crash}
assert: AskCard 정착 StreamClosed{crash} → 카드 닫힘 이벤트,
        종결 status 정확히 1회, 대기자 0, busy 해제,
        ★ 이후 도착하는 (지연된) control_response 는 **버려진다**(unmatched LRU)
변형 8b: 사망 대신 app_quit  ⇒ 정착 사유 AppQuit,
        재부팅 시 저장본 복원에서 "앱이 종료돼 정리됨" 배지가 붙는다
        (2.6.2 snapshotForPersist는 사유 없이 조용히 stopped로 내렸다)
```

---

## 5. 상시 회귀 시나리오 (8조합 외 — 같은 러너)

| # | 시나리오 | 지키는 규약 |
|---|---|---|
| 9 | **정착↔통지 순서 뒤집기** — `fault=reorder`로 `background_tasks_changed`(레벨)와 `task_notification`(에지)의 순서를 6가지 순열로 | 위험 #2. **레벨이 진실, 에지는 장식** — 어느 순열에서도 최종 원장이 동일해야 |
| 10 | 무음 result 슬라이딩 보류 → 13초 뒤 진짜 첫 토큰 | `HeldResult` 재장전 8회(~22s). 고정 타임아웃이면 '응답 없음' 오탐 |
| 11 | 통지 삼킴 재주입 **1회 제한** — 재주입 턴이 또 무음이면 두 번째 재주입 금지 | T12 `replayed_once` 불변식(무한 루프 방지) |
| 12 | `addDirs` 순서만 다른 재전송 | **재스폰 없음**(§2.3 `BTreeSet`) — 2.6.2는 `JSON.stringify` 비교라 재스폰했다 |
| 13 | 전역 `outputStyle` 변경 후 다른 채팅에서 send | 상주가 끊기지 않음(§2.4 물질화) |
| 14 | `Resident`에서 `interrupt` | verdict = `no_turn` + "백그라운드 전체 중지" 제안 (침묵 아님) |
| 15 | 큐 항목의 첨부 파일이 사라진 채 드레인 | `rejected{attachment_missing}` 정착, 뒤 항목은 계속 (O11) |
| 16 | `delete_chat`을 라이브 항목 있는 채팅에 | ⚠️ confirm + 비용 문장, 확인 후 `Cancelled` 정착 |
| 17 | 같은 `task_notification` 중복 배달 | 멱등 — 정착 이벤트 1회 |
| 18 | `system/init`이 턴마다 재도착, `session_id` 불변 | **"init 도착 = 새 세션" 판정 금지**(m3-poc.md §3 실측) |

---

## 6. 라이브로만 닫을 수 있는 것 (`#[ignore]` — 수동/게이트에서만)

재생으로 검증 **불가능**한 3가지. 각각 비용과 절차를 적어 둔다.

| # | 항목 | 왜 재생 불가 | 절차 | 비용 |
|---|---|---|---|---|
| L1 | 백그라운드 셸 **턴종료 5s 유예**의 실제 값 (O7) | CLI 내부 타이밍 | 셸 백그라운드화 → 턴 종료 → REPLACE 이탈까지 ms 계측 | 1턴(haiku) ≈ $0.005 |
| L2 | 계정 격리 실효성 — 계정 2개 번갈아 1턴씩, 각 턴 `init`의 `account.email` 일치 | 자격증명 계층은 프로세스 밖 | `ARCHITECTURE-3.0.md` M3 위험 #3 곁가지 | 2턴 ≈ $0.01 |
| L3 | job object 좀비 차단 4행 대조 | 커널 동작 | `scripts/poc-rs/job-test.sh` 재사용(이미 CONFIRMED) | 2턴 ≈ $0.01 |

**주의**: L1~L3은 M-LOGIC의 게이트가 **아니다**(상태기계 정합성과 무관). M3 빌더의 몫이며,
여기 적는 이유는 "재생으로 덮은 척하지 않기 위해서"다.

---

## 7. 리포트 형식 (크리틱이 읽는 것)

```
m-logic replay: 21/21 green   (wire fixtures 9, synth 6)
─ 필수 8조합 ................ 8/8
─ 상시 회귀 .................. 10/10
─ 공통 불변식 ................ 10/10 × 18 시나리오 = 180/180
─ 죽인 병리 커버리지 ......... P1 ✓ P1b ✓ P1c ✓ P1d ✓ P2 ✓ P3 ✓ P4 ✓ P5 ✓ P6 ✓
                              P7 ✓ P8 ✓ P8b ✓ P8c ✓ P9 ✓        (m-logic.md §8 대응)
─ 합성 의존 시나리오 ......... #4 #6 #7 #9 (라이브 관측 생기면 wire로 승격)
```

`kills = [...]` 필드를 시나리오마다 적게 한 이유가 이 줄이다 — **§8 대응표의 모든 병리에
최소 1개 시나리오**가 붙어 있는지 러너가 집계한다. 붙지 않은 병리가 있으면 **빌드 실패**.
