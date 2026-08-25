# R28f 「WFIRE」 R2 — 예산에 프로세스 경계를 넘는 다리를 놓는다

> 대상 크리틱: `docs/critic/r28e-wfire-critic-r1.md`(판정 **합격** · 남은 격차 §4.1~§4.4)
> 부모: `61d818a` *R28e WFIRE R1 — 상한의 단위를 바꾼다*
> 브랜치 `feature/3.0.0-beta` · 경계: `crates/ccg-engine/**` · `app/src/lib/limitResume.ts` ·
> `app/src/lib/useLimitResume.ts` · `app/src/components/Chat.tsx` · `crates/ccg-store/src/status.rs` ·
> `src-tauri/src/engine/{lite,hub}.rs` · `scripts/poc-limit-*.mjs`

## 0. 한 줄

R28e가 세운 예산은 **프로세스 경계 하나에 통째로 지워지고 있었다.** 그 경계에 네 칸짜리
다리를 놓고(디스크 → `HoldLite` → `ReloadHold` → `episode_fires`), 불변식의 **유효 범위를
60시간으로** 정확히 적고, 배너가 **예산 착지를 다른 말로** 하게 했다. 렌더러 축의
「도달 불가」는 고치는 대신 **계기로 못 박았다** — 왜 그렇게 골랐는지는 §3.

---

## 1. ★① 예산이 재시작을 넘는다 (크리틱 §4.1)

### 1-1. 무엇이 문제였나

크리틱의 실측 그대로다: `ReloadHold`에 `attempts`도 `fires`도 없어서 `reload_state`가 둘 다
`0`을 놓았고, **예산을 다 쓴 대본을 재장전하니 20시간 12발이 재충전**됐다. R28e 보고서가
「엔진만의 문제」로 신고한 것은 사실이었지만, 「렌더러는 `sanitizeHold`가 복원하므로 괜찮다」는
**실앱에서 성립하지 않았다**(§3).

### 1-2. 놓은 다리 — 네 칸

값이 지나는 길은 넷이고, **한 칸만 비어도 못은 초록인데 앱은 재충전된다.** 그래서 넷을 다 잰다.

| # | 자리 | 한 일 |
|---|---|---|
| ① | `hub::persist_hold` | 채팅 파일의 `hold`에 `attempts`·`fires`를 함께 적는다(`fires`는 표 **밖** `episode_fires`에서 읽는다) |
| ② | `ccg_store::status::HoldLite` | 그 두 칸을 파싱한다(`serde(default)` → 옛 파일은 0 = R28e 동작) |
| ③ | `engine::reload_pending`(`mod.rs`) | `ReloadHold`로 그대로 나른다 |
| ④ | `ChatRuntime::reload_state` | `hold.attempts = h.attempts` · `self.episode_fires = h.fires` |

**안 나르는 것도 규약이다.** `auto_paused`는 「지금 자동을 접었다」는 *판정 결과*이고 판정은
부팅 뒤 `check_hold`가 이 두 값으로 다시 한다(렌더러 `sanitizeHold`가 `autoPaused`를 안 살리는
것과 같은 규약). `auto_resume_at`/`auto_resume_fired_at`도 안 나른다 — 런타임 시계는 프로세스마다
0에서 다시 시작하므로 옛 ms를 새 축에 놓으면 구분자 ①·②가 거짓 「넘어갔다」를 낸다. 모르면
`None`이 정답이고 `None`은 **상한이 살아 있는 쪽**으로 떨어진다.

### 1-3. 실측 — 대조군을 못 안에 품는다

`crates/ccg-engine/tests/wcap_limit_streak.rs` ⑭·⑯은 **같은 바이너리·같은 대본·같은 재장전
경로**에서 새 칸만 0으로 두어 R28e의 동작을 재현한다. 즉 「고쳐졌나」와 「그 칸이 정말
원인이었나」를 한 못이 함께 잰다.

```
[WFIRE⑭] 재장전 뒤 20시간 — 예산 물려받음 0발(잔여예산 12 · 접힘 true)  vs  0으로 재장전 12발
[WFIRE⑯] 재장전 뒤 12시간 — 계수 물려받음 0발                          vs  0으로 재장전 2발
```

크리틱이 잰 두 숫자(**12발 재충전** · **+2발**)가 대조군에서 그대로 재현되고, HEAD에서 **0발**이다.

### 1-4. 실앱 실측 — 네 칸이 실제로 이어져 있나

