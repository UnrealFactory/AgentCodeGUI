# R28g GATE 확인 크리틱 R1 — 반쯤 붉던 자물쇠는 내 손에서도 닫혔다(대조군 5/12 → 판정 0/240). 그런데 이 라운드가 늘린 **단 하나의 테스트**는 자기가 지킨다는 배선을 안 잡는다

판정 대상: `127d9db`(GATE R1) + `c2f828d`(GATE R2).
규율대로 **빌더의 보고서·커밋 메시지·하네스를 근거로 쓰지 않았다** — exe를 새로 굽고, 계기를
새로 쓰고(`C:\Temp\ccg-r28g-gatecrit\tools\*.mjs`), 격리 홈에서 눌러 쟀다. 대조군·돌연변이는
**전부 새 `CARGO_TARGET_DIR`** 에서 따로 구웠다(재활용 금지 — R28d 실증).

---

## 1. 무엇으로 쟀나

| 자리 | 값 |
|---|---|
| 판정 트리 | `feature/3.0.0-beta` 워킹트리. 시작 시 **추적 파일 수정 0**. `git diff c2f828d HEAD -- src-tauri/src/ipc/accounts.rs tools/churn.mjs docs/parity-fix-gate-r1.md` = **빈 출력** = GATE가 낸 바이트 그대로 쟀다 |
| 판정 소스 | `src-tauri/src/ipc/accounts.rs` md5 `342cf5f55c9e5dff7b2bd44bcba61ac8` (= `git archive HEAD` 사본과 바이트 동일) |
| **판정 테스트 exe**(debug) | `C:\Code\AgentCodeGUI\target-r28g-gate-crit\debug\deps\agentcodegui-602aa36c438f5a1e.exe`<br>sha256 `7956e1f8d96136244b346998391599b52cfdfddc8fdb2063228892b6ff7a30e1` |
| **판정 앱 exe**(release) | `C:\Temp\ccg-r28g-gatecrit\tgt-judge\release\agentcodegui.exe`<br>sha256 `afbaf7490ee61b4fdd673c85c67c0d7e0b92acad71f04165dd7beb93eb232c2d`<br>`--features custom-protocol` 확인: **내가 구운 번들 이름** `FileModal-Cz_dR_N7` 1회 embed · 주행 중 `window.api` **있음** · `location.href = http://tauri.localhost/` |
| **대조군 exe**(GATE **직전** `8dd4678`의 `accounts.rs`를 HEAD 트리에 얹음) | `…\tgt-mutC\debug\deps\agentcodegui-…exe` sha256 `27ab0517824a273fe80b78416704876fbf38f6e6dc3346211717b4c112cb5f34` · **새 target dir** |
| 돌연변이 exe 셋 | A `800f1dc6…`(tgt-mutA) · B `dccfdf19…`(tgt-mutB) · D `0d803735…`(tgt-mutD) — **셋 다 각자 새 target dir**, 매 회 `Compiling agentcodegui` 확인, 해시 전부 다름 |
| CARGO_TARGET_DIR | `target-r28g-gate-crit`(크리틱 전용) · `C:\Temp\ccg-r28g-gatecrit\tgt-{judge,mutA,mutB,mutC,mutD}` — GATE의 `target-r28g-gate`와 **한 번도 안 겹쳤다** |
| CCG_HOME | `C:\Temp\ccg-r28g-gatecrit\home-n1-j{,2,3,4}` · `home-n2-x` — 계정은 전부 `@crit.invalid` **합성**. 사용자 실홈(`%USERPROFILE%\.agentcodegui`)은 **읽지도 복사하지도 않았다** |
| CDP 포트 | 10651 · 10652 · 10653 · 10654 · 10661 (GATE 10600 + 50 대역) |
| 내 계기 | `C:\Temp\ccg-r28g-gatecrit\tools\{gclib,n1,n2,storm}.mjs` — 전부 이 라운드에 내가 씀. **빌더의 `tools/churn.mjs`는 한 번도 안 돌렸다**(내 `storm.mjs`는 손자를 만드는 세 갈래라 부모-자식 링크가 실제로 나고 죽는다 — churn의 `cmd /c ver`는 링크를 안 만든다) |
| 안전 | 이름 기반 kill **0회**(내가 spawn한 PID와 그 서브트리만) · `taskkill /IM` **0회** · 실홈 무접촉 · 기준 결과 파일 덮어쓰기 **0회** · 주행 뒤 `PING.EXE` 잔존 **0** · 내 앱 프로세스 잔존 **0** |

