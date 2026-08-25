# R28i OPENDIR R1 — 「이미 떠 있는 앱」에 폴더가 오면, 이제 도착한다

라운드: R28i OPENDIR R1 · 2026-08-26 · `feature/3.0.0-beta`
근거 문서: `docs/critic/final-parity-r5.md` §3.3 · §9.1(`N3` · **높음**) ·
`docs/critic/r28e-audit-critic-r1.md` §3.2(중간 → 높음으로 올린 근거)
경계: `src-tauri/src/main.rs` · `src-tauri/src/tray.rs`(=`win::tray`) ·
`src-tauri/src/ipc/{mod,app_meta}.rs` · `app/src/App.tsx` · `app/src/api/shim.ts` ·
`docs/renderer-divergence.md` §6.11 · `scripts/poc-opendir.mjs`(새 하네스) · 이 문서

> 이 라운드가 닫는 것은 **한 동작**이다: 트레이에 숨어 있는(=정상 상태인) 3.0에서
> 폴더를 우클릭해 「AgentCodeGUI3으로 열기」를 누르는 것. R28h까지 그것은 **창만 앞으로
> 오고 폴더는 조용히 사라지는** 동작이었다. 이제 **123~142ms 만에 도착하고**, 열 수 없는
> 경로가 오면 **화면이 사유를 말한다.**

## 0. 한 문단

`main.rs`의 단일 인스턴스 관문이 `win::tray::raise_existing()`을 부른 뒤 그냥 `return`했다
— 그 자리가 명령줄의 폴더 인자를 버리는 자리였다. 렌더러는 **이미 구독하고 있었고**
(`App.tsx`의 `onOpenDirectory`), 방출자만 0이었다. 깨우는 통로가 등록 윈도우 메시지
**브로드캐스트**라 봉투에 경로를 못 싣는다(정수 둘뿐 · `WM_COPYDATA`는 브로드캐스트 불가).
그래서 두 번째 인스턴스가 앱 홈 아래 `.pending-open-dir`에 `{path, at}`를 원자 저장한 **뒤**
브로드캐스트하고, 먼저 뜬 인스턴스가 창을 세운 **뒤** 그것을 소비한다(읽으면 지운다 · 15초
TTL). 판정(`fs::metadata` 한 번)은 전용 스레드/블로킹 풀에서 돈다 — 그 한 번이 도달 불가
UNC에서 21초이기 때문이다. 성공 페이로드는 2.6.2와 글자 그대로 같고(문자열 하나), 실패는
2.6.2에 아예 없던 통지라 계약면 밖 3.0 전용 채널로 나가 `NoticeModal` 카드가 된다.

---

## 1. 무엇이 틀렸나 (수정 전 · 내 대조군 실측)

`main.rs:169-177`:

```rust
let Some(_lock) = acquire_home_lock() else {
    win::tray::raise_existing();
    return;                      // ← 폴더 인자를 여기서 버린다
};
```

대조군 exe(**R28h가 오늘 23:18에 구운 수정 전 릴리스** ·
`target-r28h-m10-critr2/release/agentcodegui.exe`)에 같은 하네스를 두 번 돌린 결과:

```
warm(창이 보이는 상태) 두 번째 실행 + 폴더 → 9,097ms / 9,001ms 대기 → chat-head "폴더 선택" 그대로
warm(트레이에 숨은 상태)                    → raise는 된다(보이는 창 1→0→1) · 폴더는 안 온다
파일 인자 / 없는 경로                        → 카드 0장 (침묵)
raw app:open-directory(T3 / "" / "C:\Code") → {"__unimplemented":true} ×3
cold(앱이 꺼져 있을 때 폴더 인자)            → 도착한다 (감사의 「콜드는 된다」와 일치)
```

두 주행 동일. **감사·크리틱이 적은 그대로다.**

---

## 2. 무엇을 고쳤나

### 2.1 인계 — 파일 + 브로드캐스트 (순서가 규약)