못은 `reload_state`를 직접 부른다. 실앱은 위 네 칸을 지난다 — 그 간극을 **살아 있는 exe로** 잰다
(`scripts/poc-limit-engine.mjs`에 `--seed-fires`/`--seed-attempts`와 E11~E13을 더했다).

| 주행 | 심은 값 | 새 프로세스가 읽은 값 | 채팅 파일에 적힌 값 |
|---|---|---|---|
| `--seed-fires=12 --seed-attempts=2` | 12 / 2 | **`episodeFires` 12 · `attempts` 2** | `{"resetsAt":…,"ready":false,"attempts":2,"fires":12}` |
| 기본(대조군) | 0 / 0 | 0 / 0 | `{…,"attempts":0,"fires":0}` |

둘 다 **14 통과 / 0 실패**. 산출: `docs/critic/limit-engine-wfirer2-carry.json` ·
`docs/critic/limit-engine-wfirer2.json`.

읽는 창을 내려고 `engine:debug` 행에 `episodeFires`를 실었다 — 예산은 표 **밖**에 살아서
`hold` 안에 못 넣는다(표가 없어도 산다). 계약면(`ChatStatusLite.hold`)은 안 건드렸다.

### 1-5. 파리티 — 같은 대본을 두 축에

크리틱의 요구(★)대로 **같은 대본**(예산 소진 → 저장 → 복원)을 두 축에 먹였다.

| 대본 | 엔진(`wcap_limit_streak` ⑭⑯) | 렌더러(`poc-limit-resume` L⑥) |
|---|---|---|
| 예산을 다 쓴 표로 재시작 | 20시간 **0발** · `auto_paused` | **0발** · `ready`+`autoPaused` |
| 그 칸을 0으로 두면(R28e) | **12발** 재충전 | `resumeVerdict` = `{kind:'ready'}` = 12발이 새로 열린다 |
| 상한까지 쏜 표로 재시작 | 12시간 **0발** | `{kind:'ready', paused:true}` |
| 그 칸을 0으로 두면 | **2발** | `{kind:'ready'}` |

렌더러 쪽은 **실제 훅을 구동**해서 잰다(pref 모양 → `JSON` 왕복 → `sanitizeHold` → 새 훅에
얹고 타이머 발화). 궤적이 네 줄 다 일치한다.

---

## 2. ★② 불변식의 유효 범위는 60시간 (크리틱 §4.2)

R28e가 적은 「진짜 일한 밤샘 연속은 **안 잘린다**」는 **끝이 있는 문장**이었다. 참인 문장으로
고쳐 적었다 — **「약 60시간까지는 안 잘린다」**.

고친 자리 넷: `crates/ccg-engine/src/limit.rs`(`MAX_EPISODE_FIRES` 독) ·
`runtime.rs::check_hold`의 `budget_out` 주석 · `app/src/lib/limitResume.ts`(같은 상수) · 이 보고서.

그리고 **문장을 못으로 세웠다** — ⑮ `the_night_run_invariant_is_good_for_about_sixty_hours`:

```
[WFIRE⑮] 5시간 창 · 4.5시간 작업 — 60시간에 접힘 · 발사 12 · attempts 0 · auto_paused true
```

크리틱이 쓴 실전 눈금 그대로이고 값이 **정확히 60시간**이다. 범위의 반대쪽 끝(하룻밤은 한 발도
안 깎인다)은 ①이 이미 잠그고 있다 — 이번 라운드에서도 **7발 · attempts 0 · 안 접힘**으로 그대로다.

유지 조건을 문서에 명시했다: *하룻밤(12시간 = 7발)이 한 발도 안 깎이는 것.* 그 아래로 내려가면
`MAX_EPISODE_FIRES`를 올려야 한다.

---

## 3. ★① 렌더러 축 — 「도달 불가」를 정직하게 처리한다 (크리틱 §4.1 후반)

### 3-1. 사실

`sanitizeHold`의 계수·예산 복원 분기는 **실앱에 살아 있는 호출자가 없다.** 배선을 그대로 옮기면:

* `limitResume.hold` pref를 읽고 쓰는 곳은 `App.tsx` 본채팅 **하나**뿐이다.
* 그 훅은 **늘 `managed`**다 — `ccg_store::status::empty_lite`와 `engine/lite.rs`가 **조건 없이**
  `resumeOwner:"engine"`을 싣는다.
* `managed`면 `useLimitResume`이 `if (o.managed) return`으로 **장전 자체를 안 한다** → pref는 늘
  비고 → `sanitizeHold`가 받는 값은 언제나 `null`.
