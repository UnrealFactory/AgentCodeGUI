# R28b 「ACCT」 확인 크리틱 R3 — 판정문

- 대상: `feature/3.0.0-beta` / **`5e1dae7`**(R28b ACCT 수정 R3 · 14파일 +1216/−62)
  (측정 중 GIT 갈래가 `7c1280f`를 올렸지만 바뀐 파일은 `docs/critic/r28b-git-critic-r5.md`
  하나뿐이라, 내가 빌드한 트리는 ACCT R3 코드 그대로다 — `git diff --name-only 5e1dae7..HEAD`로 확인)
- 방식: 빌더 보고서·커밋 메시지를 **근거로 안 쓴다.** 새 트리에서 다시 빌드하고, 실 exe를
  띄워 전부 다시 쟀다. 빌더 하네스가 안 밟는 자리는 **레포 밖 프로브**로 따로 눌렀고,
  「못이 헛못인가」는 **수정 전 빌드에 같은 못을 겨눠** 확인했다.
- 격리: `CARGO_TARGET_DIR=target-critacct3`(새로 판 트리) ·
  `CCG_HOME` = `%TEMP%\ccg-acct-live-critr3*` · `%TEMP%\ccg-critacct-r3\homes\*` ·
  CDP **9601~9607 · 9611~9614 · 9621~9622 · 9631 · 9641~9647**(+ `poc-account-switch`가
  스크립트에 박아 둔 9481~9486) · 전 주행 `CCG_NO_NET=1` + 합성 계정(`ccg-auth-probe seed`)
  → **실 HTTP 0건 · 실계정 토큰 열람 0회**.
- 종료는 **내가 spawn한 PID 트리만**(`killTree`). 이름 기반 kill **0회** — 사용자 실앱
  `…\Programs\AgentCodeGUI\AgentCodeGUI.exe` 5개(PID 6644·12924·23792·24836·26924)는
  주행 전후로 **같은 PID 그대로**고, 내 exe 고아는 0건이다.
- 빌드: `cargo build --release --features custom-protocol` + `ccg-fakecli`(`--features fakecli`)
  + `ccg-auth-probe`(`--features cli`). 빌더의 `target-acctr3`·R2 크리틱의 `target-critacct2`는
  **안 건드렸다**(후자는 대조군으로 **읽기만** 했다).

## 판정: **불합격 (경계선 — G1은 진짜로 닫혔다. 같은 문장이 반대 방향으로 깨진다)**

**G1은 종결이다.** 빌더가 옮긴 문(값을 지운 자가 알린다)은 실제로 열린다. 그리고 그 못이
헛못이 아니라는 것을 **수정 전 빌드로 직접 확인**했다 — 같은 하네스, 같은 시나리오, 4건 FAIL.

그런데 §3의 「사용 중」은 **다른 방향으로** 여전히 틀린다. R1은 *"늘 켜져 있는 경고"*로
불합격이었고 R2는 *"지워도 안 걷히는 경고"*로 불합격이었다. R3에서 남은 것은 그 반대다 —
**조회 한 번(`chats:get`)이 살아 있는 경고를 지운다.** 실 exe에서 화면까지 재현했다:
같은 계정을 문 자리가 둘인데 칩이 **사라지고**, 그때 그 채팅의 CLI는 PID를 달고 살아 있다.
「사용 중」을 켜는 세 자리를 R2가 만들 때 세워 둔 「부팅 장전은 한 번」 표식(`LOADED`)이
**세워지기만 하고 아무도 안 읽는다.**

