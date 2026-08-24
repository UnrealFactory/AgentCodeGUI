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
4. **`docs/renderer-divergence.md:522`의 한 줄**(*"`load_boot`이 부팅 장전에서 걷어낸다"*)은
   이제 **"첫 장전에서만"**이라는 한정이 붙는다. R1에서는 그 파일을 다른 갈래가 미커밋으로
   잡고 있어 안 건드렸는데(공유 파일 규율), 확인 크리틱 R1 시점에 **git에서 깨끗해졌다** →
   **R2에서 그 줄만 고쳤다**(아래 §8.5).

## 6. 만진 파일

| 파일 | 무엇 |
|---|---|
| `crates/ccg-store/src/status.rs` | `State.loaded` + `claim_boot`/`read_live`/`row_from_disk`/`force_boot_shape`/`read_stored` 분리 · `set`·`forget`·`seed` 보정 · 규약 6 · 새 못 3 |
| `crates/ccg-store/src/chats_v3.rs` | `read_chats`의 `load_boot` 호출 자리에 「이 줄은 읽기다」 주석(규약 6 연결) |
| `scripts/poc-acct-live.mjs` | 시나리오 **F(조회 축)** 추가 — 6항목 |
| `docs/critic/acct-live-ag2r1.json` | 고친 exe 전 시나리오 주행(30항목 통과) |
| `docs/critic/acct-live-ag2r1ctrl.json` | 대조군(수정 전 빌드 · 3건 FAIL) |
| `docs/parity-fix-ag2-r1.md` | 이 문서 |
| `crates/ccg-store/src/bin/ccg_migrate.rs` | 부기 ⑴ — `#[must_use]` 세 줄(아래) |

## 7. 부기 — `#[must_use]` 관문이 세 줄에서 새고 있었다

확인 크리틱 R3의 사소·부기 첫 줄. `crates/ccg-store/src/bin/ccg_migrate.rs`의 85·98·109행이
`write_chats`·`chats_save`·`ma_save`의 반환을 그냥 버려
`cargo build -p ccg-store --features cli --bin ccg-migrate`가 **경고 3건**을 냈다(기본 피처로는
그 바이너리를 안 지어 `cargo test -p ccg-store`에는 안 보인다). 동작 피해는 없지만 —
CLI에는 거둘 런타임도 들을 창도 없다 — 「구조적으로 막는다」가 그 세 줄에서 사실이 아니었다.

`let _ =`로 덮지 않고 **말하게** 했다: `{ "ok": true, "removed": [...] }`. CLI 판에서
그 계약의 이행은 *무엇을 지웠는지 밝히는 것*이고, 하네스도 그 값을 볼 수 있게 된다
(추가 키라 기존 소비자 `poc-chat-unify-migrate.mjs`는 영향 없다 — 그쪽은 반환을 안 읽는다).

실측: 재빌드 **경고 0건** · 스모크 `save-chats`(빈 목록 저장) → `{"ok":true,"removed":["z1"]}` ·
`cargo test -p ccg-store` **85/0** 그대로.

---

# AG2 R2 — 「규약 4를 **파일에** 굳혔다」 (확인 크리틱 R1 · 새 회귀)

- 대상: `docs/critic/r28c-ag2-critic-r1.md` **§6**(판정문 커밋 `cf490e2`) — 이 갈래가 R1에서
  **새로 만든** 결함 한 건. 크리틱의 나머지 축(G2 조회·F1 재시작·G1 삭제·ask·부기)은 전부
  「닫혔다」 판정이라 R2는 그 하나와, 「지금 고치라는 말은 아니다」로 남긴 작은 것 둘을 만진다.
- 격리: `CARGO_TARGET_DIR=target-ag2`(내 갈래) · CDP **9781~9788** · `CCG_HOME`은
  `%TEMP%\ccg-acct-live-ag2r2*` + `%TEMP%\ag2r2\*` · 전 주행 `CCG_NO_NET=1` + 합성 계정
  → **실 HTTP 0건 · 실계정 토큰 회전 0회**. 이름 기반 kill **0회**(`killTree`만) — 사용자
  실앱 5개(`24836`·`12924`·`26924`·`6644`·`23792`)는 주행 전후 **같은 PID**, 내 exe 고아
  **0건**(`Win32_Process` 확인). 공용 `target/`·남의 `target-*`에는 **한 바이트도 안 지었다.**

