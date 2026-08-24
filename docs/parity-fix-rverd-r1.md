# R28b 「RVERD」 R1 — 렌더러에 남아 있던 **쌍둥이 구멍** 둘을 닫는다

빌더: RVERD 갈래 · 2026-08-24 · `feature/3.0.0-beta`
커밋: **`63bf667`**(두 구멍 + 하네스 + 라이브 리포트)
과녁: CRIT 확인 크리틱 R1(`docs/critic/r28b-crit-critic-r1.md`) **§4.1 — 다음 라운드 지시(우선순위 1)**

크리틱이 적은 통과 조건 두 줄을 그대로 옮긴다:

> esbuild 하네스에서 시각 미상 표가 **유한 회차에 `ready`**가 되고, **`accountsUsage()`가 빈 배열이 아닐 것.**

둘 다 실측으로 만족했다. **시각 미상 표는 3회차에 `ready`**(수정 전: 20/20 hold),
**`accountsUsage()`는 2행**(수정 전: `{"__unimplemented":true}` → `[]`).

---

## 0. 한 문단 결론

**엔진에서만 닫혀 있던 「시각 미상 표에도 출구」가 렌더러에서도 닫혔다.** `resumeVerdict`의
사다리 한 조각(`!past`)이 `resetsAt == null`인 표에서 **영원히 참**이라 상한(`MAX_AUTO_ATTEMPTS`)이
판정에 한 번도 닿지 못했다 — 그 표는 재확인만 무한 반복하고 「이어가기」도 자동 재개도 오지
않았다. 엔진(`runtime.rs:3240`)과 같은 뜻으로 맞췄다: `probes <= MAX || (known && !past)`.
**그리고 `codex-auth:accounts-usage`가 Rust에 생겼다** — codex 채팅의 렌더러 재검증이
R1까지 언제나 「못 물어봤다」였던 이유가 그 빈 채널이었고, 설정 ▸ Account의 OpenAI 게이지도
같은 채널로 산다. 조회기는 **새로 만들지 않았다**: CRIT 갈래가 만든 `engine/codex_limit.rs`의
같은 왕복·같은 캐시를 그대로 노출했다.

| 무엇 | 수정 전(크리틱 실측/내 실측) | 수정 후(내 실측) |
|---|---|---|
| 시각 미상 표 + 조회 실패 20회 | `ready` 도달 **없음(20/20 hold)** | **3회차에 `ready`** |
| 시각 아는 표(해제 시각 미래) | hold | **hold**(안 흔들렸다) |
| `ipc_call('codex-auth:accounts-usage')` | `{"__unimplemented":true}` | **행 2개**(83ms) |
| `window.api.codexAuth.accountsUsage()` | `[]` | **행 2개** — `planType`·라벨·`resetsAt` 실물 |
| codex 재검증의 착지 | `unavailable: true`(언제나) | **`unavailable:false` · `blockedUntil` 실값** |

---

## 1. 무엇을 고쳤나

### 1.1 `resumeVerdict`의 마지막 한 칸 (`app/src/lib/limitResume.ts`)

```ts
// R1
if (probes <= MAX_AUTO_ATTEMPTS || !past) return { kind: 'hold', … }
// 지금
const known = hold.resetsAt != null
const past = known && hold.resetsAt! <= nowSec
if (probes <= MAX_AUTO_ATTEMPTS || (known && !past)) return { kind: 'hold', … }
```

`past`는 **시각을 알 때만** 참이 될 수 있다. 그래서 `resetsAt == null`인 표에서는 `!past`가
영원히 참이고, 오른쪽 항이 언제나 이겨 상한이 죽은 코드였다. 엔진은 CRIT R1에서 같은 구멍을
`known && !past`로 닫았다 — 이제 두 사본이 **같은 문장**이다(회차 수는 각 사다리의 것을
그대로 둔다: 엔진 `MAX_BLIND_PROBES=6`, 렌더러 `MAX_AUTO_ATTEMPTS=2`).

착지의 모양은 두 사본이 다르고, 그건 **의도된 차이**다(runtime.rs 주석이 먼저 적어 둔 것):
엔진은 `ready + auto_paused`(버튼만, 아무것도 안 태운다), 렌더러는 `ready`(눈감고 한 번 쏜다).
렌더러의 그 자리는 원래부터 2.6.2의 동작이고 — 시각을 아는 표에서 이미 그랬다 — 시각 미상
표에도 같은 규칙을 준 것이다. 이 판의 재전송 간격은 **10분 이상**이다(첫 프로브가 `PROBE_MS`
10분, 이후 15·30초): 2.6.2가 시각 미상 표에 하던 10분 간격과 같은 자리다.

### 1.2 `codex-auth:accounts-usage` 채널 (`src-tauri/src/…`)

