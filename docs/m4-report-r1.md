# M4 빌드 보고 — R1 (Codex 엔진: `codex app-server` 드라이버)

**범위**: `crates/ccg-engine/src/codex/`(신설) · `crates/ccg-engine/src/bin/ccg_fakecodex.rs`(신설) ·
`crates/ccg-engine/src/{driver,identity,lib}.rs`(가감) · `crates/ccg-engine/tests/codex_*.rs`(신설) ·
`src-tauri/src/engine/`(codex 배선) · `scripts/poc-codex.mjs`(신설) · 이 문서.

**안 건드린 것**: `app/`(얼려 둔 2.6.2 렌더러) · `src-tauri/src/{win,crash,main}.rs` ·
`src-tauri/src/ipc/`(엔진 밖) · `crates/ccg-{store,auth,fs}` · `crates/ccg-engine/src/runtime.rs`
(60전이 상태기계 — **한 줄도 안 고쳤다**. 그게 이 라운드의 설계 명제였다) ·
루트 `Cargo.toml`·`Cargo.lock`(다른 라운드가 같은 순간에 고치고 있어 소유자에게 남긴다 — §7).

---

## 0. 한 장 요약

| 항목 | 수치 |
|---|---|
| 테스트 | `ccg-engine` **167 green / 0 red** · `agentcodegui` **25 green / 0 red** · 경고 0 |
| 그중 M4 신규 | 옮김 재생 **15** · 실 프로세스 세로 조각 **3** · 버전관리 **3** · 셸 와이어 **4** |
| 옮김표(`FRAME_MAP`) | **44행** — 재생 커버리지 게이트가 **44/44** 강제 |
| 실 `codex app-server` 스모크 | **0.149.0** · initialize **233ms** · `thread/start` **성공**(threadId 발급) |
| 우리가 보내는 RPC의 실서버 검증 | `initialize`·`thread/start`·`turn/start`·`backgroundTerminals/list`·`model/list` **전부 유효**, `turn/interrupt`는 대상 턴이 없어 거절(=이름·스키마 유효) |
| 앱 세로 조각(가짜 app-server) | 부팅→전송→스트리밍→도구→완료→**재시작 후 잔존** · 검사 9/9 · findings **0** |
| Claude 파리티 회귀 | `poc-live-chat --only=events` **PASS · 결함 0** (내 변경 뒤 재주행) |
| `runtime.rs` 변경 | **0줄** |
| 코드량 | 엔진 codex 모듈 **2,556줄** · 스텁 130 · 테스트 1,006 · 셸 배선 261 · 하네스 441 |

재현:

```bash
cargo test -p ccg-engine --offline            # 167 green
cargo test -p agentcodegui --offline          # 25 green
cargo build -p ccg-engine --features fakecli --bin ccg-fakecodex --release
npm run tauri:build
node scripts/poc-codex.mjs                    # 실 바이너리 핸드셰이크 + 앱 세로 조각
node scripts/poc-live-chat.mjs --only=events --tag=m4   # Claude 파리티 회귀
```

산출: `docs/critic/m4-r1-codex.json`(이 문서의 모든 실측치) ·
`docs/critic/m3-r4-live-m4.json`(Claude 회귀 — 기준 파일 `m3-r4-live.json`은 안 건드렸다).

---

## 1. 설계 결정 하나 — "드라이버를 하나 더 만든다"

m-logic §3.1은 상태기계를 **한 벌**로 둔다. Codex를 얹는 길은 둘이었다.

| | 방법 | 대가 |
|---|---|---|
| (a) | `frames.rs`에 Codex 분류기를 더하고 `runtime.rs`를 엔진별로 분기 | 60전이 표·97 재생 시나리오가 걸린 파일이 두 갈래가 된다. 「Codex일 때만 나는 버그」의 서식지 |
| (b) | **`CliDriver`를 하나 더 구현하고 와이어를 그 안에서 옮긴다** | 상태기계·원장·정체성·큐·한도가 한 글자도 안 바뀐다 |