## 8. 무엇이 틀렸나 — 「부팅 강제」가 캐시가 아니라 **사실**을 지웠다

R1의 ⑷는 `seed()`에 규약 4(`working|analyzing→idle` 등)를 걸었다. 옳은 절반이었다 —
틀린 절반은 그 강제가 **`flush()`로 디스크까지 내려갔다**는 것이다:

```
migrate_v3: staged chats-v3/status.json ← 2.6.2 값 **그대로**("working")   ← §5.2
            commit_dir(staged → chats-v3)
            status::seed(statuses)  → force_boot_shape → dirty=true → flush()
                                                   ↑ 방금 커밋한 파일을 "idle"로 덮는다
```

그래서 `chats-v3/status.json`은 `idle`, `chats-v3/<id>.json`은 `working` — **사이드카와
레코드가 영구히 어긋난다.** 규약 3·5가 *파일을 진실로 쓰는* 설계인데, 그 파일에서 「턴
도중에 죽었다」는 사실만 사라진 것이다. 그리고 `migrate_v3.rs:151`은 그 반대를 이미 문장으로
적어 두고 있었다 — *"마이그레이터는 원본 값을 그대로 옮긴다(§5.2 '상태 맵 동일'). 얼리기는
부팅 장전이 한다 — **파일은 사실, 메모리는 안전값**"*.

화면 피해는 오늘 없다(모든 읽기 경로가 다시 `idle`로 얼린다). 깨진 것은 **문장과 게이트**다:
프로젝트의 유일한 무손실 하네스 `poc-chat-unify-migrate.mjs`가 정확히 그 필드를 비교한다
(BEFORE `rec.snapshot.status` **355행** ↔ AFTER `status.json.statuses[id].status` **519행** ·
비교 목록 **601행**). 그 하네스를 R1이 **안 돌렸다** — 「공용 `target/debug` 경로가 박혀 있다」는
이유였는데, 스크립트를 `%TEMP%`의 가짜 ROOT로 복사하고 거기 `target/debug/`에 내 exe를
놓으면 **스크립트를 한 글자도 안 고치고** 돈다(R2는 그렇게 돌렸다).

### 8.1 고친 것 — 파일은 사실, 메모리는 안전값

| 자리 | 무엇 |
|---|---|
| `write_map(&map)` (새 함수) | 직렬화 + 런타임 전용 키 제거 + 원자 저장. `flush()`가 쓰던 몸통을 그대로 뗐다 |
| `flush()` | `dirty`면 맵을 복제해 `write_map` — 동작 동일(직렬화가 자물쇠 밖으로 나온 것만 다르다) |
| `seed(map)` | **디스크**에는 `write_map(&map)`으로 마이그레이터가 준 값 그대로, **메모리**에는 `force_boot_shape`를 건 사본 |
| `seed()`의 `dirty=false` | 이 함수 계약의 일부다 — 안 내리면 500ms 디바운스 쓰기나 `ccg-migrate`의 마무리 `status::flush()`가 방금 쓴 사실을 **안전값으로 덮는다** |
| `seed()`의 `loaded=true` | 심은 값이 그 홈의 진실이다(규약 6). `CCG_NO_STATUS_BOOT=1`에서 첫 `chats:get`이 「첫 장전」 자격을 가져가 심은 행을 디스크로 되돌리는 길을 막는다 |
| 헤더 규약 4 | *"강제는 **읽는 쪽**이다. 파일에는 마지막 사실이 남는다"* 한 문장 추가 |

다음 부팅에서 그 파일을 읽을 때 `row_from_disk`가 다시 얼리므로 **화면은 어느 쪽이든
안전값**이다 — 이것이 이 수정이 유령 알약을 되살리지 않는 이유고, 단위 못 ④가 그 자리다.

### 8.2 겸해 — 부팅 가지의 좁은 창을 닫았다(크리틱 지적 3)

