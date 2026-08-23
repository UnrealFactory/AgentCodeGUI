# M9 R1 — 멀티채팅 기준 MCP·Skill 전용 뷰

라운드 R20 · 2026-08-23 · 브랜치 `feature/3.0.0-beta`

2.6.2에서 "이 대화에 어떤 MCP 서버가 붙어 있나 / 어떤 스킬을 쓸 수 있나"를 묻는 자리는
**설정 화면 한 곳**뿐이었다(`src/main/mcp.ts`·`skills.ts`가 `~/.claude.json`과
`.claude/skills`를 디스크에서 스캔한다). 그건 "설정 파일에 뭐가 적혀 있나"이지 "지금 이
대화에 뭐가 붙어 있나"가 아니다 — 연결 실패도, 승인 안 된 `.mcp.json`도, 플러그인이 들고
온 스킬도 파일만 봐서는 모른다. 멀티 그리드는 **패널마다 작업 폴더가 다르므로 목록도
다른데**, 그 차이를 물을 자리가 아예 없었다.

이 라운드가 그 자리를 만들었다. 값은 디스크가 아니라 **와이어**에서 온다.

자기 채점은 하지 않는다 — 무엇을 실측했고, 무엇을 만들었고, 무엇이 아직 없는지의 기록이다.

---

## 0. 한 문단 요약

패널 헤더에 도구 환경 칩이 생겼고, 그 값은 `system/init`이 실어 오는 것을 셸이 커맨드
사전과 조인해 만든 `EngineEvent{type:'tooling'}` 하나다. 실물 앱에서 **서로 다른 폴더를 보는
2패널**에 각각 stdio MCP 스텁 픽스처를 물리고 1턴씩 태웠더니, 패널1은 `1 · 15`(서버 1 ·
스킬 15), 패널2는 `1/2 · 16`(붙은 1 / 전체 2 · 실패 1 · 스킬 16)을 그렸고 팝오버 내용이
**한 항목도 겹치지 않았다**. 죽은 서버는 「연결 실패」 행으로 남고, 붙은 서버는 자기 도구
이름(`echo, ping`)까지 적는다. 직전 세션이 코드에 "실측"이라고 적어 둔 주장 중 **근거가
하네스에 없던 것 하나**(끄면 행이 사라지는가)를 C 픽스처로 실제로 재고, **거짓이던 주석
하나**(설명 한 줄 자르기)를 코드로 만들었으며, **렌더러 타입체크를 깨뜨리던 미완성 한
군데**(소진 가드)를 닫았다. 2턴 계측에서 매 턴 낡은 목록이 한 번씩 스치던 것도 잡았다
(패널A 3회 → 2회 = `system/init` 수와 일치). 아직 없는 것: 패널에서 켜고 끄기(설정의
`mcp:list`·`mcp:set-enabled` 채널이 3.0 셸에 **미구현**), 그리고 상주 판의
`commands_changed` 경로(앱까지는 도달 못 함, §6).

---

## 1. 와이어 실측 — 무엇이 실려 오는가

하네스: `scripts/poc-mcpskill.mjs`. `%TEMP%\ccg-mcpskill`에 픽스처를 만들고 실
`claude.exe`(엔진 0.3.241)를 **각각 다른 cwd**로 띄운다. MCP 서버는 스크립트가 같이 낳는
stdio 스텁(JSON-RPC 2.0 줄단위)이라 네트워크도 외부 설치도 없다. 실홈은 읽기만 한다.

| 픽스처 | cwd | `.mcp.json` | `.claude/skills` | 정책 |
|---|---|---|---|---|
| A | `…\ccg-mcpskill\A` | `ccg-probe-a`(정상) | `alpha-probe` | — |
| B | `…\ccg-mcpskill\B` | `ccg-probe-b`(정상) · `ccg-broken-b`(없는 파일) | `beta-probe` · `beta-second` | — |
| C | **B와 같은 폴더** | 같음 | 같음 | `deniedMcpServers:[{serverName:'ccg-probe-b'}]` · `skillOverrides:{'beta-probe':'off'}` |

개인(user) 스코프 스킬 `gamma-personal`은 무인증 설정 폴더(`CLAUDE_CONFIG_DIR`)에 **씨앗으로
심는다**. R20 진입 시점의 하네스는 이 씨앗을 심지 않으면서 `(user)` 근거를 그 폴더에 남아
있던 **찌꺼기**에서 얻고 있었다(새 기계에서는 사라지는 근거였다 — §5-①).

### 1.1 `system/init` — 이 스폰의 도구 환경

```
init.mcp_servers  (A): [{"name":"ccg-probe-a","status":"connected"}]
init.mcp_servers  (B): [{"name":"ccg-probe-b","status":"connected"},
                        {"name":"ccg-broken-b","status":"failed"}]
init.skills       (B): ["gamma-personal","beta-probe","beta-second","deep-research",
                        "dataviz","update-config","verify","debug","code-review",
                        "simplify","batch","fewer-permission-prompts","doctor","loop",
                        "claude-api","run","run-skill-generator"]      ← 문자열 배열
init.tools        (B): [… ,"mcp__ccg-probe-b__echo","mcp__ccg-probe-b__ping", …]
init.plugins         : []
init.cwd          (B): C:\Users\User\AppData\Local\Temp\ccg-mcpskill\B
```

셸이 쓰는 필드 목록과 그 성질:

| 필드 | 모양 | 이 기능이 쓰는 이유 |
|---|---|---|
| `cwd` | 문자열 | 스냅샷의 주인 — 폴더를 바꾼 직후의 낡은 목록을 화면이 버리는 근거 |
| `mcp_servers[]` | `{name, status}` **딱 둘** | 실측 status = `connected` · `failed`. 열린 집합으로 다룬다 |
| `tools[]` | `mcp__<정규화 서버>__<도구>` | **서버별 도구 수·이름의 유일한 무왕복 출처** |
| `skills[]` | **문자열 배열** | 이름뿐 — 설명도 스코프도 없다. 순서는 개인·프로젝트가 앞, 내장이 뒤 |
| `plugins[]` | `{name, path, version}` | 팝오버 꼬리 한 줄 (이 주행에선 빈 배열) |

`slash_commands[]`도 같은 프레임에 오지만(41개) **이름뿐**이라 안 쓴다. 스킬이 아닌
내장 명령까지 섞여 있어 스킬 목록의 기준이 될 수 없다.

### 1.2 설명은 어디서 오나 — 커맨드 사전 두 입

`init.skills`가 이름뿐이므로 설명은 다른 데서 온다. 출처는 둘이고 **둘 다 REPLACE**다.

```
① control_response(initialize).response.response.commands[]   ← 스폰당 1회
   { "name":"beta-probe", "description":"B 픽스처 전용 스킬 — A에는 없다 (project)",
     "argumentHint":"" }                                        (B에서 41개)
② system/commands_changed .commands[]                          ← result 뒤 1장 (41개)
```

**순서가 못 박혔다**: ①은 `system/init`보다 **먼저** 온다(3판 전부 `initFirst=true`).
그래서 셸은 사전을 먼저 채우고 init에서 조인한다.

설명 꼬리의 스코프 표식도 실측이다 — `(project)` · `(user)` 둘 다 확인. 같은 자리에
**스코프가 아닌 꼬리**도 온다(`deep-research` = `… (dynamic workflow)`). 그래서 셸의
`split_scope`는 **닫힌 집합**(`user`·`project`·`local`·`plugin`)만 떼어낸다.

### 1.3 ★끈 것은 어떤 얼굴로 오는가 (C 픽스처)

R20 진입 시점의 `wire.rs`에는 "`deniedMcpServers`를 실으면 행째 사라진다(실측)"이라고
적혀 있었지만 **하네스에 그 실측이 없었다.** C 픽스처로 실제로 쟀다:

```
C.init.mcp_servers : [{"name":"ccg-broken-b","status":"failed"}]      ← ccg-probe-b 소멸
C.init.skills      : ["gamma-personal","beta-second", …]              ← beta-probe 소멸
C.init.tools       : mcp__ 접두사 0개                                  ← 끈 서버의 도구도 소멸
C의 커맨드 사전에 남은 beta-probe: null                                ← 설명도 함께 소멸
```

주장은 참이었다. 덧붙여 알게 된 것 둘:
* 끈 서버의 **도구도** `init.tools`에서 사라진다(도구 수로 역추적할 수 없다).
* 끈 스킬은 **커맨드 사전에서도 빠진다** → 되붙인 off 행에는 설명이 없다. 화면은
  「설정에서 껐어요」만 적는다(지어내지 않는다).
* 안 끈 항목(`ccg-broken-b`·`beta-second`)은 그대로 남는다 — 정책이 목록을 통째로
  비우는 것이 아니다.

즉 와이어만 보면 **"내가 껐다"와 "설정에 아예 없다"가 같은 얼굴**이다. 셸이 자기 정책
(`identity().tools()`)으로 그 행을 `status:"off"` / `off:true`로 되붙인다.

### 1.4 안 쓰기로 한 길 — `mcp_status` · `reload_skills`

턴 밖 재조회 컨트롤 왕복은 **둘 다 살아 있다**(응답 확인). 그리고 `init`보다 정보가 많다:

```
mcp_status.mcpServers[] : {name, status, serverInfo{name,version}, config{type,command,args},
                           scope:"project", tools:[{name,annotations}],
                           error:"MCP error -32000: Connection closed"}
reload_skills.skills[]  : {name, description, argumentHint}
```

**그래도 안 쓴다.** 이유는 셋이다. (a) 왕복마다 CLI가 서버를 다시 물어 비용이 든다.
(b) 살아 있는 CLI가 있어야만 물을 수 있어서, 턴이 끝나 CLI가 죽은 패널은 답이 없다 —
그런데 화면은 그때도 목록을 보여줘야 한다. (c) `init`+커맨드 사전 조인으로 이미 이름·
상태·도구·설명·스코프가 전부 나온다. 남는 것은 실패 사유 문자열(`error`)과 `config`인데,
그 둘이 필요해지면 그때 왕복을 붙이면 된다(§7).

---

## 2. 무엇을 세웠나

| 파일 | 역할 |
|---|---|
| `src-tauri/src/engine/wire.rs` (+407) | `system/init`·커맨드 사전 조인 → `tooling` 이벤트 · 끈 항목 되붙이기 · 단위 테스트 6 |
| `src-tauri/src/engine/hub.rs` (+19) | 이 채팅의 도구 정책(P1e `tools` 축)을 옮김기에 전달 (**바뀔 때만**) |
| `src/shared/protocol.ts` (+45) | `EngineEvent{type:'tooling'}` · `ChatTooling`/`McpLive`/`SkillLive` |
| `app/src/components/McpSkillView.tsx` (신설 262줄) | 헤더 칩 + 팝오버 |
| `app/src/components/MultiAgent.tsx` (+11) | 칩 부착 · `panelId` prop |
| `app/src/components/PanelWindow.tsx` (+2) | 팝아웃 창에도 같은 구독 주소 |
| `app/src/store/session.ts` (+12) | `tooling`은 **일부러 상태에 안 담는다**(소진 가드에 명시) |
| `scripts/poc-mcpskill.mjs` | 와이어 실측(A·B·C) + `--app` 실물 주행 |