(b)를 골랐다. `CliDriver`는 이미 상태기계와 프로세스 사이의 **유일한 통로**다 — 그 좁은
목에서 JSON-RPC ↔ Claude 프레임을 옮기면 위층에게 Codex는 "조금 다른 CLI"일 뿐이다.

```text
  ChatRuntime(변경 0줄) ──CliDriver──▶ AnyDriver ─┬─ ClaudeDriver  (claude.exe · stream-json)
                                                  └─ CodexDriver   (codex app-server · JSON-RPC)
                                                        └─ Transcoder(순수)  ← 재생 테스트의 SUT
```

**엔진은 스폰 인자가 고른다.** `build_spawn_spec`이 정체성을 보고 `SpawnSpec.codex`를
채우면(`Some(CodexPlan)`) `AnyDriver`가 그 스폰만 Codex로 간다. 채팅 도중 picker에서
엔진을 바꾸면 T17(재스폰)이 돌고 그 다음 스폰부터 반대쪽 드라이버가 뜬다 — 런타임을
두 벌 들거나 채팅을 다시 만들 필요가 없다.

| 파일 | 줄 | 내용 |
|---|---|---|
| `codex/mod.rs` | 309 | `CodexPlan`(정체성→실행계획) · effort/mode 매핑 · **옮김표 `FRAME_MAP` 44행** |
| `codex/transcode.rs` | 1,399 | **순수** 옮김기(JSON-RPC ↔ 프레임). 프로세스·파일·시계를 모른다 |
| `codex/driver.rs` | 343 | 스폰 · `CODEX_HOME` · job object · stdout 바이트 루프 · 테일 파일 |
| `codex/versions.rs` | 505 | 설치본 목록/활성/설치/제거/정리 + 레지스트리 조회 |
| `bin/ccg_fakecodex.rs` | 130 | 가짜 app-server(JSON-RPC 스텁) — `--features fakecli` |
| `src-tauri/src/engine/any.rs` | 101 | `AnyDriver` — 스폰마다 엔진 선택 |
| `src-tauri/src/engine/codex_versions.rs` | 160 | `codex-engine:*` 5채널 + 격리 홈 해석 |

### 프레이밍은 두 벌 만들지 않았다

`driver.rs`의 바이트 루프(`read_frames`)를 `pub(crate)`로 열어 Codex도 **그대로** 쓴다.
codex의 `initialize` 응답과 `item/completed`의 diff는 read 경계를 넘고, 그 조립 버그를
두 곳에 만들 이유가 없다.

---

## 2. 옮김표 — 무엇이 무엇이 되는가

전체는 `codex/mod.rs::FRAME_MAP`(데이터)이고, 재생이 **44/44 전부** 밟는다
(`tests/codex_replay.rs::frame_map_is_fully_replayed`가 게이트). 요지만:

| Codex 와이어 | 상태기계가 받는 것 | 화면(2.6.2 EngineEvent) |
|---|---|---|
| `initialize` 응답 | `control_response{init-1}` | (T2 절반) |
| `thread/start`·`resume` 응답 | `system/init{session_id=threadId}` | `session` |
| `item/agentMessage/delta` | `stream_event{text_delta}` | `assistant-stream` |
| `item/reasoning/*Delta` | `stream_event{thinking_delta}` | `thinking` |
| `item/started{commandExecution}` | `assistant{tool_use Bash}` | `tool-start` + `terminal` |
| `item/completed{*}` | `user{tool_result}` | `tool-end` |
| `item/completed{fileChange}` | `system/ccg_codex{file_change}` + `tool_result` | `file-change` |
| `item/*/requestApproval`(4종) | `control_request{can_use_tool}` | `permission-request` |
| `item/tool/requestUserInput` | `control_request{AskUserQuestion}` | `question-request` |
| `turn/plan/updated` | `system/ccg_codex{todos}` | `todos` |
| `thread/tokenUsage/updated` | `system/ccg_codex{context}` | `context` |
| `turn/completed` | `result{usage·modelUsage}` | `result` |
| `backgroundTerminals/list` | `system/background_tasks_changed` | `bg-tasks` |

