# CRIT R1 — 눈은 떴는데 **엉뚱한 곳을 보던** 재검증, 그리고 npm 없는 컴퓨터의 침묵

빌더: R28b 「CRIT」 갈래 · 2026-08-24 · `feature/3.0.0-beta`
받은 과제: R28 확인 크리틱이 지목한 격차 **2건** 마감
 ① T3T4 R3 §3 — **치명 회귀**: 한도 재검증 훅이 엔진 종류를 안 가른다(Codex 채팅이 클로드 한도로 잠긴다)
 ② T1T2 R2 §5 — npm(Node.js)이 없고 네트워크는 있는 컴퓨터에서 **3.0만 아무 말도 안 한다**

커밋: `d6fdcca`(①) · `25fd697`(②) · 허브 스레드 쓰기 제거 · 이 보고서
빌드: `CARGO_TARGET_DIR=target-crit cargo build --release --features custom-protocol`
→ `agentcodegui.exe` **6,431,744B · md5 `f838824ded0b60de92c8e74f14576bcf`**(아래 수치는 이 exe의 것이다).
대조군 exe는 **이 갈래의 직전 HEAD**를 같은 자리에서 빌드해 따로 보관했다
(`target-crit/base-agentcodegui.exe` — 6,387,712B = 크리틱 R3이 잰 그 크기).

---

## 0. 한 문단 결론

**Codex 채팅을 최대 7일 잠그던 자물쇠는 사라졌다.** 크리틱 §3의 판을 하네스로 그대로 세워
(클로드 계정 1 · `identity.engine.kind='codex'` · 리셋 시각 2시간 전 대기표) 두 exe를 같은
격리 홈에 번갈아 띄웠다. 직전 exe는 **120초 내내 `spawns=0`**, 표가 살아 있고
(`probes=2 · asks=2 · unavailable=2`) 그동안 **사용자가 직접 보낸 메시지도 `queued:1`로 주차**된다.
새 exe는 **t=90초에 `spawns=1 · stdin 502B`**, `probe.unknown=1 · blocked=0`이고 큐에 세워 둔
사용자 메시지도 그 순간 함께 나간다. 클로드 축의 안전장치는 그대로다 — `poc-limit-engine` **11/0**
(전송 0 · 바이트 0).

**npm 없는 컴퓨터의 침묵도 끝났다.** 같은 판(PATH에서 npm·node 제거 · 네트워크 유지)에서
직전 exe는 45초 동안 표본 54개에 카드 **0장**, 설정 ▸ Engine의 목록도 0개에 문구 0줄이었다.
새 exe는 **2,485ms**(재주행 2,861 · 3,128ms)에 「엔진을 설치할 수 없어요 … npm(Node.js)과 인터넷 연결이 필요해요」 카드를 띄우고
그 아래 채널이 준 사유를 그대로 싣는다. 설정 목록 자리에도 같은 사유가 한 줄로 앉는다.

---

## 1. ★ 회귀 — 재검증이 「어느 엔진의 한도인가」를 안 봤다

### 1.1 무엇이 문제였나 (크리틱 §3의 구조를 코드로 다시 읽었다)

```text
  Codex 채팅이 한도 에러로 죽는다
        │  classify_limit_error는 엔진을 안 가른다(runtime.rs:2693)
        ▼
  arm_hold → LimitHold.account = identity.billing()      ← 클로드 구독 계정
        ▼
  check_hold → probe.blocked_until_for(account, model, now)   ← 엔진 축이 인자에 없다
        ▼
  peek_usage(클로드 이메일) → fold(클로드 usage) → Blocked{클로드 주간 해제 시각}
```

인자에 없으면 훅은 알 수 없다. **그래서 인자를 늘렸다.**

### 1.2 무엇을 고쳤나

| 자리 | 무엇 |
|---|---|
| `crates/ccg-engine/src/limit.rs` | `ProbeQuery{ billing, engine, codex_account, model, now }` + `LimitProbe::probe(&ProbeQuery)`. 기본 구현은 축을 버리고 옛 메서드로 접는다(대본 훅=재생 하네스는 답을 시나리오로 정해 두므로 한 글자도 안 바뀐다) |
| `crates/ccg-engine/src/runtime.rs` `check_hold` | 축을 **표가 아니라 지금 정체성**에서 읽어 넘긴다(`identity.engine_kind()` · `identity.codex_account()`). 표는 장전 시각의 과금 축만 알고, 이 실행이 어느 서비스의 창을 태우는지는 정체성만 안다 |
| `src-tauri/src/engine/limit_probe.rs` | 셸 훅이 축으로 **갈라진다**. Claude면 옛 경로 그대로, Codex면 `codex_verdict` |
| `src-tauri/src/engine/codex_limit.rs`(새 파일) | Codex 한도 창 조회 — `codex app-server`에 JSON-RPC `account/rateLimits/read`(2.6.2 `codexAccountsUsage`의 Rust 짝) + 계정별 메모리 캐시 |