`claim_boot()`은 표식만 세우고 **자물쇠를 놓는다**. R1은 그 뒤 디스크를 읽고
`st.map = out.clone()`으로 **통째로 덮었다** — 그 사이에 들어온 `set()`은 사라진다.
조회 쪽(`read_live`)은 이미 `entry().or_insert()`로 막아 둔 창인데 자기 가지에는 안 닫혀
있었다. 첫 장전을 `boot_load()`로 떼어 **같은 규칙**을 적용했다: 메모리가 이기고, 모르는
채팅만 디스크가 채운다. (오늘 도달 불가 — `load_boot`은 `hub::start` 앞에서 돈다. 도달하는
판은 `CCG_NO_STATUS_BOOT=1`뿐이다. 「닫혔다」고 적을 수 있게 실제로 닫았다.)

### 8.3 회귀 못 — 단위 둘(A/B로 헛못이 아님을 확인)

| 못 | 잠그는 것 |
|---|---|
| `a_migration_freezes_the_screen_but_not_the_file` | ① 메모리는 `idle`(유령 알약 없음) ② **디스크는 `working`**(§5.2) ③ 마무리 `flush()`가 그 사실을 안 덮는다 ④ 다음 부팅 장전은 다시 얼린다 |
| `even_the_first_load_keeps_a_row_that_landed_while_it_read_the_disk` | 첫 장전(`boot_load`)이 그 사이 앉은 살아 있는 행(`account`·`ask`·`busy`)을 안 덮는다 · 모르는 채팅은 계속 짓는다 |

**대조군(단위)** — 두 자리를 R1 동작으로 임시 되돌려(`seed`는 `dirty=true`+`flush()`,
`boot_load`는 `st.map = out.clone()`) `cargo test -p ccg-store status::` → **정확히 그 둘만
FAIL**(나머지 11 통과), 되돌린 뒤 87/0. FAIL 문구:
`★ 디스크의 얼어붙은 사실이 지워졌다: {"c-run":{…"status":"idle"…}}` ·
`★ 장전이 살아 있는 계정을 덮었다`.

### 8.4 ★크리틱이 실패시킨 실측을 그대로 재현 — 실 바이너리 A/B

손수 만든 2.6.2 홈(`chats/`에 넷: `c-run`=`snapshot.status:"working"` · `c-ana`=`"analyzing"` ·
`c-done` · `c-idle`. 레코드 키 집합은 하네스의 `makeSyntheticHome`과 **동일**하게 맞춰 리프
감사 잡음을 없앴다). 대조군은 **수정 직전 소스로 지은 `ccg-migrate`**를 `%TEMP%`에 떠 놓고
(바이너리만 갈아 끼운 A/B), 홈은 매번 새로 만든다.

```
ccg-migrate migrate --no-backup           chats-v3/status.json     chats-v3/<id>.json
──────────────────────────────────────────────────────────────────────────────────────
대조군(수정 전)   c-run                    "idle"        ✗          "working"
                  c-ana                    "idle"        ✗          "analyzing"
HEAD(수정 후)     c-run                    "working"     ✓          "working"
                  c-ana                    "analyzing"   ✓          "analyzing"
                  c-done/c-idle            "done"/"idle" ✓          동일
```

같은 홈·같은 하네스(`%TEMP%` 사본, `--home`), 바이너리만 교체:

```
[대조군] 실패 3 — ✗ 항목 필드 status {"id":"c-run","before":"working","after":"idle"}
                  ✗ 항목 필드 status {"id":"c-ana","before":"analyzing","after":"idle"}
                  ✗ §5.3-6 스테이징 잔여물 ["boards.old-…","chats-v3.old-…"]
[HEAD]   실패 1 — ✗ §5.3-6 스테이징 잔여물 ["boards.old-…","chats-v3.old-…"]   ← 선존(아래 §9)
```

**크리틱이 새로 띄운 그 한 줄이 사라졌다.** 남은 한 줄은 AG2와 무관한 선존 결함이다.

### 8.5 문서 한 줄 (`docs/renderer-divergence.md:522`)

R1이 「남이 미커밋으로 잡고 있다」며 미룬 줄. 지금은 git에서 깨끗해서 **내 hunk 하나만** 고쳤다:
*"**부팅 첫 장전에서만** 걷어낸다 … 그 뒤의 `load_boot`(=`chats:get`)은 **조회**라 살아 있는
메모리가 이긴다 — 읽기 한 번이 살아 있는 런타임의 계정·승인 대기를 지우던 자리(G2)"*.