주: 주행 중 레포 HEAD가 `0f20aad` → `8795998`로 움직였다(M10·AUDIT3·NAIL 착지).
`git log 8dd4678..HEAD -- src-tauri/src/ipc/accounts.rs` = `127d9db`·`c2f828d` **둘뿐**이라
내 측정은 GATE가 낸 바이트에 고정돼 있고 그대로 유효하다.

---

## 2. 체크리스트 항목별 실측

| # | 요구 | 내 실측 | 판정 |
|---|---|---|---|
| 1 | `cargo test -p agentcodegui --bin agentcodegui --features custom-protocol` **기본 병렬 10회 연속** | **10/10 초록**(매 회 `161 passed; 0 failed` · `finished in` 1.50~1.60s · 명령 전체 1.89~5.23s). 여기서 멈추지 않고 **연속 240회**까지 밀었다 → **0 붉음** | ✅ |
| 2 | `cargo test --workspace` exit 0 | **exit 0** · `805 passed / 0 failed` · 34개 테스트 바이너리 전부 ok | ✅ |
| 3 | 부하를 겹쳐도 초록(최소 3회) | **108회**(8 + 100). 부하는 내 `storm.mjs`: ①`cmd /c ver` ②`cmd /c "cmd /c ver"`(손자) ③`cmd /c "PING -n 1"`(로더 경합)를 섞어 상위 **238~276 spawn/s ≈ 태어나는 프로세스 ~397~460/s**. 100회 구간은 24코어 cargo 빌드까지 겹쳤다 → **108/108 초록** | ✅ |
| 4 | 픽스처가 장식이 아닌가(내가 만든 돌연변이) | 돌연변이 **A·B 둘 다 4/4 결정론적 붉음**, 각각 **다른 한 테스트만** 잡는다(아래 §3) | ✅ |
| 5 | N1·N2 무회귀(내 exe·내 격리 홈) | 「맨 위로」 디스크 저장 ✅ · 「취소」 스피너 **13~22ms** · 손자 생존 **0/0/0/0** · N2 감옥 탈출 ✅(9개 상태 전부 §4) | ✅ |
| 6 | 크레이트별 테스트 수 · typecheck 3종 | 아래 §5. typecheck node·web·app **exit 0 ×3** | ✅ |

### 2-A. 240회의 의미(그리고 10회가 왜 통과선이 아닌지)

빌더 자신이 R2 커밋에서 「10회 초록은 2% 결함의 통과선이 아니다」라고 적었다. 맞다. 그래서
내 쪽 통과선을 훨씬 위로 올렸다.

| 구간 | 조건 | 결과 |
|---|---|---|
| 1~10 | 평시, 기본 병렬 | 10/10 초록 |
| 11~60 | 평시 + mutA 빌드 겹침 | 50/50 초록 |
| load 1~8 | storm `--par=140`(238 top/s · ~397 born/s) | 8/8 초록 |
| 61~160 | storm `--par=160`(276 top/s · ~460 born/s) + mutC 빌드 겹침 | 100/100 초록 |
| 161~240 | 평시 | 80/80 초록 |
| **합계** | | **240/240 · 매 회 161 passed** |

240회 0붉음이면 **2% 잔존 결함은 99.2%로 배제**되고(1−0.98²⁴⁰), 실패율의 95% 상한은
약 **1.25%**(rule of three)다. 「보였을 뿐 아직 안 뜬 손자」(⑤가 잡은 2%)는 내 손에서
재현되지 않았다.

---

## 3. 자물쇠인가 장식인가 — 돌연변이 넷(전부 새 target dir)

### ✅ A. 제품의 취소 경로 무력화 → 자물쇠다

