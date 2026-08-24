# 최종 파리티 R1 후속 — T3T4 갈래 **R3** (확인 크리틱 R2 수정 라운드)

빌더: T3T4 · 2026-08-24 · `feature/3.0.0-beta`
앞 라운드: `docs/parity-fix-t3t4-r2.md` · 판정: 확인 크리틱 R2(**6항 중 4항 통과 · 2항 부분**, 판정문 `babd925` · `docs/critic/r28-t3t4-critic-r2.md`)

| 커밋 | 무엇 |
|---|---|
| `38a8810` | **[최대 격차]** 본채팅의 한도 재개에 재검증을 붙인다 — `LimitProbe` 셸 배선 + 「못 물어봤다」 판정 |
| `04e4c57` | **[부분2]** `git:ai-message` 구현 — R2가 미룬 근거의 절반이 틀렸다 |

빌드(직접): `CARGO_TARGET_DIR=target-t3t4 cargo build --release --features custom-protocol`
→ `target-t3t4/release/agentcodegui.exe` **6,387,712바이트** · md5 `a80c61370d259749b9c95c519ec5ace2` (2026-08-24 20:32).
아래 실측은 **전부 이 exe**로 냈다(대조군 절만 예외 — 거기만 `--exe=`로 옛 exe를 지목한다).
대조군 exe(HEAD `babd925`를 %TEMP% 워크트리에서 따로 빌드): `target-t3t4-base/release/agentcodegui.exe` **6,356,992바이트**
— 크리틱이 잰 바로 그 크기다. `app/dist`는 이 라운드에 **한 글자도 안 바뀌었다**(렌더러 수정 0).

실측 산출물(전부 새 파일 — 기준 파일은 덮지 않았다):
`docs/critic/limit-engine-t3t4-r3.json` · `docs/critic/limit-engine-t3t4-r3-long.json` · `docs/critic/git-aimsg-t3t4-r3.json`

---

## 0. 한 문단 결론

크리틱의 통과 조건은 하나였다 — *"대기표를 심은 본채팅에서 조회 불가 판(`CCG_NO_NET=1` +
리셋 시각 경과)을 만들고 **전송 0**이 나오는 실측."* 그 판을 만들었고, **같은 하네스로
옛 exe와 새 exe를 나란히 돌렸다**: 옛 exe는 t=90초에 CLI를 띄우고 가짜 CLI의 stdin에
`"이어서 진행해 주세요"` **313바이트**를 밀어 넣었고, 새 exe는 110초 내내
`spawns=0 · stdin 0바이트 · 큐 0건`이다. 고친 자리는 크리틱이 제안한 (a)다 —
`resumeOwner`를 좁혀 렌더러 훅을 되살리는 (b)는 그 세 표면에 재개 주체를 둘로 만든다.
대신 **엔진이 유일한 주체인 채로 엔진에 눈을 달았다**: `LimitVerdict`에 `Unavailable`을
새로 파고(「훅이 없다」와 「물어봤는데 못 얻었다」는 다른 사실이다), `check_hold`의 착지를
넷으로 갈랐다. 부분2였던 `git:ai-message`는 R2가 적어 둔 미룬 근거를 SDK 본체에서 다시
읽어 **절반이 틀렸다**는 것을 확인하고 구현했다(§3).

---

## 1. [최대 격차] 본채팅에는 이번 안전장치가 아예 안 걸려 있었다

### 1.1 크리틱이 짚은 구조

```text
  chat:status.resumeOwner = "engine"      ← engine/lite.rs:112가 **조건 없이** 싣는다
        │
        ▼
  resumeOwner.ts:36 engineOwnsResume → 항상 true
        │
        ▼
  App.tsx:604 managed = true
        │
        ▼
  useLimitResume  →  장전 ✕ · 타이머 ✕ · 재검증 ✕ · 소진 ✕   (전부 건너뛴다)
        │
        ▼
  엔진 check_hold의 재검증 원천 = NoProbe = LimitVerdict::Unknown
        └─ 뜻: **「풀린 것으로 두고 진행」**
```

R2는 「조회 실패 = 풀림」 오판을 **렌더러 훅에서** 없앴다(`limitResume.ts` `resumeVerdict`).
그런데 실앱의 본채팅은 그 훅을 안 쓴다. 즉 사용자가 가장 많이 쓰는 표면은 R2 수정의
**바깥**에 있었고, `with_limit_probe`를 부르는 자리는 워크스페이스에 테스트 하나뿐이었다.

