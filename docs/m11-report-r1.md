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

> **★R2 정정 — 이 문단의 「리프레시 없음」은 *이 손 주행에만* 참이다.**
> 그 명령(`ccg-auth-probe usage`)에는 문이 달려 있다: 액세스 토큰이 만료됐으면
> `skipped: token_expired`로 끝난다. **제품 경로(자동 전환)에는 그 문이 없고, 있어서도
> 안 된다** — 오래 논 계정은 정의상 액세스 토큰이 만료돼 있어서, 문을 달면 후보의
> 게이지를 영영 못 읽는다. 그래서 제품은 2.6.2와 같이 **만료된 경우에만 교환**한다.
> 아래 §R2-1이 그 교환을 어떻게 안전하게 만들었는지(결과 보존·단일 비행·조회 시점)를
> 적는다. R1 커밋 메시지의 같은 문장도 이 범위로 읽어야 한다.

`ccg-auth/src/net.rs`가 정말 도는지만 실계정 1건으로 쟀다(복사본 홈 · **이 프로브 경로는**
리프레시 없음):

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

> **★R2 정정** — R1에서 ②는 **문서에만** 있었다(`collect()`가 `order` 전체를 돌았다).
> 게다가 `Switcher::start()`가 **부팅 즉시** 워커를 깨웠다. §R2-1을 보라 — 이제 ②는
> 코드이고(물음이 제외 집합을 들고 온다), ②'(부팅 프리웜 없음)가 하나 늘었다.

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

> **★R2 — 했다.** 같은 트리에서 A/B로 다시 쟀다(§R2-6): rustls 6,823,424 B →
> native-tls **5,933,056 B**, **−890,368 B(−13.0%)**. M11 비용은 +1.08MB에서
> **+0.30MB**로 줄었다. 실 핸드셰이크도 확인했다(무인증 GET → 405 · 243ms).

동기 클라이언트(`ureq`)를 고른 것은 이미 선택된 절충이다: 부르는 자리가 전용 워커
스레드 하나이고, 거기에 async 런타임을 하나 더 띄우면 상주 메모리가 그만큼 는다
(`reqwest`는 blocking 피처조차 내부에 tokio 멀티스레드 런타임을 세운다).

---

## 6. 아직 없는 것

1. ~~**되돌리기 알약이 화면에 없다.**~~ → **닫음 (잔여 청소 라운드 · `docs/sweep-r1.md`).**
   여기 적어 둔 **두 자리를 다 붙였다**(폴백 전환이 이미 쓰는 것과 같은 쌍이라, 한쪽만
   붙이면 중복 금지 규약이 성립하지 않는다):
   - **스레드** — `session.ts`의 `case 'notice'`가 `switch.revertTo`를 읽어 그 줄에
     `action:'revert'`를 세운다. 새 `ThreadItem` 종류를 파지 않았다(리듀서 소진 가드·
     4개 표면의 MessageView를 안 흔든다 — protocol.ts §notice가 적은 그대로다).
     `Chat.tsx`의 notice band가 폴백 band와 **같은 알약·같은 정착**을 그린다.
   - **상태줄** — `App.tsx`의 `show` 판정에 `origin === 'auto_account_switch'`를 더하고
     `IdentityBand`에 제목·문장 가지를 하나 추가. 중복은 폴백과 **같은 판정**으로 막는다
     (`identBandNotice`: 스레드에 `revertTo === revision-1`인 band가 있으면 상태줄은 비운다).
   - 되먹임까지 같이 닫았다(M-UI 크리틱 F3): 되돌리면 알약이 `[되돌림 ✓]`로 정착한다.
   - 알약이 그려지는 조건도 코드로 못 박았다 — `MessageView`의 `canRevert`를 **주는
     표면에서만** 그린다. 본채팅만 준다(멀티 패널·추가 채팅 창은 통합 스토어 `chatId`
     배선이 없다). 그전에는 `onNotify`만 있으면 그려서 **패널에 죽은 버튼**이 있었다.