* 렌더러가 **실제로** 표를 드는 세 표면(멀티 패널·추가 채팅 창·팝아웃)은 `managed`를 아예 안
  넘기지만(= 살아 있다) **영속을 안 한다**. 설계상 런타임 전용이다.

`scripts/poc-limit-resume.mjs` **M절**이 이 네 줄을 **측정으로** 남긴다(주장이 아니라):
`empty_lite` 행과 `lite::build` 행을 실번들 `engineOwnsResume`에 먹여 둘 다 `true` · `managed:true`
훅에 한도 사망을 먹여 `hold === null` · 대조군으로 `managed:false`면 같은 대본에 표가 선다 ·
판별력으로 `resumeOwner:'renderer'`면 답이 `false`.

### 3-2. 무엇을 골랐고 왜

크리틱이 준 두 선택지를 다 재고 **셋째**를 골랐다. 근거를 그대로 적는다.

**① 도달 가능하게 만든다 — 안 했다.** `resumeOwner`는 *한 채팅에 재개 주체가 둘이 되는 것을
막으려고* 만든 선언이다(M-UX R2.9 · 재현 축: 한도로 죽은 턴 → 재시작 → 리셋 도달 → 전송이 한
번인가 두 번인가). 조건을 붙이는 순간 그 틈이 다시 열린다. 멀티 패널 쪽에 영속을 주는 길은 더
나쁘다 — 슬롯 키는 **자리 번호**(`String(slot)`)라 복원 시 그 자리에 다른 대화가 앉아 있으면
**남의 대화에 재개 프롬프트를 쏜다.**

**② 죽은 분기를 걷어낸다 — 안 했다.** 걷어내면 **파리티가 깨진다.** 같은 대본(예산 소진 → 저장 →
복원)을 두 축에 먹였을 때 엔진은 예산을 지키고 렌더러는 재충전하는, R28e가 야단맞은 그 모양이
**반대 방향으로** 생긴다(§1-5의 표가 두 줄 어긋난다). 이 파일의 함수들은 두 축의 **공통 규칙
그 자체**이고(`turnDidWork` 주석의 규약), 규칙을 한쪽만 지우는 것은 규칙을 바꾸는 것이다.
그리고 걷어내는 것도 반쪽이다 — pref를 **쓰는** 쪽(`App.tsx`)은 SHIPBLOCK 갈래의 파일이다.

**③ 골랐다: 규칙은 남기고, 「지금 도달 불가」라는 사실을 계기로 못 박는다.** M절이 그 못이고,
`limitResume.ts`의 `sanitizeHold` 독에 **왜 남겼는지 · 두 선택지가 왜 더 나쁜지 · 어디를 보면
도달 가능해지는지**를 적었다. `resumeOwner`가 언젠가 조건부가 되면 M절의 판별력 줄이 빨강이
되고, 그날의 독자가 그 주석을 본다.

### 3-3. 보고서 §미완 1의 문장 정정

R1 보고서(`docs/parity-fix-wfire-r1.md` §4-1)가 적은 문장:

> *"렌더러 쪽은 `sanitizeHold`가 `fires`를 복원하므로 두 축이 재시작에서 갈린다"*

**사실이 아니었다.** 두 축은 재시작에서 **같이 재충전**됐다 — 렌더러의 복원 분기가 실앱에서
도달 불가이기 때문이다. R1이 그 문장을 근거로 「엔진만의 문제」라고 범위를 좁힌 것이 신고의
오류다. 정확한 문장은 이렇다:

> **재시작 한 번 = 예산 통째로 재충전이 두 축의 공통 착지였다.** 엔진은 `ReloadHold`에 칸이
> 없어서, 렌더러는 그 칸을 쓰는 유일한 표면이 `managed`라 pref가 늘 비어서. R28f가 엔진 축을
> 닫았고(§1), 렌더러 축은 **규칙은 같지만 실행되는 표면이 없다**는 사실을 M절로 고정했다(§3-1).

또한 R1 §4-1이 적은 *"`src-tauri/src/engine/mod.rs`는 M10이 잡고 있어 손대지 않았다"*는 이번에
해소됐다 — 그 파일은 지금 워킹트리에서 깨끗하고, 이번 변경은 4줄(값 두 개를 그대로 나름)이다.

---

## 4. ★③ 배너가 예산 착지를 구분한다 (크리틱 §4.3)

