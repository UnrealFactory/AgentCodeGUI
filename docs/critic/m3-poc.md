# M3 PoC 크리틱 — 독립 재현 판정

**판정자**: 크리틱 에이전트(새 컨텍스트). 빌더의 `docs/m3-poc-findings.md` 결론을 **전제하지 않고**
`scripts/poc-rs/`를 직접 빌드·실행해 재현했다.
**일시**: 2026-08-22 13:29‥13:33 KST (UTC 04:29‥04:33) / 브랜치 `feature/3.0.0-beta`
**CLI**: `~/.agentcodegui/engines/0.3.239/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`
(337,672,352 B, 2.1.239) — 빌더가 쓴 것과 동일 바이너리
**계정**: 기본 계정(`lmg56634@gmail.com`, Claude Max, `apiKeySource=none`) — init 응답으로 실확인
**실행 비용**: 라이브 유저 턴 7회(haiku + `--thinking disabled`), 합계 **≈ $0.03**.
0원 검증 2회(빈 `CLAUDE_CONFIG_DIR`). 잔존 프로세스는 **PID 지정**으로만 정리(`taskkill /F /T /PID`).

## 총평

| 항목 | 빌더 주장 | 크리틱 판정 |
|---|---|---|
| (2) `can_use_tool` — `toolUseID` 유무별 반응 | 라이브는 `request_id`만으로 매칭, 그래도 고아 경로 때문에 항상 넣어야 함 | **CONFIRMED** (라이브 = 내가 재현, 더 강한 조건으로. 고아 경로 = **정적 근거만** — 라이브 재현 아님) |
| (4) `interrupt` 후 프로세스 생존 + 후속 턴 | 턴만 죽고 프로세스는 산다, 2·3턴 정상, 사망 루프 재현 안 됨 | **CONFIRMED** (단 **범위 한정** — 아래 참조) |
| (6) job object 좀비 차단(대조 포함) | 4행 대조표 | **CONFIRMED — 4행 전부 그대로 재현** |

**refuted 없음.** 다만 (a) 빌더의 §6 대조표에는 **관측 로그가 하나도 보존돼 있지 않았고**
(`%TEMP%\ccg-poc-rs\job-*.log`는 poc 자신의 출력만 담고, 트리 관측은 드라이버 stdout으로 흘려버렸다),
(b) 빌더의 `approve-noid` 실험은 **교란변수를 배제하지 못한 설계**였다(§2 참조).
둘 다 이번에 고쳐서 재실행했고 결론은 바뀌지 않았다.

---

## 1. 재현 절차

```bash
cd C:/Code/AgentCodeGUI/scripts/poc-rs
cargo build                                  # cargo 1.96.1, 빈 [workspace] — 루트 무영향

# (6) job object — 0원 2회 + 라이브(턴 중) 2회
bash job-test.sh --no-job                    # 0원 (빈 CLAUDE_CONFIG_DIR)
bash job-test.sh --with-job                  # 0원
bash job-test.sh --no-job   --busy           # LIVE — 턴 스트리밍 중 부모 강제 종료
bash job-test.sh --with-job --busy           # LIVE

# (2) can_use_tool
./target/debug/poc_engine.exe approve-noid   # LIVE — toolUseID 제거(+ 크리틱 수정)
./target/debug/poc_engine.exe approve        # LIVE — toolUseID 포함 (양성 대조)

# (4) interrupt
./target/debug/poc_engine.exe interrupt      # LIVE — 3턴

# 정적 근거 (0원)
rg -a -o "[ -~]{0,200}missing toolUseID[ -~]{0,80}" <claude.exe>
```

### 크리틱이 하네스에 가한 수정 (`scripts/poc-rs/src/main.rs`, 커밋 안 함)

