# AG2 R1 — 「조회 한 번이 살아 있는 『사용 중』을 지운다」 (확인 크리틱 R3 · G2)

- 대상 결함: `docs/critic/r28b-acct-critic-r3.md` **G2** (커밋 `bf15d5b`에 실린 판정문)
- 갈래 경계: `crates/ccg-store/src/status.rs` · `crates/ccg-store/src/chats_v3.rs` ·
  `scripts/poc-acct-live.mjs`(조회 축 추가) · 이 보고서
- 격리: `CARGO_TARGET_DIR=target-ag2` · `CCG_HOME=%TEMP%\ccg-acct-live-ag2r1*` ·
  CDP **9661~9668**(고정 exe) · **9671~9678**(대조군) · 전 주행 `CCG_NO_NET=1` + 합성 계정
  → **실 HTTP 0건 · 실계정 토큰 열람 0회**. 종료는 내가 spawn한 PID 트리만
  (`killTree`) — 이름 기반 kill **0회**, 사용자 실앱 5개(6644·12924·23792·24836·26924)는
  주행 전후 **같은 PID 그대로**고 내 exe 고아는 0건이다(주행 뒤 `Win32_Process`로 확인).

## 0. 한 줄 요약

`chats:get`은 **읽기 채널**인데 그 한 번이 셸의 상태 맵을 디스크 스냅샷으로 갈아치우고
있었다. 「부팅 장전은 한 번」 표식(`LOADED`)이 **세워지기만 하고 아무도 안 읽었기**
때문이다. 표식을 실제로 읽게 만들었다 — 첫 장전만 디스크가 메모리를 채우고, 그 뒤의
`load_boot`(=`chats:get`)은 **조회**다: 살아 있는 메모리가 이기고, 메모리가 모르는
채팅만 디스크에서 짓는다.

크리틱이 요구한 두 선택지(① `LOADED`를 읽어 두 번째부터 `snapshot()` · ②
런타임 전용 두 키는 메모리가 이기게 병합) 중 **①을 골랐고, ②의 성질을 포함하도록**
지었다. ①을 그대로(=`snapshot()` 반환) 두면 *메모리가 아직 모르는 채팅*(방금 만든
채팅·이 프로세스에서 한 번도 안 돈 채팅)의 행이 응답에서 통째로 빠지고, `chat:status`는
REPLACE라 그 채팅이 **다음 브로드캐스트에서 사라진다**(사이드바 점이 꺼진다). 그래서
"메모리가 이기고, 모르는 것만 디스크가 채운다"가 정확한 모양이다.

## 1. 무엇이 틀렸나 (코드로)

`chats_v3::read_chats`(= `chats:get`의 본체)가 마지막에 무조건 `status::load_boot(&ids)`를
부르고, `load_boot`은 매번 **부팅 장전**을 했다:

1. `status.json`을 다시 읽어 행마다 `strip_runtime_only`(`account`·`panelId` 제거 — R2가
   F1을 닫으려고 넣은 그 줄)를 적용하고,
2. 규약 4의 부팅 강제(`busy=false`·`ask="none"`·`bgActive=false`·`working|analyzing→idle`)를
   걸고,
3. `st.map = out`으로 **메모리 맵을 통째로 덮었다**.

걷힌 행은 스스로 못 돌아온다 — 허브는 lite가 *바뀔 때만* `status::set`을 부르는데
(`hub.rs`의 `if same { return }`) 턴이 끝난 채팅의 lite는 다시 안 바뀐다. 그래서 그
채팅은 **다음 턴을 돌 때까지** 계정을 안 문 것으로 보이고, 그 사이 사용자는 §3이 막으려던
바로 그 사고(이미 타고 있는 계정으로 다른 대화를 갈아타기)를 낸다.

같은 덮어쓰기가 `ask`도 `"none"`으로 되돌린다. **승인 대기(`AwaitingUser`)는 계약상
타임아웃이 없어** lite가 다시 안 바뀌므로, 그 행은 영영 안 돌아온다.

## 2. 고친 것

### ⑴ 표식을 `State`로 옮기고 **실제로 읽는다** (`status.rs`)

```
State { map, dirty, loaded }        // ← `static LOADED: OnceLock<()>`를 대체
claim_boot() -> bool                // 이번 호출이 부팅 장전인가(그 자리에서 표식을 세운다)
load_boot(ids) = claim_boot() ? 장전 : read_live(ids)
```

