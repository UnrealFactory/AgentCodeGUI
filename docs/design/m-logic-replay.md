# M-LOGIC 회귀 하네스 — 상태기계 재생 테스트 · **R2**

> 본문: `docs/design/m-logic.md`. 이 문서는 그 §9(D10)의 상세다.
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
    frame_coverage.rs   # ★R2 §3.7 사영표(24행) ↔ 전이 id ↔ 시나리오 covers[] 집계
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
        01-account-change-midturn.toml … 24-*.toml   # ★R2 변형 포함 33개
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
identity = { engine = { engine = "claude", model = "fable", effort = "medium" },
             billing = { kind = "subscription", account = "fixture@example.com",
                         drop_env_key = false },
             cwd = "C:\\ccg-fixture\\work", mode = "default", tools = {} }

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
| `stale_replace{ms}` ★R2 | REPLACE 프레임만 끊어 멤버십을 낡게 만든다 | 프로브 ②의 **신선도 창** 검증 — 낡은 REPLACE가 Alive 근거로 쓰이면 L2가 부활한다 |
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
    `settle(reason=Watchdog)` 직후의 `close_input` 호출 0건(m-logic §5.4-c 규약 3).
13. ★R2 **폴백 리비전은 전환당 1개**: 같은 `to_model`로 향하는 리비전이 한 턴 안에 2개 이상이면 위반
    (m-logic §6.2 — 배너 핑퐁 회귀 잠금).
14. ★R2 **큐 이벤트 정합**: `chat:queue` REPLACE의 마지막 상태 == 러너가 추적한 큐 모델.
    중단이 있었으면 `queue_cleared` verdict가 정확히 1회 있고 `undoToken`이 비어 있지 않다.

> 불변식 1·2·3이 바로 **P8(유령)·busy 잠김·스피너 굳음**의 자동 감시다. 시나리오를
> 무엇으로 짜든 이 셋은 항상 검사된다. 11·12·13은 **R2가 고친 세 구멍이 다시 열리지 않게** 하는
> 잠금장치다 — 설계 문서의 문장이 아니라 테스트가 지킨다.

### 3.5 시나리오가 선언해야 하는 축 (★R2)

R1은 시나리오가 `identity`와 스텝만 선언했다. 크리틱 #5가 드러낸 대로 **SUT의 종료 정책이
픽스처 채집 조건과 다르면 "그대로 재생"이 불가능**하므로, 두 축을 선언 대상으로 올린다.

| 키 | 값 | 기본 | 왜 |
|---|---|---|---|
| `close_policy` | `on_idle` \| `linger_ms = N` \| `keep_open` | `on_idle` | m-logic §3.4-b. `wire/*.jsonl`은 전부 **`keep_open` 조건에서 채집**됐다(PoC 하네스가 stdin을 안 닫음 — `m3-poc.md:39`, `:253-254`) |
| `covers` | 전이 id 배열 | `[]` | `tests/frame_coverage.rs`가 §3.7 사영표(24행)의 모든 전이에 시나리오가 최소 1개 붙었는지 집계. 안 붙은 전이가 있으면 **빌드 실패** |

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
identity_set{ billing.account = b@x } @턴 중  ⇒ deferred
result → §3.4 착지 ⇒ 원장에 셸 1개 남음 → Resident{LiveItems}   (close_input 안 함)
send("다음")
assert: 재사용 판정 = Respawn{ IdentityChanged[billing] }
        effects.killsLive = [{ kind: BgShell, count: 1 }]
        셸 정착 사유 = IdentityChanged{diff:[billing]}   (≠ Completed)
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
frames: synth/refusal-fallback.jsonl  (system/model_refusal_fallback fable→opus)
   ⇒ §6.2 경로 B'(arm 없음) ⇒ 리비전 1: opus + a@x, origin=EngineFallback{via:refusal_frame}
   ⇒ fallback_armed = {opus, RefusalFrame},  observed_model = opus
   ⇒ 배너 이벤트 **정확히 1회**, revertTo = 0