`kill_wrapped_child`를 통째로 no-op으로.

```
mutA ×4 → 4/4 FAILED (160 passed; 1 failed) — 매 회 정확히 한 테스트
  ipc::accounts::tests::cancelling_a_wrapped_login_kills_the_program_inside_the_wrapper
  panicked at accounts.rs:909: ★래퍼 안의 프로그램이 살아남았다(pid 28384의 자식): [25956]
```

문구가 **픽스처 단정이 아니라 제품 단정**이고(살아남은 손자의 번호까지 싣는다), 같이 붉으면
안 되는 unwrapped 테스트는 초록을 유지했다.

### ✅ B. ★내가 새로 만든 반대 방향 — 이쪽도 자물쇠다

빌더는 이 방향을 안 재 봤다. `wrapped` 비트를 무시하게 만들어 **unwrapped에서도 직속 자식을
죽이도록** 했다(= CLI가 스스로 연 브라우저까지 취소가 죽이는 회귀).

```
mutB ×4 → 4/4 FAILED — 매 회 정확히 다른 한 테스트
  ipc::accounts::tests::cancelling_an_unwrapped_login_leaves_what_the_cli_launched_alone
  panicked at accounts.rs:947:
  ★unwrapped인데 CLI가 띄운 것까지 죽었다(브라우저가 죽는 모양) — ["39020: +31ms code=0x1"]
```

두 테스트는 **서로 반대 방향의 자물쇠**다. 그리고 R2가 남긴 25ms 폴링 계기가 실제로 값을
한다 — 종료 코드 `0x1`(우리가 넘긴 값 = **우리가 죽였다**)이 R2가 쫓던 `0xC000010A`
(초기화 중 부모와 함께 무너짐)와 문면에서 갈린다. 계기가 원인을 두 갈래로 나눈다.

### ✅ C. 대조군(GATE 직전 `accounts.rs`) — 빌더의 기전 진단은 내 손에서도 참이다

HEAD 트리에 `8dd4678`의 `accounts.rs`만 얹어 **새 target dir**에서 구웠다(`160 passed` =
이 라운드가 테스트 1개를 늘렸다는 것도 여기서 확인된다).

| 조건 | 대조군(GATE 직전) | **판정 exe(HEAD)** |
|---|---|---|
| 평시 · 기본 병렬 ×12 | **붉음 5 / 12 (42%)**<br>붉은 회차 6.8~7.0s(6초 폴링을 다 쓴다) · 초록 1.6s | **0 / 240** |
| 적대적 PATH(없는 폴더 하나)로 exe 직접 ×3~4 | **4/4 붉음** — 매 회 그 **두 테스트**가 같이 | **3/3 초록** |

즉 「전역 PATH를 갈아끼운 이웃 테스트의 창에 걸리면 `cmd`가 `ping`을 못 찾는다」는 진단은
사실이고, 절대 경로 + 일부러 없는 PATH를 자식에게 주는 처방 ①이 **확률을 양방향 결정론으로
바꿨다**. 크리틱이 여기서 확인해 줄 것은 확인해 준다.

### ❌ D. ★그런데 §3-C 처방(재시도)은 **아무 테스트도 안 잡는다**

`direct_children`을 `retrying(|| snapshot_children(pid))` 에서
`snapshot_children(pid).unwrap_or_default()` 로 되돌렸다 — 즉 **§3-C가 닫았다고 말한 그
구멍(스냅샷 실패 = 조용한 빈 목록)을 제품 경로에 그대로 다시 뚫었다.**

```
mutD ×5 → 5/5 ok. 161 passed; 0 failed
```

이 라운드가 늘린 테스트는 정확히 하나
(`a_snapshot_that_fails_once_is_retried_instead_of_read_as_no_children`)인데, 그 테스트는
`retrying()` 헬퍼에 **손으로 만든 클로저**를 먹여 재시도 **정책**만 잰다. `direct_children`도
`snapshot_children`도 한 번도 안 부른다. 그래서 **정책은 잠기고 배선은 안 잠긴다** — 다음
사람이 저 한 줄을 되돌려도 161개가 전부 초록이다. 자세한 등급·재현은 §6-①.

