# R28b 「ACCT」 확인 크리틱 R2 — 판정문

- 대상: `feature/3.0.0-beta` / **`6891372`**(R28b ACCT 수정 R2 · 24파일 +2003/−51)
- 방식: 빌더 보고서·커밋 메시지를 **근거로 쓰지 않는다.** 전 항목을 새로 빌드하고, 실 exe를
  띄워 다시 쟀다. 빌더가 안 밟은 자리는 **레포 밖 독립 프로브**를 따로 세워 눌렀다.
- 격리: `CARGO_TARGET_DIR=target-critacct2`(새로 판 트리) · `CCG_HOME=%TEMP%\ccg-acct-live-critr2`
  및 `%TEMP%\ccg-critacct-r2\homes\*` · CDP **9541~9556**(남의 갈래 9481~9499·9486~9491과 안 겹친다) ·
  전 주행 `CCG_NO_NET=1` + 합성 계정(`ccg-auth-probe seed`) → **실 HTTP 0건 · 실계정 토큰 열람 0회**.
  종료는 **내가 spawn한 PID 트리만**(`killTree`) — 주행 전후로 사용자 실앱
  `…\Programs\AgentCodeGUI\AgentCodeGUI.exe` 5개 프로세스는 그대로 살아 있다. 이름 기반 kill 0회.
- 빌드: `cargo build --release --features custom-protocol` + `ccg-fakecli`(`--features fakecli`) +
  `ccg-auth-probe`(`--features cli`). 빌더가 쓰던 `target-acct`는 **안 건드렸다**.

## 판정: **불합격 (경계선 — 한 항목이 실측으로 깨진다)**

F1~F5·N1·N2 **일곱 중 여섯은 진짜로 닫혔다.** 실 exe로 다시 재서 그렇다(아래 표). N1은 빌더의
「6회 → 3회」를 **내가 직접 레인을 도려낸 대조군**으로 재현했다(추출본에서만 — 레포 무접촉).

그런데 **F1이 절반만 닫혔다.** 빌더가 F1-b라고 적은 문장 —

> `hub::Op::Dispose` → `status::clear_runtime`이 마지막 lite를 계정 없이 다시 앉힌다

— 은 **사용자가 닿을 수 있는 어느 삭제 경로에서도 발동하지 않는다.** 실 exe 실측: 채팅을 지우면
그 대화의 「사용 중」 칩이 **그 세션 내내 남는다**(다음 턴이 나기 전까지 브로드캐스트 0건).
R1이 실패시킨 그 문장 — *"늘 켜져 있는 경고는 없는 것보다 나쁘다"* — 이 재시작 축에서는 사라졌고
**삭제 축에 그대로 남아 있다.** 체크리스트 2번의 「세션 종료 시 소멸」이 여기서 깨진다.

| 절 | 빌더 주장 | 이 라운드의 실측 |
|---|---|---|
| F1 「사용 중」 재시작 | 종료→재기동에 0건 | **재현 초록.** 오염된 `status.json`을 먹여도 배지 `["기본 · 맨 위"]` ✔ |
| **F1-b** Dispose가 계정을 뗀다 | 「같은 세션 안에서도 걷힌다」 | ★ **깨진다.** 채팅 삭제 후에도 `chat:status`에 `account` 잔존 · 칩 「사용 중 · 다른 자리」 |
| F2 되돌리기 | 턴 없이 재시작해도 원 계정 | **재현 초록.** 디스크 `one@ccg.test` · 재시작 실행 `RAN-one_ccg.test` ✔ |
| F3 마이그레이션 첫 세션 | 목록·새 채팅·실행 셋 다 3번째 | **재현 초록** ✔ |
| F4 본채팅 자리 이름 | 「N번 자리」 아님 | **재현 초록.** `panelId=null` · 칩 「사용 중 · 첫 채팅」 ✔ |
| F5 「다시 시도」 | 격리를 넘는다 | **재현 초록.** 봉투 `{"priority":…,"retry":true}` · 조회 3→4 ✔ |
| N1 두 창 합류 | 6회 → 3회 | **대조군까지 재현.** 원본 3 / 레인 도려낸 판 6 ✔ |
| N2 회전 금지 구역 | 구역 안은 시작조차 안 함 | **재현 초록.** 밖 `Disabled` / 안 `RotateForbidden` ✔ |

---

## 초록 — 전부 이 라운드에서 직접 잰 수치