**착지 규약**(클로드 축과 같은 뜻, 재료만 다르다):

| 판 | 값 | 근거 |
|---|---|---|
| API 키 실행 | `Clear` | 갈아탈 구독 창이 없다 |
| 등록 codex 계정 0 · codex 실행본 없음 | **`Unknown`** | **물어볼 창구가 없다** = 판정하지 않는다 = 옛 계약(발사). 크리틱이 (b)로 허용한 착지 |
| 스냅샷이 차갑거나 RPC 실패 | `Unavailable` | 물어봤는데 못 얻었다 — 표 유지 후 재확인 |
| 창 목록이 있다 | `codexBlockedResetsAt` 규칙 | 소진 창 중 가장 늦은 해제 시각, `+60초` 경계까지 이식본과 같은 값 |

즉 크리틱이 준 두 갈래 중 **(a)를 골랐고, (a)가 불가능한 판에서만 (b)로 떨어진다.**

**허브 스레드는 여전히 안 막힌다.** 판정에 쓰는 것은 메모리 캐시 엿보기 + `can_ask`
(실행본 stat 1 · 계정 스토어 JSON 1, **읽기만**)이고, 격리 `CODEX_HOME` 물질화와
app-server 스폰(≈0.7초)은 전부 워커 스레드다. 그 경계는 테스트가 잠근다
(`an_unregistered_account_has_no_instrument_and_never_reaches_the_real_home` —
판정 한 번이 계정 폴더를 만들면 빨강).

### 1.3 곁다리 하나 더 — 시각 미상 표의 출구(크리틱 §3.4 · 지시 2)

`if probes < MAX_BLIND_PROBES || !past`의 `past`는 `resets_at`이 있을 때만 참이 될 수 있다.
그래서 **꼬리(`…|epoch`) 없는 문구로 걸린 표**(codex 한도 문구가 그렇다)는 「눌러서 이어가기」
착지에 **영영 도달하지 못했다** — 조회가 죽어 있으면 10분마다 조용히 다시 묻기만 하고,
그동안 `hold_gate_open()`이 닫혀 사용자 메시지도 큐에 선다. 이번 라운드의 Codex 경로는
바로 그 모양의 표를 만들 수 있으므로(RPC 실패 + 시각 미상) 같이 닫았다:

```rust
if probes < MAX_BLIND_PROBES || (known && !past) {   // known = resets_at.is_some()
```

「기다릴 근거를 모른다」는 「영원히 기다려라」가 아니다. 6회 실패하면 시각을 몰라도
`ready + auto_paused`로 사용자에게 넘긴다(아무것도 안 태우고, 버튼은 사용자의 선택이다).

### 1.4 실측 — 크리틱 레시피 그대로, 다만 **실계정 HTTP 0건**으로

새 하네스 `scripts/poc-limit-codex.mjs`. 크리틱은 실계정(주간 100%)으로 쟀지만, 같은 판을
**합성 계정 + `CCG_NO_NET=1`** 로 세웠다 — 토큰 회전 0이 규율이고, 판별력은 그대로다:
훅이 클로드 축을 보면 `Blocked`든 `Unavailable`이든 **표를 유지**하고, 사용자에게 보이는
결과(잠긴 채팅 + 주차된 메시지)가 똑같기 때문이다.

| t | 직전 exe(`base-agentcodegui.exe`) | 새 exe |
|---|---|---|
| 5–85초 | `spawns=0 · hold 유지` | `spawns=0 · hold 유지` |
| **90초** | `spawns=0` | **`spawns=1 · stdin 502B · hold 없음`** |
| 90–120초 | `spawns=0` 계속(`probes=2 · asks=2 · unavailable=2`) | (끝) |
| 사용자 메시지 | **`queued:1 · spawns=0`** (주차) | `queue []` — 표가 풀리며 함께 나갔다 |
| 판정 | **5통과 / 3실패**(C1·C3·C5) | **8통과 / 0실패** |
| `limitProbe` | `{asks:2, unavailable:2, blocked:0}` | `{asks:1, unknown:1, blocked:0}` |

`unknown`은 이번에 `engine:debug`에 추가한 계수기다 — **판정하지 않았다**의 숫자이고,
이 값이 오르는 동안 `blocked`가 0이라는 것이 "클로드 창을 안 봤다"의 물증이다.

회귀 그물(클로드 축)은 그대로 초록이다:

