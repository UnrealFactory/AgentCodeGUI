# M3 PoC 실측 결과 — Rust가 Claude Code CLI를 직접 몰 수 있는가

**하네스**: `scripts/poc-rs/` (cargo bin `poc_engine`, tokio + serde_json + windows-sys).
Node SDK를 **전혀 쓰지 않고** `claude.exe`를 직접 스폰해 stream-json 양방향으로 대화한다.
`scripts/poc-rs/Cargo.toml`에는 빈 `[workspace]`가 있어 레포 루트 워크스페이스와 독립이다
(루트 `Cargo.toml`/`Cargo.lock` 무변경).

| | |
|---|---|
| CLI | `~/.agentcodegui/engines/0.3.239/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` (2.1.239) |
| 계정 | 기본 계정 `lmg56634@gmail.com` (`CLAUDE_CONFIG_DIR` = 물질화 폴더, `ANTHROPIC_API_KEY` 삭제 → `apiKeySource:"none"`) |
| 모델 | `--model haiku --thinking disabled` (초저비용) |
| 라이브 스폰 | 11회, 합계 **≈ $0.09** |
| 0원 검증 | `smoke`, `job --with-job|--no-job` (자격증명 없는 빈 `CLAUDE_CONFIG_DIR`) |
| 프레임 원본 | `%TEMP%\ccg-poc-rs\<scenario>.jsonl` (전 프레임 raw) |

```bash
cd scripts/poc-rs && cargo build
./target/debug/poc_engine.exe smoke          # 0원
./target/debug/poc_engine.exe approve        # LIVE — can_use_tool + 항상 허용
./target/debug/poc_engine.exe approve-noid   # LIVE — toolUseID 뺀 응답
./target/debug/poc_engine.exe park           # LIVE — 응답을 아예 안 보냄 (90초)
./target/debug/poc_engine.exe ask            # LIVE — AskUserQuestion deny+message
./target/debug/poc_engine.exe interrupt      # LIVE — 소프트 중단 + 3턴 연속
./target/debug/poc_engine.exe resume         # LIVE — resume / fork-session
bash ../poc-rs/job-test.sh --no-job [--busy] # job 대조 (잔존분은 PID 지정 정리)
bash ../poc-rs/job-test.sh --with-job [--busy]
```

---

## 0. 결론 6줄

| # | 항목 | 결론 |
|---|---|---|
| 1 | 스폰 + initialize + 스트리밍 | ✅ Rust/tokio가 SDK 없이 완전히 몬다. 부분 라인 재조립·stderr 완전 분리 실측 |
| 2 | `can_use_tool` 왕복 | ✅ **`request_id`만으로 매칭.** `toolUseID`를 빼도 라이브 턴은 멈추지 않는다 — 그러나 **고아 재생 경로에서 필수**라 항상 넣어야 한다 |
| 3 | `AskUserQuestion` | ✅ 2.6.2의 `deny`+`message` 트릭이 2.1.239에서도 그대로 유효 |
| 4 | `interrupt` | ✅ 턴만 죽고 프로세스는 산다. 같은 프로세스로 2·3턴 정상. **사망 루프 재현 안 됨** |
| 5 | `resume` / `forkSession` | ✅ resume=같은 id·컨텍스트 승계, fork=새 id·원본 전사 보존 |
| 6 | job object | ✅ `KILL_ON_JOB_CLOSE`가 claude.exe와 손자까지 커널 보장으로 거둔다. **job 없으면 턴 중 크래시 시 전원 잔존** |

---

## 1. 스폰 + initialize + 1턴 스트리밍

```
./target/debug/poc_engine.exe smoke
```

`docs/protocol-claude-cli.md` §2.1 argv를 그대로 조립 →
`control_request initialize` → `{"type":"user"}` 한 줄.

```
>>> {"request":{"forwardSubagentText":true,"subtype":"initialize",
     "supportedDialogKinds":["refusal_fallback_prompt"]},"request_id":"init-1","type":"control_request"}
>>> {"message":{"content":[{"text":"hi","type":"text"}],"role":"user"},…,"type":"user"}
<<< [406ms] control_response/success id=init-1  {account:{apiProvider,tokenSource:"none"}, agents:[…], …}
<<< [428ms] system/init  session=f57640d8-… model=claude-haiku-4-5-20251001 apiKeySource=none
            mode=default caps=["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"]
<<< [429ms] system/status
<<< [449ms] assistant [text"Not logged in · Please run /login"] error=authentication_failed
<<< [450ms] result/success is_error=true cost=0 turns=1 stop="stop_sequence"
--- framing: read()=6 bytes=17628 frames=5 spanning_reads=1 max_line=13533 parse_err=0 empty=0
```