`OnceLock`이 아니라 `State`인 이유: **홈이 갈리면 다음 장전은 다시 부팅**이다
(`forget()`이 표식을 내린다). 새 홈의 `status.json`에 옛 판이 써 둔 유령 계정이 있을 수
있으므로 F1은 그 홈에서 다시 한 번 돌아야 한다. `OnceLock`은 그 되돌림을 표현할 수
없다(프로세스에 한 번뿐이라 테스트도 한 홈만 산다).

동시 호출은 **하나만** 장전 자격을 받는다. 두 번 장전해도 결과는 같지만, 그 사이의
`set`을 덮을 수 있는 창을 굳이 열지 않는다.

### ⑵ `read_live` — 조회는 메모리가 이긴다 (`status.rs`)

- 메모리가 아는 행은 **그대로** 돌려준다(`account`·`panelId`·`ask`·`busy`·`status` 전부 —
  그 값들의 주인은 허브이지 디스크가 아니다).
- 메모리가 **모르는** 채팅만 `row_from_disk`로 짓는다. 그런 채팅은 정의상 이 프로세스에서
  한 번도 안 돈 채팅이라 부팅 강제·F1 청소·규약 3(`<chatId>.json`이 이긴다)·규약 5(얕은
  스캔 재구성)가 전부 그대로 맞다.
- 지은 행은 메모리에도 **앉힌다**(REPLACE에서 사라지지 않게). 다만 `dirty`는 안 세운다 —
  **조회는 디스크를 안 건드린다.**
- 디스크 읽기는 자물쇠 **밖**에서 한다(허브 틱을 세우지 않는다). 그 사이 허브가 같은 id에
  행을 앉혔으면 **그쪽이 이긴다**(`entry().or_insert()`) — 덮지 않는 것이 이 수정의 요지다.

### ⑶ `set()`도 표식을 세운다 — 플래그 판의 같은 구멍 (`status.rs`)

`CCG_NO_STATUS_BOOT=1`(R4 귀속 팔)에서는 부팅 장전이 **아예 안 돈다**. 그 판에서 첫
`chats:get`이 「첫 호출 = 장전」 자격을 가져가면, 허브가 이미 앉힌 살아 있는 행들을 디스크
스냅샷이 덮는다 — 같은 결함의 플래그 판이다. 그래서 **살아 있는 값이 한 줄이라도 앉으면
그 홈은 장전된 것으로 친다.**

### ⑷ `seed()`가 규약 4를 건다 — 업그레이드 첫 화면의 유령 알약 (`status.rs`)

이 수정이 **새로 만들 뻔한** 회귀다. 순서가 함정이다:

```
engine::boot → load_boot(&[])        ← 2.6.2 승계 홈에서는 chats-v3가 아직 비어 있다
                                        (그런데 「첫 장전」 자격을 여기서 가져간다)
첫 chats:get → ensure_migrated() → migrate → status::seed(2.6.2가 얼려 둔 상태 그대로)
             → load_boot(ids)        ← 이제 이건 조회다 = 메모리를 그대로 돌려준다
```

마이그레이터는 원본 값을 그대로 옮기고(§5.2 "상태 맵 동일") 얼리기는 부팅 장전 몫이었다.
그 몫이 조회로 바뀌었으니 **심는 자리에서** 걷어야 한다 — 안 그러면 2.6.2가 크래시 때
얼려 둔 `working`이 업그레이드 첫 화면에 유령 알약으로 뜬다. 얼린 사실 자체는
`<chatId>.json`의 `status`에 그대로 남는다(규약 5가 읽는 그 값 — `migrate_v3`의
「기록에도 남는다」 못이 지키는 자리).

### ⑸ 규약을 하나 적었다 (`status.rs` 헤더 · `chats_v3.rs:467`)

> 6. **장전은 부팅에 한 번.** 규약 4의 강제도, 디스크 값으로 메모리를 덮는 것도 첫
>    장전에서만. 그 뒤의 `load_boot`(=`chats:get`)은 **조회**다. 읽기 채널 한 번이 살아
>    있는 런타임의 계정·승인 대기를 지우면 안 된다.

## 3. 회귀 못 — **조회 축**을 새로 판다