| 항목 | 실측 | 빌더 주장과 |
|---|---|---|
| `npm run typecheck`(node·web) + `typecheck:app` | **3종 초록** | 일치 |
| `cargo test -p ccg-auth` | 84+0+0+14+2+1+1 = **102 통과 · 0 실패** | 일치 |
| `cargo test -p ccg-auth --features net` | 94+1+6+14+2+1+1 = **119 통과 · 0 실패** | 일치 |
| `cargo test -p ccg-store` | **79 통과 · 0 실패** | 일치 |
| `cargo test -p agentcodegui` | **143 통과 · 0 실패** | 일치 |
| `cargo test --workspace` | **699 통과 · 0 실패**(ccg-engine 64 등 포함) | 빌더는 안 셌다 |
| `node scripts/poc-acct-store.mjs` | **`ok` 25줄 전부 통과** | 일치 |
| `node scripts/poc-limit-resume.mjs` | **164 통과 · 0 실패** — M11 훅 경로 무회귀 | 일치 |
| `node scripts/poc-store-fanout.mjs` | **`ok:` 34줄 전부 통과** | ✗ 「10항목」은 인용 오류(회귀는 아니다) |
| `poc-account-switch --exe=target-critacct2/… --out=-critacctr2` | **시나리오 6개 PASS · findings 0** | M11 자동 전환 무회귀 |
| `poc-acct-live --exe=… --out=-critr2 --port=9541` | **16항목 전부 통과** | 일치 |

`poc-acct-live`의 F1 못은 크리틱이 요구한 모양 그대로 섰다 — 앱이 쓴 진짜 `status.json`(209B,
`"account"` 0건)에 **두 키를 도로 끼워 넣어 「R1이 써 둔 홈」을 만든 뒤** 재기동해도
`status.account=null` · 배지 `["기본 · 맨 위"]`다. 쓰기 쪽만이 아니라 **읽기 쪽 청소가 실제로 돈다.**

### 이 라운드가 새로 세운 프로브 (레포 밖 · `%TEMP%\ccg-critacct-r2\probe.mjs`)

빌더 하네스가 안 밟는 체크리스트 항목을 실 exe로 직접 쟀다.

| 프로브 | 실측 |
|---|---|
| **S1** §1 첫 페인트 | 계정 3개 · 디스크 캐시 3분 전(TTL 밖) · Account 탭 클릭 → 게이지까지 **2.2ms** |
| S1 콜드 부팅 | 부팅 봉투 = `{cachedOnly:true}` → `{priority:"one@…",warm:true}` (실조회 0) |
| S1 탭 오픈 | 탭을 열며 나간 조회 = `{cachedOnly:true}` **한 건** |
| S1 여닫이 TTL | 설정을 3번 여닫아도 늘어난 조회는 `cachedOnly` **3건뿐**(실조회 0 — 60초 TTL 무회귀) |
| **S4** 실패 주입 | 캐시 0 + `CCG_NO_NET` → 계정 행 **3/3 보존** · 실패 문구 **3/3** · 「다시 시도」 **3/3** |
| **S3** §4 순서 | 「맨 위로」(two@) → 그 세션의 목록 `two,one,three` · 디스크 순서 동일 · `defaultEmail:"two@ccg.test"` 되채움 ✔ |
| S3 새 채팅 | chip `… · two` · 실제 실행 `RAN-two_ccg.test` |
| S3 파생 기본 「현재」 | 바인딩 없는 채팅에서도 「현재」가 **맨 위 계정 한 줄에만** 선다 |
| **S2** §3 자리 둘 | 같은 계정을 문 자리 = `["c-a","c-b"]` · picker 한 줄에 `현재` + `사용 중 · 첫 채팅` **동시** ✔ |
| S2 busy 아닌 생존 | 턴이 끝난(`done`·프로세스 없음) 채팅도 계정을 문다 ✔ (`Resident`+생존 축은 단위 못 `only_a_dead_resident_stops_holding_the_account`) |
| **S2 세션 종료** | ✗ **아래 G1** |

### N1 — 빌더의 대조군을 내가 다시 만들었다

`git archive 6891372`를 `%TEMP%\ccg-critacct-r2\wt`로 뽑아(레포·`.git` 무접촉) `sweep_lane` 획득과
레인 안 디스크 재확인 **두 조각만** 도려내고 같은 테스트를 돌렸다:

```
원본        [N1] 두 훑기가 실제로 물어본 횟수 = 3 · ["one@…","two@…","three@…"]   ok
레인 제거   [N1] 두 훑기가 실제로 물어본 횟수 = 6 · ["one","one","two","two","three","three"]   FAILED
```

**못이 헛못이 아니다.** 같은 프로세스 안의 두 창이 곧 두 스레드라, 이 in-process 못은 실물과
같은 판을 잰다(실 두 창 재현이 없다는 빌더의 자기 신고는 사실이지만, 이 축에서는 감점 사유가 아니다).

