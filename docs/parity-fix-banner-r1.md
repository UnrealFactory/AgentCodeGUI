# R28g 「BANNER」 R1 — 재시작을 넘은 예산 위에서, 화면이 하던 거짓말을 걷는다

> 대상 크리틱: `docs/critic/r28f-wfire-critic-r1.md`(커밋 `fd0f01b` · 판정 **합격** · 남은 격차 F1~F5)
> 판정 대상이었던 커밋: `d461f21` *R28f WFIRE R2*
> 부모: `2071c36` · 브랜치 `feature/3.0.0-beta`
> 경계: `crates/ccg-engine/**` · `crates/ccg-store/src/status.rs` · `src-tauri/src/engine/{hub,mod}.rs` ·
> `app/src/lib/limitResume.ts` · `scripts/poc-limit-*.mjs`

## 0. 한 줄

R28f는 예산을 재시작 너머로 실어 날랐다(합격). 그런데 **그 재시작 뒤 화면이 거짓말을 했다** —
12발을 태우고 여전히 막힌 표에 대고 배너가 「한도가 풀렸어요 — 눌러서 이어가기」라고 말했다.
원인 세 칸 중 **접힘을 영속**(a)하는 것을 본선으로 삼고, 그 세 칸이 근거로 든 거짓 문장
(「판정은 부팅 뒤 `check_hold`가 다시 한다」)은 **주석을 고치는 대신 문장을 참으로 만들었다**(c) —
부팅 뒤 첫 판정 통행권. 두 축(엔진·렌더러)에 같은 대본을 먹여 궤적이 같음을 다시 쟀다.

---

## 1. ★F1 — 부팅 첫 프레임이 진실을 말한다 (본선 = (a) 접힘 영속)

### 1-1. 무엇이 문제였나

크리틱이 실앱에서 포획한 행이 전부다:

```json
{"chatId":"c-crit-carry","hold":{"resetAt":1787649364.888,"ready":true,"fires":12,"paused":false},
 "autoResume":false,"resumeOwner":"engine"}
```

실번들 `budgetLanding(false, 12) = false` · `canPressResume = true` → `Chat.tsx`의 사다리가
「한도가 풀렸어요 — 눌러서 이어가기」로 착지한다. R28d가 밤샘 축에서, R28e가 예산 축에서 고친
것과 **같은 종류의 거짓**이다.

세 칸이 겹쳐 만든 거짓이었다: ⓐ `hub::persist_hold`가 `auto_paused`를 일부러 안 적었고
ⓑ `status::truth_from_chat_file`이 부팅 행에 `"paused": false`를 **상수로** 적었으며
ⓒ 그 둘이 근거로 든 「판정은 부팅 뒤 `check_hold`가 다시 한다」가 **거짓**이었다.

### 1-2. 놓은 다리 — 다섯 칸(WFIRE의 네 칸과 같은 길)

| # | 자리 | 한 일 |
|---|---|---|
| ① | `hub::persist_hold` | `hold`에 `"paused": h.auto_paused`를 함께 적는다 |
| ② | `ccg_store::status::HoldLite` | `paused` 칸을 파싱한다(`serde(default)` → 옛 파일은 `false` = R28f 동작) |
| ③ | `status::truth_from_chat_file` | 부팅 행의 상수 `false`를 **파일이 말하는 값**으로 바꾼다 |
| ④ | `engine::reload_pending`(`mod.rs`) | `ReloadHold::paused`로 나른다 |
| ⑤ | `ChatRuntime::reload_state` | `auto_paused: h.paused` |

**왜 (a)를 본선으로 골랐나**(크리틱이 남긴 세 선택지 중): 참이었던 상태를 잃지 않는 것이 가장
정직하고, 부팅 행이 진실을 담으면 ⓑ의 상수도 자연히 사라진다. 그리고 결정적으로 — **화면의 첫
프레임은 재판정보다 먼저 온다.** 부팅 행(`truth_from_chat_file`)은 허브가 첫 tick을 돌기 전에
그려지고, 리셋 시각이 미래인 표라면 재판정은 몇 시간 뒤다. 재판정만 고쳤다면 그 창 내내 화면은
같은 거짓말을 계속했을 것이다.

