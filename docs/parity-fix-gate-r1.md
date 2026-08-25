# R28g GATE R1 — 자물쇠가 반쯤 붉었던 진짜 이유는 스냅샷이 아니라 **이웃이 갈아끼운 PATH**였다

대상: `src-tauri/src/ipc/accounts.rs`의 취소 회귀 테스트 둘
(`cancelling_a_wrapped_login_kills_the_program_inside_the_wrapper` ·
`cancelling_an_unwrapped_login_leaves_what_the_cli_launched_alone`, 둘 다 `1e47a06` 산물).
지시: R28f 확인 크리틱 R2(`1ff6c8e`) §3-A의 ★유일 격차 — 「게이트가 전체 주행의 절반에서 붉다」.

측정 자리: `CARGO_TARGET_DIR=C:\Code\AgentCodeGUI\target-r28g-gate` · 명령은 전부
`cargo test -p agentcodegui --bin agentcodegui --features custom-protocol`(기본 병렬).
`--test-threads=1`로 도망친 주행은 **한 번도 없다**.

---

## 1. 재현 — 크리틱의 붉음은 내 손에서도 났다

손대기 전(HEAD `2071c36`의 워킹트리), 같은 명령 6회:

| 회차 | exit | 결과 |
|---|---|---|
| 1 | 101 | 156 passed / **2 failed** |
| 2 | 0 | 158 / 0 |
| 3 | 101 | 156 / **2** |
| 4 | 101 | 157 / **1** |
| 5 | 101 | 156 / **2** |
| 6 | 0 | 158 / 0 |

**6회 중 4회 붉음.** 크리틱(3/6)보다 더 자주 났다. 붉은 회차는 매번 6.9초(= 픽스처가 6초
폴링을 다 쓰고 죽는다), 초록 회차는 1.6초 — 이 시간 차가 뒤에서 원인을 갈랐다.

---

## 2. ★크리틱의 기전 가설은 **틀렸다** — 계기를 심어 찍은 값

크리틱 §3-A의 가설:

> 그 대기 루프는 「자식 수가 늘기를 멈출 때까지」인데, 스냅샷이 한 번이라도 빈 목록을
> 돌려주면 `kids`가 `[]`로 덮이고 그대로 끝난다.

코드를 그대로 따라가 보면 이 가설은 성립하지 않는다. `kids`가 `[]`가 되어도 **다음 회차**의
`now.len() > kids.len()`이 참이 되어 곧바로 회복한다(잃는 것은 100ms뿐이다). 진짜로 무너지려면
스냅샷이 **6초 내내** 빈 목록이어야 한다.

그래서 픽스처에 계기를 심었다 — 폴 1회당 스냅샷 **1회**(원본과 같은 비용)로 유지하면서
실패 코드·자식 이름·래퍼의 출력·래퍼의 종료 코드를 같이 찍었다. 붉은 회차의 전문:

```text
★래퍼 안의 프로그램이 안 떴다 — 픽스처가 무의미하다(자식 [])
cwd=Ok("C:\\Code\\AgentCodeGUI\\src-tauri")
PATH[0..160]=C:\Users\User\AppData\Local\Temp\ccg-test-codex-limit-path-11484-1787659101435356700\fakepath
cmd alive=false try_wait=Ok(Some(ExitStatus(ExitStatus(1))))
SAID="'ping'은(는) 내부 또는 외부 명령, 실행할 수 있는 프로그램, 또는 배치 파일이 아닙니다."
TRACE:
t0 +6ms Ok([(33128, "conhost.exe")])
+113ms Ok([])
…(같은 값이 +6401ms까지)
```

읽히는 것 셋:

1. **스냅샷은 매 회 성공했다** — 60회 전부 `Ok(...)`, `Err`(= `CreateToolhelp32Snapshot` 실패)
   **0회**. 크리틱이 지목한 「빈 목록으로 덮인다」는 이 붉음의 원인이 아니다.
2. `cmd.exe`는 **첫 100ms 안에 종료 코드 1로 죽었다.** 자식 목록이 빈 것은 스냅샷 탓이 아니라
   부모가 없어서다.