```text
window.api.codexAuth.accountsUsage()        (app/src/api/shim.ts:273 — 이미 있었다)
  → ipc_call('codex-auth:accounts-usage')
     → ipc/parity/mod.rs  owns() → spawn_blocking 팔 → dispatch
        → engine::codex_limit::accounts_usage()      ← ★ 새로 생긴 12줄
           · 등록 codex 계정마다 한 행(등록 순서 = 맨 위가 기본)
           · 캐시가 신선하면 프로세스 0개(성공값 2분 · 실패값 20초)
           · 아니면 fill() → account/rateLimits/read 한 왕복(≈0.7초)
```

**조회기를 새로 안 만든 것이 이 조각의 요점이다.** `codex_limit`은 이미 워커 스레드에서
같은 왕복을 하고 있었고(엔진 재검증용), 사본을 만들면 그 둘이 각자 만료를 세면서 app-server를
번갈아 태운다(클로드 축에서 이미 겪은 사고 — `parity/mod.rs`의 `pub mod usage` 주석). 그래서:

* 캐시 한 칸이 **행 하나**(`{planType, windows}`)가 됐다. `peek()`은 창 목록만 꺼내 주므로
  `limit_probe`의 판정 경로는 **한 글자도 안 바뀐다**(`fold_codex`가 읽는 두 필드 그대로).
* 창에 `label`이 붙었다 — 렌더러가 **문자열로** 주간 창을 찾기 때문이다
  (`Chat.tsx cxUsageLine`의 `'주간'|'Weekly'`). 2.6.2 `windowLabel`의 규약 그대로다.
* `planType`은 스토어에 되싱크한다(2.6.2 `codexAccountsUsage`의 그 줄 — `ccg_auth::codex::resync_plan`.
  이 라운드까지 그 함수는 **호출자가 하나도 없었다**).

TTL을 둘로 나눈 이유: 성공값은 2분(2.6.2 `CX_USAGE_TTL`), **실패값은 20초**다. 실패를 2분
붙들면 사용자가 설정을 여닫아도, 재검증이 15초 사다리로 다시 물어도 같은 실패만 돌아온다.

### 1.3 안 한 것 (범위 밖 — 지시대로)

* `managed`를 멀티 패널·팝아웃까지 넓히기(§3의 배경). **손대지 않았다.** 1·2가 그 표면을
  렌더러 기계째로 살린다.
* 자동 계정 전환의 엔진 축 혼동(크리틱 §4.2). 다음 라운드 후보로 남아 있다.

---

## 2. 실측

### 2.1 판별력 — 같은 조각을 **수정 전 조건**에 먹였다

레포 밖(`%TEMP%\ccg-rverd-disc`)에서 `limitResume.ts`를 두 벌 번들해 같은 입력을 먹였다
(원본은 한 글자도 안 고쳤다 — 사본에서 조건만 R1로 되돌렸다):

```
OLD 시각 미상 표: probes=1:hold 2:hold 3:hold 4:hold 6:hold 20:hold | 20회 중 ready 도달 = 없음(20/20 hold)
    대조(시각 아는 미래 표, probes=10): hold
NEW 시각 미상 표: probes=1:hold 2:hold 3:ready 4:ready 6:ready 20:ready | 20회 중 ready 도달 = 3회차
    대조(시각 아는 미래 표, probes=10): hold
```

윗줄이 크리틱 §4.1의 `20/20 'hold'`를 **그대로 재현**한다. 아랫줄이 이 라운드다.
그리고 **대조군이 두 판에서 같다** = 시각을 아는 표의 사다리는 안 흔들렸다.

### 2.2 `poc-limit-resume` — **164 통과 / 0 실패** (기준 141/0)

`node scripts/poc-limit-resume.mjs`. 늘어난 23은 전부 이 라운드의 것이고, **바뀐 4개**는
계약이 바뀐 자리다(정직하게 적는다 — 아래 넷은 R1에서 초록이던 단언이다):

| 자리 | R1 단언 | 지금 |
|---|---|---|
| F절 | 「상한 초과여도 시각 미상이면 **절대 안 쏜다**」 | 상한 안(1·2회차)은 유지 · 넘기면 출구 |
| G절 ②(세 표면) | 「시각 미상 + 조회 실패 5회 → 유지·전송 0」 | 1·2회차 유지 → **3회차 출구(전송 1)** · 그 뒤 추가 전송 0 |

새로 심은 절 H(codex 축, 6 시나리오)가 **두 수정이 만나는 자리**를 잰다 — 채널이 빈 배열인
판(= R1의 셸)에서도 3회차에 출구가 있고, 채널이 값을 주면 그 값으로 재장전/발사한다:

```
H. codex 축 — 채널이 값을 주는 판 / 못 주는 판
   ① 빈 배열   → 2회차까지 유지(전송 0) → 3회차 출구(전송 1) · cxCalls≥3
   ② 소진 창    → 장전 정제로 그 시각이 앉고, 재검증도 그 시각으로 재장전(probes=0 · 전송 0)
   ③ 여유 창    → 이어서 전송 1회
   ④ 계정 여럿  → 남의 계정이 100%여도 내 행으로 판정(전송 1)
   ⑤ 계정 미지정 → 첫 행(기본 계정)으로 판정
   ⑥ 채널이 던짐 → 실패로 읽고 유지
```