## 9. R2 검증 — 크레이트별로 따로 셈

| 항목 | 실측 |
|---|---|
| `npm run typecheck`(node·web) + `typecheck:app` | **3종 초록**(커밋 직전 재확인) |
| `cargo test -p ccg-store` | **87 / 0** (R1의 85 + 새 못 2) |
| `cargo test --workspace` | **717 / 0** (크리틱 실측 715 + 내 못 2 · FAILED 0건) |
| ↳ `agentcodegui` | 145 / 0 |
| ↳ `ccg-auth`(워크스페이스 피처 통합 = `net` 포함) | 119 / 0 (94+1+6+14+2+1+1) |
| ↳ `ccg-engine` | 207 / 0 (68 + 통합 12벌) |
| ↳ `ccg-fs` 100 / 0 · `ccg-lsp` 59 / 0 · `ccg-store` 87 / 0 | |
| **`poc-acct-live`(실 exe, 전 시나리오)** | **30항목 통과 · findings 0** — A 6 · B 3 · C 4 · D 3 · E 8 · **F 6**. `--exe=target-ag2/release/agentcodegui.exe --out=-ag2r2 --port=9781` |
| ↳ F(조회 축) 전제 | `c-a` CLI가 **pid 26808로 살아 있는 채로** `chats:get` 1회 통과 → 다음 REPLACE `account:"one@ccg.test"` · 칩 `["사용 중 · 첫 채팅"]` |
| ↳ A(재시작 축) | `status.json` `"account"` **0건** · 오염 홈 재기동 유령칩 **0건** |
| **마이그레이션 하네스**(`%TEMP%` 사본 · 손수 만든 2.6.2 홈) | 대조군 실패 3 → **HEAD 실패 1**(선존만) |
| ↳ 같은 하네스 `--synthetic`(부하 픽스처) | 채팅 **311** · 메시지 **15810** · 정체성 1차 불일치 **0** · **실패 1**(선존 스테이징 잔여물만) — 이 수정이 큰 홈에 새 손실을 안 냈다 |
| `poc-acct-store` / `poc-store-fanout` / `poc-limit-resume` | **전부 통과 / 전부 통과 / 197 통과 0 실패** |

리포트: `docs/critic/acct-live-ag2r2.json`(기준 파일 무훼손 — `--out=-ag2r2`로 갈랐다).

## 10. R2가 안 한 것 · 남은 리스크

1. **`ask` 축은 이번에 다시 안 쟀다.** 크리틱이 실 exe로 9/9를 재 준 축이고, 그 길
   (`read_live`)은 R2에서 **한 줄도 안 바뀌었다**(`git diff`의 hunk가 `load_boot`
   가지 → `flush`/`write_map` → `seed` → 새 못 넷뿐 — `read_live`·`claim_boot`·
   `row_from_disk`·`force_boot_shape`·`set`은 무접촉). 단위 못
   `a_read_never_wipes_a_live_account_or_a_pending_ask`는 그대로 초록이다.
2. **`§5.3-6 스테이징 잔여물`은 선존이고 고치지 않았다 — 다음 라운드 후보다.**
   하네스는 마이그레이션 뒤 홈에 `.tmp-*`·`.old-*`가 **하나도 없기**를 요구하는데
   (`poc-chat-unify-migrate.mjs:1063·1069`), 구현은 M10 R2 §5-2에서 **일부러 한 세대를
   남기게** 바뀌었다(`migrate_v3::commit_dir` → `prune_old_generations`가 *지난* 세대만
   지운다). 그 결정의 근거가 주석에 있다: R1이 성공 직후 `.old-*`를 지워 사용자가 3.0에서
   만든 보드가 백업 없이 사라졌다(크리틱 S1·S2). 즉 **하네스의 기대가 낡았다.** 내 A/B에서
   대조군·HEAD 양쪽 다 같은 줄로 실패하고, AG2는 `migrate_v3.rs`를 한 줄도 안 만졌다.
   경계 밖(`scripts/poc-chat-unify-migrate.mjs`는 이 갈래 경계가 아니다)이라 **남의 게이트를
   조용히 완화하지 않았다** — 사실만 여기 적는다.