### 2.1 데이터 경로

```
claude.exe ──frames──▶ Wire::translate
                        ├ control_response(initialize).commands[]  → cmd_desc  (사전, REPLACE)
                        ├ system/commands_changed.commands[]       → cmd_desc  (사전, REPLACE)
                        └ system/init                              → env       (원재료, REPLACE)
                                                                     └▶ tooling 이벤트
Hub::pump ── identity().tools() ──▶ Wire::set_policy (바뀔 때만 true) ─▶ tooling 이벤트
Hub::fanout ─▶ chat:event · engine:event · session:event · ma:event{panelId}
                                                              └▶ McpSkillView (직접 구독)
```

**화면은 세션 스토어를 안 거친다.** 도구 환경은 대화 내용이 아니라 실행 환경이고, 세션
스냅샷은 디스크에 절여져 재시작 때 되살아난다 — 담으면 "지난주에 붙어 있던 MCP 서버"가
새 창에서 붙어 있는 척한다. 리듀서에는 `case 'tooling': return state`를 **명시**했다
(소진 가드가 `never`라 조용히 흘릴 수 없고, 흘릴 수 있어도 흘리면 안 된다).

### 2.2 화면 문법 — 새 CSS 0줄

칩 = `.ma-p-folder`(작업 폴더 칩과 같은 면) · 래퍼 = `.hfold` · 카드 = `.wb-pop.hpop.r`
(WorkBar 유리 팝오버의 하향 변형) · 섹션 = `.hsec` · 행 = `.wb-prow`(+`.done`/`.err`) ·
빈 상태 = `.ag-none`. 전부 이미 있던 규칙이다.

칩은 폴더 칩 **왼쪽**에 둔다 — 목록이 폴더에서 오므로 읽는 순서가
「무엇이 붙어 있나 ← 어느 폴더인가」여야 인과가 맞는다.

두 팝오버(도구 환경·작업 폴더)는 각자 `.hfold` 안에 있고 바깥 mousedown으로 닫히므로
**동시에 열리지 않는다**(서로의 칩 클릭이 상대에겐 바깥 클릭이다).

---

## 3. 실물 주행 — `poc-mcpskill.mjs --app`

격리 `CCG_HOME`(`.poc-home-mcpskill`) · 엔진은 실홈 정션 · 계정은 자격증명만 복사 ·
사용자 실앱은 건드리지 않는다(죽이는 것은 이 스크립트가 spawn한 PID 트리뿐). 보드는 앱
자신의 IPC(`multi.saveState`)로 심고 리로드한다 — 하네스가 디스크 포맷을 알 필요가 없다.

**헤더 칩 (실 DOM)**

| 패널 | 칩 | 툴팁 |
|---|---|---|
| 1 (폴더 A) | `1 · 15` | `MCP 1개 연결 · 스킬 15개 · 클릭해 자세히` |
| 2 (폴더 B) | `1/2 · 16` | `MCP 1개 연결 · 1개 실패 · 스킬 16개 · 클릭해 자세히` |

실패가 있으면 분모를 드러낸다(`1/2`) — 실패는 숫자 하나로 가려지면 안 되는 사실이다.
숫자는 빨강(`--red`)으로 물든다.

**팝오버 (실 DOM · 발췌)**

```
패널1  「도구 환경 · A」
  MCP 서버 1
    ccg-probe-a · 연결됨 · echo, ping        [도구 2]
  스킬 15
    /alpha-probe   · A 픽스처 전용 스킬 — B에는 없다      [프로젝트]
    /deep-research · Deep research harness — fan-out web searches, … (dynamic workflow)
    /dataviz       · Use this skill whenever you are about to create ANY chart, …
    … 12개 더

패널2  「도구 환경 · B」
  MCP 서버 2
    ccg-probe-b   · 연결됨 · echo, ping      [도구 2]
    ccg-broken-b  · 연결 실패
  스킬 16
    /beta-probe    · B 픽스처 전용 스킬 — A에는 없다      [프로젝트]
    /beta-second   · B에만 있는 두 번째 스킬              [프로젝트]
    … 14개 더
```

단언 11건 전부 통과. 그중 이 기능의 존재 이유인 것들:

* `패널1에 B의 서버·스킬이 **없다**` / `패널2에 A의 것이 **없다**` — `ma:event`의
  panelId 봉투가 새지 않는다. (새도 눈으로는 "둘 다 잘 나온다"로 보인다.)
* `두 패널의 목록이 서로 다르다` — 팝오버 JSON 전체 비교.
* `패널2에 죽은 서버가 「연결 실패」로 남는다` — 사라지면 "왜 안 붙었지"를 물을 자리가 없다.
* `패널2 MCP 행에 도구 이름(echo·ping)` — `init.tools` 접두사 갈라내기의 화면 증거.

### 3.1 2턴 계측 — 스냅샷은 몇 번 나가나

와이어 계수(`CCG_ENGINE_LOG`)와 화면 계수(`ma:event` 구독)를 **따로** 셌다.