### 합성 프레임 세 개를 둔 이유 (`system/ccg_codex`)

Codex에는 Claude 프레임에 **대응물이 없는 값**이 셋이다 — 파일 변경의 unified diff,
`turn/plan/updated`, `thread/tokenUsage/updated`. 억지로 Claude 모양(`TodoWrite` 도구
호출·`assistant.usage`)에 끼우면 그 프레임이 상태기계의 **회계**(모델 전환 감지·턴 활동
판정)까지 건드린다. 그래서 표시 전용 값은 표시 전용 통로로 보낸다 — 상태기계에는 미지
`system` 서브타입이라 F21(조용히 버림)로 떨어지고, 셸의 `wire.rs`만 읽는다.

### `codex_file_change`라는 도구 이름

Codex의 파일 변경을 `Edit`으로 위장하면 셸의 diff 조립기(`build_pending`)가 **Claude
도구 입력**(old_string/new_string)을 기대해 **빈 변경**을 만든다. 전용 이름을 쓰고
`tool_label`이 같은 'edit' 종류로 그리게 했다. 실제 diff는 합성 프레임이 싣고,
`wire.rs`가 2.6.2와 같은 정책으로 승격한다: **런 기준선 ↔ 디스크 전체 diff(whole=true)**.
기준선은 훙크를 디스크에 **역적용**해 복원한다(`diff::reverse_apply_unified` —
2.6.2 `unidiff.ts` 이식). 역적용이 어긋나면 그 한 번만 훙크 조각(`whole=false`)으로 흘린다.

---

## 3. 실 `codex app-server` 스모크 (0.149.0)

`node scripts/poc-codex.mjs --only=handshake`. **격리된 빈 `CODEX_HOME`**(레포 안)으로
띄웠다 — 사용자 실홈 `~/.codex`에는 아무것도 쓰지 않았고, `initialize` 응답이 그
사실을 되돌려 준다(`codexHome: C:\Code\AgentCodeGUI\.poc-home-codex-rpc`).

| 호출 | 결과 |
|---|---|
| `initialize` | **ok, 233ms** — `userAgent: agentcodegui/0.149.0 (Windows 10.0.26200; x86_64) … (agentcodegui; 3.0.0)` |
| `thread/start` | **ok** — `threadId 01a02d3a-…`(**로그인 없이도 스레드는 선다**) |
| `thread/backgroundTerminals/list` | ok(`experimentalApi` opt-in이 실제로 먹는다) |
| `turn/start` | ok(접수됨 — 실패는 나중에 통지로 온다) |
| `turn/interrupt` | `-32600 no active turn to interrupt`(대상이 없을 뿐, **이름·스키마 유효**) |
| `model/list` | ok |

즉 **우리가 조립하는 RPC 6종이 0.149.0에서 전부 유효**하다. 모르는 메서드(-32601)는 0건.

### 미로그인 턴이 실제로 뱉는 것 (조립+드라이런의 끝)

실계정이 없으므로 여기서 멈추는 대신, **자격증명 없는 턴을 끝까지 돌려** 실패 경로를
받아 적었다(과금 위험 0 — 그 홈에는 토큰이 없다). 순서(요약, 전문은 산출 JSON):

```
item/completed{userMessage}          ← 2.6.2에 없던 아이템 타입
error{willRetry:true} × 5            ← "Reconnecting… n/5" (401)
warning                              ← "Falling back from WebSockets to HTTPS transport…"
error{willRetry:true} × 5            ← HTTPS로도 401
thread/status/changed{systemError}
error{willRetry:false, codexErrorInfo:"other"}
turn/completed{status:"failed", error:{…}}
```

