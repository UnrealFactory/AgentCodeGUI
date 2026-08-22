# Claude Code CLI 프로토콜 스펙 — `ccg-claude` (Rust) 이식용

**목적**: 3.0.0의 Rust 크레이트 `ccg-claude`가 **Node SDK 없이** Claude Code CLI를
직접 스폰·구동하기 위한 완전 스펙. 이 문서만 읽고 구현 가능해야 한다.

**원전 (전부 실코드 — 추측 금지)**

| 약칭 | 실체 | 비고 |
|---|---|---|
| `sdk.mjs` | `~/.agentcodegui/engines/0.3.239/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` | 1,386,151 B 번들·미니파이 **1줄** → 인용은 **바이트 오프셋** |
| `sdk.d.ts` | 같은 폴더 `sdk.d.ts` (391,408 B) | 타입 선언 + 상세 JSDoc — **줄 번호** 인용 |
| `claude.exe` | `.../claude-agent-sdk-win32-x64/claude.exe` (337,672,352 B) | bun 단일바이너리. **스트립 안 됨** — JS 소스 문자열이 그대로 들어 있어 grep 가능 |
| `engine.ts` | `src/main/claude/engine.ts` (2537줄) | 2.6.2의 실전 의미론 — 줄 번호 인용 |
| 실측 | `scripts/poc-claude-cli-wire.mjs` | 이 문서와 함께 추가. §7 참조 |

레포 기준 커밋: `571fb92` (2.6.2), 브랜치 `feature/3.0.0-beta`.
CLI 실측 버전: **2.1.239** (SDK 래퍼 0.3.239, `manifest.json` `commit
9bf8e9521fe06414183309865310e27c9b8db3dd`, `buildDate 2026-08-21T04:55:13Z`).

`sdk.mjs` 오프셋 재현 방법:

```bash
node -e "const s=require('fs').readFileSync('sdk.mjs','utf8');console.log(s.slice(931700,932100))"
```

`claude.exe` 문자열 재현 방법 (바이너리 청크 스캔, latin1):

```bash
node -e "const fs=require('fs'),fd=fs.openSync('claude.exe','r'),sz=fs.fstatSync(fd).size,CH=8<<20,b=Buffer.alloc(CH);let p=0,c='';
while(p<sz){const n=fs.readSync(fd,b,0,Math.min(CH,sz-p),p),s=c+b.subarray(0,n).toString('latin1');let i=0;
while((i=s.indexOf(process.argv[1],i))>=0){console.log(s.slice(i-500,i+500).replace(/[^\x20-\x7e\n]/g,'.'));i+=1}
c=s.slice(-1024);p+=n}" 'subtype:\"can_use_tool\"'
```

---

## 0. 한 장 요약

```
 ┌──────────────┐   argv(§2) + env(§2.3)          ┌─────────────────────────┐
 │  ccg-claude  │────── spawn ──────────────────▶ │ claude.exe (native bun) │
 │   (Rust)     │                                 │  --input-format  json   │
 │              │◀── stdout: JSONL 프레임 ────────│  --output-format json   │
 │              │──▶ stdin : JSONL 프레임 ────────│                         │
 │              │◀── stderr: 자유 텍스트 ─────────│                         │
 └──────────────┘                                 └─────────────────────────┘
```

- **한 줄 = 한 JSON 값**. 양방향 동일 프레이밍. 줄 끝 `\n` 필수.
- 프레임은 두 계열:
  - **스트림 메시지** (`type: system|assistant|user|result|stream_event|rate_limit_event|…`)
    — CLI → 앱 단방향. §5.
  - **컨트롤 프로토콜** (`control_request` / `control_response` /
    `control_cancel_request` / `keep_alive`) — **양방향 RPC**. §4.
- 턴 시작 = 앱이 `{"type":"user",…}` 한 줄을 stdin에 쓴다.
  턴 끝 = CLI가 `{"type":"result",…}` 한 줄을 낸다.
- **stdin을 닫으면(EOF) CLI가 정리 후 종료한다.** 열어 두면 상주하고
  다음 `user` 줄로 다음 턴이 시작된다. 이것이 2.6.2 "상주 유지"의 전부다(§6.1).

---

## 1. CLI 실행 파일 찾기

### 1.1 2.6.2가 쓰는 경로

`engine.ts`는 SDK의 `query()`를 동적 로드하고(`versions.ts:326-344` `loadActiveQuery`),
CLI 경로는 **SDK가 스스로 해석**한다. Rust는 이 해석을 직접 해야 한다.

앱 홈 레이아웃 (실측):

```
~/.agentcodegui/
  config.json                      { "activeVersion": "0.3.239" }   ← versions.ts:76-88
  engines/
    0.3.239/
      manifest.json                { package, version, installedAt }  ← versions.ts:185-196
      node_modules/@anthropic-ai/
        claude-agent-sdk/
          manifest.json            { version:"2.1.239", commit, platforms{…} }
          sdk.mjs sdk.d.ts …
        claude-agent-sdk-win32-x64/
          claude.exe               ← ★ 이게 진짜 CLI
```

`versions.ts:101-113`(`packageDir`/`installedVersionAt`), `:127-146`(`listInstalled`/
`getState` — 설정된 버전이 없으면 **번들 폴백 없음**, `engine.ts:764-771`이 에러로
안내), `:288-302`(`cleanupOld` — 최신 1개만 남김).

### 1.2 SDK의 해석 규칙 (Rust가 재현할 것)

`sdk.mjs @943374` `function kB(e,t={})`:

```
platform=win32 → 후보 = ["@anthropic-ai/claude-agent-sdk-win32-<arch>/claude.exe"]
platform=linux → musl 우선 여부에 따라
                 ["…-linux-<arch>-musl/claude", "…-linux-<arch>/claude"] (또는 역순)
platform=android → ["…-linux-<arch>-android/claude"]
그 외(darwin)   → ["…-<platform>-<arch>/claude"]
첫 번째로 존재하는 파일을 채택. 하나도 없으면 에러.
```

**Rust 구현**: `engines/<active>/node_modules/@anthropic-ai/claude-agent-sdk-<plat>-<arch>/claude{.exe}`
를 직접 조립하고 `exists()`만 확인하면 된다(node resolve 불필요 — 설치 레이아웃이
평평하다. 실측 확인).

### 1.3 네이티브 vs 스크립트 (command/args 분기)

`sdk.mjs @941437` `function LIe(e){return![".js",".mjs",".tsx",".ts",".jsx"].some(n=>e.endsWith(n))}`

- **네이티브**(확장자가 위 목록에 없음, 즉 `claude.exe`):
  `command = <path>`, `args = [...executableArgs, ...flags]`
- **스크립트**(`cli.js` 등): `command = "node"`(bun 런타임이면 `"bun"`,
  `sdk.mjs @616506` `Ga()`), `args = [...executableArgs, <path>, ...flags]`

`sdk.mjs @934972`: `let ht=LIe(a),er=ht?a:o,Tt=ht?[...s,...Y]:[...s,a,...Y]`.

> 2.6.2는 `MAIN_VITE_CLAUDE_BIN` / `CLAUDE_BIN` env가 있으면 그 경로를
> `pathToClaudeCodeExecutable`로 넘긴다(`engine.ts:586`, `:919`). Rust도 같은 탈출구를
> 남길 것 — 디버깅에 쓰인다.

---

## 2. 스폰: argv · env · stdio

### 2.1 argv 전문 (푸시 **순서 그대로**)

원전: `sdk.mjs @931500‥935000` (`ProcessTransport.initialize()`).
`Tk(Y,k,v)` (`@926231`) = 값이 `-`로 시작하고 길이>1이면 `--k=v`, 아니면 `--k v` 두 토큰.

| # | 플래그 | 조건 | 출처 |
|---|---|---|---|
| 1 | `--output-format stream-json` | **항상** | `@931736` |
| 2 | `--verbose` | **항상** | `@931768` |
| 3 | `--input-format stream-json` | **항상** | `@931780` |
| 4 | `--thinking adaptive` / `--max-thinking-tokens <n>` / `--thinking disabled` | `thinking.type` = enabled(무예산)/enabled(예산)/disabled/adaptive | `@931806` |
| 5 | `--thinking-display <v>` | `thinking.type!=='disabled' && display` | `@932114` |
| 6 | `--effort <low\|medium\|high\|xhigh\|max>` | `options.effort` | `@932153` |
| 7 | `--max-turns <n>` | | 〃 |
| 8 | `--max-budget-usd <n>` | | 〃 |
| 9 | `--task-budget <n>` | | 〃 |
| 10 | `--model <id>` | `options.model` | 〃 |
| 11 | `--agent <name>` | | 〃 |
| 12 | `--betas a,b` | | 〃 |
| 13 | `--json-schema <json>` | | 〃 |
| 14 | `--debug-file <path>` \| `--debug` | | `@932489` |
| 15 | `--debug-file <auto>` | `!debugFile && !spawnClaudeCodeProcess` 이고 내부 `EB()`가 경로를 주면 | `@932600` |
| 16 | `--permission-prompt-tool stdio` | **`canUseTool` 콜백을 쓸 때** | `@932716` |
| 16' | `--permission-prompt-tool <name>` | 대신 이름을 줄 때 (둘 동시 지정 시 throw) | 〃 |
| 17 | `--continue` | `continueConversation` | `@932928` |
| 18 | `--resume=<sessionId>` | `resume` | `@932950` (**`=` 형식**) |
| 19 | `--channels <v>` × n | | `@932990` |
| 20 | `--allowedTools a,b` | 비어있지 않을 때 | `@933096` |
| 21 | `--disallowedTools a,b` | 〃 | 〃 |
| 22 | `--tools a,b` / `--tools ""` / `--tools default` | 배열/빈배열/그 외 | `@933200` |
| 23 | `--mcp-config <json>` | `{"mcpServers":{…}}` JSON 문자열 | `@933342` |
| 24 | `--setting-sources=a,b,c` | `settingSources !== undefined` | `@933414` (**`=` 형식**) |
| 25 | `--strict-mcp-config` | | 〃 |
| 26 | `--permission-mode <mode>` | | `@933520` |
| 27 | `--allow-dangerously-skip-permissions` | `allowDangerouslySkipPermissions` | 〃 |
| 28 | `--fallback-model <id>` | (모델과 같으면 throw) | `@933739` |
| 29 | `--include-hook-events` | | `@933800` |
| 30 | `--include-partial-messages` | `includePartialMessages` | `@933848` |
| 31 | `--session-mirror` | | `@933877` |
| 32 | `--add-dir <dir>` × n | `additionalDirectories` | `@933958` |
| 33 | `--plugin-dir <p>` / `--plugin-dir-no-mcp <p>` × n | | `@934010` |
| 34 | `--fork-session` | `forkSession` | `@934195` |
| 35 | `--resume-session-at=<uuid>` | | 〃 |
| 36 | `--resume-drops-turn=<bool>` | | 〃 |
| 37 | `--session-id=<id>` | | `@934409` |
| 38 | `--no-session-persistence` | `persistSession === false` | 〃 |
| 39 | `--managed-settings <json>` | | `@934600` |
| 40 | **`--settings <json>`** + extraArgs | 아래 참조 | `@934663` |

**#40 상세** (`@934663`):

```js
let Ye = {...extraArgs};
if (options.settings) Ye.settings = options.settings;   // ← 이미 JSON 문자열
let Et = xB(Ye, sandbox);                                // sandbox 없으면 그대로
for (const [k,v] of Object.entries(Et))
  if (v === null) Y.push(`--${k}`);                      // 값 없는 플래그
  else Tk(Y, k, v);                                      // --k v  (또는 --k=v)
```

`options.settings`는 `query()` 진입부에서 **객체면 `JSON.stringify`** 된다
(`sdk.mjs @1371800` `settings: typeof i==="object"?fe(i):i`).
`--settings`는 **경로 또는 인라인 JSON** 둘 다 받는다(`xB @925854`의
"Cannot use both a settings file path and the sandbox option" 분기가 증거,
그리고 §7 실측에서 인라인 JSON이 그대로 먹었다).

**`--skills`는 없다.** `options.skills`는 argv가 아니라 `allowedTools`에
`Skill(<name>)` 항목으로 접힌다(`@931640`) + `initialize` 페이로드의 `skills`로 간다.

### 2.2 2.6.2가 실제로 만드는 argv

`engine.ts:856-1024`의 옵션 → 위 표를 적용한 결과. (모델 `haiku`, effort `minimal`,
mode `normal`, 스킬/MCP 비활성 없음, addDirs 없음, resume 없음, outputStyle 미설정 예)