---

## 4. N1·N2 무회귀 — 내 릴리즈 exe·내 격리 홈에서 다시 눌렀다

### N1 — 「맨 위로」 · 「계정 추가」 · 「취소」 (4회 반복)

| 값 | run1 | run2 | run3 | run4 |
|---|---|---|---|---|
| 「맨 위로」 클릭 → 화면 정착 | **7ms** | 2ms | 2ms | 4ms |
| 정착 후 OpenAI 목록 | `[b, a]` 2행 | 〃 | 〃 | 〃 (증발 없음) |
| 디스크 `codex-accounts.json` | `[b, a]` · `defaultEmail=b` · **461바이트**(클릭 전과 같은 크기, 순서만 뒤집힘) | 〃 | 〃 | 〃 |
| 「계정 추가」 → 래퍼+손자 등장 | 737ms (`cmd.exe`×1 + `PING.EXE`×1) | 661ms | 650ms | 713ms |
| 셰임 로그 | `shim\|login` (실홈으로 안 샌다) | 〃 | 〃 | 〃 |
| **「취소」 → 스피너 해제** | **14ms** | **13ms** | **13ms** | **22ms** |
| **취소 뒤 살아남은 손자** | **0** | **0** | **0** | **0** |
| 취소 뒤 목록 / 디스크 | 2행 유지 / 461바이트 그대로 | 〃 | 〃 | 〃 |
| 뒷정리 후 `PING.EXE` 잔존 | 0 | 0 | 0 | 0 |

R28f 확인 크리틱 R2의 기준선(스피너 58ms)보다 빠르고, 손자 생존은 여전히 0이다. **무회귀.**

(주: 중간 계측에서 `cmd /C npm view @openai/codex --json` 한 개가 「래퍼 잔존」으로 잡혔는데
로그인 래퍼가 아니라 버전 조회다 — 2.5초 뒤 재측정에서 전부 사라졌다. 오탐이라 여기 적어 둔다.)

### N2 — 렌더 예외 감옥 (9개 상태, 폭탄 채팅 `text`가 객체)

| 상태 | eb-card | 사이드바 | 창 크롬 | 채팅 | 디스크 activeChatId |
|---|---|---|---|---|---|
| 부팅(정상 활성) | 0 | 3 | 1 | 1 | `gc-good` |
| 폭탄 선택 직후 | **1** | **3** | **1** | 0 | **`gc-boom`**(즉시 영속) |
| 사이드바로 탈출 | 0 | 3 | 1 | 1 | `gc-good` |
| 폭탄 재선택 | 1 | 3 | 1 | 0 | `gc-boom` |
| 「앱 새로고침」 | **0** | 3 | 1 | 1 | `gc-good` |
| 폭탄 활성인 채로 재시작 #1 | **0** | 3 | 1 | 1 | `gc-good` |
| 재시작 #2 | **0** | 3 | 1 | 1 | `gc-good` |
| 재시작 뒤 탈출 | 0 | 3 | 1 | 1 | `gc-good` |

카드 문구 `문제가 발생했어요 / 대화 화면을 그리는 중 오류가 났어요. 대화 기록은 저장되어
있습니다. / e.slice is not a function`, 버튼 `[다시 시도, 앱 새로고침]`.
**카드가 떠 있는 동안에도 사이드바 3행과 창 크롬이 산다 = 감옥이 아니다.** 폭탄을 활성으로
남긴 채 프로세스를 두 번 재시작해도 부팅 루프가 안 난다. **무회귀.**

---

## 5. 테스트 수 · 타입체크

크레이트별(내 target dir, 같은 순간):

| 크레이트 | 수 | 비고 |
|---|---|---|
| agentcodegui | **161** | 대조군(GATE 직전 `accounts.rs`)은 **160** → 이 라운드가 늘린 테스트는 **정확히 1개**. `ipc::accounts::tests` = **9** |
| ccg-auth | **125**(`net` 끔) / **142**(`net` 켬) | 차이 **17** |
| ccg-engine | **251** | 이 중 **18**은 이웃의 미추적 프로브(`probe_wfire_crit` **8** + `probe_wfr2` **10**, 실측). 추적분은 **233** |
| ccg-fs | 101 | |
| ccg-lsp | 59 | |
| ccg-store | 91 | |
| **크레이트별 합** | **788** | |
| **`cargo test --workspace`** | **805** | 차이 **17** |