1. **`updatedPermissions`를 `with_id` 경로에서만 붙이도록 변경.**
   원본은 `asks == 1`이면 `with_id` 여부와 무관하게 `addRules(Write, destination:"session")`를
   실었다 → "noid 응답에도 툴이 진행된 건 세션 규칙이 생겨서지 `request_id` 매칭 때문이 아니다"라는
   **대안 설명을 배제하지 못했다.** 수정 후 noid 응답은 `{"behavior":"allow","updatedInput":{…}}`
   **두 필드뿐**이다.
2. `answered_at` 계측 추가 — 승인 응답 송신 → 다음 프레임까지의 실지연(ms)을 직접 찍는다.
   (빌더의 "11 ms"는 절대 타임스탬프 두 개의 뺄셈이었다.)

---

## 2. (2) `can_use_tool` — `toolUseID` 유무별 반응 → **CONFIRMED**

### 2.1 `toolUseID` **없이** (크리틱 수정판: `updatedPermissions`도 없음)

```
<<< [ 2277ms] control_request/can_use_tool id=38363360-b82d-474e-8254-fabf9051b1bd
              tool=Write tool_use_id=toolu_012xL8ZqCUy9URcbNX332WyH requires_user_interaction=null
--- can_use_tool payload keys: ["description","display_name","input",
                                "permission_suggestions","subtype","tool_name","tool_use_id"]
--- (deliberately omitting toolUseID)
>>> {"response":{"request_id":"38363360-…","response":{
      "behavior":"allow","updatedInput":{"content":"NOID","file_path":"…\\work\\noid.txt"}},
      "subtype":"success"},"type":"control_response"}
<<< [ 2278ms] stream_event message_delta
--- [critic] first frame after permission response: +0 ms  (stream_event message_delta)
<<< [ 2289ms] user [tool_result(is_error=null) "File created successfully at: …\\work\\noid.txt"]
<<< [ 2983ms] result/success is_error=false cost=0.0060362 turns=2 stop="end_turn" result="DONE"
--- can_use_tool asks: 1
--- stalled: false  recovered_after_retry: false
--- framing: read()=45 bytes=30720 frames=44 spanning_reads=1 max_line=13773 parse_err=0
```

→ **라이브 매칭 키 = `request_id`뿐이다.** 응답 **+11 ms**(2278→2289)에 `tool_result`,
파일 실제 생성, 턴 정상 종료. `updatedPermissions`까지 뺀 최소 응답에서도 동일 → 빌더 결론이
**더 엄격한 조건에서도 성립**한다.

### 2.2 `toolUseID` **포함** (양성 대조)

```
<<< [ 2279ms] control_request/can_use_tool id=be1a2769-… tool=Write tool_use_id=toolu_01Au7vm1…
<<< [ 2289ms] user [tool_result … a.txt]
--- [critic] first frame after permission response: +10 ms
<<< [ 3670ms] assistant [tool_use(Write)]          ← 두 번째 Write
<<< [ 3680ms] user [tool_result … b.txt]           ← 승인 요청 없이 통과
<<< [ 4367ms] result/success is_error=false cost=0.0094757 turns=3 result="DONE"
--- can_use_tool asks: 1
```

→ `updatedPermissions:[{type:"addRules",rules:[{toolName:"Write"}],behavior:"allow",
destination:"session"}]`가 **실제로 세션 스코프 규칙을 만들어 재질문을 멈춘다**(asks=1, Write 2회).
2.6.2의 "항상 허용" 이식 가능 — **CONFIRMED**.

### 2.3 `can_use_tool` 페이로드가 최소 집합이라는 주장 → **CONFIRMED**

두 런 모두 키가 **정확히 7개**: `description, display_name, input, permission_suggestions,
subtype, tool_name, tool_use_id`.
`title`/`decision_reason`/`decision_reason_type`/`classifier_approvable`/`matched_ask_rule`/
`blocked_path`/`agent_id`/`suppress_always_allow_rule`은 **0건**.
`requires_user_interaction`은 Write에서 **null(부재)**.
→ Rust 파서는 `tool_name`/`input`/`tool_use_id` 외 전부 `Option`이어야 한다는 결론 유효.

### 2.4 "고아 재생 경로에서 `toolUseID` 필수" → **정적 근거만. 라이브 재현 아님**