3. 무엇이 죽였는지 래퍼가 직접 말했다 — **`ping`을 못 찾았다.** 그리고 그 줄 위에 범인이 있다:
   `PATH`가 `…\ccg-test-codex-limit-path-…\fakepath` **하나뿐**이다.

### 범인 — 이웃 테스트가 프로세스 전역 `PATH`를 갈아끼운다

`src-tauri/src/engine/codex_limit.rs:469`
(`a_codex_found_on_the_global_path_is_an_instrument_too`):

```rust
let _p = EnvGuard::set("PATH", std::env::join_paths([dir]).unwrap());
```

「전역 PATH의 codex도 창구다」를 재려고 가짜 `codex.cmd` 하나만 든 폴더로 **PATH를 통째로
치환**한다. `std::env::set_var`는 **프로세스 전역**이고, 그 테스트가 쥐는 자물쇠는
`CCG_HOME`(`ccg_store::testhome`)뿐이다. 그 자물쇠를 안 쥐는 우리 픽스처는 그 창에 겹치면
System32가 없는 PATH를 물려받는다.

왜 `cmd.exe`는 떴는데 `ping`만 못 찾았나: `CreateProcess`는 이름 해석에서 **언제나 System32를
뒤진다**(그래서 pid는 나온다). 반면 `cmd`가 자기 손으로 하는 외부 명령 탐색은 `%PATH%`뿐이다.

창이 그 이웃 테스트의 수명(≈수백 ms)뿐이라 **절반만 붉었다.** `--test-threads=1`이면 두
테스트가 절대 겹치지 않으므로 안 났다 — 크리틱이 관찰한 「직렬이면 초록」과 정확히 맞는다.

> 이웃 테스트는 **고치지 않았다.** `src-tauri/src/engine/**`는 이 갈래의 경계 밖이고,
> 무엇보다 **고칠 자리가 거기가 아니다** — 게이트가 프로세스 전역 환경에 기대고 있던 것이
> 결함이다. (다만 같은 창은 PATH로 실행 파일을 찾는 **다른 모든 테스트**에도 열려 있다.
> 이 라운드 뒤 20회 주행에서 다른 붉음은 안 났지만, 소유자가 볼 만한 자리로 남겨 적는다.)

---

## 3. 무엇을 바꿨나 — 「수를 센다」를 버리고 넷을 세웠다

`spawn_wrapped_fixture`를 다시 세웠다. 근거는 코드 주석에 그대로 적었다.

| # | 바꾼 것 | 왜 |
|---|---|---|
| ① | 래퍼(`cmd.exe`)도 그 안의 프로그램(`PING.EXE`)도 **절대 경로**로 못 박고 존재를 먼저 확인한다. 게다가 자식의 `PATH`를 **일부러 없는 폴더**로 준다 | 환경을 안 믿는다. 픽스처의 어느 고리든 PATH에 기대면 이제 절반이 아니라 **매번** 붉다 = 회귀가 확률이 아니라 사실이 된다 |
| ② | 「자식 **수**가 늘기를 멈출 때까지」를 버리고 **이름으로 특정**(`PING.EXE`) + **「보인 적이 있다」를 단조로 기억** | 수를 세는 모양은 부하에 취약하다: 스냅샷 한 번의 빈 목록·conhost가 안 붙는 판·손자가 늦는 판이 전부 같은 값으로 보인다. `kids.len() >= 2`는 「conhost가 반드시 먼저 붙는다」를 몰래 전제하고 있었다 |
| ③ | 손자를 **번호가 아니라 핸들**로 들고 있다(`PidWatch`) | 158개 테스트가 초당 수백 개 프로세스를 만들고 죽이는 판에서 pid는 재발급된다. 윈도우는 핸들이 열려 있는 동안 프로세스 객체(따라서 번호)를 놓지 않으므로, 죽인 뒤의 「아직 사나」가 **정확해진다** |
| ④ | 실패가 **스스로 말한다** — 래퍼가 뱉은 말·종료 코드·스쳐간 직속 자식 전부를 패닉 문구에 싣는다 | R28f의 「자식 []」 한 줄은 6초의 침묵만 남겼고, 그래서 크리틱도 나도 계기를 새로 심어야 했다. ②의 계기 한 줄이 이번에 원인을 **한 번에** 지목했다 |
| ⑤ | **준비 신호를 자식에게서 받는다** — 「PING.EXE가 보였다」에 더해 「파이프에 **뭐라도 썼다**」를 함께 요구한다 | 「프로세스 표에 있다」는 「떴다」가 아니다. ①~④만 세운 판이 **여전히 100회에 2회 붉었다** — §10 참조. 스냅샷은 `CreateProcess`가 객체를 만든 즉시 pid를 보여주고, 그때 손자는 로더도 stdio도 아직이다 |