| 자리 | 하는 일 |
|---|---|
| `main.rs`(두 번째 인스턴스) | `open_dir::stash_from_args()` → **그 다음** `raise_existing()`. 반대면 첫 인스턴스가 아직 없는 파일을 읽는다 |
| `main.rs`(첫 인스턴스 · 콜드) | `open_dir::clear_stale()` — 먼젓번 주행의 **잔해만** 턴다(신선한 것을 지우면 잠금 경쟁에 걸린 형제의 폴더가 조용히 사라진다) |
| `win::tray`의 raise 수신부 | `show_main()` **뒤에** `open_dir::deliver_pending()` — 숨어 있던 창이 먼저 서야 카드가 보이는 화면에 앉는다 |
| `ipc/app_meta.rs` `open_dir` | 판정(`classify`) · 인계 읽기/쓰기 · 방출(`request`) |
| `ipc/mod.rs` `ipc_call` | `app:open-directory` 원시 호출을 **전용 블로킹 풀**로 (UNC 21초 함정) |

인계 파일은 **앱 홈 아래**다 — `raise_existing()`의 메시지 이름이 홈 해시인 것과 같은 규약이라
격리 홈(dev·벤치·하네스)끼리 안 섞인다.

### 2.2 판정 — 실패에 이름을 준다

```rust
match std::fs::metadata(&abs) {
    Ok(m) if m.is_dir() => Verdict::Ok(abs),   // 절대 경로로 다듬어서
    Ok(_)               => Verdict::NotADir,   // 부모로 올리지 않는다(§2.3)
    Err(e) if e.kind() == PermissionDenied => Verdict::Denied,
    Err(_)              => Verdict::NotFound,
}
```

성공은 `app:open-directory`(문자열 하나 — 2.6.2와 동일), 실패는
`app:open-directory-failed`(`{path, reason}` — **계약면에 없는 3.0 전용 셸 채널**).
문구는 렌더러가 고른다(i18n이 거기 있다):

| reason | 카드 본문(ko) |
|---|---|
| `not-a-dir` | ‘…’ 은(는) 파일이에요. 작업 폴더로는 폴더만 열 수 있어요 — 그 파일이 든 폴더를 우클릭해 주세요. |
| `not-found` | ‘…’ 경로를 찾을 수 없어요. 폴더가 옮겨졌거나 지워졌을 수 있어요. |
| `denied` | ‘…’ 을(를) 열 권한이 없어요. 폴더 접근 권한을 확인해 주세요. |
| `empty` | 열 폴더 경로가 비어 있어요. |

### 2.3 안 한 것 둘

- **파일 인자를 부모로 올리지 않는다.** 사용자가 안 고른 자리에 조용히 착지하는 것이고,
  콜드 런치(`parity::misc::initial_dir`)는 파일을 그냥 무시하므로 두 경로의 착지가 갈린다.
- **N8(앱 자동 업데이트 3채널)은 손대지 않았다** — 사용자가 범위 밖으로 선언했다.
  우클릭 메뉴 등록(`nsis/hooks.nsh`)도 **읽기만** 했다(항목 0개 추가).

### 2.4 다듬기 — 콜드 부팅의 청소가 **잔해만** 턴다 (같은 라운드 · 커밋 둘째)

첫 커밋의 `clear_pending()`은 인계 파일을 **무조건** 지웠다. 좁지만 실재하는 경쟁이 하나
남는다: A가 잠금을 딴 직후 B가 잠금에 실패해 인계를 남기는 창. 거기서 무조건 삭제면
**B가 들고 온 폴더가 조용히 사라진다** — 이 라운드가 없애려는 바로 그 모양이다.
`clear_stale()`은 TTL을 넘긴 것만 지우고, 신선한 인계는 raise 수신부가 소비하거나
아무도 안 받으면 스스로 만료된다. 못 하나가 지킨다
(`clear_stale_drops_the_old_one_and_keeps_a_fresh_one`).

---

## 3. 실측 (판정 exe 3주행 · 대조군 2주행 · 같은 하네스)