### N2 — 문장이 코드가 됐다

```
[N2] 구역 밖 = Some(Disabled)                      ← 교환을 시작은 한다(전송에서 거절)
[N2] 구역 안 = Some(RotateForbidden("warm@x"))     ← 시작조차 안 한다
[N2] force_refresh(구역 안) = Some(RotateForbidden("warm@x"))   ← 401 경로도 같은 관문
```

회전으로 가는 문 **둘 다** 관문을 지난다. 401 응답 자체를 못 만든 것은 실 HTTP 0건 규율과
맞바꾼 자리이고, 잰 것이 *"교환을 시작하는가"*라는 빌더의 자기 신고는 정확하다.

---

## 결함

### G1 ★ §3 — **채팅을 지워도 「사용 중」이 안 걷힌다**(빌더가 「F1-b」로 닫았다고 적은 자리)

실 exe · 계정 2개 · 채팅 둘(`c-a`「첫 채팅」·`c-b`「둘째 채팅」, 둘 다 `one@ccg.test` 바인딩).
둘 다 턴을 한 번씩 돌려 런타임을 살린 뒤, 사이드바에서 **`c-a`를 삭제**(우클릭 → 삭제 → 확인):

```
삭제 전   chat:status = [{c-a, done, account:one@}, {c-b, done, account:one@}]
          picker 한 줄 = "one현재 | 남음 5시간 90% · 주간 80% | 사용 중 · 첫 채팅"

삭제 직후 (3초)
          디스크  chats-v3/index.json = {"order":["c-b"]}          ← 삭제는 됐다
          디스크  chats-v3/status.json = c-b 한 줄               ← prune도 됐다
  ★       chat:status = [{c-a, done, account:one@}, {c-b, …}]     ← 지운 채팅이 아직 계정을 문다
  ★       picker 한 줄 = "one현재 | … | 사용 중 · 다른 자리"      ← 이름표까지 잃고 유령이 됐다

+12초 무입력   브로드캐스트 7건 → 7건 (0건)                        ← 스스로 안 낫는다
그 다음 턴     chat:status = [{c-b, …}] · 칩 = null                ← 그제서야 걷힌다
```

**두 번 돌려 두 번 다 같았다**(결정적).

기제(코드로 확정):

1. 본채팅 삭제는 `chats:save`(목록 REPLACE) → `chats_v3::write_chats` → `status::retain(&order)`다.
   **`Op::Dispose`를 아예 안 보낸다** — `engine::dispose_chat`의 호출자는 `win.rs:759`
   `session_close` **한 곳뿐**이다.
2. 그 유일한 호출자마저 `chats_v3::remove_chat(id)`를 **먼저** 부르고, 그 안이
   `crate::status::forget_one(id)`로 행을 지운다. 그러니 뒤이어 오는
   `status::clear_runtime(&chat)`은 **맵에 없는 키**를 만나 `false`를 돌려주고,
   빌더가 그 반환값에 매단 `emit_all(CHAT_STATUS, …)`이 **영원히 안 나간다**.

즉 R2가 새로 판 문은 두 삭제 경로 모두에서 **닫힌 채로 태어났다.** 실제로 값을 지우는 것은
`retain`/`forget_one`이고, 그 둘은 **브로드캐스트를 안 한다.** 렌더러의 `liveRows`는 REPLACE로만
갱신되므로(설계 그대로) 마지막 페이로드를 그대로 들고 있는다.

피해:

- 대화를 지운 뒤 계정 picker를 열면 **없는 대화**가 그 계정을 쓰는 중이라고 말한다. 이름표를
  잃어 「사용 중 · **다른 자리**」로 나오므로 사용자는 *어디인지 확인할 방법조차 없다* —
  §3이 존재하는 이유(*"이 계정을 다른 데서 쓰면 안 되니 구분되게"*)가 그 자리에서 무너진다.
- 스스로 낫는 조건이 **아무 채팅에서 다음 턴이 나는 것**이라, 「지우고 오늘 작업을 접는」
  가장 흔한 순간에는 안 낫는다(R1 F2의 피해 창과 같은 모양이다).
- 앱을 껐다 켜면 사라진다(F1의 디스크 청소가 산다). 그래서 R1의 F1보다 **작다** — 그러나
  R1이 불합격 사유로 든 문장이 그대로 남는 자리다.

회귀 못으로: **「같은 계정을 문 채팅 둘 → 하나를 삭제 → 턴 없이 picker → 「사용 중」 0건」**을
실 exe로. `poc-acct-live` A는 *재시작* 축만 밟는다 — 이 결함은 그 못을 100% 통과한다.

---

## 사소 · 부기