빌더는 이 부분을 라이브로 보지 않았고 바이너리 문자열만 인용했다. 인용의 **정확성은 내가 검증했다** —
`claude.exe`에 아래가 **문자 그대로** 존재한다:

```js
async function*P8f(e,t,r,n){let o=!vre(),{permissionResult:i,assistantMessage:s}=e,{toolUseID:a}=i;
  if(!a){E("handleOrphanedPermission: dropping orphaned permission — permissionResult is missing toolUseID",
           {level:"warn"});return}
  let l=s.message.content,c;if(Array.isArray(l)){for(let …
```

중복 방어가 `toolUseID`를 키로 삼는다는 주장도 **실코드로 확인**:

```js
l==="string"&&this.resolvedToolUseIds.has(l)){
  E(`Ignoring duplicate control_response for already-resolved toolUseID=${l} request_id=${t.response.request_id}`);
  return}
```

그 외 확인된 문자열: `handleOrphanedPermissionResponse: dropping orphaned permission for toolUseID=`,
`team teardown park deadline`, `: the park deadline already settled this dialog as cancelled`
(= park deadline은 **다이얼로그/팀 teardown 전용**이라는 §2.5 서술과 일치).

> **판정**: 인용 정확 · 결론 타당. 그러나 이건 **코드 독해**지 실행 관측이 아니다.
> "toolUseID 없으면 고아 승인이 버려진다"를 **실제로 발동시킨 런은 존재하지 않는다**
> (턴 종료 후 지연 도착·프로세스 교체 상황을 만들지 않았다). 엔진 계약으로 채택하는 데는 충분하지만,
> **"실측으로 확정"이라고 쓰면 과장**이다.

---

## 3. (4) `interrupt` 후 프로세스 생존 및 후속 턴 → **CONFIRMED (범위 한정)**

```
>>> INTERRUPT after 3 deltas
<<< [ 1800ms] control_response/success id=int-1 {"still_queued":[]}
<<< [ 1808ms] user [text "[Request interrupted by user]"]
<<< [ 1809ms] result/error_during_execution is_error=true cost=0 turns=2 stop=null
--- process alive after interrupt: true
>>> turn 2 on the SAME process
<<< [ 2314ms] system/init session=42a1612f-05c7-43cb-b5d2-1fdf72d631b9 …
<<< [ 3019ms] result/success is_error=false cost=0.0028623 turns=1 result="SECOND"
--- turn 2 completed ok: true    --- process alive after turn 2: true
>>> turn 3 on the SAME process
<<< [ 3021ms] system/init session=42a1612f-05c7-43cb-b5d2-1fdf72d631b9 …
<<< [ 3719ms] result/success is_error=false cost=0.005518 turns=1 result="THIRD"
--- turn 3 completed ok: true    --- process alive after turn 3: true
--- exit after stdin EOF: Ok(Ok(ExitStatus(ExitStatus(0))))
```

원본 프레임(`%TEMP%\ccg-poc-rs\interrupt.jsonl`, 이번 런이 덮어씀) 정밀 확인:

```
assistant text="1\n2\n3\n…\n20" len=149              ← 잘린 텍스트가 완성 프레임으로 온다
result/error_during_execution is_error=true stop_reason=null terminal_reason=aborted_streaming turns=2 cost=0
result/success is_error=false stop_reason=end_turn  terminal_reason=completed turns=1 cost=0.0028623
result/success is_error=false stop_reason=end_turn  terminal_reason=completed turns=1 cost=0.005518
```

동시에 재현된 부수 주장:

- **`terminal_reason="aborted_streaming"`** — 빌더 값 일치.
- **`system/init`이 턴마다 다시 오고 `session_id`는 불변**(`42a1612f-…` × 3) — 일치.
  → "init 도착 = 새 세션" 판정은 금지, **id 변화만** 볼 것.