### 1.2 왜 (a)를 골랐나

크리틱은 두 갈래를 줬다.

| 갈래 | 하는 일 | 대가 |
|---|---|---|
| (a) | 셸에 `LimitProbe`를 배선해 `Blocked/Clear/Unknown`을 진짜로 가른다 | 엔진에 눈을 달아야 한다 |
| (b) | `resumeOwner`를 「엔진이 실제로 대기표를 든 채팅」으로 좁힌다 | **재개 주체가 둘이 된다**(본채팅·추가 채팅·멀티) |

(b)의 대가는 크리틱 스스로 적어 둔 것이다 — *"지금은 그 세 표면에 재개 주체가 둘일 수
있다."* 주체를 하나로 두는 것이 m-logic P6이고, 그 하나를 **눈먼 채로** 두는 것이 이번
사고였다. 그래서 주체는 엔진 하나로 두고 눈을 달았다.

### 1.3 무엇을 고쳤나

**① `LimitVerdict::Unavailable` 신설** (`crates/ccg-engine/src/limit.rs`)

R2까지 `Unknown` 한 낱말에 두 사실이 들어 있었다: *"훅이 없다"* 와 *"물어봤는데 못
얻었다"*. 훅이 없을 때 「풀린 것으로 두고 진행」은 옳다(판정이라는 것이 존재하지 않는다).
그런데 셸이 훅을 꽂는 순간 **후자가 전자의 관대함을 물려받는다** — 그게 눈감고 쏘는
재전송기다. 이제 둘이 다른 값이고, `Unknown`은 옛 계약 그대로라 재생 97개 시나리오는
한 글자도 안 바뀐다(테스트 `an_unwired_probe_keeps_the_old_contract`가 그 바닥을 잠근다).

**② `check_hold`의 착지를 넷으로** (`runtime.rs`) — 이식본 `resumeVerdict`와 같은 순서:

| # | 판정 | 하는 일 |
|---|---|---|
| ① | `Blocked` | 그 시각으로 재장전 + `probes = 0`(신선한 증거는 실패 계수를 지운다) |
| ② | `Unavailable` | **유지** — `probes += 1`, `recheck_wait(probes)` 뒤에 다시 묻는다 |
| ②' | `Unavailable` × [`MAX_BLIND_PROBES`] & 리셋 경과 | `ready + auto_paused` = **눌러서 이어가기** |
| ③ | `Clear` / `Unknown` | 옛 경로(소진 → 발화) |

재확인 사다리는 이식본 `recheckDelayMs`와 **한 칸도 안 갈린다**: 15 → 30 → 60 → 120 →
240초, `PROBE`(10분) 상한. 한 칸의 값이 다르기 때문에 이 사다리가 촘촘해도 된다 —
`unknown_wait`의 한 칸은 **CLI 턴 1회**고 이쪽은 **usage 조회 1회**다.

**③ 이식본과 일부러 다르게 둔 곳 하나** — ②'의 착지.
렌더러는 상한을 넘기면 *눈감고 한 번 쏘고*(`MAX_AUTO_ATTEMPTS = 2`) 그 대가를 사용자가
오류 말풍선으로 치른다. 엔진은 출구가 하나 더 있다: `ready`를 켜면 배너가 「눌러서
이어가기」를 준다(`resumeOwner.ts` `canPressResume`). **아무것도 안 태우고 침묵도 아닌**
착지라서, 더 오래 기다려도(6회 = 15+30+60+120+240 = **465초**) 손해가 없고 30초짜리
네트워크 끊김 하나가 「한도 자동 이어서」를 꺼 버리지도 않는다.

**④ 셸 훅** (`src-tauri/src/engine/limit_probe.rs`) — `acct_switch.rs`와 같은 모양이다.

```text
  [허브 스레드]  tick → check_hold → probe.blocked_until_for()   ← **절대 막히면 안 된다**
        │                              │
        │                     메모리 캐시만 엿보고 즉시 답한다(45초 TTL)
        │                              │ 없으면 워커를 깨우고 Unavailable
        ▼                              ▼
  [워커 1개]  ipc::parity::usage::usage_get(fresh) → **같은 캐시**에 적재
```