```
poc-limit-engine   (110초 · CCG_NO_NET · 리셋 2시간 전)   11 / 0
   E1  전송 0(spawns=0) · E1′ stdin 0바이트 · E5 asks=2 · E6 unavailable=2
poc-limit-engine --long (620초)                          14 / 0
   t=557초 `probes=6 · ready=true · autoPaused=true`(그 순간에도 spawns=0 · stdin 0B)
   → 눌렀을 때만 `spawns=1 · stdin 313B`  ← 크리틱 R3이 잰 t=556초·313B와 같은 자리
poc-limit-resume   141 / 0      poc-limit-blind   14 / 0 (--out= 로 기준 파일 보호)
```

§1.3의 손질이 **이 착지를 안 흔들었다**는 것이 `--long`의 요점이다(시각을 아는 표는
`known && !past`가 예전과 같은 값이라 t=557초 그대로다).

### 1.5 테스트로 잠근 것

| 테스트 | 무엇을 막나 |
|---|---|
| `limit_probe::a_codex_chat_is_never_judged_by_the_claude_weekly_window` | 클로드 주간 100% 스냅샷을 심어 두고 같은 계정으로 Claude/Codex를 각각 묻는다 → 앞은 `Blocked`, 뒤는 `Unknown`이고 **`blocked` 계수가 안 오른다** |
| `limit_probe::the_codex_windows_fold_like_the_renderer_does` | 빈 목록=「못 물어봤다」 · 가장 늦은 시각 · `+60초` 경계까지 이식본과 동치 |
| `codex_limit::the_rate_limit_wire_maps_onto_the_two_fields_the_verdict_reads` | 와이어 → `{usedPct, resetsAt}` 매핑이 2.6.2와 같은 두 필드 |
| `r14_limit_loop::the_probe_is_told_which_engine_the_limit_belongs_to` | **엔진이 축을 안 넘기면 빨강**(질문을 그대로 받아 적는 훅) |
| `r14_limit_loop::a_ticket_with_no_known_reset_time_still_reaches_the_users_hand` | §3.4 — 시각 미상 표가 30분 뒤 `ready+auto_paused`로 착지하고, 눌러야 정확히 한 번 나간다 |

---

## 2. npm(Node.js)이 없는 컴퓨터 — 이제 3.0도 말을 한다

### 2.1 무엇을 고쳤나 (둘 다 렌더러)

① **`EngineGate`가 `latest`를 몰라도 물러나지 않는다.** `if (!latest) return`이 있던 자리에
   'blocked' 카드가 선다 — 제목 「엔진을 설치할 수 없어요」, 본문 「… 엔진 설치에는
   npm(Node.js)과 인터넷 연결이 필요해요 — 확인한 뒤 다시 시도하세요」(npm이 없는 컴퓨터와
   잠깐 오프라인인 컴퓨터가 같은 자리로 떨어진다 — 어느 쪽인지는 아래 사유가 말한다), 그 아래 **채널이 값으로 준
   사유**(`.sd-why`), 버튼 [나중에 · 다시 시도]. 「다시 시도」는 재조회라 Node.js를 깔고 그 자리에서
   이어갈 수 있다. 부팅 업데이터가 뒤늦게 일을 맡으면 이 카드도 함께 접힌다(진행 카드와 안 겹친다).

② **설정 ▸ Engine이 응답의 `error`를 읽는다.** `.then(r => setAvailable(r.versions))`가 값만 읽어
   `listError`가 영영 `null`이었다. 이제 목록이 **비었을 때만** 사유를 싣고(부분 실패에서 목록을
   지우지 않는다), 목록 자리에 제목 아래 한 줄로 그린다. 계약면(`src/shared/api.ts`)에도
   `error?: string`을 적었다 — 3.0 Rust가 이미 내려보내던 필드인데 **타입에 없어서 아무도 못 읽었다**.

### 2.2 실측 (`bench/scratch/critr1-nonpm.mjs` · PATH에서 npm·node 제거 · 네트워크 유지 · 엔진 0개)

| | 직전 exe | 새 exe |
|---|---|---|
| 부팅 카드 | **없음**(45초 · 표본 54개 · `.sd-title` null) | **2,485ms**(재주행 2,861 · 3,128ms) · 「엔진을 설치할 수 없어요」 |
| 카드가 실은 사유 | — | `레지스트리 응답을 읽지 못했어요(npm view 출력이 JSON이 아닙니다)` |
| 카드 버튼 | — | `[나중에 · 다시 시도]` |
| `listAvailable()` | `{latest:null, versions:[], error:…}` | 같음(값은 늘 있었다) |
| 설정 ▸ Engine 목록 | 0개 · `.vpick-msg` **null** | 0개 · 「목록을 불러오지 못했습니다」 + 위 사유 한 줄 |

참고로 2.6.2는 같은 판에서 4,314ms에 카드를 띄운다(크리틱 R2 §5.1). **3.0이 1.8초 빠르고,
2.6.2가 못 말하는 것(무엇이 없어서 안 되는지)까지 말한다.**

