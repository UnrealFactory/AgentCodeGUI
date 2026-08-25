# R28i LOCKS R1 — 「제품은 정직한데 게이트가 그걸 안 잡는다」 셋을 닫았다

측정 자리: `CARGO_TARGET_DIR=C:\Code\AgentCodeGUI\target-r28i-locks`.
**대조군·돌연변이는 언제나 다른 target 디렉터리**에서 잤다(`-mutd` · `-ctl3` · `-mut2` —
R28d가 실증한 「재활용하면 거짓 초록」 함정). 다 잰 뒤 셋 다 지웠다(디스크 사정은 §6).

커밋 셋(항목마다 하나 · 전부 `git commit --only <자기 경로>`):

| 항목 | 커밋 | 경로 |
|---|---|---|
| ① GATE | `15c6d6f` | `src-tauri/src/ipc/accounts.rs` |
| ② NAIL | `7f9798f` | `crates/ccg-auth/src/claude.rs` · `crates/ccg-auth/tests/m11r4_store_cas.rs` |
| ③ BANNER | `5d6b5a2` | `crates/ccg-store/src/status.rs` |

한 줄 결론: **세 자리 다 못이 섰고, 셋 다 돌연변이로 붉는 것을 직접 확인했다.**
새 기능은 하나도 안 만들었다.

---

## ① GATE — 재시도 처방이 「정책」으로만 잠겨 있었다 (`15c6d6f`)

### 무엇이 문제였나

R28g가 늘린 유일한 못 `a_snapshot_that_fails_once_is_retried_instead_of_read_as_no_children`은
손으로 만든 클로저를 `retrying()`에 먹여 **정책**(2회 실패 뒤 성공 / 빈 목록은 1회 / 상한 4)만
쟀다 — `direct_children`도 `snapshot_children`도 한 번도 안 불렀다.
확인 크리틱의 돌연변이 D(`retrying(|| snapshot_children(pid))` →
`snapshot_children(pid).unwrap_or_default()`)가 **5/5 초록(161 passed)**이었던 이유다.

### 무엇을 했나

1. **고장 손잡이**를 `snapshot_children` 첫 줄에 뒀다. 성질 셋이 다 필요했다.
   * `cfg(test)` — 제품 빌드에는 분기가 없다.
   * **스레드 지역**(`thread_local!`) — 158개 테스트가 병렬로 돌고 그중 셋이 같은 순간에
     `cancel()`을 부른다. 전역 카운터면 남의 취소가 내 고장을 먹는다. `cancel()`은 부른
     스레드에서 동기로 도므로 스레드 지역이면 구조적으로 격리된다.
   * `FaultBudget` 가드 — 못이 붉게 죽어도(assert 패닉) 잔량이 다음 테스트로 안 샌다.
2. **배선을 지나는 못 둘**:
   * `a_cancel_reaches_the_program_inside_even_if_the_first_snapshots_fail` — 기존 취소
     픽스처(`cmd.exe` 래퍼 + 손자 `PING.EXE`)에 고장 3발을 심고 `LoginSlot::cancel()`.
     길은 제품 그대로: `cancel → kill_wrapped_child → direct_children → retrying → snapshot_children`.
   * `a_snapshot_that_never_comes_back_gives_up_at_the_cap` — 고장 14발 → **정확히 4번만**
     찍고 빈 목록(취소가 안 멎는다).
3. 기존 정책 못은 그대로 뒀다(붉을 때 「정책이 깨졌나 배선이 끊겼나」가 한 줄로 갈리게).

### 곁가지〈하〉 — `Process32First/NextW` 실패 시 잘린 목록: **고쳤다**

근거: `snapshot_children`의 계약이 *"`None` = 스냅샷 자체를 못 찍었다(≠ 자식이 없다)"*인데,
훑다 깨진 판은 그때까지 모은 목록을 `Some`으로 내보내 그 계약을 깨고 있었다. 잘린 목록은
「자식이 이것뿐」과 구분이 안 되고, 그 한 번이 곧 `kill_wrapped_child`가 **일부만 죽이고
성공한 척** 돌아오는 자리다(래퍼 안의 CLI가 마침 못 읽은 뒷줄에 있으면 살아남는다 —
①이 닫은 병과 **같은 병의 다른 입구**다).