곁들여 **크리틱 §3-C(〈하〉)도 닫았다** — 이번 붉음의 원인은 아니었지만 진짜 결함이다:
`direct_children`이 `CreateToolhelp32Snapshot` 실패를 **조용한 빈 목록**으로 돌려주고 있었다
(= `kill_wrapped_child`가 아무것도 안 죽이고 성공한 것처럼 돌아온다). 스냅샷 한 번을
`Option`으로 갈라 실패는 실패로 돌려받고 최대 4회 다시 찍는다(`snapshot_children` + `retrying`).
재시도 규칙 자체는 단위 테스트로 잠갔다
(`a_snapshot_that_fails_once_is_retried_instead_of_read_as_no_children` — 「빈 목록은 성공이라
한 번에 끝난다」·「상한이 있다」까지 잰다).

---

## 4. 통과선 — 요구 (2)

명령: `cargo test -p agentcodegui --bin agentcodegui --features custom-protocol`(기본 병렬).
**커밋할 바이트 그대로**에서 잰 값이다(주석 정정까지 반영한 뒤 다시 쟀다).

아래는 **최종 판**(§10의 ⑤까지 반영한, 커밋 `R2`의 바이트)에서 잰 값이다.
요구는 10회지만 §10의 결함이 10회로는 안 보이는 크기(≈2%)였으므로 **200회**를 돌렸다.

| 주행 | 결과 |
|---|---|
| **연속 200회**(100 + 100 두 묶음) | **200/200 초록** · 매 회 `161 passed; 0 failed` |
| **부하 겹친 5회**(`node tools/churn.mjs --par=60`, 실측 293 spawn/s ≈ 프로세스 생성·소멸 **~590/s**) | **5/5 초록** · 1.64 ~ 1.73s |
| **`cargo test --workspace`** | **exit 0** · `805 passed / 0 failed` (34개 테스트 바이너리 전부 ok) |
| `npm run typecheck`(node·web) | exit **0** |
| `npm run typecheck:app` | exit **0** |
| 빌드 경고 | 0 |
| 누수 점검 | 주행 뒤 `PING.EXE` 잔존 **0** |

참고로 ⑤ **이전** 판(커밋 `R1`)의 값은 연속 10회 초록 ×2묶음 · 부하 4회 초록 · workspace 초록이었다.
**그 통과선으로는 §10의 결함이 안 보였다** — 그게 §10을 따로 적는 이유다.

### 대조군 — 「이 픽스처가 PATH에 걸린다」의 A/B

같은 target 디렉터리에서 **소스만 갈아** 두 번 굽고(`Compiling agentcodegui` 확인 — 거짓 초록
아님), 컴파일된 테스트 exe를 **적대적 PATH**(`PATH=C:\ccg-r28g-no-such-dir` 하나뿐)로 직접 돌렸다.
이것이 이웃 테스트가 만드는 상태를 결정론적으로 재현한 판이다:

| 트리 | 명령 | 결과 |
|---|---|---|
| **HEAD(고치기 전)** | `<exe> ipc::accounts::tests::cancelling` | **2회 중 2회 붉음** — `1 passed / 2 failed`, 문구 `★래퍼 안의 프로그램이 안 떴다(자식 [])` (accounts.rs:939) |
| **이 라운드(고친 뒤)** | 같은 명령 | **3회 중 3회 초록** — `3 passed / 0 failed`, 1.05s |