2. **Codex 계정은 대상이 아니다.** 판정식·훅은 Claude 구독 축(`BillingAxis::Subscription`)만
   본다. Codex는 한도 조회가 `app-server` 스폰이라 워커의 비용 모델이 다르다.
3. **`OnDrift`는 여전히 선언만 있다.** 큐 항목 재조준을 축 비교로 대신했다(§2-③).
   그 열거형을 진짜로 읽게 만드는 것은 큐 라운드의 몫이다.
4. **멀티 패널의 `busy` 정의가 거칠다.** "CLI가 살아 있는 채팅의 계정"으로 잡았다
   (`state != Idle`). 상주 중이지만 다음 턴이 없을 채팅까지 후보에서 빼므로 **보수적**이다 —
   틀린 쪽으로 틀리지는 않지만, 계정이 적은 사용자에게는 후보가 부당하게 줄 수 있다.
5. **`ccg-auth-probe seed`/`seed-dup`/`usage`** 는 `cli` 피처 전용 하네스 도구다.
   앱 번들에 안 들어가고 `CCG_HOME` 없이는 실행을 거부한다.

---

# §R2 — 크리틱이 뚫은 다섯을 닫는다 (치명 1 · 중대 2 · 경 2 + native-tls)

크리틱 판정(`docs/critic/m11-r1.md`): 게이트 셋은 **전부 재현**, 기능은 **조건부 통과**,
그리고 **토큰 안전 불합격**. 이 절은 그 다섯 건과, 크리틱이 남긴 회귀 그물의 구멍 하나를
닫은 기록이다. 순서는 크리틱의 권고 순서 그대로다.

| # | 크리틱 | 무엇을 했나 | 잠긴 자리 |
|---|---|---|---|
| **C1** | 치명 — 자동 경로가 refresh 토큰을 회전시키고 **결과를 버린다** | 결과 정착(재시도 3회 → 실패는 `TokenLost`) · 계정별 단일 비행 · **부팅 프리웜 제거** · 후보에게만 조회 | `net.rs` 단위 2 · `acct_switch` 단위 4 · 크리틱 감사 도구 green |
| **C2** | 중대 — 스탬피드(대기하던 채팅 전원이 같은 1등) | 엔진 **예약 장부**(훅이 뭘 하든 마지막 문) + 셸 **예약**(집는 순간 busy) + 허브 **슬롯 단위 busy 갱신** | 재생 ⑪ · 크리틱 A3 green |
| **C3** | 중대 — 유령 대기 문장(표가 죽어도 살아남는 플래그) | 플래그를 **표 안으로** 옮겼다(구조적으로 불가능) | 재생 ⑫(3경로) · 크리틱 A1·A2 green |
| **C4** | 경 — 예산 문 ②가 문서에만 있다 | ②를 코드로(물음이 제외 집합을 들고 온다) + ②'(프리웜 없음) 신설 + `engine:debug`에 **숫자** | `acct_switch` 단위 3 · PoC 산출물의 `worker` |
| **C5** | 경 — Settings가 Codex 계정을 센다 | `count={accounts?.length ?? 0}` | — |
| **C6** | 정보 — 단언 수 표기 | 내 주행 실측 **18건**(잔여 청소 라운드가 알약 3건을 더했다) | — |
| **§6** | native-tls 제안 diff | 적용 + 같은 트리 A/B 재측정 | 실 핸드셰이크 1건 |
| **뮤테이션 ①a** | "함수 끝 드레인"이 재생 10판에 안 걸린다 | 왜 무해한지 **기계적 이유**를 찾아 그 전제를 테스트로 박았다 | 재생 ⑩ |

---

## R2-1. C1 — 토큰 안전 (치명)

크리틱의 판정식은 정확했다: **후보는 "노는 계정"이고, 노는 계정은 정의상 액세스 토큰이
만료돼 있다.** 그래서 자동 경로의 리프레시 교환은 예외가 아니라 정상 경로다.