```
frames 37 · system/init 3장 (A, B, A) · system/commands_changed 0장
패널A가 받은 tooling: 1턴 뒤 1 · 2턴 뒤 2      ← init 수와 정확히 일치
```

`init` 3장 = **이 앱은 턴마다 CLI를 다시 띄운다**(패널A 2턴 + 패널B 1턴). 그러니
"턴마다 온다"가 이 구성에서는 참이다.

**여기서 결함 하나가 드러났다** — §5-④.

---

## 4. 단위 테스트 (`cargo test -p agentcodegui wire::` — 24/24)

M9 몫 6개. 프레임은 전부 위 실측 캡처 모양 그대로다.

| 테스트 | 무엇을 못 박나 |
|---|---|
| `init_carries_the_chats_mcp_and_skill_snapshot` | init 전 커맨드 응답만으로는 **아무것도 안 낸다**(미지≠빈 목록) · 조인 · 실패 서버 행 유지 · 스코프 꼬리 · 비스코프 꼬리는 안 뗀다 |
| `a_mid_session_commands_push_refreshes_the_snapshot` | `commands_changed` REPLACE — 사전에서 빠진 이름은 설명을 잃되 **행은 남는다** |
| `the_next_turns_handshake_does_not_flash_the_previous_turns_environment` | ★같은 사전을 다시 받으면 재방출 없음 / 진짜 바뀌면 재방출 |
| `mcp_tool_prefix_matches_the_normalized_server_name` | `my.co tools` ↔ `mcp__my_co_tools__search` 되맞춤 |
| `a_server_turned_off_in_settings_still_gets_a_row` | off 행 꼬리 배치 · **와이어가 정책을 이긴다**(재스폰 전 낡은 정책의 유령 행 금지) · 같은 정책 재방출 금지 |
| `a_chat_with_no_mcp_reports_an_empty_list_not_silence` | 빈 환경도 스냅샷을 낸다 |

---

## 5. 인수인계본에서 고친 것

R20이 넘겨받은 워킹트리는 `cargo check`가 통과했지만, 아래 넷은 **검증하면 무너지는
상태**였다.

**① 하네스가 자기 근거를 안 만들고 있었다.** `(user)` 스코프 실측은 `%TEMP%`에 남아 있던
찌꺼기 스킬(`gamma-personal`)에 기대고 있었다 — 스크립트에는 그것을 만드는 코드가 없다.
새 기계에서 돌리면 그 근거가 조용히 사라진다. 씨앗을 스크립트가 심게 했다(무인증 설정
폴더에만 — 실 계정 폴더는 읽기 전용 규약).

**② "실측"이라 적혔지만 실측이 없던 주장.** `wire.rs`의 off 행 되붙이기 전체가
"`deniedMcpServers`를 실으면 행째 사라진다"에 기대는데, 하네스에 그 판이 없었다.
C 픽스처를 세워 실제로 쟀다(§1.3). 주장은 **참**이었고, 부수적으로 세 가지를 더 알아냈다.

**③ 렌더러 타입체크가 깨져 있었다.** `protocol.ts`의 `EngineEvent`에 `tooling`을 더한
순간 `session.ts`의 소진 가드가 컴파일을 멈춘다.

```
app/src/store/session.ts(1263,51): error TS2345:
  Argument of type '{ type: "tooling"; … }' is not assignable to parameter of type 'never'.
```

`cargo check`만 보면 안 보이는 자리다. `case 'tooling': return state`를 이유와 함께 명시.

**④ 매 턴 지난 턴의 목록이 한 번씩 스쳤다.** 2턴 계측에서 `tooling`이 **3번** 나왔다
(`init`은 3장인데 패널A 몫은 2장). 원인: 2턴째 핸드셰이크의 `initialize` 응답이
`system/init`보다 먼저 오는데, `read_commands`가 **내용이 같아도** 재방출을 시키고 있었다.
그 순간 `env`는 아직 지난 턴 것이라 낡은 스냅샷이 한 번 나간 뒤 곧바로 덮인다. 같은 폴더면
내용이 같아 안 보이지만, **폴더를 바꾼 턴에서는 남의 폴더 목록이 스친다**. `read_commands`가
실제 변경만 참을 주도록 고쳤다 → 재측정 **3회 → 2회**(= `init` 수).

**⑤ 주석이 코드보다 앞서 있었다.** `McpSkillView`에 "설명은 한 줄로 자른다"고 적혀
있었지만 자르는 코드도 CSS도 없었다. 실 데이터에서 내장 스킬 설명은 `dataviz` 941자 ·
`update-config` 604자 — 300px 폭 팝오버(최대 340px)에서 그 한 행이 카드를 통째로 먹는다.
`oneLine()`(110자 + `…`, 전체는 `title`)을 붙였다. 재측정: 스킬 행 16개 최장 **139자**.
CSS로 안 자른 이유는 `.wb-prow .sub`가 다른 팝오버 넷과 공유하는 규칙이라서다.

---

## 6. 아직 없는 것 / 못 개통한 것

* **패널에서 켜고 끄기.** 팝오버는 읽기 전용이다. 끄기는 설정 화면 몫인데, 그 채널
  (`mcp:list`·`mcp:set-enabled`)이 **3.0 셸에 구현돼 있지 않다** — `app/src/api/shim.ts`가
  기본값 `[]`로 접어 설정 MCP 탭이 항상 "없음"을 그린다. 그래서 `status:"off"` 행은
  **와이어·단위 테스트 수준에서만 검증**됐고 실물에서 그 행을 만들 경로가 아직 없다.