기존 `poc-acct-live`의 A(재시작 축)·E(삭제 축)는 이 결함을 **100% 통과한다**: A는
프로세스를 죽여서(그러면 유령이 저절로 사라진다), E는 지운 채팅만 봐서 못 본다.
그래서 시나리오 **F(`--only=get`)**를 새로 박았다 — 크리틱의 재현식 그대로다:

```
같은 계정을 문 채팅 둘에 턴 1회씩
  → window.api.getChats()  ← App.tsx가 마운트마다 부르는 그 한 줄(읽기 채널)
  → 다른 채팅(c-b)에 턴 하나 더 = 다음 REPLACE   ← c-a는 안 건드린다
  → c-a의 account · picker 「사용 중」 칩 · engine:debug의 PID
```

단위 못은 `crates/ccg-store/src/status.rs`에 셋(전부 조회 축):

| 못 | 잠그는 것 |
|---|---|
| `a_read_never_wipes_a_live_account_or_a_pending_ask` | 조회가 `account`·`panelId`·`ask("permission")`·`busy`·`status("working")`를 **응답에서도, 다음 REPLACE(=`snapshot()`)에서도** 안 지운다 |
| `a_read_still_builds_rows_for_chats_it_has_never_seen` | 처음 보는 채팅의 행은 계속 짓되(REPLACE에서 사라지면 사이드바 점이 꺼진다) 옛 파일의 **유령 계정은 안 싣는다**(F1) |
| `a_migration_seeds_safe_values_not_a_running_turn` | 마이그레이션이 심는 값은 안전값이다(위 ⑷) · `queued`·`hold`는 안 건드린다 |

### 대조군 — 못이 헛못이 아니다 (직접 겨눴다)

**① 실 exe.** 확인 크리틱 R3가 남긴 **수정 전 빌드**(`target-critacct3`, 커밋 `5e1dae7`)에
지금 레포의 하네스로 같은 시나리오를 쐈다(레포·`.git` 무접촉 — exe만 읽었다):

```
node scripts/poc-acct-live.mjs --exe=target-critacct3/release/agentcodegui.exe \
     --only=get --out=-ag2r1ctrl --port=9671

  o F-두 자리        [{c-a, one@ccg.test}, {c-b, one@ccg.test}]
  o F-칩(조회 전)    ["사용 중 · 첫 채팅"]
  X F-조회 응답      ★ chats:get 응답이 살아 있는 계정을 지웠다 → c-a.account = null
  o F-런타임 생존     [{c-b, pid 26400, Idle}, {c-a, pid 15108, Idle}]   ← c-a의 CLI는 살아 있다
  X F-다음 REPLACE   ★ [{c-a, account:null}, {c-b, account:one@ccg.test}]
  X F-칩(조회 후)    ★ ["사용 중 · 첫 채팅"] → []
  ❌ FAIL — 3건
```

크리틱이 적은 표(`account:null` · 칩 소멸 · `c-a`는 PID를 달고 생존)가 **글자 그대로
재현**됐다. 같은 못이 고친 빌드에서는 **6/6 통과**다.

**② 단위.** `claim_boot`의 표식 읽기만 임시로 무력화(=R3 동작)하고 `cargo test -p
ccg-store status::`를 돌려 새 못 **3건이 전부 FAIL**하는 것을 확인한 뒤 되돌렸다
(`조회가 살아 있는 계정을 지웠다(c-a): account = Null` 등).

## 4. 검증 — 크레이트별로 따로 셈

| 항목 | 실측 |
|---|---|
| `npm run typecheck`(node·web) + `typecheck:app` | **3종 초록** |
| `cargo test -p ccg-store` | **85 통과 · 0 실패** (R3 기준 82 + 새 못 3) |
| `cargo test -p agentcodegui` | **145 / 0** |
| `cargo test -p ccg-auth` | **102 / 0** |
| `cargo test -p ccg-auth --features net` | **119 / 0** |
| `cargo test --workspace` | **715 / 0** (R3 크리틱 704 + 내 3 + 옆 갈래 미커밋분) |
| `poc-acct-live --exe=target-ag2/… --out=-ag2r1 --port=9661` | **30항목 전부 통과**(A 6 · B 3 · C 4 · D 3 · E 8 · **F 6**) |
| `poc-acct-live --only=get` **대조군**(수정 전 빌드) | **3건 FAIL**(위) |
| `poc-acct-store` | **`ok` 25줄 · 전부 통과** |
| `poc-store-fanout` | **`ok:` 34줄 · 전부 통과** |
| `poc-limit-resume` | **197 / 0** |

