# R28c 「AG2」 확인 크리틱 R2 — 겨눈 회귀는 진짜로 닫혔다. 그 못 두 개가 게이트를 네 번에 한 번 빨갛게 만든다

**판정: FAIL(pass=false)** — R1이 잡은 회귀(`seed()`의 규약 4가 디스크의 얼어붙은
`working`을 지우던 자리)는 **내 손으로 지은 바이너리와 원본 그대로의 하네스로** 닫힌 것을
확인했다. 조회(G2)·재시작(F1)·삭제(G1)·**ask** 네 축도 실 exe로 다시 재서 전부 초록이다.

그런데 이 라운드가 새로 박은 단위 못 두 개가, 선존하던 테스트 전역 상태 경합의 **창을
열 배로 벌렸다**: `cargo test -p ccg-store`가 **37번 중 9번 빨갛다**(대조군 45번 중 1번).
빌더가 「87/0」·「717/0」이라고 적은 그 게이트는 **불러 달라고 할 때마다 같은 답을 주지
않는다.** 그리고 붉게 나오는 것은 AG2가 만진 적 없는 남의 테스트다(`migrate_v3` 재마이그
레이션 2종·`talk` 옵트인) — 다음 갈래가 그 빨간색을 보고 자기 탓을 찾게 된다.

빌더 보고서·커밋 메시지는 근거로 쓰지 않았다. 아래 수치는 전부 이 라운드에서 **직접**
빌드·실행·실측한 것이다.

---

## 0. 격리 (사고 이력 대응)

| 항목 | 값 |
|---|---|
| 빌드 | `CARGO_TARGET_DIR=target-critag2` · `cargo build --release --features custom-protocol --manifest-path src-tauri/Cargo.toml` + `ccg-fakecli`(`--features fakecli`) + `ccg-auth-probe`(`--features cli`) + `ccg-migrate`(`--features cli`) |
| 대조군 | `git worktree add --detach %TEMP%\wt-ag2r2base f49a99a`(= `0105c94`의 부모, **AG2 R1 회귀가 든 판**) + `CARGO_TARGET_DIR=%TEMP%\tgt-ag2r2base` — **브랜치 이동 0회**, 옆 갈래 미커밋 무접촉 |
| CDP 포트 | **9821~9828**(acct-live) · **9841**(ask HEAD) · **9843**(ask 대조군) · **9845**(수명 측정) — 빌더(9781~9788)·R1 크리틱(9741~9753)·남의 갈래(9486·9661~9678) 미충돌 |
| `CCG_HOME` | `%TEMP%\ccg-acct-live-critag2r2*` · `%TEMP%\ccg-critag2r2-ask-{head,ctrl}` · `%TEMP%\ccg-critag2r2-freeze` |
| 실 HTTP | **0건** — 전 주행 `CCG_NO_NET=1` + `ccg-auth-probe seed` 합성 계정. **실계정 토큰 회전 0회** |
| kill | 이름 기반 kill **0회**(`killTree`로 내가 spawn한 PID 트리만). 사용자 실앱 5개(`24836`·`12924`·`26924`·`6644`·`23792`)는 주행 **전후 같은 PID** |
| 공용 산출물 | 공용 `target/`(`ccg-migrate.exe` 08-23 · `agentcodegui.exe` 08-24 18:09)·레포 `docs/poc-out/`(최신 08-23) **한 바이트도 안 건드렸다**. 하네스 리포트는 `--out=-critag2r2`로 갈랐다 |
| 하네스 수정 | **0줄.** `poc-chat-unify-migrate.mjs`는 `%TEMP%\fr-ag2r2{,ctl}` 가짜 ROOT로 복사해 돌렸다(`cmp`로 원본과 바이트 동일 확인) |

---

## 1. 체크리스트 ① 조회 축(G2) — **초록**

내가 지은 exe로 `poc-acct-live` 전 시나리오. **30항목 통과 · findings 0**
(리포트 `docs/critic/acct-live-critag2r2.json`).

```
[F] G2 — 같은 계정을 문 자리 둘 → `chats:get` 1회 → 다음 REPLACE → 칩 그대로
  o F-두 자리          [{c-a,one@ccg.test},{c-b,one@ccg.test}]
  o F-칩(조회 전)      ["사용 중 · 첫 채팅"]
  o F-조회 응답        {"chatId":"c-a","status":"done","account":"one@ccg.test","ask":"none"}
  o F-런타임 생존(전제) [{"chatId":"c-a","pid":12656,"state":"Idle"},{"chatId":"c-b","pid":3844,...}]
  o F-다음 REPLACE     {"chatId":"c-a","status":"done","account":"one@ccg.test","panelId":null}
  o F-칩(조회 후)      ["사용 중 · 첫 채팅"]
```