* **`system/commands_changed` 경로가 앱까지 안 닿았다.** CLI 수준에서는 확실히 온다
  (`result` 뒤 1장, 41개). 그런데 앱 주행에서는 **0장** — 턴이 끝나면 CLI가 죽어서다.
  상주 판(중단 복귀·예약 드레인)에서는 프로세스가 턴을 넘겨 사니 그때 필요해진다.
  지금은 단위 테스트만이 이 arm의 근거다.
* **플러그인 행이 빈 배열로만 검증됐다.** 실 주행에서 `init.plugins`가 `[]`였다.
  `{name, version}` 렌더는 합성 프레임 테스트뿐.
* **팝아웃 창(`#mapanel`)의 칩은 눈으로 확인 안 했다.** 같은 `panelId`를 넘기므로 코드상
  같은 값을 받지만, 그 창에서 칩을 실제로 열어 보지는 않았다.
* **본채팅·추가 채팅에는 안 붙였다.** 요구가 「멀티채팅 기준」이었고, 두 표면은 헤더
  문법이 달라 부착 지점 설계가 따로 필요하다. 와이어(`chat:event`·`session:event`)는
  이미 같은 이벤트를 싣고 간다.
* **메모리는 재지 않았다**(다른 라운드가 같은 워크스페이스를 동시에 컴파일 중).

---

## 7. 다음 라운드가 손댈 만한 자리

1. `mcp:list`·`mcp:set-enabled`를 셸에 구현하면 off 행이 실물에서 살아난다. 그때 이 팝오버
   행에 토글을 붙이면 「보고 → 끄고 → 재스폰 → 바뀐 것을 그 자리에서 확인」이 한 카드에서 끝난다.
2. 실패 사유(`mcp_status`의 `error:"MCP error -32000: Connection closed"`)는 지금 화면에
   없다. 필요해지면 **실패 행이 있을 때만** 왕복 한 번을 거는 것이 값싸다.
3. 본채팅 헤더 부착 — 이벤트는 이미 간다.

---

## 부록 — 재현

```
node scripts/poc-mcpskill.mjs           # 와이어 실측 A·B·C (무인증 · 토큰 0) — 단언 28
node scripts/poc-mcpskill.mjs --app     # 실물 앱 멀티 2패널 2턴 (실과금 최소) — 단언 11
cargo test -p agentcodegui wire::       # 24/24 (M9 몫 6)
npx tsc --noEmit -p app/tsconfig.json   # 0
```

`--app`은 `target/release/agentcodegui.exe`를 쓴다. **`npm run tauri:build`로 만든
바이너리여야 한다** — `cargo build --release`만 돌린 exe는 프런트를 `devUrl`
(`localhost:5273`)에서 찾아 빈 창이 뜬다(이 라운드에서 한 번 밟았다).

> R2에서 이 절의 숫자 셋이 바뀌었다(§R2.5). 최신 재현 명령은 §R2.6이다.

---
---

# M9 R2 — 칩이 마운트를 넘어 산다

라운드 R21 · 2026-08-24 · 브랜치 `feature/3.0.0-beta` · 대상 크리틱 `docs/critic/m9-r1.md`

크리틱은 「빌더 숫자는 전부 재현됐고, 칩은 「크게 보기」 한 번에 사라진다」로 닫았다.
와이어 28/28·단위 24/24·실물 2패널 숫자는 한 줄도 안 틀렸는데, **행복 경로 밖에서 네 개가
깨졌다.** 이 라운드는 그 넷을 닫는다. 자기 채점은 안 한다 — 판정은 크리틱 자신의 도구
(`critic-m9-attack.mjs`·`critic-m9-norm.mjs`)를 **무수정으로 다시 돌려** 나온 값이다
(`critic-m9-norm.mjs`는 한 줄 예외 — §R2.4).

## R2.0 한 문단

칩의 값이 **스폰당 푸시 한 장**뿐이라 껍데기가 갈리면 증발하던 것을, 셸에 **질의 채널**
(`chat:tooling-get`)을 내서 마운트마다 한 번 묻게 했다 — 「크게 보기」·「원래 크기로」·
팝아웃 첫 진입·그리드 복귀 **전부 턴 0회로** 칩이 그대로 선다(실물 실측 §R2.2). 같은
자리에 두 팝오버가 포개 뜨던 것은 캡처 단계 + 래퍼 containment로 닫았고(양방향), 서버
이름의 비BMP 문자가 도구를 조용히 삼키던 것은 `mcp_norm`을 **UTF-16 단위**로 고쳐 닫았다
(실 CLI 0.3.241 실측 — 이제 빌더 하네스도 그 판을 직접 잰다). 칩·툴팁이 `connected`/
`failed` 밖의 상태를 안 세던 것은 **분모가 맞게** 다시 셌다(`pending`·`needs-auth`·
`disabled`·미상까지). 크리틱의 정정 다섯도 반영했다(§R2.5). 남은 것은 하나다 —
`result` **뒤**에 오는 `commands_changed`(크리틱이 「패(기지)」로 표시한 그 항목, §R2.3).

## R2.1 크리틱 도구 재실행 — 4패 → 1패(그 1패는 「기지」)