3. **`poc-chat-unify-migrate.mjs`의 `EXE`는 여전히 공용 `target/debug` 고정이다**(30행).
   병렬 갈래는 공용 `target/`에 못 지으므로, 돌리려면 R2가 한 것처럼 **가짜 ROOT**
   (`<TEMP>/x/scripts/…` + `<TEMP>/x/target/debug/ccg-migrate.exe`)를 만들면 된다 —
   스크립트 수정 0줄. `--exe=` 인자 하나가 이 우회를 없애지만 그 파일도 경계 밖이다.
4. **조회가 더 이상 「목록에 없는 행」을 걷어내지 않는다**(R1 §5-2의 되풀이). 크리틱이
   삭제 경로 넷을 감사해 구멍이 없음을 확인했다(`write_chats→retain` ·
   `remove_chat→forget_one` · `ma_save→dispose_removed_chats→forget_one` ·
   `Op::Dispose→clear_runtime`). 다만 **공짜였던 안전망은 사라졌다** — 앞으로 `clear_runtime`을
   빠뜨리면 그 유령은 프로세스가 죽을 때까지 남는다. 새 삭제 경로를 낼 때의 체크 항목이다.
5. **`ccg-auth` 테스트의 `unused Result` 경고 4건**은 옆 갈래 파일
   (`crates/ccg-auth/tests/critic_m11r2_token.rs`)이고 내 손이 안 닿았다. 워크스페이스
   테스트 로그에 그대로 있다.

## 11. R2가 만진 파일

| 파일 | 무엇 |
|---|---|
| `crates/ccg-store/src/status.rs` | `write_map` 분리 · `seed`(파일=사실/메모리=안전값, `dirty` 내림, `loaded` 세움) · `boot_load` 분리 + 병합 · 규약 4 한 문장 · 새 못 2 |
| `docs/renderer-divergence.md` | 522행 한 줄에 「첫 장전에서만」 한정(내 hunk만) |
| `docs/critic/acct-live-ag2r2.json` | 고친 exe 전 시나리오 주행(30항목 · findings 0) |
| `docs/parity-fix-ag2-r1.md` | 이 문서(§8~§11 추가 · §5-4 갱신) |

---

# R3 — 게이트가 네 번에 한 번 빨갛던 이유는 **자물쇠가 둘**이었기 때문이다

확인 크리틱 R2(`docs/critic/r28c-ag2-critic-r2.md`, 커밋 `25ab2f7`) 판정 **FAIL**.
겨눈 회귀(G2 조회 축·F1 재시작 축·G1 삭제 축·ask 축·마이그레이션 무손실)는 크리틱이
자기 손으로 지은 바이너리로 **전부 초록**임을 확인해 줬다. 붉은 것은 하나였다:
이 갈래가 R2에서 새로 박은 못 두 개가 `cargo test -p ccg-store`를 **9/37(24%)** 붉게 만들었다.

## 12. 최대 격차 — `CCG_HOME` 자물쇠 둘을 하나로 합친다

### 12-1. 뿌리(선존) — 서로를 모르는 뮤텍스 두 개

`CCG_HOME`은 **프로세스 전역**이다. 그런데 `ccg-store` 안에서 그 값을 지키는 자물쇠가 둘이었다.

| 자물쇠 | 쓰는 자 |
|---|---|
| `crates/ccg-store/src/lib.rs:248` `testkit::lock()` | `testkit::temp_home` — 이 크레이트 테스트 **대부분** |
| `crates/ccg-store/src/testhome.rs:29` `testhome::lock()` | `testhome::take` — `testhome::tests`의 스왑 못(그리고 남의 크레이트 전부) |

서로를 모르니, 스왑 못이 8스레드로 `set_var`/`remove_var`를 돌리는 창에 `temp_home`을 든
테스트가 **쓰기와 읽기 사이**로 들어가면 그 테스트는 **남의 홈을 읽는다**. 그래서 붉은
자리가 매번 달랐고(`migrate_v3` 재마이그레이션 2종·`talk::opting_a_board`), 전부 이 갈래가
안 만진 남의 테스트였다 — 다음 갈래는 자기가 안 쓴 코드에서 자기 탓을 찾게 된다.

