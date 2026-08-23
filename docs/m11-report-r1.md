# M11 R1 — 한도 소진 시, 기다리지 않고 노는 계정으로 갈아탄다

3.0.0 신기능 3. **설정 옵션이고 기본은 꺼짐이다.**

한도에 걸린 대화는 지금까지 리셋 시각을 기다렸다(대기표 → 재검증 → 이어서). 계정이
여러 개인 사용자에게 그건 낭비다 — 다른 계정은 놀고 있고, 그중 어떤 계정은 **10분 뒤에
리셋되면서 남은 잔량을 통째로 버린다.** 그래서 규칙이 셋이다.

| # | 규칙 | 왜 |
|---|---|---|
| ① | **노는 계정만** 후보 | 다른 대화가 태우는 계정으로 옮기면 둘이 한 창을 나눠 쓰다 둘 다 막힌다 |
| ② | **여유가 있어야** 후보(≥5%p) | 99% 계정으로 옮기면 스폰 한 번 태우고 같은 자리로 돌아온다 |
| ③ | 그중 **초기화가 임박한 순서** | 곧 리셋될 창의 잔량은 **버려질 잔량**이다. 먼저 태우는 쪽이 총량에서 이득이고, 10분 뒤 그 계정은 다시 가득 찬다 |

설정 화면에서 이 토글이 **계정 목록 정렬 버튼 바로 아래**에 사는 이유가 그것이다:
그 버튼에 이미 「초기화 임박순」이 있고, 같은 규칙이다.

---

## 1. 실증 — 실 창 6판 (`scripts/poc-account-switch.mjs`, 단언 17건)

실계정 0건 · 네트워크 0건. 계정은 합성(`ccg-auth-probe seed` — 이 자리에서 만든 가짜
토큰), 한도는 합성(계정별 대본을 읽는 가짜 CLI), usage는 합성(`usage-cache.json` 직접
심기) + `CCG_NO_NET=1`. 산출물: `docs/critic/m11-r1-switch.json`.

| 시나리오 | 재료 | 실측 |
|---|---|---|
| **후보 있음** | a 소진 · soon(30분 뒤 리셋·여유 45) · late(4시간 뒤·여유 95) | → **soon**. 여유가 두 배인 late를 제치고 **임박한 쪽**을 골랐다. 배너 1개 · 대기표 없음 · `spawns=2` |
| **후보 없음** | 계정 1개 | 전환 0 · 대기표 섬(`resetsAt` 살아 있음) · 재스폰 없음(`spawns=1`) |
| **설정 꺼짐** | 후보 있음과 **같은 재료**, 토글만 off | `accountSwitch.on=false` · 계정 그대로 · 대기표 · `spawns=1` = 후보 없음 판과 구별 불가 |
| **오염 스킵** | dirty(10분 뒤 리셋 = 임박 1등)가 a와 **같은 토큰** | → **clean**(2시간 뒤). `skipped[dirty].why = "contaminated"` |
| **연속 소진** | a·b 소진, c 정상 | `a→b`, `b→c` 배너 2개 · `spawns=3` · c에 착지 · 대기표 없음 · **A로 안 돌아감** |
| **설정 토글** | 계정 2개, off로 시작 | Account 탭의 스위치 = **기본 꺼짐** → 클릭 → `ui-prefs.json{limitSwitch.on:true}` → 엔진 진단 `on:false→true` |

### 배너 (실 창 스레드에서 읽은 문장)

```
한도에 걸릴 질문
Claude AI usage limit reached|1787509821
사용 한도에 걸려 soon@ccg.test 계정으로 바꿔 이어갑니다 — 이 계정은 약 29분 뒤 초기화돼요.
계정 변경(으)로 새 프로세스에서 시작했어요
이어서 진행해 주세요
OK-soon_ccg.test
```

꼬리(「약 29분 뒤 초기화돼요」)가 **왜 이 계정인가**의 답이다. 모르면 그 절이 통째로
빠진다 — 지어내지 않는다(모델 폴백 배너와 같은 규약).

### 되돌리기

배너가 `switch.revertTo`(= 전환 **직전** 리비전)를 실어 온다. 그대로
`chat:identity-revert`에 넘긴 실측:

```
전환   : revision 0 → 1   origin=auto_account_switch  changed=[billingAccount]  account=soon@ccg.test
되돌림 : revision 1 → 2   origin=revert                                          account=a@ccg.test
```