되돌림 위험도 같이 쟀다: `Process32NextW`는 목록의 끝에서도 `Err`를 주므로(MSDN이
`ERROR_NO_MORE_FILES`로 명시), 그 하나만 「끝」으로 읽는다(`walk_ended`). 만약 어떤 판에서
끝 코드가 다르면 매 스냅샷이 `None`이 되어 취소가 아무것도 못 죽이는데, **그 회귀는 기존
취소 못 둘이 즉시 잡는다**(이 트리에서 5/5 초록으로 확인). 판정 자체도 못으로 잠갔다
(`only_no_more_files_means_the_process_walk_finished` — `ERROR_BAD_LENGTH`를 「끝」으로 읽으면 붉다).

### 실측

```
HEAD (target-r28i-locks)
  cargo test -p agentcodegui --bin agentcodegui --features custom-protocol
  → 5/5 초록 · 170 passed 0 failed        (라운드 시작 기준선 161 + 내 몫 3 + 같은 트리 OPENDIR 몫 6)

돌연변이 D (target-r28i-locks-mutd · 별도 디렉터리)
  direct_children → snapshot_children(pid).unwrap_or_default()
  → 3/3 붉음 · 168 passed / 2 failed
  붉은 첫 줄(내가 그렇게 배치했다 — 사고부터 말한다):
    ★첫 스냅샷이 흔들렸다고 래퍼 안의 프로그램을 놓쳤다(pid 34636의 자식): [13040] · 남은 고장 2
    ★상한이 4가 아니다(남은 고장 13) — 취소 경로가 그만큼 멎는다
```

즉 「재시도 규칙은 단위 테스트로 잠갔다」가 이제 **처방까지** 참이다.

---

## ② NAIL — 자물쇠 **안** Blind가 무방비였고, doc이 반대로 읽혔다 (`7f9798f`)

### 무엇이 문제였나

R28g의 못은 `late_watch_tick`(자물쇠 **밖**)만 밟는데 doc은 *"자물쇠 안 경로도 같은 두
줄을 쓴다 … 어느 쪽이 파냈든 같은 값을 잰다"*고 적어 다음 사람이 「덮였다」로 읽게 했다.
실측은 정반대다.

| 무엇 | 값 |
|---|---|
| R28g 못 31주행 | 전부 `in_lock=0`(착지는 언제나 자물쇠 **밖**) |
| 이웃 통짜쓰기 12,700판(크리틱 k6) | 자물쇠 **안** Blind 262 · 자물쇠 **밖** Blind 0 |
| 자물쇠 안 두 줄만 지운 돌연변이 | `cargo test -p ccg-auth` **125 통과 0 실패** |

### 왜 확률 프로브를 안 넣었나 — 그리고 대신 무엇을 했나

자물쇠 안 `Commit::Buried`가 서려면 이웃의 열기가 `[증인 읽기 → 갈아끼우기]`(실측
50~600µs)에 들어오고 그들의 쓰기가 **갈아끼우기 직후 첫 판독 전에** 떨어져야 한다
(첫 판독이 `expect` 그대로면 그 자리에서 `Clean`으로 나간다). 크리틱의 적중률은 2.06%,
75초짜리 프로브였다. 그 모양은 게이트가 아니라 복권이다 — 실패해도 「오늘은 안 걸렸다」로
읽힌다.

그래서 **경합을 지우는 대신 순서를 잡아 줬다**: `claude::bury_rehearsal()` —
`CCG_CAS_BURY_REHEARSAL_MS`가 있을 때만 갈아끼우기 **직후** 그만큼 쉰다(**기본 0**,
없으면 `OnceLock` 한 번 읽기 · 상한 5,000ms). 그 창 동안 못 안의 이웃 스레드가 「이름이
새 inode를 가리킨다」를 보고 **걸터탄 옛 핸들**에 통짜로 쓴다. 늦춰지는 것은 잠금 보유
시간 하나뿐이고 판독·판정·되살리기·로그는 전부 제품 코드 그대로 지난다.

정직하게 적는다 — 이건 **제품 코드에 심은 테스트 손잡이**다. 같은 모양의 선례가 이 크레이트
안에 이미 있다(`cas_trace_on`의 `CCG_CAS_TRACE` · `replace.rs`의 `CASX_OLD_SWAP` /
`CASX_NO_WITNESS`). 대안 둘은 각각 더 나빴다: ⓐ 75초 확률 프로브(복권) ⓑ `#[ignore]` 프로브
(아무도 안 돌린다 = 지금과 같은 무방비).