frames: assistant{ message.model: "opus" }   (메인 경로)
   ⇒ §6.2 경로 C'(arm과 일치) ⇒ **미러만 갱신, 리비전 없음**   ★ R1이면 여기서 2번째 배너
identity_set{ billing.account = b@x } @턴 중
   ⇒ deferred{ patch:{billing}, base_revision:1, preview: opus+b@x }
result → §3.4 착지
   ⇒ land_pending(): normalize(현재(opus+a@x).patched({billing})) = **opus + b@x**
   ⇒ 리비전 2, origin=DeferredApply, driftedFields = []   (preview와 착지값이 같다)
   ⇒ fallback_armed 해제(턴 종료)
   ⇒ 원장에 셸 1개 → Resident{LiveItems}
send("다음")
   ⇒ 좌변 stream.spawn_identity = fable+a@x,  우변 chat.identity = opus+b@x
   ⇒ 재사용 판정 = Respawn{ IdentityChanged[engine, billing] }        ★ 두 필드 모두
assert: 리비전 총 3개(0 Default → 1 EngineFallback → 2 DeferredApply), 번호 단조 증가
        배너 이벤트 1회 (불변식 13)
        사유 문구에 "모델 자동 전환"과 "계정 변경"이 **둘 다** 들어감
        셸 정착 사유 = IdentityChanged{diff:[engine, billing]}
        identity_revert(0) ⇒ 리비전 3 (origin=Revert{to:0}, 값 = fable+a@x) — 히스토리 삭제 아님
변형 2b (드리프트 가시화): identity_set을 **폴백보다 먼저** 접수
   ⇒ deferred{ patch:{billing}, base_revision:0, preview: fable+b@x }
   ⇒ 그 뒤 폴백 발생(리비전 1: opus+a@x)
   ⇒ 착지: normalize(opus+a@x .patched({billing})) = opus+b@x,
      driftedFields = ["engine"]  ★ preview(fable)와 착지(opus)가 갈렸다
   assert: 브로드캐스트가 **토스트로 승격**되고 문구가 "계정만 바꿨고 모델은 자동 전환값을 유지"
   ★ R1 규칙이면 여기서 정체성이 fable+b@x로 착지 — **폴백이 조용히 취소된다**(그게 L3)
```
없으면 놓치는 것: 폴백과 사용자 변경이 겹쳤을 때 어느 쪽이 이겼는지 모르는 상태
(2.6.2에서 `setPicker`와 `restore`가 서로 덮어쓰던 자리). 2b는 **R1 설계였다면 반드시 빨간불**이
되는 케이스라, L3 회귀 잠금 그 자체다.

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

### #4 예약 큐 + 한도 소진 → 자동 이어서 (P5+P6) — **미정의 2개 확정 (★R2)**

> **R1이 부분이었던 이유**(크리틱 §5 #4): 뼈대는 표현됐지만 둘이 미정의였다.
> ① 삽입되는 `origin:'limit_resume'` 항목의 **정체성**(현재값? 원래 항목 스냅샷?)
> ② 항목마다 정체성이 다르면 드레인이 **매 항목 재스폰**인지, 그 비용을 UI가 어떻게 알리는지.
> **R2**: ①은 m-logic §7.3("재개 항목 = 발화 시점 현재 정체성, `onDrift:'use_current'`"),
> ②는 §7.2(항목별 판정 + 연속 동일 정체성 배칭 + 드레인 계획 브로드캐스트)로 확정.

```
close_policy = on_idle
                                  [리비전 0: fable + a@x]
send("1")                      → Streaming
enqueue("2"), enqueue("3")     ⇒ queued (각각 identity 스냅샷 = fable + a@x)
identity_set{ engine.model = opus } @턴 중 ⇒ deferred{ patch:{engine} }
                                  ★ 큐 항목 "2","3"은 여전히 fable 스냅샷