되돌리기는 **새 리비전**이다(히스토리 삭제가 아니다 — m-logic §6.3).

### 실 HTTP — 1건

`ccg-auth/src/net.rs`가 정말 도는지만 실계정 1건으로 쟀다(복사본 홈 · 리프레시 없음):

```
GET /api/oauth/usage  →  200 · 460ms
  fiveHourPct 25 (resets 1787503200) · weeklyPct 81 · fablePct 27
CCG_NO_NET=1 로 같은 명령  →  skipped: CCG_NO_NET
```

---

## 2. 인수인계본에서 **틀려 있던 것** 넷 (전부 자기 재생으로 잡았다)

R1 부분 작업은 `cargo check`를 통과했지만 **재생 8판 중 3판이 실패하고 1판은 영원히
끝나지 않았다.** 검증 없이 신뢰하면 안 되는 이유의 표본이다.

### ① `try_auto_switch`가 `arm_hold` 한복판에서 드레인했다 → **무한 루프**

`arm_hold`는 `on_result` 안에서 불린다. 그 순간 죽은 턴의 CLI는 **아직 살아 있다**
(EOF도 `land_turn`도 아직). 거기서 `drain_if_possible()`을 부르면 재개 나팔이
**옛 계정 프로세스로** 나가 같은 한도 에러를 다시 받았다.

실측(재생 ①): 계정은 b로 갈렸는데 `hold=Some(...)`이 남았다 — 사용자 눈에는
"갈아탔는데 또 대기". 재생 ④(A→B→C)는 **영영 끝나지 않았다**.

고침: 나팔만 큐 head에 넣고 발사는 호출자에게 맡긴다 — `consume_hold`와 **같은 규약**.
드레인은 `check_hold`(tick의 끝 = 재진입 없는 발사대)가 한다.

### ② 에피소드 정리가 표의 생사만 봤다 → **A→B→C→A 핑퐁**

`on_result`의 `if self.hold.is_none() { switch_tried.clear() }`. 그런데 바로 위
`arm_hold`가 표를 걸고 그 안에서 전환이 성사되면 표는 다시 `None`이 되어 돌아온다.
그러면 이 줄이 "한도 없이 착지했다"로 오독하고 **방금 거쳐 온 계정을 지운다**.

고침: `limited`(분류 결과) — 표의 생사와 무관한 사실 — 을 게이트로 쓴다.
전환이 없던 판에서는 동작이 한 글자도 안 바뀐다.

### ③ 큐에 주차된 사용자 메시지가 **소진된 계정으로 나갔다**

큐 항목은 접수 시점 정체성 스냅샷을 들고 다니고 드레인은 그 스냅샷으로 스폰한다.
사용자가 직접 계정을 바꿨을 때는 그게 옳다. 그러나 자동 전환이 떠나는 계정은 **방금
한도로 막힌 계정**이다 — 실측 `spawns=["a_x","a_x"]`, 갈아탄 뒤에도 옛 계정으로 나갔다.

고침: **소진된 축에 못 박힌 항목만** 새 계정으로 옮긴다. 사용자가 손수 다른 계정을
골라 둔 예약은 건드리지 않는다. (`OnDrift`는 선언만 있고 읽는 자리가 없다 — 그 배선은
이 라운드의 몫이 아니라 축 비교로 같은 뜻을 냈다.)

### ④ 대기 문장이 **0.3초 만에 거짓이 됐다** (실물 주행에서만 보였다)

첫 실물 주행의 스레드:

```
사용 한도에 걸려 대기합니다 — 풀리는 시각에 맞춰 이어서 보낼게요.
사용 한도에 걸려 soon@ccg.test 계정으로 바꿔 이어갑니다 …
```

셸의 한도 스냅샷이 차가워서 첫 물음이 "조회 중"이었을 뿐인데, 그 사이를 대기 선언으로
메웠다. `pick`의 `None`에 *"갈 데가 없다"* 와 *"아직 안 물어봤다"* 가 섞여 있었던 것이다.

고침: `AccountSwitcher::pending()`(기본 `false`)을 더해 둘을 가르고, `pending`이면 대기
문장을 **미룬다**. `check_hold`가 판명 직후 말하고, 훅이 굳어도 5초 유예 뒤에는 반드시
말한다(침묵보다 늦은 말이 낫다 — D7). 재검증한 실물 스레드에는 그 줄이 **없다**.
후보 없음·설정 꺼짐 판에서는 여전히 **정확히 한 번** 나온다.