| 절 | 빌더 주장 | 이 라운드의 실측 |
|---|---|---|
| **G1** 삭제 축(본채팅) | 8/8 통과 | **재현 초록.** 브로드캐스트 7→8 · 행 `[c-b]` · 칩 `[]` · 런타임 `["c-b"]` ✔ |
| G1 대조군(6891372) | 4건 FAIL | **내가 직접 겨눠 재현.** 7→7 · 「사용 중 · **다른 자리**」 · 좀비 `["c-a","c-b"]` ✔ |
| G1 멀티 축(`ma:save`) | 「전파했다」(못 없음) | **내가 못을 새로 박아 확인 — 초록.** 「사용 중 · 1번 자리」 → 세션 삭제 → 칩 `[]` · 런타임 `[]` ✔ |
| G1 헛 브로드캐스트 | 「지운 게 없으면 즉시 반환」 | **재현 초록.** 평상시 저장 5회 = `chat:status` **0건**(7→7) ✔ |
| G1 배리어 비용 | 「최대 3초」 | **실측 4ms**(상주 CLI 2개가 붙은 판에서 삭제 저장 1회 왕복) ✔ |
| F1~F5 · N1 · N2 | R2에서 초록 | **전부 재현 초록**(아래 표) ✔ |
| ★ **G2**(신규) | — | ✗ **깨진다.** `chats:get` 1회 → 살아 있는 채팅의 `account`가 `null` · 칩 소멸 |

---

## 초록 — 전부 이 라운드에서 직접 잰 수치

| 항목 | 실측 | 빌더 주장과 |
|---|---|---|
| `npm run typecheck`(node·web) + `typecheck:app` | **3종 초록** | 일치 |
| `cargo test -p ccg-store` | **82 통과 · 0 실패** | 일치 |
| `cargo test -p agentcodegui` | **143 / 0** | 일치 |
| `cargo test -p ccg-auth` | 84+0+0+14+2+1+1+0 = **102 / 0** | 일치 |
| `cargo test -p ccg-auth --features net` | 94+1+6+14+2+1+1+0 = **119 / 0** | 일치 |
| `cargo test --workspace` | **704 / 0** | 일치 |
| `poc-acct-live --exe=target-critacct3/… --out=-critr3 --port=9601` | **24항목 전부 통과**(A 6 · B 3 · C 4 · D 3 · E 8) | 일치 |
| `poc-acct-store` | **`ok` 25줄** | 일치 |
| `poc-limit-resume` | **164 / 0** | 일치 |
| `poc-store-fanout` | **`ok:` 34줄** | 일치 |
| `poc-account-switch --exe=… --out=-critacctr3` | **시나리오 6개 PASS · findings 0** | M11 자동 전환 무회귀 |

### 대조군 — 못이 헛못이 아니다 (내가 직접 겨눴다)

R2 크리틱이 남긴 **수정 전 빌드**(`target-critacct2`, 커밋 6891372)에 **지금 레포의 하네스**로
같은 시나리오를 쐈다(레포·`.git` 무접촉 — exe만 읽었다):

```
node scripts/poc-acct-live.mjs --exe=target-critacct2/release/agentcodegui.exe \
     --only=del --out=-critr3ctrl --port=9641

  X E-브로드캐스트  ★ 지웠는데 chat:status가 한 번도 안 나갔다 (7 → 7)
  X E-유령 행       ★ [{c-a, done, account:one@ccg.test}, {c-b, …}]
  X E-유령 칩       ★ ["사용 중 · 다른 자리"]
  X E-런타임 회수   ★ ["c-a","c-b"]   (좀비 CLI)
  ❌ FAIL — 4건
```

같은 못이 **수정 후 빌드에서는 8/8 통과**다. 빌더가 적은 「7 → 7 · 사용 중 · 다른 자리」는
글자 그대로 재현됐다 — G1은 진짜 결함이었고 진짜로 닫혔다.

### 독립 프로브 (레포 밖 · `%TEMP%\ccg-critacct-r3\probe.mjs` · `attack.mjs` · `x3.mjs`)