```
claude.exe
  --output-format stream-json
  --verbose
  --input-format stream-json
  --thinking disabled                    ← effortToOptions('minimal', 비-fable) engine.ts:223-226
  --model haiku                          ← req.model (ModelId: fable|opus|sonnet|haiku) protocol.ts:9
  --permission-prompt-tool stdio         ← canUseTool 제공 engine.ts:920
  --setting-sources=user,project,local   ← engine.ts:908
  --permission-mode default              ← modeToPermission(req.mode) engine.ts:228-241
  --include-partial-messages             ← engine.ts:910
  --settings {"permissions":{"defaultMode":"default"}}
```

옵션별 매핑 (engine.ts 근거):

| engine.ts 옵션 | 줄 | argv/컨트롤 반영 |
|---|---|---|
| `cwd` | 520, 858 | spawn의 cwd (플래그 아님) |
| `model: req.model` | 860 | `--model` |
| `permissionMode` | 559, 861 | `--permission-mode` |
| `settings.permissions.defaultMode` | 870 | `--settings` JSON. **CLI 플래그 계층은 user/project/local 설정을 이긴다** — 사용자의 `~/.claude/settings.json`이 `defaultMode:"auto"`여도 앱의 모드가 이긴다 (869 주석) |
| `settings.outputStyle` | 872-873 | `--settings` JSON에 `outputStyle:"Concise"` 등. 값 집합 = `Concise/Explanatory/Learning/Proactive` (`engine.ts:56`). '기본'은 **미주입** — 안 보낼 때만 `~/.claude`의 전역 outputStyle이 산다 (50-55 주석). 실측 init이 `output_style`, `available_output_styles:["default","Proactive","Concise","Explanatory","Learning"]`를 돌려준다(§7) |
| `settings.skillOverrides` | 874 | `--settings` JSON에 `{ "<skill-name>": "off", … }` (`skills.ts:137-143`) |
| `settings.deniedMcpServers` | 875 | `--settings` JSON에 `[{"serverName":"x"}, …]` (`mcp.ts:141-145`) |
| `additionalDirectories: req.addDirs` | 879 | `--add-dir` × n |
| `effort` / `thinking:{type:'disabled'}` | 881 | `--effort <lvl>` / `--thinking disabled`. `minimal` + `fable` 모델은 **아무것도 안 보냄** (Fable 5가 명시적 disabled에 400을 낸다 — 220-226 주석) |
| `resume: req.resume` | 884 | `--resume=<id>` |
| `forkSession` | 887 | `--fork-session` (`resume`이 있을 때만) — /btw 포크 |
| `allowDangerouslySkipPermissions` | 890 | `--allow-dangerously-skip-permissions`. **이게 없으면 `bypassPermissions` 모드는 무력** |
| `env` | 894-898 | §2.3 |
| `systemPrompt: {type:'preset',preset:'claude_code',append}` | 903-907 | **argv 아님** → `initialize` 컨트롤 요청. §4.2 |
| `settingSources` | 908 | `--setting-sources=user,project,local` |
| `includePartialMessages` | 910 | `--include-partial-messages` |
| `forwardSubagentText: true` | 914 | **argv 아님** → `initialize.forwardSubagentText` |
| `abortController` | 915 | 프로세스 kill 경로 |
| `pathToClaudeCodeExecutable` | 919 | §1.3 |
| `canUseTool` | 920 | `--permission-prompt-tool stdio` |
| `supportedDialogKinds: ['refusal_fallback_prompt']` | 929 | **argv 아님** → `initialize.supportedDialogKinds` |
| `onUserDialog` | 930 | `request_user_dialog` 컨트롤 요청 핸들러 |
| `stderr` | 1020 | stderr 라인 → `terminal` muted 이벤트 |

### 2.3 환경변수

`sdk.mjs @1370099` (query 진입) + `@934823` (transport):

```
base   = options.env ?? {...process.env}          ← 지정 시 process.env를 "대체"(merge 아님)
        CLAUDE_CODE_ENTRYPOINT       ??= "sdk-ts"
        CLAUDE_AGENT_SDK_VERSION     ??= "0.3.239"
        CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = "true"  (enableFileCheckpointing)
        CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH        = "1"      (getOAuthToken 제공)
        CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH    = "1"      (getHostAuthToken 제공)
        CLAUDE_CODE_QUESTION_PREVIEW_FORMAT      = …        (toolConfig)
        TRACEPARENT / TRACESTATE                            (OTel 전파 — 없으면 삭제)
transport:
        delete NODE_OPTIONS                        ← ★ 반드시. 남기면 CLI가 오작동
        DEBUG = "1"  (DEBUG_CLAUDE_AGENT_SDK 참일 때) / 아니면 delete DEBUG
```

**2.6.2가 추가로 넣는 것** (`engine.ts:849-852`, `:894-898`):

| 상황 | env |
|---|---|
| 구독(계정 오버라이드) | `CLAUDE_CONFIG_DIR = ~/.agentcodegui/accounts/<slug>` (`auth.ts:287-325` `accountRunDir`) |
| 구독 + 사용자가 "구독으로 실행" 선택 | 위 + `delete ANTHROPIC_API_KEY` (`engine.ts:852`) |
| API 모드 | `{...process.env, ANTHROPIC_API_KEY: <저장된 키>}` (`engine.ts:895`) |

**과금 경로 제어 (§7 실검증 질문에 대한 답)**

- **구독 토큰을 쓰게 하려면**: `CLAUDE_CONFIG_DIR`를 유효한 `.credentials.json`
  (`{"claudeAiOauth":{…}}`)이 있는 폴더로 두고 **`ANTHROPIC_API_KEY`를 지운다.**
  → init의 `apiKeySource == "none"` (실측 §7.2).
- **구독 토큰을 안 쓰게 하려면** 둘 중 하나:
  1. `ANTHROPIC_API_KEY=<키>` — 헤드리스 CLI는 TUI와 달리 **묻지 않고 env 키를
     OAuth보다 우선한다**(`engine.ts:790-795` 주석의 실측). init의 `apiKeySource`가
     `"ANTHROPIC_API_KEY"`가 된다.
  2. `CLAUDE_CONFIG_DIR=<자격증명 없는 빈 폴더>` — **0원 스모크**. init까지 정상으로
     오고 첫 assistant 프레임이 `"Not logged in · Please run /login"` + `error:
     "authentication_failed"`로 즉시 끝난다(실측 §7.1). 와이어 모양 검증에 최적.

> **`apiKeySource` 값 주의.** `sdk.d.ts:4771‥`의 `SDKSystemMessage.apiKeySource`
> JSDoc: 현재 CLI가 내는 값은 `'ANTHROPIC_API_KEY' | 'apiKeyHelper' |
> '/login managed key' | 'none'`. `'user'|'project'|'org'|'temporary'|'oauth'`는
> **레거시로 이제 안 나온다.** `engine.ts:2255-2257`의 `isApiKeyBilled`는
> `'oauth'`와 `'none'`만 구독으로 치므로 현행 CLI에선 `'none'`이 유일한 구독 신호다.
> Rust도 **화이트리스트(`none`/`oauth`) = 구독, 그 외 = API 과금**으로 유지할 것.

> **Windows 부수 env.** `sdk.mjs @1371241`: SDK의 `sessionStore` resume 경로는
> `CLAUDE_CONFIG_DIR`를 세팅할 때 win32에 한해
> `CLAUDE_SECURESTORAGE_CONFIG_DIR`도 같이 세팅한다. 2.6.2의 평범한 `env` 경로는
> 이걸 안 넣고도 3개월 이상 정상 동작 중이므로 **필수는 아니다**(§9 미지수 참고).

### 2.4 spawn 옵션

`sdk.mjs @929960` `spawnLocalProcess`:

```js
spawn(command, args, {
  cwd, env,
  stdio: ["pipe","pipe","pipe"],
  signal,                 // AbortSignal
  windowsHide: true       // ★ 콘솔창 깜빡임 방지 — Rust는 CREATE_NO_WINDOW
})
```

Rust(tokio):

```rust
let mut cmd = tokio::process::Command::new(&cli);
cmd.args(&flags).current_dir(&cwd)
   .env_clear().envs(&env)                 // env는 "대체" 의미론 — 반드시 전체를 준다
   .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
   .kill_on_drop(false);                   // 수명은 우리가 관리 (§8.5)
#[cfg(windows)] {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000 /* CREATE_NO_WINDOW */);
}
```

---

## 3. 와이어 프레이밍

### 3.1 규칙

- **읽기**: stdout을 줄 단위로 자른다. **빈 줄은 스킵**. 각 줄을 `JSON.parse`.
  파싱 실패 줄은 **버리고 계속** (죽지 않는다) — `sdk.mjs @939902`
  `for await(let n of e) if(n.trim()){ try{r=yt(n)}catch{ ln('Non-JSON stdout: '+n); continue } yield r }`.
- **쓰기**: `JSON.stringify(obj) + "\n"` 한 번에.
  `sdk.mjs @961239`(control), `@965183`(user 메시지) 모두 동일.
- **줄 길이 무제한**: 한 프레임이 수 MB일 수 있다(대용량 tool_result, 첨부).
  Rust의 `BufReader::lines()`는 무한 성장 → **상한(예: 64 MiB)을 걸고 초과 시
  그 줄을 버리고 에러 이벤트**로 흘릴 것.
- **stderr**: JSON 아님. 자유 텍스트. SDK는 tail 4096자만 보관
  (`kk=2048`, `this.stderrTail.length > 2*kk`면 잘라냄 — `sdk.mjs @930276`).
  2.6.2는 trim된 stderr 줄을 `terminal`(muted) 이벤트로 그대로 흘린다
  (`engine.ts:1020-1022`).
- **stderr 배수 순서 주의**: SDK는 `exit` 이벤트를 stderr가 완전히 드레인될 때까지
  미룬다(가짜 이벤트명 `"sdk-exit-after-stderr-drained"`, `@926293`; exit 후 stderr
  close가 안 오면 `PIe=200ms` 뒤 강제 발행). 즉 **"종료 코드"보다 stderr가 늦게 올 수
  있다** — Rust도 exit을 관측한 뒤 stderr를 마저 읽어야 마지막 진단이 안 사라진다.

### 3.2 stdin 수명 = CLI 수명

`sdk.mjs @965183` `streamInput`:

```js
for await (const msg of asyncIterable) { transport.write(JSON.stringify(msg) + "\n") }
// 이터러블이 끝나면:
if (sent>0 && hasBidirectionalNeeds()) await waitForFirstResult()
transport.endInput()      // = stdin.end()  ⇒ CLI가 정리 후 종료
```

2.6.2는 `promptStream()`이 **`closeInput()`이 불릴 때까지 절대 끝나지 않는**
무한 async generator다(`engine.ts:532-558`). 그래서 `endInput`이 안 불리고 CLI가
상주한다. 이것이 백그라운드 셸/워크플로/에이전트를 살려 두는 유일한 수단이다
(526-531 주석: "문자열 프롬프트는 result 후 SDK가 입력을 닫아 CLI가 죽는다").

---

## 4. 컨트롤 프로토콜 (양방향 RPC)

### 4.1 봉투

```jsonc
// 요청 (양쪽 다 보낼 수 있음)
{"type":"control_request","request_id":"<발신자가 고른 유일 id>","request":{"subtype":"…", …}}

// 응답 (요청 받은 쪽이 정확히 1개)
{"type":"control_response","response":{"subtype":"success","request_id":"…","response":{…}}}
{"type":"control_response","response":{"subtype":"error","request_id":"…","error":"사람이 읽는 사유"}}

// 취소 (요청 보낸 쪽이 철회 — 응답 없음)
{"type":"control_cancel_request","request_id":"…"}

// 하트비트 (양쪽 아무 때나 — 받으면 무시)
{"type":"keep_alive"}
```

근거: `sdk.d.ts:4024`(`SDKControlRequest`), `:4073`(`SDKControlResponse`),
`:308`(`ControlResponse`), `:285`(`ControlErrorResponse`), `:3305`
(`SDKControlCancelRequest`), `:4277`(`SDKKeepAliveMessage`).
SDK 구현: `sdk.mjs @961239`(`request()` — `request_id`는
`Math.random().toString(36).substring(2,15)`), `@951925`(`handleControlRequest`),
`@952695`(`handleControlCancelRequest`), `@952831`(`processControlRequest`).

**규약**
- 응답은 `request_id`를 **에코**한다. 모르는 `request_id`의 응답은 무시(단,
  SDK는 최대 1024개까지 "미매칭 응답"을 캐시했다가 나중에 매칭 —
  `UNMATCHED_CONTROL_RESPONSES_MAX=1024`, `@946184`. 응답이 요청 등록보다 먼저
  도착하는 레이스 방어).
- **중복 배달 방어**: 같은 `request_id`가 이미 처리 중이면 무시
  (`@951925` "Duplicate delivery of in-flight request … skipping").
- 모르는 subtype은 `subtype:"error"` 응답 — 단 `request_user_dialog`만 예외(§4.4).