frames: synth/rate-limit-blocked.jsonl (result is_error + 한도 문구)
   ⇒ T30 hold 장전 { account: Subscription(a@x), resets_at }
   ⇒ §3.4 착지: land_pending() ⇒ 리비전 1 (opus + a@x, DeferredApply)
   ⇒ 원장 비었음 ∧ on_idle → close_input → Idle
   ⇒ drain_if_possible(): hold.ready == false → **return** (드레인 0건)
clock.advance(resets_at + 90s) ⇒ 신선 usage 재검증 → ready = true
   ⇒ 큐 head에 origin=limit_resume 항목 삽입
      identity = chat.identity **지금 값 = opus + a@x**  (★ ①의 답)
      onDrift  = 'use_current',  thread = 'continue'
   ⇒ 드레인 계획 브로드캐스트: [ {1건, opus, respawn:false},
                                {2건, fable, respawn:true, killsLive:[]} ]   (★ ②의 답)
drain ⇒ [resume(opus)] → [2(fable) 3(fable)]
   ⇒ 스폰 3회가 아니라 **2회**: opus 1스폰 → fable 1스폰에 "2","3" 연속 주입(배칭)
assert: hold 중 드레인 0건
        순서 = [resume, 2, 3], 이중 전송 없음(불변식 7)
        "2"의 스폰 정체성 = fable(예약 시점) ≠ opus(현재)   ← keep_snapshot 기본값
        resume 항목의 스폰 정체성 = opus(현재)              ← use_current
        UI 이벤트에 드리프트 배지 플래그 + 드레인 계획이 실려 있음
        총 spawn 수 = 3 (최초 + opus + fable),  exit 수 = 3 (불변식 9)
변형 4b: hold 중 identity_set{ billing.account = b@x }
   ⇒ hold.account != identity.billing ⇒ hold **무효화** + 사유 통지 1회
   ⇒ 그 즉시 드레인 가능해짐(게이트 해제) — 재개 항목은 **삽입되지 않는다**
변형 4c: hold 중 interrupt   ★R2 신규
   ⇒ §7.4: 큐 비움 + hold 해제 + queue_cleared{count:2, holdCancelled:true, undoToken}
   ⇒ clock.advance(resets_at + 90s) 해도 **아무것도 전송되지 않는다**
   ⇒ queue.restore(token) ⇒ 큐 2건 + hold 복원, 자동 전송은 안 됨
   ★ R1 설계였다면: 중지 후 몇 시간 뒤 혼자 이어서 보낸다(L1의 최악 형태)
```
없으면 놓치는 것: 2.6.2에서 훅과 드레인 effect가 같은 전이에 경합하던 자리(ref로 때운 곳).
4c는 L1이 한도 대기와 겹칠 때의 최악 시나리오라 **별도 잠금**이 필요하다.

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
      → 원장 비었음 ∧ keep_open → Resident{Policy::KeepOpen}
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
      → 원장 비었음 ∧ on_idle → close_input() → T25 Ended → T26 Idle
      → send("2턴") → T1 ColdStart (`--resume <session_id>`)
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
변형 6c ★R2: 중단 후 clock.advance(95s) — 셸이 조용하다
        ⇒ 리스(90s) 만료 → 프로브 ②(REPLACE 신선도 60s 초과 → stale) → ④(outputFile mtime)
        ⇒ mtime이 최근이면 Alive → 재장전 (dev 서버 케이스)
        ⇒ mtime도 없으면 Unknown → liveness=unverified → **게이팅만 해제**, 정착은 아직
        assert: 어느 쪽이든 셸이 30분 전에 정착하지 않는다,
                unverified 항목은 gating_blocks에 없다 (불변식 6)
```
없으면 놓치는 것: **2026-08-03 릴리즈 사고(중단 1회 → 매 턴 CLI 사망 루프)의 연료 그 자체.**
크리틱이 "한 번도 시험되지 않았다"고 지적한 정확히 그 조합.

### #7 워크플로 도는 중 CLI 강제 종료 (**P8 유령 재현**)

§3.1의 전문 참조. 추가 변형:

```
7b ★R2 재작성: fault=freeze{35분}  (프로세스는 살아 있는데 프레임 없음 — 워크플로 외부 사망)
    t=0        마지막 REPLACE(wf-1, wf-2 멤버십) 관측 → last_evidence = 0, lease_until = 90s
    t=5s..85s  tick마다 now < lease_until → continue        (프로브 안 부름)
    t=90s      리스 만료 → probe_chain:
                 ⓪ 프로세스 생존       → **묻지 않는다**(CAN_SAY_ALIVE=false) ★ 여기가 L2 수정점
                 ② REPLACE 멤버십      → replace_seen_at = 0, 신선도 창 60s 초과 → **stale → Unknown**
                 ③ task_progress 하트비트 → 90s 창 밖 → Unknown
                 ④ 전사 mtime          → 파일 없음/오래됨 → Unknown
               ⇒ liveness = Unverified   ★ 게이팅 자격 즉시 상실
    t=90s..30분 tick마다 같은 결과. now - last_evidence < hard_limit(30분) → 정착 보류
    t=30분     hard_limit 도달 → settle(wf-1, Watchdog), settle(wf-2, Watchdog)
               ⇒ 알약 2개 소멸, ledger.confidence = Unverified
               ⇒ T21 → **Resident{Unverified}**  (★ close_input 하지 않는다 — §5.4-c 규약 3)
               ⇒ 안내 1줄 "백그라운드 진행 상태를 알 수 없어 표시를 정리했어요 … [엔진 정리]"
    assert: t=90s 이후 어느 시점에도 switch_chat/new_chat/delete_chat이 거부되지 않음
            busy == false 내내
            settle 사유 = Watchdog(≠ Completed) — 표시는 "정리됨(응답이 없어서)"
            불변식 11: last_evidence를 process_alive가 움직인 이벤트 0건
            불변식 12: Watchdog 정착 직후 close_input 호출 0건
    ★ R1 문면대로면: 프로브 ①이 Alive를 돌려줘 t=90s에 리스가 재장전되고
      **35분 내내 알약이 그대로**다 — P8 그 자체. 이 시나리오가 L2의 회귀 잠금이다.
7c: 7b 도중(t=10분) force_settle(wf-1) ⇒ 즉시 정착 ForcedByUser, 표시 "강제로 정리함
    (실제 프로세스는 남아 있을 수 있음)". wf-2는 그대로 → 30분에 Watchdog.
7d ★R2 신규: 7b를 6시간까지 연장  (freeze{6h 5분})
    t=6h  stream_idle_limit 도달 → T32 → close_input → kill 상한 → Terminating{IdleReclaim}
          → T25 Ended → T26 Idle
    assert: 최종 상태 idle, 원장 [], spawn 수 == exit 수
    ★ 이게 "행(hang)한 CLI"의 마지막 탈출구다. 7b만으로는 프로세스가 영원히 남는다.
7e ★R2 신규 (거짓 양성 방지): fault=freeze{35분}이되 **outputFile mtime을 5분마다 갱신**
    assert: 프로브 ④가 Alive → 리스 재장전 → 35분 내내 항목이 정착하지 않고 게이팅도 유지
    ★ 진짜 도는 dev 서버를 워치독이 죽이지 않는다는 반대편 증명.
       7b와 7e가 같이 있어야 워치독이 "무차별"이 아님이 검증된다.
```
**이 다섯 변형이 사용자 스크린샷 버그의 전부다** — 재시작 없이 빠져나오는 경로가
셋(자동 30분·강제 해제·6h 회수) 생기고, 살아 있는 작업을 오인 사살하지 않음이 하나(7e) 증명된다.

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
| 13 | 전역 `outputStyle` 변경 후 다른 채팅에서 send | 상주가 끊기지 않음(§2.4 물질화) |
| 14 | `Resident`에서 `interrupt` | ★R2 수정: verdict = **`accepted`** + bg 전체 중지 **즉시 수행** + 큐 비움 (2.6.2 `App.tsx:901-908` 파리티). R1의 `no_turn`+제안은 클릭 한 번을 두 번으로 만드는 말없는 파리티 후퇴였다(크리틱 L9) |
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
m-logic replay: 33/33 green   (wire fixtures 9, synth 6)
─ 필수 8조합 ................ 8/8   (변형 포함 실 시나리오 17개)
─ 상시 회귀 .................. 16/16  (#9~#24)
─ 공통 불변식 ................ 14/14 × 33 시나리오 = 462/462
─ 프레임 커버리지 ............ §8.4 24행 → 전이 58개 중 58개 밟음        ★R2
─ 죽인 병리 커버리지 ......... P1 ✓ P1b ✓ P1c ✓ P1d ✓ P1e ✓ P2 ✓ P3 ✓ P4 ✓ P5 ✓
                              P6 ✓ P7 ✓ P8 ✓ P8b ✓ P8c ✓ P9 ✓   (m-logic.md §8 대응)
─ close_policy 분포 .......... on_idle 30 · keep_open 2 · linger 1        ★R2
─ 합성 의존 시나리오 ......... #2 #4 #6 #7 #9 #19 (라이브 관측 생기면 wire로 승격)
```

`kills = [...]` 필드를 시나리오마다 적게 한 이유가 이 줄이다 — **§8 대응표의 모든 병리에
최소 1개 시나리오**가 붙어 있는지 러너가 집계한다. 붙지 않은 병리가 있으면 **빌드 실패**.
`covers = [...]`도 같은 장치다(★R2) — `m-logic.md` §3.7 사영표의 전이 중 **아무 시나리오도
안 밟는 것**이 있으면 빌드 실패. 두 집계가 "표에는 있는데 테스트가 없는 줄"을 구조적으로 못 만든다.

---

## 8. 개정 후 종이 재생 (trace) — 8조합 전수 (★R2)

크리틱 §5와 **같은 방식**으로 다시 돌렸다: `m-logic.md` §3.3(A/B) 전이표 + §3.4 착지 +
§3.6 판정표 + §5.4 워치독 루프만 써서 손으로 한 스텝씩. 코드는 아직 없다 — 이 표가 주장하는 것은
"**설계 문서만 읽고도 각 스텝의 다음 상태가 유일하게 결정된다**"이다.

| # | R1 판정 | **R2 판정** | 무엇이 막았고 무엇이 뚫었나 |
|---|---|---|---|
| **1** 계정 변경 중 턴 시작 | ✗ 마지막 단언 불가 | **✅ 온전** (1 + 1b) | 막힘: 라이브 항목이 없어 착지가 `Idle`이라 다음 send가 `ColdStart` — `Respawn` 단언이 나올 수 없었다. 뚫음: 단언을 사실에 맞추고(#1 = ColdStart + "안내 문구 없음"), `Respawn` 경로는 셸을 심은 #1b로 분리 |
| **2** 폴백 직후 계정 변경 | ✗ 두 군데(L3·L4) | **✅ 온전** (2 + 2b) | 막힘: (a) `deferred` 전체 교체가 폴백 model을 되돌림 (b) 폴백 신호 합류 규약 부재로 리비전 수가 결정 불가. 뚫음: (a) §4.2-b 패치형 `pending` + 착지 재정규화 (b) §6.2 `fallback_armed` 합류표. 2b가 드리프트 가시화까지 검증 |
| **3** busy 중 채팅 전환 | ✓ (한계 미기재) | **✅ 온전 + 한계 명시** | 상태기계로는 원래 표현됐다. R2는 **하네스가 Rust만 때린다**는 검증 범위 한계를 시나리오 본문에 적었다(O2 미해결이면 하네스가 초록이어도 앱은 깨질 수 있다) |
| **4** 예약 큐 + 한도 소진 | △ 미정의 2개 | **✅ 온전** (4 + 4b + 4c) | 막힘: 재개 항목의 정체성 미정의 · 항목별 재스폰 비용의 UI 미정의. 뚫음: §7.3(재개 = 발화 시점 현재 정체성 · `use_current`) + §7.2(항목별 판정 + 연속 배칭 + 드레인 계획 브로드캐스트). 4c(hold 중 중단)는 L1 잠금으로 신설 |
| **5** 중단 직후 재개 | ✗ 픽스처와 SUT 어긋남 | **✅ 온전** (5a + 5b) | 막힘: 픽스처는 `keep_open` 조건(PoC 하네스가 stdin 미폐쇄)에서 채집됐는데 SUT는 무조건 `close_input`. 뚫음: `StreamClosePolicy`를 SUT의 명시 축으로 승격(§3.4-b). 5a = 픽스처 충실도(재스폰 0), 5b = 출하 기본값 파리티(ColdStart + `--resume`) |
| **6** 백그라운드 살아있는 중단 | ✓ | **✅ 온전 + 6c** | 원래 가장 잘 표현되던 조합. R2는 큐 효과(L1)와 조용한 셸의 리스 거동(6c)을 얹었다 |
| **7** 워크플로 중 CLI 강제 종료 | △ 본체 ✓ / 7b ✗ | **✅ 온전** (7 + 7b~7e) | 막힘: 프로브 ①(프로세스 생존)이 Alive를 줘 리스가 무한 재장전 → 7b 성립 불가. 뚫음: §5.4-b 프로브 등급(⓪ `CAN_SAY_ALIVE=false`) + REPLACE **신선도 창**. 추가로 7d(6h 유휴 회수)·7e(거짓 양성 방지) 신설 |
| **8** 승인 카드 뜬 채 CLI 사망 | ✓ (규약 1개 누락) | **✅ 온전** (8 + 8b + 8c) | 누락: 늦게 온 `control_response` 처리가 "SDK 규약"으로만 있었다. 뚫음: §5.7 컨트롤 대기자 회계를 본문에 신설(스트림 종료 = 전원 취소 · 미매칭 = 조용히 버림 · 중복 = 멱등) |

**요약: 8/8 온전.** R1 대비 온전 3 → 8 · 부분 2 → 0 · 불가 3 → 0.

### 8.1 이 표가 주장하지 **않는** 것

정직하게 적어 둔다. 종이 재생은 **설계의 결정성**을 보인 것이지 구현의 정확성이 아니다.

1. **합성 픽스처 의존**: #2·#4·#6·#7·#9·#19는 `synth/`에 기댄다. 특히
   `rate-limit-blocked.jsonl`은 **한 번도 관측된 적 없는 모양**이다(m-logic O14).
   그 위에서 초록인 것은 *우리 가정 위에서* 초록이다.
2. **타이밍 상수는 전부 미실측**: 리스 90s · `hard_limit` 30분 · `stream_idle_limit` 6h ·
   셸 유예 5s · REPLACE 신선도 창 60s. 전부 첫 숫자다. 가상 시계가 검증하는 건
   "그 숫자대로 발화하는가"이지 "그 숫자가 옳은가"가 아니다(O7·O16).
3. **#3의 진짜 위험은 범위 밖**: 렌더러 리듀서 소유권(O2). 하네스는 Rust만 때린다.
4. **`close_policy` 출하 기본값이 아직 열려 있다**(O13). #5a/#5b가 둘 다 초록이어도
   **어느 쪽으로 출하할지는 실측(상주 RSS · 재스폰 지연) 뒤에 정한다.**
5. **L8/O15(와이어의 싼 경로)를 닫지 못했다**: `set_model`·`apply_flag_settings`가 실제로 도는지는
   라이브 1턴이 필요하다. 그때까지 "설정 변경 = 재스폰 = 백그라운드 몰살"은 **그대로 남는다** —
   안내 문구가 정직해질 뿐이다.
6. **P1e 4축은 이 하네스로 "실제로 고쳐졌는지" 못 본다**: 재생은 `RunIdentity`가 다르면
   재스폰한다는 것만 보인다. 스폰 argv/env에 그 값이 실제로 실리는지는 M3 라이브 몫이다.