접힌 표가 화면에 서는 길은 셋인데 R28e까지 문구는 둘뿐이었고, **둘 다 예산 착지에 대해 거짓**이었다.

| 착지 | 사실 | R28e 문구 | R28f 문구 |
|---|---|---|---|
| 예산 소진(`fires >= 12`) | 자동으로 12번 이어서 보냈고 그 턴들은 **`MIN_WORK`를 넘겨 일했다** | 렌더러: 「…계속 한도에 막혔어요」 / 엔진: 「한도가 풀렸어요」 | **「이 한도 창에서 자동으로 12번 이어서 보냈는데 계속 막혔어요 — 눌러서 이어가기」** |
| 연속 헛발질(`attempts >= 2`) | 문전박대만 당했다 | 「…계속 한도에 막혔어요」 | 그대로(정확했다) |
| 화면 밖(`auto:false`) | 한도가 **진짜로** 풀렸다 | 「한도가 풀렸어요 — 눌러서 이어가기」 | 그대로(정확했다) |

엔진은 이 셋을 스레드 공지로는 이미 갈라 말하고 있었다(`check_hold`의 `over`/`budget_out`) —
**화면 위 한 줄만** 셋을 하나로 뭉갰다. 배너 숫자는 그 공지의 숫자와 같다.

구현: 판정을 `limitResume.ts::budgetLanding(paused, fires)` **순수 함수 하나**로 두고 `Chat.tsx`의
두 갈래가 같은 함수를 본다(이 파일의 규약: 판정은 순수 함수, React 배선은 훅). 엔진 관장 갈래가
그 값을 받으려면 와이어에 두 칸이 필요해서 `engine/lite.rs`의 `hold`에 `fires`·`paused`를 실었다 —
`paused`가 따로 필요한 이유는 `autoResume:false`가 「예산으로 접혔다」와 「화면 밖이라 안 쏜다」를
구분하지 못하기 때문이다(둘 다 `auto:false`). `truth_from_chat_file`도 같은 키 집합으로 맞췄다
(규약 3 — 갈리면 부팅 행과 첫 허브 갱신이 달라 배너가 깜빡인다).

계약면(`src/shared/protocol.ts`)은 **안 건드렸다.** `resumeOwner`/`autoResume`과 같은 방식으로
`app/src/lib/resumeOwner.ts`의 선택적 확장으로만 읽는다 — 값이 없는 옛 셸에서는 R28e 문구 그대로다.

실측: `poc-limit-resume.mjs` L⑦ 6건(예산 착지 = 참 · 연속 헛발질 = 거짓 · 화면 밖 = 거짓 ·
`paused` 미탑재 = 거짓 · 실제로 접힌 표에서 참). 대조군(부모 트리)에서는 `lib3.budgetLanding is
not a function`으로 즉사 = 새 절이 이번 변경을 재고 있다.

---

## 5. ★④ 계기 잔류물 (크리틱 §4.4)

`crates/ccg-engine/tests/probe_wfire_crit.rs`(크리틱의 8건) · `probe_wfr2.rs`(10건)는 **미추적
그대로 뒀다** — 크리틱의 독립 계기를 내 커밋으로 삼키지 않는다. 다만 `ReloadHold`에 칸이 늘어
**구조체 리터럴이 컴파일을 깨므로** 두 파일에 `..Default::default()` 한 조각씩만 넣었다(값은
0/0 = 그 파일들이 재던 R28e 동작 그대로 · 커밋 안 함).

> **`cargo test -p ccg-engine` 수를 셀 때 이 둘(8 + 10 = 18)을 빼라.**
> 이번 라운드 실측: **249 통과 / 0 실패 / 2 ignored** → 추적본만 **231**(R28e 228 + 새 못 ⑭⑮⑯ 3).

---

## 6. 이번 라운드 실측 전부

### 6-1. Rust (전부 격리 `CARGO_TARGET_DIR=target-r28f-wfire`)

| 크레이트 | 결과 |
|---|---|
| `ccg-engine` | **249 / 0**(2 ignored) — 미추적 probe 18 포함 · 추적본 **231** |
| ↳ `wcap_limit_streak` | **16 / 0**(R28e 13 + ⑭⑮⑯) |
| `ccg-store` | **90 / 0** |
| `agentcodegui`(`--features custom-protocol`) | **154 / 0** |
| `ccg-fs` | **101 / 0**(2 ignored) |
| `ccg-lsp` | **59 / 0** |
| `ccg-auth` | **124 / 0**(9 ignored) |

### 6-2. 하네스 (전부 내가 빌드한 exe · `--features custom-protocol`)