| 도구 | R1 | R2 |
|---|---|---|
| `critic-m9-attack.mjs`(A1~A10 전량) | 지적 **4종**(A1-tip-pending · A2-uni · A9-expand/restore · A10-two-pops) + A4-push | 지적 **A4-push 1건**뿐 |
| `critic-m9-norm.mjs`(실 CLI 5종) | `emoji🚀srv` **불일치** | **5/5 일치 · `unmatched: []`** |
| `poc-mcpskill.mjs`(와이어) | 28 OK | **30/30**(비BMP 접두사 단언 2건 추가) |
| `poc-mcpskill.mjs --app`(실물 2패널) | 13 OK | **21/21**(칩 수명 5건 · 팝오버 배타 3건 추가) |
| `cargo test -p agentcodegui wire::` | 24 | **25**(UTF-16 접두사 표 1건 추가) |

산출: `docs/critic/m9-r2-attack-all.json` · `docs/critic/m9-r2-norm.json`
(크리틱의 기준 파일 `m9-r1-*.json`은 **하나도 안 덮었다**).

### 넷이 어떻게 닫혔나

**① 칩 수명 (A9·A6) — 질의 채널.** R1의 데이터 경로는 푸시 한 방향뿐이었다:
`system/init` → `Wire::tooling_event()` → `ma:event` → `McpSkillView`의 `useState`.
그런데 「크게 보기」는 같은 대화를 오버레이 카드로 **옮겨 다시 마운트**하고(그리드
자리는 `.ma-ghost`가 된다), 팝아웃은 아예 다른 창이다. 새 컴포넌트에는 아무것도 안 온다.
값은 셸의 `Wire::env`에 그대로 있었으므로 **같은 함수를 조회로도 열었다**:

```
chat:tooling-get {panelId|chatId}
  → engine/mod.rs::core_dispatch  (panelId → chatId 번역: 멀티 칩은 자기 chatId를 모른다)
  → hub::Op::ToolingGet           (★`ensure` 앞 — 조회가 런타임을 만들지 않는다)
  → Wire::tooling()               (푸시와 **같은** 생성 함수)
```

`McpSkillView`는 마운트/`panelId` 변경마다 한 번 묻고, 왕복 중에 푸시가 먼저 닿으면
그쪽을 남긴다(`setSnap((cur) => cur ?? tl)`). **재시작 미복원 원칙은 그대로다** —
스냅샷은 여전히 셸 메모리에만 있고 디스크에 절이지 않는다. 앱을 껐다 켜면 `null`이고,
칩은 서지 않는다("지난주에 붙어 있던 MCP 서버"를 되살리지 않는다는 §2.1의 결정).

**② 팝오버 배타 (A10).** R1 §2.2는 *"서로의 칩 클릭이 상대에겐 바깥 클릭이다"* 라고
적었지만 실측은 반대였다 — 폴더 칩의 래퍼도 `.hfold`(`onMouseDown={stopPropagation}`)라
그 클릭이 `window`까지 오지 않는다. 양쪽을 다 막았다:

* 도구 팝오버의 바깥닫힘을 **캡처 단계**(`addEventListener(..., true)`)로 옮기고, 안쪽
  판정은 전파가 아니라 **래퍼 `ref`의 `contains`** 로 한다 → 남이 전파를 끊어도 울린다.
* 도구 칩이 **열릴 때** 호스트에 알린다(`onOpen` → `setFolderPop(false)`) → 반대 방향.

**③ `mcp_norm`을 UTF-16 단위로 (A2-uni · norm 5종).** CLI는 JS라 정규식이 **UTF-16 코드
단위**를 돈다 — 서로게이트 쌍은 `_` **두 개**가 된다. Rust `chars()`는 하나였다. 대가는
조용한 소멸이었다: 그 행은 「연결됨」인데 도구 이름도 `도구 N` 배지도 없다. `len_utf16()`
만큼 `_`를 넣어 두 규칙을 맞췄다. 더해서 **접두사 조각도 한 번 정규화해서** 키를 만든다
(멱등이라 실 CLI 출력에는 아무 일도 안 일어나고, 정규화를 안 거친 접두사가 오는 판에서만
양쪽이 같은 자리에 떨어진다 — 크리틱 A2가 흘린 `mcp__Ω_유니코드_🚀__hello`가 그 판이다).

빌더 하네스도 이제 이 규칙을 **직접 잰다**: B 픽스처에 `ccg-emoji🚀b`를 물렸고, 실 CLI
0.3.241이 돌려준 접두사는 `mcp__ccg-emoji__b__`였다(`_` 두 개). 실물 2패널 주행에서도
그 행이 `ccg-emoji🚀b · 연결됨 · echo, ping · 도구 2`로 뜬다 — 와이어부터 화면까지 한 줄.

**④ 상태 집계 (A1-tip-pending).** 칩 본문은 `bad > 0`일 때만 분모를 드러냈고 툴팁은
`live`·`bad`·`off` 셋만 읽었다. 그래서 서버 10대(연결7·실패1·인증필요1·연결중1)가
「MCP 7개 연결 · 2개 실패」— **합이 9**였고, `needs-auth`가 「실패」로 합산됐다.

```
             R1                                     R2
A1 칩  7/10 · 50                             7/10 · 50
A1 툴팁 MCP 7개 연결 · 2개 실패 · 스킬 50개    MCP 7개 연결 · 1개 실패 · 1개 인증 필요
                                              · 1개 연결 중 · 스킬 50개
A2 칩  4 · 5   (status 없는 5번째가 증발)      4/5 · 5
A2 툴팁 MCP 4개 연결 · 스킬 5개                MCP 4개 연결 · 1개 상태 미상 · 스킬 5개
```