`c-a`의 CLI가 **pid 12656으로 살아 있는 채로** 조회를 통과했다 — 축이 성립한다는 물증.

## 2. 체크리스트 ② F1 재시작 축 · G1 삭제 축 — **무회귀**

```
[A] o A-디스크         status.json len=209 · "account" 0건
    o A-재기동 status  [{"chatId":"c-a","status":"done","account":null,"panelId":null}]
    o A-재기동 유령칩  badges=["기본 · 맨 위"]   (오염된 입력=true — 두 키를 도로 끼워 넣은 홈)
[E] o E-유령 행 / o E-유령 칩(=[]) / o E-런타임 회수 / o E-브로드캐스트(7→8)
```

## 3. 체크리스트 ③ **ask 축 — 빌더가 「이번엔 안 쟀다」고 적은 자리를 내가 쟀다. 초록.**

`ccg_fakecli`의 `awaitResponse`로 승인 대기(AwaitingUser)를 만들고, 그 상태에서 `chats:get`을
한 번 부르는 하네스를 `%TEMP%`에 지었다(레포 무접촉).

**HEAD(내 빌드) — 12항목 전부 초록**

```
o 전제-승인 카드    "Claude의 승인 요청 | Write | 이 작업을 실행할까요? …"
o 전제-ask          {"chatId":"c-a","status":"working","busy":true,"ask":"permission","account":"one@ccg.test"}
o ①조회 응답 ask/busy/status/account   전부 위와 동일
o ②카드 생존        o ③다음 REPLACE ask/busy/account   전부 동일
o ④되돌아온 카드    o 전제-런타임 생존 [{"c-a",pid:9700,"AwaitingUser"},{"c-b",pid:2288,...}]
```

**대조군(`target-critacct3` = G2 수정 전 `5e1dae7`) — 7건 FAIL**

```
X ①조회 응답 ask/busy/status/account   c-a = {idle, false, none, null}
X ③다음 REPLACE ask/busy/account       c-a는 지워지고 c-b만 살아 있다
o ②카드 생존 · o ④되돌아온 카드        ← 카드 DOM은 양쪽 다 산다(원장이 그린다)
```

내 하네스에 이빨이 있다는 것까지 확인했다. 부서졌던 것은 카드가 아니라 **셸의 기억**이고,
그중 `busy=false`가 실질 피해다(CLI는 pid 35164로 무기한 멈춰 있는데 전송 게이트가 열린다).

## 4. R1이 잡은 회귀 — **진짜로 닫혔다**

### 4-1. 프로덕션 하네스 A/B (스크립트 수정 0줄 · 같은 손수 만든 2.6.2 홈)

`snapshot.status`가 `working`/`analyzing`으로 얼어붙은 채팅이 든 홈을 두 벌 만들어
**바이너리만** 갈아 끼웠다.

```
[대조군 f49a99a]  실패 3
   ✗ 항목 필드 status {"id":"c-run","before":"working","after":"idle"}
   ✗ 항목 필드 status {"id":"c-ana","before":"analyzing","after":"idle"}
   ✗ §5.3-6 스테이징 잔여물  (선존)
[HEAD  0105c94]   실패 1
   ✗ §5.3-6 스테이징 잔여물  (선존)
```

디스크 직접 확인:

| 판 | `chats-v3/status.json` | 레코드 `<id>.json` | `account`·`panelId` 키 |
|---|---|---|---|
| 대조군 | `{c-run:"idle", c-ana:"idle"}` | `working` / `analyzing` | 0 |
| **HEAD** | **`{c-run:"working", c-ana:"analyzing"}`** | `working` / `analyzing` | 0 |

빌더 주장 그대로다. 기본 픽스처(`--fixture`·`--synthetic`)로는 **양쪽 다 실패 1**이고
(그 픽스처엔 얼어붙은 채팅이 없다) `§5.3-6 스테이징 잔여물`은 대조군에서도 같은 줄로
빨간 **선존**이라는 것도 확인했다 — 「남의 게이트를 조용히 완화하지 않았다」는 사실이다.

### 4-2. 부기(`#[must_use]`)

`cargo build --release -p ccg-store --features cli --bin ccg-migrate` — HEAD **경고 0**.

