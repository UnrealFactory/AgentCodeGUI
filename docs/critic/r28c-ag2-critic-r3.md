# R28c 「AG2」 확인 크리틱 R3 — 자물쇠는 진짜로 하나가 됐다. 그 창이 실홈으로 열려 있었다는 것도 내 손으로 봤다

**판정: PASS(pass=true)** — R2가 FAIL을 낸 단 하나의 이유(`cargo test -p ccg-store`가
네 번에 한 번 붉다)는 닫혔다. 체크리스트 네 축(조회·재시작/삭제·ask·게이트)도 전부
**내가 지은 바이너리와 원본 그대로의 하네스로** 다시 재서 초록이다.

빌더 보고서·커밋 메시지는 근거로 쓰지 않았다. 아래 수치는 전부 이 라운드에서 직접
빌드·실행·실측한 것이다. 그리고 빌더가 **재지 않은** 축을 하나 더 쟀다 — 「그 창이
정말로 *사용자 실홈*으로 열려 있었나」. 열려 있었다. 지금은 닫혔다.

---

## 0. 격리 (사고 이력 대응)

| 항목 | 값 |
|---|---|
| 빌드 | `CARGO_TARGET_DIR=target-critag2r3` · `cargo build -p agentcodegui --release --features custom-protocol` + `ccg-fakecli`(`--features fakecli`) + `ccg-auth-probe`(`--features cli`) + `ccg-migrate`(`--features cli`, debug/release 둘 다) |
| 대조군 | `git worktree add --detach %TEMP%\wt-critag2r3ctl 25ab2f7` + `CARGO_TARGET_DIR=%TEMP%\tgt-critag2r3ctl` — **브랜치 이동 0회**, 옆 갈래 미커밋 무접촉, 주행 뒤 워크트리 제거 완료 |
| G2 이빨용 수정 전 exe | `target-critacct3/release/agentcodegui.exe`(= G2 수정 전 판) **읽기만** — 그 target에는 아무것도 안 지었다 |
| CDP 포트 | **9861~9868**(acct-live 1차) · **9881**(ask) · **9891~9898**(하네스 이빨) · **9901~9908**(acct-live 2차) — 빌더(9781~)·R1(9741~)·R2(9821~9845)·남의 갈래(9486·9661~) 미충돌 |
| `CCG_HOME` | `%TEMP%\ccg-acct-live-critag2r3{,b,ctl}` · `%TEMP%\ccg-critag2r2-ask-critr3head` |
| 실 HTTP | **0건** — 전 주행 `CCG_NO_NET=1` + `ccg-auth-probe seed` 합성 계정. **실계정 토큰 회전 0회** |
| kill | 이름 기반 kill **0회**(`killTree`로 내가 spawn한 PID 트리만). 사용자 실앱 6개(`6644`·`12924`·`23792`·`24836`·`26924`·`31284`)는 주행 **전후 같은 PID**, 고아 프로세스 0건 |
| 공용 산출물 | 공용 `target/`(`agentcodegui.exe` 08-24 18:09 · `ccg-migrate.exe` 08-23 06:55) **무변경** · 레포 `docs/poc-out/` 무변경(최신 08-23) · 기준 리포트는 `--out=-critag2r3*`로 갈랐다 |
| 하네스 수정 | **0줄.** `poc-chat-unify-migrate.mjs`는 `%TEMP%\fr-critag2r3` 가짜 ROOT로 복사해 돌렸다(`cmp` 바이트 동일 확인) |

**★ 자진 신고 — 내 대조군 주행이 사용자 실홈에 파일 하나를 썼다.** §7에 전말과 그 파일의
정확한 정체를 적었다. 원인은 이 라운드가 고친 바로 그 결함이고, **고친 판에서는 540주행
0건**이다.

---

## 1. R2가 FAIL을 낸 그 축 — `ccg-store` 게이트, 닫혔다

`cargo test -p ccg-store --lib --no-run`으로 지은 **같은 테스트 바이너리**를 `%TEMP%`에
복사해 반복 실행했다(빌드 노이즈 없이 경합만 센다).

