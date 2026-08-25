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

## 4. 정직하게 남기는 것 셋

1. **`denied`는 Windows에서 사실상 안 뜬다.** 실측: 폴더에 `icacls /deny`를 걸어도
   Rust `std::fs::metadata`는 성공한다(속성 조회 폴백) → `Ok`로 판정돼 그 폴더가 열린다
   (`{"ok":true,…}` · chat-head에 앉는다). 같은 폴더에 Node의 `statSync`는 `ENOENT`를 던진다
   — 즉 2.6.2였다면 **조용히 버려졌을** 인자다. 사유 코드 자체는 단위 테스트가 못을 박고
   있고, `metadata`가 진짜로 거절당하는 경로(상위 traverse 거부 등)에서는 카드가 뜬다.
2. **실패 통지는 웜 경로에만 있다.** 콜드 런치에서 잘못된 인자가 오면 R28h까지와 똑같이
   조용하다(= 2.6.2와 동일). 부팅 중에 이벤트를 쏘면 렌더러 `listen()` 등록보다 앞설 수 있어
   (`docs/renderer-divergence.md` §3.3) 「가끔 안 뜨는 카드」가 된다 — 조회 채널을 하나 더
   만들어야 하는 일이고, N3이 가리키는 사고(정상 상태인 **웜** 경로의 침묵)와는 다른 자리다.
3. **경로 다듬기가 한 칸 다르다.** 웜은 상대 경로를 절대 경로로 올리고(2.6.2 `path.resolve`와
   같다), 콜드(`initial_dir`)는 argv 문자열을 그대로 돌려준다. 탐색기 컨텍스트 메뉴는 늘
   절대 경로(`%V`)를 주므로 **출하 경로에서는 두 값이 같다**. `initial_dir`은 이 라운드의
   경계 밖(`ipc/parity/misc.rs`)이라 손대지 않았다.

## 5. 다음 사람이 다시 재는 법

```
node scripts/poc-opendir.mjs --tag=<태그> --port=<10800+>            # 판정 exe
node scripts/poc-opendir.mjs --tag=<태그>ctl --port=<+2> --exe=<수정 전 exe>
node docs/critic/tools/critic-r28e-channels.mjs                      # missing 9인가
```

하네스는 실홈을 한 바이트도 안 만진다(`bench/fixture.mjs`와 달리 `accounts.json`을
**복사조차 안 한다**), 죽이는 것은 자기가 스폰한 PID뿐이다.