### 4.2 앱 → CLI: `initialize` (**첫 프레임**)

**반드시 첫 user 메시지보다 먼저 쓴다.** SDK는 `Query` 생성자에서
`this.initialization = this.initialize()`를 즉시 부르고(`@947601`), 그 다음에
프롬프트를 쓴다(`@1373863` `MUt`: `xP(...)` → `vP(n,r,e,o)`).

```jsonc
{"type":"control_request","request_id":"init-1","request":{
  "subtype":"initialize",
  "hooks":            { "<HookEvent>": [ {"matcher":"…","hookCallbackIds":["hook_0"],"timeout":30} ] },
  "sdkMcpServers":    ["<in-process MCP 서버 이름>"],
  "jsonSchema":       {…},
  "systemPrompt":     ["<전체 교체 프롬프트>"],   // ★ 아래 주의
  "appendSystemPrompt":"<프리셋 뒤에 덧붙일 문자열>",
  "planModeInstructions":"…",
  "appendSubagentSystemPrompt":"…",
  "toolAliases":      {"foo":"Bash"},
  "excludeDynamicSections": false,
  "agents":           {"<name>": {…AgentDefinition}},
  "title":            "세션 제목",
  "skills":           ["dataviz","my-plugin:my-skill"],
  "webSearchIsolationExemptMcpServers":[…],
  "promptSuggestions": false,
  "agentProgressSummaries": false,
  "forwardSubagentText": true,
  "supportedDialogKinds": ["refusal_fallback_prompt"]
}}
```

필드 정의: `sdk.d.ts:3692-3766`. 페이로드 조립: `sdk.mjs @956259`.

**★ systemPrompt 3분기** (`sdk.mjs @1367632` `xP`):

| `options.systemPrompt` | `initialize.systemPrompt` | `appendSystemPrompt` |
|---|---|---|
| `undefined` | `[""]` (**빈 문자열 1개 배열**) | 없음 |
| `"문자열"` | `["문자열"]` | 없음 |
| `["a","b"]` | `["a","b"]` | 없음 |
| `{type:'preset',preset:'claude_code',append:"X"}` | **필드 자체 생략** | `"X"` |

즉 **2.6.2처럼 CLI 기본 페르소나를 쓰려면 `systemPrompt`를 아예 넣지 말고
`appendSystemPrompt`만 넣는다**(`engine.ts:903-907`). 넣으면 빈 시스템 프롬프트가
되어 코딩 에이전트 인격이 통째로 사라진다. **Rust 이식에서 가장 흔한 실수 지점.**

**성공 응답 페이로드** (실측 §7.2 — `sdk.d.ts`에 스키마 없음, 실측이 유일 원전):

```jsonc
{"type":"control_response","response":{"subtype":"success","request_id":"init-1","response":{
  "commands":[{"name":"deep-research","description":"…","argumentHint":""}, …],
  "agents":[…],
  "output_style":"default",
  "available_output_styles":["default","Proactive","Concise","Explanatory","Learning"],
  "models":[{"value":"default","resolvedModel":"claude-opus-5[1m]","displayName":"Default (recommended)",
             "description":"…","supportsEffort":true,
             "supportedEffortLevels":["low","medium","high","xhigh","max"],
             "supportsAdaptiveThinking":true,"supportsFastMode":true,"supportsAutoMode":true}, …],
  "account":{"email":"…","organization":"…","subscriptionType":"Claude Max","apiProvider":"firstParty"},
  "pid":22576,
  "current_permission_mode":"default",
  "remote_control_auto_enable":false,"remote_control_auto_on_by_default":false,
  "ide_rc_auto_enable_gate":false,
  "fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required",
  "session_state":"idle"
}}}
```

`models`/`account`는 **모델 picker와 계정 표시를 CLI 없이 얻는 유일한 경로**다
(2.6.2는 SDK의 `supportedModels()`/`accountInfo()`로 같은 값을 읽는다 —
`sdk.mjs @962673` `supportedModels()`). Rust는 이 응답을 캐시해 두면 별도 API
호출이 필요 없다.

**재초기화**: 이미 돌고 있는 세션에 `initialize`를 다시 보내면 CLI는 성공 응답
바로 뒤에 현재 `background_tasks_changed` 스냅샷을 (비어 있어도) 밀어 준다
(`sdk.d.ts:3131` JSDoc). 재접속 클라이언트가 레벨 신호를 잃지 않게 하는 장치.

**응답에 실릴 수 있는 곁가지**: `pending_permission_requests`,
`pending_user_dialog_requests` (`sdk.d.ts:298`,`:302`) — 이미 초기화된 세션에
붙었을 때 "떠 있는 승인/다이얼로그"를 복원용으로 재배달한다. `initialize`
**응답에서만** 의미가 있고 다른 subtype 응답에 오면 무시해야 한다
(`sdk.mjs @962039` `[Query] Ignoring prompt-redelivery fields on non-initialize response`).
받으면 각 항목을 **일반 `control_request`처럼 처리**한다(`@961239` 위 `processPending*`).
같은 `request_id`가 라이브 프레임으로도 또 올 수 있으니 **중복 렌더 방지 필수**.

### 4.3 앱 → CLI: 나머지 요청 subtype 전수

`sdk.mjs @947601‥963000` (Query 메서드) + `sdk.d.ts:4033` (`SDKControlRequestInner` 유니온).

| subtype | 페이로드 | 성공 응답 | 2.6.2 사용처 |
|---|---|---|---|
| `interrupt` | `{cancel_queued?:bool}` | `{still_queued?:string[], cancelled?:string[]}` | **`interruptTurn`/`cancel`** (`engine.ts:388`, `:449`) |
| `set_permission_mode` | `{mode}` | `{}` | 미사용(2.6.2는 모드 변경 시 재스폰) |
| `set_model` | `{model}` | `{}` | 미사용 |
| `set_max_thinking_tokens` | `{max_thinking_tokens, thinking_display}` | `{}` | 미사용 |
| `set_mcp_permission_mode_override` | `{serverName, mode}` | `{}` | 미사용 |
| `stop_task` | `{task_id}` | `{}` | **`bgTask({action:'stop'})`** (`engine.ts:370`) |
| `background_tasks` | `{tool_use_id?}` | `{backgrounded:bool}` | **`bgTask({action:'background'})`** = Ctrl+B (`engine.ts:372`) |
| `apply_flag_settings` | `{settings}` | `{}` | 미사용(재스폰으로 대체) |
| `get_settings` | `{}` | 설정 스냅샷(`applied.effort` 등) | 미사용 |
| `rewind_files` | `{user_message_id, dry_run?}` | | 미사용 |
| `cancel_async_message` | `{message_uuid}` | `{cancelled:bool}` | 미사용 |
| `seed_read_state` | `{path, mtime}` | `{}` | 미사용 |
| `set_cwd` | `{path, trust_accepted?, trusted_directory?}` | | 미사용 |
| `remote_control` | `{enabled, name?, reattach_session_id?, keep_session_on_exit?}` | | 미사용 |
| `submit_feedback` / `message_rated` / `generate_session_title` / `side_question` / `ultrareview_launch` | — | — | 미사용 |
| `mcp_message` | `{server_name, message}` (JSON-RPC) | `{}` | SDK-호스팅 MCP만. 2.6.2 미사용 |

`interrupt` 상세 (`sdk.d.ts:3768`):
- `cancel_queued:true`면 큐에 남은 uuid 스탬프 메시지까지 전부 `cancelled`로 닫고
  `still_queued`는 빈다. `false/생략`이면 큐가 살아남아 `still_queued`에 나열된다.
- 능력 광고: init의 `capabilities`에 `interrupt_receipt_v1`(응답에 `still_queued`),
  `interrupt_cancel_queued_v1`(`cancel_queued` 존중). **실측 §7.2에서 둘 다 확인.**
- 2.6.2는 `cancel_queued`를 안 쓴다(`engine.ts:388`, `:449`는 `interrupt()` 무인자).

### 4.4 CLI → 앱: 요청 subtype 전수

`sdk.mjs @952831` `processControlRequest`. **앱이 반드시 응답해야 하는 것들.**

#### (a) `can_use_tool` — 승인 게이트 ★핵심

`--permission-prompt-tool stdio`일 때만 온다.

```jsonc
{"type":"control_request","request_id":"<cli가 고름>","request":{
  "subtype":"can_use_tool",
  "tool_name":"Bash",
  "display_name":"Bash",
  "input":{"command":"npm test", …},          // 그 도구의 원본 입력
  "tool_use_id":"toolu_…",
  "agent_id":"…",                              // 서브에이전트 안이면
  "description":"…",                           // 카드 부제
  "title":"…",                                 // "Claude wants to read foo.txt"
  "permission_suggestions":[ …PermissionUpdate ],
  "blocked_path":"…",
  "decision_reason":"…",                       // ANSI 이스케이프 가능 — sanitize
  "decision_reason_type":"rule|mode|subcommandResults|permissionPromptTool|hook|
                          asyncAgent|sandboxOverride|workingDir|safetyCheck|classifier|other",
  "classifier_approvable":true,
  "matched_ask_rule":{"source":"…","tool_name":"…","rule_content":"…"},
  "suppress_always_allow_rule":true,
  "requires_user_interaction":true
}}
```

타입: `sdk.d.ts:3895-3970`. CLI 측 실제 조립(바이너리):
`claude.exe @326808008` `this.sendRequest({subtype:"can_use_tool",tool_name:t.name,
display_name:mFe(t.name),input:l,…description,permission_suggestions:c,
blocked_path:…,decision_reason:T,decision_reason_type:_?.type,…matched_ask_rule,
classifier_approvable:…,tool_use_id:i,agent_id:n.agentId,
suppress_always_allow_rule:…,requires_user_interaction:…})`.

**응답 = `PermissionResult`** (`sdk.d.ts:2218-2232`):

```jsonc
// 허용
{"type":"control_response","response":{"subtype":"success","request_id":"…","response":{
  "behavior":"allow",
  "updatedInput":{…},                 // 수정한 입력(없으면 원본 그대로 다시 넣어 줌)
  "updatedPermissions":[ … ],         // "항상 허용" 규칙
  "toolUseID":"toolu_…"               // SDK가 자동으로 덧붙임 — 아래 주의
}}}
// 거부
{"…":{"behavior":"deny","message":"모델이 읽을 사유","interrupt":false,"toolUseID":"toolu_…"}}
```

> **`toolUseID`**: SDK는 콜백 반환값에 `{...result, toolUseID: request.tool_use_id}`를
> **무조건 덧붙인다**(`sdk.mjs @953261`). Rust도 넣어 주는 게 안전하다.
> `null` 반환(= 응답을 아예 안 씀)은 "다른 경로로 이미 응답했다"는 뜻이며,
> 실수로 그러면 **툴이 영원히 막힌다 — 승인 요청에는 park deadline이 없다**
> (`sdk.d.ts:209-217` 경고).

**2.6.2의 게이트 정책** (`engine.ts:2188-2231`) — Rust가 그대로 옮길 것:

```
AskUserQuestion      → 항상 질문 카드 (모드 무관). 답을 deny.message로 되먹인다 (아래)
mode auto | bypass   → 무조건 allow(updatedInput=input)
READONLY_TOOLS       → allow           (engine.ts:207-210)
mode acceptEdits 이고 Bash도 MUTATING도 아님 → allow   (engine.ts:2203)
그 외                → 렌더러 카드 → allow / allow_always / deny
allow_always         → allow + updatedPermissions:[{type:"addRules",
                        rules:[{toolName}], behavior:"allow", destination:"session"}]
deny                 → {behavior:"deny", message: 사용자 문구 || "사용자가 거부했습니다."}
```

`READONLY_TOOLS` = Read, Grep, Glob, NotebookRead, WebFetch, WebSearch, TodoWrite,
Task, Agent, TaskCreate, TaskUpdate, TaskList, TaskGet, TaskStop, TaskOutput.
`MUTATING_TOOLS` = Write, Edit, MultiEdit, NotebookEdit, Bash, BashOutput, KillBash.

**AskUserQuestion 트릭** (`engine.ts:2164-2186`): `canUseTool`은 allow/deny만 가능
하므로, 질문 카드의 답을 **`deny` + `message`(선택 요약)** 로 돌려준다. 모델은 그
message를 tool_result로 읽고 이어 간다. `formatAnswers`(`engine.ts:2372-2388`)가
"사용자가 질문에 다음과 같이 답했습니다: …" 지시문을 만든다. 답을 안 하고 닫으면
"건너뛰었습니다. 합리적인 기본값으로 계속 진행하세요."

#### (b) `request_user_dialog` — 도구 주도 다이얼로그