**JSONL 프레이밍**: 8 KiB `read()` 루프 + 수동 `\n` 스캔(`wire.rs`). `initialize` 성공
응답 하나가 **13,533 B** — 8 KiB 버퍼를 넘긴다. `spanning_reads=1`이 그 줄이 **2회의
read()에 걸쳐 재조립됐다**는 실측이다. `parse_err=0` — 중간 조각을 파싱한 적 없음.
`tokio`의 `lines()`를 안 쓰고 직접 짠 이유는 §3.1의 상한(MAX_LINE 64 MiB) 때문이다.

**stderr 분리**: 일부러 잘못된 플래그를 주면

```
[stderr] error: unknown option '--ccg-bogus-flag'
--- exit: ExitStatus(1)
--- framing: read()=0 bytes=0 frames=0 parse_err=0     ← stdout은 완전히 비어 있다
```

`--debug`를 얹어도 stderr로 새는 게 없고 stdout JSONL도 오염되지 않았다.
라이브 턴 11회 전부 `stderr lines: 0`.

**라이브 스트리밍 프레임 순서** (approve 런에서 관측, §5.3의 ★순서 주의 재확인):

```
system/init → system/status → stream_event message_start
→ content_block_start → content_block_delta(text_delta)×n
→ assistant(완성본)          ← ★ content_block_stop보다 먼저
→ content_block_stop → content_block_start → input_json_delta×n
→ assistant[tool_use] → content_block_stop → message_delta → message_stop
→ rate_limit_event → user[tool_result] → system/status → …(다음 어시스턴트 턴)…
→ result/success
```

---

## 2. `can_use_tool` 승인 왕복 — ★이 PoC의 핵심 계약

### 2.0 먼저 함정: `Bash(echo …)`로는 승인 요청이 **안 온다**

1차 시도는 `--permission-mode default` + `--permission-prompt-tool stdio`에서
`echo ONE` / `echo TWO`를 시켰는데 **`can_use_tool` asks: 0**, 툴은 그냥 실행됐다.
CLI의 커맨드 안전 분류기가 읽기 전용 셸 명령을 스스로 통과시킨다.

→ **`docs/protocol-claude-cli.md` §9-① 마지막 문단의 "`Bash(echo hi)`를 유도하는
1턴이면 can_use_tool을 볼 수 있다"는 틀렸다. 고쳤다.** 승인 게이트를 확실히 때리는
도구는 **`Write`**(또는 다른 MUTATING 도구)다.

### 2.1 실제 `can_use_tool` 프레임 (2.1.239, Write)

```jsonc
{"type":"control_request","request_id":"94add60e-f365-460d-98eb-06c4a71c2ce4",
 "request":{
   "subtype":"can_use_tool",
   "tool_name":"Write",
   "display_name":"Write",
   "description":"a.txt",
   "input":{"file_path":"C:\\…\\work\\a.txt","content":"AAA"},
   "permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]
 }}
```

- `request_id`는 **UUID** (SDK 쪽 `Math.random().toString(36)`와 다르다 — 발신자가
  고르는 값이라 무관).
- 스펙 §4.4a가 나열한 `title` / `decision_reason` / `decision_reason_type` /
  `classifier_approvable` / `matched_ask_rule` / `blocked_path` / `agent_id` /
  `suppress_always_allow_rule`은 **이 케이스에서 하나도 안 왔다.** 전부 선택 필드다
  → Rust 파서는 `tool_name` / `input` / `tool_use_id` 외 전부 `Option`이어야 한다.
- `requires_user_interaction`은 **Write에선 부재**, **AskUserQuestion에선 `true`** (§3).

### 2.2 `toolUseID`를 넣은 응답 — 정상