허브 스레드에서 `usage_get`을 부르면 만료 토큰의 리프레시 **교환 POST** + 전역 1.2초
게이트 + 429면 최대 30초를 스레드째 잔다 — 그동안 다른 대화의 스트리밍이 통째로 멈춘다.
그래서 `peek_usage`(논블로킹 · 새로 판 문)만 본다. 캐시는 **워크바 게이지와 한 벌**이라
조회 루프가 두 벌이 되지 않는다(M11 R2 C1이 걷어낸 토큰 회전 사고의 자리).

판정 함수 `fold()`는 `blockedResetsAt` + `usageUnavailable`의 Rust 짝이고 순수 함수다:
`unavailable` 표식 → `Unavailable` · 창이 하나도 없어도 `Unavailable` · `pct ≥ 100`이고
해제 시각이 **`now + 60초` 뒤인** 창들의 가장 늦은 시각 → `Blocked` · 나머지 → `Clear`.
Fable 주간 창은 **Fable 실행만** 게이트한다(그래서 트레이트에 `blocked_until_for`를
기본 구현으로 더했다 — 대본 훅은 그대로 산다).

### 1.4 실측 — 크리틱의 통과 조건 그대로, 그리고 **대조군과 나란히**

하네스 `scripts/poc-limit-engine.mjs`(신설). 격리 홈에 `chats-v3` 채팅 하나 +
`hold{resetsAt: 2시간 전}` + **가짜 CLI**(`ccg-fakecli`)를 심고 `CCG_NO_NET=1`로 실 exe를
관찰한다. 자동 재개는 **켠** 최악의 판이다(`autoResume: true`).
「전송 0」의 물증은 추론이 아니라 **파일**이다 — 한 글자라도 나가면 가짜 CLI의
`stdin.log`에 바이트로 남는다.

| t | 옛 exe (`babd925`) | 새 exe (`04e4c57`) |
|---|---|---|
| 5–85초 | `spawns=0 stdin=0B` | `spawns=0 stdin=0B` |
| **90초** | **`spawns=1 stdin=313B`** ← 쐈다 | `spawns=0` · `probes=1` · `asks=1` |
| 105초 | (표는 사라졌다 = 소진 = 전송) | `spawns=0` · `probes=2` · `asks=2` |
| 110초 | — | `spawns=0 stdin=0B queue=0 hold.ready=false` |

옛 exe가 그 90초에 밀어 넣은 바이트(하네스가 파일에서 그대로 읽은 것):

```json
{"type":"control_request","request_id":"init-1","request":{"subtype":"initialize", …}}
{"type":"user","session_id":"","message":{"role":"user","content":[{"type":"text","text":"이어서 진행해 주세요"}]}}
```

새 exe의 판정 회계: `limitProbe = {asks:2, fetches:2, blocked:0, clear:0, unavailable:2}`.
`asks > 0`이 「훅이 배선됐다」의 증거이고(옛 exe는 `limitProbe` 자체가 없다),
`unavailable=2 · clear=0`이 「못 물어봤다로 착지했다」의 증거다.

**긴 주행**(`--long`, 620초 · `docs/critic/limit-engine-t3t4-r3-long.json`):
t=556초에 `probes=6 · ready=true · autoPaused=true`로 착지하고 그 순간에도
`spawns=0 · stdin=0B`. 그리고 「이어가기」를 누르면(`chat:queue-mutate {op:'resume'}`)
그때 `spawns=1 · stdin=313B` — 출구가 막히면 그건 침묵이다(D7).

| 하네스 | 결과 |
|---|---|
| `poc-limit-engine`(110초) | **11/0** |
| `poc-limit-engine --long`(620초) | **14/0** |
| `poc-limit-engine --exe=<옛 exe>` | **4통과 / 7실패**(E1·E1′·E3·E4·E5·E6·E7) ← 대조군 |

Rust 잠금(`crates/ccg-engine/tests/r14_limit_loop.rs`, 신규 3종):

- `a_probe_that_cannot_ask_never_fires_and_hands_the_turn_to_the_user`
  — 리셋 +5분·+15분에 `spawns` 불변, 착지는 `ready+auto_paused`, 누르면 정확히 한 번.