| 프로브 | 실측 |
|---|---|
| **S1** §1 첫 페인트 | 계정 3개 · 디스크 캐시 3분 전(TTL 밖) · Account 탭 클릭 → 게이지까지 **2.4ms** |
| S1 콜드 부팅 | 부팅 봉투 = `{cachedOnly:true}` → `{priority:"one@…",warm:true}` (실조회 0) |
| S1 탭 오픈 | 탭을 열며 나간 조회 = `{cachedOnly:true}` **한 건**(2 → 3) |
| S1 여닫이 TTL | 설정을 3번 여닫아도 **+3건뿐**(3 → 6, 전부 `cachedOnly`) |
| **S2** §3 두 자리 | `["c-a","c-b"]` · picker 한 줄 = `one현재 \| 남음 5시간 90% · 주간 80% \| 사용 중 · 첫 채팅` |
| S2 세션 종료 | 삭제 후 status `[c-b]` · 칩 `null` · **12초 무입력 브로드캐스트 8→8**(이미 걷혀 있었다) |
| S2 busy 아닌 상주 | 턴이 끝난(`done`) 채팅도 계정을 문다 ✔ |
| **S3** §4 순서 | 「맨 위로」(two) → 목록 `two,one,three` · 디스크 동일 · `defaultEmail:"two@ccg.test"` |
| S3 새 채팅 | 칩 `… · two` · **실제 실행** `RAN-two_ccg.test` |
| S3 파생 기본 「현재」 | 바인딩 없는 채팅에서도 「현재」가 **맨 위 한 줄에만** |
| **S4** 실패 주입 | 캐시 0 + `CCG_NO_NET` → 행 **3/3** · 실패 문구 **3/3** · 「다시 시도」 **3/3** |
| **X1** §3 멀티 축 | 패널 대화가 계정을 문 채 `ma:save`로 지워짐 → 브로드캐스트 4→5 · 행 소멸 · 칩 `[]` · 런타임 `[]` |
| **X2** 배리어 비용 | 상주 CLI 2개 · 삭제 저장 1회 왕복 **4ms**(`REPLY_TIMEOUT` 3000ms 대비) |
| **X3** 헛 브로드캐스트 | 지운 게 없는 저장 **5회 = 0건**(7→7 · 26ms) |
| **X3(신규)** `chats:get` | ✗ **아래 G2** |
| N1 두 창 합류 | `[N1] 두 훑기가 실제로 물어본 횟수 = 3`(계정당 1건) — `-p agentcodegui` 안에서 실측 |
| N2 회전 금지 구역 | `[N2] 워밍 = [("two@…", true)]` · `사용자 조회 = 3건 전부 false` |
| §1 1200ms 직렬 | `the_global_gate_actually_spaces_the_calls` — **1.2005s · 1.2001s**(규약 1.2s) |

체크리스트 4번의 **기록 요구는 충족**이다: `docs/renderer-divergence.md` §6.6에 ★R3 정정
(문이 `Op::Dispose`가 아니었다 + 세 자리 표)이 있고, §6.5·§6.7의 R2 정정도 그대로 있다.
보고서는 `docs/parity-fix-acct-r1.md` R3절(§0~§5).

---

## 결함

### G2 ★ §3 — **조회 한 번이 살아 있는 「사용 중」을 지운다**

`chats:get`은 **읽기 채널**이다. 그런데 그 한 번이 셸의 상태 맵을 통째로 디스크 스냅샷으로
갈아치우고, 그 과정에서 **살아 있는 런타임의 `account`·`panelId`를 걷어낸다.**

실 exe · 계정 2개 · 채팅 둘(`c-a`「첫 채팅」·`c-b`「둘째 채팅」, 둘 다 `one@ccg.test`).
둘 다 턴을 한 번씩 돌린 뒤, **`chats:get`을 한 번** 부르고(= `App.tsx`가 마운트마다 하는 그 한 줄),
그 다음 REPLACE가 나가게 `c-b`에 턴을 하나 더 보냈다:

```
조회 전   status = [{c-a, acct:one@ccg.test}, {c-b, acct:one@ccg.test}]
          picker 칩 = ["사용 중 · 첫 채팅"]

chats:get 1회 (읽기만 한다)

다음 REPLACE 뒤
  ★       status = [{c-a, acct:null}, {c-b, acct:one@ccg.test}]
  ★       picker 칩 = []                       ← 경고가 조용히 사라졌다
          engine:debug = [{c-b, pid:30112, Idle}, {c-a, pid:13824, Idle}]
                                                 ↑ c-a의 CLI는 **살아 있다**
```

기제(코드로 확정):

1. `chats_v3::read_chats`(= `chats:get`의 본체)는 마지막에 **무조건** `status::load_boot(&ids)`를
   부른다(`chats_v3.rs:467`).
2. `load_boot`는 `status.json`을 디스크에서 다시 읽어 행마다 `strip_runtime_only`
   (`account`·`panelId` 제거 — R2가 F1을 닫으려고 넣은 그 줄)를 적용하고,
   `busy=false` · `ask="none"` · `bgActive=false` · `working|analyzing → idle`을 강제한 뒤
   **`st.map = out`으로 메모리 맵을 통째로 덮는다**(`status.rs:164-168`).