R2의 몫은 **창을 벌린 것**이다: `temp_home`을 잡는 못 둘(`a_migration_freezes_the_screen…`·
`even_the_first_load_keeps_a_row…`)을 병렬 풀에 더 넣었다.

### 12-2. 고친 것 — 자물쇠를 버리고 `testhome::take` 위에 얹는다

`testkit::lock()`을 **지웠다**. `testkit::temp_home`은 이제 `testhome::take(tag)`가 주는
증표(`TestHome`)를 그대로 들고 있는다. 부수 효과 둘이 따라온다.

1. **홈 복원이 `remove_var`가 아니라 「원래 값으로」**가 된다. `testhome` 헤더가 M11 R3부터
   적어 둔 규약이다 — `remove_var` 창이 곧 `app_home()`이 **사용자 실홈**으로 떨어지는 창이다.
2. **캐시를 걷을 때도 비운다.** 세울 때만 비우던 `chats_v3`·`boards`·`legacy_bridge`·`status`
   전역 캐시를 `Home::drop`에서도 비운다(`forget_all`). 캐시가 홈보다 오래 살면 그 뒤의
   쓰기는 되돌아온 홈을 향한다.

겸해 `status::flush()`가 **목적지를 자물쇠 안에서 뜨게** 했다. 디바운스 배경 스레드
(`ensure_writer`)는 `set()` 500ms 뒤에 깨어나는데, 「dirty를 읽고 → 맵을 복사하고 → 파일을
쓰기」 사이에 그 홈이 걷히면 그 쓰기는 실홈을 향한다. `forget()`이 같은 자물쇠를 잡으므로,
경로를 자물쇠 안에서 뜨면 그 창이 닫힌다. (실측: 사용자 실홈 `~/.agentcodegui/chats-v3/`에는
지금도 `status.json`이 **없다** — 이 사고는 아직 안 났다. 창만 닫았다.)

### 12-3. 새 못 — 자물쇠가 하나임을 **결정적으로** 잰다

`testhome::tests::the_lock_is_one_lock_so_a_neighbour_cannot_swap_my_home`.
기존 스왑 못은 `take`끼리의 경합만 재서, 자물쇠가 둘인 동안 **영원히 초록**이었다.
새 못은 `temp_home` 증표를 든 채 옆 스레드가 `take`로 홈을 갈아끼울 수 있는지 잰다.

**이빨 확인(A/B)** — `git worktree add --detach %TEMP%\wt-ag2r3teeth 25ab2f7`에 이 못만 얹고
(=`lib.rs`는 자물쇠 둘인 판) 격리 `CARGO_TARGET_DIR`로 지어 돌렸다:

```
thread '…the_lock_is_one_lock_so_a_neighbour_cannot_swap_my_home' panicked at testhome.rs:144:
  ★ 자물쇠가 둘이다 — 남이 내 증표 위로 지나갔다
→ 두 자물쇠 판에서 붉음 5 / 5   (고친 판 0 / 160)
```

실패 방향이 한쪽뿐인 못이다: 옆 스레드가 안 깨어나면 **초록 쪽으로만** 틀린다.

### 12-4. 반복 계수 — 8/100 → **0/160**

`cargo test -p ccg-store --lib --no-run`으로 지은 **같은 테스트 바이너리**를 `%TEMP%`에
복사해 반복 실행했다(빌드 노이즈 없이 경합만 센다).

| 판 | 붉은 주행 |
|---|---|
| 대조군 `25ab2f7`(자물쇠 둘) | **8 / 100 (8%)** |
| **HEAD(자물쇠 하나)** | **0 / 100** |
| HEAD, 마무리 정리 뒤 다시 | **0 / 60** |
| HEAD, 직렬 `--test-threads=1` | **0 / 5** |

대조군에서 붉었던 자리는 크리틱이 지목한 그 둘이다(`remigration_still_brings_in_a_chat_created_in_2_6_2_afterwards` 4회 ·
`remigration_never_overwrites_a_record_that_3_0_kept_writing` 4회). 크리틱의 24%와 내 8%가
다른 것은 기계 부하 차이다 — **결함의 존재와 소멸**은 양쪽에서 같다.