### 1-3. 실측 — 대조군을 못 안에 품는다

`crates/ccg-engine/tests/wcap_limit_streak.rs` ⑰ (`--nocapture`):

```
[BANNER⑰] 접힘 물려받음 첫프레임 (true, 12)(예산문구 true) · 20시간 뒤 (true, 12) · 0발
      vs  R28f 대조군 첫프레임 (false, 12)(예산문구 false) · 20시간 뒤 (true, 12) · 0발
```

`(paused, fires)`가 곧 와이어의 두 칸이고, `예산문구`는 렌더러 실번들과 **같은 식**
(`paused && fires >= MAX_EPISODE_FIRES`)을 엔진 축에서 계산한 값이다. 같은 바이너리·같은 대본에서
`paused` 한 칸만 R28f처럼 두면 **첫 프레임이 그대로 그 거짓말**이다.

`crates/ccg-store/src/status.rs`의 새 못(`the_boot_row_says_a_folded_table_is_folded`)은 같은 자를
**부팅 행 생성기 자체**에 댄다 — 크리틱이 포획한 파일 모양을 그대로 심고, `paused` 칸이 없는
옛 파일(대조군)이 `false`를 내는 것까지 함께 잰다.

### 1-4. 실앱 실측 — 다섯 칸이 실제로 이어져 있나

못은 `reload_state`를 직접 부른다. 실앱은 다섯 칸을 지난다. `scripts/poc-limit-engine.mjs`에
**접힘 모드**(`--fold`)를 더해 살아 있는 exe로 그 간극을 쟀다. `--paused=1/0` 한 칸이 대조군
스위치다.

| 잰 것 | `--paused=1`(HEAD) | `--paused=0`(= R28f) |
|---|---|---|
| 앱이 내리는 행 | `{"resetAt":…,"ready":true,"fires":12,"paused":true}` | `{…,"paused":false}` |
| `budgetLanding` | **true** → 「12번 보냈는데 계속 막혔어요」 | **false** → 「한도가 풀렸어요」 |
| 엔진 런타임 | `autoPaused true` · `episodeFires 12` | `autoPaused false` · `episodeFires 12` |
| 디스크 왕복(앱이 다시 쓴 값) | `{…,"ready":true,"paused":true,"attempts":0,"fires":12}` | `{…,"paused":false}` |
| 120초 관찰 | spawns 0 · stdin 0B | spawns 0 · stdin 0B |

리포트: `docs/critic/limit-engine-r28gbanner-fold.json`(9/0) ·
`docs/critic/limit-engine-r28gbanner-foldctl.json`(9/0).

---

## 2. ★(c) 보강 — 「판정은 부팅 뒤 다시 한다」를 **참으로 만들었다**

### 2-1. 왜 주석 수정으로 끝내지 않았나

`check_hold`의 첫 문 `filter(|h| !h.ready)`는 **인프로세스에서는 옳다**: `ready`가 켜진 채 살아남은
표는 세 착지(접힘 · 화면 밖 · 조회 실패 소진) 중 하나이고, 다시 들여다보면 매 tick 같은 문장을
되뇐다. 그런데 **재장전은 그 tick의 바깥**이다 — 디스크의 `ready:true` 표는 *이 프로세스가 한 번도
판정하지 않은 표*인데 같은 필터에 걸린다. 크리틱 c8 실측이 그 값이다(자동 켬 + 20시간 **0발**).
그동안 배너는 「한도가 풀렸어요 — **곧 이어서 계속해요**」라고 말한다 — 침묵이 아니라 **거짓 약속**
(D7의 반대편)이고, F1과 뿌리가 같다. 성질 자체를 남겨 두면 다음 사고를 부른다.

### 2-2. 통행권 — `LimitHold::reloaded`

`reload_state`가 켜는 칸 하나. **통행권을 주는 조건이 곧 배너가 약속을 하는 조건**이다:

| 재장전된 `ready` 표 | 화면이 하는 말 | 통행권 |
|---|---|---|
| 자동 켬 · 안 접힘 | 「곧 이어서 계속해요」 = **약속** | **준다** — 약속을 지킨다 |
| 자동 끔(화면 밖) | 「눌러서 이어가기」 + 버튼 | 안 준다 — 이미 정직하고 출구도 열려 있다 |
| 접힘(`auto_paused`) | 「N번 보냈는데 계속 막혔어요」 + 버튼 | 안 준다 — §2-3 |

들어갈 때 **`ready`를 내린다.** 그래야 세 갈래(`Blocked` 재대기 · `Unavailable` 재확인 계수 ·
`Clear` 발사/접힘)가 인프로세스와 글자 그대로 같은 경로를 탄다. `ready`를 켠 채 들여보내면
`Blocked` 착지가 「아직 막혔는데 ready」라는 **새 거짓말**을 만든다(실제로 그 함정을 밟을 뻔했다 —
`Blocked` 가지는 `ready`를 안 내린다). 통행권은 **한 번**이고 판정에 들어가는 순간 소비된다.

### 2-3. 접힌 표를 통행권에서 뺀 이유 — 주장이 아니라 실측

접힘의 **근거**(`attempts`·`fires`)가 함께 디스크를 건너오므로 재판정은 **같은 답**을 낸다. 그
사실을 못 ⑰의 대조군이 잰다: 접힘을 안 물려준 표(`paused:false` + `fires:12`)를 그냥 계속 돌리면
통행권이 열려 **같은 자리에서 다시 접힌다**(위 실측의 「20시간 뒤 (true, 12) · 0발」). 즉 접힌 표에
통행권을 줘도 결과는 같고 **부팅마다 공지 한 줄이 더 붙을 뿐**이라, 안 주는 쪽을 골랐다.

### 2-4. 실측 — 엔진 못 ⑱

```
[BANNER⑱] ready 표 1발 · ready:false 1발 · 접힌 표 0발(ready true) · 화면 밖 0발(ready true)
```

`ready` 한 칸으로 답이 갈리면 그건 규칙이 아니라 사고다 — 그래서 `ready:true`행과 `ready:false`행이
**같은 수**임을 단언한다(R28f에서 앞쪽은 0발이었다).

### 2-5. 실앱 실측 — 통행권이 진짜로 열리고 닫히나

`--fold`의 F7·F8이 **같은 스위치로** 그것을 가른다(120초 관찰 · `CCG_NO_NET=1`):

| | `--paused=1`(접힘) | `--paused=0`(안 접힘) |
|---|---|---|
| t=85s | `ready=true probes=0 asks=0` | `ready=true probes=0 asks=0` |
| **t=90s**(= 재장전+90초 · `due_at`) | `ready=true probes=0 **asks=0**` | `ready=false probes=1 **asks=1**` |
| t=120s | 그대로 · 접힌 채 | `probes=2 asks=2`(재확인 사다리) |

R28f에서는 **양쪽 다 영원히 `asks=0`**이었다. 왼쪽 열은 「접힌 표는 판정에 안 들어간다」의 물증이고,
오른쪽 열은 「`ready` 표가 부팅 뒤 정확히 한 번 들어간다」의 물증이다. `CCG_NO_NET`이라 그 판정은
「못 물어봤다」로 착지해 재확인 사다리를 시작한다 = **인프로세스와 같은 경로**(§2-2).

---

## 3. 두 축이 같은 규칙인가 — 렌더러 축을 다시 맞췄다

R28f까지 두 축은 같은 문장을 적고 있었다: 「사실(`attempts`·`fires`)만 나르고 결론
(`autoPaused`·`ready`)은 복원 뒤 재검증이 다시 낸다」. 엔진 축에서 그 재검증이 **일어나지 않는다**는
것이 실측됐으므로, 엔진을 영속 쪽으로 닫은 이상 렌더러도 같은 규칙이어야 한다.