새 못 `a_bury_the_lock_dug_up_itself_is_refused_out_loud_too`는 R28g와 **같은 여섯 걸음**
(한 세대에 같이 있은 적 없는 두 앵커)을 밟는다. 자식 프로세스인 이유 둘: 손잡이가
`OnceLock`이라 프로세스 첫 커밋 전에 서야 하고(같은 바이너리의 이웃 테스트를 300ms씩
늦추지 않으려면 프로세스가 갈려야 한다), 제품의 진단 한 줄은 stderr로 나가 같은 프로세스
에서는 읽을 수단이 없다.

### 실측

```
HEAD (target-r28i-locks)
  cargo test -p ccg-auth  → 3/3 초록 · 126 passed 0 failed   (기준선 125 + 1)
  새 못 한 판 = 1.5초. 자식이 스스로 적은 장부:
    자물쇠안=1 · 자물쇠안되살림=0 · 근거못짚음=1 · 되살릴것없음=0 · 지연=0
    → 이 못이 지난 길이 자물쇠 **안**이라는 증거(R28g 못은 여기가 늘 0이었다)
  부모가 읽은 제품 줄(자식 stderr, 1줄):
    [auth] ★ accounts.json: 이웃의 통짜 쓰기를 묻었는데 … 앵커 2행은 우리 장부에 있는데
    (장부 세대 1~5 · 후보 상한 세대 5) … 그들이 지웠다는 1개(dropme@x)가 …

돌연변이 A — 자물쇠 안 두 줄 통째 제거 (target-r28i-locks-mut2 · 별도 디렉터리)
  → 3/3 붉음. **새 못만** 붉고 R28g 못은 그대로 초록(= doc 정정이 실측으로 맞다)
    ★ 「못 짚었다」가 장부에 안 남았다 — 자물쇠 안 Blind 두 줄이 침묵으로 지나갔다

돌연변이 B — `blind_line`만 제거(카운터는 남김)
  → 붉음. 부모가 잡는다: ★ 자물쇠가 **자기 손으로 파낸** 매장이 침묵으로 지나갔다(제품 줄 0개)
  ⇒ 두 줄이 **각각** 잠겼다(카운터 = 자식 단정 · 한 줄 = 부모 단정)
```

### doc 정정

`m11r4_store_cas.rs`의 그 자리를 **사실대로** 고쳤다 — 위 실측 표를 그대로 싣고,
「그 갈래를 지나는 못은 이 파일 아래의 `a_bury_the_lock_dug_up_itself_is_refused_out_loud_too`다」로
잇는다. 이제 다음 사람이 「덮였다」로 읽을 자리가 없다.

---

## ③ BANNER — 부팅 행의 `autoResume`가 상수라 접힌 표의 출구가 사라졌다 (`5d6b5a2`)

### 무엇이 문제였나

R28g가 `hold.paused`를 진실로 만들었지만 배너 문장이 갈리는 칸은 **둘**이다. 다른 한 칸
(`autoResume`)은 `empty_lite`의 상수 `true`였고, 행이 거기서 나오는 판이 실제로 있다 —
`status.json`에 그 채팅 행이 없을 때(마이그레이션 직후 · `status.json` 유실 · 이 홈에서
한 번도 안 돈 채팅). 그러면 12발을 태우고 엔진이 자동을 접은 표가 부팅 첫 프레임에서
`ready:true` + `autoResume:true`로 서고, 렌더러의 갈림(`LimitHoldBar`의
`press = managed.ready && managed.auto !== true`)이 **뒤집힌다**.

### 처방 — 상수가 진실을 담게 했다

`row_from_disk`가 파일에서 읽은 `hold`가 접혀 있으면 `autoResume`도 접는다. 규칙은
런타임 쪽과 **글자 그대로 같다** — `engine::lite::build`의
`auto_resume = rt.auto_resume() && !hold.auto_paused`. 부팅엔 런타임이 없으니 앞항은 행이
들고 온 값(스토어 행이면 마지막 lite · 없으면 기본값 `true`)이고 뒷항은 방금 파일에서 읽은
사실이다. 접힘은 **디스크가 아는 진실**이라 행의 출처와 무관하게 이긴다(규약 3의 정신).
`empty_lite`의 상수에는 「대기표를 모르는 기본값」이라는 근거와 그것을 접는 자리를 적었다
(R28g까지 그 주석에는 근거가 없었다).

### 재현 배치를 못으로 — 재는 것은 필드가 아니라 **화면 문구**다