`cargo test --workspace`의 715는 트리에 남아 있는 **옆 갈래의 미커밋 변경**
(`crates/ccg-fs/src/git.rs` +174줄 등)을 포함한 수치다 — 내 몫은 `ccg-store` +3이고,
나머지 크레이트 수는 R3 크리틱 실측과 같다(145는 R3의 143 + 옆 갈래 2).

빌드는 `CARGO_TARGET_DIR=target-ag2`에 `cargo build --release --features custom-protocol -p
agentcodegui` + `ccg-fakecli`(`--features fakecli`) + `ccg-auth-probe`(`--features cli`).
공용 `target/`·다른 갈래의 `target-*`에는 **아무것도 안 지었다**(`target-critacct3`는
대조군으로 **읽기만**).

## 5. 남은 리스크 · 정직하게 안 한 것

1. **`ask` 축은 화면으로 안 쟀다.** 승인 대기가 조회를 견디는지는 단위 못
   (`ask:"permission"`이 응답과 `snapshot()` 양쪽에 남는다)으로만 잠갔다. 실 exe로 재려면
   가짜 CLI가 승인 요청을 내는 대본이 필요한데, 이번 갈래의 경계 밖이라 안 만들었다.
   (크리틱도 이 축은 코드로만 확인하고 결함으로 세지 않았다.)
2. **조회가 더 이상 「목록에 없는 행」을 걷어내지 않는다.** 예전에는 `st.map = out`이
   암묵적 prune이었다. 지금은 삭제 경로가 각자 알린다(`retain`·`forget_one` — R3 G1이 판
   문). 전 삭제 경로가 그 문을 지나는 것은 확인했다(`write_chats`→`retain` ·
   `remove_chat`→`forget_one` · `dispose_removed_chats`). **일부러** prune을 안 넣었다:
   `chat_ids`가 불완전한 판(깨진 `index.json` → `scan_ids` 폴백)에서 prune은 **살아 있는
   행을 지우는** 더 나쁜 실패로 간다 — 지금 고치는 결함과 같은 종류다.
3. **`queued`·`hold`의 갱신 시점이 조회에서 빠졌다.** 예전에는 조회마다 `<chatId>.json`을
   다시 읽어 되맞췄다(규약 3). 지금은 메모리가 아는 행이면 허브의 값을 쓴다 — 그 둘의
   주인은 런타임이고(`engine/lite.rs` 헤더) 허브가 바뀔 때마다 `set`+`persist_hold`로
   내린다. 어긋날 수 있는 창은 *런타임이 이미 거둬진 채팅의 큐를 렌더러가 디스크에서만
   바꾼 경우*인데, 그 화면의 예약 목록은 렌더러 자기 상태(`ScheduledMsg[]`)로 그리므로
   `statuses.queued`가 즉시 필요하지 않다. 재장전 후보 판정(`reload_candidates`)은 조회를
   안 쓰고 채팅 파일을 직접 읽으므로 영향이 없다.
4. **`docs/renderer-divergence.md` §6.6/§6.7의 한 줄**(*"`load_boot`이 부팅 장전에서
   걷어낸다"*)은 이제 **"첫 장전에서만"**이라는 한정이 붙는다. 그 파일은 이번 라운드에
   다른 갈래가 미커밋으로 잡고 있어 **안 건드렸다**(공유 파일 규율) — 소유 갈래가
   반영하면 된다.

## 6. 만진 파일

| 파일 | 무엇 |
|---|---|
| `crates/ccg-store/src/status.rs` | `State.loaded` + `claim_boot`/`read_live`/`row_from_disk`/`force_boot_shape`/`read_stored` 분리 · `set`·`forget`·`seed` 보정 · 규약 6 · 새 못 3 |
| `crates/ccg-store/src/chats_v3.rs` | `read_chats`의 `load_boot` 호출 자리에 「이 줄은 읽기다」 주석(규약 6 연결) |
| `scripts/poc-acct-live.mjs` | 시나리오 **F(조회 축)** 추가 — 6항목 |
| `docs/critic/acct-live-ag2r1.json` | 고친 exe 전 시나리오 주행(30항목 통과) |
| `docs/critic/acct-live-ag2r1ctrl.json` | 대조군(수정 전 빌드 · 3건 FAIL) |
| `docs/parity-fix-ag2-r1.md` | 이 문서 |