```jsonc
{"type":"control_response","response":{"subtype":"success",
 "request_id":"94add60e-…",
 "response":{"behavior":"allow",
             "updatedInput":{…원본 그대로…},
             "updatedPermissions":[{"type":"addRules","rules":[{"toolName":"Write"}],
                                    "behavior":"allow","destination":"session"}],
             "toolUseID":"toolu_017tKA54nkaHvJ1Roca4FHrq"}}}
```

→ 툴 실행, `user[tool_result]` 반환, 턴 계속. **`asks: 1` — 두 번째 `Write`는
승인 요청 없이 통과했다.** `updatedPermissions` `addRules` `destination:"session"`이
실제로 세션 스코프 규칙을 만들어 재질문을 멈춘다(= 2.6.2의 "항상 허용" 유효).
CLI 바이너리 쪽 대응 코드도 확인: `n.setSessionToolPermissionContext((S)=>Nle(S,b))`.

### 2.3 `toolUseID`를 **뺀** 응답 — 멈추지 않는다

```
<<< [2497ms] control_request/can_use_tool id=3d0faab8-… tool=Write tool_use_id=toolu_01WJRq…
--- (deliberately omitting toolUseID)
>>> {"response":{"request_id":"3d0faab8-…","response":{"behavior":"allow","updatedInput":{…}}}}
<<< [2508ms] user [tool_result(is_error=null) "File created successfully at: …\\noid.txt"]
<<< [3473ms] result/success is_error=false cost=0.0102595 turns=2 result="DONE"
--- can_use_tool asks: 1
--- stalled: false
```

**응답 11 ms 뒤에 tool_result가 왔다.** 라이브 턴에서 CLI는 `request_id`만으로
매칭하며 `toolUseID`는 보지 않는다.

### 2.4 그런데도 `toolUseID`는 **반드시 넣어야 한다** — 바이너리 근거

`claude.exe @310708475` (문자열 스캔으로 추출한 실코드):

```js
async function* P8f(e,t,r,n){                       // handleOrphanedPermission
  let {permissionResult:i, assistantMessage:s}=e, {toolUseID:a}=i;
  if(!a){ E("handleOrphanedPermission: dropping orphaned permission — permissionResult is missing toolUseID",
            {level:"warn"}); return }                                   // ★ 조용히 버린다
  … s.message.content 에서 y.type==="tool_use" && y.id===a 인 블록을 찾는다
  if(!c){ E(`… dropping orphaned permission for toolUseID=${a} — assistant message ${s.message.id}
             has no matching tool_use block`); return }
  … Ld(t,u,…) 로 활성 도구 조회, 없으면 또 drop
  if(i.behavior==="allow"){ let y=i.updatedInput;
    if(y&&Object.keys(y).length>0) p=y;
    else { p={}; E(`Orphaned permission for ${u}: updatedInput is missing or empty,
                    falling back to original tool input`,{level:"warn"}) }
    let _=i.updatedPermissions; if(Array.isArray(_)) try{
      let b=VVe(_,d,gn(n)); n.setSessionToolPermissionContext((S)=>Nle(S,b)); await jxe(b,n.storageV5)
    }catch(b){ E(`Orphaned permission for ${u}: malformed updatedPermissions ignored: ${b}`) } }
  …
}
```

그리고 같은 영역의 다른 진단 문자열:

```
Ignoring duplicate control_response for already-resolved toolUseID=…  request_id=…
Leaving control_response for request_id=… to the next process — this one is shutting down
  and settles no question
[structuredIO] dropped control_response with malformed response payload
```

### ★ 3.0 엔진 계약 (이 항목의 결론)

1. **라이브 매칭 키 = `request_id`.** 응답 봉투의 `request_id`는 요청을 정확히 에코할 것.
2. **`toolUseID`는 항상 넣는다.** 라이브에선 무시되지만
   (a) **고아/지연 재생 경로**(턴이 이미 끝났거나 프로세스가 교체된 뒤 도착한 승인
   응답)는 이 필드가 없으면 **경고 로그 한 줄 남기고 통째로 버린다** → 사용자가 누른
   허용이 증발한다. (b) CLI의 **중복 응답 방어가 `toolUseID`를 키로 삼는다**.
3. **`allow`면 `updatedInput`에 원본 입력을 그대로 되넣는다.** 비거나 없으면 고아
   경로에서 `{}`로 폴백된다(= 인자 없는 도구 호출).