`a_folded_table_still_gets_the_button_in_a_home_status_json_never_saw`:
`status.json`이 **없는** 홈 + 채팅 파일만 두고 `load_boot`을 돌린 뒤, 렌더러 실번들과 같은
식(`press` · `budgetLanding`)으로 문장을 고른다.

| 배치 | 처방 전(대조군) | 처방 후 |
|---|---|---|
| `paused:true` · `fires:12` · `ready:true` · status.json 없음 | `autoResume:true` → 「한도가 풀렸어요 — **곧 이어서 계속해요**」 · 버튼 없음 | 「이 한도 창에서 자동으로 **12번** 이어서 보냈는데 계속 막혔어요 — **눌러서 이어가기**」 · 버튼 있음 |
| `paused:false` · `fires:3` · `ready:true`(대조군) | 「곧 이어서 계속해요」 | **그대로**(회귀 0 — 곧 엔진이 쏠 표에 버튼을 주면 그게 이중 전송의 입구다) |

### 실측

```
HEAD (target-r28i-locks)  cargo test -p ccg-store → 3/3 초록 · 92 passed 0 failed   (기준선 91 + 1)
대조군(처방 한 덩이 제거 · target-r28i-locks-ctl3 · 별도 디렉터리)
  → 91 passed / 1 failed. 붉은 첫 줄이 그 거짓말 그대로다:
    ★★ 부팅 첫 프레임의 문장이 거짓이다(행: … "autoResume":true, "hold":{…,"fires":12,"paused":true})
회귀: cargo test -p agentcodegui --bin agentcodegui --features custom-protocol → 170 passed 0 failed
```

**값은 한 발도 안 깎았다** — 예산 12발 · `MIN_WORK` · 재시작을 넘는 예산 · 밤샘 7발 ·
헛발질 2발 · 60시간 전부 그대로다(상수 한 줄도 안 만졌다). 훅(`app/src/lib/limitResume.ts`)은
**무변경**이라 재실행 의무는 없지만, 회귀 대조로 한 번 돌렸다:
`node scripts/poc-limit-resume.mjs` → **PASS · 357 통과 0 실패**.

---

## 4. 만진 파일 / 안 만진 것

만진 것(전부 내 경계 안):

```
src-tauri/src/ipc/accounts.rs              ①  (+185 −5)
crates/ccg-auth/src/claude.rs              ②  (+34)
crates/ccg-auth/tests/m11r4_store_cas.rs   ②  (+195 −2)
crates/ccg-store/src/status.rs             ③  (+101)
docs/parity-fix-locks-r1.md                이 파일
```

안 만졌다: `src-tauri/src/main.rs` · `src-tauri/src/win/**` ·
`src-tauri/src/ipc/{system,app_meta,unified,mod}.rs` · `app/src/App.tsx` ·
`app/src/api/*`(OPENDIR) · `src-tauri/src/engine/talk.rs` · `docs/m10-*`(R28h) ·
`docs/critic/final-parity-*` · `bench/**` · `progress/**`(아무도 만지면 안 되는 것).
`src-tauri/src/engine/lite.rs` · `app/src/lib/limitResume.ts` · `scripts/poc-limit-*.mjs`는
**내 소유지만 손댈 이유가 없어 안 건드렸다**(③의 규칙은 이미 `lite.rs`에 있고, 부팅 행이
그것을 안 따르던 것이 병이었다).

미추적 `crates/ccg-engine/tests/probe_wfire_crit.rs` · `probe_wfr2.rs`(테스트 18개)는 남의
계기라 **커밋하지 않았고** 아래 수에서도 뺐다.

## 5. 재현 명령

```bash
# ① — 배선 못 (HEAD는 초록, 돌연변이 D는 붉어야 한다)
CARGO_TARGET_DIR=<격리> cargo test -p agentcodegui --bin agentcodegui --features custom-protocol
#   돌연변이: accounts.rs의 direct_children 본문을 snapshot_children(pid).unwrap_or_default()로
#   (반드시 **다른** CARGO_TARGET_DIR에서)

# ② — 자물쇠 안 Blind (1.5초)
CARGO_TARGET_DIR=<격리> cargo test -p ccg-auth --test m11r4_store_cas -- \
  --exact a_bury_the_lock_dug_up_itself_is_refused_out_loud_too --nocapture
#   돌연변이: claude.rs의 `Verdict::Blind(w) => { REFUSED…; unattributed = …; break }` 두 줄

# ③ — 부팅 행의 문구
CARGO_TARGET_DIR=<격리> cargo test -p ccg-store -- --nocapture \
  a_folded_table_still_gets_the_button_in_a_home_status_json_never_saw
#   대조군: row_from_disk의 `if hold.paused { autoResume=false }` 한 덩이 제거

node scripts/poc-limit-resume.mjs        # 357 통과
```