```jsonc
{"…","request":{"subtype":"request_user_dialog","dialog_kind":"refusal_fallback_prompt",
                "payload":{…kind별 자유 형태},"tool_use_id":"…"}}
```

`sdk.d.ts:4057-4072`. **`initialize.supportedDialogKinds`에 선언한 kind만 온다.**
선언하지 않으면 CLI는 "표시 불가"로 보고 fail-closed — `refusal_fallback_prompt`의
경우 그냥 거부 에러로 턴이 죽는다(`engine.ts:921-929` 주석과 일치).

응답:
- 렌더 가능 → `{behavior:"completed", result:"retry_fallback"}` 등 kind별 값
- 사용자가 닫음/거절 → `{behavior:"cancelled"}` (CLI가 그 다이얼로그의 기본 동작 적용)
- **선언하지 않은 kind가 왔으면 응답하지 말 것.** `cancelled`는 "사용자가 닫았다"는
  진짜 정착으로 취급된다. 무응답이면 CLI의 dialog deadline이 알아서 취소한다.

2.6.2의 `refusal_fallback_prompt` 처리 (`engine.ts:930-1019`):
payload에서 `originalModel`/`fallbackModel`/`apiRefusalCategory`를 읽어 질문 카드를
띄우고 → 계속을 고르면 `{behavior:'completed', result:'retry_fallback'}` + 앱 쪽
`model-fallback` 이벤트(스트리밍 중이던 거부된 말풍선 `retractMessageId`로 회수) →
중단이면 `{behavior:'cancelled'}` + 안내 notice.

#### (c) `hook_callback`

```jsonc
{"…","request":{"subtype":"hook_callback","callback_id":"hook_0","input":{…HookInput},"tool_use_id":"…"}}
```
`sdk.d.ts:4204-4212`. `initialize.hooks`로 등록한 `hookCallbackIds`를 CLI가 되부른다.
2.6.2는 훅을 안 쓴다 → `initialize.hooks` 생략 → 이 요청 자체가 안 온다.

#### (d) `mcp_message`

```jsonc
{"…","request":{"subtype":"mcp_message","server_name":"x","message":{…JSON-RPC 2.0}}}
```
`sdk.d.ts:3851-3862`. **양방향**: CLI→앱(in-process MCP 서버로 배달, 응답은
`{"mcp_response":{…JSON-RPC 응답}}`), 앱→CLI(그 서버가 스스로 낸 메시지 전달,
CLI는 빈 success로 ack). `initialize.sdkMcpServers`에 이름을 안 넣으면 안 온다.
2.6.2 미사용.

#### (e) `elicitation`

`{subtype:"elicitation", mcp_server_name, message, mode, url, elicitation_id,
requested_schema, title, display_name, description}`. 핸들러 없으면
`{action:"decline"}` (`sdk.mjs @954590`). 2.6.2 미사용.

#### (f) `oauth_token_refresh` / `host_auth_token_refresh`

`CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1` env를 넣었을 때만 온다.
응답 `{accessToken: string|null, reason?}` / `{authToken: string|null}`.
2.6.2는 env를 안 넣으므로 안 온다 — **CLI가 `CLAUDE_CONFIG_DIR/.credentials.json`을
직접 리프레시한다.** 그래서 턴이 끝나면 그 파일을 되읽어 암호화 백업에 반영한다
(`engine.ts:1817-1825` → `auth.ts:328-350` `syncAccountTokens`; 만료시각이 후퇴하는
"껍데기 토큰" 가드 포함).

---

## 5. 스트림 메시지 사전 (CLI → 앱)

유니온 전체: `sdk.d.ts:4334` `SDKMessage`. 아래는 **`engine.ts`가 실제로 소비하는
필드 전수** + 실측으로 확인된 추가 필드.

공통: 거의 모든 프레임에 `uuid: string`, `session_id: string`이 붙는다.

### 5.1 `system` / `init`  (`sdk.d.ts:4771`)

턴마다 **가장 먼저** 온다.

```jsonc
{"type":"system","subtype":"init",
 "session_id":"ebfe31d4-…","cwd":"C:\\…","model":"claude-haiku-4-5-20251001",
 "permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.239",
 "output_style":"default",
 "tools":["Task","AskUserQuestion","Bash",…,"Write"],
 "mcp_servers":[{"name":"…","status":"…"}],
 "slash_commands":[…], "terminal_slash_commands":["doctor","color"],
 "agents":["claude","Explore","general-purpose","Plan","statusline-setup"],
 "skills":[…], "plugins":[{"name","path","version?"}],
 "capabilities":["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"],
 "betas":[…], "effort":"high"|null,
 "fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required",
 "analytics_disabled":true,"product_feedback_disabled":true,
 "memory_paths":{"auto":"…\\memory\\"},
 "uuid":"…"}
```

`engine.ts:1271-1327` 소비:
- `session_id` → `session` 이벤트 + `bgSessionId`(백그라운드 출력파일 경로 유도) +
  **세션이 바뀌면 taskMap/taskSeq 리셋**(1275-1279).
- `model` → 모델 전환 감지의 기준점(`modelKey` — 풀 id일 때만, 1290).
- `cwd`, `tools` → `session` 이벤트.
- `apiKeySource` → 과금 경로 확정(`runApiKeySource`), 불일치 배너(1296-1325).
- `capabilities`는 **feature detection용 열린 집합** — 모르는 값은 무시.

### 5.2 `system` / `status`  (실측 발견, `sdk.d.ts`에 `SDKStatusMessage`)

```jsonc
{"type":"system","subtype":"status","status":"requesting","uuid":"…","session_id":"…"}
```
`engine.ts`는 **처리하지 않는다**(무해하게 흘러 감). Rust도 무시해도 되지만
"모델 호출 대기 중" 스피너를 앞당기고 싶으면 쓸 수 있다.

### 5.3 `stream_event` — 부분 스트리밍  (`sdk.d.ts:4479`)

`--include-partial-messages`일 때만. `event`는 **Anthropic Messages API 스트리밍
이벤트 원문**.

```jsonc
{"type":"stream_event","parent_tool_use_id":null,"session_id":"…","uuid":"…","ttft_ms":1051,
 "event":{"type":"message_start","message":{"model":"…","id":"msg_…","usage":{…}}}}
{"…","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}
{"…","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}}
{"…","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"…"}}}
{"…","event":{"type":"content_block_stop","index":0}}
{"…","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{…}}}
{"…","event":{"type":"message_stop"}}
```

`engine.ts:1571-1613` 소비:
- **`parent_tool_use_id`가 있으면 즉시 `continue`** — 사이드체인 델타를 메인
  말풍선에 섞지 않는다(1573-1574). ★§6.5
- `text_delta` → `assistant-stream`(누적 messageId `a m<launch>-<n>`), 생각줄 닫기.
- `thinking_delta` → `thinking` 한 줄(누적 90자 요약). **앞 90자가 다 차면 이후
  델타는 무시**(1592-1599 — 렌더 낭비 방지).
- `content_block_start` + `content_block.type==='tool_use'` → 도구별 진행 라벨
  ("파일 작성 중" 등, `toolGenLabel`). Write의 파일 본문이 `input_json_delta`로
  수 초간 흐르는 동안 화면이 얼어 보이는 구멍을 메운다(1601-1611).

**★순서 주의 (실측)**: `content_block_delta` → **`assistant`(완성본)** →
`content_block_stop` → `message_delta` → `message_stop`.
즉 완성 `assistant` 프레임이 `content_block_stop`보다 **먼저** 온다.

### 5.4 `assistant`  (`sdk.d.ts:3062`)

```jsonc
{"type":"assistant",
 "message":{"model":"claude-haiku-4-5-20251001","id":"msg_…","role":"assistant","type":"message",
            "content":[{"type":"text","text":"OK"}],
            "stop_reason":null,"stop_sequence":null,"stop_details":null,
            "usage":{"input_tokens":3,"cache_creation_input_tokens":25251,
                     "cache_read_input_tokens":0,"output_tokens":1,
                     "cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":25251},
                     "service_tier":"standard","inference_geo":"not_available"},
            "context_management":null},
 "parent_tool_use_id":null,"session_id":"…","uuid":"…","request_id":"req_…",
 "timestamp":"2026-08-22T03:48:15.318Z",
 "error":"authentication_failed",       // 선택 — SDKAssistantMessageError
 "subagent_type":"Explore","task_description":"…",
 "supersedes":["<회수할 uuid>"], "aborted":true, "resumed_from_incomplete_thinking":true}
```

- **스트리밍 중에는 완성 블록 1개당 assistant 프레임 1개**가 오고, 여러 프레임이
  같은 `message.id`를 공유하며 `stop_reason`은 아직 `null`이다(`sdk.d.ts:3062` JSDoc).
- `error`는 `authentication_failed | oauth_org_not_allowed | account_on_hold |
  billing_error | rate_limit | overloaded | invalid_request | model_not_found |
  server_error | unknown | max_output_tokens` (`sdk.d.ts:3117`).

`engine.ts:1615-1726` 소비:
- **`parent_tool_use_id || subagent_type` → 사이드체인 분기 전담**(1624-1654). ★§6.5
- `message.model` → 세션 중 모델 전환 감지(`modelKey` 비교, 1659-1676) →
  `model-fallback` 이벤트. `[1m]` 변형은 표시명이 같아 안 걸린다.
- `message.usage` → **라이브 컨텍스트 게이지**:
  `input + cache_read + cache_creation + output` (`contextFromUsage` 82-86).
  result의 usage는 **런 누적**이라 절대 게이지에 쓰지 않는다(1027-1031, 1086-1088).
- content 블록: `thinking`(스트림이 안 왔을 때만) / `text`(→`assistant-done`) /
  `tool_use`(→`handleToolUse`, 첫 도구에서 status `working`).

### 5.5 `user`  (`sdk.d.ts:4966`, replay는 `:5016`)

```jsonc
{"type":"user","message":{"role":"user","content":[{"type":"tool_result",
   "tool_use_id":"toolu_…","content":"…"|[{type:"text",text:"…"}],"is_error":false}]},
 "parent_tool_use_id":null,"session_id":"…","uuid":"…","isSynthetic":true,
 "tool_use_result":{…구조화 출력…},"timestamp":"…",
 "isReplay":true,"file_attachments":[…]}
```

- **앱이 쓰는 것과 같은 타입**. 프롬프트 전송이 곧 `type:"user"` 한 줄.
- CLI가 내는 user 프레임은 두 종류:
  1. **tool_result** — 도구 실행 결과. `parent_tool_use_id`가 있으면 사이드체인.
  2. **텍스트** — CLI가 주입한 정착 통지(`<task-notification>`) 또는 큐에 밀린
     사용자 메시지의 재생(replay).
- `tool_use_result`는 도구의 **구조화 출력 전체**(모델에 간 문자열이 아니라).
  Agent/Task는 서브에이전트 최종 보고 + 런 합계가 들어온다. 2.6.2 미사용.

`engine.ts:1728-1757` 소비:
- 메인체인 텍스트 프레임에서 `<task-notification>` 감지 →
  `/<task-id>([^<]+)<\/task-id>/g`로 task id 수집 → `deliveredNotifs`(1740-1742).
  **CLI가 실제로 쓰는 템플릿** (`claude.exe @306259558`):
  ```xml
  <task-notification>
  <task-id>{agentId}</task-id>
  <status>completed|failed|killed|blocked</status>
  …
  ```
  `<system-reminder>` 안에 감싸여 **user-role 메시지**로 온다.
- 텍스트 프레임을 보면 보류 중이던 무음 result를 **버린다**(턴이 이어진다는 증거,
  1745-1749).
- `tool_result` 블록 → `handleToolResult`.

### 5.6 `result`  (`sdk.d.ts:4601` error / `:4637` success)

```jsonc
{"type":"result","subtype":"success","is_error":false,
 "duration_ms":1131,"duration_api_ms":1092,"ttft_ms":1120,"ttft_stream_ms":1090,
 "time_to_request_ms":40,"num_turns":1,"stop_reason":"end_turn",
 "result":"OK","total_cost_usd":0.050525,
 "usage":{…메인루프 누적…},
 "modelUsage":{"claude-haiku-4-5-20251001":{
    "inputTokens":3,"outputTokens":4,"cacheReadInputTokens":0,"cacheCreationInputTokens":25251,
    "webSearchRequests":0,"costUSD":0.050525,"contextWindow":200000,"maxOutputTokens":32000,
    "canonicalModel":"claude-haiku-4-5","provider":"firstParty"}},
 "permission_denials":[],"terminal_reason":"completed",
 "subagent_stats":{"spawned":0,"requested":{…},"killed":{…},"refused":{…},"by_type":{}},
 "api_error_status":null,"fast_mode_state":"off","session_id":"…","uuid":"…"}
```

에러 계열: `subtype`이 `error_during_execution | error_max_turns |
error_max_budget_usd | error_max_structured_output_retries`이고 `result` 대신
**`errors: string[]`**.