- **`total_cost_usd`는 프로세스 누적** — `0 → 0.0028623 → 0.005518`. 델타 가산 필요. 일치.
- `cancel_queued` 없이도 `still_queued:[]`가 온다(`interrupt_receipt_v1`). 일치.
- 접수(`control_response`)와 `result`가 **9 ms 차**(1800→1809). 일치.

### ★ 범위 한정 — 이 결과가 **덮지 못하는 것**

"2.6.2의 **중단 1회 → 매 턴 CLI 사망 루프**가 재현 안 됨"은 참이지만,
**그 사고의 실제 연료(백그라운드 작업 잔존 + 고아 통지 재주입)를 이 PoC는 만들지 않았다.**
백그라운드 셸/에이전트가 살아 있는 상태의 interrupt는 **한 번도 시험되지 않았다.**
→ `docs/ARCHITECTURE-3.0.md` **M3 위험 #2(상주 회계 순서 의존성)는 이 PoC로 조금도 해소되지 않았다.**
빌더 문서도 이를 명시(§4 괄호)하므로 과장은 아니나, **6줄 결론표의 ✅가 위험 #2까지 덮는 것처럼
읽히지 않도록** 읽는 쪽이 주의해야 한다.

부가로 `park.jsonl`(빌더 아티팩트, mtime 04:17Z — 내 런보다 15분 앞)에는 §2.6이 주장한
**CLI→앱 `control_cancel_request`가 실제 프레임으로 남아 있다**(같은 `request_id`
`d70b5301-…`, 뒤이어 `result/error_during_execution terminal_reason=aborted_tools` +
`permission_denials[{tool_name:"Write",…}]`). 내 3항목 밖이라 **재실행하지는 않았으나,
"실행했다고만 하고 로그가 없는" 부류는 아니다.**

---

## 4. (6) job object 좀비 차단 → **CONFIRMED (4행 전부)**

빌더 표에는 관측 로그가 보존돼 있지 않아 **4개 조합을 전부 새로 돌렸다.**
poc가 ① `claude.exe` ② `cmd.exe → ping.exe`(손자)를 띄우고, 외부 드라이버가 트리를 찍은 뒤
poc가 **자기 PID로 `taskkill /F`** 해 앱 크래시를 흉내 낸다.

| 실험 | claude.exe | cmd.exe | 손자 ping.exe | 판정 |
|---|---|---|---|---|
| `--no-job` (유휴, 0원) | **dead** | **ALIVE** | **ALIVE** | 재현 |
| `--no-job --busy` (턴 중, LIVE) | **ALIVE** | **ALIVE** | **ALIVE** | 재현 |
| `--with-job` (유휴, 0원) | dead | dead | dead | 재현 |
| `--with-job --busy` (턴 중, LIVE) | **dead** | **dead** | **dead** | 재현 |

관측 원문(발췌):

```
### bash job-test.sh --no-job          (0원)
pids: {"claude":23704,"cmd":10024,"mode":"no-job","self":24184}
=== AFTER  taskkill /F /PID 24184 ===
  claude.exe 23704 : dead     cmd.exe 10024 : ALIVE     grandchild 26524 : ALIVE
RESULT(--no-job): ZOMBIES LEFT → cleaning up by PID

### bash job-test.sh --no-job --busy   (LIVE, "turn is streaming; killing the parent mid-turn")
pids: {"claude":24992,"cmd":5280,"mode":"no-job","self":33616}
=== AFTER  taskkill /F /PID 33616 ===
  claude.exe 24992 : ALIVE    cmd.exe 5280 : ALIVE      grandchild 6932 : ALIVE
RESULT(--no-job): ZOMBIES LEFT → cleaning up by PID
   (정리 로그가 claude.exe의 자식 PID 5480까지 함께 거둔 것을 보여준다 = "자기 자식까지 달고 잔존")

### bash job-test.sh --with-job        (0원)
=== AFTER  taskkill /F /PID 31464 ===
  claude.exe 31000 : dead     cmd.exe 25812 : dead      grandchild 18940 : dead
RESULT(--with-job): all children reaped

### bash job-test.sh --with-job --busy (LIVE, 턴 스트리밍 중)
=== AFTER  taskkill /F /PID 29024 ===
  claude.exe 31648 : dead     cmd.exe 4188 : dead       grandchild 28200 : dead
RESULT(--with-job): all children reaped
```

