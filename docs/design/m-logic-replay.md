# M-LOGIC 회귀 하네스 — 상태기계 재생 테스트 · **R3**

> 본문: `docs/design/m-logic.md`. 이 문서는 그 §9(D10)의 상세다.
>
> **개정 R3 (2026-08-22)** — `docs/critic/design-r2.md` §5(재생 재검)·§6(N3·N11·N6·N1) 반영.
> 크리틱의 재검 판정은 **8/8이 아니라 7/8**이었다 — **#4가 SUT와 어긋났다**(본문 §3.4가 착지에서
> 무조건 `close_input()`이라 §7.2 배칭이 불가능 → 실제 spawn은 3이 아니라 4).
> 본문에 §3.4-a(「드레인 가능하면 close 보류」)를 넣어 **#4를 성립**시켰고, 그 위에서 8조합을
> **처음부터 다시 종이 재생**했다(§8). 그 밖에:
> ① 프로브 표 개정(② 제거 · **⑥ 능동 `initialize`** 추가)으로 **6c·7b의 트레이스가 바뀐다** —
>    7b는 **7b(행한 CLI)** 와 **7b′(외부 사망 워크플로)** 로 갈린다,
> ② **#2에 2c·2d 신설**(effort-only 패치 + 폴백 = N2 잠금 · 리프 충돌 판정),
> ③ **상시 시나리오 9건 신설**(#25~#33) — 커버리지 게이트의 빈칸(T3·T6·T15·T18·T28·T34·
>    F14·F18·F22 + 신규 T21b·T35)을 **게이트를 좁히지 않고** 메웠다(N11),
> ④ 폴트 2종 신설(`control_alive` · `probe_reply`), 공통 불변식 **15·16** 신설.
>
> **개정 R2 (2026-08-22)** — `docs/critic/design-r1.md` §5(8조합 종이 재생) 반영.
> R1은 8조합 중 **온전 3 · 부분 2 · 불가 3**이었다. 불가 3건의 원인이 전부
> *하네스가 아니라 SUT(설계 본문)* 쪽에 있었다:
> #1·#2는 착지가 `ColdStart`라 단언이 나올 수 없었고, #5는 **픽스처가 채집된 조건**
> (PoC 하네스가 stdin을 안 닫음)이 SUT에 표현돼 있지 않았다.
> R2는 본문에 `StreamClosePolicy`(m-logic §3.4-b)·패치형 `pending`(§4.2-b)·
> 폴백 합류 규약(§6.2)·프레임 최신성 워치독(§5.4)을 넣어 **8/8을 온전 재생 가능**으로 만들었고,
> 개정 후 종이 재생(trace)을 **§8**에 전수 수록했다.
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
    state.rs            # StreamState 전이표 A+B (§3.3 · §3.3-B)
    live.rs             # LiveLedger · StreamGuard · 워치독 프로브 등급 (§5.4)
    control.rs          # ★R2 ControlWaiters — pending + unmatched LRU (§5.7)
    queue.rs            # 큐 · QueueUndo · LimitHold (§7)
    clock.rs            # trait Clock { now(), sleep_until() } — 실시계/가상시계
    driver.rs           # trait CliDriver { send(Frame), recv() -> Frame, kill(), alive() }
                        #   ★R2 alive()는 ProbeVerdict::Dead만 낼 수 있다(§5.4-b ⓪)
  tests/
    replay.rs           # 시나리오 러너 (#[test] × N)
    frame_coverage.rs   # ★R3 §3.7 사영표(24행) ↔ 전이 60개 ↔ 시나리오 covers[] 집계
    fixtures/
      wire/             # ★ 실와이어 박제 (scripts/import-wire-fixtures.mjs가 채운다)
        smoke.jsonl  approve.jsonl  approve-noid.jsonl  ask.jsonl
        park.jsonl   interrupt.jsonl  resume-1.jsonl  resume-2.jsonl  resume-3-fork.jsonl
      synth/            # 스펙(§5 사전) 기반 손합성 — 실계정 없이 만들 수 있는 것들
        bg-shell.jsonl  workflow.jsonl  task-notification.jsonl  task-started.jsonl
        rate-limit-allowed.jsonl  rate-limit-blocked.jsonl        # ★R2 allowed=실측 / blocked=가정
        refusal-fallback.jsonl  refusal-dialog.jsonl  compact.jsonl
        model-delta.jsonl  informational.jsonl  unknown-frame.jsonl
      scenarios/
        01-account-change-midturn.toml … 33-*.toml   # ★R3 변형 포함 **49개** (§7에서 다시 셈)
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

**★R2 — 합성 파일 신뢰도 3등급**을 `PROVENANCE.json`에 적는다. "합성"이 다 같은 게 아니다:

| 등급 | 뜻 | 해당 파일 |
|---|---|---|
| `spec_documented` | SDK 타입/바이너리 emitter로 **모양이 문서화**됨 | `bg-shell` · `task-started` · `task-notification` · `refusal-fallback` · `compact` · `informational` |
| `binary_observed` | `sdk.d.ts`엔 없지만 CLI 바이너리 emitter를 뜯어 확인 | `workflow`(`claude.exe @312434010` — `workflow_progress`) |
| **`assumed`** | **모양을 아무도 본 적 없다** | **`rate-limit-blocked`** (m-logic O14 — 실측된 건 `status:"allowed"`뿐) |

`assumed` 등급에 의존하는 시나리오는 리포트에서 **별도 줄로 세고**, 실사용에서 실물이 잡히면
`wire/`로 승격하며 그 파일을 지운다. 3등급을 안 나누면 "#4가 초록이니 한도 처리는 끝났다"는
가장 위험한 착각이 남는다.

---

## 3. 러너

### 3.1 시나리오 파일 (TOML)

