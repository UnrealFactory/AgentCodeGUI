# R28c 「AG2」 확인 크리틱 R1 — G2는 진짜로 닫혔다(빌더가 안 잰 ask 축까지). 마이그레이션 하네스가 새로 빨개졌다

**판정: FAIL(pass=false)** — 겨눈 구멍(G2)은 **내 손으로 지은 exe**에서 전부 닫힌 것을
확인했고, 빌더가 「경계 밖」이라며 코드로만 잠근 **ask 축을 실 exe로 재서 초록**을 봤다.
다만 이 라운드가 **새로 만든 회귀 한 건**을 A/B로 잡았다: `seed()`에 건 규약 4가 2.6.2의
얼어붙은 `working`을 **디스크에서 지운다**. 하필 그것이, 빌더가 안 돌린 그 하네스
(`poc-chat-unify-migrate.mjs`)가 잡도록 만들어진 바로 그 필드다.

빌더 보고서·커밋 메시지는 근거로 쓰지 않았다. 아래 수치는 전부 이 라운드에서 **직접**
빌드·실행·실측한 것이다.

---

## 0. 격리 (사고 이력 대응)

| 항목 | 값 |
|---|---|
| 빌드 | `CARGO_TARGET_DIR=target-critag2` · `cargo build --release --features custom-protocol -p agentcodegui` + `ccg-fakecli`(`--features fakecli`) + `ccg-auth-probe`(`--features cli`) — **공용 `target/`·남의 `target-*`에는 한 바이트도 안 지었다** |
| 대조군 빌드 | `git worktree add --detach <TEMP>/wt-base bc7877c`(= 1bd6ebb의 부모) + `CARGO_TARGET_DIR=<TEMP>/tgt-base` — **브랜치 이동 0회**, 워킹트리 미커밋(옆 갈래 codex 6파일) 무접촉 |
| CDP 포트 | **9741~9748**(acct-live) · **9751**(ask 축 HEAD) · **9753**(ask 축 대조군) — 남의 갈래(9486·9661~9678) 미충돌 |
| `CCG_HOME` | `%TEMP%\ccg-acct-live-critag2r1*` · `%TEMP%\ccg-critag2-ask` · `%TEMP%\ccg-critag2-mig{,2,3,4}` |
| 실 HTTP | **0건** — 전 주행 `CCG_NO_NET=1` + `ccg-auth-probe seed` 합성 계정. **실계정 토큰 회전 0회** |
| kill | 이름 기반 kill **0회**(`killTree`로 자기 PID 트리만). 사용자 실앱 5개(`24836`·`12924`·`26924`·`6644`·`23792`)는 주행 **전후 같은 PID**, 내 exe 고아 **0건**(`Win32_Process` 확인) |
| 기준 결과 파일 | 무훼손 — 새 리포트는 `--out=-critag2r1`로 갈랐다(`docs/critic/acct-live-critag2r1.json`). 빌더의 `acct-live-ag2r1*.json`·남의 `acct-live-critr*.json` 그대로 |

---

## 1. 체크리스트 ① 조회 축 재현 — **초록**

내가 지은 exe로 `poc-acct-live` 전 시나리오를 돌렸다(A·B·C·D·E·F, **30항목 findings 0**).
리포트: `docs/critic/acct-live-critag2r1.json`.

```
[F] G2 — 같은 계정을 문 자리 둘 → `chats:get` 1회 → 다음 REPLACE → 칩 그대로
  o F-두 자리          [{c-a,one@ccg.test},{c-b,one@ccg.test}]
  o F-칩(조회 전)      ["사용 중 · 첫 채팅"]
  o F-조회 응답        {"chatId":"c-a","status":"done","account":"one@ccg.test","ask":"none"}
  o F-런타임 생존(전제) [{"chatId":"c-a","pid":4020,"state":"Idle"},{"chatId":"c-b","pid":3968,...}]
  o F-다음 REPLACE     {"chatId":"c-a","status":"done","account":"one@ccg.test","panelId":null}
  o F-칩(조회 후)      ["사용 중 · 첫 채팅"]
```

「런타임 생존(전제)」가 **pid 4020으로 살아 있는 채로** 조회를 통과했다 — 이 축이 성립한다는
물증이다.

## 2. 체크리스트 ② F1 무회귀(재시작 축) · 삭제 축(E) — **초록**