즉 고치기 전 픽스처는 이 조건에서 **100% 붉고**, 고친 뒤는 **100% 초록**이다.
확률적이던 것이 결정론으로 바뀌었고, 그 결정론이 양쪽 방향에서 확인된다.

---

## 5. 요구 (3) — 자물쇠인가 장식인가

### 돌연변이 A — `kill_wrapped_child` 무력화 (요구가 지목한 것)

```rust
/*MUT*/ if true || !wrapped {   // = 래퍼 갈래에서도 아무것도 안 죽인다
    return;
}
```

| 주행 | 결과 |
|---|---|
| 최종 판 전체 주행 **4회** | **4/4 FAILED** — 매 회 `160 passed; 1 failed` |
| (⑤ 이전 판) 전체 1회 + 취소 셋만 3회 | **4/4 붉음** |
| 붉은 테스트 | 언제나 `cancelling_a_wrapped_login_kills_the_program_inside_the_wrapper` **하나** |
| 붉은 문구 | `★래퍼 안의 프로그램이 살아남았다(pid 9728의 자식): [29748]` — **제품 단정**이다(픽스처 단정이 아니다) |
| 같이 붉어지면 안 되는 것 | `cancelling_an_unwrapped_login_leaves_what_the_cli_launched_alone`은 **초록 유지**(그쪽 계약은 「살아 있어야 한다」다) |

**자물쇠다.** 그리고 이제 그 붉음은 4/4 결정론이다(R28f의 픽스처는 초록조차 확률이었다).

### 돌연변이 B — 죽이는 **순서** 뒤집기 → ★붉지 **않았다**(정직한 음성)

`cancel()`에서 `child.kill()`·`wait()`를 **먼저** 하고 스냅샷을 나중에 찍게 바꿨다.
기존 주석은 「순서가 중요하다 — 부모가 살아 있어야 직속 자식을 찾는다」였는데,
**취소 테스트 셋이 그대로 초록이었다**(`3 passed / 0 failed`).

기전: 윈도우의 `th32ParentProcessID`는 살아 있는 링크가 아니라 **기록된 값**이라 부모가 죽은
뒤에도 남는다. 게다가 `Child`를 들고 있는 동안은 그 번호가 재사용되지 않는다.
그래서 이 순서는 **현재 코드에서는** 결과를 안 바꾼다.

그렇다고 순서를 뒤집지는 않았다 — 부모 핸들을 놓은 뒤에 찍으면 번호 재사용으로 **남의 자식**을
죽일 수 있다. 대신 **주석의 거짓을 고쳤다**(`direct_children`·`LoginSlot::cancel` 두 자리).
「죽은 뒤엔 링크가 끊긴다」는 사실이 아니었고, 규칙을 지키는 진짜 이유는 번호 재사용이다.
이 자리는 픽스처가 못 잡는다는 것도 함께 적었다.

---

## 6. 요구 (4) — 크리틱이 인용한 「780 vs 763」의 정확한 내역

**크리틱의 귀속(「차이 18 = 이웃의 미추적 probe 둘」)은 산술이 안 맞고, 원인도 다르다.**
셋을 따로 쟀다.

**(a) 미추적 probe 둘 = 정확히 18개.** 크리틱이 센 수는 맞다.

```
cargo test -p ccg-engine --test probe_wfire_crit   →  8
cargo test -p ccg-engine --test probe_wfr2         → 10                        합 18
```

두 파일의 mtime은 **2026-08-25 16:49**로, 빌더의 측정(`8dd4678`, 19:10)과 크리틱의
측정(20:08) **양쪽보다 앞서고** 그 뒤로 안 바뀌었다. 그리고 `git diff --stat 8dd4678 37afd55
-- '*.rs'`와 `git diff --stat 37afd55 HEAD -- '*.rs'`는 **둘 다 빈 출력** = 추적되는 Rust는
세 커밋에서 한 줄도 안 움직였다. 즉 probe는 **두 측정에 똑같이** 들어 있거나 똑같이 빠졌다.

**(b) 산술은 18이 아니라 17이다.** `780 − 763 = 17`. 크리틱 자신도 「차이 17~18」로 흔들려
적었다 — probe(18)로는 이 칸이 안 맞는다.