```toml
# tests/fixtures/scenarios/07-workflow-cli-killed.toml
name = "워크플로 도는 중 CLI 강제 종료 (P8 유령 재현)"
kills  = ["P8", "P8b", "P9"]        # m-logic.md §1의 병리 번호 — 리포트가 이걸 집계한다
close_policy = "on_idle"            # ★R2 필수 선언 — m-logic §3.4-b. 생략 시 on_idle
covers = ["T22", "T25", "T26", "F13", "F15"]   # ★R2 — frame_coverage.rs가 집계하는 전이 id

# ★R3 — `identity`는 **완전 지정 `RawIdentity`**다(m-logic §2.2). 축을 빠뜨리면 파싱 실패.
#        부분 지정이 필요한 곳은 스텝의 `identity_set.patch`(= RawIdentityPatch)뿐이다.
identity = { engine  = { kind = "claude", model = "fable", effort = "medium" },
             billing = { kind = "subscription", account = "fixture@example.com",
                         drop_env_key = false },
             cwd = "C:\\ccg-fixture\\work", add_dirs = [], mode = "default",
             system_prompt = "", output_style = "",
             tools = { skill_overrides = {}, denied_mcp = [] } }

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
| `freeze{ms}` | **프로세스는 살아 있는데** 프레임이 전혀 안 옴 | 행(hang)·워크플로 외부 사망 (**P8 본체**). ★R2: `FakeCli.process_alive == true`를 **유지**한 채 프레임만 끊는다 — 그래야 프로브 ⓪이 Alive를 못 준다는 규약(불변식 11)이 실제로 시험된다. R1 하네스처럼 freeze가 프로세스도 죽이면 L2 버그가 영원히 안 잡힌다 |
| `touch{path, every_ms}` ★R2 | 전사·`outputFile` mtime을 주기적으로 갱신 | 조용하지만 **진짜 도는** dev 서버·에이전트. 7e(거짓 양성 방지)의 재료 |
| `stale_replace{ms}` ★R2 | REPLACE 프레임만 끊어 멤버십을 낡게 만든다 | 낡은 멤버십이 Alive 근거로 쓰이면 L2가 부활한다. ★R3: 프로브 ②를 없앴으므로 이 폴트는 이제 **①a의 리스 만료를 만드는 도구**다 |
| **`control_alive{responsive}`** ★R3 | `freeze` 중에도 **컨트롤 채널만은 살아 있는지**를 정한다 | **7b(행한 CLI, `responsive=false`)와 7b′(외부에서 죽은 워크플로 + 멀쩡한 CLI, `responsive=true`)를 가르는 유일한 축.** 이 폴트가 없으면 능동 프로브 ⑥의 두 결과(Dead vs 타임아웃)를 시험할 수 없다 |
| **`probe_reply{tasks:[…]}`** ★R3 | 능동 `initialize` 재전송에 CLI가 돌려줄 REPLACE 목록을 시나리오가 지정 | `[]` = Dead 판정 재료(T21b) · `[wf-1]` = Alive 재료. 응답에 `pending_permission_requests`를 얹어 **중복 렌더 방지**(m-logic §5.4-b)도 시험한다 |
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
   > ★R2 (크리틱 L11): 2.6.2는 워크플로 정리 턴 재개에서 **같은 `run_id`로 `done→working→done`을
   > 왕복**한다(`engine.ts:1259-1268`). 그 정상 동작이 이 불변식에 걸린다. 3.0은
   > **T19/T19b가 새 `run_id`를 발급**하도록 본문을 고쳐 불변식을 지킨다(m-logic §3.3·§3.5).
   > 러너는 추가로 **`run_id` 발급 지점이 T1/T16/T19/T19b 넷뿐**임을 이벤트 로그로 검사한다.
4. **대기자 0**: 미해제 `AskCard`/`control_request` 없음. `unmatched` LRU에 남은 건 **위반 아님**
   (m-logic §5.7 — 늦게 온 응답은 조용히 버리는 게 규약이다).
5. **정착 사유 전원 보유**: 정착한 항목 중 `reason` 없는 것 0개.
6. **게이팅 자격**: `liveness != observed`인 항목이 `gating_blocks`에 등장하지 않음.
7. **이중 전송 없음**: 같은 큐 항목 id가 두 번 `send`되지 않음.
8. **정체성 단조성**: 리비전 번호가 증가만 하고, 각 리비전에 `origin`이 있음.
9. **프로세스 누수 없음**(FakeCli 회계): spawn 수 == exit 수.
   > ★R2: 시나리오가 `Resident{*}`로 끝나면 프로세스는 **의도적으로** 살아 있다.
   > 러너는 마지막 단언 뒤 **암묵 `app_quit`**(T24)을 넣고 그 다음에 9번을 검사한다.
   > 이 teardown이 없으면 #5a·#6·#7b가 전부 거짓 빨간불이 된다.
10. **모르는 프레임에 죽지 않음**: 러너가 시나리오마다 무작위 위치에 미지 `type` 프레임을
    1개 주입한다(§5.16 규약 — "조용히 버린다").
11. ★R2 **워치독은 프로세스 생존으로 재장전되지 않는다**: 어떤 tick에서도
    `last_evidence`를 움직인 근거가 `process_alive`인 이벤트가 **0건**이어야 한다
    (m-logic §5.4-b 프로브 ⓪ — L2 회귀 잠금).
12. ★R2 **추정으로 빈 원장은 `close_input`을 부르지 않는다**:
    `settle(reason=Watchdog{probe:None})` 직후의 `close_input` 호출 0건(m-logic §5.4-c 규약 3).
    ★R3 단서: `Watchdog{probe:Active}`(관측된 정착)는 **이 불변식의 대상이 아니다** —
    그 뒤에 오는 빈 REPLACE가 F13 → T20으로 프로세스를 거두는 것이 **정상**이다.
    러너는 `probe` 태그로 둘을 구분한다.
13. ★R2 **폴백 리비전은 전환당 1개**: 같은 `to_model`로 향하는 리비전이 한 턴 안에 2개 이상이면 위반
    (m-logic §6.2 — 배너 핑퐁 회귀 잠금). ★R3: 한 턴에 **다른** `to_model`이 둘이면 리비전 2개가 정상이다
    (`fallback_arms` 벡터화 — 크리틱 N16).
14. ★R2 **큐 이벤트 정합**: `chat:queue` REPLACE의 마지막 상태 == 러너가 추적한 큐 모델.
    중단이 있었으면 `queue_cleared` verdict가 정확히 1회 있고 `undoToken`이 비어 있지 않다.
15. ★R3 **워치독 루프는 `Resident{*}` 밖에서 `state`를 대입하지 않는다**:
    상태 대입 이벤트마다 `source`(전이 id 또는 `watchdog_loop`)를 기록하고,
    `source == watchdog_loop`인 대입의 **직전 상태가 `Resident{*}`가 아니면 위반**
    (m-logic §5.4-c 가드 — **크리틱 N1 회귀 잠금**). R2 문면대로면 긴 턴 중 워크플로가
    30분 `hard_limit`에 정착할 때 **진행 중 `Streaming`이 `Resident{Unverified}`로 튄다**.
16. ★R3 **능동 프로브 예산**: 채팅당 `initialize` 재전송 간격이 **30s 미만인 쌍이 0건**이고,
    한 tick에서 같은 채팅에 프로브가 2회 이상 나가지 않는다(m-logic §5.4-b 사용 규칙 · O18).
    그리고 프로브 응답에 실려 온 `pending_permission_requests`가 **이미 원장에 있는
    `request_id`면 카드 이벤트가 추가로 나지 않는다**(중복 렌더 방지).

> 불변식 1·2·3이 바로 **P8(유령)·busy 잠김·스피너 굳음**의 자동 감시다. 시나리오를
> 무엇으로 짜든 이 셋은 항상 검사된다. 11·12·13은 **R2가 고친 세 구멍**, 15·16은
> **R3가 고친 두 구멍**이 다시 열리지 않게 하는 잠금장치다 —
> 설계 문서의 문장이 아니라 테스트가 지킨다.

### 3.5 시나리오가 선언해야 하는 축 (★R2)

R1은 시나리오가 `identity`와 스텝만 선언했다. 크리틱 #5가 드러낸 대로 **SUT의 종료 정책이
픽스처 채집 조건과 다르면 "그대로 재생"이 불가능**하므로, 두 축을 선언 대상으로 올린다.

| 키 | 값 | 기본 | 왜 |
|---|---|---|---|
| `close_policy` | `on_idle` \| `linger_ms = N` \| `keep_open` | `on_idle` | m-logic §3.4-b. `wire/*.jsonl`은 전부 **`keep_open` 조건에서 채집**됐다(PoC 하네스가 stdin을 안 닫음 — `m3-poc.md:39`, `:253-254`) |
| `covers` | 전이 id 배열 | `[]` | `tests/frame_coverage.rs`가 §3.7 사영표(24행)가 사영하는 **전이 60개 전부**에 시나리오가 최소 1개 붙었는지 집계. 안 붙은 전이가 있으면 **빌드 실패**. ★R3: R2 시점에 이 게이트는 **이미 빨간불**이었다(T3·T6·T15·T18·T28·T34·F14·F18·F22 미커버) — #25~#33이 채웠다 |

리포트는 시나리오마다 `close_policy`를 표시한다 — **"어느 조건에서 초록인가"가 결과의 일부**다.

---

## 4. 필수 8조합

각 항목: **재현하는 병리 → 스텝 뼈대 → 이게 없으면 놓치는 것**.

### #1 계정 변경 중 턴 시작 (P4) — **두 갈래로 쪼갬 (★R2)**

> **R1이 불가였던 이유**(크리틱 §5 #1): 이 시나리오엔 라이브 항목이 없다 → §3.4 착지가
> `close_input() → Terminating{AllClear} → Ended → Idle`로 떨어진다(2.6.2 파리티 ✓).
> 그러면 다음 `send`는 **`ColdStart`**라 단언 "재사용 판정 = `Respawn{IdentityChanged[billing]}`"이
> **나올 수 없다**. 단언이 SUT와 모순이었다.
> **R2**: `#1`은 단언을 사실에 맞추고(ColdStart), `#1b`가 셸 하나를 심어 `Respawn` 경로를 따로 덮는다.

```
#1  close_policy = on_idle,  라이브 항목 없음
send("작업")                       → T1 Starting → T2 Streaming     [스폰 env: a@x]
identity_set{ billing.account = b@x } @턴 중
   ⇒ verdict = deferred{ at: turn_end },  pending = { patch:{billing}, base_rev:0 }
result                             → T7 → §3.4 착지
   ⇒ land_pending(): normalize(현재.patched({billing})) → 리비전 1 (DeferredApply)
   ⇒ 원장 비었음 ∧ on_idle → close_input() → T25 Ended → T26 Idle
send("다음")                       → T1  [ColdStart — 재사용할 스트림이 없다]
assert: 1턴의 스폰 env.CLAUDE_CONFIG_DIR = accountRunDir(a@x)   ★ 옛 계정 유지
        chat:identity 브로드캐스트 2회 (deferred 통지 + deferred_apply)
        driftedFields = []                                     (폴백이 없었으므로)
        2턴의 재사용 판정 = ColdStart, 스폰 env = accountRunDir(b@x)
        ★ 재스폰 안내 문구 **없음** — 정리된 백그라운드가 0개인데 "정리됐어요"는 거짓말이다
```

```
#1b close_policy = on_idle,  라이브 셸 1개 심음
send("작업") → Streaming
frames: synth/bg-shell.jsonl (background_tasks_changed: local_bash 1개)   [F13 → 원장 1]
identity_set{ billing:{account: b@x} } @턴 중  ⇒ deferred (touched = ['billing.account'])
result → §3.4 착지 ⇒ 원장에 셸 1개 남음 → Resident{LiveItems}   (close_input 안 함)
                    drainable = false(큐 비었음) → 드레인 없음
send("다음")
assert: 재사용 판정 = Respawn{ IdentityChanged['billing.account'] }   ★R3 리프 경로
        effects.killsLive = [{ kind: BgShell, count: 1 }]
        effects.changed = ['billing.account']   (축 'billing'이 아니라 리프)
        셸 정착 사유 = IdentityChanged{diff:['billing.account']}   (≠ Completed)
        안내 문구 정확히 1회, 문장에 "1개"가 들어감
```
없으면 놓치는 것: 진행 중 턴이 새 계정으로 조용히 갈아타거나(토큰 되싱크 사고),
판정이 UI에 안 보여 사용자가 "바꿨는데 안 바뀌었네"를 겪는 경로.
그리고 **#1과 #1b의 분리 자체가 규약**이다 — "재스폰했어요(N개 정리)"라는 문구는
정리할 게 실제로 있을 때만 뜬다.

### #2 폴백 직후 계정 변경 (P3+P4) — **L3·L4가 닫혀야 성립 (★R2)**

> **R1이 불가였던 이유**(크리틱 §5 #2, 두 군데):
> **(a) L3** — `deferred` **전체 교체**가 폴백 model을 되돌려 착지 후 정체성이 `fable+b@x`가 된다
> → `IdentityChanged[engine, billing]`이 **나올 수 없다**(engine이 안 바뀌었으므로).
> **(b) L4** — 폴백 신호 3경로의 합류 규약이 없어 리비전이 1개인지 2개인지 **결정 불가**.
> 여기에 #1과 같은 ColdStart 문제까지 있었다.
> **R2**: (a)는 §4.2-b(패치 + 착지 재정규화), (b)는 §6.2(`fallback_armed` 합류),
> ColdStart는 셸을 심어 해결. 리비전 번호는 **0부터**(생성 시 `origin: Default`).

```
close_policy = on_idle,  라이브 셸 1개 심음
                                     [리비전 0: fable + a@x, origin=Default]
send("작업") → Streaming              [spawn_identity = fable + a@x]
frames: synth/bg-shell.jsonl          ⇒ 원장에 BgShell 1개 (F13)
frames: synth/refusal-fallback.jsonl  (system/model_refusal_fallback fable→opus)   [seq=S1]
   ⇒ §6.2 경로 B'(같은 to_model의 arm 없음) ⇒ 리비전 1: opus + a@x, origin=EngineFallback{refusal_frame}
   ⇒ fallback_arms = [{opus, RefusalFrame, at_seq:S1}],  observed_model = opus
   ⇒ 배너 이벤트 **정확히 1회**, revertTo = 0
frames: assistant{ message.model: "opus" }   (메인 경로)
   ⇒ §6.2 경로 C'(같은 to_model의 arm 있음) ⇒ **미러만 갱신, 리비전 없음**  ★ R1이면 여기서 2번째 배너
identity_set{ billing:{account: b@x} } @턴 중                                   [seq=S2 > S1]
   ⇒ deferred{ patch 리프 = ['billing.account'], touched_at{billing.account:S2},
                base_revision:1, preview: opus+b@x }
result → §3.4 착지
   ⇒ 폴백 우선 규칙: arm.touched_leaves = ['engine.model'] ∩ patch 리프 = ∅ → **충돌 없음**
   ⇒ land_pending(): normalize(현재(opus+a@x).patched({billing.account})) = **opus + b@x**
   ⇒ 리비전 2, origin=DeferredApply, driftedFields = [], keptByFallback = []
   ⇒ fallback_arms.clear()(턴 종료)
   ⇒ 원장에 셸 1개 → Resident{LiveItems}, drainable=false
send("다음")
   ⇒ 좌변 stream.spawn_identity = fable+a@x,  우변 chat.identity = opus+b@x
   ⇒ 재사용 판정 = Respawn{ IdentityChanged['engine.model','billing.account'] }   ★ 두 리프 모두
assert: 리비전 총 3개(0 Default → 1 EngineFallback → 2 DeferredApply), 번호 단조 증가
        배너 이벤트 1회 (불변식 13)
        사유 문구에 "모델 자동 전환"과 "계정 변경"이 **둘 다** 들어감
        셸 정착 사유 = IdentityChanged{diff:['engine.model','billing.account']}
        identity_revert(0) ⇒ 리비전 3 (origin=Revert{to:0}, 값 = fable+a@x) — 히스토리 삭제 아님

변형 2b (드리프트 가시화): identity_set{billing.account}을 **폴백보다 먼저** 접수  [S1 < S2(폴백)]
   ⇒ deferred{ 리프 ['billing.account'], touched_at:S1, base_revision:0, preview: fable+b@x }
   ⇒ 그 뒤 폴백 발생(리비전 1: opus+a@x, arm.at_seq=S2)
   ⇒ 충돌 판정: 리프 교집합 ∅ → 패치 그대로
   ⇒ 착지: normalize(opus+a@x .patched({billing.account})) = opus+b@x,
      driftedFields = ['engine.model']  ★ preview(fable)와 착지(opus)가 갈렸다
   assert: 브로드캐스트가 **토스트로 승격**되고 문구가 "계정만 바꿨고 모델은 자동 전환값을 유지"
   ★ R1 규칙이면 여기서 정체성이 fable+b@x로 착지 — **폴백이 조용히 취소된다**(그게 L3)

변형 2c ★R3 — **effort만 바꾼다** (크리틱 N2 전용 잠금)
   [리비전 0: fable + effort:medium + a@x]
   send("작업") → Streaming, 셸 1개 심음
   identity_set{ engine:{ effort: 'high' } } @턴 중                              [seq=S1]
      ⇒ deferred{ 리프 ['engine.effort'] 하나뿐, preview: fable+high }
      ★ 여기가 핵심 — 패치에 model이 **실려 있지 않다**
   frames: synth/refusal-fallback.jsonl (fable→opus)                            [seq=S2 > S1]
      ⇒ 리비전 1: opus + medium + a@x, arm.touched_leaves = ['engine.model']
   result → 착지
      ⇒ 충돌 판정: ['engine.model'] ∩ ['engine.effort'] = ∅ → **폴백이 그냥 산다**
      ⇒ landed = normalize(raw(opus, medium).patched({engine.effort:'high'})) = **opus + high**
      ⇒ 리비전 2, driftedFields = ['engine.model'] → 토스트 승격
   assert: 착지 정체성의 model == "opus"      ★ 이 한 줄이 N2 잠금 전체다
           effort == "high"
           driftedFields == ['engine.model'],  keptByFallback == []
   ★ R2 설계였다면: patch = {engine:{claude, model:'fable', effort:'high'}} 통짜 →
     landed = **fable + high**(폴백이 조용히 취소) 이고, preview == landed 라
     **driftedFields = [] → 토스트도 안 뜬다.** "죽였다"던 L3가 경고조차 없이 살아 있는 상태.

변형 2d ★R3 — **같은 리프 충돌**의 결정론 (§4.2-b 규약 2)
   2d-i  identity_set{ engine:{ model:'sonnet' } } [S1] → 그 뒤 폴백 opus [S2]
         ⇒ 충돌(둘 다 engine.model), S1 < S2 → **폴백이 이긴다** → landed model = opus
         ⇒ keptByFallback = ['engine.model'],
            문구 "모델은 자동 전환값(Opus 5)을 유지했어요 — [내가 고른 Sonnet으로 되돌리기]"
   2d-ii 폴백 opus [S1] → 그 뒤 identity_set{ engine:{ model:'sonnet' } } [S2]
         ⇒ 충돌, S2 > S1 → **패치가 이긴다** → landed model = sonnet
         ⇒ driftedFields = ['engine.model'], 문구 "자동 전환을 당신이 고른 값으로 덮었어요"
   assert: 두 방향의 결과가 **다르고**, 각각 이벤트 1회 · 리비전 단조 · 배너 1회
   ★ 이게 없으면 "폴백 유지"가 어느 경우에 성립하는지 문서만으로 결정되지 않는다.
```
없으면 놓치는 것: 폴백과 사용자 변경이 겹쳤을 때 어느 쪽이 이겼는지 모르는 상태
(2.6.2에서 `setPicker`와 `restore`가 서로 덮어쓰던 자리). 2b는 **R1 설계였다면 반드시 빨간불**,
2c는 **R2 설계였다면 반드시 빨간불**이 되는 케이스다 — 각각 L3·N2의 회귀 잠금 그 자체.
크리틱 R2가 "2/2b는 billing 패치만 잠근다"고 지적한 구멍이 2c·2d다.

### #3 busy 중 채팅 전환 (P7)

```
chat A: send → Streaming
switch_chat(B)  ⇒ verdict = accepted           ★ 2.6.2는 침묵 no-op
chat B: send    ⇒ accepted (독립 스트림)
frames: A의 result / B의 result 를 **인터리브**로 배달
assert: A·B의 run-state가 서로 오염되지 않음, 각자 busy가 정확히 풀림,
        A로 돌아왔을 때 A의 스레드·큐·정체성 그대로
        각 이벤트의 chatId가 정확 (★R2: ref/surface가 아니라 chatId 하나로 라우팅)
```
없으면 놓치는 것: 리듀서 하나를 갈아타던 구조에서 이벤트가 엉뚱한 채팅에 붙는 사고.

> **★R2 — 이 시나리오의 검증 범위 한계를 문서에 적는다** (크리틱 §5 #3):
> 하네스는 **Rust만** 때린다. 2.6.2에서 채팅 전환이 깨지던 진짜 원인은 렌더러 쪽
> "리듀서 **1개**를 채팅들이 갈아탄다"(O2)이고, 그건 이 하네스가 만질 수 없다.
> **하네스가 초록이어도 앱은 깨질 수 있다.** #3의 초록은 "Rust 상태기계가 두 채팅을
> 독립적으로 다룬다"까지만 보증한다. 나머지는 O2 착지(m-logic §11-2.5)와
> 렌더러 레벨 테스트의 몫이다.

### #4 예약 큐 + 한도 소진 → 자동 이어서 (P5+P6) — **N3 수정 후 재계산 (★R3)**

> **R1이 부분이었던 이유**(크리틱 R1 §5 #4): ① 재개 항목의 **정체성** 미정의
> ② 항목마다 정체성이 다를 때의 재스폰 비용을 UI가 어떻게 알리는지 미정의.
> **R2**: ①은 m-logic §7.3, ②는 §7.2로 확정.
>
> **★R3 — R2의 단언이 SUT와 어긋났다**(크리틱 R2 §5 #4): `close_policy=on_idle`인데
> R2의 §3.4는 **매 턴 종료마다** 원장 빔 → `close_input()` → `Terminating`이었다.
> 그러면 T16(주입)은 `Resident`에서만 나므로 **§7.2의 배칭이 불가능**하고, 실제 스폰은
> **4**(최초 + resume + 2 + 3)인데 단언은 "총 spawn 3"이었다. 하네스가 아니라 **본문 한 줄**이
> 없어서 깨진 것이다. m-logic **§3.4-a**(「드레인 가능하면 close 보류」)를 넣고 아래처럼 다시 셌다.
> **결과: spawn 3 / exit 3이 이제 참이다.** 스텝마다 착지 분기를 명시해 두었다 —
> 이 트레이스가 곧 그 한 줄의 검증이다.

```
close_policy = on_idle
                                  [리비전 0: fable + a@x]                        ─ spawn#1
send("1")                      → T1 Starting → T2 Streaming
enqueue("2"), enqueue("3")     ⇒ queued (각각 identity 스냅샷 = fable + a@x)
identity_set{ engine:{ model:'opus' } } @턴 중 ⇒ deferred{ 리프 ['engine.model'] }
                                  ★ 큐 항목 "2","3"은 여전히 fable 스냅샷
frames: synth/rate-limit-blocked.jsonl (result is_error + 한도 문구)
   ⇒ T30 hold 장전 { account: Subscription(a@x), resets_at }
   ⇒ §3.4 착지: land_pending() ⇒ 리비전 1 (opus + a@x, DeferredApply)
   ⇒ live 비었음.  drainable = !queue.empty ∧ (hold 없음 ∨ ready) = **false**  ← hold가 막는다
   ⇒ (true,false) 가지 → on_idle → close_input() → T25 Ended → T26 Idle   ─ exit#1
   ⇒ drain_if_possible(): hold.ready == false → **return** (드레인 0건)
      ★ 여기서 닫는 게 맞다 — 한도 해제는 몇 시간 뒤다. 337MB 상주를 붙들 이유가 없다(§3.4-a 3번)
clock.advance(resets_at + 90s) ⇒ 신선 usage 재검증 → ready = true
   ⇒ 큐 head에 origin=limit_resume 항목 삽입
      identity = chat.identity **지금 값 = opus + a@x**  (★ ①의 답)
      onDrift  = 'use_current',  thread = 'continue'
   ⇒ 드레인 계획 브로드캐스트(1회):
        [ {count:1, identityHash: H(opus+a@x), willRespawn:false, killsLive:[]},
          {count:2, identityHash: H(fable+a@x), willRespawn:true,  killsLive:[]} ]
      UI 한 줄: *"대기 3건 — 프로세스 2개로 나눠 보냅니다(1개는 지금 것을 정리하고 새로 시작)"*
      ★R3 문구 정정: R2의 "2건은 새 프로세스로"는 프로세스 수(2)와 항목 수(2)가 우연히 같아
         읽는 사람이 어느 쪽인지 알 수 없었다. `willRespawn`은 **기존 스트림을 끊는가**이고,
         Idle에서 시작하는 첫 그룹은 끊을 스트림이 없으므로 false다.
drain (상태 = Idle) ⇒ T27 → head = resume(opus) → T1                              ─ spawn#2
   … 턴 진행 … result → §3.4 착지
   ⇒ live 비었음.  drainable = true (큐 2건, hold 없음)
   ⇒ (true,true) 가지 → **close 보류** → Resident{Policy::Linger(0)} → 같은 tick에 drain
   ⇒ reuse_decision(fable ↔ spawn_identity=opus) = Respawn{IdentityChanged['engine.model']}
   ⇒ T17 → Terminating → Ended → T1                                              ─ exit#2 / spawn#3
   … "2" 턴 … result → 착지
   ⇒ live 비었음.  drainable = true (큐 1건)
   ⇒ **close 보류** → Resident{Policy::Linger(0)} → drain
   ⇒ reuse_decision(fable ↔ fable) = Reuse ⇒ **T16 주입**  ★ 배칭이 성립하는 정확히 그 자리
   … "3" 턴 … result → 착지
   ⇒ live 비었음.  drainable = **false** (큐 0)
   ⇒ on_idle → close_input() → Terminating{AllClear} → Ended → Idle             ─ exit#3
assert: hold 중 드레인 0건
        순서 = [resume, 2, 3], 이중 전송 없음(불변식 7)
        "2"의 스폰 정체성 = fable(예약 시점) ≠ opus(현재)   ← keep_snapshot 기본값
        resume 항목의 스폰 정체성 = opus(현재)              ← use_current
        UI 이벤트에 드리프트 배지 플래그 + 드레인 계획이 실려 있음
        ★ 총 spawn 수 = **3**,  exit 수 = **3** (불변식 9)
        ★ T16 주입이 **정확히 1회**("3"에 대해) — 이게 없으면 §3.4-a가 안 들어간 것이다
        ★ Resident{Policy::Linger(0)}는 **브로드캐스트되지 않는다**(run-state 이벤트에 0건)
변형 4b: hold 중 identity_set{ billing:{account: b@x} }
   ⇒ hold.account != identity.billing ⇒ hold **무효화** + 사유 통지 1회
   ⇒ 그 즉시 드레인 가능해짐(게이트 해제) — 재개 항목은 **삽입되지 않는다**
   ⇒ 상태가 Idle이므로 T27 → head "2"(fable + **a@x** 스냅샷) → T1 ColdStart, 그 뒤 "3"은 T16
   ⇒ 총 spawn 2
   ★R3 추가 단언: 큐 항목의 `billing.account`가 **옛 계정(a@x)** 이라 드리프트 배지가 뜬다.
     `keep_snapshot`이 기본값이므로 **자동으로 안 바꾼다**(약속을 지킨다). 대신 계획 브로드캐스트에
     `[전부 현재 계정으로]` 원클릭 힌트를 싣는다 — 안 그러면 방금 한도가 찬 계정으로 다시 나간다.
변형 4c: hold 중 interrupt   ★R2 신규
   ⇒ §7.4: 큐 비움 + hold 해제 + queue_cleared{count:2, holdCancelled:true, undoToken}
   ⇒ clock.advance(resets_at + 90s) 해도 **아무것도 전송되지 않는다**
   ⇒ queue.restore(token) ⇒ 큐 2건 + hold 복원, 자동 전송은 안 됨
   ★ R1 설계였다면: 중지 후 몇 시간 뒤 혼자 이어서 보낸다(L1의 최악 형태)
```
없으면 놓치는 것: 2.6.2에서 훅과 드레인 effect가 같은 전이에 경합하던 자리(ref로 때운 곳).
4c는 L1이 한도 대기와 겹칠 때의 최악 시나리오라 **별도 잠금**이 필요하다.
그리고 **#4 전체가 §3.4-a의 회귀 잠금**이다 — 그 줄이 사라지면 spawn 수가 4가 되어 즉시 빨간불.

### #5 중단 직후 재개 (소프트 중단) — **픽스처와 SUT 화해 (★R2)**

> **R1이 불가였던 이유**(크리틱 §5 #5): `wire/interrupt.jsonl`은 같은 프로세스로 2·3턴이 이어진다
> — **PoC 하네스가 stdin을 안 닫았기 때문**이다(`m3-poc.md:39`, `:253-254`).
> 그런데 R1의 SUT는 aborted result 시점에 라이브 항목이 0이라 §3.4가 무조건 `close_input()`을 부른다
> → `Terminating`. **"그대로 재생"이 불가능**했다. 단언 "프로세스 생존 + 재스폰 없이 2턴"은
> 라이브 항목이 있을 때만 참인데 픽스처엔 라이브 항목이 없다.
>
> **R2**: 종료 정책을 SUT의 명시 축으로 올렸다(m-logic §3.4-b). 픽스처가 채집된 조건 =
> `keep_open`. 출하 기본값 = `on_idle`. **둘 다 시나리오로 덮는다** — 하나는 픽스처 충실도,
> 하나는 제품 파리티. 어느 쪽도 다른 쪽인 척하지 않는다.

```
#5a  close_policy = keep_open      ← 픽스처가 채집된 조건 그대로
frames: wire/interrupt.jsonl 를 **바이트 그대로** 재생
  (실측: control_response{still_queued:[]} → user"[Request interrupted by user]"
   → result/error_during_execution terminal_reason=aborted_streaming
   → 같은 프로세스에서 2·3턴 정상, session_id 불변)
흐름: send → Streaming → C interrupt → T13(카드 해제 + **큐 비움**) → Interrupting
      → T14 result(aborted_streaming) → §3.4 착지
      → live 비었음 ∧ drainable=false(T13이 큐를 비웠다) ∧ keep_open → Resident{Policy::KeepOpen}
      → send("2턴") → T16 주입 (spawn_identity 동일 · thread 연속)
      → send("3턴") → T16 주입
assert: 상태 궤적 = [starting, streaming, interrupting, resident(keep_open),
                     streaming, resident, streaming, resident]
        FakeCli spawn 수 = **1** (재스폰 0), session_id 3턴 내내 불변
        interrupt_requested=true 라서 T12(통지 재주입)가 발동하지 않음
        run_id 3개, 각각 종결 status 1회 (불변식 3)
        total_cost_usd는 **프로세스 누적** → 델타 가산 (m3-poc.md §3 실측)
        중단 시점에 queue_cleared verdict 1회 (§7.4)
```

```
#5b  close_policy = on_idle        ← 3.0 출하 기본값. 2.6.2 파리티
같은 프레임을 1턴까지만 쓰고, 2턴은 새 스트림으로 재생
흐름: … → T14 result(aborted) → §3.4 착지
      → live 비었음 ∧ **drainable=false**(중단이 큐를 비웠으므로) ∧ on_idle
        → close_input() → T25 Ended → T26 Idle
      → send("2턴") → T1 ColdStart (`--resume <session_id>`)
   ★R3 주의: 중단이 큐를 비우지 **않았다면** §3.4-a의 (true,true) 가지로 가 close가 보류되고
     2턴이 T16 주입이 됐을 것이다. 즉 5b의 `spawn 2` 단언은 **L1(§7.4)에도** 달려 있다.
assert: FakeCli spawn 수 = **2**, 두 번째 spawn argv에 `--resume` + 같은 session_id
        중단 마커('중단함')가 스레드에 남아 있음
        큐는 여전히 비어 있음(되돌리기 토큰은 첫 send에서 만료 — §7.4)
        busy 해제 (불변식 2)
```
없으면 놓치는 것: 중단 뒤 첫 메시지가 **어느 경로로 가는지**가 정책마다 다르다는 사실 자체.
R1처럼 한쪽만 적으면 "픽스처가 초록이니 제품도 그렇겠지"라는 착각이 남는다.

### #6 백그라운드 살아있는 상태의 중단 (**PoC 미검증 구간 · 위험 #2**)

```
close_policy = on_idle          ← 라이브 항목이 있으니 정책과 무관하게 Resident로 간다
send → Streaming
enqueue("나중 것")               ⇒ 큐 1건 (★R2 — 중단의 큐 효과를 여기서도 본다)
frames: synth/bg-shell.jsonl (background_tasks_changed: local_bash 2개)   [F13]
interrupt  ⇒ T13: 카드 해제 → **큐 비움 + undo 토큰** → control_request{interrupt}
frames: result(aborted_streaming)
assert: 셸 2개가 **정착하지 않는다**(중단은 턴만 죽인다), 상태 = Resident{LiveItems},
        원장 = 셸 2개 observed, 리스가 장전돼 있다(★ 2.6.2는 타이머를 안 걸었다),
        **큐 = 0건**, queue_cleared verdict 1회      ← R1이면 여기서 "나중 것"이 자동 전송(L1)
        이어서 send ⇒ 정체성 동일 → T16 주입(재스폰 아님) ⇒ 셸 생존, spawn 수 = 1
변형 6b: 중단 후 identity_set{engine.model} → send ⇒ T17 재스폰,
        셸 2개 정착 사유 = IdentityChanged[engine], 안내 문구 1회
변형 6c ★R3 재작성: 중단 후 clock.advance(95s) — 셸이 조용하다.
        **프로브 체인이 R2와 다르다**(② 삭제 · ⑥ 신설 — m-logic §5.4-b). 세 갈래로 쪼갠다:
  6c-i  (dev 서버) fault=touch{outputFile, every_ms:60_000}
        ⇒ 리스(90s) 만료 → ①a 없음 → ③ 없음(BgShell) → **④ mtime 최근 → Alive** → 재장전
        assert: 정착 0건, liveness 내내 observed, gating 유지, ⑥은 **호출되지 않는다**(싼 게 먼저)
  6c-ii (출력 없는 정상 셸 — 응답 대기 서버·sleep) fault=control_alive{responsive:true},
        probe_reply{tasks:[bash-1, bash-2]}
        ⇒ ④ 실패 → **⑥ 능동 initialize → 응답 뒤 REPLACE에 둘 다 있음 → Alive** → 재장전
        assert: 정착 0건, gating 유지, `initialize` 재전송 정확히 1회(불변식 16)
        ★ **R2였다면 여기서 90s에 게이팅을 잃고 30분에 알약이 사라졌다** — 2.6.2는 유지했다.
          크리틱 N6이 "말없는 후퇴"라고 부른 자리이고, 이 시나리오가 그 회귀 잠금이다.
  6c-iii (진짜 죽음) control_alive{responsive:true}, probe_reply{tasks:[]}
        ⇒ ⑥ → **Dead** → T21b: settle(Watchdog{probe:Active}) ×2 **즉시**(30분 안 기다린다)
        ⇒ 응답에 실려 온 빈 REPLACE는 F13으로도 소화 → 목록 빔 ∧ confidence=Observed ∧ on_idle
           → **T20** → Terminating{AllClear} → Ended → Idle
        assert: 정착 시각 ≈ 95s(±tick), 사유 = watchdog:active,
                ledgerConfidence == 'observed'(추정 아님),
                close_input 호출 1회 — **불변식 12에 걸리지 않는다**(probe 태그로 구분)
```
없으면 놓치는 것: **2026-08-03 릴리즈 사고(중단 1회 → 매 턴 CLI 사망 루프)의 연료 그 자체.**
크리틱이 "한 번도 시험되지 않았다"고 지적한 정확히 그 조합.

### #7 워크플로 도는 중 CLI 강제 종료 (**P8 유령 재현**)

§3.1의 전문 참조. 추가 변형:

```
7b ★R3 재작성 — **행(hang)한 CLI**: fault=freeze{35분} + control_alive{responsive:**false**}
    (프로세스는 살아 있는데 프레임도 컨트롤 응답도 없다)
    t=0        마지막 REPLACE(wf-1, wf-2 멤버십) 관측 → last_evidence = 0, lease_until = 90s
    t=5s..85s  tick마다 now < lease_until → continue        (프로브 안 부름)
    t=90s      리스 만료 → probe_chain:
                 ⓪ 프로세스 생존       → **묻지 않는다**(CAN_SAY_ALIVE=false) ★ 여기가 L2 수정점
                 ①a 지목 프레임        → 35분째 없음 → Unknown
                 ③ task_progress 하트비트 → 90s 창 밖 → Unknown
                 ④ 전사 mtime          → 파일 없음/오래됨 → Unknown
                 ⑥ 능동 initialize     → **3s 타임아웃 → Unknown** (+ stream_hung_probes += 1)
               ⇒ liveness = Unverified   ★ 게이팅 자격 즉시 상실
    t=90s..30분 tick마다 같은 결과(단 ⑥은 **30s 간격**으로만 재시도 — 불변식 16).
               now - last_evidence < hard_limit(30분) → 정착 보류
    t=30분     hard_limit 도달 → settle(wf-1, Watchdog{probe:None}), settle(wf-2, 동상)
               ⇒ 알약 2개 소멸, ledger.confidence = Unverified
               ⇒ (상태가 Resident{*}이므로 가드 통과 — §5.4-c) T21 → **Resident{Unverified}**
                 (★ close_input 하지 않는다 — 규약 3)
               ⇒ 안내 1줄 "백그라운드 진행 상태를 알 수 없어 표시를 정리했어요 … [엔진 정리]"
    assert: t=90s 이후 어느 시점에도 switch_chat/new_chat/delete_chat이 거부되지 않음
            busy == false 내내
            settle 사유 = watchdog:none(≠ Completed) — 표시는 "정리됨(응답이 없어서)"
            불변식 11: last_evidence를 process_alive가 움직인 이벤트 0건
            불변식 12: Watchdog{None} 정착 직후 close_input 호출 0건
            불변식 15: 상태 대입의 직전 상태가 Resident{*}
            불변식 16: initialize 재전송 간격 ≥ 30s
    ★ R1 문면대로면: 프로브 ①이 Alive를 돌려줘 t=90s에 리스가 재장전되고
      **35분 내내 알약이 그대로**다 — P8 그 자체. 이 시나리오가 L2의 회귀 잠금이다.

7b′ ★R3 신규 — **외부에서 죽은 워크플로 + 멀쩡한 CLI (P8 본체의 실제 모양)**:
    fault=freeze{35분} + control_alive{responsive:**true**} + probe_reply{tasks:[]}
    t=0..85s   7b와 동일
    t=90s      리스 만료 → ①a/③/④ Unknown → **⑥ 능동 initialize**
    t≈93s      성공 응답 + 빈 background_tasks_changed 도착
               ⇒ ⑥ = **Dead** → **T21b**: settle(wf-1, Watchdog{probe:Active}), settle(wf-2, 동상)
               ⇒ confidence는 **Observed 유지**(추정이 아니다)
               ⇒ 같은 프레임이 F13으로도 소화 → 목록 빔 ∧ Observed ∧ on_idle
                 → **T20** → Terminating{AllClear} → T25 Ended → T26 Idle
    assert: 알약 소멸 시각 ≈ 93s(**30분이 아니다**)
            settle 사유 = watchdog:active, ledgerConfidence == 'observed'
            close_input 정확히 1회, 최종 상태 idle, spawn 수 == exit 수
            프로브 응답의 pending_permission_requests(있으면)로 **중복 카드 0건**(불변식 16)
    ★ **P8(사용자 스크린샷 버그)의 실제 형태가 이것이다** — 프로세스는 멀쩡하고 워크플로만 죽었다.
      R2 설계에서는 30분을 기다려야 했고 그마저 추정 정착이라 프로세스가 6h까지 남았다.
      7b와 7b′가 **같이 있어야** "행한 CLI"와 "죽은 작업"을 구별한다는 게 검증된다.
7c: 7b 도중(t=10분) force_settle(wf-1) ⇒ 즉시 정착 ForcedByUser, 표시 "강제로 정리함
    (실제 프로세스는 남아 있을 수 있음)". wf-2는 그대로 → 30분에 Watchdog{None}.
7d ★R2 신규: 7b를 6시간까지 연장  (freeze{6h 5분}, responsive=false)
    t=6h  stream_idle_limit 도달 → T32 → close_input → kill 상한 → Terminating{IdleReclaim}
          → T25 Ended → T26 Idle
    assert: 최종 상태 idle, 원장 [], spawn 수 == exit 수
    ★ 이게 "행(hang)한 CLI"의 마지막 탈출구다. 7b만으로는 프로세스가 영원히 남는다.
    ★R3: 7b′ 경로로 가는 CLI는 여기까지 오지 않는다(93초에 회수됐다).
7e ★R2 신규 (거짓 양성 방지): fault=freeze{35분}이되 **전사 mtime을 5분마다 갱신**
    assert: 프로브 ④가 Alive → 리스 재장전 → 35분 내내 항목이 정착하지 않고 게이팅도 유지
            ⑥은 **한 번도 호출되지 않는다**(④가 먼저 답한다 — 프로브 순서 검증)
    ★ 진짜 도는 dev 서버를 워치독이 죽이지 않는다는 반대편 증명.
       7b와 7e가 같이 있어야 워치독이 "무차별"이 아님이 검증된다.
```
**이 여섯 변형이 사용자 스크린샷 버그의 전부다** — 재시작 없이 빠져나오는 경로가
넷(**능동 프로브 93초** · 자동 30분 · 강제 해제 · 6h 회수) 생기고,
살아 있는 작업을 오인 사살하지 않음이 둘(7e·6c-ii) 증명된다.

### #8 승인 카드 뜬 채 CLI 사망 (P8 + 대기자 누수)

```
frames: wire/approve.jsonl 를 can_use_tool 직전까지 재생
   ⇒ AwaitingUser, 원장에 AskCard{request_id, tool_use_id}
fault = kill_process{cause: crash}
assert: AskCard 정착 StreamClosed{crash} → 카드 닫힘 이벤트,
        종결 status 정확히 1회, 대기자 0, busy 해제,
        ★ 이후 도착하는 (지연된) control_response 는 **버려진다**
          — m-logic §5.7 규약 2(미매칭은 조용히 버리고 unmatched LRU 1024에 기록).
            R1은 이걸 "SDK가 해 주는 것"으로 두고 본문에 안 적었다(크리틱 §5 #8).
            Rust가 컨트롤 채널을 직접 몰면 **우리 규약**이므로 이제 본문에 있다.
변형 8b: 사망 대신 app_quit  ⇒ 정착 사유 AppQuit,
        재부팅 시 저장본 복원에서 "앱이 종료돼 정리됨" 배지가 붙는다
        (2.6.2 snapshotForPersist는 사유 없이 조용히 stopped로 내렸다)
변형 8c ★R2: 같은 request_id의 control_response가 **두 번** 도착(fault=duplicate)
        ⇒ 멱등 — 두 번째는 unmatched 경로, 패닉·중복 이벤트 없음 (§5.7 규약 3)
```

---

## 5. 상시 회귀 시나리오 (8조합 외 — 같은 러너)

| # | 시나리오 | 지키는 규약 |
|---|---|---|
| 9 | **정착↔통지 순서 뒤집기** — `fault=reorder`로 `background_tasks_changed`(레벨)와 `task_notification`(에지)의 순서를 6가지 순열로 | 위험 #2. **레벨이 진실, 에지는 장식** — 어느 순열에서도 최종 원장이 동일해야 |
| 10 | 무음 result 슬라이딩 보류 → 13초 뒤 진짜 첫 토큰 | `HeldResult` 재장전 8회(~22s). 고정 타임아웃이면 '응답 없음' 오탐 |
| 11 | 통지 삼킴 재주입 **1회 제한** — 재주입 턴이 또 무음이면 두 번째 재주입 금지 | T12 `replayed_once` 불변식(무한 루프 방지) |
| 12 | `addDirs` 순서만 다른 재전송 | **재스폰 없음**(§2.3 `BTreeSet`) — 2.6.2는 `JSON.stringify` 비교라 재스폰했다 |
| 13 | 전역 `outputStyle` 변경 후 다른 채팅에서 send | 상주가 끊기지 않음(§2.4 물질화). ★R3: 이제 **채팅 정체성이 아예 안 바뀐다**(상속 경로가 없다) — 단언을 "identity_hash 불변"으로 강화 |
| 13b ★R3 | 전역 변경 후 **[전부 적용]** 흐름 | 채팅 N개에 `identity_set`이 N번 나가고 verdict N개가 **전부** 돌아온다(턴 중 = deferred, 계정 없음 = rejected). 조용히 반영되는 채팅 0건(D7 · §2.4 규약 3) |
| 14 | `Resident`에서 `interrupt` | ★R2 수정: verdict = **`accepted`** + bg 전체 중지 **즉시 수행** + 큐 비움 (2.6.2 `App.tsx:901-908` 파리티). R1의 `no_turn`+제안은 클릭 한 번을 두 번으로 만드는 말없는 파리티 후퇴였다(크리틱 L9). ★R3: 대응 전이는 **T35**(#32가 전이 커버리지를 든다) |
| 15 | 큐 항목의 첨부 파일이 사라진 채 드레인 | `rejected{attachment_missing}` 정착, 뒤 항목은 계속 (O11) |
| 16 | `delete_chat`을 라이브 항목 있는 채팅에 | ⚠️ confirm + 비용 문장, 확인 후 `Cancelled` 정착 |
| 17 | 같은 `task_notification` 중복 배달 | 멱등 — 정착 이벤트 1회 |
| 18 | `system/init`이 턴마다 재도착, `session_id` 불변 | **"init 도착 = 새 세션" 판정 금지**(m3-poc.md §3 실측). 전이 **F1** |
| **19** ★R2 | **폴백 3경로 6순열** — {다이얼로그 수락, `model_refusal_fallback`, `assistant.message.model` 변화}를 도착 순서 6가지로 | m-logic §6.2 합류표. 어느 순열에서도 **리비전 1개·배너 1개**(불변식 13). 사이드체인 프레임을 섞어도 늘지 않음(§6.5) |
| **20** ★R2 | 중단이 큐를 비우고 `queue.restore`가 복원 | §7.4. `queue_cleared` 1회 + `undoToken` + 복원 후 순서·정체성 스냅샷 동일. **복원이 자동 전송을 유발하지 않음** |
| **21** ★R2 | 워치독이 **프로세스 생존만으로** 재장전되지 않음 | m-logic §5.4-b 프로브 ⓪. 불변식 11의 전용 시나리오(freeze + 프로세스 alive 고정) — **L2 회귀 잠금** |
| **22** ★R2 | `skillOverrides` 토글 후 재전송 | **재스폰 발생**(P1e). 2.6.2는 `optsMatch`에 없어 "껐는데 안 꺼짐"이 조용히 났다. 같은 형태로 `deniedMcp`·API 키 지문·`drop_env_key` 각각 1건 |
| **23** ★R2 | `Resident{Unverified}`에서 `send` | 재사용 판정은 정상 동작(정체성 같으면 T16 주입). **원장 confidence가 send를 막지 않는다** — 막으면 P8이 다른 형태로 부활 |
| **24** ★R2 | 스트림 급사 후 늦게 온 `control_response` | §5.7 규약 2 — 조용히 버림, `unmatched`에 1건 기록, 대기자 0 유지(불변식 4) |
| **25** ★R3 | **spawn 실패 / `initialize` 20s 무응답** | **T3** → `Terminating{SpawnFailed}`. `notice` + `status:error` 각 1회, 원장 비어 있음, busy 해제, 큐는 **그대로**(중단이 아니다 — L1과 구별). 두 갈래: 프로세스가 안 뜸 / 떴는데 응답 없음 |
| **26** ★R3 | CLI가 승인 카드를 **회수**(`control_cancel_request`) | **T6** → 카드 정착 `Withdrawn`, "질문이 취소됨" 표시 1회, `AwaitingUser → Streaming`, 그 뒤 사용자의 늦은 응답은 §5.7 규약 4로 **전송 시도조차 하지 않음** |
| **27** ★R3 | **중단 6s 무응답 → 하드 강등** + **부팅 재장전** | 앞부분: **T15** → `Terminating{HardCancel}` → kill 상한 → Ended. 뒷부분: 그 채팅에 큐 2건 + hold가 있는 상태로 `app_quit` → 재부팅 → `status.json` 인덱스 → `ChatRuntime::ensure` → **hold 재장전 + 큐 복원**(m-logic §5.8). `status.json`을 지우고 재부팅해도 전수 얕은 스캔으로 같은 결과(반쪽 쓰기 내성) |
| **28** ★R3 | `/btw` 포크 후 send | **T18** `ThreadChanged`(정체성은 동일) — 사유 문구가 `IdentityChanged`와 **다르다**. 이어서 `cwd` 변경 후 send = **둘 다** 실린 `RespawnReason`(m-logic §3.3의 `—` 규약 행) |
| **29** ★R3 | `/compact` | **T28** — `compact_boundary` 버퍼 → 다음 assistant 프레임과 짝맞춤(F9). 턴이 먼저 끝나면 `after=null`로 방출. `synth/compact.jsonl`을 **드디어 쓰는** 시나리오 |
| **30** ★R3 | `Starting` 중 `interrupt` | **T34** — spawn 핸들 abort, 정착할 항목 0, 큐 비움 + undo 토큰(§7.4), `Terminating{Cancelled}`. `stop_all` 변형도 같은 행 |
| **31** ★R3 | 자동 응답·통과 프레임 3종 | **F14**(`task_started` → `tool_use_id→task_id` 매핑 후 그 서브에이전트의 tool_result가 "백그라운드 접수증"으로 판정되는가) · **F18**(`notification`/`informational` → `notice` 통과, 원장 무영향) · **F22**(`hook_callback`·`mcp_message`·미지 subtype → 프로토콜 §4.4 규약대로 자동 응답, **UI 카드 0건**) |
| **32** ★R3 | `Resident{LiveItems}`에서 `interrupt` | **T35** — `stop_task` N회 송신, `control_request{interrupt}` **0회**(턴이 없다), 큐 비움 1회, 결과 통지 1회. ⓐ F13/F17로 이탈 확인 → `Stopped{by_user}` + confidence Observed → 빈 REPLACE에 T20. ⓑ 3s 무응답 → `ForcedByUser` + confidence Unverified → `Resident{Unverified}`. **두 갈래가 다르게 나오는지**가 단언 |
| **33** ★R3 | 능동 프로브 예산과 Dead 판정 | **T21b** + 불변식 16. `initialize` 재전송이 **30s 미만 간격으로 두 번 나가지 않고**, 한 tick에서 같은 채팅에 2회 이상 안 나가며(항목이 3개여도 왕복 1회), 응답의 `pending_permission_requests`가 이미 있는 카드면 **추가 이벤트 0건** |

> **★R3 — 왜 9건을 늘렸나 (크리틱 N11).** R2는 "전이 58개 중 58개 밟음"을 리포트 형식에 적고
> `covers` 미달 = **빌드 실패**로 정했는데, 열거된 시나리오 어디에도 T3·T6·T15·T18·T28·T34·
> F14·F18·F22를 밟는 것이 없었다(`synth/compact.jsonl`·`task-started.jsonl`은 만들어만 두고
> 쓰이지 않았다). 선택지는 둘이었다 — **게이트를 「핵심 전이 목록」으로 좁히거나, 시나리오를 채우거나.**
> 좁히면 "표에는 있는데 테스트가 없는 줄"을 구조적으로 못 만든다는 §7의 설계 의도가 죽으므로
> **채우는 쪽**을 골랐다. 신규 전이 T21b·T35도 #33·#32가 든다.

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
m-logic replay: 53/53 green   (wire fixtures 9, synth 6)
─ 필수 8조합 ................ 8/8   (변형 포함 실 시나리오 27개)
                              1·1b(2) / 2·2b·2c·2d-i·2d-ii(5) / 3(1) / 4·4b·4c(3) /
                              5a·5b(2) / 6·6b·6c-i·6c-ii·6c-iii(5) /
                              7·7b·7b′·7c·7d·7e(6) / 8·8b·8c(3)
─ 상시 회귀 .................. 26/26  (#9~#33 25건 + #13b)
─ 공통 불변식 ................ 16/16 × 53 시나리오 = 848/848                ★R3
─ 프레임 커버리지 ............ §8.4 24행 → 전이 **60개 중 60개** 밟음       ★R3
─ 죽인 병리 커버리지 ......... P1 ✓ P1b ✓ P1c ✓ P1d ✓ P1e ✓ P2 ✓ P3 ✓ P4 ✓ P5 ✓
                              P6 ✓ P7 ✓ P8 ✓ P8b ✓ P8c ✓ P9 ✓   (m-logic.md §8 대응)
─ close_policy 분포 .......... on_idle 50 · keep_open 2 · linger 1         ★R3
─ 합성 의존 시나리오 ......... #2 #4 #6 #7 #9 #19 #25 #29 #31 #33
                              (라이브 관측 생기면 wire로 승격)
─ 능동 프로브 의존 ........... #6c-ii #6c-iii #7b′ #33  ← **O17이 실패하면 이 4건이 통째로 바뀐다**
```

> **★R3 — R2의 이 줄들은 산수가 안 맞았다(자체 발견).** "필수 8조합 (변형 포함 실 시나리오 **17개**)"라
> 적었지만 §4에 열거된 변형은 **21개**였고(1·1b·2·2b·3·4·4b·4c·5a·5b·6·6b·6c·7·7b·7c·7d·7e·8·8b·8c),
> `21 + 16 = 37`이라 머리줄의 `33/33`과도 맞지 않았다. R3는 세 수를 전부 다시 셌다:
> **27(필수 변형) + 26(상시) = 53.** 하위 갈래(2d-i/ii · 6c-i/ii/iii)는 **각각 별개 TOML**이라
> 하나로 세지 않는다 — 단언이 서로 다르기 때문이다.
> 커버리지 분모도 58 → **60**(T21b·T35 신설).

`kills = [...]` 필드를 시나리오마다 적게 한 이유가 이 줄이다 — **§8 대응표의 모든 병리에
최소 1개 시나리오**가 붙어 있는지 러너가 집계한다. 붙지 않은 병리가 있으면 **빌드 실패**.
`covers = [...]`도 같은 장치다(★R2) — `m-logic.md` §3.7 사영표의 전이 중 **아무 시나리오도
안 밟는 것**이 있으면 빌드 실패. 두 집계가 "표에는 있는데 테스트가 없는 줄"을 구조적으로 못 만든다.

---

## 8. 개정 후 종이 재생 (trace) — 8조합 전수 (★R3 재실행)

크리틱 §5와 **같은 방식**으로 **처음부터 다시** 돌렸다: `m-logic.md` §3.3(A/B) 전이표 +
**§3.4·§3.4-a** 착지 + §3.6 판정표 + **§5.4 개정 워치독 루프**만 써서 손으로 한 스텝씩.
코드는 아직 없다 — 이 표가 주장하는 것은
"**설계 문서만 읽고도 각 스텝의 다음 상태가 유일하게 결정된다**"이다.

**먼저 정직하게**: 크리틱 R2의 재검 결론은 **7/8**이었고 그게 맞았다.
R2가 적은 "8/8"은 **#4에서 거짓**이었다 — `close_policy=on_idle`에서 §3.4가 매 턴 `close_input()`을
부르므로 §7.2의 배칭이 불가능했고, 실제 스폰은 3이 아니라 **4**였다.
R3는 §3.4-a(「드레인 가능하면 close 보류」)를 본문에 넣어 **그 단언을 참으로 만들었다.**
아래 표의 "R3 판정"은 **개정된 본문** 위에서 다시 센 결과다.

| # | R1 | R2(자기 주장) | **크리틱 R2 재검** | **R3 (재실행)** | 무엇이 바뀌었나 |
|---|---|---|---|---|---|
| **1 / 1b** 계정 변경 중 턴 시작 | ✗ | ✅ | ✅ 동의 | **✅ 온전** | 단언의 `[billing]`이 리프 `['billing.account']`로. 트레이스 불변 |
| **2 / 2b** 폴백 직후 계정 변경 | ✗ | ✅ | ✅ 동의 **(잠금 부족)** | **✅ 온전 + 2c·2d 신설** | 크리틱 지적대로 2·2b는 **billing 패치만** 잠갔다 → N2(engine 패치가 폴백을 삼키는 경로)를 못 잡는다. **2c**(effort-only + 폴백)가 그 전용 잠금, **2d-i/ii**가 같은 리프 충돌의 결정론 |
| **3** busy 중 채팅 전환 | ✓ | ✅ | ✅ 동의 | **✅ 온전 + 한계 명시** | 변화 없음. 하네스가 Rust만 때린다는 한계(O2)를 그대로 유지 |
| **4 / 4b / 4c** 예약 큐 + 한도 | △ | ✅ | ❌ **SUT와 어긋남**(실제 spawn 4) | **✅ 온전** | **§3.4-a 한 줄**로 성립. 트레이스에 착지 분기를 스텝마다 명시 → spawn 3 / exit 3 / **T16 주입 정확히 1회**. 드레인 계획 문구도 "프로세스 2개로 나눠 보냅니다"로 고침(항목 수와 프로세스 수가 헷갈리던 자리) |
| **5a / 5b** 중단 직후 재개 | ✗ | ✅ | ✅ 동의 | **✅ 온전** | 착지 조건에 `drainable=false`(L1이 큐를 비웠다)를 명시. 5b의 `spawn 2`가 **§7.4에도 달려 있다**는 의존을 드러냄 |
| **6 / 6b / 6c** bg 살아있는 중단 | ✓ | ✅ | ✅ 동의(단 ②는 항상 stale) | **✅ 온전 (6c 재작성)** | 크리틱이 지적한 "②는 항상 stale" 사슬이 **프로브 표 개정으로 사라졌다**. 6c는 3갈래로: mtime Alive / **능동 Alive**(2.6.2 파리티 복원) / 능동 Dead(~95s 정착) |
| **7 / 7b~7e** 워크플로 중 CLI 강제 종료 | △ | ✅ | ✅ 동의 | **✅ 온전 (7b 분기 신설)** | **7b(행한 CLI · 프로브 타임아웃 → 30분)** 와 **7b′(외부 사망 워크플로 · 능동 Dead → ~93초 + T20 회수)** 가 갈린다. P8의 실제 형태는 7b′다 |
| **8 / 8b / 8c** 승인 카드 뜬 채 사망 | ✓ | ✅ | ✅ 동의 | **✅ 온전** | 변화 없음 |

**요약: R3 = 8/8** (변형 포함 실 시나리오 27개).
R1 대비 온전 3 → 8. **R2 대비**는 "선언만 8/8 → 실제로 8/8"이다 — 늘어난 건 판정이 아니라 **근거**다.

### 8.1 이 표가 주장하지 **않는** 것

정직하게 적어 둔다. 종이 재생은 **설계의 결정성**을 보인 것이지 구현의 정확성이 아니다.

1. **합성 픽스처 의존**: #2·#4·#6·#7·#9·#19·#25·#29·#31·#33은 `synth/`에 기댄다. 특히
   `rate-limit-blocked.jsonl`은 **한 번도 관측된 적 없는 모양**이다(m-logic O14).
   그 위에서 초록인 것은 *우리 가정 위에서* 초록이다.
2. **타이밍 상수는 전부 미실측**: 리스 90s · `hard_limit` 30분 · `stream_idle_limit` 6h ·
   셸 유예 5s · **능동 프로브 3s 타임아웃 / 30s 최소 간격**. 전부 첫 숫자다.
   가상 시계가 검증하는 건 "그 숫자대로 발화하는가"이지 "그 숫자가 옳은가"가 아니다(O7·O16·O18).
3. **#3의 진짜 위험은 범위 밖**: 렌더러 리듀서 소유권(O2). 하네스는 Rust만 때린다.
4. **`close_policy` 출하 기본값이 아직 열려 있다**(O13). #5a/#5b가 둘 다 초록이어도
   **어느 쪽으로 출하할지는 실측(상주 RSS · 재스폰 지연) 뒤에 정한다.**
   ★R3: §3.4-a가 들어가면서 `OnIdle`의 재스폰 비용이 **큐가 있을 때만큼은** 사라졌으므로
   O13의 저울이 `OnIdle` 쪽으로 조금 더 기운다 — 그래도 실측 전에는 안 정한다.
5. **L8/O15(와이어의 싼 경로)를 닫지 못했다**: `set_model`·`apply_flag_settings`가 실제로 도는지는
   라이브 1턴이 필요하다. 그때까지 "설정 변경 = 재스폰 = 백그라운드 몰살"은 **그대로 남는다** —
   안내 문구가 정직해질 뿐이다.
6. **P1e 4축은 이 하네스로 "실제로 고쳐졌는지" 못 본다**: 재생은 `RunIdentity`가 다르면
   재스폰한다는 것만 보인다. 스폰 argv/env에 그 값이 실제로 실리는지는 M3 라이브 몫이다.
7. ★R3 **능동 프로브 ⑥ 자체가 가정이다**(O17). `initialize` 재전송이 REPLACE를 밀어 준다는 건
   문서·JSDoc 근거이고 **라이브 미관측**이다. `FakeCli`의 `probe_reply` 폴트는 **우리가 정한 응답**을
   돌려줄 뿐이다. O17이 실패하면 #6c-ii·#6c-iii·#7b′·#33이 통째로 바뀌고,
   "출력 없는 조용한 셸은 90s에 게이팅을 잃는다"가 영구 제약으로 남는다.
8. ★R3 **`Resident{Policy::Linger(0)}`의 비관측성은 하네스가 못 본다**: "브로드캐스트되지 않는다"는
   이벤트 로그로 검사할 수 있지만, 실제 렌더러가 그 사이 재렌더로 깜빡이는지는 **렌더러 레벨의 몫**이다.