## 6. 함정·환경에 대해 (다음 사람이 알아야 하는 것)

* **CDP 포트·실앱**: 이 라운드는 앱을 한 번도 안 띄웠다(세 항목 다 크레이트 못이다).
  `taskkill /IM`류는 한 번도 안 썼고, 스폰한 자식은 취소 못이 만든 `cmd.exe`/`PING.EXE`와
  ②의 테스트 자식뿐이며 전부 그 못이 직접 거뒀다.
* **실계정**: 실홈(`%USERPROFILE%\.agentcodegui`)은 읽지도 쓰지도 않았다. `CCG_HOME`을
  만지는 Rust 못은 전부 `ccg_store::testhome::take()` 증표를 든다(②의 자식은 부모가 넘긴
  홈이 `r28i-inlock`을 포함하는지 스스로 단정한다). 네트워크 0건(`CCG_NO_NET=1`).
* **기준 결과 파일**: `bench/results/*` · `bench/shots/*/report.json` · `docs/critic/*.json`
  한 개도 안 건드렸다.
* **같은 트리의 이웃**: 빌드 중 한 번 `app_meta.rs`가 `super::ch::APP_OPEN_DIRECTORY`를
  못 찾아 깨졌다 — OPENDIR가 두 파일을 저장하는 **중간 상태**를 cargo가 읽은 것이고,
  1분 뒤 그대로 다시 돌리니 초록이었다. 내 변경과 무관하다(그 파일들은 내 경계 밖이다).
* **★디스크**: `C:`가 한때 **100% (0바이트 남음)**이 되어 `cargo test -p ccg-store`가
  *"디스크 공간이 부족합니다 (os error 112)"*로 죽었다. 원인은 지난 라운드들이 남긴
  `target-*` 디렉터리 **75개**다(`target` 하나만 23G · `target-acct` 7G · …).
  **나는 내가 만든 셋만 지웠다**(`target-r28i-locks-mutd` · `-ctl3` · `-mut2`) — 남의
  라운드 디렉터리는 하나도 안 건드렸다. 지금 여유는 ~27G고, 다음 라운드가 돌연변이
  디렉터리를 두엇 더 만들면 다시 바닥난다. **누군가는 죽은 라운드의 target을 정리해야 한다.**

## 7. 미완 / 안 한 것

* **`cargo test --workspace`**: **exit 0 · 816 passed / 0 failed / 13 ignored**(34개 테스트
  바이너리). 기준선 805 대비 +11 = 내 몫 5(①3 · ②1 · ③1) + 같은 트리 OPENDIR 몫 6.
  이 트리에는 이웃의 미커밋 변경이 함께 있으므로 총계는 내 몫만의 값이 아니다 —
  판정 기준은 아래 크레이트별 표다.
* ②의 손잡이(`CCG_CAS_BURY_REHEARSAL_MS`)는 **테스트 전용**이다. 제품에서 켜면 잠금 보유가
  그만큼 늘어난다(그래서 상한 5,000ms를 걸고, 켜지면 stderr에 한 줄을 남긴다). 이걸
  「제품 코드 오염」으로 볼 수 있다는 것을 안다 — §②에 대안 둘을 왜 버렸는지 적어 뒀다.
* ①의 곁가지는 **고쳤지만**, 「훑다 깨진 판」 자체를 실물로 재현하는 못은 없다
  (`Process32NextW`를 밖에서 실패시킬 수단이 없다). 대신 그 판정 함수(`walk_ended`)를
  두 코드로 직접 잠갔다. 이건 정책 못이고 배선 못이 아니다 — 정직하게 적어 둔다.

| 크레이트 | 라운드 시작 | 지금 | 차이 |
|---|---|---|---|
| `agentcodegui` (`--bin agentcodegui --features custom-protocol`) | 161 | 170 | +3(내 몫) +6(OPENDIR 몫, 같은 트리) |
| `ccg-auth` | 125 | 126 | +1 |
| `ccg-store` | 90~91 | 92 | +1 |