### 2.3 `poc-codex-usage`(신규) — **라이브 9 통과 / 0 실패**

`node scripts/poc-codex-usage.mjs` (내 exe · 격리 홈 `.poc-home-rverd` · CDP 9455).
판은 크리틱 §2.2가 연 길 그대로다: **DPAPI로 봉인한 합성 codex 계정 둘**(`safe_storage::decrypt`는
`v10` 접두사가 없으면 DPAPI 직접으로 푼다) + `CCG_CODEX_BIN`에 꽂은 가짜 app-server.
**`CCG_NO_NET`은 끄고** 돌았다(그 스위치가 `read_row`를 즉사시킨다) — 그래도 실 HTTP는 0건이다.

```
U1 ★★ ipc_call이 미구현이 아니다 — 행 2개 · 83ms   (크리틱이 {"__unimplemented":true}를 받은 자리)
U2 ★★ accountsUsage()가 빈 배열이 아니다 — len=2   (크리틱이 적은 통과 조건)
U3 행 모양 = 계약면 CodexAccountUsage — planType:"pro" · windows 2개 · usedPct 100 · resetsAt 실값
U4 라벨 = ["5시간","주간"]                          (렌더러가 문자열로 찾는 그 값)
U5 ★ account/rateLimits/read가 실물로 나갔다 — asks=2 (가짜 app-server의 stdin 로그)
U6 ★ 두 번째 호출은 캐시로 답한다 — asks 2→2 · 83ms→2ms
U7 스토어 plan이 free→pro로 되싱크됐다
U8 ★★ 재검증이 「못 물어봤다」에서 벗어났다 — unavailable:false · blockedUntil=창 실값
```

산출: `docs/critic/rverd-r1-codexusage.json`(신규 파일 — 기준 결과 0개 덮음).

### 2.4 회귀 그물

| 대상 | 값 | 비고 |
|---|---|---|
| `cargo test --bin agentcodegui` | **140 / 0** | 이 라운드 +3(아래) · 나머지 +4는 **다른 갈래의 미커밋 테스트**다 |
| `cargo test -p ccg-engine` | **203 / 0** | 기준과 같다(안 건드렸다) |
| `cargo test -p ccg-store` | **79 / 0** | 기준 76 + 다른 갈래 미커밋 3 |
| `cargo test -p ccg-auth --features net` | **116 / 0** | 기준과 같다 |
| `npm run typecheck`(node·web) · `typecheck:app` | **3종 초록** | |

이 라운드가 심은 Rust 테스트 셋:
`the_window_labels_are_the_strings_the_renderer_matches_on`(라벨 규약 — 한 글자 어긋나면
「주간 소진」 줄이 조용히 사라진다) · `the_channel_answers_with_one_row_per_registered_account`
(등록 0이면 빈 배열 · 실패는 「창 0개」 · 실홈으로 안 샌다) ·
`the_codex_usage_channel_is_claimed_by_the_blocking_arm`(이름 오타·`owns` 누락 = 조용한 미구현).

빌드: `CARGO_TARGET_DIR=target-rverd cargo build --release --features custom-protocol`
→ exe **6,444,544바이트** · md5 `ad7fffc340f12ca3162a01d556602cc6`.

---

## 3. 정직하게 적는 줄

1. **내 exe는 순수 HEAD가 아니다.** 빌드 시점 워킹트리에 다른 두 갈래(ACCT·GIT)의 미커밋
   변경이 있었다(`engine/lite.rs`·`engine/hub.rs`·`ipc/parity/usage.rs`·`crates/ccg-fs/src/git.rs` 등).
   이 판정이 밟는 경로(`engine/codex_limit.rs`·`ipc/parity/mod.rs`·`app/src/lib/limitResume.ts`)는
   전부 내 것이고, 위 테스트 수의 초과분(+4 / +3)이 그 사실의 물증이다.
2. **`ready`의 착지는 두 사본이 다르다**(§1.1). 렌더러는 상한을 넘긴 마지막 회차에 한 번 쏘고,
   엔진은 버튼만 준다. 이번 라운드는 지시대로 **조건**을 맞췄고 착지는 각 사본의 것을 뒀다.
   렌더러도 `auto_paused` 같은 「안 쏘는 ready」를 갖는 것이 더 나은지는 다음 라운드의 질문이다.
3. **가짜 app-server로 잰 값이다.** 실 OpenAI 계정의 `account/rateLimits/read` 왕복은
   이 하네스가 재지 않는다(실계정 토큰 회전 금지). 와이어 모양은 CRIT R1이 남긴 실물
   매핑(`parse`의 테스트 픽스처)과 같다.
4. **`accounts_usage()`는 계정 수만큼 직렬로 프로세스를 태운다**(첫 조회 한정). 2.6.2는
   `Promise.all`이었다. 계정 다섯이면 첫 조회가 ≈3.5초일 수 있다 — 블로킹 팔이라 다른
   IPC를 굶기진 않지만, 게이지가 그만큼 늦게 찬다. TTL 뒤에는 0개다.