**이 주행이 이식 결함 두 개를 잡았다.** 둘 다 코드 대조로는 안 보였다:

1. **결과 카드 두 장.** 치명 오류가 `error{willRetry:false}` **와** `turn/completed{failed}`로
   두 번 온다. 2.6.2는 `endedTurnIds`(`engine.ts:210-213`)로 막았는데 R1 초안에는 그
   장치가 없어 `result`가 두 번 나갔다 → `ended_turns` 세트로 이식(재생 테스트가 잠근다).
2. **`.cmd` shim 인용 파손.** `cmd /C "<경로>" app-server`를 `Command::arg()`로 넘기면
   Rust가 `\"`로 이스케이프하는데 **cmd.exe는 백슬래시 이스케이프를 모른다** —
   하네스 첫 주행이 `'"…codex.cmd"'은(는) 내부 또는 외부 명령이 아닙니다`로 죽었다.
   고친 방향은 둘: ① 설치본 안의 **네이티브 실행본**을 찾아 직접 스폰(1순위 — 프로세스가
   3개에서 1개로 줄고 node 런타임이 안 뜬다) ② shim 폴백은 `raw_arg`로 바깥 따옴표를
   직접 쓴다.

새로 관측한 통지 4종(`warning`·`thread/started`·`thread/settings/updated`·
`thread/status/changed`·`remoteControl/status/changed`)도 표에 올렸다 — `warning`만
안내 한 줄로 흘리고 나머지는 **일부러 버린다**(사유를 표에 적었다).

**남은 것**: 로그인이 필요한 것은 `turn` 이후의 **모델 응답**뿐이다. 계정이 생기면
`poc-codex --only=handshake`의 `turn/start` 드라이런이 그대로 라이브 턴이 된다.

---

## 4. 세로 조각 — 실 창에서 codex 채팅이 돈다

`node scripts/poc-codex.mjs --only=app`. 실 exe · 실 창 · 제품 경로, app-server만 가짜다
(`ccg-fakecodex`가 위 실측 스키마 그대로 대본을 흘린다). 검사 **9/9**, findings 0.

| 검사 | 결과 |
|---|---|
| 드라이버 선택 | `engine:debug.engine == "codex"` · `session == "th-poc"` |
| 스트리밍 | 답변 `M4-ALL-DONE`이 **DOM에** 있다 |
| 터미널 | `M4-TERM-OUT` 줄이 화면에 |
| 할 일 | `turn/plan/updated` → 칩 `할 일 0/2` |
| 변경 파일 | `file-change{path:"cx-made.txt", add:2, tag:"new", whole:true}` · 칩 `변경된 파일 1` |
| 컨텍스트 | `context{540}` |
| 결과 | `tokenUsage[{model:"gpt-5.6-terra", inTok:400, outTok:40, cacheRead:100}]` · `contextWindow 272000` |
| 저장 | **재시작 후** 채팅에 메시지 4건, 답변 잔존 |

이벤트 집계: `status 3 · session 1 · thinking 1 · thinking-clear 1 · assistant-stream 1 ·
todos 1 · tool-start 2 · terminal 3 · tool-end 2 · file-change 1 · context 1 ·
assistant-done 1 · result 1`.

이 주행이 잡은 결함 하나 더: 변경 파일 경로가 **절대경로로** 떴다. 정체성의 `cwd`는
`CanonPath`가 소문자로 접은 값인데(재스폰 판정 때문) 와이어의 파일 경로는 원래
대소문자라 `strip_prefix`가 실패한 것. `to_rel`에 대소문자 무시 재시도를 넣어
`cx-made.txt`로 정상화했다(Windows 파일시스템이 대소문자를 안 가리므로 Claude 경로에도 안전).

---

## 5. O4 — `EngineAxis::Codex` 정규화 (닫음)