4. **응답을 아예 안 보내면 그 턴은 영구 정지한다** (§2.5). 모든 `can_use_tool`은
   반드시 1회 응답하거나, 아니면 `interrupt`로 턴을 접어야 한다.
5. `updatedPermissions[].destination:"session"`은 유효 — "항상 허용"을 그대로 이식.

### 2.5 응답을 아예 안 보내면 — park deadline **없음** (실측)

```
./target/debug/poc_engine.exe park
```

```
<<< [2402ms] control_request/can_use_tool id=d70b5301-… tool=Write
!!! NOT answering this permission request — parking for 90s
<<< [parked 0s] stream_event message_delta
<<< [parked 0s] stream_event message_stop
<<< [parked 0s] rate_limit_event
--- frames during 90s park: 3        ← 진행 중이던 메시지의 꼬리 3개뿐, 이후 완전 무음
--- process alive while parked: true
```

90초 동안 아무 일도 일어나지 않는다. 타임아웃·재촉·에러 어느 것도 없다.
바이너리 스캔에서도 `can_use_tool`용 타임아웃 문자열은 0건이고, `park deadline`
문자열은 **`request_user_dialog`(다이얼로그)와 팀 teardown에만** 존재한다:

```
Ignoring late request_user_dialog answer for request_id=…: the park deadline already
  settled this dialog as cancelled …ms ago
```

→ **`sdk.d.ts:209-217`의 경고("승인 요청에는 park deadline이 없다")는 참.** 반면
`request_user_dialog`는 무응답 시 CLI가 알아서 `cancelled`로 정착시킨다(§4.4b의 설명과 일치).

### 2.6 멈춘 승인은 `interrupt`로 푼다 — ★CLI가 자기 요청을 철회한다

같은 park 런에서 90초 뒤 `interrupt`를 보냈다:

```
>>> {"type":"control_request","request_id":"int-1","request":{"subtype":"interrupt"}}
<<< control_cancel_request  {"type":"control_cancel_request","request_id":"d70b5301-…"}   ★
<<< control_response/success id=int-1  {"still_queued":[]}
<<< user [tool_result(is_error=true) "The user doesn't want to proceed with this tool use…"]
<<< user [text "[Request interrupted by user for tool use]"]
<<< result/error_during_execution is_error=true stop_reason="tool_use"
        terminal_reason="aborted_tools"
        errors:["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"]
        permission_denials:[{"tool_name":"Write","tool_use_id":"toolu_019twb…",
                             "tool_input":{"file_path":"…\\park.txt","content":"PARK"}}]
--- interrupt unwedged the parked permission: true
--- process alive: true
>>> 다음 턴 → result/success "AFTERPARK"
```

**`control_cancel_request`가 CLI → 앱 방향으로 온다.** 스펙 §4.1은 이걸 "요청 보낸
쪽이 철회"라고만 적어 뒀는데, 실제로 **떠 있는 `can_use_tool`을 CLI가 스스로 철회하는
경로가 존재**한다. Rust 엔진은 이걸 반드시 처리해야 한다 — 안 하면 사용자 화면에
**이미 죽은 승인 카드가 영원히 남는다**. (2.6.2는 SDK의 `handleControlCancelRequest`가
대신 해 주고 있었다.)

---

## 3. `AskUserQuestion` — `deny` + `message` 트릭은 **여전히 유효**

```
./target/debug/poc_engine.exe ask
```

요청 (Write와 필드 구성이 다르다 — `description`/`permission_suggestions` 없음,
대신 `requires_user_interaction`):

```jsonc
{"subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion",
 "requires_user_interaction":true,
 "tool_use_id":"toolu_013BR5WuuHKtuKoG14f9R66X",
 "input":{"questions":[{"header":"Language","multiSelect":false,
   "question":"Which language would you like to use?",
   "options":[{"label":"Rust","description":"A systems programming language…"},
              {"label":"Go","description":"A statically typed language…"}]}]}}
```

응답 = 2.6.2의 `formatAnswers` 문법 그대로:

```jsonc
{"behavior":"deny","message":"사용자가 질문에 다음과 같이 답했습니다: Rust",
 "toolUseID":"toolu_013BR5WuuHKtuKoG14f9R66X"}
```

결과:

```
<<< user [tool_result(is_error=true) "사용자가 질문에 다음과 같이 답했습니다: Rust"]
<<< assistant [text"CHOSEN=Rust"]
<<< result/success is_error=false result="CHOSEN=Rust"
```

`deny`의 `message`가 **그대로 `tool_result`(is_error=true)로 모델에 전달**되고 모델은
그것을 사용자의 답으로 읽고 이어 간다. `requires_user_interaction:true`가 붙어도
취급이 달라지지 않았다.

**엔진 노트**: `requires_user_interaction`은 "이건 모드 무관하게 사람에게 물어야 하는
호출"이라는 **CLI가 주는 힌트**다. 2.6.2는 `toolName === 'AskUserQuestion'` 문자열로
분기했는데, Rust는 `requires_user_interaction == true`를 1차 기준, 도구 이름을
폴백으로 두면 CLI가 나중에 다른 대화형 도구를 추가해도 자동으로 따라간다.

---

## 4. `interrupt` — 소프트 중단. 사망 루프는 재현되지 않았다

```
./target/debug/poc_engine.exe interrupt
```

`Count from 1 to 400` 턴을 시작하고 `text_delta` 3개를 본 직후 interrupt.

```
>>> INTERRUPT after 3 deltas
<<< [2142ms] control_response/success id=int-1  {"still_queued":[]}      (요청 후 ~960ms)
<<< [2142ms] assistant [text"1\n2\n3\n…\n23\n"]        ← 잘린 텍스트가 완성 프레임으로 온다
<<< [2149ms] user [text "[Request interrupted by user]"]
<<< [2150ms] result/error_during_execution is_error=true cost=0 turns=2 stop_reason=null
             terminal_reason="aborted_streaming"
--- process alive after interrupt: true
>>> turn 2 (same process) → result/success "SECOND"   ✅
>>> turn 3 (same process) → result/success "THIRD"    ✅
--- process alive after turn 3: true
>>> (stdin EOF) → exit 0
```

관측 사실:

- **프로세스는 산다.** 2·3턴 모두 같은 stdin에 `{"type":"user"}` 한 줄로 정상 동작.
  2.6.2가 겪은 "**중단 1회 → 매 턴 CLI 사망 루프**"는 **재현되지 않았다.**
  (그 사고의 실제 연료는 하드 `cancel()`이 남긴 고아 백그라운드 통지였고, 소프트
  interrupt 자체는 이번 CLI에서 깨끗하다. 백그라운드 작업이 살아 있는 상태의
  interrupt는 이번 PoC 범위 밖 — M3 회귀 하네스에서 재생 방식으로 볼 것.)
- **`system/init`이 턴마다 다시 온다. `session_id`는 그대로다.**
  (`208c5e32-…` × 3턴) → `optsMatch`의 `resume === bgSessionId` 비교는 안전하다.
  단 Rust는 "init이 왔다 = 새 세션"으로 착각하면 안 되고 **id 변화만** 봐야 한다.
- 중단된 턴의 종결은 **`result/error_during_execution`**, `stop_reason:null`,
  `terminal_reason:"aborted_streaming"` (도구 승인 중 중단이면 `"aborted_tools"`),
  `total_cost_usd: 0`.
- interrupt 접수(`control_response`)와 `result`가 **8 ms 차이**로 붙어서 왔다.
  2.6.2의 "접수 4초 / result 6초" 2단 레이스는 넉넉하다.
- `cancel_queued`를 안 보내도 응답에 `still_queued:[]`가 온다 —
  `interrupt_receipt_v1` 능력 광고와 일치.

**비용 회계 실측**: 같은 프로세스의 세 result의 `total_cost_usd`가
`0 → 0.0029343 → 0.0055936`. **턴을 가로질러 누적된다**(§5.6 JSDoc 경고가 참).
Rust는 **직전 result의 값을 빼서 델타로 가산**해야 한다 — 2.6.2처럼 매 턴
`addSpend(total_cost_usd)`를 하면 상주 다중 턴에서 중복 가산된다.

---

## 5. `resume` + `forkSession`

```
./target/debug/poc_engine.exe resume
```