| 판 | 붉은 주행 |
|---|---|
| 대조군 `25ab2f7`(자물쇠 둘) | **4 / 100** (30·33·80·95번째) |
| **HEAD `8bdd375`(자물쇠 하나)** | **0 / 100** |
| HEAD, 부하 걸린 채 다시(옆에서 `--synthetic` 마이그레이션 하네스) | **0 / 60** |
| 합계 | HEAD **0 / 160** |

빌더가 적은 8/100(대조군)·0/160(HEAD)과 같은 방향·같은 크기다. R2가 잰 24%와의 차이는
기계 부하 차이고, **결함의 존재와 소멸**은 세 판정자에게서 모두 같다.

### 1-1. 새 못은 이빨이 있다 (A/B)

`the_lock_is_one_lock_so_a_neighbour_cannot_swap_my_home`을 **대조군 워크트리**(25ab2f7,
자물쇠 둘)에 그 못만 얹어 지어 돌렸다:

```
thread 'testhome::tests::crit_r3_the_lock_is_one_lock' panicked at testhome.rs:125:
  LOCK IS TWO
→ 자물쇠 둘 판에서 붉음 5 / 5 · 고친 판 0 / 160
```

「옆 스레드가 안 깨어나면 초록 쪽으로만 틀린다」는 빌더의 자기 진단대로 한쪽으로만
틀리는 못이지만, **틀리는 쪽이 안전한 쪽**이고 실제로 두 자물쇠 판을 100% 잡는다.

---

## 2. 체크리스트 ① 조회 축(G2) — 초록, 그리고 **하네스가 아직 문다**

내가 지은 exe로 `poc-acct-live` 전 시나리오. **30항목 통과 · findings 0**, **2회 연속**
(`docs/critic/acct-live-critag2r3.json` · `-critag2r3b.json`).

```
[F] o F-두 자리          [{c-a,one@ccg.test},{c-b,one@ccg.test}]
    o F-칩(조회 전)      ["사용 중 · 첫 채팅"]
    o F-조회 응답        {"chatId":"c-a","status":"done","account":"one@ccg.test","ask":"none"}
    o F-런타임 생존(전제) [{"c-b",pid:16160,"Idle"},{"c-a",pid:15932,"Idle"}]   ← 2차: 23336/35272
    o F-다음 REPLACE     {"chatId":"c-a","status":"done","account":"one@ccg.test"}
    o F-칩(조회 후)      ["사용 중 · 첫 채팅"]
```

`c-a`의 CLI가 **pid를 달고 살아 있는 채로** 조회를 통과했다 — 축이 성립한다는 물증.

### 2-1. 빌더가 하네스를 고쳤으니 **이빨부터 다시 쟀다**

이 라운드는 `poc-acct-live`의 `sendTurn` 뒤 고정 `sleep(3500)` 여섯 자리를 `waitTurn`
(조건 대기, 상한 25s)으로 바꿨다. 게이트를 만진 라운드는 **게이트가 아직 무는지**부터
증명해야 한다. 고친 하네스를 **G2 수정 전 exe**에 물렸다:

```
X F-조회 응답     c-a = {"status":"done","account":null}     ← 조회 한 번이 계정을 지웠다
X F-다음 REPLACE  c-a = {"account":null}   (c-b는 "one@ccg.test"로 살아 있다)
X F-칩(조회 후)   ["사용 중 · 첫 채팅"] → []
o F-런타임 생존   [{"c-b",pid:6652,"Idle"},{"c-a",pid:32524,"Idle"}]  ← 살아 있는데 지웠다
→ 3 FAIL (docs/critic/acct-live-critag2r3ctl.json)
```

`waitTurn`은 단정을 무르게 하지 않는다. 코드로도 그렇다 — 대기 조건이 「턴이 끝났다」일
뿐 단정문은 한 줄도 안 바뀌었고, 조건이 영영 안 오면 상한 뒤 **옛 판과 같은 값으로**
단정한다. 즉 느려질 수는 있어도 **초록으로 틀릴 수는 없다.**

---

## 3. 체크리스트 ② F1 재시작 축 · G1 삭제 축 — 무회귀