> **함정**: `subtype:"success"`인데 `is_error:true`일 수 있다(실측 §7.1 —
> 미로그인). **`is_error`가 진실**이다. `engine.ts:1080-1085`가 정확히 그렇게 읽는다:
> `is_error ? (errors?.join('; ') ?? result ?? '실행 실패') : (result ?? '')`.

`engine.ts:1079-1135` 소비:
- 컨텍스트 게이지는 `lastContextTokens`(마지막 assistant usage), **result.usage 아님**.
- 컨텍스트 창 크기 = `max(modelUsage[*].contextWindow)` (`windowFromModelUsage` 98-106
  — 서브에이전트가 작은 창 모델이면 여러 개가 오므로 최대값).
- 모델별 토큰 = `modelUsage` → 표시명으로 접어 합산(`tokenUseFromResult` 112-143;
  전부 0이면 `usage`를 현재 모델 하나로 폴백).
- **누적 의미**: `total_cost_usd`/`modelUsage`는 **스트리밍 입력 세션에서 턴을
  가로질러 누적**된다 — 마지막 result만 읽고 더하지 말 것(`sdk.d.ts:4646` JSDoc).
  2.6.2는 턴마다 `addSpend(total_cost_usd)`를 하는데, 이건 **상주 다중 턴에서
  중복 가산**이 된다(§9 미지수 후보였으나 실사용상 상주는 백그라운드 있을 때뿐).

### 5.7 `system` / `compact_boundary`  (`sdk.d.ts:3159`)

```jsonc
{"type":"system","subtype":"compact_boundary",
 "compact_metadata":{"trigger":"auto"|"manual","pre_tokens":152000,"post_tokens":…,
   "duration_ms":…,"preserved_segment":{…},"preserved_messages":{…}},
 "uuid":"…","session_id":"…"}
```

`engine.ts:1372-1379`: **여기서 바로 안 내보낸다.** 압축 후 컨텍스트는 *다음*
assistant 프레임의 usage가 처음 반영하므로 보류했다가 그 프레임과 짝지어
`compact{trigger, preTokens, afterTokens}`를 **게이지 하락보다 먼저** 낸다
(1681-1688). 짝 없이 턴이 끝나면 `afterTokens:null`로 흘린다(1112-1117).

### 5.8 `system` / `model_refusal_fallback`  (`sdk.d.ts:4411`)

```jsonc
{"type":"system","subtype":"model_refusal_fallback","trigger":"refusal",
 "direction":"retry","scope":"session"|"local",
 "original_model":"claude-fable-5","fallback_model":"claude-opus-5",
 "request_id":"…","api_refusal_category":"cyber"|null,"api_refusal_explanation":"…"|null,
 "retracted_message_uuids":["…"],"refused_user_message_uuid":"…"|null,"content":"…"}
```

`engine.ts:1334-1349`: 다이얼로그 경로(§4.4b)가 이미 배너를 냈으면
`pendingFallbackNotices--`로 **삼킨다**. CLI가 묻지 않고 스스로 전환한 경우만
여기서 배너. **여기서는 절대 회수(retract)하지 않는다** — 턴 끝 시점의 라이브
스트림 id는 이미 재시도된(좋은) 답변의 것일 수 있다(1332-1333 주석).

### 5.9 `system` / `notification`  (`sdk.d.ts:4464`)

```jsonc
{"type":"system","subtype":"notification","key":"…","text":"…",
 "priority":"low|medium|high|immediate","color":"…","timeout_ms":…}
```
`engine.ts:1355-1359`: `text.trim()`이 있으면 그대로 `notice`.

### 5.10 `system` / `informational`  (`sdk.d.ts:4254`)

```jsonc
{"type":"system","subtype":"informational","content":"…",
 "level":"info|notice|suggestion|warning","tool_use_id":"…","prevent_continuation":true}
```
`engine.ts:1360-1367`: **`level`이 `warning|suggestion`이고 `tool_use_id`가 없을 때만**
`notice`로. `info`(transcript 전용)와 `notice`(도구 진행줄)는 소란해서 버린다.

### 5.11 `system` / `background_tasks_changed`  (`sdk.d.ts:3131`) ★REPLACE

```jsonc
{"type":"system","subtype":"background_tasks_changed",
 "tasks":[{"task_id":"…","task_type":"local_bash|local_agent|local_workflow|…",
           "description":"…"}],
 "uuid":"…","session_id":"…"}
```

CLI 측 emitter (`claude.exe @318218561`):
```js
function R8l(e){return Object.values(e.tasks).filter(t=>bO(t)&&!cx(t))
  .map(t=>({task_id:t.id,task_type:t.type,description:t.description}))}
function cgo(e){nk({type:"system",subtype:"background_tasks_changed",tasks:R8l(e)})}
```

**의미론 (JSDoc 원문 요지, `sdk.d.ts:3131`)**:
- **레벨 신호**. 멤버십이 바뀔 때마다 **살아 있는 전체 집합**이 온다.
  `task_started`/`task_notification`이라는 에지 북엔드와 **짝맞추지 말고 통째로
  교체**하라 — 북엔드 하나를 놓쳐도 스피너가 굳지 않는다.
- 같은 전이에 대한 **레벨과 에지의 순서는 미정의**(실무상 레벨이 먼저).
- 페이로드는 **id만** 실린다 — 에지 스트림과 상관짓지 말 것.
- **프로세스 단위**: 기동 시엔 아무것도 안 온다. CLI가 (재)시작되면 **빈 집합으로
  리셋**하고 다음 변화가 채우게 둘 것.
- 이미 돌던 프로세스에 `initialize`를 다시 보내면 성공 응답 뒤에 (빈 것이라도)
  스냅샷을 보내 준다.

`engine.ts:1385-1426` 소비:
- 목록에서 **빠진** 추적 대상 → `pendingSettles`에 넣고 `wfNotifySeq=frameSeq`
  (정착 통지는 목록이 빈 **뒤에** 오므로 여기서 바로 닫으면 보고 턴이 잘린다).
- `task_type`으로 3분류: `/workflow/i` → `liveWorkflows`,
  `/bash|shell/i` → `liveBgIds`(셸 칩), 나머지 → `liveBgAgents`.
- 셸만 `bg-tasks` 이벤트로(같은 REPLACE 의미).
- `outputFile` 후보 = `%TEMP%\claude\<cwd 영숫자 외 '-' 치환>\<session>\tasks\<task_id>.output`
  (1383-1387 — CLI 실측 규칙, 종료 통지의 실제 경로가 오면 덮인다).
- 마지막 하나가 걷힌 REPLACE면 `maybeCloseInput()`.

### 5.12 `system` / `task_started`  (`sdk.d.ts:4870`)

```jsonc
{"type":"system","subtype":"task_started","task_id":"…","tool_use_id":"toolu_…",
 "description":"…","subagent_type":"…","is_backgrounded":true,"spawn_depth":1,
 "task_type":"local_agent","workflow_name":"spec","prompt":"…","skip_transcript":true}
```
`engine.ts:1473-1478`: `tool_use_id → task_id` 매핑만 등록(`liveTaskByToolUse`).
이 매핑이 "서브에이전트 tool_result가 **백그라운드 시작 접수증**인지"를 문구 스니핑
없이 판정하게 해 준다(2079).

### 5.13 `system` / `task_progress` + **`workflow_progress`** (문서화 안 됨)

`sdk.d.ts:4848`의 `SDKTaskProgressMessage`에는 **`workflow_progress`가 없다.**
그러나 CLI는 낸다 — 바이너리 emitter (`claude.exe @312434010`):

```js
function fQr(e){nk({type:"system",subtype:"task_progress",task_id:e.taskId,
  tool_use_id:e.toolUseId,description:e.description,subagent_type:e.subagentType,
  usage:{total_tokens:e.totalTokens,tool_uses:e.toolUses,duration_ms:Date.now()-e.startTime},
  last_tool_name:e.lastToolName,summary:e.summary,
  workflow_progress:e.workflowProgress})}
```

`workflow_progress`는 **매번 전체 스냅샷** 배열이고 두 종류가 섞여 온다
(`claude.exe @312777420`, `@312781616`):

```jsonc
{"type":"workflow_phase","index":1,"title":"설계","kind":"…"}
{"type":"workflow_agent","index":3,"label":"…","phaseIndex":1,"phaseTitle":"설계",
 "agentType":"…","isolation":"worktree"|"remote"|undefined,
 "model":"claude-opus-5","state":"queued|running|done|error",
 "blocked":true,"error":"…","agentId":"…","cached":true,
 "queuedAt":…,"startedAt":…,"lastProgressAt":…,
 "promptPreview":"…","resultPreview":"…"}
```

`engine.ts:1430-1471` 소비: `workflow_progress`가 실린 `task_progress`만 보드
이벤트(`workflow`)로 승격. 그 외 `task_progress`는 하트비트라 버린다.
`note` = 실행 중이면 `promptPreview`, `state==='done'`이면 `resultPreview`(140자).
`usage.{total_tokens,tool_uses,duration_ms}`가 카드 하단 수치.

### 5.14 `system` / `task_notification`  (`sdk.d.ts:4830`)

```jsonc
{"type":"system","subtype":"task_notification","task_id":"…","tool_use_id":"toolu_…",
 "status":"completed|failed|stopped","output_file":"…","summary":"…",
 "usage":{"total_tokens":…,"tool_uses":…,"duration_ms":…},"skip_transcript":true}
```

`engine.ts:1481-1568` 소비 — **2.6.2에서 가장 조밀한 분기**:
1. `byUser`(사용자가 중지 버튼) → `pendingSettles`에서 **즉시 제거**(보고 턴 없음).
2. 아니면 추적한 적 있는 id(`wfIds|liveWorkflows|liveBgAgents|liveBgIds|pendingSettles`)
   → `pendingSettles.add` + `wfNotifySeq=frameSeq` (**보고 턴 대기**).
3. 워크플로면 스냅샷을 `status`로 마감. `summary`는 **진행 프레임의 원문을 지킨다**
   (통지 문장은 `Dynamic workflow "…" completed` 꼴이라 중복).
   직접 중지 or 진행 중 턴이면 즉시 emit, **유휴 상주면 `wfSettledEmits`로 미룬다**
   (렌더러 전송 게이트가 `wf.status==='running'`에 매달려 있어, 정리 턴 전에
   settled를 내면 새 전송이 끼어들어 정리 턴을 자른다 — 641-651 주석).
4. `bg-task-end{status, summary, outputFile, atTurnEnd: this.turnEnded, byUser}`.
   `atTurnEnd`가 '중지됨' vs '턴 종료로 정리됨'을 가른다.
5. `tool_use_id`가 추적 중인 서브에이전트면 **여기가 진짜 완료** — Task의
   tool_result는 접수증으로 먼저 돌아오기 때문(1537-1564).

### 5.15 `rate_limit_event`  (실측 발견 — `engine.ts` 미사용)

```jsonc
{"type":"rate_limit_event","rate_limit_info":{
   "status":"allowed","resetsAt":1787377200,"rateLimitType":"five_hour",
   "overageStatus":"rejected","overageDisabledReason":"org_level_disabled",
   "isUsingOverage":false},
 "uuid":"…","session_id":"…"}
```
**Rust 기회**: 2.6.2는 한도를 별도 usage API로 폴링한다. 이 프레임을 쓰면
턴 중에 공짜로 한도/리셋 시각을 얻을 수 있다(한도 자동 이어서 기능과 직결).

### 5.16 그 밖의 유니온 멤버 (2.6.2 미소비 — **무시하되 죽지 말 것**)

`sdk.d.ts:4334`: `SDKStatusMessage`, `SDKAPIRetryMessage`,
`SDKControlRequestProgressMessage`(`type:"system",subtype:"control_request_progress"` —
`sdk.d.ts:4038`), `SDKModelRefusalNoFallbackMessage`, `SDKLocalCommandOutputMessage`,
`SDKHookStartedMessage`/`HookProgress`/`HookResponse`, `SDKPluginInstallMessage`,
`SDKToolProgressMessage`, `SDKAuthStatusMessage`, `SDKTaskUpdatedMessage`,
`SDKThinkingTokensMessage`, `SDKSessionStateChangedMessage`,
`SDKWorkerShuttingDownMessage`, `SDKCommandsChangedMessage`, `SDKFilesPersistedEvent`,
`SDKToolUseSummaryMessage`, `SDKMemoryRecallMessage`, `SDKRateLimitEvent`,
`SDKElicitationCompleteMessage`, `SDKPermissionDeniedMessage`,
`SDKPromptSuggestionMessage`, `SDKMirrorErrorMessage`, `SDKConversationResetMessage`.