### 무엇을 고쳤나 — 그리고 무엇을 **안** 고쳤나

크리틱의 최소 수선안 첫 줄(`fetch_account_usage`에 프로브와 같은 문을 달아 만료면
`NoToken`)은 **채택하지 않았다.** 그 문을 달면 잃는 것이 기능 자체다: 후보의 게이지를
영영 못 읽으니 모든 후보가 `usage_unknown`이고, 자동 전환은 캐시가 따뜻한 계정에만
동작한다. 2.6.2도 같은 자리에서 같은 교환을 한다(`auth.ts:412 freshAccountToken`).
**회전 자체는 정상 경로다 — 조건은 셋이다.**

**(a) 결과를 반드시 반영한다.** R1:

```rust
if let Some(next) = next { let _ = claude::persist_refreshed(email, &next); }   // 삼킴
```

교환이 200을 받은 순간 **옛 refresh 토큰은 서버에서 죽는다.** 새 토큰을 폴더·백업에
못 쓰면 남는 것은 죽은 토큰뿐이고, 그 계정의 출구는 재로그인이다. 지금:

- `apply_refresh`가 `None`(base가 JSON 객체가 아님)인 가지도 **실패로 센다**(R1은 조용히 지나갔다).
- `persist_refreshed`는 **3회까지 재시도**한다(40ms 간격). 파일 잠금·검사기 같은 일시 실패에 계정 하나를 잃을 수는 없다.
- 그래도 실패하고 **서버가 회전시켰으면**(= 우리가 보낸 것과 다른 refresh 토큰을 돌려줬으면) `Err(NetError::TokenLost)`로 착지한다 + `eprintln!` 한 줄.
- 회전이 **없었으면**(같은 refresh를 돌려줬거나 아예 안 줬으면) 잃은 것은 이번 액세스 토큰뿐이라 `Ok`로 진행하되 경고는 남긴다.

셸은 그 에러를 다른 실패와 **다른 줄**로 적는다(`acct_switch::fetch`):
`[acct-switch] ★★ <email>: rotated refresh token could not be saved: … — 이 계정은 재로그인이 필요할 수 있습니다`.

교환 응답을 디스크에 정착시키는 조각은 `net::store_rotation`으로 떼어 냈다. **실 HTTP
없이 "회전은 났는데 저장이 실패했다"를 재생할 수 있어야** 하기 때문이다:

```text
[C1] 회전→저장실패 = Err(TokenLost("idle@x: account not registered: idle@x"))
[auth] ★ 리프레시 결과 저장 실패 idle@x: account not registered: idle@x (서버 회전=true)
```

`crates/ccg-auth/src/net.rs::tests::a_rotation_that_cannot_be_saved_is_a_fatal_error` —
네 가지를 한 판에서 잡는다: ① 정상 회전은 폴더·백업에 정착하고 만료가 밀린다
② 회전 + 저장 불가 = `TokenLost` ③ 회전 없음 + 저장 불가 = `Ok`(옛 토큰이 살아 있다)
④ `access_token` 없는 응답 = `BadBody`.

**(b) 단일 비행**(2.6.2 `auth.ts:411 refreshInflight`의 이식). R1에서는 호출자가 워커
스레드 하나라 *우연히* 안전했고 그 성질은 코드 어디에도 없었다. 이제 계정별 레인이
있고, 뒤따라온 호출은 앞 주자가 **저장까지 끝낸 뒤** 깨어나 그 결과를 재확인하고 쓴다.
판별식은 킬 스위치다 — 두 번째 교환이 나갔다면 `CCG_NO_NET=1`에서 `Err(Disabled)`다:

```text
[C1] 뒤따라온 호출 = Ok("A-rotated")
```

**(c) 조회는 한도 장전 순간, 후보에게만.** 크리틱 C1의 폭발 반경 ①·②를 닫는다.