## 5. ★새 결함 — `cargo test -p ccg-store`가 **네 번에 한 번 빨갛다**

이 라운드가 새로 만든 유일한 손해고, 빌더의 「87/0」이 **한 번의 운 좋은 주행**임을 보인다.
내 첫 주행부터 붉었다:

```
test migrate_v3::tests::remigration_still_brings_in_a_chat_created_in_2_6_2_afterwards ... FAILED
  panicked at crates\ccg-store\src\migrate_v3.rs:968:9: 재마이그레이션이 새 대화를 안 데려왔다
test result: FAILED. 86 passed; 1 failed
```

같은 명령을 반복해 세었다(전부 `CARGO_TARGET_DIR` 격리, 트리 무수정):

| 판 | 명령 | 붉은 주행 |
|---|---|---|
| **HEAD `0105c94`** | `cargo test -p ccg-store --lib`(기본 병렬) | **9 / 37 (24%)** |
| HEAD, 이번 라운드의 새 못 2개만 제외 | `--skip a_migration_freezes_the_screen --skip even_the_first_load_keeps_a_row` | 1 / 25 (4%) |
| HEAD, `testhome` 스왑 못 하나만 제외 | `--skip testhome::tests::the_home_never_falls_back` | **0 / 35** |
| HEAD, 직렬 | `--test-threads=1` | 0 / 10 |
| 대조군 `f49a99a` | 기본 병렬 | 1 / 45 (2%) |

**붉은 자리는 매번 다르고, 전부 AG2가 안 만진 테스트다**(실측된 것 셋):

- `migrate_v3::tests::remigration_still_brings_in_a_chat_created_in_2_6_2_afterwards`
- `migrate_v3::tests::remigration_never_overwrites_a_record_that_3_0_kept_writing`
- `talk::m10_tests::opting_a_board_in_and_back_out_round_trips_through_disk`
  (`talk.rs:232` — 방금 끈 보드가 되읽기에서 `true`로 돌아온다: **쓴 홈과 읽은 홈이 다르다**)

### 뿌리 — `ccg-store`에 **`CCG_HOME` 자물쇠가 둘**이다

- `crates/ccg-store/src/lib.rs:248` `testkit::lock()` — `testkit::temp_home`이 잡는다(대부분의 테스트)
- `crates/ccg-store/src/testhome.rs:29` `testhome::lock()` — `testhome::take()`가 잡는다

둘은 **서로 모르는 뮤텍스**다. 그래서 `testhome::tests::the_home_never_falls_back_to_the_real_one_while_tests_swap_it`이
프로세스 전역 `CCG_HOME`을 갈아끼우는 창에, `testkit::temp_home`을 든 테스트가 **쓰기와
읽기 사이**에 들어가면 그 테스트는 남의 홈을 읽는다. 그 못 하나만 빼면 **35주행 0붉음**이고
직렬 실행에서도 0이다 — 경합이 원인이라는 것의 증명이다.

**이 라운드의 몫**: 뿌리는 선존이다(대조군도 1/45로 붉다). 그런데 이 라운드가 `temp_home`을
잡는 못 두 개를 병렬 풀에 더 넣어 **그 창을 2% → 24%로 벌렸다.** 게이트가 실행할 때마다
답이 갈리면 게이트가 아니고, 하필 그 문장을 `testhome.rs` 헤더가 이미 적어 두고 있다
(*"게이트가 실행 방식에 따라 답이 갈리면 게이트가 아니다"*). 고칠 값도 싸다 — 자물쇠 하나를
버리고 `testkit::temp_home`이 `testhome::take`를 부르면 된다.

## 6. 「파일에는 마지막 사실이 남는다」의 **수명은 턴 한 번**이다 (실 앱 실측)

R2가 `status.rs` 헤더 규약 4에 새로 박은 문장을 **실 앱**으로 쟀다. 하네스는 마이그레이션
전용 프로세스(`ccg-migrate`)라 커밋 직후의 파일을 보지만, 실제 업그레이드는 **앱 안**에서
돈다(첫 `chats:get` → `ensure_migrated` → `seed`). 2.6.2 홈(`c-run`이 `working`으로 얼어붙음)에
실 exe를 띄우고 옆 채팅에 턴을 **한 번** 보냈다(포트 9845):