```
[A] o A-디스크         status.json len=209, "account" 0건
    o A-재기동 status  [{"chatId":"c-a","status":"done","account":null,"panelId":null}]
    o A-재기동 유령칩  badges=["기본 · 맨 위"]  (오염된 입력=true — 두 키를 도로 끼워 넣은 홈)
[E] o E-유령 행 / o E-유령 칩 / o E-런타임 회수 / o E-브로드캐스트(7→8)
```

「사용 중」 배지 **0건**, `status.json`에 `account` **0건**. 삭제 축도 전부 초록.
즉 이 수정은 F1·G1을 되돌리지 않았다.

## 3. 체크리스트 ③ **ask 축 — 빌더가 안 잰 자리를 내가 쟀다. 초록.**

빌더는 *"실 exe로 재려면 가짜 CLI에 승인 요청 대본이 필요한데 경계 밖"*이라며 단위 못으로만
잠갔다. **그 대본은 이미 만들 수 있다** — `ccg_fakecli`는 `{"awaitResponse":"<id>"}`를 지원하고
(`crates/ccg-engine/src/bin/ccg_fakecli.rs`), `control_request{can_use_tool}` 한 줄이면 T4가
`AwaitingUser`로 올라간다. 레포는 안 건드리고 `%TEMP%`에 하네스를 하나 지어 쟀다.

**HEAD(내 빌드) — 9항목 전부 초록**

```
o 전제-승인 카드    "Claude의 승인 요청 | Write | 이 작업을 실행할까요? …"
o 전제-ask          {"chatId":"c-a","status":"working","busy":true,"ask":"permission","account":"one@ccg.test"}
o ①조회 응답 ask/account/busy·status   전부 위와 동일
o ②카드 생존        (.qcard 그대로)
o ③다음 REPLACE ask/account            전부 위와 동일
o ④되돌아온 카드    (c-b로 갔다 c-a로 복귀해도 카드 그대로)
```

**대조군(`target-critacct3` = 수정 전 5e1dae7) — 5건 FAIL 재현**

```
X ①조회 응답 ask     {"chatId":"c-a","status":"idle","busy":false,"ask":"none","account":null}
X ①조회 응답 account  ↑
X ①조회 응답 busy/status ↑
X ③다음 REPLACE ask   c-a={idle,false,none,null}  ·  c-b={working,true,permission,one@ccg.test}
X ③다음 REPLACE account ↑
o ②카드 생존 · o ④되돌아온 카드   ← **카드 DOM은 양쪽 다 살아 있다**
```

여기서 하나 바로잡는다. **부서진 것은 카드가 아니라 셸의 기억이다.** 승인 카드(`.qcard`)는
수정 전에도 화면에 남아 있었다 — `chat:event` 원장이 그리므로 조회가 안 건드린다. 지워진 것은
`ask`·`busy`·`status`·`account`고, 그중 **`busy=false`가 실질 피해**다: CLI가 무기한 멈춰 서
있는데 셸은 「안 도는 중」으로 알아 **전송 게이트가 열리고** 사이드바 알약·멀티 `waiting`
표식이 꺼진다. 그리고 위 대조군 로그가 보여주듯 **조회 시점에 이미 메모리에 있던 행만** 갈리고
(c-a) 조회 뒤에 생긴 행은(c-b) 멀쩡하다 — 커밋 메시지가 적은 기전 그대로다.

## 4. 체크리스트 ④ 테스트·타입 — **초록**(크레이트별로 따로 셌다)

| 항목 | 실측 | 빌더 주장 |
|---|---|---|
| `cargo test -p ccg-store` | **85 / 0** (새 못 3 포함, 전부 통과) | 85/0 ✔ |
| `cargo test -p agentcodegui` | **145 / 0** | 145/0 ✔ |
| `cargo test -p ccg-auth` | **100 / 0** (84+14+2) | 102/0 △ |
| `cargo test -p ccg-auth --features net` | **117 / 0** (94+1+6+14+2) | 119/0 △ |
| `cargo test --workspace` | **715 / 0** | 715/0 ✔ |
| `npm run typecheck`(node·web) + `typecheck:app` | **3종 초록** | ✔ |
| `poc-acct-store` / `poc-store-fanout` / `poc-limit-resume` | **통과 / 통과 / 197 통과 0 실패** | ✔ |