- `a_recovered_probe_resumes_on_the_first_answer_it_gets` — 실패는 유예지 영구 정지가 아니다.
- `an_unwired_probe_keeps_the_old_contract` — 미배선(`Unknown`)의 바닥은 안 흔들린다.
- `recheck_wait_matches_the_renderer_ladder`(limit.rs) — 사다리 값이 이식본과 같다.

### 1.5 함께 온 것: 재개 주체가 둘일 수 있다는 지적

크리틱의 곁다리 — `SESSION_RUN`·`MA_RUN`도 같은 `ChatRuntime`을 타므로 추가 채팅·멀티
패널은 렌더러 훅과 엔진이 **둘 다** 살아 있다(그 두 표면은 `managed`를 안 넘긴다).
이번 라운드에 그 배선을 **바꾸지 않았다** — 두 가지를 확인했기 때문이다.

1. **게이트가 먼저 막는다.** 표가 `ready`가 아니면 `hold_gate_open()`이 닫혀 있어,
   렌더러가 먼저 쏜 재개는 스폰이 아니라 **큐에 주차**된다.
2. **`already` 가드가 나팔을 삼킨다.** 표가 걸린 뒤에 들어온 사용자 메시지가 큐에 있으면
   `consume_hold`가 「이어서」를 안 끼운다(★R4가 정확히 이 모양을 위해 넣은 자리다).

즉 착지는 *한 번의 해제에 한 턴*이다. 다만 이것은 **구조가 아니라 두 가드의 합**이라,
`managed`를 세 표면에 흘리는 일은 여전히 남은 정리다(§5).

---

## 2. 체크리스트 1·1′·3·4·6 — 회귀 그물

렌더러(`app/`)는 이 라운드에 **0파일** 고쳤다. 그래서 게이지·btw·MCP/스킬은 R2 값이
그대로여야 하고, 실제로 그렇다.

| 검사 | R2(크리틱 확인) | R3 |
|---|---|---|
| `cargo test -p ccg-engine` | 197/0(2 ignored) | **201/0**(2 ignored) |
| `cargo test -p agentcodegui` | 107/0 | **121/0** |
| `cargo test -p ccg-store` | 76/0 | **76/0** |
| `cargo test -p ccg-auth --features net` | 88 + 25 = 113/0 | **88 + 25 = 113/0** |
| `npm run typecheck`(node·web) + `typecheck:app` | 초록 | **초록** |
| `poc-limit-resume`(훅 실구동 · 세 표면) | 141/0 | **141/0** |
| `poc-limit-blind`(실 exe · `CCG_NO_NET`) | 14/0 | **14/0** |
| `poc-btw-fork` | 33/0 | **33/0** |
| `poc-mcpskill` | 전부 통과 | **전부 통과** |
| `poc-parity-t3t4 --no-live` | — | 34/1 (아래 참고) |

`poc-parity-t3t4 --no-live`의 1실패(`T4-6b`)는 **회귀가 아니다**: `--no-live`는 격리 홈에
계정을 한 벌도 안 깐다(`NO_LIVE`면 `liveAccounts`가 비고 `accounts.json`을 안 쓴다).
그래서 그 검사가 필요로 하는 「CLI가 시드를 인용하며 거절하는 문장」 대신
`실행 계정을 쓸 수 없어요 — (빈 계정)`이 온다. **옛 exe로 같은 명령을 돌려도 34/1이고
실패 id가 같다**(직접 대조했다). 크리틱이 잰 41/0은 실 계정을 복사하는 live 주행이다 —
이번 라운드는 실계정 HTTP를 최소로 두는 규율이라 `--no-live`로 갈음했다.

`poc-limit-blind`의 기준 파일은 이번에도 **안 덮었다**(`--out=`을 새로 달았고, 시험
주행은 `%TEMP%`로 뺐다 — 크리틱이 지적한 그 위생). `poc-parity-t3t4`가 쓴
`docs/critic/parity-t3t4-r1.json`은 주행 뒤 `git checkout`으로 되돌렸다.

---

## 3. [부분2] `git:ai-message` — 미룬 근거의 절반이 틀렸다

### 3.1 R2가 적어 둔 근거와, SDK 본체가 말하는 것

R2는 이렇게 남겼다(`ipc/git.rs` 헤더):