m-logic §9의 O4는 *"Codex 축의 정규화(모델 id 공간·`codexAccount`·`CODEX_HOME` 격리)를
Claude와 같은 규칙으로 접을 수 있는지 미확인"*이었다. 셋 다 확인·구현했다.

| 축 | 규칙 | 근거 |
|---|---|---|
| 모델 id 공간 | 태그드 유니온이 이미 분리한다 — Claude 정체성에는 `codexAccount`가 **타입상 없다**(`RunIdentity::codex_account()`가 항상 `None`) | 골든 왕복 + `o4_…` 테스트 |
| `codexAccount` | ① 미지정 → **기본 계정**으로 해석 ② 아는 목록에 없으면 `AccountUnavailable`로 **거부** ③ 목록이 비면 검사 안 함 — **구독 계정과 같은 규칙** | `identity.rs` normalize |
| `CODEX_HOME` | 물질화는 `ccg-auth`(M5)가, 주입은 드라이버의 `HomeResolver`가. 엔진 크레이트는 계정 스토어를 모른다 | `codex_versions::home_for` |

`IdentityDefaults`에 축 두 개를 더했다(`default_codex_account`·`known_codex_accounts`) —
Anthropic과 **다른 스토어**(`codex-accounts.json`)라 필드를 나눠야 "클로드 계정으로
Codex를 띄운다"가 구조적으로 불가능해진다. 기본값은 빈 값이라 기존 재생 97 시나리오의
동작은 한 글자도 안 바뀐다(golden 11 green 그대로).

**실홈 보호 규약**: 계정을 못 고르면 `CODEX_HOME`을 **비우지 않는다** — 앱 홈 안의 빈
폴더를 준다. 안 그러면 codex가 사용자 실홈 `~/.codex`로 떨어진다(터미널 codex와 완전
격리가 2.6.2부터의 규약). 그 자리를 테스트가 지킨다
(`an_unresolvable_account_never_falls_back_to_the_real_codex_home`).

또 하나 닫은 구멍: 옛 `claude:run`이 `engine:'codex'`만 싣고 `codexModel`을 안 실으면
`engine_switch_needs_model`로 **전송이 통째로 거부**됐다(§4.2 규칙). 2.6.2와 같은
폴백(`gpt-5.6-terra`)을 `patch_from_run_request`에 넣었다.

---

## 6. 엔진 버전 관리 — Rust 몫

`codex/versions.rs`(순수 파일시스템 + npm)와 `engine/codex_versions.rs`(채널 5개).
`codex-engine:state`는 **M1이 이미 `ipc/app_meta.rs`에 구현**했으므로 손대지 않았다 —
같은 채널에 두 저자가 답하면 어느 쪽이 이겼는지 안 보인다.

| 채널 | 구현 |
|---|---|
| `codex-engine:list-available` | `npm view @openai/codex --json`(8초 상한) → 내림차순·프리릴리즈 제외·`preview` 판정 |
| `codex-engine:install` | `npm install …@ver --prefix <홈>/codex-engines/<ver>` + 진행 줄을 `install-progress`로 |
| `codex-engine:uninstall` | 재시도 5회 삭제(Windows EPERM) + 활성 표식 정리 |
| `codex-engine:set-active` | 설치 안 된 버전 거부 |
| `codex-engine:cleanup` | 최신 하나만 남기고 정리 + 활성 이동 |

**레지스트리 조회를 `npm view`로 하는 이유**: 3.0 Rust에는 HTTP 클라이언트 의존성이
없고(오프라인 빌드 제약) 설치에는 npm이 **필수**다. 같은 도구·같은 레지스트리·같은
프록시 설정을 그대로 타므로 "조회는 되는데 설치가 안 되는" 상태가 생기지 않는다.
파싱은 순수 함수(`parse_packument`)라 테스트가 픽스처를 먹인다 — `npm view`(배열)와
레지스트리 원본(객체) 두 모양 다 읽는다.