**(c) ★진짜 원인은 트리 차이가 아니라 측정 방식 차이 — 그리고 그 값이 정확히 17이다.**

`cargo test --workspace`는 `agentcodegui`가 켜는 `ccg-auth`의 `net` 피처를 **워크스페이스
전체에 통일**한다. `cargo test -p ccg-auth`는 그 피처가 꺼진다. 내 트리에서 같은 순간에 잰 값:

```
cargo test -p ccg-auth                  → 125 passed
cargo test -p ccg-auth --features net   → 142 passed      차이 = 17
```

* 빌더의 **780**은 `cargo test --workspace`(= net 켜짐)이다 — `docs/parity-fix-shipblock-r2.md:239`.
* 크리틱의 **763**은 **크레이트별 합**(= net 꺼짐)이다 — 판정문 §7 표.

**두 사람은 서로 다른 두 모드를 뺐다.** 내 트리에서 그 두 모드를 같은 순간에 재면
크레이트별 합 **788** vs `--workspace` **805**, 차이 **정확히 17** — 트리 차이가 하나도 없는
같은 코드에서 빌더·크리틱 사이의 그 칸이 그대로 재현된다. probe 18은 두 모드에 **함께** 얹히는
별개의 항이지, 그 칸의 값이 아니다.

**(d) 오늘 내 트리의 전 내역**(단일 `cargo test --workspace` 주행에서 바이너리별로 뽑았다):

| 크레이트 | 오늘(워킹트리) | 크리틱(archive `37afd55`, 크레이트별) | 차이의 출처 |
|---|---|---|---|
| agentcodegui | **161** | 158 | +1 이 라운드(재시도 단위 테스트) · +2 이웃 미커밋(`engine/hub.rs`·`engine/mod.rs`) |
| ccg-auth | 142(net) / **125**(크레이트별) | 124 | +17 net 피처 · +1 이웃 미커밋(`tests/m11r4_store_cas.rs`) |
| ccg-engine | **251** | 231 | +18 이웃 **미추적 probe 둘** · +2 이웃 미커밋(`queue.rs`·`runtime.rs`·`wcap_limit_streak.rs`) |
| ccg-fs | **101** | 101 | — |
| ccg-lsp | **59** | 59 | — |
| ccg-store | **91** | 90 | +1 이웃 미커밋(`status.rs`) |
| **합** | **805**(workspace) / **788**(크레이트별 합) | **763** | |

**이 라운드가 늘린 테스트는 정확히 1개**다(`a_snapshot_that_fails_once_is_retried_instead_of_read_as_no_children`).
취소 테스트 둘은 **개수가 안 늘었다** — 같은 두 개를 고쳐 세웠다.
`ipc::accounts::tests`는 8 → **9**.

> 함정 10 그대로: 옆 갈래 넷이 같은 워킹트리에서 동시에 돈다. 위 수는 **측정 시점의 스냅샷**이고,
> 크리틱이 다시 재면 이웃 칸은 또 달라질 것이다. 내 칸(`agentcodegui` +1)만 고정값이다.

---

## 7. 안 한 것 · 남은 것

* **이웃 테스트의 전역 `PATH` 치환은 안 고쳤다**(§2 인용문). 경계 밖이고, 게이트 쪽이
  환경에 안 기대게 만드는 것이 옳은 층위다. 다만 같은 창은 PATH로 실행 파일을 찾는
  **다른 테스트에도** 열려 있다 — `engine/` 소유자가 볼 자리다.
* **크리틱 §3-B(파이프를 쥔 손자가 살아남는 판의 스레드·핸들 누수, 〈하〉)** 는 안 건드렸다.
  제품 `pump_login`의 읽기 스레드 수명 문제이고 이 라운드의 요구가 아니다. 장부에 남긴다.
* **돌연변이 B가 안 붉다**(§5) — 픽스처가 「죽이는 순서」는 못 잡는다. 현재 코드에서는 결과가
  같아서이지 순서가 아무래도 좋아서가 아니다(§5의 근거).
* **실 OAuth 왕복**은 여전히 검증 안 됨(가짜 프로그램으로만 왕복 — 실홈 무접촉이 규율이다).

---