> 2.6.2는 SDK `query()`에 `{ maxTurns: 1, allowedTools: [] }`를 준다. 그런데 그 둘은
> **argv 플래그가 아니다** — `claude.exe 0.3.241 --help`에 `turns`는 0회 등장한다.
> SDK는 이 값들을 stream-json 제어 요청으로 넘긴다.

크리틱은 앞 문장을 사실로 확인해 줬다(`--help`에 없다). 그래서 이번엔 **SDK 본체**를
읽었다 — 설치본이 들고 있는 `@anthropic-ai/claude-agent-sdk/sdk.mjs`의 argv 조립:

```js
if (u) Y.push("--max-turns", u.toString());                 // ← maxTurns는 CLI 플래그다
if (St.length > 0) Y.push("--allowedTools", St.join(","));  // ← 빈 배열이면 아무것도 안 붙는다
```

두 가지가 드러난다.
① `--max-turns`는 **숨은 플래그**다 — `--help`에 없을 뿐 실재한다.
② 2.6.2의 `allowedTools: []`는 **와이어에서 아무 일도 하지 않았다**(길이 0 → 플래그 없음).
즉 "도구 없는 순수 1턴"을 실제로 만든 것은 `--max-turns 1` 하나이고, 그것은 argv다.

②를 실 API 0건으로 확인했다(`--print --input-format stream-json`에 빈 stdin을 물리면
CLI는 플래그 파싱까지만 하고 죽는다):

```text
  --ccg-bogus-flag 1  →  error: unknown option '--ccg-bogus-flag'     (대조군)
  --max-turns 1       →  (조용히 통과)                                  (시험)
```

### 3.2 무엇을 만들었나

`src-tauri/src/ipc/parity/aimsg.rs` — 2.6.2 `src/main/git.ts:510-630`과 한 줄씩 마주 본다:
diff 예산(총 120k · 파일 24k, 넘으면 **헤더만** 남긴다) · 변경 줄만 직렬화(ctx 생략) ·
최근 커밋 15개로 톤 · `CLAUDE_CONFIG_DIR` 계정 격리 · 전역 `ANTHROPIC_API_KEY`는
"API로"라고 저장한 키만 존중 · 기본 `sonnet`/`low` · effort→thinking 매핑(fable은 명시적
`disabled`에 400을 내므로 아무것도 안 보낸다) · 90초 상한 · `<commit>` 마커 안만 취하고
코드펜스 줄 제거.

**도구 목록은 2.6.2와 같이 안 보낸다.** 보내면 그쪽에 없던 제약이 생긴다 — 파리티는
의도가 아니라 바이트다. 도구 폭주를 막는 것은 `--max-turns 1`과 90초이고, 그 둘이
2.6.2의 실제 방어선이었다.

허브(엔진)를 안 태우는 이유: 이 호출은 대화가 아니다(채팅 id도 세션도 없고 스레드에
말풍선을 안 남긴다). 태우면 `ChatRuntime` 하나가 유령 채팅으로 떠 사이드바에 그려진다.
2.6.2도 `engine.ts`가 아니라 `git.ts`에서 SDK를 직접 불렀다 — 같은 이유다.

### 3.3 실측 — `scripts/poc-git-aimsg.mjs` **20/0** (실 모델 호출 0건)

합성 계정(`ccg-auth-probe seed`) + 가짜 CLI + 작은 git 저장소로 전 경로를 돈다.

- **B** `git:ai-message` = `{ok:true, subject:"한도 재검증을 엔진에 배선한다", body: 2줄}`.
  대본이 붙인 서두 `"아래와 같이 제안합니다."`는 마커 밖이라 **안 삼켰다**.
- **C** 엔진에 **실제로 나간 argv**(가짜 CLI가 파일로 적은 것 — 새 옵트인 `CCG_FAKECLI_ARGV`):

  ```json
  ["--output-format","stream-json","--verbose","--input-format","stream-json",
   "--effort","low","--model","sonnet","--permission-mode","default","--max-turns","1"]
  ```

  `--max-turns 1` 있음 · `--allowedTools` **없음**(2.6.2와 같은 바이트).
- **D** 프롬프트에 diff 헤더(`### a.txt (+…)`)·변경 줄·톤(`M12 R1 — 설치본을 만든다`)·
  마커 블록이 실린다. **ctx 줄은 안 실린다**(예산).