**추가로 SDK가 스트림에서 가로채는(사용자에게 안 주는) 프레임**
(`sdk.mjs @949793`):
- `type:"transcript_mirror"` → 전사 미러 배처로
- `type:"system", subtype:"commands_changed"` → 최신 커맨드 목록 캐시
- `type:"active_goal"`, `type:"autocompact_state"`, `system/post_turn_summary`,
  `system/task_summary` → 그대로 소비자에게 전달

**Rust 규칙: 모르는 `type`/`subtype`은 조용히 버린다.** 절대 에러로 승격 금지 —
CLI는 스키마보다 먼저 새 프레임을 낸다.

---

## 6. 2.6.2 실전 의미론 → "와이어에서 무슨 일이 벌어지는가"

### 6.1 상주 유지(resident) — 입력 스트림을 안 닫는다

| 앱 동작 | 와이어 |
|---|---|
| `run()` 첫 호출 | spawn → `control_request initialize` → `{"type":"user",…}` |
| result 도착, 백그라운드 없음 | `maybeCloseInput()` → **stdin EOF** → CLI 정리·종료 |
| result 도착, 셸/워크플로/에이전트 살아있음 | **stdin 계속 열림.** CLI는 살아 있고, 작업이 끝나면 스스로 `<task-notification>` user 프레임을 주입하고 **보고 턴**(assistant/result)을 낸다 |
| 다음 메시지 | 새 spawn 대신 **같은 stdin에 `{"type":"user",…}` 한 줄 더** (`injectFn`) |

`engine.ts:658-663` `maybeCloseInput`:
```
!liveWorkflows.size && !liveBgIds.size && !liveBgAgents.size
  && !pendingSettles.size && turnEnded  →  closeInput()
else armHoldIdle()
```

**주입 게이트 `optsMatch`** (`engine.ts:1185-1200`) — 스폰 시점에만 정할 수 있는
옵션이 **전부** 같아야 주입한다:

```
ncwd === cwd
nreq.resume === bgSessionId          ← ★ init이 준 session_id와 비교
nreq.model === req.model
nreq.mode  === req.mode
nreq.effort === req.effort
!!nreq.useApi === useApi
(nreq.account ?? null) === (req.account ?? null)
(nreq.systemPrompt?.trim() ?? '') === (req.systemPrompt?.trim() ?? '')
JSON.stringify(nreq.addDirs ?? []) === JSON.stringify(req.addDirs ?? [])
claudeOutputStyle() === outputStyle   ← 스폰 시점 값과 "지금 디스크 값" 비교
```

불일치 → `injectMissReason='opts'` → 새 스폰(= 그 백그라운드 작업 전부 사망) +
**스레드에 사유 안내**(`engine.ts:569-584`). 조용히 죽이면 "작업이 증발했다"로 보인다.

**`busy` 미스의 특수 처리** (`engine.ts:490-502`): 턴이 진행 중이면 바로 자르지 말고
`waitTurnEnd(15s)` 후 **재주입 시도**. 여기서 `cancel()`로 자르면 CLI째 죽어 그
작업들이 고아 통지로 남고, 다음 턴이 그 통지를 소화하다 또 죽는 **꼬임 루프**의
연료가 된다(실측 2026-08-03, 릴리즈 빌드 3연속 사망).

**상주 안전망** (`engine.ts:681-732`) — "지킬 게 없는데 영영 안 닫히는" 릭만 막는다:
- 셸/워크플로가 살아 있으면 **타이머를 아예 안 건다**(dev 서버·긴 단계는 조용한 게 정상).
- 보고 턴 대기(`pendingSettles`)만 남음 → **10분** 무소식이면 닫는다.
- 에이전트만 남음 → **30분** 무프레임. 단 **발화 시점에 재검증**하고,
  전사 파일(`<config>/projects/<cwd 슬러그>/<session>/subagents/**`)이 10분 내
  쓰였으면 재장전(`agentsRecentlyActive` 685-713 — 최대 400개만 얕게 훑음).
- 프레임이 흐르는 동안은 매 프레임 `armHoldIdle()`로 재장전(1238).

### 6.2 소프트 중단 (Esc / 중지) vs 하드 취소

**`interruptTurn()`** (`engine.ts:438-459`) — **프로세스를 죽이지 않는다**:
```
1. 진행 중 아니거나 turnEnded면 즉시 return
2. interruptRequested = true            ← 삼킴 리플레이 금지 표식
3. 떠 있는 승인/질문 waiter 전부 해제(deny/null)
4. control_request {"subtype":"interrupt"}  ... 4초 레이스
5. waitTurnEnd(6초) — ★ 접수만으론 부족, 중단된 턴의 result 프레임까지 봐야 끝
6. 안 오면 → cancel() 강등
```

**`cancel()`** (`engine.ts:379-416`) — 프로세스 정리:
```
1. interruptRequested = true
2. turnEnded가 false일 때만 interrupt 전송(1.5초 레이스)
   ★ result 후 정리 유예(~5s) 중인 CLI는 응답할 턴이 없어 조용히 막힌다
     (답변 직후 보낸 다음 메시지가 몇 초 "씹히는" 주범이었다)
3. closeInput()  → stdin EOF
4. abort()       → 프로세스 kill 경로
5. 대기자 전부 해제
6. runLoop 종료를 최대 5초 대기 (두 CLI가 잠깐 공존하는 것 방지)
```

**왜 소프트인가**: 프로세스째 죽이면 백그라운드 작업이 **고아 통지**로 남고,
다음 CLI가 그걸 소화하다 턴 종료 직후 사망하는 루프가 된다(실측 2026-08-03,
`engine.ts:432-437` 주석).

### 6.3 고아 통지 재주입 (`tryNotifReplay`)

**증상** (실측 2026-08-13, `engine.ts:1137-1146`): 고아/밀린 `<task-notification>`을
소화하는 기상 턴이 사용자 프롬프트와 한 턴으로 묶이면 모델이 통지 규약대로
**`"No response requested."`** 만 내고 프롬프트를 삼킨다. 렌더러엔 "응답 없이
끝났어요"만 남고 메시지가 증발.

> 그 문자열은 CLI 상수다 — `claude.exe`: `var XH="(no content)", tQ="No response
> requested.", CD="<synthetic>"`. 프롬프트 규약에도
> `"No response requested." / "No action needed." → done` 으로 박혀 있다.

**시그니처 판정** (`engine.ts:1149-1168`):
```
!promptReplayed && !inputClosed && !aborted && !interruptRequested
&& !sawTurnActivity && deliveredNotifs.size > 0
  → 정착시키지 말고 같은 stdin에 프롬프트를 한 번 다시 밀어넣는다 (실행당 1회)
```
`sawTurnActivity`(1247-1253)의 정의가 핵심 — **사이드체인 프레임은 활동이 아니다**:
```
!parent_tool_use_id && (
   assistant에 text|tool_use 블록 || stream_event text_delta || user에 tool_result )
```

**무음 result 보류** (`engine.ts:1043-1078`, `:1763-1775`): 활동도 result 텍스트도
없는 성공 result는 **즉시 종결하지 않고 보류**한다. 고정 2.5초 원샷이 아니라
**슬라이딩**: 보류 후에도 프레임이 흐르면(또는 `deliveredNotifs`가 있으면) 최대 8번
재장전(총 ~22초). 진짜 턴의 첫 토큰이 13초 걸린 실측이 있어 고정 타임아웃이
'응답 없음' 오탐의 주범이었다.

### 6.4 백그라운드 작업 컨트롤

| 앱 액션 | 와이어 |
|---|---|
| 셸 칩 "중지" | `control_request {"subtype":"stop_task","task_id":"…"}` → 뒤이어 `task_notification status:"stopped"` |
| Ctrl+B / "백그라운드로" | `control_request {"subtype":"background_tasks"}` (인자 없음 = 전부) → 막혀 있던 `tool_result`가 즉시 반환되고 턴 계속 |
`engine.ts:366-377`. 사용자가 누른 중지는 `userBgStops`에 기억해 정착 통지에
`byUser` 표식을 단다(`engine.ts:369`, `:1532`).

### 6.5 사이드체인 조기 분리

**규칙: `parent_tool_use_id`(또는 `subagent_type`)가 있는 프레임은 메인 경로에
절대 태우지 않는다.** `engine.ts:1616-1654` 주석의 4가지 피해:
1. 서브에이전트가 다른 모델로 돌면(예: Fable 5 메인 아래 Explore=Opus 5)
   모델 전환 안전망이 인터리브마다 배너를 **핑퐁으로 도배**
2. usage가 서브에이전트 자신의 컨텍스트라 **게이지 오염**
3. 내레이션 text가 **메인 말풍선에 섞임**
4. 메인 스트리밍 상태(`curTextId`)를 리셋해 **말풍선이 쪼개짐**

분리 후 처리:
- 내부 `tool_use` → 그 카드에 귀속(`parentToolId`)
- 내레이션 `text` / `thinking` → 그 카드의 `activity` 한 줄(200자)
- `message.model` → 카드의 모델 칩(**값이 바뀔 때만** 부분 업데이트, 1628-1636)
- `stream_event`는 `parent_tool_use_id` 있으면 즉시 버림(1574) — 완성 프레임만 씀

`forwardSubagentText: true`(initialize)가 없으면 애초에 내레이션이 안 온다
(기본은 tool_use/tool_result만).

### 6.6 워크플로 진행 미러 + 보고 턴 회계

정착과 "보고 턴"을 잇는 회계는 순전히 **프레임 순번**으로 한다
(`engine.ts:626-671`):

```
frameSeq        매 프레임 ++
turnStartSeq    턴 시작 시점의 frameSeq
wfNotifySeq     정착(목록 이탈/통지) 관측 시점의 frameSeq
turnFromInject  이 턴이 사용자 주입 턴인가 (정리 턴은 CLI 재기동 턴 몫)
deliveredNotifs 이 턴에 실제로 모델에 전달된 통지 task id (user 텍스트에서 파싱)

finishWrap():
  if (turnStartSeq > wfNotifySeq && !turnFromInject) pendingSettles.clear()   // 통지 이후 시작된 턴 = 정리 턴
  else for (id of deliveredNotifs) pendingSettles.delete(id)                  // 안전벨트
  deliveredNotifs.clear()
```

두 번째 갈래가 없으면, system 통지 프레임이 재기동 턴의 첫 활동보다 늦게 올 때
wrap이 영영 안 풀리고(stuck) → 원샷 안전망이 **돌고 있는 워크플로를 오인 사살**한다
(실측 사고, 626-629 주석).

### 6.7 스트림 코얼레싱 (IPC 부하)

`src/main/streamCoalesce.ts` — **와이어가 아니라 앱→렌더러 구간**이지만
Rust에서도 그대로 필요하다(Tauri 이벤트도 직렬화 비용이 같다):

- `FLUSH_MS = 16` (한 프레임)
- `assistant-stream`: **같은 runId+messageId면 delta를 이어 붙인다**
- `thinking`: 전체 텍스트 교체라 **최신 것만 남긴다**
- 그 외 모든 이벤트: **버퍼를 먼저 비우고 즉시 통과** → 순서 보존

없으면 긴 답변 하나가 수천 번의 IPC + 리렌더가 된다.

### 6.8 진단 로그

`CCG_ENGINE_LOG=1`일 때만 `APP_HOME/engine-debug.log`에 append
(`engine.ts:254-265`). 프로덕션 기본 무음·무비용. 남기는 지점: cancel/interrupt,
inject 성공·미스, closeInput 사유, bg REPLACE 스냅샷, task_notification,
notif replay, stream end. **Rust도 이 지점 그대로 유지할 것** — 상주 CLI가
"언제·왜 닫혔는지"는 로그 없이는 사후 추적 불가다(2026-08-03 사고의 교훈).

---

## 7. 실검증

### 7.0 하네스

`scripts/poc-claude-cli-wire.mjs` (이번에 추가). SDK를 **전혀 import하지 않고**
`claude.exe`를 직접 스폰해 §2.1의 argv를 그대로 넘기고, stdin에 `initialize` +
`user` 두 줄을 쓰고, stdout 전 프레임을 `%TEMP%\ccg-cli-wire\frames*.jsonl`에 덤프한다.

```bash
node scripts/poc-claude-cli-wire.mjs          # 0원 스모크 (자격증명 없는 빈 CLAUDE_CONFIG_DIR)
node scripts/poc-claude-cli-wire.mjs --live   # 실계정 1턴 (haiku + --thinking disabled)
```

### 7.1 Run A — 무인증 스모크 (0원)

env: `CLAUDE_CONFIG_DIR=%TEMP%\ccg-cli-wire\noauth-config`(빈 폴더),
`ANTHROPIC_API_KEY` 삭제, `CLAUDE_CODE_ENTRYPOINT=sdk-ts`.