**빌더의 「780 vs 763 = 측정 모드 차이 17」 해명은 내 트리에서 정확히 재현된다.**
`--workspace`는 `src-tauri`가 켜는 `ccg-auth`의 `net` 피처를 통일하고 `-p ccg-auth`는 끈다 —
그 델타가 `142 − 125 = 17`이고, `788 + 17 = 805`로 딱 맞는다. 프로브 18은 두 모드에 함께
얹히는 별개 항이라는 것도 맞다(둘 다 `-p ccg-engine`·`--workspace` 양쪽에 들어간다).

| 검사 | 결과 |
|---|---|
| `npm run typecheck`(node·web) | **exit 0** |
| `npm run typecheck:app` | **exit 0** |
| `cargo test --workspace` | **exit 0** · 805/0 |

---

## 6. 남은 결함

### ① 〈중〉 이 라운드가 늘린 **유일한 테스트**가 제품 배선을 안 잡는다

* **무엇** — §3-C 처방(`direct_children`이 스냅샷 실패를 재시도한다)에 붙은 자물쇠가 없다.
  새 테스트는 `retrying()`에 손으로 만든 클로저를 먹여 **정책**(2회 실패 뒤 성공 / 빈 목록은
  성공 / 상한 4)만 잰다. `direct_children`·`snapshot_children`을 **한 번도 안 부른다**.
* **왜 문제** — R28f 확인 크리틱 §3-C가 지목한 병은 「스냅샷 실패가 **제품의 취소 경로에서**
  자식 없음과 구분 안 된다」였다. 처방은 배선에 있는데 테스트는 헬퍼에 있어서, 배선을
  되돌리면 침묵한다. 커밋 메시지의 「재시도 규칙은 단위 테스트로 잠갔다」는 **규칙**까지는
  맞고 **처방**까지는 아니다.
* **재현(내가 한 그대로)**

  ```
  git archive HEAD | tar -x -C <새 트리>            # app/dist 복사
  # accounts.rs 한 줄:
  #   retrying(|| snapshot_children(pid))
  # → snapshot_children(pid).unwrap_or_default()
  CARGO_TARGET_DIR=<새 dir> cargo test -p agentcodegui --bin agentcodegui --features custom-protocol
  ```
  **실측 5/5 → `ok. 161 passed; 0 failed`.** exe 해시 `0d803735f14be2d76f23e52a9d5dd61df34617b33f200861672650f36483a219`
  (판정 exe `7956e1f8…`와 다름 = 진짜로 다시 구웠다).
* **닫는 모양(제안)** — `snapshot_children`을 주입 가능한 자리로 빼거나, 최소한
  「`direct_children`가 `retrying`을 지난다」를 소스 수준이 아니라 **행동**으로 잰다.

### ② 〈중〉 이웃의 전역 `PATH` 치환은 아직 열려 있다(GATE 경계 밖 — 빌더도 미완으로 적음)

* 같은 `agentcodegui` 바이너리 안에 프로세스 전역 `PATH`를 갈아끼우는 자리가 **넷**이다:
  `engine/codex_limit.rs:469`·`:503`, `engine/versions.rs:255`·`:262`.
  이들이 쥐는 자물쇠는 `testhome` 하나뿐이고(그건 `CCG_HOME`용이다), **그 자물쇠를 안 쥐는
  테스트는 그 창에 그대로 노출된다.**
* GATE는 자기 픽스처를 절대 경로로 못 박아 그 창에서 빠져나왔다. **다른 테스트가 같은 창에
  들어가지 않는다는 보증은 없다** — 오늘 안 터지는 것은 게이트가 아니라 우연이다.
  (내 240회에서도, 대조군 12회에서도 붉은 것은 그 두 테스트뿐이었다 = 지금은 노출된
  다른 테스트가 없다. 그래서 〈상〉이 아니라 〈중〉이다.)