| 하네스 | 결과 | 산출 |
|---|---|---|
| `poc-limit-resume.mjs` | **343 / 0**(R28e 322 → +21, 후퇴 0) | — |
| `poc-limit-engine.mjs`(seed 0) | **14 / 0** | `docs/critic/limit-engine-wfirer2.json` |
| `poc-limit-engine.mjs --seed-fires=12 --seed-attempts=2` | **14 / 0** | `docs/critic/limit-engine-wfirer2-carry.json` |
| `poc-limit-engine.mjs --long` | **17 / 0**(t=553s 손 넘김 · 전송 0B · 누르면 313B) | `docs/critic/limit-engine-wfirer2-long.json` |
| `poc-limit-codex.mjs` | **8 / 0**(C1 t=90s 정상 발사) | `docs/critic/limit-codex-wfirer2.json` |

**판별력 대조**(부모 트리 `git archive HEAD` → 레포 밖 `C:\Temp\ccg-r28f-wfire\ctl`, 현행 스크립트를
그대로 물림): L⑦에서 `TypeError: lib3.budgetLanding is not a function`으로 즉사. L⑥은 부모에서
**초록**인데 그것이 정확한 답이다 — 렌더러 축의 규칙은 R28e에 이미 있었고 이번에 바뀐 것은
**엔진 축**이며, 그쪽 판별력은 ⑭⑯이 못 안의 대조군으로 든다.

### 6-3. 타입체크

`npm run typecheck`(node·web) · `npm run typecheck:app` — **3종 exit 0**.

### 6-4. 자원·안전 규율

| 항목 | 결과 |
|---|---|
| `CARGO_TARGET_DIR` | `target-r28f-wfire` (배정표대로) |
| CDP 포트 | 10500·10501·10502·10503·10504·10505·10506·10507 (WFIRE 대역) |
| `CCG_HOME` | `C:\Temp\ccg-r28f-wfire\home-*` (전부 레포 **밖**) |
| 이름 기반 kill | **0** — 하네스가 스폰한 PID 트리만 |
| 실계정 접촉 | **0** — 합성 자격증명 + `CCG_NO_NET=1`(실 HTTP 0 = 토큰 회전 0) |
| `npm ci` | **0** |
| 기준 결과 파일 덮어씀 | **0** — 산출 4건 전부 `--out`으로 신규 |
| 동결 구역(`src/main`·`src/preload`·`src/renderer`·`out/`·`dist/`) | **0줄** |

**하네스의 홈·포트를 인자로 뺐다**(`--home=`/`--port=`). 다섯 갈래가 한 워킹트리에서 도는
라운드인데 `poc-limit-engine`/`poc-limit-codex`가 9425/9437과 레포 안 고정 홈을 하드코딩하고
있었다 — 두 갈래가 같은 시각에 돌리면 서로의 홈과 디버깅 포트를 밟는다. 기본값은 R28e 그대로다.

---

## 7. 미완 / 알려진 격차

1. **`ma:dispose`(패널 자리 접기)는 여전히 그 채팅의 대기표를 통째로 잃는다.** 슬롯을 거두면
   런타임이 사라지고, `ensure`가 다시 만들 때 **디스크의 hold를 안 읽는다**(부팅 경로
   `reload_pending`만 읽는다). 그래서 접힌 자리의 채팅은 다음 부팅까지 자동 재개를 못 한다 —
   이건 예산 문제가 아니라 **재개 자체가 멎는** 문제이고 R28f 이전부터 그랬다.
   **예산 축으로는 실손해가 거의 없다**: 표가 사라졌으니 자동 발사도 없고, 새 표가 서려면 새
   턴이 필요한데 그 턴이 사용자 것이면 `accept_user_message`(`runtime.rs`의 `origin ==
   QueueOrigin::User → episode_fires = 0`)가 **어차피 예산을 새로 연다.** 남는 구멍은
   *사람이 아닌 원본*(talk·notif_replay·viewer_ask)이 연 턴이 그 뒤에 한도로 죽는 좁은 판뿐이다.
   닫으려면 `ensure`가 디스크 hold를 되살리거나(= 접은 자리를 되살리는 동작 변경) 허브가 예산을
   기억해야 하는데, 둘 다 이번 요구 밖의 판단이라 **재지 않고 넘기지 않는다** — 위 문장이 실측
   근거(`hub.rs::ensure`에 재장전 호출 없음 · `runtime.rs:1366`의 User 리셋)와 함께 이번 라운드의
   답이다.