### 하네스 결함 하나도 같이 잡았다

가짜 CLI가 **핸드셰이크 줄에도** result를 물려 턴 하나에 result가 둘이었다. 한도 판에서
그건 두 번째 `arm_hold`로 나타나 없는 증상을 재생한다. 이제 `type:"user"`에만 답한다.

---

## 3. 구조

```text
설정 Account 탭 스위치            ui-prefs.json{limitSwitch.on}   (기본 false)
        │                                   │  3초 TTL로 읽는다
        ▼                                   ▼
[허브 스레드] rt.tick() → check_hold → switcher.pick(req)   ← **절대 막히면 안 된다**
        │                                   │ 스냅샷만 읽고 즉시 답 / 없으면 워커를 깨우고 None
        ▼                                   ▼
[워커 1개] preflight(로컬) + usage(캐시 → 필요하면 HTTP) → 스냅샷 → ccg-auth::switch::plan
```

| 조각 | 파일 | 무엇 |
|---|---|---|
| 판정식 | `crates/ccg-auth/src/switch.rs` | 순수 함수 `plan()` — 순위 + **탈락 사유**. 단위 테스트 9 |
| 실행기 | `crates/ccg-auth/src/net.rs` | `net` 피처 안에만 있다. `CCG_NO_NET=1` 킬 스위치 |
| 훅 | `crates/ccg-engine/src/limit.rs` | `AccountSwitcher{pick, pending}` — 엔진은 계정을 모른다 |
| 상태기계 | `crates/ccg-engine/src/runtime.rs` | `try_auto_switch` + 리비전 + 배너 + 나팔 |
| 재료 수집 | `src-tauri/src/engine/acct_switch.rs` | 워커 스레드 1개(앱당) · 오염가드 · 예산 문 5개 |
| 배너 | `src-tauri/src/engine/hub.rs` | `notice{switch:{from,to,soonestReset,revertTo}}` |
| 계약면 | `src/shared/protocol.ts` | `notice`의 **선택 필드** — EngineEvent 종류를 안 늘린다 |
| 설정 | `app/src/components/Settings.tsx` | 새 CSS 0줄(`.sc2.tgl`·`.sw2` 재사용) |

### 왜 훅인가 · 왜 워커인가

`pick`은 허브 스레드에서 불린다. 그 스레드는 **모든 채팅의 tick**을 돈다. 거기서 계정
6개의 usage를 동기 조회하면(각 1.2초 간격 직렬화 — usage API의 레이트리밋 규약) 7초 동안
다른 대화의 스트리밍이 통째로 멈춘다. 그래서 `pick`은 I/O를 **하지 않는다**.

### 왜 새 EngineEvent 종류가 아닌가

M9 R1이 밟은 함정이 있다: 종류를 늘리면 렌더러 리듀서의 소진 가드가 타입체크를 멈춘다.
얻는 것도 없다 — 이건 스레드에 줄 하나를 남기는 안내이고 그 문법은 `notice`가 이미 갖고
있으며, 되돌릴 재료는 **선택 필드**로 실으면 그만이다. 안 읽는 화면은 문장만 그린다.

### 거절하는 자리들 (전부 의도된 문)

| 조건 | 왜 |
|---|---|
| 훅 미배선 · 설정 꺼짐 | 기본값. 기능이 없던 판과 같아야 한다(워커도 안 깨운다 = HTTP 0건) |
| `!auto_resume` | 스펙 ⑤ — 화면 밖 채팅이 **조용히 다른 계정을 태우기 시작**하면 안 된다 |
| `auto_paused` | 이미 자동을 멈춘 표다. 자동 전환도 자동이다 |
| 구독이 아님 | API 키 실행에는 갈아탈 "계정"이 없다 |
| 이미 거쳐 온 계정 | A→B→A 핑퐁 금지. 한도 없이 착지한 턴이 이 기억을 비운다 |
| 캐시가 낡음 | `resetsAt`이 지난 퍼센트는 **지난 창의 값**이라 `Rolled`(=모름)로 접는다 — 100%로 굳은 낡은 값 하나가 멀쩡한 계정을 영원히 지우지 않게 |

### 예산 문 5개 (실 HTTP)