- `Switcher::start()`의 부팅 프리웜(`if me.enabled() { me.kick() }`)을 **걷어냈다.**
  아끼려던 것은 첫 한도에서의 한 tick이고(그 자리는 `pending`이 이미 막는다), 대가는
  *앱을 켜는 것만으로 등록 계정 전부의 그랜트가 돌아가는 것*이었다.
- 조회의 계기는 이제 하나다: **한도에 걸린 채팅이 후보를 묻는 순간**(`Switcher::ask`).
  그 물음은 자기가 **제외할 계정**(지금 쓰는 계정 + 이 에피소드에서 거쳐 온 계정)을
  같이 들고 오고, 워커는 물어 온 채팅들이 **아무도 제외하지 않은 계정에만** HTTP를 쓴다.
  (`Switcher`에 그 둘을 담을 필드가 없다던 크리틱 C4의 지적이 이 설계의 출발점이다 —
  필드를 만드는 대신 **물음에 실어 보낸다**. 채팅마다 현재 계정이 다르기 때문이다.)

**(d) 신선하면 회전 없이 쓴다.** R1부터 그랬고(`account_access_token`이 먼저), 이제
그 위에 단일 비행의 **이중 검사**가 하나 더 있다.

### 크리틱 감사 도구 — 여전히 green

```text
[T] CCG_HOME=…\ccg-m11c-auth-12692  CCG_NO_NET=true
[T] access_token(idle)=Some(Disabled)  access_token(dead)=Some(NoToken)  fresh_ok=true
[T] fetch_account_usage(idle)=Some(Disabled)
[T] refresh req: POST https://console.anthropic.com/v1/oauth/token grant_type="refresh_token"
test the_product_path_does_attempt_a_refresh_exchange_on_an_idle_account ... ok
```