규칙은 셋이다. (a) 분모는 **다 안 붙었으면 항상** 드러낸다(`live !== total`). (b) 상태는
`connected`/`failed`/`needs-auth`/`pending`/`disabled`/**나머지 전부(`상태 미상`)** 로
갈라 세어 **합이 분모와 같다**. (c) 칩이 빨개지는 조건은 「사용자가 손대야 붙는 것」
(`failed + needs-auth`)이고, 그래도 툴팁은 둘을 다른 낱말로 말한다 — 할 일이 다르다.
곁들여 **칩과 카드의 수를 맞췄다**: 섹션 머리도 켜진 것만 세고 끈 것은 `· 꺼짐 N`으로
따로 적는다(R1은 여기만 off를 포함해 칩 `1 · 1` 옆에 「MCP 서버 2」가 섰다).

## R2.2 칩 수명 — 실물 실증(턴 0회)

`poc-mcpskill.mjs --app`(실 `claude.exe` 0.3.241 · 격리 홈 · 2패널). 패널1에서 한 턴을
태워 칩을 세운 뒤, **더 이상 턴을 태우지 않고** 껍데기만 갈았다.

```
턴 뒤 그리드          : "1 · 15"
「크게 보기」 카드     : "1 · 15"     ← R1: null
「원래 크기로」 복귀   : "1 · 15"     ← R1: null
팝아웃 창 첫 진입     : "1 · 15"     ← R1: null (그 창에서 한 턴을 더 태워야 떴다)
팝아웃 → 그리드 복귀  : "1 · 15"
```

팝오버 배타도 같은 주행에서 잰다: 도구 칩만 → **1장** · 도구 팝오버가 열린 채 폴더 칩 →
**1장** · 폴더 팝오버가 열린 채 도구 칩 → **1장**(R1은 두 번째가 2장, 겹침 64,200px²).

가짜 CLI 쪽(크리틱 도구)에서도 같은 값이다: A9 `1 · 1` → 크게 보기 `1 · 1` → 복귀
`1 · 1`, A6 팝아웃 **첫 진입** `1 · 1`, A10 `count: 1 · overlap: 0`.

## R2.3 남은 하나 — `result` 뒤의 `commands_changed`

크리틱이 「**패(기지)**」로 표시한 항목이고 R1 §6이 스스로 적어 둔 자리다. R2도 못 열었다.

* **끊긴 지점은 확정됐다**(크리틱 §5-라 + 이 라운드 재확인): 와이어 계수
  `commandsChanged: 0`. 프레임이 **셸에 오지 않는다**. 턴 한복판의 같은 푸시는 화면까지
  닿는다(A4c · `commandsChanged: 1`) — arm은 살아 있고 죽은 것은 **프레임이 오는 시점**이다.
* **원인**: `on_result` → `land_turn()` → `StreamClosePolicy::OnIdle` →
  `close_and_finish(AllClear)` → `driver.kill()`. 즉 CLI가 result 직후 죽어서 그 뒤의
  프레임을 아무도 못 받는다(가짜 CLI는 700ms 뒤에 밀도록 대본이 짜여 있다).
* **레버는 한 줄이다**(`with_close_policy(StreamClosePolicy::Linger(ms))`) **그러나 M9가
  당길 자리가 아니다.** 그 값은 앱 전체의 턴 종료 의미를 바꾼다 — `Resident{Linger}`
  브로드캐스트·`chat:status`·「완료」 표시 규칙(bg까지 걷혀야 완료)·한도 대기표·좀비
  스윕이 전부 그 시점에 매달려 있고, 지금 M10·M11 라운드가 같은 파일을 만지고 있다.
  도구 환경 칩 하나를 위해 그걸 옮기는 것은 값이 안 맞는다. **엔진 라운드의 몫**으로
  남긴다(그때 이 arm은 코드 변경 0으로 저절로 초록이 된다 — 이미 배선돼 있다).

## R2.4 크리틱 도구에 손댄 한 줄 (전부 공개)

`critic-m9-norm.mjs:74`의 `mcpNormRust`는 **제품 코드의 거울**이다("wire.rs의 `mcp_norm`을
그대로 옮긴 것"이라고 그 파일이 적고 있다). R2가 `wire.rs`를 `len_utf16()`으로 고쳤으므로
거울도 같이 돌렸다(`'_'` → `'_'.repeat(c.length)` — JS의 코드포인트 조각 길이가 곧 UTF-16
단위 수다). **안 돌리면 그 도구는 이제 존재하지 않는 코드를 잰다.**

이 편집은 판정을 무르게 하지 않는다: 그 도구가 재는 대상은 여전히 **실 CLI가 실제로 뱉은
접두사**이고, 규칙을 CLI에 맞춘 것이지 기대치를 결과에 맞춘 것이 아니다. 그리고 같은
사실을 **거울 없이** 재는 근거를 두 군데 더 만들었다 —
(a) `poc-mcpskill.mjs`의 B 픽스처가 실 CLI에 비BMP 이름을 물려 접두사를 직접 읽고,
(b) `wire.rs`의 새 단위 테스트가 크리틱이 실측한 접두사 5종을 표로 못 박았다.
`critic-m9-attack.mjs`는 **한 글자도 안 고쳤다.**

## R2.5 크리틱 정정 반영

**가. `--app` 단언은 11이 아니라 13이었다.** R1 문서의 「단언 11건」은 과소 신고였다.
R2에서 칩 수명 5건 + 팝오버 배타 3건이 늘어 **21건**이다.

**나. 와이어 갈래의 엔진이 보고서와 달랐다.** `poc-mcpskill.mjs`의 기본값이
`CCG_ENGINE ?? '0.3.239'`라 부록 명령을 그대로 치면 0.3.239로 쟀는데 §1은 0.3.241이라
적었다. 이제 **홈의 `activeVersion`을 기본으로 읽는다**(=`--app`과 같은 판). 고정하려면
`CCG_ENGINE=0.3.239`. 이 라운드의 와이어 주행은 **0.3.241**이다.

**다. 「off 행을 실물에서 만들 경로가 아직 없다」는 사실이 아니었다 — 있고, 된다.**
R1 §6이 자기 성과를 과소 신고했다. 설정 UI(`mcp:list`·`mcp:set-enabled`)가 없는 것은
맞지만 그 값이 사는 축은 **`chat:identity-set {tools: {deniedMcp, skillOverrides}}`** 이고,
그 채널은 3.0 셸에 구현돼 있다. 실경로는 이렇다:

```
chat:identity-set {chatId, patch:{tools:{deniedMcp:{'srv-off':true},
                                        skillOverrides:{'skill-off':'disabled'}}},
                   applyPolicy:'now'}
  → RunIdentity.tools()                     (P1e `tools` 축 · revision 1)
  → Hub::pump 매 tick  Wire::set_policy(denied, off)   ← **바뀔 때만** true
  → Wire::tooling()  → ma:event → 칩·팝오버              ← **재스폰 없이** 1.5초 안에
```

크리틱 실측(A5 · 유효 회차 `-c`)과 R2 재실측이 같다 — 정책 적용 뒤 **재스폰 없이**
패널A 칩 `1 · 1` / 행 `srv-off · 설정에서 껐어요`·`/skill-off · 설정에서 껐어요`,
같은 보드의 패널B는 off 행 **0건**(옆으로 안 샌다). 주의: 이 채널의 주소는 **chatId**이지
panelId가 아니다 — `panelId`를 그대로 넘기면 유령 런타임을 패치한다(크리틱이 한 회차를
그렇게 날렸다: `m9-r1-b-midturn.json`의 A5는 무효).

**라. 「`commands_changed`는 단위 테스트만이 근거」도 지금은 아니다.** 턴 한복판의 푸시는
화면까지 닿는다(A4c). 남은 것은 `result` **뒤**의 푸시뿐 — §R2.3.

**마. 팝오버 머리가 소문자로 떴다.** `도구 환경 · a`(보고서 §3은 `· A`로 적었다). 원인은
`read_init_env`가 `system/init.cwd`를 쓰는데 앱이 CLI를 **정규화된(소문자) cwd**로 띄우기
때문이다 — 같은 헤더에서 폴더 칩은 `A`, 팝오버 머리는 `a`가 됐다. 표시 이름을 **패널
meta의 cwd**에서 따오게 고쳤다(`stale` 게이트가 두 경로의 폴더가 같음을 이미 보장한다).
실물 재실측: 팝오버 머리가 `도구 환경 · A` / `도구 환경 · B`(대문자 — 폴더 칩과 같은 글자).

## R2.6 재현 · 경계

```
# 제품
npx tsc --noEmit -p app/tsconfig.json                  # 0
cargo test -p agentcodegui wire:: --features custom-protocol   # 25 passed

# 빌더 하네스
node scripts/poc-mcpskill.mjs                          # 와이어 A·B·C (무인증 · 토큰 0)
node scripts/poc-mcpskill.mjs --app [--exe=…]          # 실물 2패널 + 칩 수명 + 팝오버 배타

# 크리틱 도구 (판정)
cargo build --release -p ccg-engine --features fakecli --bin ccg-fakecli
node docs/critic/tools/critic-m9-attack.mjs [--exe=…] --out=docs/critic/m9-r2-attack-all.json
node docs/critic/tools/critic-m9-norm.mjs             --out=docs/critic/m9-r2-norm.json
```

`--exe=`는 R2에서 두 하네스에 필요했다: 다른 라운드가 `target/release/agentcodegui.exe`를
물고 있어 링커가 못 덮었다(`os error 5`). 격리 타깃(`CARGO_TARGET_DIR`)에 짓고 그것을
가리켰다 — 공용 exe는 **건드리지 않았다**. `poc-mcpskill.mjs`에 `--exe=`를 새로 붙였다
(크리틱 도구·`poc-live-chat.mjs`에는 원래 있었다).

**이 라운드가 만진 파일**: `src-tauri/src/engine/{wire,hub,mod}.rs` ·
`src-tauri/src/ipc/mod.rs`(채널 상수 1줄) · `src/shared/{protocol,api}.ts` ·
`app/src/api/shim.ts` · `app/src/components/{McpSkillView,MultiAgent}.tsx` ·
`scripts/poc-mcpskill.mjs` · `docs/critic/tools/critic-m9-norm.mjs`(거울 1줄 · §R2.4) ·
이 문서. M10(`engine/talk.rs`·`Op::TalkConfig`/`TalkStop`)과 M11(`acct_switch`)은
**한 글자도 안 만졌다** — `hub.rs`에서 겹치는 줄은 `unreachable!` 목록에 새 variant 이름
하나를 더한 것뿐이다.