△ 2건 차이는 **AG2 탓이 아니다** — 빌더가 잴 때 트리에 옆 갈래의 `ccg-auth/src/{claude,codex}.rs`
미커밋이 얹혀 있었고 지금은 없다(내 주행 시점 `git status`에 그 둘이 없다). 워크스페이스
총합 715가 정확히 맞는 것이 그 해석을 뒷받침한다.

## 5. 부기(`#[must_use]` 세 줄) — **A/B로 확인. 초록.**

대조군 워크트리(`bc7877c`)에서 같은 명령(`cargo build -p ccg-store --features cli --bin
ccg-migrate`)을 돌려 **경고 3건**을 눈으로 봤다:

```
warning: unused return value of `ccg_store::chats_v3::write_chats` that must be used
warning: unused return value of `chats_save` that must be used
warning: unused return value of `ma_save` that must be used
warning: `ccg-store` (bin "ccg-migrate") generated 3 warnings
```

HEAD 동일 명령 = **경고 0**. 그리고 `{"ok":true,"removed":[…]}`로 키가 **늘어난** 것이
소비자를 안 깨는지도 코드로 확인했다 — `poc-chat-unify-migrate.mjs`의 세 호출
(`save-chats` 697·717·782행, `alias-chats-save` 750행, `alias-ma-save` 733행)은 **반환을 변수에
안 받는다**. 빌더 주장대로다.

---

## 6. ★새 회귀 — `seed()`의 규약 4가 **디스크의 얼어붙은 `working`을 지운다**

이 라운드가 새로 만든 유일한 결함이고, **빌더가 안 돌린 그 하네스가 잡도록 만들어진 필드**다.

### 무엇이 바뀌었나

`status::seed()`는 R3까지 `st.map = map`(마이그레이터가 준 값 **그대로**)이었다. 이 라운드가
거기에 `force_boot_shape`를 걸었고, `seed()`는 그 직후 **`flush()`로 디스크에 쓴다**. 그래서
규약 4의 강제가 「메모리 안전값」에 그치지 않고 **`chats-v3/status.json`에 굳는다**.

### A/B (같은 손수 만든 2.6.2 홈 — 크래시로 `snapshot.status:"working"`에 얼어붙은 채팅 하나)

| 빌드 | `chats-v3/status.json` → `statuses["c-run"].status` |
|---|---|
| **대조군 `bc7877c`**(detached worktree, 격리 target) | `"working"` |
| **HEAD** | `"idle"` |

레코드(`chats-v3/c-run.json`)의 `status`는 양쪽 다 `"working"`이다 — 즉 **사이드카와 레코드가
영구히 어긋난 상태로 남는다.**

### 프로덕션 하네스가 실제로 빨개진다

`poc-chat-unify-migrate.mjs`는 `status`를 **BEFORE(2.6.2 `rec.snapshot.status`, 355행)** 대
**AFTER(`status.json.statuses[id].status`, 519행)**로 비교한다(601행 필드 목록에 `status`가
있다). 같은 홈, 같은 하네스, 바이너리만 갈아 끼운 A/B:

```
[대조군 bc7877c]  실패 2 — 원본 리프 소실(내 픽스처의 미지 키) · §5.3-6 스테이징 잔여물
[HEAD]            실패 3 — 위 둘 + ✗ 항목 필드 status {"id":"c-run","before":"working","after":"idle"}
```

`항목 필드 status`는 **HEAD에만 있다.** 이 라운드가 만든 것이다.

*(하네스 실행은 레포를 안 건드렸다 — 스크립트를 `%TEMP%`로 복사해 `EXE`/출력 경로만 바꿔 돌렸다.)*

### 얼마나 나쁜가 — 정직하게

- **오늘 화면에 보이는 피해는 없다.** 얼린 사실은 `<chatId>.json`에 남고, 어느 읽기 경로든
  `working→idle`을 다시 강제하므로 알약은 양쪽 다 `idle`이다.
- **깨진 것은 문장이다.** §5.2의 "상태 맵 동일"이 더 이상 참이 아니고, 프로젝트가 「무손실」을
  재는 유일한 자가 그 필드에서 빨개진다. 그리고 그 대상 인구는 **턴 도중에 죽은 채팅** —
  규약 4가 존재하는 이유인 바로 그 집단이다.