* `sanitizeHold`가 `autoPaused`를 되살린다. **`ready`도 함께** — 접힌 표의 출구는
  `canPressContinue = ready && autoPaused` 하나뿐이라, `ready`가 없으면 버튼이 안 뜨고 배너가
  「약 N 뒤 자동으로 이어서 계속해요」라는 **또 다른 거짓 약속**을 한다.
* 위험이 없는 이유는 접힘의 정의 그 자체다: 소진 effect의 첫 문이 `cur.autoPaused`에서 되돌아가고
  타이머 effect도 `hold.ready`에서 멎는다 — **사람이 누르기 전에는 한 글자도 안 나간다.** 그 사실을
  훅 실구동으로 쟀다(N②: 5회 tick · 전송 0 → 누르면 1발).
* 안 접힌 표의 `ready`는 **여전히 안 되살린다**(F절 대조군).

`scripts/poc-limit-resume.mjs` **N절**이 엔진 ⑰⑱과 같은 대본을 렌더러 축에 먹인다:

| 대본 | 엔진 | 렌더러 |
|---|---|---|
| 접힌 표로 재시작 → 첫 프레임 | `paused true · fires 12` → 예산 문구 | 같음 |
| 〃 그 뒤(20시간 / 타이머 5회) | **0발** · 접힌 채 · 버튼 있음 | **0발** · 접힌 채 · 버튼 있음 |
| 접힘을 안 물려주면(R28f) 첫 프레임 | `paused false` → 「풀렸어요」 | 같은 거짓말 |
| `ready`로 저장된 표(안 접힘·자동 켬) | **1발** | **1발** |

N③은 **크리틱이 포획한 실앱 원문 그대로**를 실번들 `resumeOwner.ts` → `budgetLanding`에 먹여
「고친 행 → 예산 문구 / R28f 행 → 「풀렸어요」」를 잰다. 버튼(`canPressResume`)은 두 행 다 있다 —
R28f에도 출구는 있었고 **틀린 것은 문장**이었다.

---

## 4. 곁가지 — 「분 단위」의 크기를 실측값으로 고쳤다 (크리틱 F2)

`persist_hold`는 표가 없으면 디스크에 `null`을 적으므로 *발사 직후 ~ 다음 표가 설 때까지* 예산이
디스크에 없다. R28f 보고서 §미완 2는 그 창을 「턴 하나(분 단위)」라고 적었는데 크리틱의 실측은:

| 대본 | 표가 디스크에 없는 시간 | 최장 공백 |
|---|---|---|
| 밤샘(45분 작업) | 5.25h / 12h = **44%** | 45분 |
| 5시간 창·4.5시간 작업(예산 12발을 정의하는 그 대본) | 54h / 70h = **77%** | **4.5시간** |
| 텍스트 즉사(빠른 헛돌이) | 0h (0%) | 0 |

그 표를 `ReloadHold::fires`의 독에 옮겨 적고, 같은 자리의 절대문(「되돌아가는 자리는 셋뿐 —
**재시작은 그 셋이 아니다**」)을 「예산을 0으로 되돌리는 자리는 셋이다 … 다만 절대문으로 적으면
거짓이다」로 고쳤다. **실손해는 여전히 제한적**(그 창에서 재시작하면 다음 표를 세우는 데 턴이
하나 필요하고, 그게 사용자 턴이면 어차피 예산이 열린다)이지만 문장은 사실이어야 한다.
`docs/parity-fix-wfire-r2.md`는 지난 라운드의 산출물이라 **안 고쳤다**(같은 워킹트리에 네 갈래가
도는 라운드라 남의 칸을 늘리지 않는다) — 정정은 코드 주석과 이 문단이 진다.

같은 이유로 정정하는 문장 하나 더(크리틱 F4): `sanitizeHold`에 **호출자는 있다**(`App.tsx:682` —
부팅마다 돈다). 없는 것은 **입력**이다(pref가 늘 `null` — M절이 그 사실을 계기로 잡고 있다).
그 주석의 표제 문장을 이 라운드에서 손대지는 않았다(같은 문단 아래가 이미 정확히 적고 있다).

---

## 5. 무후퇴 — 실측 전부