`node scripts/poc-opendir.mjs --tag=r1 --port=10800` / `--tag=r2 --port=10804` / `--tag=r3 --port=10800`(§2.4 다듬기 뒤)
대조군: `--tag=ctl --port=10802 --exe=…r28h-m10-critr2…` / `--tag=ctl2 --port=10806`
결과 파일: `docs/critic/opendir-{r1,r2,r3,ctl,ctl2}.json`

| 잣대 | 대조군(수정 전) | **판정 exe** |
|---|---|---|
| 웜(창이 보임) 폴더 도착 | **false** · 9,097 / 9,001ms 대기 후에도 `폴더 선택` | **true · 123 / 126 / 121ms** · chat-head = 그 폴더 |
| 웜(트레이에 숨음) raise | true (보이는 창 1 → 0 → 1) | true (1 → 0 → 1) |
| 웜(트레이에 숨음) 폴더 도착 | **false** (9,104 / 9,001ms) | **true · 142 / 130 / 142ms** |
| `onOpenDirectory` 이벤트 수신 | 0건 | **유효한 4건만**(무효 인자에는 이벤트가 안 간다) |
| 파일 인자 → 카드 | **없음(침묵)** | **뜬다** · 「폴더를 열지 못했어요」 + 파일 사유 · chat-head **불변** |
| 없는 경로 → 카드 | **없음(침묵)** | **뜬다** · 경로 사유 · chat-head **불변** |
| 인자 **없는** 재실행 | 무변화 | **무변화**(인계는 소비 1회 — 직전 폴더가 되살아나지 않는다) |
| 인계 파일 잔존 | — | **false**(소비됐다) |
| `raw app:open-directory(T3)` | `{"__unimplemented":true}` | `{"ok":true,"dir":"…proj-raw"}` · 화면에 착지 |
| `raw app:open-directory("")` | `{"__unimplemented":true}` | `{"ok":false,"reason":"empty","path":""}` · 카드 |
| `raw app:open-directory("C:\Code")`<br>(감사가 부른 것과 **같은 호출**) | `{"__unimplemented":true}` | `{"ok":true,"dir":"C:\\Code"}` · chat-head = `C:\Code` |
| 콜드(폴더 인자로 기동) | true | **true** · 기동부터 953ms |
| **같은 착지**(웜 성공 = 콜드 성공) | false | **true** |

계약면 스캔(`node docs/critic/tools/critic-r28e-channels.mjs`):

```
수정 전: total 216 · impl 206 · commentOnly 0 · missing 10
수정 후: total 216 · impl 207 · commentOnly 0 · missing  9   ← openDirectory가 빠졌다
남은 9 = talk 여섯(M10) + app 셋(update-check · update-install · update-event = N8 · 범위 밖)
```

**총 채널 수 216은 안 움직였다** — 실패 통지는 계약면(`src/shared/protocol.ts`)에 넣지 않았다.

게이트:

```
npm run typecheck:node  초록
npm run typecheck:web   초록
npm run typecheck:app   초록
cargo test 크레이트별 (전부 0 failed):
  agentcodegui 170 (= 이 트리의 기존 164 + 내 6)   ccg-auth 126   ccg-fs 101
  ccg-engine  251 (추적분 233 + 남의 미추적 프로브 18)  ccg-lsp  59   ccg-store 92
  새 못 6: dir_wins_and_file_is_named · candidate_matches_the_cold_rule_and_keeps_the_bad_one
           handoff_is_consumed_once · stale_handoff_is_dropped · clear_stale_drops_the_old_one_and_keeps_a_fresh_one
           broken_handoff_does_not_linger
```

> 지시서의 기준선(`agentcodegui 161` · `ccg-auth 125` · `ccg-store 90~91`)보다 큰 것은
> **내 라운드가 시작된 뒤 옆 갈래가 착지시킨 못들** 때문이다(`agentcodegui` 기준선은
> 내 트리에서 164 — `cargo test -p agentcodegui … open_dir`가 「6 passed · 164 filtered out」).

---

## 4. 정직하게 남기는 것 셋 — ⚠️ **셋 다 §6에서 정정·폐기됐다**