- 고치는 값은 싸 보인다: 강제를 **메모리에만** 걸고(`seed`가 `flush` 전에 원본을 쓰거나, 강제를
  `snapshot()`/브로드캐스트 쪽으로 옮기거나), 아니면 **하네스의 AFTER 모델을 레코드 쪽으로**
  옮기고 그 이유를 §5.2에 적는다. **어느 쪽이든 「안 재고 넘어간다」는 아니다.**

### 곁다리 — 그 하네스는 원래도 초록이 아니었다(AG2 탓 아님)

두 기본 픽스처(`--fixture`·`--synthetic`) 모두 `§5.3-6 스테이징 잔여물`
(`chats-v3.old-<ts>`·`boards.old-<ts>`)로 실패한다. **대조군 바이너리에서도 똑같이 실패한다** —
AG2는 `migrate_v3.rs`를 한 줄도 안 만졌다. 다만 이 사실이 아무 라운드의 보고서에도 없다:
「안 돌렸다」가 이렇게 쌓인다.

---

## 7. 나머지 지적(작은 것들)

1. **`docs/renderer-divergence.md:522`의 변명은 만료됐다.** 빌더는 *"다른 갈래가 미커밋으로 잡고
   있어 안 건드렸다"*고 적었는데, 지금 그 파일은 **git에서 깨끗하다**(마지막 손댐 `5e1dae7`).
   그 줄은 아직 *"`account`·`panelId`는 … **부팅 장전에서 걷어낸다**(`load_boot`)"*라고만 적혀
   있어, 이 라운드가 만든 **「첫 장전에서만」** 한정이 빠져 있다. 주인 없는 문장이 됐다.
2. **prune을 뺀 자리(빌더의 「미완 3」)는 감사 결과 구멍이 없다** — 값을 지우는 경로 넷
   (`write_chats→retain` · `remove_chat→forget_one` · `ma_save→dispose_removed_chats→forget_one`
   · `Op::Dispose→clear_runtime`)이 전부 살아 있고 E 시나리오도 초록이다. 다만 **공짜였던 안전망이
   사라졌다**는 것은 기록해 둘 값이다: R3까지는 조회 한 번이 맵의 `account`를 통째로 쓸어
   유령을 지웠다(그게 G2의 원인이자, 동시에 「`clear_runtime` 빠뜨림」의 은폐막이었다). 이제는
   빠뜨리면 **프로세스가 죽을 때까지 남는다.**
3. **`load_boot`의 부팅 가지에 좁은 창이 하나 남아 있다.** `claim_boot()`이 자물쇠를 놓고 →
   디스크를 읽고 → `st.map = out.clone()`으로 **통째로 덮는다**. 그 사이의 `set()`은 사라진다.
   오늘은 도달 불가다(부팅 `load_boot`은 `hub::start` **앞**에서 돈다). 도달하는 판은
   `CCG_NO_STATUS_BOOT=1`뿐이고, `set()`이 표식을 세우니 「턴이 한 번이라도 돈 뒤」는 안전하다.
   `claim_boot`의 주석은 *동시 독자*에 대해 이 창을 이미 논하면서 **자기 가지에는 안 닫았다.**
   지금 고치라는 말은 아니고, 「닫혔다」고 적지는 말자는 말이다.

---

## 8. 요약

| 축 | 결과 |
|---|---|
| G2 조회 축(실 exe, 내 빌드) | **닫혔다** — 30/30, 런타임 pid 생존 상태로 통과 |
| F1 재시작 축 · G1 삭제 축 | **무회귀** |
| **ask 축(빌더 미측정 → 내가 실 exe로 측정)** | **닫혔다** — HEAD 9/9, 대조군 5 FAIL |
| 단위·타입·PoC | ccg-store 85/0 · agentcodegui 145/0 · workspace 715/0 · typecheck 3종 · fanout/acct-store/limit-resume 통과 |
| `#[must_use]` 부기 | **사실** — 대조군 경고 3, HEAD 0 |
| **마이그레이션 무손실** | **★새로 깨졌다** — `seed()`의 규약 4가 `status.json`의 `working`을 `idle`로 굳힌다(A/B 확인, 하네스 새 FAIL 1건) |

**가장 치명적인 하나**: 안 돌린 하네스가, 하필 이 라운드가 만진 유일한 마이그레이션 한 줄을
잡도록 만들어져 있었다. 「경로가 공용 target에 박혀 있어서 못 돌렸다」는 이유는 사실이지만,
**스크립트를 복사해 경로만 바꾸면 되는 일이었다**(내가 그렇게 했다).