3. 그 자리에 「부팅 장전은 한 번」 표식이 있다 — `LOADED.set(())`(`status.rs:162`). 그런데
   **`LOADED`를 읽는 코드가 레포에 한 줄도 없다**(`grep -n LOADED status.rs` = 정의 89행,
   대입 162행, 끝). 문을 만들어 두고 경첩을 안 단 것이다.
4. 걷힌 행은 **스스로 안 돌아온다.** 허브는 lite가 *바뀔 때만* `status::set`을 부르는데
   (`hub.rs:1497` `if same { return }`), 턴이 끝난 채팅의 lite는 다시 안 바뀐다. 그래서
   그 채팅은 **다음 턴을 돌 때까지** 계정을 안 문 것으로 보인다.

피해:

- §3이 막으려던 바로 그 사고가 난다 — 사용자가 **이미 타고 있는 계정**으로 다른 대화를
  갈아탄다. 두 대화가 한 5시간 창을 나눠 쓰다 둘 다 막히는, R28 후속 §3의 존재 이유다.
- R1 판정문의 문장(*"늘 켜져 있는 경고는 없는 것보다 나쁘다"*)에는 쌍둥이가 있다:
  **조용히 꺼지는 경고도 없는 것보다 나쁘다.** 사용자는 「사용 중」이 없으면 *비어 있다*로
  읽는다(그게 이 칩의 계약이다 — `poc-acct-store` F: *"죽은 채팅이 계정을 물고 있다고
  말하면 안 된다"*).
- 같은 덮어쓰기가 `ask`도 `"none"`으로 되돌린다. **승인 대기(`AwaitingUser`)는 lite가
  안 바뀌는 상태**라(계약상 타임아웃이 없다) 그 행은 되돌아오지 않는다 — 다른 채팅의
  전이가 REPLACE를 낼 때마다 그 대화는 「물어볼 게 없다」로 나간다. 이 축은 이번에
  코드로만 확인했고 화면으로는 안 쟀다(§3 밖이라 결함으로는 안 센다).

**크기(정직하게)** — 앱 안에서 `chats:get`을 부르는 자리는 `App.tsx` 둘뿐이고
(`App.tsx:665` 부팅 복원 · `App.tsx:1000` `chat:status` 따라잡기) 둘 다 **마운트 1회**다.
그러니 사용자가 닿는 경로는 *메인 창이 다시 마운트되는 순간* — 크래시 복구(`crash.rs`가
브라우저 프로세스 사망 뒤 메인 창을 재생성한다. Rust 프로세스는 살아 있으므로 런타임과
CLI는 그대로다) · ErrorBoundary 리셋이다. 부팅 첫 호출은 런타임이 없어 무해하다.
**부팅 재장전(§5.8)이 만든 런타임과 `chats:get`의 순서**는 이번에 안 쟀다 — 재장전이
먼저면 그 채팅도 같은 자리에서 걷힌다(추정이므로 결함 크기에 안 넣는다).

- **R3가 낸 회귀는 아니다.** 지우는 줄은 R2의 F1 수정(`strip_runtime_only`)이고,
  `read_chats → load_boot` 연결은 그보다 앞이다. R1·R2 두 판정문이 **둘 다 놓쳤다**
  (R2 프로브 S2는 세션 안에서 `chats:get`을 한 번도 안 불렀다). 갈래가 아직 열려 있고
  이 문장이 이 갈래의 계약이므로 이 라운드에 넣는다.

회귀 못으로: **「같은 계정을 문 자리 둘 → `chats:get` 1회 → 다음 REPLACE → 칩이 그대로」**.
`poc-acct-live` A(재시작 축)·E(삭제 축) 둘 다 이 결함을 **100% 통과한다**.

---

## 사소 · 부기

- **`#[must_use]` 관문이 세 줄에서 새고 있다.** `crates/ccg-store/src/bin/ccg_migrate.rs`
  85·98·109행이 `write_chats`·`chats_save`·`ma_save`의 반환을 그냥 버려
  `cargo build -p ccg-store --features cli --bin ccg-migrate`가 **경고 3건**을 낸다.
  기본 피처로는 그 바이너리를 안 지어서 빌더의 `cargo test -p ccg-store`(82/0)에는 안 보인다.
  하네스 전용 CLI라 동작 피해는 없다(거둘 런타임이 없다) — 다만 「구조적으로 막는다」는
  설명이 그 세 줄에서 사실이 아니다.
- **`ma_save` 전파에 단위 못이 없다.** R3가 만진 `legacy_bridge_tests.rs` 10곳은 전부
  `let _ = …`로 반환을 버리는 수정이고, *돌려주는 목록이 맞는가*를 보는 못은
  `chats_v3` 쪽 둘(`a_save_that_deletes_a_chat_says_which_one` ·
  `deleting_a_chat_that_never_ran_still_counts`)뿐이다. 멀티 축은 **실 exe로 내가 대신
  확인했고 초록**이다(위 X1) — 결함으로는 안 세지만, 그 초록은 지금 하네스에 남아 있지 않다.
- **배리어 비용은 기우였다.** 빌더가 「남은 리스크」로 적은 3초는 실측 **4ms**다
  (상주 CLI 2개 + 삭제 1건). 평상시 저장 5회는 `chat:status`를 **한 건도** 안 낸다.
- 추가 채팅 창(`SessionWindow`)의 §3 칩 부재는 `renderer-divergence.md` §6.6에 한계로
  적혀 있다 — 이번에도 결함으로 안 센다(그 창은 `chats:get`을 부르지도 않는다).
- F2의 대가(`PROJECTED`를 합의값으로 넓히면 *되돌림*과 *낡은 사본*을 원리적으로 못 가른다)는
  이번에도 재현식을 못 만들었다 — R2와 같이 **위험으로만** 남긴다.
- `poc-account-switch`는 CDP 포트 **9481~9486**을 스크립트에 박아 쓴다(`--port` 없음).
  세 갈래가 동시에 돌리면 겹친다 — 이번 주행은 다른 갈래와 시각이 안 겹쳐 통과했다.

## 수정 라운드에 넘기는 것

1. **G2** — 「부팅 장전」은 **부팅에만** 돌아야 한다. 이미 세워 둔 `LOADED` 표식을 실제로
   읽어(`load_boot`이 두 번째부터는 `snapshot()`을 돌려주게) 조회가 살아 있는 맵을 못 덮게
   하거나, `chats:get`이 디스크 값을 **병합**만 하게 한다(런타임 전용 두 키는 메모리가 이긴다).
   F1은 *"R1이 써 둔 파일이 유령을 되살리지 않는다"*였고, 그건 **첫 장전 한 번**으로 충분하다.
2. 회귀 못은 **조회 축**으로 한 줄 더: 재시작 축(A)·삭제 축(E) 둘 다 이 결함을 못 잡는다.

## 부기 — 이 패스가 지킨 규율

- 레포 코드·하네스 **0줄 수정**. 프로브 셋(`probe.mjs`·`attack.mjs`·`x3.mjs`)은 전부 레포 밖
  (`%TEMP%\ccg-critacct-r3\`). `reset`·`checkout`·`stash`·`git add -A` **0회**.
- 남의 갈래 미커밋·미추적 파일 무접촉. `git diff --stat HEAD -- docs/critic/ bench/` = **빈 출력**
  (추적 파일 훼손 0).
- 기준 결과 파일 무훼손 — 산출물은 `--out`으로 갈랐다:
  `docs/critic/acct-live-critr3.json`(24항목) · `acct-live-critr3ctrl.json`(대조군 4 FAIL) ·
  `m11-r1-switch-critacctr3.json`(6시나리오). 빌더의 `acct-live-r3*.json`·
  `m11-r1-switch-acctr3.json`은 안 건드렸다.
- 빌드 격리 `target-critacct3`(새로 판 트리). `target-acctr3`(빌더) 무접촉,
  `target-critacct2`(R2 크리틱)는 대조군으로 **읽기만**. 공용 `target/`에는 아무것도 안 지었다.
- 이름 기반 kill **0회** — 사용자 실앱 5개 프로세스는 주행 전후 같은 PID로 그대로다.