## 8. 만진 파일 · 안전

* `src-tauri/src/ipc/accounts.rs` — 픽스처 재설계(테스트 모듈) + `direct_children` 재시도(제품) +
  주석 두 자리 정정. 커밋 둘로 나뉜다: `R1`(①~④ · 307 삽입 / 56 삭제) + `R2`(⑤ · §10).
* `tools/churn.mjs` — **새 파일.** 부하 발생기(요구 2의 「부하를 겹친 주행」). 이름 기반 kill을
  하지 않는다 — 자기가 spawn한 핸들만 들고 있다가 끝낼 때 정리하고, 띄우는 것은 System32의
  `cmd /c ver`(내장 명령이라 손자를 안 만든다)뿐이다.
* `docs/parity-fix-gate-r1.md` — 이 문서.

안전 규율:

* 이름 기반 kill **0회**. `taskkill` **0회**. 죽인 것은 내가 스폰한 pid의 핸들뿐이다.
* 사용자 실홈(`%USERPROFILE%\.agentcodegui`) 읽기·복사·수정 **0회**. 실계정 토큰 회전 유발 **0회**.
* 기준 결과 파일(`bench/results/*`·`bench/shots/*/report.json`·`docs/critic/*.json`) 덮어쓰기 **0회**.
* `CARGO_TARGET_DIR`는 `target-r28g-gate` 하나만 썼다(GATE 배정). 대조군은 **같은 트리에서
  소스만 갈아** 구웠고 매 회 `Compiling agentcodegui`를 확인했다 — 캐시 건너뛰기로 인한 거짓
  초록이 아니다(함정 11은 *다른 트리* 사이의 재활용을 금하는 것이고, 여기는 같은 트리다).
* 커밋은 `git commit --only <내 경로 셋>`. 남의 미커밋 변경은 `reset`·`checkout`·`stash`·
  `restore` **0회**(트리에는 지금도 이웃 11개 파일의 미커밋 변경이 살아 있다).
* 이웃의 미추적 계기 `crates/ccg-engine/tests/probe_{wfire_crit,wfr2}.rs`는 커밋하지 않았고,
  테스트 수에서 18로 따로 빼서 적었다(§6).

---

## 9. 재현