| 런 | argv | session_id | 답 |
|---|---|---|---|
| 1 | (없음) | `621771c1-af74-…` (새로 생성) | `OK` (코드워드 BANANA47 심음) |
| 2 | `--resume=621771c1-…` | **`621771c1-…` 동일** | **`BANANA47`** ← 컨텍스트 승계 |
| 3 | `--resume=621771c1-… --fork-session` | **`3aef0f02-cfa4-…` 새 id** | **`BANANA47`** ← 포크도 승계 |

파일 시스템 (`<CLAUDE_CONFIG_DIR>/projects/C--Users-User-AppData-Local-Temp-ccg-poc-rs-work/`):

```
621771c1-af74-4663-b07f-5d326df48f78.jsonl   13,649 B   ← 원본. 보존됨(resume이 append)
3aef0f02-cfa4-4f74-a052-826ccbc0b4d6.jsonl   15,293 B   ← 포크. 전사 복사 + 새 턴
```

- `--resume=<id>`는 **`=` 형식**이 맞다(§2.1 #18 확인).
- resume은 **같은 파일에 이어 쓴다**(같은 id). fork는 **새 파일**을 만들고 원본을
  건드리지 않는다 → `/btw` 곁다리 질문이 본 대화를 오염시키지 않는다는 2.6.2의 전제 유효.
- `projects/`가 계정 폴더 → `~/.agentcodegui/shared/projects`로 향하는 정션이라
  계정을 바꿔도 전사가 이어진다(메모리의 per-chat-account-override 규약 그대로).

---

## 6. Job object — Windows 좀비 차단

```
bash scripts/poc-rs/job-test.sh --no-job   [--busy]
bash scripts/poc-rs/job-test.sh --with-job [--busy]
```

poc가 ① `claude.exe`(337 MB) ② `cmd.exe → ping.exe`(손자 사슬)을 띄우고,
외부 관측자가 트리를 찍은 뒤 poc가 **`taskkill /F /PID <자기자신>`**으로 앱 크래시를
흉내 낸다. `--busy`면 claude.exe가 **턴 스트리밍 중**일 때 죽인다.

| 실험 | claude.exe | cmd.exe | 손자 ping.exe |
|---|---|---|---|
| `--no-job` (CLI 유휴) | **dead** ※ | **ALIVE** | **ALIVE** |
| `--no-job --busy` (CLI 턴 중) | **ALIVE** (자기 자식까지 달고) | **ALIVE** | **ALIVE** |
| `--with-job` (CLI 유휴) | dead | dead | dead |
| `--with-job --busy` (CLI 턴 중) | **dead** | **dead** | **dead** |

※ 유휴 상태에서 claude.exe가 죽은 건 job 덕분이 아니다. **부모가 사라지면서 stdin
파이프 핸들이 닫혀 CLI가 EOF를 보고 스스로 정리 종료**한 것이다(§3.2의 endInput과 같은
경로). 그래서 **턴이 돌고 있으면 그 우아한 경로가 안 먹고 그대로 남는다** — 위 표의
2행이 그 증거다.

**결론**: `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` job은 유휴/바쁨을 가리지 않고
`claude.exe` + 손자를 **커널 보장으로** 거둔다. `job.rs`가 그 구현(30줄):
`CreateJobObjectW` → `SetInformationJobObject(JobObjectExtendedLimitInformation)` →
`AssignProcessToJobObject(child.raw_handle())`, **spawn 직후·첫 write 전**에 편입.
job 핸들을 앱 전역에 하나 두고 모든 엔진/LSP 자식을 넣는다.

> 잔존분은 실험 스크립트가 **PID 지정**으로만 정리한다(`taskkill /F /T /PID`).
> 이름 기반 kill(`/IM`)은 사용자 실앱을 죽이므로 절대 금지.

---

## 7. `docs/protocol-claude-cli.md` 수정 내역

| 위치 | 무엇을 | 왜 |
|---|---|---|
| §4.4a `toolUseID` 인용문 | "넣는 게 안전하다" → **라이브=`request_id` 매칭, 고아 재생=`toolUseID` 필수, 중복 방어 키** 3항 계약으로 교체 | 실측(§2.3)에서 라이브는 안 멈췄다. 그러나 바이너리의 `handleOrphanedPermission`이 없으면 **버린다** — 원래 서술은 "필수인지 선택인지 모름"이었고 이제 둘 다 참인 이유가 밝혀졌다 |
| §4.4a | **`control_cancel_request`(CLI→앱) 문단 신설** | interrupt 시 CLI가 떠 있는 `can_use_tool`을 스스로 철회하는 것을 실측. 원래 §4.1에 "요청 보낸 쪽이 철회"라고만 있어 앱이 받는 쪽이라는 게 안 드러났다 |
| §4.4a | can_use_tool 실측 페이로드가 **최소 집합**임을 명시 | 문서가 나열한 9개 선택 필드가 실제로는 하나도 안 왔다 → Rust 파서는 전부 Option |
| §4.4a | `requires_user_interaction`이 AskUserQuestion에만 `true`로 온다는 실측 + 분기 권고 | 스펙엔 필드만 있고 값이 언제 붙는지 없었다 |
| §5.6 | 중단 result 실물(`error_during_execution` / `terminal_reason` 2값 / `permission_denials` 형태) 추가 | 스펙에 `terminal_reason` 값 집합이 없었다 |
| §5.6 | `total_cost_usd` 턴 누적을 **실측 수치로** 확정 + Rust는 델타 가산 | JSDoc 경고였던 것을 3턴 연속 측정으로 확정(0 → 0.0029343 → 0.0055936) |
| §7.3 표 | 🔶(스키마만 확인)였던 `can_use_tool`/`interrupt`/`request_user_dialog` 행을 ✅ 또는 실측 결과로 갱신 | 이번 PoC가 라이브로 봤다 |
| §7.4 | **신설** — Rust 하네스 실측 요약표 | |
| §9-① | "미검증" → **닫힘**. 4개 미지수의 답을 각각 적고 findings로 링크 | |
| §9-① 마지막 문단 | `Bash(echo hi)`로 승인을 볼 수 있다 → **틀렸다. `Write`를 쓸 것** | 실측 asks=0 (커맨드 안전 분류기가 통과시킴) |
| §9-③ | "앱이 죽으면 337MB claude.exe가 그대로 남는다" → **유휴면 stdin EOF로 죽고, 턴 중이면 남는다. 손자는 언제나 남는다**로 정밀화 + 실측 표 | 대조 실험 4종의 결과가 원래 서술보다 구체적이다 |

---

## 8. 3.0 엔진 설계에 미치는 영향 (요약)

1. **컨트롤 RPC는 양방향 대칭으로 짠다.** CLI→앱 요청(`can_use_tool`,
   `request_user_dialog`, …)과 **CLI→앱 `control_cancel_request`**를 같은 레지스트리에서
   다룬다. 승인 대기는 `request_id → oneshot`으로 잡고, cancel 수신 시 그 대기자를
   "철회됨"으로 깨워 **카드를 화면에서 걷는다**.
2. **승인 응답 빌더는 한 곳으로 모으고 `toolUseID`/`updatedInput`을 강제한다**
   (타입으로. `PermissionResponse::allow(req)`가 두 필드를 자동으로 채우게).
   빼먹으면 라이브에선 아무 증상이 없다가 고아 경로에서만 조용히 터진다 —
   테스트로 못 잡는 종류의 버그다.
3. **무응답 = 영구 정지.** 승인 대기에는 타임아웃이 없으므로 엔진 쪽에
   (a) 런 종료 시 `perm-<run_id>-*` 대기자 전원 해제, (b) interrupt 시 대기자 먼저 해제,
   (c) 프로세스 종료 시 남은 대기자 해제 — 3중 안전망을 **처음부터** 넣는다.
4. **`requires_user_interaction`으로 분기**하면 AskUserQuestion 하드코딩을 줄인다.
5. **비용은 델타 가산**. `total_cost_usd`는 프로세스 누적이다.
6. **`system/init`은 턴마다 온다.** 세션 리셋 판정은 `session_id` **변화**로만.
7. **job object는 `ccg-engine` 최초 커밋에.** 유휴 CLI가 stdin EOF로 죽는 건 우연이고,
   위험한 케이스(턴 중 크래시·손자 프로세스)는 job 없이는 100% 잔존한다.
8. **프레이밍은 직접 짠다.** 13 KB짜리 initialize 응답이 첫 프레임부터 read 경계를
   넘는다. 상한(64 MiB) + 부분 라인 누적 + 파싱 실패 스킵 + stderr 별도 태스크.