- **E** 실패도 문장으로 착지한다(`커밋에 담긴 파일이 없어요` · `Git 저장소가 아니에요`)
  — 그리고 그 실패들은 엔진을 **안 띄운다**(argv 파일이 안 갈린다).

---

## 4. `app:open-directory`는 죽은 버튼이 아니다

크리틱의 실측표에 `M2' app:open-directory = {"__unimplemented":true}`가 있다. 사실이지만
**요청 채널이 아니라 이벤트**다 — 렌더러는 구독만 한다:

```text
  app/src/api/shim.ts:471   onOpenDirectory: (cb) => subscribe(IPC.openDirectory, cb)
  app/src/App.tsx:1710      window.api.app.onOpenDirectory((dir) => openProjectDir(dir))
```

`call(...)`이 아니라 `subscribe(...)`라 **부르는 자리가 없다**. 그래서 채널로 invoke하면
당연히 미구현으로 떨어지고, 그 값이 곧 「눌러도 안 되는 버튼」을 뜻하지는 않는다.
유일한 발원지는 단일 인스턴스 잠금의 second-instance인데, 그 플러그인을 넣는 순간
**격리 홈으로 여러 벌 띄우는 하네스가 전부 죽는다**(지금 세 갈래가 그렇게 돈다).
설치기가 컨텍스트 메뉴를 등록하는 라운드의 몫이라는 R1·R2의 판단을 유지한다.

---

## 5. 남은 것 / 알려진 한계

| # | 무엇 | 왜 남았나 |
|---|---|---|
| 1 | 추가 채팅·멀티 패널에 `managed`를 안 흘린다 | 착지는 지금도 한 턴이지만(§1.5) 그 보장이 **구조가 아니라 두 가드의 합**이다. 렌더러 3표면 배선 + `poc-limit-resume` 재주행이 붙는 작업이라 이 라운드의 「렌더러 최소」 규율 밖으로 뒀다. |
| 2 | 조회가 **영구히** 죽은 환경에서는 자동 재개가 465초 뒤 멈춘다 | 의도한 착지다(§1.3 ③). 사용자는 배너의 「이어가기」로 계속한다. 이식본은 그 자리에서 눈감고 한 발 쏘므로, **이쪽이 더 보수적**이다. |
| 3 | `git:ai-message`의 실모델 왕복은 실측 안 함 | 하네스는 가짜 CLI로 돈다(실 계정 토큰 회전 0 규율). argv·프롬프트·파싱은 바이트로 쟀고, 남은 것은 모델의 답 품질뿐이다. |
| 4 | Fable 주간 창 게이트는 **모델 문자열**로 가른다 | `blocked_until_for(account, model, …)`의 `model`이 `"fable"`인지로 판정한다. 모델 별칭이 늘면 그 목록도 함께 늘어야 한다(단위 테스트가 그 자리를 잠근다). |
| 5 | `app:open-directory` second-instance | §4 — 설치기 라운드 몫. |

---

## 6. 규율 자기점검

| 규율 | 결과 |
|---|---|
| 동결 구역(`src/main`·`src/preload`·`src/renderer`·`out/`·`dist/`) | **0파일**(두 커밋 전수 확인) |
| 공유 파일(`main.rs`·`ipc/mod.rs`·`ipc/unified.rs`·`protocol.ts`·`package.json`) | **0줄** — 이번 라운드는 손대지 않았다 |
| 렌더러(`app/`) | **0파일** |
| 실계정 토큰 회전 | **0** — 합성 계정 + `CCG_NO_NET=1`. 실 HTTP는 이 라운드 **0건** |
| 이름 기반 kill | **0** — 죽인 것은 spawn한 PID 트리뿐(`killTree`) |
| 기준 결과 파일 | `limit-blind-t3t4-r1.json` 안 덮음(`--out=` 신설) · `parity-t3t4-r1.json`은 `git checkout`으로 복원 |
| 격리 | `CCG_HOME=.poc-home-{engine,aimsg}-t3t4`(gitignore `.poc-home-*/`) · CDP 9425·9427 · `CARGO_TARGET_DIR=target-t3t4`(+대조군 `target-t3t4-base`, gitignore `target-*/`) |
| 대조군 워크트리 | `%TEMP%/ccg-t3t4-base`(레포 밖) — 다 쓰면 `git worktree remove` |