① 설정 꺼짐 → 0건 ② 후보만 조회(현재·기시도·오염 제외) ③ 캐시 TTL 2분
④ 워커 쿨다운 20초 ⑤ `CCG_NO_NET=1`.

---

## 4. 게이트

| 게이트 | 결과 |
|---|---|
| `cargo test --workspace` | **462 passed / 0 failed** (22 바이너리) |
| 신설 재생 `m11_account_switch.rs` | **10 passed** |
| 신설 단위 `ccg-auth::switch` | **9 passed** |
| `scripts/poc-account-switch.mjs` | **PASS — 시나리오 6 / 단언 17** |
| `scripts/poc-live-chat.mjs --tag=m11r1` | **PASS · 결함 0건** (R8-1·DIALOG·WINSAVE·EVENTS·ERROR·RELOAD·SLOTS·LIVE 전부) |

`poc-live-chat`의 RELOAD 단계가 특히 의미 있다: 부팅 재장전으로 선 대기표가 **토글이
꺼진 판에서** 옛 경로(자동 발사 / 화면 밖은 눌러서) 그대로 도는지를 재는데, M11이
`check_hold` 맨 앞에 훅 호출을 끼웠으므로 이게 초록이어야 "꺼짐 = 무동작"이 참이다.

---

## 5. 대가 — 정직하게

**바이너리 +1.08MB**(5.63 → 6.73MB). `ureq` + `rustls` + 번들 루트 인증서다.
3.0의 목표가 풋프린트라 이건 공짜가 아니다. 줄일 길은 있다: `ureq`의 `native-tls`로
OS(schannel)를 쓰면 루트 인증서 번들이 통째로 빠진다. 이 라운드에서 안 한 이유는
`AgentBuilder::tls_connector` 배선이 늘고 그 코드를 검증할 시간이 라운드 끝에 없어서다 —
**다음 라운드의 첫 항목**으로 남긴다.

동기 클라이언트(`ureq`)를 고른 것은 이미 선택된 절충이다: 부르는 자리가 전용 워커
스레드 하나이고, 거기에 async 런타임을 하나 더 띄우면 상주 메모리가 그만큼 는다
(`reqwest`는 blocking 피처조차 내부에 tokio 멀티스레드 런타임을 세운다).

---

## 6. 아직 없는 것

1. **되돌리기 알약이 화면에 없다.** 재료는 전부 와이어에 실려 있고
   (`notice.switch.revertTo` + `chat:identity{origin:"auto_account_switch"}`) 되돌리기
   경로도 실증했지만, 그 버튼을 그리는 곳은 `app/src/components/Chat.tsx`의 `FallbackBand` /
   `IdentityBand`이고 **이번 라운드의 경계 밖**이다(동시에 다른 라운드가 편집 중이었다).
   지금 사용자가 보는 것은 문장 한 줄이다. 붙일 자리는 둘 중 하나:
   - `App.tsx:2108`의 `show` 판정에 `origin === 'auto_account_switch'`를 더하고
     `IdentityBand`에 문장 가지를 하나 추가(되돌리기 알약이 그대로 붙는다), 또는
   - `session.ts`에 `notice.switch`를 읽는 스레드 항목을 더해 `FallbackBand`와 같은
     문법으로 그린다.
2. **Codex 계정은 대상이 아니다.** 판정식·훅은 Claude 구독 축(`BillingAxis::Subscription`)만
   본다. Codex는 한도 조회가 `app-server` 스폰이라 워커의 비용 모델이 다르다.
3. **`OnDrift`는 여전히 선언만 있다.** 큐 항목 재조준을 축 비교로 대신했다(§2-③).
   그 열거형을 진짜로 읽게 만드는 것은 큐 라운드의 몫이다.
4. **멀티 패널의 `busy` 정의가 거칠다.** "CLI가 살아 있는 채팅의 계정"으로 잡았다
   (`state != Idle`). 상주 중이지만 다음 턴이 없을 채팅까지 후보에서 빼므로 **보수적**이다 —
   틀린 쪽으로 틀리지는 않지만, 계정이 적은 사용자에게는 후보가 부당하게 줄 수 있다.
5. **`ccg-auth-probe seed`/`seed-dup`/`usage`** 는 `cli` 피처 전용 하네스 도구다.
   앱 번들에 안 들어가고 `CCG_HOME` 없이는 실행을 거부한다.