## 13. 곁다리 1 — 「파일에는 마지막 사실이 남는다」에 한정을 붙였다

크리틱 §6이 실 exe로 잰 사실: 그 문장은 **마이그레이션 프로세스 한정**이다. 앱 안에서는
옆 채팅의 턴 한 번이 `dirty`를 세우고 디바운스 `flush()`가 **메모리 맵 전체**(=규약 4의
안전값)를 쓰므로, 얼어붙은 `working`은 첫 턴에 `idle`로 덮인다.

프로세스 안에서 그대로 재현해 못으로 박았다 —
`status::tests::the_frozen_fact_outlives_the_migration_but_not_the_first_turn`:

```
① seed 직후 + 마무리 flush   status.json = {"c-run":"working"}   ← 마이그레이션 프로세스
② set("c-live") + flush      status.json = {"c-live":"done","c-run":"idle"}  ← 앱의 첫 턴
③ 다음 장전                   화면 = idle  (읽는 쪽이 다시 얼린다 — 화면 피해 0)
```

크리틱 말대로 **고치지 않았다**(영구히 참으로 만들려면 행마다 「아직 살지 않은 값」을 따로
들어야 한다 — 비용이 이득보다 크고, 그 차이를 재는 자는 무손실 하네스 하나뿐이다).
대신 규약 4 헤더에 한정을 명시하고, 못이 그 문장을 지킨다: 누군가 수명을 늘리면 **이 못이
붉어져** 헤더도 같이 고치라고 말한다.

## 14. 곁다리 2 — `poc-acct-live`의 A 축이 **시계** 때문에 붉었다

내 첫 전체 주행에서 A 축이 2건 붉었다(`{"status":"idle","account":null}` = 턴 **전** 값).
`sendTurn` 뒤가 `sleep(3500)` **고정**이었기 때문이다. A 축 단독으로 다시 재니
내 판 3/3 초록 · 대조군(`target-critag2`, 수정 전 exe) 3/3 초록 — **못이 아니라 시계**다.

이 라운드의 주제가 「실행 방식에 따라 답이 갈리면 게이트가 아니다」이므로 같이 고쳤다:
`waitTurn(app, chatId, mark)` — ① 이 턴이 만든 새 REPLACE가 왔고 ② 그 행에 계정이 실렸고
③ 상태가 `working`/`analyzing`이 아닐 때까지 기다린다(상한 25s). 상한을 넘으면 **옛 판과
똑같이 그 시점 값으로 단정한다** — 기다림이 단정을 무르게 만들지 않는다.

**이빨 확인** — 고친 하네스를 G2 수정 **전** exe(`target-critacct3` = `5e1dae7`)에 물렸다:

```
X F-조회 응답     c-a = {"status":"done","account":null}   ← 조회 한 번이 계정을 지웠다
X F-다음 REPLACE  c-a = {"account":null}                    (c-b는 살아 있다)
X F-칩(조회 후)   ["사용 중 · 첫 채팅"] → []
o F-런타임 생존   [{"c-a",pid:7804,"Idle"},{"c-b",pid:13332,"Idle"}]  ← 살아 있는데 지웠다
→ 3 FAIL. 리포트: docs/critic/acct-live-ag2r3ctl.json
```

## 15. R3 검증 — 크레이트별로 따로 셈

| 항목 | 실측 |
|---|---|
| `cargo test -p agentcodegui` | **145 / 0** |
| `cargo test -p ccg-auth`(net 없음) | **102 / 0**(워크스페이스 통합 시 lib 94 + 통합 25 = 119) |
| `cargo test -p ccg-engine` | **207 / 0** |
| `cargo test -p ccg-fs` | **100 / 0** |
| `cargo test -p ccg-lsp` | **59 / 0** |
| `cargo test -p ccg-store` | **89 / 0** (R2의 87 + 새 못 2) · **반복 0/160** |
| `cargo test --workspace --no-fail-fast` | **719 / 0**(바이너리별 합산으로 검산) |
| `npm run typecheck` + `typecheck:app` | **3종 초록** |
| `poc-acct-live`(실 exe, 전 시나리오) | **30 / 30 · findings 0** — 2회 연속(`docs/critic/acct-live-ag2r3.json`) |
| `poc-store-fanout` · `poc-acct-store` | 전부 통과 / 전부 통과 |
| `poc-chat-unify-migrate`(가짜 ROOT, 스크립트 수정 0줄) | 픽스처 **실패 1** · 부하 픽스처 **실패 1** · 얼어붙은 홈 **실패 1**(전부 선존 `§5.3-6 잔여물`) |
| 얼어붙은 홈 디스크 A/B | `status.json {c-run:"working", c-ana:"analyzing"}` = 레코드와 일치 · `account`/`panelId` 키 **0** |
| `ccg-migrate` 빌드 경고 | **0** |