| 계기 | 결과 | 직전 기준 |
|---|---|---|
| `poc-limit-resume` | **357 / 0** | 343(크리틱) · 322(R28e) — 후퇴 0 |
| `poc-limit-engine` | **14 / 0** | 14 |
| `poc-limit-engine --seed-fires=12 --seed-attempts=2` | **14 / 0** | 14 |
| `poc-limit-engine --long` | **17 / 0** | 17 |
| `poc-limit-engine --fold --paused=1` | **9 / 0**(신규) | — |
| `poc-limit-engine --fold --paused=0`(대조군) | **9 / 0**(신규) | — |
| `poc-limit-codex` | **8 / 0** | 8 |
| `cargo test -p ccg-engine` | **251 / 0**(2 ignored) — 남의 미추적 프로브 18(`probe_wfire_crit` 8 + `probe_wfr2` 10)을 빼면 **추적본 233**(+2 = ⑰⑱) | 추적본 231 |
| `cargo test -p ccg-engine --test wcap_limit_streak` | **18 / 0**(+2) | 16 |
| `cargo test -p ccg-store` | **91 / 0**(+1) | 90 |
| `cargo test`(src-tauri · `--features custom-protocol`) | **161 / 0** | 154(크리틱 · 그 뒤 옆 갈래가 늘렸다) |
| `npm run typecheck`(node·web) · `typecheck:app` | **3종 exit 0** | — |

빌드: `target-r28g-banner`(갈래 전용) · `cargo build --release --features custom-protocol` ·
`agentcodegui.exe` sha256 `fe6190d03abafc678a95ee9543950e5e6d6363e772424a31514f99a9285347e1` ·
`ccg-fakecli.exe` `d3c4c4d0b14eddd8c6418a0b50e2038f76ac9e307fde86299512c8a772acd878` ·
`ccg-fakecodex.exe` `1b70b90c5e9293c5ad23db8742e0a085966d33a08c674d3062155c826d638998`.
격리 홈 `C:\Temp\ccg-r28g-banner\home-{fold,foldctl,eng,seed,long,cx}` · CDP 10610~10615 ·
`CCG_NO_NET=1` · 합성 자격증명 · 사용자 실홈 접촉 0 · 이름 기반 kill 0회(전부 `killTree(내 pid)`).

**WFIRE가 세운 것은 한 발도 안 깎였다**: 예산 12발(못 ⑫) · `MIN_WORK`(⑩⑪) · 재시작을 넘는 예산
(⑭) · 밤샘 7발/60시간(①⑮) · 헛발질 2발(③⑯) 전부 초록 그대로.

---

## 6. 미완 / 알려진 격차

1. **화면 안팎 전환으로 자동이 켜져도 재판정은 없다.** 통행권을 켜는 자리는 `reload_state`
   하나다. 「화면 밖에서 `ready`가 된 표 → 그 채팅이 보이게 됨 → 자동 발사」는 안 산다.
   **실앱에서는 도달 불가**다 — 셸이 `set_auto_resume`을 부르는 자리는 `Op::Reload` 하나뿐이고
   (`grep set_auto_resume` = 정의 1 + 테스트 3 + `hub.rs:901`), 자리 가시성 변화가 그 값을 흔드는
   배선은 3.0에 아직 없다. 배선이 생기는 날 `set_auto_resume(false→true)`에서 통행권을 한 장 켜면
   되고, 그때 이 문단이 그 자리를 가리킨다. 지금 켜면 **도달 불가 동작**을 늘리는 것이라 안 켰다.
2. **`ma:dispose`는 여전히 그 채팅의 표와 예산을 통째로 잃는다**(R28f §미완 1 그대로 · 크리틱 F5).
   `Hub::ensure`가 디스크 hold를 안 읽는다. 이번 라운드의 판단 밖이라 안 건드렸다.