> 아래 세 줄은 **수정 전(`6028521`)의 상태 기록**으로만 남긴다. 확인 크리틱 R1이
> ①을 「이 라운드의 최대 격차」로 승격시켰고(D1), ②를 D2·D3으로 쪼갰다.
> **①의 마지막 문장은 사실 자체가 틀렸다** — 아래 §6.1의 실측을 보라.

1. ~~**`denied`는 Windows에서 사실상 안 뜬다.**~~ 실측: 폴더에 `icacls /deny`를 걸어도
   Rust `std::fs::metadata`는 성공한다(속성 조회 폴백) → `Ok`로 판정돼 그 폴더가 열린다
   (`{"ok":true,…}` · chat-head에 앉는다). ~~같은 폴더에 Node의 `statSync`는 `ENOENT`를
   던진다 — 즉 2.6.2였다면 **조용히 버려졌을** 인자다.~~ ← **틀렸다.** Node의
   `statSync`도 **성공한다**(`isDirectory()===true` · §6.1 실측). 던지는 것은
   `readdirSync`다. 즉 2.6.2도 이 폴더를 **열었다** — 2.6.2 파리티가 아니라 **버그의 승계**였다.
2. ~~**실패 통지는 웜 경로에만 있다.**~~ → §6.3에서 콜드에도 붙었다.
3. **경로 다듬기가 한 칸 다르다.** → §6.3에서 콜드가 웜에 맞춰졌다(둘 다 절대 경로).

---

## 6. 확인 크리틱 R1 수정 라운드 1 — D1~D5

판정문: `docs/critic/r28i-opendir-critic-r1.md`(불합격 · 커밋 `837ae19`).
크리틱이 **닫혔다고 인정한 것**(웜 도착 3/3 · 트레이 숨김 3/3 · 콜드↔웜 다섯 칸 · 계약면
10→9 · 무회귀 대부분)은 여기서 다시 논하지 않는다. 아래는 **실패시킨 칸만**이다.

계기는 새로 만들었다 — `scripts/poc-opendir-crit.mjs`(D1~D5 전용). 기존
`scripts/poc-opendir.mjs`(체크리스트용)는 그대로 두고 둘 다 돌린다.

### 6.0 A/B — 같은 계기 · 같은 픽스처 · 수정 전 exe는 크리틱이 판정한 그 커밋

| | 수정 전 | 수정 후 |
|---|---|---|
| 커밋 | `6028521` (크리틱 판정 대상) | 이 커밋 |
| exe sha256 | `c78dfbd45f86ccb8d4de14fa263b544f5292f3a517cac2a4770a41296f2b5764` | `4b8eafdf8d740ff30de8e1a04954017bfc5c7114f48a71e027a07dc21ba5f75a` |
| 결과 | `docs/critic/opendir-crit-ctl6028521.json` | `docs/critic/opendir-crit-fixr1.json` |

수정 전 exe는 **다시 굽지 않고** 그 커밋이 남긴 `target-r28i-od\release\agentcodegui.exe`를
그대로 복사했다(sha256이 크리틱 §1.1의 「빌더의 exe `c78dfbd4…`」와 일치한다 — 진짜 그 exe다).
같은 타깃에 다시 구우면 그게 사라지므로 **복사 먼저** 했다(함정 9의 반대 방향 — 대조군을
다시 굽지 않고 원본을 보존한 것이라 「거짓 초록」이 생길 자리가 없다).

deny ACL 픽스처가 진짜로 걸렸는지는 **Node로 교차 확인**한다(`aclProbe`):
두 주행 모두 `listable=false, statable=true` — 즉 **못 읽는데 stat은 되는** 그 폴더가 맞다.