`ccg-store` 게이트가 「불러 달라고 할 때마다 같은 답을 준다」는 것이 이 라운드의 산출물이다.

## 16. R3가 안 한 것 · 남은 리스크

1. **`ccg-auth`의 `m11r4_store_cas::a_lock_unaware_neighbour_cannot_undo_a_logout`은 그대로
   둔다.** 크리틱이 1/5로 붉다고 적은 못이다. 내 판에서 **단독 10주행 0붉음**이라 재현을
   못 했고, 그 바이너리 안에는 자물쇠가 하나뿐이라(`ccg_store::testhome::take` 단독)
   이번 뿌리와 **다른 결함**이다 — 잠금 모르는 이웃 대 CAS의 실제 경합(제품 쪽)일 가능성이
   높다. 경계 밖(`crates/ccg-auth/`)이라 손대지 않았다. 다음 갈래 후보.
2. **`ccg-auth::testkit::lock()`은 세 번째 자물쇠로 남아 있다**(`crates/ccg-auth/src/testkit.rs:10`).
   그 바이너리(`ccg-auth` lib 테스트)의 `src/`는 `testhome::take`를 안 쓰므로 **지금은**
   자물쇠가 하나뿐이고 안전하다. 다만 누군가 `ccg-auth`의 `src/` 테스트에서
   `ccg_store::testhome::take`를 부르는 순간 오늘의 24%가 그 크레이트에서 재현된다.
   `testhome.rs` 헤더 규약에 그 문장을 박아 뒀다("크레이트 안에 자물쇠는 하나뿐이다").
3. **「파일의 마지막 사실」 수명은 늘리지 않았다**(§13). 화면 피해 0 · 게이트 초록 ·
   문서와 못이 사실대로 말한다.
4. **`§5.3-6 스테이징 잔여물`은 여전히 선존 실패다.** R2 §10-2 그대로 — 하네스의 기대가
   구현(일부러 한 세대를 남긴다)보다 낡았다. 남의 게이트를 조용히 완화하지 않았다.
5. **`poc-acct-live`의 나머지 고정 `sleep`은 안 건드렸다.** 손댄 것은 `chat:status`를
   표집하는 여섯 자리뿐이다. 스레드 텍스트를 읽는 자리(B·C)와 「턴을 **안** 보낸다」가
   본질인 자리(E의 `sleep(4000)`)는 고정 대기가 곧 단정이라 그대로 뒀다.

## 17. R3가 만진 파일

| 파일 | 무엇 |
|---|---|
| `crates/ccg-store/src/lib.rs` | `testkit::lock()` 삭제 → `testhome::take` 위에 얹음 · `forget_all()`(세울 때·걷을 때) |
| `crates/ccg-store/src/testhome.rs` | 헤더에 「크레이트 안에 자물쇠는 하나」 규약 + 실측 이력 · 새 못 1 |
| `crates/ccg-store/src/status.rs` | `flush()`가 목적지를 자물쇠 안에서 뜬다(`write_map_to`) · 규약 4에 수명 한정 · 새 못 1 |
| `scripts/poc-acct-live.mjs` | `waitTurn`/`stMark` — 턴 표집 여섯 자리의 고정 `sleep` 제거 |
| `docs/critic/acct-live-ag2r3.json` | 고친 exe 전 시나리오(30/30 · findings 0) |
| `docs/critic/acct-live-ag2r3ctl.json` | 고친 하네스의 이빨 확인(수정 전 exe에서 3 FAIL) |
| `docs/parity-fix-ag2-r1.md` | 이 문서(§12~§17) |