```
>>> {"type":"control_request","request_id":"init-1","request":{"subtype":"initialize",
     "forwardSubagentText":true,"supportedDialogKinds":["refusal_fallback_prompt"]}}
>>> {"type":"user","session_id":"","parent_tool_use_id":null,
     "message":{"role":"user","content":[{"type":"text","text":"hi"}]}}
<<< control_response success init-1
<<< system/init   session=d282d3b6-… model=claude-haiku-4-5-20251001 apiKeySource=none
                  caps=interrupt_receipt_v1|interrupt_cancel_queued_v1|msg_lifecycle_v1
<<< system/status status=requesting
<<< assistant     text="Not logged in · Please run /login"  error="authentication_failed"
                  message.model="<synthetic>"  is_api_error_message=true
<<< result/success is_error=true cost=0 turns=1 result="Not logged in · Please run /login"
--- exit 1
```

**확인된 것**: argv 전체가 유효, stdin JSONL 프레이밍 정확, `initialize` 응답 왕복,
init 필드 전수, `subtype:"success"` + `is_error:true` 조합의 실재,
`result` 후 stdin EOF → 프로세스 종료.

### 7.2 Run B — 실계정 1턴 (허용된 1회, 초저비용)

env: `CLAUDE_CONFIG_DIR=~/.agentcodegui/accounts/lmg56634_gmail.com-68e935`
(기본 계정, `accounts.json.defaultEmail`), `ANTHROPIC_API_KEY` 없음.
프롬프트 `"Reply with exactly: OK"`, `--model haiku --thinking disabled`.

```
<<< control_response success init-1
      response.keys = [commands, agents, output_style, available_output_styles, models,
                       account, pid, current_permission_mode, remote_control_auto_enable,
                       remote_control_auto_on_by_default, ide_rc_auto_enable_gate,
                       fast_mode_state, fast_mode_disabled_reason, session_state]
      account = {email, organization, subscriptionType:"Claude Max", apiProvider:"firstParty"}
<<< system/init          apiKeySource="none"  claude_code_version="2.1.239"
<<< system/status        requesting
<<< stream_event         message_start        (usage.cache_creation_input_tokens=25251, ttft_ms=1051)
<<< stream_event         content_block_start  {type:"text"}
<<< stream_event         content_block_delta  {type:"text_delta", text:"OK"}
<<< assistant            content=[{type:"text",text:"OK"}]  stop_reason=null   ★ stop보다 먼저
<<< stream_event         content_block_stop
<<< stream_event         message_delta        stop_reason="end_turn"
<<< stream_event         message_stop
<<< rate_limit_event     five_hour / allowed / resetsAt=1787377200
<<< result/success       is_error=false cost=0.050525 turns=1 result="OK"
                         modelUsage["claude-haiku-4-5-20251001"].contextWindow=200000
--- exit 0, 프레임 12개
```

### 7.3 문서 ↔ 실제 대조 결과

| 문서 주장 | 결과 |
|---|---|
| argv §2.1/§2.2 그대로 CLI가 받는다 | ✅ (에러/경고 0) |
| `--settings` 인라인 JSON 수용 | ✅ init `permissionMode:"default"` 반영 |
| `--setting-sources=a,b,c` `=` 형식 | ✅ |
| `initialize`가 첫 프레임, `control_response`로 성공 | ✅ |
| `systemPrompt` 생략 = 프리셋 유지 | ✅ (툴 30종·에이전트·스킬 정상 로드) |
| init 필드 (`session_id/model/cwd/tools/apiKeySource/capabilities/output_style`) | ✅ 전부 |
| 구독 경로 `apiKeySource === "none"` | ✅ (`'oauth'` 아님 — §2.3 경고대로) |
| `stream_event` = Messages API 이벤트 원문 | ✅ |
| `assistant` 완성본이 `content_block_stop`보다 먼저 | ✅ (문서에 반영) |
| `result.modelUsage[*].contextWindow` | ✅ 200000 |
| `subtype:"success"` ∧ `is_error:true` 가능 | ✅ (Run A) |
| stdin EOF → CLI 종료 | ✅ (exit 0 / 1) |
| `--permission-prompt-tool stdio` 수용 | ✅ (플래그 거부 없음). **단 `can_use_tool` 왕복 자체는 미실행** (§9-1) |
| `background_tasks_changed` / `task_*` / `workflow_progress` 모양 | 🔶 **바이너리 소스 문자열로 확인**(§5.11·5.13에 emitter 원문 인용), 라이브 미관측 |
| `interrupt` / `set_permission_mode` / `hook_callback` / `mcp_message` / `request_user_dialog` | 🔶 `sdk.d.ts` 스키마 + `claude.exe` 문자열 존재 확인, 라이브 미관측 |

**바이너리 문자열 존재 확인** (§0의 스캔 레시피, 출현 횟수):
`can_use_tool`×74, `request_user_dialog`×80, `set_permission_mode`×54,
`hook_callback`×43, `mcp_message`×16, `stop_task`×20, `background_tasks`×42,
`control_cancel_request`×56, `keep_alive`×27, `still_queued`×16,
`background_tasks_changed`×22, `local_workflow`×120, `local_bash`×70,
`local_agent`×166, `workflow_progress`×4, `workflow_phase`×11, `workflow_agent`×43,
`phaseIndex`×17, `promptPreview`×8, `resultPreview`×8, `task-notification`×282,
`refusal_fallback_prompt`×19, `permission_suggestions`×18, `updatedPermissions`×31,
`No response requested`×4.

---

## 8. Rust 이식 노트

### 8.1 프로세스 + JSONL 프레이밍 (tokio)

```rust
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;

const MAX_LINE: usize = 64 * 1024 * 1024;   // 한 프레임 상한 (대용량 tool_result 방어)

// stdout: 줄 단위, 부분 라인은 절대 파싱하지 않는다
let stdout = child.stdout.take().unwrap();
let mut lines = BufReader::with_capacity(1 << 20, stdout).lines();
while let Some(line) = lines.next_line().await? {
    if line.trim().is_empty() { continue; }              // ★ 빈 줄 스킵
    if line.len() > MAX_LINE { warn!("oversized frame dropped"); continue; }
    match serde_json::from_str::<Frame>(&line) {
        Ok(f)  => sink.send(f).await.ok(),
        Err(_) => { debug!("non-JSON stdout: {}", &line[..line.len().min(300)]); } // ★ 계속
    }
}
```

**주의 6가지**

1. **부분 라인**: `lines()`가 알아서 처리하지만, **EOF에 개행 없는 꼬리**가 남으면
   `next_line()`이 그 조각을 마지막으로 한 번 준다 → JSON 파싱 실패 → 스킵. OK.
   직접 `read_buf` 루프를 짤 거면 `\n`을 만나기 전엔 절대 파싱하지 말 것.
2. **백프레셔**: stdout 소비가 늦으면 CLI가 파이프 버퍼(윈도 기본 4~64KB)에서
   블록된다 → 턴이 통째로 정지. **읽기 태스크는 파싱만 하고 즉시 `mpsc`(bounded,
   예: 1024)로 넘기고**, 렌더 가공은 별도 태스크에서. `mpsc`가 꽉 차면 그건
   렌더가 느린 것이므로 §6.7 코얼레싱을 그 경계에 둔다.
3. **stdin 쓰기**: `write_all(json.as_bytes())` + `write_all(b"\n")` + `flush()`.
   **한 프레임을 두 write로 쪼개도 되지만 다른 프레임과 인터리브되면 안 된다** —
   `ChildStdin`을 `Mutex<ChildStdin>` 뒤에 두거나 전용 writer 태스크 + `mpsc`로.
   SDK도 `write(str)` 한 번으로 보낸다(`sdk.mjs @937503`).
4. **stdin 종료 = `endInput`**: `drop(stdin)` 또는 `stdin.shutdown()`.
   이게 CLI에게 "더 이상 턴 없음"을 알리는 유일한 신호다.
   **stdin이 이미 닫힌 뒤 쓰면 조용히 버려야 한다**(SDK도 `writableEnded` 검사 후
   드롭 — `@937713`).
5. **stderr**: 별도 태스크로 줄 단위 수집, tail 4096자만 보관 + 각 줄을 muted
   터미널 이벤트로. **exit 관측 후에도 마저 드레인**(§3.1).
6. **windows_hide**: `CREATE_NO_WINDOW (0x08000000)`. 안 하면 턴마다 콘솔이 깜빡인다.

### 8.2 컨트롤 RPC 계층

```rust
struct Control {
    tx: mpsc::Sender<String>,                       // → stdin writer
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    unmatched: Mutex<LruCache<String, Value>>,      // 상한 1024 (SDK와 동일)
    inflight_from_cli: Mutex<HashSet<String>>,      // 중복 배달 방어
}
```

- `request_id`: SDK와 같은 형식일 필요 없음. 유일하기만 하면 됨
  (SDK는 `Math.random().toString(36).slice(2,15)`).
- 응답이 요청 등록보다 먼저 올 수 있다 → `unmatched` LRU 필수.
- **취소**: `AbortSignal` 상당의 취소 시 `control_cancel_request`를 쓰고
  이후 도착하는 그 `request_id`의 응답은 버린다.
- CLI→앱 요청은 **동시 다발**이다(여러 도구 승인이 병렬로 뜬다).
  각각 `tokio::spawn`으로 처리하고 `AbortHandle`을 `request_id`로 보관해
  `control_cancel_request` 수신 시 abort.
- 응답 실패는 `subtype:"error"`로. **응답을 아예 안 보내면 그 툴은 영구 정지.**

### 8.3 상태기계 (`ccg-engine::EngineHost` 구현체)

```
                    ┌──────────────────────────────────────────┐
   run(req) ───────▶│ Spawning                                 │
                    │  spawn → write(initialize) → write(user) │
                    └───────────────┬──────────────────────────┘
                                    │ control_response(initialize) ∧ system/init
                                    ▼
   ┌───────────────────────────▶ Turn(run_id) ◀────────────── inject(req)
   │                              │  frames → events            (optsMatch OK)
   │                              │
   │            can_use_tool ─────┼─────▶ AwaitingUser(perm)  ──answer──┐
   │      request_user_dialog ────┼─────▶ AwaitingUser(dialog)──answer──┤
   │       AskUserQuestion(tool) ─┼─────▶ AwaitingUser(question)────────┤
   │                              │◀──────────────────────────────────── ┘
   │                              │
   │        interrupt() ──────────┼─────▶ Interrupting
   │                              │        control_request{interrupt}
   │                              │        ↳ result 6초 안에 안 오면 → Terminating
   │                              ▼
   │                          result 프레임
   │                              │
   │              ┌───────────────┴──────────────────┐
   │              │ 무음 result (활동X ∧ 텍스트X)?    │
   │              │  → Held (슬라이딩 2.5s × ≤8)      │
   │              │  → deliveredNotifs 있으면 Replay  │
   │              └───────────────┬──────────────────┘
   │                              ▼
   │                     turn_ended = true
   │              ┌───────────────┴──────────────────┐
   └──────────────┤ live{workflows,shells,agents} ∨   │
        Idle      │ pendingSettles 남았나?             │
      (상주)      │  예 → Idle(hold-idle 타이머 장전)  │
                  │  아니오 → stdin EOF → Terminating  │
                  └───────────────┬──────────────────┘
                                  ▼
                             Terminating
                   stdin close → 2s → (win) 5s → SIGKILL
                                  ▼
                               Exited
```

**불변식**
- `Turn`에 들어갈 때마다: `turn_ended=false`, `interrupt_requested=false`,
  `saw_turn_activity=false`, `held_result=None`, `turn_start_seq=frame_seq`,
  스트리밍 상태(cur_text_id/thinking/streamed) 리셋. (`engine.ts:1201-1218`)
- `Idle`에서만 주입 가능. `Turn` 중 주입 요청은 `busy` 미스 → 15초 대기 후 재시도.
- `AwaitingUser`는 `Turn`의 하위 상태 — 여기서 `interrupt`가 오면 **대기자를 먼저
  전부 해제**한 뒤 interrupt를 보낸다(`engine.ts:444-447`).
- **종결 status는 반드시 1회 보장**: result도 error도 없이 스트림이 닫히면
  (CLI 급사) `notice + status:error`를 대신 낸다(`engine.ts:1861-1872`).
  안 그러면 렌더러 busy가 영영 안 풀린다.

### 8.4 프레임 → 앱 이벤트 매핑표