```
[A] o A-디스크        status.json len=209 · "account" 키 0건
      실측 원문: {"version":1,"statuses":{"c-a":{...,"ask":"none","hold":null,
                  "queued":0,"unread":0,"autoResume":true}}}      ← account/panelId 없음
    o A-재기동 status [{"chatId":"c-a","status":"done","account":null,"panelId":null}]
    o A-재기동 유령칩 badges=["기본 · 맨 위"]   (오염된 입력=true — 두 키를 도로 끼워 넣은 홈)
[E] o E-유령 행 / o E-유령 칩(=[]) / o E-런타임 회수(["c-b"]) / o E-브로드캐스트(7→8)
```

**쓰기만 막은 게 아니라 읽는 쪽도 청소한다**는 F1의 두 팔이 오염 홈에서 그대로 확인된다.

---

## 4. 체크리스트 ③ ask 축 — AwaitingUser는 조회 뒤에도 안 흔들린다

R2 크리틱이 `%TEMP%`에 지어 둔 ask 하네스를 **내 exe로** 다시 돌렸다(레포 무접촉).
`ccg_fakecli`의 `awaitResponse`로 승인 대기를 세우고 그 상태에서 `chats:get` 1회.

```
o 전제-승인 카드  "Claude의 승인 요청 | Write | 이 작업을 실행할까요? …"
o 전제-ask        {"chatId":"c-a","status":"working","busy":true,"ask":"permission","account":"one@ccg.test"}
o ①조회 응답 ask/busy/status/account   전부 위와 동일
o ②카드 생존     o ③다음 REPLACE ask/busy/account   전부 동일     o ④되돌아온 카드
o 전제-런타임 생존 [{"c-b",pid:22164,"AwaitingUser"},{"c-a",pid:14072,"AwaitingUser"}]
→ 12 / 12 초록
```

승인 무응답이 **타임아웃 없이 영구 정지**라는 계약도 그대로다(`AwaitingUser`로 멈춘 채
조회·전환·복귀를 다 통과했다).

---

## 5. 체크리스트 ④ 게이트 — 크레이트별로 따로 셌다

| 항목 | 실측 |
|---|---|
| `cargo test -p agentcodegui` | **145 / 0** |
| `cargo test -p ccg-auth` | **102 / 0**(84+14+2+1+1) |
| `cargo test -p ccg-engine` | **207 / 0** |
| `cargo test -p ccg-fs` | **100 / 0**(ignored 2) |
| `cargo test -p ccg-lsp` | **59 / 0** |
| `cargo test -p ccg-store` | **89 / 0** · 반복 **0 / 160** |
| `cargo test --workspace --no-fail-fast` | **719 / 0**(바이너리별 합산 검산) |
| `npm run typecheck` · `typecheck:app` | **3종 초록**(exit 0) |
| `poc-store-fanout` | **전부 통과**(23항목) |
| `poc-acct-store` | **전부 통과** |
| `poc-chat-unify-migrate`(가짜 ROOT, 수정 0줄) | 픽스처 **실패 1** · 부하 픽스처(311채팅/15810메시지) **실패 1** — 둘 다 선존 `§5.3-6 스테이징 잔여물` · **정체성 불일치 0** |
| `ccg-migrate` 빌드 경고 | **0** |
| 워크스페이스 경고 | `unused Result` 4건 — 전부 `crates/ccg-auth/tests/critic_m11r2_token.rs`(44·96·223·250), **AG2 밖** |

빌더가 적은 숫자와 한 자리도 안 어긋난다.

---

## 6. 곁다리 검증 — 「파일의 마지막 사실」 수명

빌더는 R2 크리틱이 실 exe로 잰 사실(「앱의 첫 턴에 덮인다」)을 **고치지 않고 못으로
고정**했다. 그 못(`the_frozen_fact_outlives_the_migration_but_not_the_first_turn`)이
초록이고, 못의 단정문이 실제로 `after["c-run"]["status"] == "idle"`을 요구한다 —
즉 수명이 늘어나면 **이 못이 붉어져** 헤더를 같이 고치라고 말한다. 문서(규약 4)에도
「마이그레이션 프로세스 한정」이 박혔다. 문서와 못과 실측이 같은 말을 한다.

---

## 7. ★내가 쟀고, 빌더는 안 잰 축 — 「그 창은 정말 실홈으로 열려 있었나」