2. **`persist_hold`는 표가 없으면 `null`을 적는다.** 그래서 *발사한 직후 ~ 다음 표가 설 때까지*의
   짧은 창에 재시작하면 예산이 디스크에 없다. 그 창은 턴 하나(분 단위)이고 반대편 창(대기)은
   시간 단위라 실손해가 작아 그대로 뒀다. 예산을 표와 무관하게 영속하려면 채팅 파일에 표 밖
   필드를 하나 더 내야 하는데, 그건 계약면 변경이라 별개 판단이다.
3. **수명의 기준점이 두 축에서 여전히 조금 다르다**(R1 §4-3 그대로). 엔진은 *우리가 쏜 시각*,
   렌더러는 *스토어가 턴을 연 시각*. 5분 문턱에서 몇 초는 의미가 없다고 보고 남긴다 — 문턱을
   초 단위로 줄이면 그때는 파리티 격차가 된다.
4. **`unknown_wait`의 백오프는 여전히 `attempts`가 지수다**(R1 §4-4 그대로). 「일한 재개」 연쇄에서
   계수가 0이라 간격이 10분으로 유지된다 — 예산이 총량만 막고 간격은 안 늘린다. 창을 태운 턴을
   60분씩 기다리게 하는 것이 손해라 일부러 안 바꿨다.
5. **배너 문구의 픽셀은 안 봤다.** `budgetLanding`과 그 입력(와이어 두 칸 · 렌더러 표의 `fires`)은
   실번들로 쟀지만, `LimitHoldBar`를 실제로 렌더해 문자열을 확인하지는 않았다(JSX + 아이콘 +
   CSS를 끌고 오는 컴포넌트라 이 하네스의 대역 밖이다). 문장 자체는 타입체크와 정독으로만 봤다.

---

## 8. 만진 파일

| 파일 | 무엇을 |
|---|---|
| `crates/ccg-engine/src/runtime.rs` | `ReloadHold`에 `attempts`·`fires` · `reload_state`가 둘을 물려받음 · 60시간 주석 |
| `crates/ccg-engine/src/limit.rs` | `MAX_EPISODE_FIRES` 독에 유효 범위(60시간)와 유지 조건 |
| `crates/ccg-engine/tests/wcap_limit_streak.rs` | 못 ⑭⑮⑯(대조군 내장) + 머리말 표 |
| `crates/ccg-store/src/status.rs` | `HoldLite`에 두 칸 · `truth_from_chat_file`이 `fires`/`paused`를 실음 |
| `src-tauri/src/engine/hub.rs` | `persist_hold`가 두 칸을 적음 · `engine:debug`에 `episodeFires` |
| `src-tauri/src/engine/lite.rs` | `chat:status`의 `hold`에 `fires`·`paused` |
| `src-tauri/src/engine/mod.rs` | 재장전 경로가 두 칸을 나름(4줄 · 주인 없는 파일 · 워킹트리 깨끗했음) |
| `app/src/lib/limitResume.ts` | `budgetLanding` 신설 · 60시간 문장 · `sanitizeHold` 독을 사실대로 |
| `app/src/lib/resumeOwner.ts` | `EngineHold`에 `paused`·`fires`(선택적 확장 · 주인 없는 파일) |
| `app/src/components/Chat.tsx` | 배너 두 갈래가 예산 착지를 구분 |
| `scripts/poc-limit-resume.mjs` | L⑥·L⑦ · M절 · 343/0 |
| `scripts/poc-limit-engine.mjs` | `--seed-fires`/`--seed-attempts`/`--home`/`--port` · E11~E13 |
| `scripts/poc-limit-codex.mjs` | `--home`/`--port` |
| `docs/parity-fix-wfire-r2.md` | 이 문서 |

**미추적으로 남긴 것**(커밋 안 함): `crates/ccg-engine/tests/probe_wfire_crit.rs` ·
`probe_wfr2.rs`(`..Default::default()` 한 조각씩만 · §5) · `docs/critic/limit-*-wfirer2*.json` 4건.

**안 건드린 남의 경계**: `crates/ccg-auth/**`(CASX2) · `src-tauri/src/engine/talk.rs`(M10 · 이번
라운드에도 미커밋 변경이 앉아 있다) · `src-tauri/src/ipc/**`·`app/src/App.tsx`·`Settings.tsx`
(SHIPBLOCK) · `bench/**`·`docs/critic/tools/**`(AUDIT) · `progress/**`(리드).