| 칸 | 수정 전 (`6028521`) | 수정 후 |
|---|---|---|
| **D1** 웜 · 못 읽는 폴더 | 카드 **없음**(9,052ms 대기) · **그 폴더로 착지** · 탐색기 `비어 있음`(0행) | 카드 **110ms** · **착지 안 함** · chat-head 불변 · 탐색기는 이전 폴더 그대로(`alpha_dir`·`AAA_alpha.txt` 2행) |
| **D1** 콜드 · 못 읽는 폴더 | 카드 없음 · **그 폴더로 착지** | 카드 · 착지 안 함(chat-head `폴더 선택`) |
| **D1** 원시 호출 | `{"ok":true,"dir":"…\Denied"}` | `{"ok":false,"reason":"denied","path":"…\Denied"}` |
| 빈 폴더(과잉 차단 감시) | 열린다 · `비어 있음` | **열린다** · `비어 있음` (**안 바뀜** — "빈 것"과 "못 보는 것"을 가른다) |
| **D2** 경주 +30ms | 착지 **안 함** · 인계 **잔존** | **착지**(439ms) · 잔해 0 |
| **D2** 경주 +150ms | 착지 **안 함** · 인계 **잔존** | **착지**(325ms) · 잔해 0 |
| **D2** 경주 +330ms | 착지 **안 함** · 인계 소비됨(방출만 버려짐) | **착지**(328ms) · 잔해 0 |
| **D2** 경주 +600 / +900ms | 착지(116 / 1ms) | 착지(216 / 111ms) |
| **D2** 납치(신선한 인계 + **인자 없는** 재실행) | **`hijacked=true`** — cwd가 `…\ProjB`로 끌려감 · 인계 소비됨 | **`hijacked=false`** · chat-head 불변 · **인계는 그대로 남아 있다**(안 걷었다는 증거) |
| 그 뒤 **진짜** 열기 | 착지 | 착지(1ms) — 문을 닫아도 정상 경로는 안 막힌다 |
| **D3** 콜드 · 파일 인자 | 침묵 | 카드("‘…a-file.txt’ 은(는) 파일이에요…") |
| **D3** 콜드 · 없는 경로 | 침묵 | 카드("‘…’ 경로를 찾을 수 없어요…") |
| 콜드 · **정상** 폴더 | 착지(863ms) | 착지(878ms) — 안 망가졌다 |
| **D4** 공백만(`"   "`) | 침묵(9,030ms 대기) | 카드 **109ms**("열 폴더 경로가 비어 있어요.") |
| **D5** 겹친 두 번(A→B) | 끝 상태 B | 끝 상태 B (**안 고쳤다** — §6.5) |

### 6.1 D1 — 「폴더다」를 `metadata`로 물으면 Windows가 거짓말을 한다

크리틱이 최대 격차로 꼽은 칸이다. `classify()`가 `fs::metadata` 한 번으로 판정했는데,
**Windows에서는 부모를 읽을 수만 있으면 deny ACL이 걸린 폴더에도 `metadata`가 성공한다**
(속성이 부모의 디렉터리 엔트리에서 온다). `Verdict::Denied`가 사실상 도달 불가였고,
그 폴더가 작업 폴더가 되어 탐색기가 `비어 있음`이라고 **사실이 아닌 것**을 적었다.

`rustc`로 판을 하나 짜서 잣대를 골랐다(레포 밖 `C:\Temp\odfix\probe.rs`):

```text
                       metadata      is_dir   read_dir
 Denied(deny ACL)      Ok(true)      true     Err PermissionDenied (os error 5)   ← 여기만 갈린다
 Empty(빈 폴더)         Ok(true)      true     Ok · 첫 항목 None
 Normal                Ok(true)      true     Ok · 첫 항목 Some("a.txt")
 C:\                   Ok(true)      true     Ok
```

같은 폴더에 **Node도 똑같다**: `fs.statSync().isDirectory()`는 `true`, `fs.readdirSync()`는
던진다. 즉 §4-①이 「2.6.2였다면 조용히 버려졌을 인자」라고 적은 것은 **틀렸다** — 2.6.2도
이 폴더를 열었다. 이 칸은 파리티가 아니라 **버그의 승계**였고, 이제 3.0이 먼저 끊는다.

고친 것: `classify`가 폴더로 판정한 **직후** `read_dir`을 한 번 더 본다(값은 안 읽는다 —
`FindFirstFileW` 한 번). 못 열면 `Denied`(사라졌으면 `NotFound`). 도달 불가 UNC는 그 앞
`metadata`에서 이미 걸러지므로 **UNC 21초에 더하는 시간은 0**이다.