```bash
# 통과선
CARGO_TARGET_DIR=<격리> cargo test -p agentcodegui --bin agentcodegui --features custom-protocol   # ×10
CARGO_TARGET_DIR=<격리> cargo test --workspace

# 부하를 겹쳐서
node tools/churn.mjs --par=60 --secs=100 &   # ~264 spawn/s
CARGO_TARGET_DIR=<격리> cargo test -p agentcodegui --bin agentcodegui --features custom-protocol   # ×3

# 「PATH에 안 기댄다」 — 컴파일된 테스트 exe를 적대적 PATH로 직접
PATH="/c/ccg-r28g-no-such-dir" <target>/debug/deps/agentcodegui-*.exe ipc::accounts::tests::cancelling
#   고치기 전: 1 passed / 2 failed (2/2 붉음)     고친 뒤: 3 passed / 0 failed (3/3 초록)

# §10의 2% 결함 — 10회로는 안 보인다. 100회 단위로 재라.
for i in $(seq 1 100); do cargo test -p agentcodegui --bin agentcodegui --features custom-protocol || echo RED; done

# 자물쇠인가 — kill_wrapped_child 무력화
#   accounts.rs: `if !wrapped {` → `if true || !wrapped {`
#   → cancelling_a_wrapped_login_kills_the_program_inside_the_wrapper 만 붉다(3/3)
```

---

## 10. ★커밋 R1 뒤에 잡은 **둘째 결함** — 「프로세스 표에 있다」는 「떴다」가 아니다

정직하게 적는다. §4의 통과선(연속 10회 + 부하 4회 + workspace)을 **통과한 뒤에** 커밋했고
(`127d9db`), 그 직후 확인 주행에서 **한 번 붉었다.** 통과선이 결함보다 작았다.

### 무엇이 붉었나

이번엔 **다른 테스트**였다 — `cancelling_an_unwrapped_login_leaves_what_the_cli_launched_alone`
(`★unwrapped인데 CLI가 띄운 것까지 죽었다`). 즉 취소가 `cmd.exe`만 죽였는데 **손자가 같이 죽었다.**

빈도: 커밋 직후 표본에서 **~100회에 2회**(2%). 이 크기는 10회 통과선으로 **못 본다**
(0.98^10 ≈ 82%가 그냥 초록으로 지나간다). ⑤ 이전 판으로 30회·40회·15회를 따로 돌려도
붉음이 각각 2·0·0이었다 — 붙잡으려면 100회 단위가 필요했다.

### 원인 — 계기로 잡은 값

테스트 B가 통짜 1초 sleep 대신 25ms마다 손자의 생사와 **종료 코드**를 찍게 바꾸고 150회를 돌렸다.
두 번의 붉음이 **같은 값**을 냈다:

```
["34368: +26ms code=0xc000010a"]
["8752:  +26ms code=0xc000010a"]
```

* `0xC000010A` = `STATUS_PROCESS_IS_TERMINATING`. 우리가 넘긴 코드(1)도 아니고 정상 종료(0)도 아니다.
* 취소 **+26ms** — 우리가 `cmd.exe`를 죽인 직후다.

읽히는 것: 그 손자는 **아직 초기화 중**이었다. `CreateToolhelp32Snapshot`은 `CreateProcess`가
프로세스 객체를 만든 **즉시** 그 pid를 보여준다 — 로더도, 콘솔 부착도, stdio 개통도 그 뒤다.
②의 「이름으로 보였다」를 준비 완료로 읽으면 그 초기화 창을 그대로 밟고, 그 창에서 부모가
사라지면 손자가 함께 무너진다.

이것은 R28f 픽스처에도 **원래 있던** 구멍이다. 다만 그쪽은 PATH 문제로 더 자주(50%) 먼저
죽어 이 2%가 가려져 있었다.

### 처방 ⑤ — 준비 신호를 자식에게서 받는다

대기 조건에 하나를 **더한다**: 이름으로 특정된 손자가 있고, **그리고** 래퍼의 파이프에
**뭐라도 써졌을 때** 비로소 준비 완료다.

* `ping`은 시작하자마자 한 줄을 뱉는다. 문면은 로캘마다 다르므로 **비어 있지 않다**만 본다.
* 무언가를 썼다 = 로더를 지났고 stdio가 살아 있다 = 이 픽스처의 전제(「손자가 파이프의
  쓰기 끝을 쥔 채 살아 있다」)가 **실제로** 참이다.
* 이름 조건과 **AND**로 걸리므로, 래퍼가 에러 문구를 뱉은 판(예: PATH 사고)은 여기 안 걸리고
  ④의 진단으로 떨어진다.

요구 (1)이 제시한 세 갈래 중 「자식이 스스로 준비 신호를 남기게 하거나」가 **결국 필요했다.**
①~④(이름 특정 + 단조 기억 + 핸들 + 자기진술)만으로는 2%가 남았다.

### 처방 뒤 실측

| | 값 |
|---|---|
| 연속 주행 | **200/200 초록**(100+100) — 잔존율이 2%라면 200회가 전부 초록일 확률은 **1.8%** |
| 부하 겹친 5회 | 5/5 초록 |
| 적대적 PATH 3회 | 3/3 초록 |
| 돌연변이 A(최종 판) | **4/4 붉음** — 자물쇠는 그대로다 |
| `cargo test --workspace` | exit 0 · 805 / 0 |

그리고 테스트 B의 25ms 폴링(죽은 시각 + 종료 코드를 패닉 문구에 싣는다)은 **남겨 뒀다** —
이 한 줄이 ⑤를 잡았고, 다음에 또 무너지면 다음 사람이 계기를 새로 심지 않아도 된다.

### 남기는 교훈 하나

**「10회 초록」은 2% 결함에 대한 통과선이 아니다.** 이 갈래의 요구가 10회였고 10회는 통과했지만,
그 통과선이 결함을 못 봤다. 프로세스를 띄우고 죽이는 게이트는 **100회 단위**로 재야 한다.

— R28g GATE 빌더 (Claude Fable 5)