**실행본 선택**이 실측으로 바뀐 자리(§3): `.bin/codex.cmd` shim이 아니라
`@openai/codex-<plat>/vendor/<triple>/bin/codex.exe`를 **훑어서** 찾는다. 트리플 이름을
박아 두지 않아 새 플랫폼이 생겨도 산다. 폴백은 shim → 전역 `codex`(PATH).

---

## 7. 남은 것 (조용히 빠뜨리지 않는다)

| # | 무엇 | 등급 | 이유·다음 한 줄 |
|---|---|---|---|
| 1 | **실계정 라이브 턴** | 미검증 | 실홈 codex 계정 0건. 계정이 생기면 `poc-codex --only=handshake`의 `turn/start` 드라이런이 그대로 라이브가 된다 |
| 2 | `codex-engine:install`이 **IPC 워커를 막는다** | 성능 | 렌더러 계약이 `await install() → {ok}`(`Settings.tsx:968`)라 동기여야 한다. 블로킹 스레드로 넘기는 것은 `ipc/mod.rs`의 목록 한 줄 — **그 파일은 이 라운드 내 경계 밖**이다 |
| 3 | **수용량 초과 모델 전환 카드** | 기능 누락 | 2.6.2 `askCapacityFallback`(engine.ts:1134-1260). 지금은 안내 한 줄 뒤 `turn/completed{failed}`로 정착만 한다. 전환 확인 카드는 상태기계의 폴백 축(`FallbackArm`)에 얹는 게 옳아 보이는데, 그 판단은 리드 몫이라 이번엔 안 했다 |
| 4 | `model/list` → picker 모델 목록 | 기능 누락 | `codex:models` 채널이 아직 없다. effort 사다리 강등(`codex_effort(supported)`)도 그 목록이 있어야 산다 — 지금은 목록 없이(=2.6.2가 조회 실패했을 때와 같은 값) 보낸다 |
| 5 | 백그라운드 터미널 **테일 파일 정리** | 위생 | `%TEMP%\ccg-codex-term-*.log`를 만들기만 하고 지우지 않는다(2.6.2도 같다) |
| 6 | `subAgentActivity`·`collabAgentToolCall` | 재생만 | 옮김·재생은 있으나 **실물로 본 적이 없다**(0.149.0 스모크에 안 나왔다). 2.6.2 주석이 유일한 근거 |
| 7 | 루트 `Cargo.toml`·`Cargo.lock` | 경계 | 같은 순간에 M7(ccg-lsp)·M8이 고치고 있어 **커밋하지 않았다**. `src-tauri/Cargo.toml`은 내 줄(ccg-auth)만 골라 스테이징했다. 다음 빌더가 lock을 커밋할 때 `ccg-auth` 항목이 함께 들어간다(경로 의존이라 오프라인 해석된다) |
| 8 | `codex-engine:*` 채널 상수 | 위생 | `ipc/mod.rs::ch`에 이름이 없어 내 모듈이 문자열 리터럴로 매칭한다(그 파일이 경계 밖) |

### 의도적으로 다르게 한 것

- **무음 턴**: 활동도 답변도 없는 Codex 턴은 상태기계의 공통 규칙대로 무음 보류
  (T8→T10 ≈22초) 뒤 정착한다. 2.6.2 Codex는 즉시 정착했다. 엔진별로 규칙을 가르면
  "Codex일 때만 다른 정착"이 생기므로 **공통 규칙을 택했다**.
- **`Status::Error`**: `result{is_error}`는 Claude와 같이 `Done`으로 정착하고 오류는
  결과 프레임이 나른다. `Status::Error`는 스트림이 깨진 경우 전용이다(`runtime.rs:1461`).
- **`usage.input_tokens`**: Codex 결과 프레임에서 이 자리는 **컨텍스트 게이지 전용**이다
  (`wire.rs`가 input+cache로 ctx를 만든다). 실 토큰 회계의 진실은 `modelUsage`다.