못 둘을 박았다(R1의 못은 `Denied`를 **문자열 이름표로만** 확인해 이 칸을 못 잡았다):
- `a_dir_we_cannot_list_is_denied_not_opened` — 「목록을 못 열더라」를 **주입**해 배선을
  고정한다(ACL 없이도 언제나 돈다). **빈 폴더는 `Ok`** 임을 같은 못이 지킨다.
- `a_real_deny_acl_folder_is_denied` — 진짜 `icacls`로 건다. 이 기계에서 그 가지가 실제로
  실행되는 것을 임시 `assert!(applied)`로 확인한 뒤 되돌렸다.

### 6.2 D2 — 부팅 창의 침묵과, 그 잔해의 납치

두 갈래였고 둘 다 닫았다.

**(a) 늦게라도 착지한다.** R1은 raise 신호를 받자마자 인계를 소비했다. 기동 후 0.3~0.8초
창에서는 렌더러가 아직 `listen()` 전이라 방출이 통째로 버려졌다(대조군 +330ms 줄: 인계는
소비됐는데 착지는 안 함). 더 이른 창(+30·+150ms)은 raise 리스너 자체가 안 붙어 신호가
유실됐다(인계 **잔존**). 이제 **듣는 사람이 없으면 안 걷는다**(`pending_for_delivery`) —
남겨 두면 렌더러의 첫 조회(`app:get-initial-dir`)가 걷는다(`initial_dir` ③).
그 조회가 신호인 이유와 왜 §3.3의 공백을 안 밟는지는 `docs/renderer-divergence.md` §6.11.2.

**(b) 인자 없는 재실행은 인계를 안 걷는다.** 봉투(`WPARAM`)에 경로는 못 실어도 **1비트는
실린다**: `stash_from_args()`의 결과를 `raise_existing(with_handoff)`로 넘기고 수신부는
`WPARAM == 1`일 때만 `deliver_pending`을 부른다.

납치는 **신선한 인계를 손으로 심어** 결정적으로 쟀다(경주 잔해에 기대면 15초 TTL과
경쟁한다 — 실제로 대조군의 +30ms 잔해는 20초 뒤 재실행 시점에 이미 만료돼 있었다).
결과: 수정 전 `hijacked=true`(cwd가 `…\ProjB`로), 수정 후 `hijacked=false`이고
**인계 파일이 그대로 남아 있다** = 걷지 않았다는 직접 증거다.

못: `a_handoff_is_not_taken_before_anyone_is_listening`(안 들으면 파일이 남고, 듣기
시작하면 그때 걷힌다).

### 6.3 D3 — 콜드 런치도 말한다 (그리고 콜드가 웜에 맞춰졌다)

R1은 「부팅 중 방출은 렌더러 `listen()` 등록보다 앞설 수 있다」를 이유로 범위 밖에 뒀다.
그 벽은 **방출을 안 하면 없다**: 콜드의 답은 `app:get-initial-dir`의 **응답**으로 가고,
렌더러가 물었으니 이미 듣고 있다. 그래서 실패 통지도 그 순간에 붙일 수 있다.

`app:get-initial-dir`를 `app_meta::dispatch`의 한 줄에서 `ipc_call`의 **블로킹 팔**로
내리고 `open_dir::initial_dir(&app)`이 받는다. 「어느 인자가 폴더인가」의 잣대는 그대로
`parity::misc::initial_dir`(2.6.2 `openedDirFromArgv` 자리)이 고른다 — 두 반쪽이 같은 인자를
고르게. 더한 것은 정직함뿐이다(그 답을 `classify`로 한 번 더 거른다).

곁가지로 두 칸이 웜에 맞춰졌다:
- 콜드의 **상대 경로**가 절대 경로로 다듬어진다(§4-③이 남긴 차이가 없어졌다).
- 콜드에 **도달 불가 UNC**가 오면 21초를 자는데, R1까지 그것은 **async 워커**에서 잤다 —
  그동안 모든 창의 IPC가 굶었다. 이제 `app:open-directory`와 같은 블로킹 풀이다.