이 도구가 초록인 것이 **의도한 결과**다. 그 이름이 묻는 것("제품 경로가 교환을
시도하는가")의 답은 여전히 **예**이고, 바뀐 것은 *그 교환이 안전한가*다. 감사가 빨개지길
원했다면 후보의 게이지를 포기해야 했다.

### 부팅에 아무것도 안 묻는다 — 숫자로

`engine:debug`의 `accountSwitch.worker`에 `{runs, fetches}`를 실었다(워커가 돈 횟수 ·
조회를 **시도한** 계정 수). 문서가 "안 묻는다"고 적어 놓고 코드가 묻고 있던 것이 R1의
C1·C4라, 이제 하네스가 0인지 볼 수 있다. 실 창 6판(`--out=-r2`)에서 읽은 값:

| 시나리오 | 토글 | `worker` |
|---|---|---|
| off | 꺼짐 | **`{runs:0, fetches:0}`** — 꺼진 기능은 워커를 깨우지도 않는다 |
| pick · none · dirty · chain | 켜짐 | **`{runs:1, fetches:0}`** — 한도에 걸려서야 한 바퀴, 캐시가 신선해 HTTP 0건 |

단위(`src-tauri/src/engine/acct_switch.rs::tests`, 격리 홈 · `CCG_NO_NET=1`):

```text
[acct-switch] 부팅 직후 runs=0 fetches=0                     ← 토글을 켠 채로 start()
[acct-switch] 첫 물음 뒤 runs=1 fetches=1 accounts=["a@x","b@x","c@x"]  ← 현재 a·기시도 b 제외
```

**뮤테이션으로 확인**(둘 다 red = 잠겼다):

| 되돌린 것 | 결과 |
|---|---|
| `start()`에 `if me.enabled() { me.kick() }` 복원 | `booting_with_the_toggle_on_queries_nothing` **FAILED** (`runs 1 ≠ 0`) |
| `collect()`의 `!want.contains(email)` 제거 | `the_first_question_is_what_wakes_the_worker` **FAILED** (`fetches 3 ≠ 1`) |

---

## R2-2. C2 — 스탬피드 (중대)

크리틱 A3: *"워커 스냅샷이 도착하는 순간, 같은 소진 계정에 묶여 대기 중이던 N개 채팅이
동시에 열린다 — 그 펌프에서 전원이 같은 1등을 고른다."* 실측이 정확했다.

**왜 셸의 예약만으로는 안 되는가.** 허브의 `busy`는 *"CLI가 살아 있는 채팅의 계정"*이라
**스폰이 끝나야** 참이 된다. 그런데 전환은 정체성만 바꾸고 스폰은 그다음이다. 즉 훅이
뭘 하든, *"방금 누가 무엇을 집었다"* 를 아는 자리는 **전환을 실행하는 코드**뿐이다.
그래서 방어를 셋으로 나눴다:

1. **엔진 — `limit::SwitchLedger`(마지막 문).** `AccountSwitcher` 훅 하나를 나눠 쓰는
   채팅들이 같은 장부를 본다(`ledger_for(&hook)`; 훅 `Arc`가 키이고 죽은 훅은 매번
   걷는다 — 재생마다 훅이 달라 장부가 섞이지 않는다). 훅이 이미 남이 집은 계정을
   내주면 **그 답을 거절하고 그 계정을 뺀 채 다시 묻는다**(최대 8회). 훅이 예약을
   아는 경우에는 첫 답이 이미 옳아서 이 루프가 한 바퀴로 끝난다.
2. **셸 — `Switcher`의 예약.** `pick`이 계정을 집는 **그 순간** `reserved`에 적고, 같은
   펌프의 다음 채팅에게 그 계정은 `busy`로 보인다(`switch::plan`의 탈락 사유도
   `busy`라 진단이 정직하다). 수명 30초 — 스폰이 끝나면 허브의 `busy`가 이어받는다.
3. **허브 — 슬롯 단위 busy 갱신.** `pump`가 `set_busy`를 한 바퀴에 한 번 돌리던 것을,
   슬롯 tick 전후로 (상태·계정)이 **바뀐 슬롯이 있을 때만** 다시 돌리게 했다. 안 바뀌면
   비용은 튜플 비교 하나다.

크리틱 A3(예약을 **모르는** 스텁 훅)에서:

```text
[A3] chat-1=b@x chat-2=c@x picks=[("chat-1","b@x"), ("chat-2","b@x"), ("chat-2","c@x")]
```

세 번째 물음이 곧 재질문이다 — chat-2는 b@x를 받았고, 장부가 "그건 chat-1의 것"이라고
말해서 다시 물어 c@x를 받았다. 같은 판을 제품 재생으로도 들여왔다(재생 ⑪).
**뮤테이션**: `SwitchLedger::taken_by_other`를 항상 `false`로 → A3·재생 ⑪ 둘 다 **red**.

---

## R2-3. C3 — 유령 대기 문장 (중대)

크리틱의 처방은 한 줄(`&& self.hold.is_some()`)이었지만, 같은 크리틱이 *"표를 죽이는
자리는 다른 세 경로가 더 있다"*고 적었다. 가드를 하나 더 다는 대신 **플래그를 표 안으로
옮겼다**(`LimitHold::notice_due`). 표가 죽으면 미뤄 둔 문장도 같이 죽는다 — 앞으로
표를 `None`으로 만드는 자리가 늘어도 이 결함은 다시 안 생긴다.

세 경로 전부 재생한다(재생 ⑫):

```text
[m11-⑫ §7.3 계정 변경] 표죽음=true 대기문장=0
[m11-⑫ 자동 이어서 끄기] 표죽음=true 대기문장=0
[m11-⑫ 중단(Esc) — 큐와 표를 함께 걷는다] 표죽음=true 대기문장=0
```

크리틱 A1·A2도 green:

```text
[A1] 대기문장=0 hold=false notices=["계정을 바꿔서 대기표를 취소했어요"]
[A2] 대기문장=0 notices=[]
```

(A1의 남은 한 줄이 정확히 사용자가 읽어야 할 전부다.)

---

## R2-4. 뮤테이션 ①a — "함수 끝 드레인"은 왜 안 걸렸나

크리틱이 심은 뮤테이션(전환 함수 **끝**에서 `drain_if_possible()`)에 재생 10판이 전부
초록이었다. 다시 심어 보고 **왜 그런지**를 찾았다: `drain_if_possible`은 첫 줄에서
`state`가 `Idle|Resident`가 아니면 즉시 돌아간다. `try_auto_switch`가 `arm_hold` →
`on_result` 한복판에서 불릴 때 그 채팅은 아직 턴 중이라 **그 문이 닫혀 있다.** 즉 이
뮤테이션은 지금 코드에서 *증명 가능하게 무해*하다(계정별 발화·스폰 목록·이벤트 순서가
바이트 단위로 같다).

무해한 것을 억지로 red로 만드는 대신, **그 무해함의 전제**를 박았다(재생 ⑩):

- 계정별로 나간 프롬프트를 센다 — 한도로 죽은 `a_x`가 받은 것은 첫 질문 하나뿐,
  나팔은 `b_x`에서 정확히 한 번.
- 그리고 **순서**: `AccountSwitched`(8) → 옛 스트림 `Exit`(18) → 새 `Spawn`(21).
  드레인 문이 언젠가 느슨해져 전환이 그 자리에서 발사하면 제일 먼저 이 순서가 깨진다.

```text
[m11-⑩] 계정별 발화=[("a_x","첫 턴"), ("b_x","이어서 진행해 주세요")]
[m11-⑩] 순서 switched=8 exit=18 spawn2=21
```

---

## R2-5. C5 · C6 — 경

- **C5**: `AutoAccountSwitchRow`의 `count`가 `accounts + cxAccounts`였다. 판정식은
  Claude 구독 축만 보므로 **클로드 1 + Codex 1이면 켤 수 있고 영원히 안 되는 스위치**가
  그려졌다. `count={accounts?.length ?? 0}`.
- **C6**: 크리틱 주행에서 16, R1 리포트 표기 17. 지금 내 주행은 **18**이다 —
  잔여 청소 라운드가 되돌리기 알약 3건(`PICK-알약`·`PICK-되돌리기(알약)`·`PICK-정착`)을
  더했기 때문이다. 시나리오는 그대로 6.

---

## R2-6. native-tls — 적용

크리틱 §6의 diff 그대로(+ `OnceLock` 형태). 같은 트리에서 **A/B로 다시 쟀다**
(둘 다 `npm run tauri:build` = `--features custom-protocol`):

| 빌드 | 크기 |
|---|---|
| rustls + 번들 루트(되돌려 심고 측정) | **6,823,424 B** |
| native-tls(schannel) | **5,933,056 B** |
| **차이** | **−890,368 B (−13.0%)** — 크리틱 실측 −890,880 B와 512바이트 차 |

실 핸드셰이크 1건(무인증 GET · Authorization 헤더 없음 · 토큰 없음):

```text
[TLS] status=405 elapsed=243ms bodyLen=132
```

대가는 크리틱이 적은 그대로다: schannel은 Windows 루트 저장소를 믿으므로 사내 MITM
프록시의 루트도 신뢰한다. Windows 전용 앱이고 그 환경에서는 대개 기능이지만, 선택이라
`Cargo.toml`에 적어 뒀다.

---

## R2-7. 게이트

| 게이트 | 결과 |
|---|---|
| `cargo test --workspace` | **485 passed / 0 failed / 4 ignored** (22 바이너리 · 크리틱 도구 사본을 걷어낸 상태) |
| 재생 `m11_account_switch.rs` | **13 passed** (10 → +⑩⑪⑫) |
| 단위 `ccg-auth::switch` | **9 passed** |
| 신설 `ccg-auth::net`(토큰) | **4 passed** |
| 신설 `engine::acct_switch`(예산 문·예약) | **4 passed** |
| 크리틱 `critic-m11-token.rs` | **1 passed** (네트워크 0건) |
| 크리틱 `critic-m11-attack.rs` | **3 passed** — R1에서 3판 전부 red였다 |
| 크리틱 `critic-m11-tls.rs` | **1 passed** (실 HTTP 1건, 무인증) |
| `poc-account-switch.mjs --out=-r2` | **PASS — 시나리오 6 / 단언 18 / 결함 0** |
| `poc-live-chat.mjs --tag=m11r2` | **PASS · 결함 0건** (R8-1·DIALOG·WINSAVE·EVENTS·ERROR·RELOAD·SLOTS·LIVE) |
| 앱 바이너리 | **5,933,056 B** (R1 대비 −890,368 B) |

크리틱 도구는 레포에 안 남긴다(그쪽 소유다). 재현:

```bash
cp docs/critic/tools/critic-m11-token.rs  crates/ccg-auth/tests/critic_m11_token.rs
cp docs/critic/tools/critic-m11-attack.rs crates/ccg-engine/tests/critic_m11_attack.rs
cargo test -p ccg-auth --features cli --test critic_m11_token -- --nocapture --test-threads=1
cargo test -p ccg-engine --test critic_m11_attack -- --nocapture
# TLS(실 네트워크 1건)
cp docs/critic/tools/critic-m11-tls.rs crates/ccg-auth/tests/critic_m11_tls.rs
CCG_CRITIC_LIVE_TLS=1 cargo test -p ccg-auth --features cli --test critic_m11_tls -- --nocapture
```

### 이 라운드에서 **실물이 먼저 잡은** 것 하나

R2 작업 중간본은 `arm_hold`/`check_hold`에서 훅이 `pending`이면 `pick`을 아예 안 부르게
바꿨다. 단위·재생 16판이 전부 초록이었다 — 그런데 `poc-account-switch`가 **4건 red**를
냈다(전환이 한 번도 안 일어났다). 이유: 부팅 프리웜을 걷어낸 뒤로 워커를 깨우는 유일한
계기가 `pick`이라, `pending`일 때 안 물으면 스냅샷이 영원히 차갑다. 대본 훅은 `pending`을
스스로 풀어 주기 때문에 이 순환을 재현하지 못한다. **실 창 게이트가 아니었으면 이
라운드는 기능이 죽은 채로 초록이었다.**

---

## R2-8. 남은 것 (크리틱 §7 + 이 라운드가 새로 아는 것)

1. **R-1 전환 직후 재검증은 여전히 없다.** `LimitProbe`가 셸에 미배선이라 캐시가 2분
   낡아 소진된 계정을 골라도 스폰 한 번을 태우고서야 안다. 상한은 `switch_tried`가
   잡아 최악 N스폰(계정 수)이다.
2. **R-2 창이 전부 `Rolled`면 여유 100%**(관대함의 대가는 조용하다) — 그대로다.
3. **R-3 되돌린 뒤의 침묵**(`switch_tried`가 남아 그 에피소드에서는 전환이 다시 안
   열린다) — 그대로다. D7 경계.
4. **R-4 `last_plan`이 전역**이라 채팅이 여럿이면 마지막에 물은 채팅의 답만 보인다.
   이번에 더한 `worker.{runs,fetches}`는 전역이 맞는 값이지만 `picked/skipped`는 아니다.
5. **`TokenLost`가 화면에 없다.** 지금은 stderr 한 줄 + 그 계정이 후보에서 빠지는 것이
   전부다. 사용자가 보는 자리(설정 Account 탭의 그 계정 카드)에 "재로그인이 필요할 수
   있어요"를 띄우는 것이 옳지만, 그 배선은 이 라운드 경계 밖(`Settings` 상태·IPC)이다.
6. **예약 TTL 30초는 감이다.** 스폰이 그보다 오래 걸리는 환경(느린 디스크·검사기)에서는
   예약이 먼저 풀리고 허브의 `busy`가 아직 안 켜진 창이 생긴다. 그 창에서 두 채팅이
   같은 계정을 집으면 엔진 장부(60초)가 잡는다 — 두 값이 다른 이유가 그것이다.