빌더는 §12-2에 이렇게 적었다: *"실측: 사용자 실홈 `~/.agentcodegui/chats-v3/`에는 지금도
`status.json`이 **없다** — 이 사고는 아직 안 났다. 창만 닫았다."* 그 문장은 「없다」를
근거로 「안 났다」를 말한다. **없는 것은 증거가 아니다.** 그래서 창을 직접 열어 봤다.

### 7-1. 사고는 실제로 난다 (대조군)

`home_dir()`은 `USERPROFILE`을 먼저 본다. 그래서 `USERPROFILE`을 가짜로 돌려 두면
「실홈으로 떨어지는 쓰기」가 **그 가짜 폴더**에 잡힌다 — 사용자 데이터를 안 건드리고
같은 사고를 관측하는 방법이다. 세 개의 병렬 루프 × 60주행 = 180주행을 한 판으로 세 판:

| 판 | 폴백 홈에 떨어진 파일 |
|---|---|
| 대조군 `25ab2f7`(자물쇠 둘) | **5 · 8 · 4** (세 판 모두 사고) |
| **HEAD `8bdd375`(자물쇠 하나)** | **0 · 0 · 0** (540주행 무사고) |

대조군이 떨군 것들:
```
<fallback>/.agentcodegui/chats-v3/status.json
<fallback>/.agentcodegui/chats-v3/index.json
<fallback>/.agentcodegui/boards/{default,index}.json
<fallback>/.agentcodegui/chats-v3.old-1787603876217/status.json   ← 스테이징 폴더까지
```

**이것이 이 라운드의 값이다.** 「게이트가 24% 붉다」는 증상이었고, 병은 *테스트가 사용자
홈에 쓴다*였다. 자물쇠를 하나로 합친 판에서 540주행 0건 — 병이 나았다.

### 7-2. 자진 신고 — 그 사고를 내가 한 번 냈다

내 대조군 100주행 루프(05:01:58~05:04:02, 옆에서 워크스페이스 컴파일이 돌던 부하 창)
안에서, **사용자 실홈에 파일 하나가 생겼다**:

```
C:\Users\User\.agentcodegui\chats-v3\status.json   919 bytes   생성/수정 2026-08-25 05:02:23
{"version":1,"statuses":{"c-1":…,"c-2":…,"ma-sess-A-0":…,"ma-sess-A-1":…,"w-1":{…,"updatedAt":5}}}
```

`c-1`·`c-2`·`w-1`·`ma-sess-A-*`는 `ccg-store`의 `testkit::seed_262` 픽스처 아이디다
(`crates/ccg-store/src/lib.rs:322~359`) — 사람이 만든 대화가 아니라 **테스트가 쓴 줄**이다.
근거 셋: ① 그 시각은 내 대조군 루프 안이다 ② 고친 판은 220주행 + 이후 540주행 동안
한 번도 안 썼다 ③ 아무 것도 안 돌린 90초 관찰 창에서 mtime이 안 움직였다.

**나는 지우지 않았다.** 판정만 하기로 한 갈래이고, 남의 데이터가 사는 폴더에서 지우는
쪽이 남기는 쪽보다 위험하다. 피해 범위는 **정확히 이 파일 하나**다(같은 폴더의
`sc-btwtest-1.json`은 08-24 17:16로 내 창 밖 · `boards/`·`*.old-*`·`chats-v3/index.json`
**없음** · `chats/`·`multi-agent/`·`session-chats/`·`accounts.json` 전부 무변경).
`status.json`은 규약 5가 「유일 진실이 아니다」라고 못 박은 사이드카라 다음 장전이
얕은 스캔으로 재구성하며 없는 채팅 줄을 걷어낸다 — 그래도 **사용자가 지울지 말지
정하도록** 여기 적어 둔다.

같은 이유로 빌더의 안전 회계 한 줄(「실홈 `~/.agentcodegui/chats-v3/`에 기록 0」)은
**지금 이 트리에서는 더 이상 참이 아니다**. 빌더 자신의 주행에 대해서는 참이었을 수 있다.

---

## 8. 남은 격차 (PASS를 막지는 않는다)

### 8-1. ★최대 — `ccg-auth`의 CAS 못은 다섯에 한 번 붉다. 빌더의 「0/10」은 재현 안 됐다

빌더는 리스크 1번에 *"내 판에서 단독 10주행 0붉음"*이라 적고 넘겼다. 내 판:

| 판 | 붉은 주행 |
|---|---|
| HEAD 단독 20주행 | **4 / 20** (2·6·9·15번째) |
| 같은 부하에서 번갈아 14주행씩 | HEAD **3 / 14** · 대조군 **3 / 14** |
| 합계 | HEAD **7 / 34** · 대조군 **4 / 34** |

```
thread 'a_lock_unaware_neighbour_cannot_undo_a_logout' panicked at
  crates\ccg-auth\tests\m11r4_store_cas.rs:167:
  ★ 잠금을 모르는 이웃의 로그아웃이 우리 배경 쓰기에 취소됐다
```

번갈아 주행에서 **HEAD와 대조군이 3/14로 똑같다** — AG2가 만든 것도, 악화시킨 것도
아니다(AG2는 `crates/ccg-auth/`를 한 줄도 안 만졌고, 그 테스트는 `status.json`을 안 탄다).
그러니 이 라운드의 판정을 뒤집지 않는다. 다만 **R2가 FAIL을 낸 그 문장이 아직 살아 있다**:
`cargo test --workspace`는 불러 달라고 할 때마다 같은 답을 주지 않는다. 그리고 이 못이
말하는 사실은 화면 밖 이야기가 아니다 — *배경 토큰 회전이 사용자의 로그아웃을 되돌린다*.
빌더의 「제품 쪽 CAS 경합 의심」이 맞다면 **제품 결함**이고, 다음 갈래가 집어야 한다.
`ccg-auth::testkit::lock()`(세 번째 자물쇠)이 아직 살아 있다는 빌더의 리스크 2번도
같은 파일 근처다.

### 8-2. `status::seed()`는 목적지를 **자물쇠 밖에서** 뜬다 — 방금 닫은 창의 쌍둥이

`flush()`는 이 라운드에 목적지를 자물쇠 안으로 들여왔다. 그런데 같은 파일을 쓰는 다른
경로 하나가 옛 모양 그대로다:

```rust
pub fn seed(map: BTreeMap<String, Value>) {
    let (m, _) = state();
    { let mut st = m.lock()…; …; st.loaded = true; }   // ← 여기서 자물쇠를 놓고
    write_map(&map);                                    // ← path()를 밖에서 뜬다
}
```

지금은 안전하다. `testkit::temp_home`이 테스트 본체 내내 **하나뿐인** `CCG_HOME` 자물쇠를
들고 있으니 그 사이에 홈이 갈릴 수 없고, 앱에서는 마이그레이션이 부팅에 한 번뿐이다.
즉 **잠재**다. 다만 `status.rs`의 새 주석이 「`forget()`이 같은 자물쇠를 잡으므로 그 창이
닫힌다」라고 적어 두었는데, `seed()`는 그 자물쇠를 잡지 않는 유일한 쓰기 경로다 —
다음 사람이 그 문장을 파일 전체의 성질로 읽으면 여기서 틀린다. 한 줄 주석이든
`write_map_to(&map, path())`를 자물쇠 안으로 들이든, 값싼 마무리다.

### 8-3. 선존 그대로

- `poc-chat-unify-migrate`의 `§5.3-6 스테이징 잔여물` 실패 1건(픽스처·부하 둘 다).
  하네스 기대가 구현(일부러 한 세대를 남긴다)보다 낡았다 — 빌더가 완화하지 않은 것은 옳다.
- 「파일의 마지막 사실」 수명은 안 늘렸다. 화면 피해 0 · 문서와 못이 사실대로 말한다.

---

## 9. 판정

**PASS.** R2가 붙인 단 하나의 붉은 자리는 닫혔고, 닫혔다는 것을 대조군·이빨·반복
세 방향으로 재확인했다. 겨눈 회귀 네 축(조회·재시작·삭제·ask)은 내 바이너리에서
30+30+12항목 findings 0. 게이트 숫자는 크레이트별로 빌더 보고서와 한 자리도 안 어긋난다.

그리고 이 라운드가 고친 것이 「테스트 게이트의 색깔」이 아니라 **「테스트가 사용자 홈에
쓴다」**였다는 것을, 대조군 3판 17건 대 고친 판 540주행 0건으로 못 박았다 — 빌더 자신이
「아직 안 났다」고 적은 사고다. 났었다. 이제 안 난다.