3. **`probes`는 여전히 안 영속한다.** 그래서 「조회 실패로 접힌 표」(`MAX_BLIND_PROBES` 착지)는
   재시작 뒤 `probes:0`으로 돌아온다. 접힘 자체는 이제 살아 돌아오므로(그 표도 `auto_paused`다)
   **재확인이 처음부터 다시 돌지는 않는다** — 통행권이 접힌 표에는 없기 때문이다. 즉 이 칸의
   실손해는 지금 0이고, 접힘 통행권 정책이 바뀌면 그때 같이 봐야 한다.
4. **배너 문구의 픽셀은 안 봤다**(R28f §미완 5 그대로). `budgetLanding`과 그 입력(와이어 두 칸)은
   실번들·실앱으로 쟀지만 `LimitHoldBar`를 렌더해 문자열을 확인하지는 않았다. `Chat.tsx`는 이번
   라운드에 **한 줄도 안 고쳤다** — 사다리는 이미 옳았고 틀린 것은 입력이었다.
5. **`--fold` 대조군의 「다시 접히는」 순간까지는 실앱으로 안 봤다.** `CCG_NO_NET` 판에서 그
   착지는 재확인 사다리 끝(≈+470초)이라 `--long` 규모다. 그 자리는 못 ⑰이 가상 시계로 잰다.

---

## 7. 만진 파일

| 파일 | 무엇을 |
|---|---|
| `crates/ccg-engine/src/queue.rs` | `LimitHold::reloaded`(부팅 뒤 첫 판정 통행권) + 독 |
| `crates/ccg-engine/src/runtime.rs` | `ReloadHold::paused` · `reload_state`가 접힘·통행권을 놓음 · `check_hold`의 통행권 게이트 · `fires` 독의 절대문 정정(44~77% 표) |
| `crates/ccg-engine/tests/wcap_limit_streak.rs` | 못 ⑰⑱(대조군 내장) + 머리말 표 · `ReloadHold` 리터럴 둘 |
| `crates/ccg-store/src/status.rs` | `HoldLite::paused` · `truth_from_chat_file`의 상수 제거 · 부팅 행 못(대조군 내장) |
| `src-tauri/src/engine/hub.rs` | `persist_hold`가 `paused`를 적음 + 주석 정정 |
| `src-tauri/src/engine/mod.rs` | `reload_pending`이 `paused`를 나름(**경계 밖 4줄** — 아래) |
| `app/src/lib/limitResume.ts` | `sanitizeHold`가 `autoPaused`+`ready` 복원 · `LimitHold` 두 독 정정 |
| `scripts/poc-limit-engine.mjs` | `--fold` 모드(F0~F8 · `--paused` 대조군 스위치) |
| `scripts/poc-limit-resume.mjs` | N절(두 축 궤적) · F절의 옛 규칙 단언 3줄 교체 |
| `docs/critic/limit-{engine,codex}-r28gbanner-*.json` | 신규 리포트 5개(`--out` · 기준 파일 덮어쓴 것 0) |

**경계 밖 신고 1건** — `src-tauri/src/engine/mod.rs` 4줄(`reload_pending`의 `paused: h.paused`).
이 파일은 어느 갈래의 소유표에도 없고, 이 한 줄이 없으면 다섯 칸 다리의 ④가 끊겨 나머지가 전부
헛일이 된다. R28f도 같은 이유로 같은 함수를 4줄 고쳤다(그 라운드 크리틱 §8이 그대로 승인).

**안 만진 것**: `src-tauri/src/engine/talk.rs` · `src-tauri/src/ipc/**` · `app/src/App.tsx` ·
`app/src/components/{Chat,Settings}.tsx` · `app/src/lib/{useLimitResume,resumeOwner}.ts` ·
`crates/ccg-auth/**` · `bench/**` · `progress/**`. 남의 미커밋 변경
(`scripts/critic-m10-*.mjs` · `scripts/poc-talk.mjs` · `src-tauri/src/engine/talk.rs` ·
`src-tauri/src/ipc/accounts.rs`)은 reset·checkout·stash 하지 않았고, 미추적 프로브 둘
(`crates/ccg-engine/tests/probe_wf*.rs`)은 커밋에서 뺐다(테스트 수에서도 뺐다 — §5).