→ **`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`는 유휴/바쁨 무관하게 `claude.exe`와 손자까지
커널 보장으로 거둔다.** 그리고 **job 없으면 "턴 중 크래시"에서 337 MB가 100% 잔존**한다.
유휴에서 claude.exe가 죽는 건 job 덕이 아니라 **stdin 파이프 EOF로 스스로 정리 종료**하는
우연이라는 빌더의 각주도 대조로 확인됐다(유휴=dead / 턴 중=ALIVE의 차이가 그 증거).

**정리 확인**: 실행 후 남은 `claude.exe`는 2개뿐이고 둘 다 **PPID 24836(사용자 실앱)**,
생성 시각이 내 런보다 앞선다(08-21 18:27, 08-22 12:23). `poc_engine.exe` 잔존 0.
이름 기반 kill은 한 번도 쓰지 않았다.

---

## 5. 빌더 문서에 대한 추가 지적 (결론을 뒤집지는 않음)

1. **§6의 증거 부재.** 대조표 4행은 이번 크리틱 전까지 **어떤 보존 로그로도 뒷받침되지 않았다.**
   `job-*.log`에는 poc 자신의 출력만 있고, 정작 판정 근거인 프로세스 트리는
   드라이버 stdout으로 흘러 사라졌다. → `job-test.sh`가 BEFORE/AFTER 트리도 파일로 남기게 할 것.
2. **`approve-noid` 실험 설계 결함**(§2.1의 1번 수정). 교란변수(`updatedPermissions`)를
   같이 실어 보내 놓고 "toolUseID를 빼도 진행됐다"고 결론냈다. 결론 자체는 수정 후에도 유지되지만,
   **원본 설계로는 그 결론이 서지 않았다.**
3. **`wire.rs`의 `MAX_LINE`은 메모리 상한으로 동작하지 않는다.**
   `txt.len() > MAX_LINE` 검사가 **줄을 통째로 `buf`에 모은 뒤**에 일어난다
   (`wire.rs` 250‥271). 즉 64 MiB 상한은 "이미 다 읽은 뒤 버리기"라 §3.1이 요구한 방어가 아니다.
   `oversized_dropped` 카운터는 사실상 도달 불가. → `ccg-engine`은 **누적 중에**
   `buf.len() > MAX_LINE`을 보고 "개행까지 폐기" 상태로 전이해야 한다. (PoC 결론에는 무영향.)
4. **`env` 대체 의미론 미검증.** 스펙 §2.4는 `.env_clear().envs(&env)`를 지시하는데
   하네스는 상속+덮어쓰기다(`wire.rs` 169‥182, 주석에 명시). 2.6.2와 같은 방식이라 라이브 결과는
   유효하지만 **스펙 코드조각 그대로는 한 번도 돌지 않았다.**
5. **M3 위험 #3의 후반부(`CLAUDE_SECURESTORAGE_CONFIG_DIR`)는 findings가 아예 다루지 않는다.**
   내 런 동안 전역 `~/.claude/.credentials.json`은 **수정되지 않았다**(mtime 08-20 17:14 불변,
   런은 08-22 13:29‥13:33) → 계정 격리가 샌 흔적은 없다. 다만 **토큰 리프레시가 발동하지 않은
   런**이라 "쓰기 경로가 안전하다"는 증명은 아니다. 만료 임박 토큰으로 별도 확인 필요.

---

## 6. 최종 판정

- **(2)(4)(6) 세 항목 모두 독립 재현 성공. refuted 없음.**
- 단 (2)의 "고아 경로 필수"는 **정적 근거**, (4)는 **백그라운드 작업 없는 조건**에 한정된다.
- M3 Rust 구현 착수 게이트로서 **통과**로 본다.