### 6.4 D4 — 공백만 있는 인자

`take_pending()`이 `trim()` 후 빈 문자열을 `None`으로 떨어뜨려 `Verdict::Empty`가 인계
경로에서 도달 불가였다. 판정을 **`classify` 한 곳으로** 모으고 `take_pending`은 값을 그대로
들고 온다. 못: `a_blank_handoff_still_has_a_reason`.

### 6.5 D5 — 안 고친다 (근거)

겹친 두 번(A 직후 B)에서 앞의 것은 인계가 덮여 사라진다. 2.6.2는 둘 다 순서대로 적용하지만
**끝 상태는 같은 B**다(실측: 수정 전·후 모두 B). 인계를 큐로 만들면 A가 잠깐 스쳤다 B로
바뀌는 깜빡임이 생길 뿐 사용자가 보는 결과는 안 바뀐다 — 크리틱도 「기록만 남긴다」로 뒀다.

### 6.6 게이트

| 잣대 | 값 |
|---|---|
| **체크리스트 하네스 재주행**(`poc-opendir.mjs` · `docs/critic/opendir-fixr1.json`) | 웜(창 보임) **124ms** · 트레이 숨김 **1→0→1 · 137ms** · 파일/없는 경로 카드 · 인자 없는 재실행 무변화 · 콜드와 **같은 착지**(`sameLanding=true`) · `raw app:open-directory("C:\Code")` = `{ok:true,dir}` — **닫혔던 칸은 그대로 닫혀 있다** |
| `cargo test -p agentcodegui` | **174 passed · 0 failed**(수정 전 170 → **+4**: D1 둘 · D2 하나 · D4 하나) |
| 계약면 스캐너 `critic-r28e-channels.mjs` | total **216** · impl **207** · missing **9** — **안 움직였다**(`app:get-initial-dir`는 자리를 옮겼을 뿐 여전히 impl) |
| typecheck | node · web · app **3종 초록** |
| 원시 호출 | `denied`/`empty`는 `{ok:false,reason}`, 빈 폴더는 `{ok:true}`, `get-initial-dir`는 인자 없는 프로세스에서 `null` |

### 6.7 남은 리스크 (정직하게)

- **`RENDERER_READY`는 `app:get-initial-dir` 하나에 걸려 있다.** 렌더러가 하이드레이션에서
  영원히 못 나오면 그 신호가 안 켜지고, 부팅 창에 온 인계는 15초 TTL로 사라진다(R1과 같은
  결과 · 더 나빠지진 않는다). 납치는 그래도 불가능하다 — (b)의 1비트가 따로 막는다.
- **첫 인스턴스가 죽은 뒤 15초 안에** 인자 없이 다시 켜면, 죽기 전에 못 받은 인계를 새
  렌더러가 걷는다. 사용자가 몇 초 전에 실제로 요청한 폴더라 **의도된 착지**로 본다(TTL이
  그 경계다). 15초를 넘긴 것은 `clear_stale`이 부팅 때 턴다.
- `read_dir`은 **목록 열기 권한**만 본다. 안의 개별 파일이 못 읽히는 폴더는 그대로 열린다 —
  그건 폴더를 여는 일의 문제가 아니라 파일을 읽는 일의 문제라 여기서 판정하지 않는다.

## 5. 다음 사람이 다시 재는 법

```
node scripts/poc-opendir.mjs --tag=<태그> --port=<10800+>            # 판정 exe
node scripts/poc-opendir.mjs --tag=<태그>ctl --port=<+2> --exe=<수정 전 exe>
node docs/critic/tools/critic-r28e-channels.mjs                      # missing 9인가
```

하네스는 실홈을 한 바이트도 안 만진다(`bench/fixture.mjs`와 달리 `accounts.json`을
**복사조차 안 한다**), 죽이는 것은 자기가 스폰한 PID뿐이다.