- **`poc-store-fanout`은 10항목이 아니라 `ok:` 34줄이다.** 보고서와 앞 두 판정문이 나란히
  「10항목」이라 적어 왔다(이어받은 인용 오류 — 통과 여부 자체는 초록이다). 실측한 수만 적는
  규율이 이 줄에서 한 번 새고 있다.
- R1 보고서의 틀린 수 둘(ccg-auth 100 · poc-acct-store 18)을 지우지 않고 취소선 + 정정 주로
  고친 것은 **좋은 처리**다. 이 라운드에서 그 정정값이 맞다는 것도 확인했다(102 / 25는 R2 기준값).
- **F2 수정의 대가 하나**(측정 못 함 · 설계 판단으로 기록): `PROJECTED`를 「합의값」으로 넓히면
  셸은 *"사용자가 되돌렸다"*와 *"낡은 사본이 뒤늦게 도착했다"*를 **원리적으로 구분할 수 없다**.
  R2 가드(셸 폴백 ↔ 낡은 디바운스 저장)는 폴백이 흡수를 안 거치므로 그대로 살아 있고
  (`a_stale_renderer_copy_cannot_revert_the_runtime_identity` 초록으로 확인), 남는 것은
  「렌더러가 A→B로 바꾼 직후, B 이전 상태를 든 사본이 도착하는」 창뿐이다. 같은 창의 저장은
  최신 상태로 직렬화되므로 재현식을 못 만들었다 — **결함으로 세지 않고 위험으로만 적는다.**
- **N2의 부작용 하나**(코드 확정 · 실 HTTP 없이는 관측 불가): 서버가 죽인 토큰을 가진 계정은
  워밍에서 `RotateForbidden`으로 실패하고, 두 번 반복되면 3분 격리에 들어간다. 그 창에 사용자가
  Account 탭을 열면 그 계정만 캐시로 갈음된다. 출구는 있다(「다시 시도」=`retry:true`가 격리를
  푼다 — F5). 규약이 서로 맞물려 있음을 확인만 해 둔다.
- 추가 채팅 창(`SessionWindow`)의 §3 칩 부재는 `renderer-divergence.md` §6.6에 한계로 적혀 있다 —
  이번 라운드의 결함으로 세지 않는다.
- 체크리스트 4번의 기록 요구는 **충족**이다: `renderer-divergence.md` §6.5(★R2 마이그레이션
  선행)·§6.6(★R2 정정 1·2 + F2)·§6.7(★R2 `retry` + N1·N2 정정) 전부 존재하고, R1의 틀린 문장
  (「키가 있으면 살아 있는 런타임」)이 정정 주로 고쳐져 있다.

## 수정 라운드에 넘기는 것

1. **G1** — 「사용 중」을 걷는 진짜 자리는 `Op::Dispose`가 아니라 **행을 지우는 자리**다.
   `status::retain`·`status::forget_one`이 실제로 무언가를 지웠으면 `chat:status`가
   한 번 나가게 한다(또는 삭제 경로가 지우기 **전에** `clear_runtime` + 브로드캐스트를 지나게 한다).
   겸해 본채팅 삭제 경로에 `dispose_chat`이 없는 것도 함께 본다 — 상주 CLI가 붙어 있으면
   지운 대화의 프로세스가 남는다(§3 밖의 사실이라 이 판정에는 안 넣었다).
2. 회귀 못은 **삭제 축**으로 한 줄 더: 재시작 축(`poc-acct-live` A)은 이 결함을 못 잡는다.

## 부기 — 이 패스가 지킨 규율

- 레포 코드·하네스 **0줄 수정**. 프로브(`probe.mjs`)와 변이 트리(`wt/`)는 **전부 레포 밖**
  (`%TEMP%\ccg-critacct-r2\`). `git worktree` 미등록(`git archive` + `tar`) — 공유 `.git` 무변.
- 남의 갈래 미커밋 변경(`crates/ccg-fs/src/git.rs`)·미추적 3건 **무접촉**. `reset`·`checkout`·
  `stash`·`git add -A` **0회**.
- 기준 결과 파일 무훼손 — 산출물은 `--out`으로 갈랐다:
  `docs/critic/acct-live-critr2.json`(16항목) · `docs/critic/m11-r1-switch-critacctr2.json`(6시나리오).
  `acct-live-r2.json`·`m11-r1-switch*.json` 원본은 안 건드렸다.
- 빌드 격리 `target-critacct2`(새로 판 트리) · 변이 빌드 `%TEMP%\…\mut-target`. `target-acct`
  무접촉. 이름 기반 kill 0회 — 사용자 실앱 5개 프로세스는 주행 전후 그대로다.