| CLI 프레임 | `EngineEvent` (`protocol.ts:391-478`) |
|---|---|
| `system/init` | `session{sessionId,model,cwd,tools}` (+ `notice` once=api-billing/api-mismatch) |
| `stream_event content_block_delta:text_delta` | `assistant-stream{messageId,delta}` |
| `stream_event content_block_delta:thinking_delta` | `thinking{text}` (90자 요약) |
| `stream_event content_block_start:tool_use` | `thinking{text: 도구별 라벨}` |
| `assistant` text 블록 | `assistant-done{messageId,text}` + `thinking-clear` |
| `assistant` tool_use 블록 | `tool-start{tool}` (+ 첫 도구에서 `status:working`) |
| `assistant` (사이드체인) | `subagent{agent:{id:parentToolId, activity, model}}` |
| `assistant.message.usage` | `context{contextTokens}` (+ 보류 `compact`) |
| `assistant.message.model` 변화 | `model-fallback{fromModel,toModel,text,retractMessageId:null}` |
| `user` tool_result | `tool-end{status,result,durationMs,output,links}` / `file-change` / `terminal` |
| `result` | `result{...}` + `status:done|error` |
| `system/compact_boundary` | (보류) → `compact{trigger,preTokens,afterTokens}` |
| `system/model_refusal_fallback` | `model-fallback` (다이얼로그가 이미 냈으면 생략) |
| `system/notification` | `notice{text}` |
| `system/informational` (warning/suggestion, tool_use_id 없음) | `notice{text}` |
| `system/background_tasks_changed` | `bg-tasks{tasks}` (셸만) — REPLACE |
| `system/task_progress` (+workflow_progress) | `workflow{wf}` |
| `system/task_started` | (내부 매핑만) |
| `system/task_notification` | `bg-task-end{...}` + `workflow{settled}` + `subagent{done}` |
| `control_request can_use_tool` | `permission-request{requestId,toolName,summary}` |
| `can_use_tool` (AskUserQuestion) | `question-request{requestId,questions}` |
| `control_request request_user_dialog` (refusal_fallback_prompt) | `question-request` + `model-fallback` |
| stderr 줄 | `terminal{line:{type:'muted'}}` |
| 스트림 이상 종료 | `notice` + `status:error` |

`tool_use`/`tool_result` 가공(파일 diff 베이스라인, Bash 로그 tail 200줄/16KB,
WebSearch 링크 추출, HUGE 파일 16MB/4M자 가드)은 `engine.ts:1884-2161`을
그대로 옮기면 된다 — 와이어와 무관한 순수 함수들이다.

### 8.5 CLI 죽음/좀비 안전망 전수 (2.6.2가 가진 것 전부)

| # | 장치 | 위치 | Rust 이식 |
|---|---|---|---|
| 1 | **소프트 중단** (프로세스 유지) | `engine.ts:438-459` | 그대로 |
| 2 | interrupt 접수 후 **result까지 대기**(6s), 안 오면 하드 cancel | `:453-458` | 그대로 |
| 3 | `turnEnded`면 interrupt 생략(정리 유예 중 CLI는 무응답) | `:386-392` | 그대로 |
| 4 | interrupt 레이스 상한 (cancel 1.5s / interruptTurn 4s) | `:388`, `:449` | `tokio::time::timeout` |
| 5 | `cancel` 후 runLoop 종료 **최대 5초** 대기 (두 CLI 공존 방지) | `:409-415` | `JoinHandle` + timeout |
| 6 | 루프 안 **매 프레임 실행 경계 가드** (`activeRunId!==runId ‖ aborted → break`) — abort 후에도 이터레이터가 안 반려되는 win32 실측 | `:1230-1235` | 채널 recv마다 `run_id` 확인 |
| 7 | **hold-idle**: 보고 턴 대기만 10분 / 에이전트만 30분, **발화 시 재검증** | `:681-732` | 그대로 |
| 8 | 에이전트 생존 물증 = `subagents/**` 파일 mtime 10분 이내 (최대 400개 스캔) | `:685-713` | `std::fs` walk |
| 9 | **종결 status 보장** (result 없이 닫혀도 error status) | `:1861-1872` | 그대로 |
| 10 | 스트림 종료 시 **잔여 정리**: running 워크플로 → stopped, 남은 셸 → bg-task-end + 빈 REPLACE, 미완 서브에이전트 → done | `:1826-1860` | 그대로 |
| 11 | 대기자 누수 방지: `perm-<runId>-*` / `ask-<runId>-*` 접두로 이 런 것만 해제 | `:1804-1816` | key 접두 유지 |
| 12 | **패널 엔진 15분 유휴 스윕** — `hasLiveStream`(턴 or 상주)면 건너뜀 | `index.ts:381-397`, `engine.ts:342-344` | 그대로 |
| 13 | 앱 종료 `dispose()` — 아무것도 기다리지 않고 stdin 닫고 abort | `engine.ts:465-472` | `on_exit` 훅 |
| 14 | `MSBUILDDISABLENODEREUSE=1` 전역 주입 (dotnet 빌드가 남기는 MSBuild 상주 노드 차단 — 실측 좀비 2개 ~290MB) | `index.ts:75` | **자식 env에 유지 필수** |
| 15 | `CCG_ENGINE_LOG` 진단 로그 | `engine.ts:254-265` | 그대로 |

**추가로 Rust가 반드시 새로 해야 하는 것 — Job Object**

Electron은 자식 프로세스를 job object에 넣어 앱이 죽으면 같이 거둬 준다.
SDK 쪽 보호는 **부실하다**: `process.on('exit')` 훅이 win32에서 `kill`이 아니라
**`stdin.end()`만** 한다(`sdk.mjs @926665` `TB.killAll`). 그리고 정상 close 경로는
`stdin.end()` → 2초 → (win32) 5초 → `SIGKILL`(`@938546` close, `@939598` kill 타이머).
즉 **앱이 비정상 종료하면 337MB짜리 `claude.exe` + 그 손자(bash·dotnet·dev 서버)가
그대로 남는다.** Rust는 직접 job object를 만들어야 한다:

```rust
#[cfg(windows)]
unsafe {
    let job = CreateJobObjectW(null_mut(), null());
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(job, JobObjectExtendedLimitInformation, ...);
    AssignProcessToJobObject(job, child_handle);   // spawn 직후, 첫 write 전
}
```
job 핸들을 앱 전역에 하나 두고 모든 엔진/LSP 자식을 넣으면 **앱 프로세스 소멸 =
전 자식 소멸**이 커널 보장으로 성립한다.

### 8.6 계정 격리 (CLAUDE_CONFIG_DIR)

`auth.ts:287-325` `accountRunDir(email)`가 매 실행 물질화하는 것:

```
~/.agentcodegui/accounts/<slug>/
  .credentials.json   ← 복호화한 OAuth 스냅샷. 단 디스크 것이 더 신선하면 덮지 않는다
                        (credsExpiresAt 비교 — 315줄)
  .claude.json        ← oauthAccount / userID 병합, hasCompletedOnboarding=true
                        (CLI가 적어 둔 다른 상태는 보존)
  agents/ commands/ plugins/ projects/ sessions/ skills/ teams/ todos/ file-history/
                      ← ~/.agentcodegui/shared/* 로 향하는 심볼릭/정션 (linkSharedState)
                        ★ projects 공유가 resume을 살린다 — 계정을 바꿔도 전사가 이어진다
```

턴이 끝나면 `syncAccountTokens(email)`(`auth.ts:328-350`)가 CLI가 리프레시한
토큰을 암호화 백업에 되쓴다. **만료가 후퇴하는 껍데기 토큰은 거부**한다.
Rust: safeStorage → **DPAPI**(`CryptProtectData`)로 대체(`ccg-store` 담당).

---

## 9. 가장 위험한 미지수 (Rust 착수 전 반드시 PoC로 닫을 것)

### ① `can_use_tool` / `request_user_dialog` / `interrupt` 왕복 — **스키마만 있고 라이브 미검증**

이번 실검증 예산(1턴)으로는 도구를 부르지 않는 턴만 돌렸다.
스키마(`sdk.d.ts`)와 CLI 바이너리의 emitter 문자열은 확인했지만, 실제로 응답
JSON을 CLI가 **받아들이는지**는 안 봤다. 특히:

- 응답에 `toolUseID`가 **필수인지 선택인지**. SDK는 무조건 덧붙인다
  (`sdk.mjs @950450` `{...n, toolUseID: e.request.tool_use_id}`) — CLI가
  `request_id`만으로 매칭하는지, 아니면 이 필드를 본다면 빠졌을 때 툴이 영구 정지한다.
- `updatedPermissions`의 `destination:"session"`이 실제로 세션 스코프 규칙을
  만들어 재질문을 멈추는지(2.6.2의 "항상 허용" — `engine.ts:2222-2228`).
- `AskUserQuestion`을 `behavior:"deny"` + message로 답하는 트릭이 현행 CLI(2.1.239)
  에서도 유효한지. CLI가 `requires_user_interaction:true`를 붙여 보내기 시작했으므로
  (§4.4a) 취급이 달라졌을 수 있다.
- `interrupt` 응답의 `still_queued` / `cancelled` 실제 페이로드, 그리고
  "interrupt 접수 후 result가 온다"는 2.6.2의 전제가 2.1.239에서도 성립하는지.

**닫는 법**: `M3-PoC` 게이트(ARCHITECTURE-3.0.md:77-78)에 이 4개를 명시적 체크로
넣는다. `--model haiku` + `--permission-mode default` + `Bash(echo hi)`를 유도하는
1턴이면 can_use_tool·interrupt·always-allow를 한 번에 볼 수 있다(비용 ~$0.05).

### ② 상주 회계(정착 ↔ 보고 턴 ↔ 입력 닫기)의 **순서 의존성**

`sdk.d.ts:3131`이 못박는다: *"Ordering relative to the bookends for the same
transition is unspecified"*. 그런데 2.6.2의 상주 로직은 순서에 대한 **휴리스틱
덩어리**다 — `frameSeq/turnStartSeq/wfNotifySeq` 3중 비교(§6.6),
`deliveredNotifs` 안전벨트, 슬라이딩 무음 정착(2.5s×8), hold-idle 10/30분,
"목록에서 빠진 뒤에 통지가 온다"는 실측 전제. 이 중 하나라도 CLI 버전이 바꾸면
증상은 **"백그라운드 작업이 조용히 증발" 또는 "CLI가 매 턴 죽는 꼬임 루프"**로
나타나고, 둘 다 2.6.2가 실제로 겪은 릴리즈 사고다(2026-08-03, 08-13).

Rust로 옮기면 타이밍(파싱 속도, 채널 지연, 스레드 스케줄링)이 바뀌므로
**같은 코드를 옮겨도 같은 순서가 보장되지 않는다.**

**닫는 법**: (a) 순서 의존을 **레벨 신호 우선**으로 다시 짠다 —
`background_tasks_changed`의 REPLACE만을 진실로 삼고 에지는 장식으로.
(b) 상주 시나리오 3종(백그라운드 셸 + 다음 메시지 주입 / 워크플로 정리 턴 /
Esc 후 재전송)을 **프레임 기록 재생 하네스**로 만들어 Rust 상태기계에 오프라인
주입한다. 라이브 비용 0.

### ③ Windows 프로세스 수명 — job object 없이는 **337MB 좀비**가 남는다

`claude.exe`는 337 MB 단일 바이너리이고, 그 아래로 bash/dotnet/dev 서버 손자
프로세스를 만든다. 2.6.2는 Electron의 job object가 이걸 덮어 줬다.
Tauri/Rust에는 그 보장이 **없다**. 그리고 SDK가 참고할 만한 코드도 부실하다:
프로세스 종료 훅이 win32에서 `stdin.end()`만 하고(`sdk.mjs @926665`), 정상 close
경로도 2s + 5s를 기다린 뒤에야 SIGKILL이다(`@938546`/`@939598`).
앱이 크래시하거나 사용자가 작업관리자로 끄면 CLI + 손자가 통째로 살아남아
CPU/메모리를 물고, 다음 실행에서 세션 파일 잠금·포트 충돌까지 만든다.

곁가지 미지수: win32에서 `CLAUDE_CONFIG_DIR`만 주고
`CLAUDE_SECURESTORAGE_CONFIG_DIR`를 안 주는 2.6.2 방식이 **CLI 2.1.239에서도
계속 안전한지**. SDK는 sessionStore 경로에서 둘을 항상 짝지어 준다
(`sdk.mjs @1371241`) — CLI가 언젠가 Windows Credential Manager 우선으로 바뀌면
계정 격리가 **조용히 전역 자격증명으로 새는** 형태로 깨진다(`claude.exe`에
`tengu_windows_credman` 플래그 문자열이 실재한다).

**닫는 법**: M1(창 껍데기)과 함께 **`ccg-engine` 최초 커밋에 job object를 넣는다.**
검증: 엔진 턴 중 Rust 프로세스를 `taskkill /F`로 죽인 뒤
`Get-Process claude` 가 비는지 확인. 자격증명 쪽은 계정 2개로 번갈아 1턴씩
돌려 각 턴의 init `account.email`이 기대 계정과 일치하는지 실측.