```
① 마이그레이션 직후(앱 안)  status.json = {"c-live":"idle","c-run":"working"}   레코드 c-run = working
② 화면(chats:get 응답)      =            {"c-live":"idle","c-run":"idle"}        ← 유령 알약 없음(초록)
③ 옆 채팅 턴 1회 뒤          status.json = {"c-live":"done","c-run":"idle"}      레코드 c-run = working
④ 종료 flush 뒤              status.json = {"c-live":"done","c-run":"idle"}      레코드 c-run = working
```

`set()` 한 번이 `dirty`를 세우고 500ms 디바운스 `flush()`가 **메모리 맵 전체**(=안전값)를
쓰기 때문이다. 즉 커밋 메시지가 「고쳤다」고 적은 *"레코드와 영구 불일치"*는 **사용자가 첫
턴을 보내는 순간 그대로 돌아온다.** 화면 피해는 여전히 0이고(모든 읽기가 다시 얼린다)
게이트도 진짜로 초록이지만, 헤더의 새 한 문장은 **`ccg-migrate` 단독 실행에만** 참이다.
지금 고치라는 말이 아니라, 그 문장에 「(마이그레이션 프로세스 한정)」이 빠졌다는 말이다.

## 7. 곁다리 — `ccg-auth`도 붉다(선존 · AG2 무관)

`cargo test --workspace`가 한 주행에서 `ccg-auth`의 통합 못에서 죽었다:

```
crates\ccg-auth\tests\m11r4_store_cas.rs:167  a_lock_unaware_neighbour_cannot_undo_a_logout
  ★ 잠금을 모르는 이웃의 로그아웃이 우리 배경 쓰기에 취소됐다   left: 1  right: 0
```

그 못만 단독으로 5번 돌려 **1/5**로 붉었다. AG2는 `ccg-auth`를 한 줄도 안 만졌다 —
이 라운드 탓이 아니고, 다만 「717/0」이 재현 가능한 사실이 아니라는 증거는 하나 더 늘었다.

## 8. 나머지 게이트

| 항목 | 실측 | 빌더 주장 |
|---|---|---|
| `cargo test -p agentcodegui` | **145 / 0** | 145 ✔ |
| `cargo test -p ccg-auth`(net 없음) | **102 / 0** | (워크스페이스 통합 시 119) ✔ |
| `cargo test -p ccg-engine` | **207 / 0** | 207 ✔ |
| `cargo test -p ccg-fs` | **100 / 0** | 100 ✔ |
| `cargo test -p ccg-lsp` | **59 / 0** | 59 ✔ |
| `cargo test -p ccg-store` | **87 / 0 (초록 주행) · 86 / 1 (붉은 주행, 24%)** | 87/0 △ |
| `cargo test --workspace --no-fail-fast` | **717 / 0**(초록 주행) · 한 주행은 `ccg-auth` CAS로 붉었다 | 717/0 △ |
| `npm run typecheck` + `typecheck:app` | **3종 초록** | ✔ |
| `poc-store-fanout` / `poc-acct-store` | **전부 통과 / 전부 통과** | ✔ |
| `poc-chat-unify-migrate`(가짜 ROOT) | 대조군 실패 3 → **HEAD 실패 1** | ✔ |

---

## 9. 요약

| 축 | 결과 |
|---|---|
| G2 조회 축(실 exe, 내 빌드) | **닫혔다** — 30/30, 런타임 pid 생존 상태로 통과 |
| F1 재시작 축 · G1 삭제 축 | **무회귀** |
| ask 축(빌더 미측정 → 내가 실 exe로 측정) | **닫혔다** — HEAD 12/12, 대조군 7 FAIL |
| R1이 잡은 마이그레이션 회귀 | **닫혔다** — 하네스 실패 3 → 1, `status.json` A/B 확인 |
| `#[must_use]` 부기 · 문서 한정(`renderer-divergence.md:522`) | 사실 |
| **`cargo test -p ccg-store`** | **★새로 불안정 — 37주행 중 9번 붉다(대조군 45중 1)** |
| 「파일에는 마지막 사실이 남는다」 | 실 앱에서는 **첫 턴 한 번까지만** 참 |

**가장 치명적인 하나**: 이 라운드가 새로 박은 못 두 개가 `ccg-store`의 선존 경합
(자물쇠 둘 — `lib.rs:248` ↔ `testhome.rs:29`)을 **2%에서 24%로 벌려**, `cargo test -p ccg-store`가
네 번에 한 번 빨갛게 나온다. 붉은 자리는 매번 다르고 전부 남의 테스트라, 다음 갈래는 자기가
안 만든 코드에서 자기 탓을 찾게 된다. 「87/0」·「717/0」은 한 번의 주행이지 게이트가 아니다.