* 고칠 층위는 `engine/` 소유자다 — 「전역 `PATH`를 만지는 테스트는 예외 없이 같은 자물쇠를
  쥔다」를 `testhome`처럼 **한 자리 규약**으로 세우는 것이 유일한 구조적 답이다.

### ③ 〈하〉 「조용한 빈 목록」이 완전히 닫히지는 않았다

`snapshot_children`의 재시도는 **`CreateToolhelp32Snapshot` 실패만** 잡는다.

```rust
let mut ok = Process32FirstW(snap, &mut e).is_ok();
while ok { … ok = Process32NextW(snap, &mut e).is_ok(); }
Some(out)                       // ← 도중에 실패해도 Some(잘린 목록)
```

`Process32FirstW`/`Process32NextW`가 **도중에 실패하면** 루프가 조용히 끝나고 **잘린 목록이
`Some(...)`으로** 나간다 — 그건 §3-C가 「닫았다」고 말한 모양(자식 없음과 구분 안 됨)과 같다.
정상 종료(`ERROR_NO_MORE_FILES`)와 진짜 실패를 `GetLastError`로 가르지 않는 한 남는 구멍이다.
확률이 아주 낮아 〈하〉로 둔다.

### ④ 〈하·방법〉 빌더의 A/B 대조군은 같은 `CARGO_TARGET_DIR`를 재활용했다

보고서·커밋의 「대조군 A/B(**같은 target**, 소스만 갈아 두 번 구움)」는 R28d가 금지한
모양이다(매 회 `Compiling` 확인으로 완화하긴 했다). **제품 결함은 아니다** — 내가 새
target dir로 다시 재서 같은 결론(대조군 붉음 / 판정 초록)을 얻었으므로 그 문장의 **값**은
살아 있고, **방법**만 규율 밖이었다.

### 진짜로 닫힌 것(공정하게 적는다)

* R28f 확인 크리틱 R2 §3-A의 ★유일 격차 — **닫혔다.** 대조군 42%(5/12) → 판정 0/240.
* 기전 진단(이웃의 전역 PATH) — **참이다.** 대조군은 적대적 PATH에서 4/4 결정론적으로 붉고,
  판정 exe는 같은 조건에서 3/3 초록.
* 취소 회귀 테스트 둘 — **양방향 자물쇠다.** 서로 다른 돌연변이가 각각 다른 하나만 붉힌다.
* R2가 남긴 25ms 폴링 계기 — **값을 한다.** 종료 코드로 「우리가 죽였다(0x1)」와
  「초기화 중 무너졌다(0xC000010A)」를 문면에서 가른다.
* N1·N2 — **무회귀.** 「취소」 13~22ms · 손자 생존 0 · 감옥 없음.
* 780 vs 763 해명 — **산술까지 맞다.** 788 + 17(= `ccg-auth net`) = 805.

---

## 7. 내가 만진 것

* **레포 코드 수정 0.** 이 판정문(`docs/critic/r28g-gate-critic-r1.md`) 한 파일만 썼다.
* 내 계기·트리·산출물은 전부 레포 밖: `C:\Temp\ccg-r28g-gatecrit\**`
  (`tools/{gclib,n1,n2,storm}.mjs` · `arch`/`mutA`/`mutB`/`mutC`/`mutD` 소스 트리 ·
  `tgt-*` target dir · `home-*` 격리 홈 · `logs/*` · `out-n1-*.json` · `out-n2-*.json`).
* 유일하게 레포 안에 만든 것은 `target-r28g-gate-crit/`(빌드 산출물, 미추적).
* 이웃의 미추적 프로브 둘(`crates/ccg-engine/tests/probe_wfire_crit.rs` · `probe_wfr2.rs`)은
  **커밋하지 않았고**, 테스트 수를 셀 때 18개를 따로 갈라 적었다.
* 남의 미커밋 변경에 `reset`·`checkout`·`stash`·`restore`를 **한 번도** 하지 않았다.