> **2.6.2(Electron) 팔은 일부러 안 돌렸다.** 크리틱 R2 §9가 적었듯 2.6.2의 부팅 정리는
> `CCG_HOME`을 무시하고 **사용자 실홈의 `codex-engines`를 지운다**(`codex/versions.ts:17`).
> 그쪽 수치는 크리틱 것을 인용한다.

### 2.3 근본 수선은 하지 않았다 — 그 이유

「조회를 2.6.2처럼 `fetch(registry.npmjs.org)`로 바꾸기」는 이번에 넣지 않았다.
npm이 없으면 **설치 자체가 불가능**하므로 목록만 채워도 그 컴퓨터의 사용자는 여전히 못 깐다
(2.6.2가 그 판에서 「설치 실패 (npm 종료 코드 1)」로 착지하는 것이 그 증거다).
「무엇이 없어서 안 되는지」를 말하는 쪽이 먼저이고, 조회 경로(`crates/ccg-engine/src/versions.rs`)는
T1T2 갈래가 만지는 파일이라 같은 라운드에 둘이 겹치는 것도 피했다. **남은 숙제로 적어 둔다.**

---

## 3. 게이트 (전부 이 갈래에서 직접 냈다)

```
cargo test (CARGO_TARGET_DIR=target-crit)
  agentcodegui   133 / 0        ccg-engine   203 / 0 (2 ignored · 14 타깃 합산)
  ccg-store       76 / 0        ccg-auth     116 / 0 (--features net)
npm run typecheck (node·web) · npm run typecheck:app     3종 초록

node scripts/poc-limit-codex.mjs                              8 / 0   (새 exe)
node scripts/poc-limit-codex.mjs --exe=<직전 exe>             5 / 3   (대조군 — 판별력)
node scripts/poc-limit-engine.mjs --exe=<새 exe>             11 / 0
node scripts/poc-limit-engine.mjs --long --exe=<새 exe>      14 / 0
node scripts/poc-limit-resume.mjs                           141 / 0
node scripts/poc-limit-blind.mjs --out=<레포 밖>             14 / 0
node bench/scratch/critr1-nonpm.mjs [--exe=<직전 exe>]       §2.2 표
```

기준 결과 파일은 **하나도 안 덮었다** — 모든 주행에 `--out=`으로 레포 밖 경로를 줬고,
이 라운드가 만든 산출만 `docs/critic/*-crit-r1*.json`으로 새로 놓았다.

병렬 규율: 세 갈래가 같은 워킹트리에서 돌고 있어 **자기 hunk만** 스테이지했다
(`git apply --cached`로 hunk 단위 선별 — 공유 파일 `Settings.tsx`·`styles.css`·`api.ts`·
`parity/usage.rs`). 이름 기반 kill 0건 · 실계정 자격 0줄 · 실 HTTP 0건 ·
격리 홈(`.poc-home-codex-crit`·`.poc-home-critr1nonpm-*`) · CDP 9437·9391·9392(다른 갈래와 안 겹침).

---

## 4. 남은 리스크 / 다음 라운드에 넘기는 것

1. **Codex 창 조회의 실물 왕복은 라이브로 못 쟀다.** `account/rateLimits/read` 경로는 등록된
   codex 계정이 있어야 도는데, 계정 스토어의 `authEnc`는 DPAPI로 잠겨 있어 하네스가 합성
   계정을 심을 수 없다(실계정 로그인은 규율상 금지). 그래서 **와이어 → 창 목록 매핑과 판정
   접기는 단위 테스트로**, 「창구가 없으면 판정하지 않는다」는 **라이브로** 잠갔다.
   다음 라운드 숙제: `ccg-auth-probe`에 `seed-codex`를 달면 이 왕복까지 라이브로 잴 수 있다.
2. **`codex-auth:accounts-usage` 채널은 여전히 Rust에 없다.** 이번에 만든 조회기는 엔진 훅
   전용이라, 설정 ▸ Account의 OpenAI 게이지와 렌더러 `useLimitResume`의 codex 갈래는 아직
   빈 배열을 받는다(크리틱 R2 §8-3의 그 자리). 조회기를 채널로 노출하면 한 번에 닫히지만,
   `ipc/mod.rs`·`parity/mod.rs`가 다른 갈래와 겹쳐 이번 라운드에서는 손대지 않았다.
3. **`lite.rs:93`의 `autoResume && !auto_paused` 접힘에는 아직 테스트가 없다**(크리틱 지시 4).
   이번에 만든 시각 미상 착지도 그 줄에 기대므로, 다음 라운드에서 한 줄 잠그기를 권한다.
4. `poc-parity-t3t4`의 `T4-6b` 시간 가정(지시 3)과 `.gitignore`의 `.poc-scratch-*/`는
   이 갈래의 경계 밖이라 손대지 않았다.
