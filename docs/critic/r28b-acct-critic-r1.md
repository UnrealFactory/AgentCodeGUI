# R28b 「ACCT」 확인 크리틱 R1 — 판정문

- 대상: `feature/3.0.0-beta` / `6a6c573` · `65bf1d7` (ACCT R1)
- 방식: 빌더 보고서를 **근거로 쓰지 않는다.** 전부 다시 빌드하고, 실 exe를 띄워 실측했다.
- 격리: `CARGO_TARGET_DIR=target-acct` · `CCG_HOME=%TEMP%\ccg-critacct\*` · CDP 9481~9499 ·
  전 주행 `CCG_NO_NET=1` + **합성 계정**(`ccg-auth-probe seed`) → **실계정 토큰 열람 0회 · 실 HTTP 0건**.
  종료는 **내가 spawn한 PID 트리만**(사용자 실앱 `AgentCodeGUI.exe` 7개 프로세스는 주행 전후 그대로 살아 있음).

## 판정: **불합격**

빌더가 「완료」로 적은 네 절 중 **§1은 실제로 산다**(첫 페인트 8ms를 실측했다).
그러나 **§3·§3-b·§4는 각각 실 exe에서 무너진다** — 셋 다 *그 기능이 존재하는 이유*가
무너지는 자리이고, 셋 다 빌더의 검증에는 그 판이 없었다(단위·스텁 하네스만 돌았다).

| 절 | 빌더 주장 | 실측 |
|---|---|---|
| §1 첫 페인트 | cachedOnly 6.19ms | **탭 클릭 → 8ms에 계정 3개 게이지**(실조회 0회) ✔ |
| §1 실패/재시도 | 상태 분리 + 수동 재시도 | 문구·버튼 ✔ / **격리 3분 동안 버튼이 셸에서 무동작**(F5) |
| §3 「사용 중」 | 「키가 있으면 살아 있는 런타임」 | **재시작하면 죽은 채팅이 영원히 「사용 중」**(F1) |
| §3 자리 이름 | 「본채팅」·「2번 자리」 | **본채팅도 「1번 자리」**(F4 — `MAIN_SLOT_NAME`은 죽은 코드) |
| §3-b 되돌리기 | 「원 계정으로 복원」 | **화면만 복원. 재시작하면 실수한 계정으로 실제 실행**(F2) |
| §4 마이그레이션 | 「말없이 1번째로 갈아타는 사고를 막았다」 | **업그레이드 첫 세션이 정확히 그 사고를 낸다**(F3) |

---

## 실측 (전부 이 라운드에서 직접 돌렸다)

### 초록으로 확인된 것

| 항목 | 결과 |
|---|---|
| `npm run typecheck` (node·web) + `typecheck:app` | **3종 초록** |
| `cargo test -p ccg-auth` | **82 + 14 + 2 + 1 = 99 통과 · 0 실패**(빌더 주장과 일치) |
| `cargo test -p agentcodegui` | **133 통과 · 0 실패**(일치) |
| `node scripts/poc-acct-store.mjs` | **18항목 전부 통과**(보고서는 16이라 적었다 — 수치만 불일치) |
| `node scripts/poc-limit-resume.mjs` | **141 통과 · 0 실패** — M11 훅 경로 무회귀 |
| `node scripts/poc-store-fanout.mjs` | 10항목 전부 통과 |
| `node scripts/poc-account-switch.mjs --exe=target-acct/release/agentcodegui.exe --out=-critacct` | **시나리오 6개 PASS · findings 0** |

★ 마지막 줄이 중요하다. 빌더는 이 하네스를 「미완·미주행」으로 남겼다.
**크리틱이 대신 돌렸고 초록이다** — M11 자동 전환은 ACCT 변경 위에서 무회귀다.
(리포트: `docs/critic/m11-r1-switch-critacct.json` — 기준 파일 `m11-r1-switch.json`은 `--out`으로 보호했다.)

### §1 — 규약은 그대로, 기다리는 쪽만 끊겼다 ✔

계정 3개 · 디스크 캐시 3분 전(TTL 밖) · `CCG_NO_NET=1`:

```
Account 탭 클릭 → 첫 게이지까지 8ms
DOM: one@ccg.test | 기본 · 맨 위 | 5시간 90% 남음 | 주간 80% 남음 | 마지막으로 확인한 값
     two@ccg.test |               | 5시간 89% 남음 | 주간 75% 남음 | 마지막으로 확인한 값 | 맨 위로
     three@ccg.test|              | 5시간 88% 남음 | 주간 70% 남음 | 마지막으로 확인한 값 | 맨 위로
탭을 열며 나간 조회 = {cachedOnly:true} 하나 (실조회 0회)
부팅 워밍 봉투 = {priority:"one@ccg.test", warm:true} 1회
```

실패 주입(디스크 캐시 없음 + `CCG_NO_NET`)에서도 행이 사라지지 않고
「한도를 못 불러왔어요 · 다시 시도」가 **계정마다** 서고, 누르면 `accountsUsage({priority})`가
새로 나간다(호출 2 → 3). 두 표면 동시 오픈의 중복 0은 스토어의 인플라이트 합류 + 60초 TTL로
서고(poc-acct-store A/D2), 실 exe에서도 탭을 열 때 실조회가 0이었다.
2분 디스크 TTL도 무회귀다(`the_two_minute_disk_ttl_is_the_gate…` 초록: 1분 전=적중·표식 없음 /
3분 전=값 유지 + `stale` / 없음=`unavailable`).

---

## 결함

### F1 ★ §3 — 「사용 중」 칩이 재시작 뒤 **영원히 켜져 있다**

빌더의 규약 문장은 이것이다(코드 주석·`renderer-divergence.md` §6.6·프로토콜 주석 모두):

> `account` 키가 있으면 **살아 있는 런타임**이다. `status.json`에서 재구성한 행에는 이 키가 없다.

**틀렸다.** 「재구성한 행」(= `status.json`에 항목이 아예 없어 `empty_lite`로 만드는 행)에만
없다. 정상 경로는 `ccg_store::status::set()`이 `lite::build`의 결과를 **통째로** 메모리 맵에
넣고 `flush()`가 그 맵을 그대로 디스크에 쓴다. `load_boot`는 `busy`·`ask`·`bgActive`·`status`·
`unread`만 강제하고 `account`·`panelId`는 **건드리지 않는다.**

실측(격리 홈, 턴 1회 → 종료 → 재기동):

```
chats-v3/status.json
{"version":1,"statuses":{"c-a":{"chatId":"c-a","status":"done",
  "account":"one@ccg.test","panelId":"default::0","busy":false,...}}}

재시작 직후(아무 런타임도 없음) chat:status =
  [{"chatId":"c-a","status":"done","busy":false,"account":"one@ccg.test"}]
설정 ▸ Account 배지 = ["기본 · 맨 위", "사용 중 · 1번 자리"]
```

즉 **한 번이라도 턴을 돌린 채팅은 그 뒤 모든 부팅에서 그 계정을 「사용 중」으로 만든다.**
§3이 존재하는 이유(*"이 계정을 다른 데서 쓰면 안 되니 구분되게"*)가 통째로 죽는다 —
늘 켜져 있는 경고는 없는 것보다 나쁘다. 체크리스트의 「세션 종료 시 소멸」도 이 자리에서 깨진다.

부수 사실 둘(같은 뿌리):
- `Op::Dispose`는 슬롯만 지우고 마지막 lite를 갱신하지 않는다 → 같은 세션 안에서도 안 걷힌다.
- 허브에 슬롯 회수가 없어, 상주 CLI가 죽어도 `rt.identity()`는 살아 있어 칩이 남는다.

### F2 ★ §3-b — 되돌리기가 **화면만** 되돌린다(재시작하면 실수가 되살아나고, 그 계정으로 실행된다)

시나리오(실 exe, 가짜 CLI의 계정별 대본으로 「어느 계정이 실제로 돌았나」를 판별):

```
chip 처음:        Haiku 4.5 · 최소 · 일반 · one
picker에서 two 선택 → chip: … · two
되돌릴 줄:        "one → two 전환됨 · 되돌리기"
되돌리기 클릭  → chip: … · one          ← 화면은 복구된 것처럼 보인다
디스크 identity:  two@ccg.test          ← ★ 파일에는 실수가 그대로 남았다
─ 앱 재시작 ─
재시작 chip:      Haiku 4.5 · 최소 · 일반 · two
재시작 턴 결과:   RAN-two_ccg.test      ← ★ 실수한 계정의 한도를 태운다
```

기제(코드로 확정): `chats:save`의 정체성 흡수는
`ccg_store::legacy_bridge::renderer_authored(id, fp)` 뒤에 있고, 그 판정은
*"셸이 마지막으로 렌더러에 투영한 지문과 다른가"*다. **되돌리기가 복원하는 값은
정의상 「마지막으로 투영한 값」과 같다** → 지문 동일 → 「에코」로 분류 → 정체성 미갱신.
전환(다른 값)은 통과하고 되돌리기(옛 값)만 막히는 **구조적 비대칭**이다.
(전환·되돌리기 사이에 `chats:get`이 한 번 끼면 투영 지문이 갱신돼 되돌리기가 먹는다 —
그래서 채팅을 갈아탔다 오면 되고, 곧장 누르면 안 된다. 재현이 들쭉날쭉해 보이는 이유다.)

되돌린 **직후 턴을 보내면** 실행 경로가 정체성을 다시 물질화해 정상 복구된다(실측
`RAN-one_ccg.test`). 즉 피해 창은 「되돌리고 → 턴 없이 앱 종료」다 — 실수를 알아채고
그날 작업을 접는, 가장 흔한 순간이다.

### F3 ★ §4 — 업그레이드 **첫 세션**이 정확히 「말없이 1번째 계정으로 갈아타는」 사고를 낸다

빌더가 마이그레이션을 만든 이유를 그대로 옮기면:
*"옮기지 않고 무시만 하면 3번째를 기본으로 쓰던 사용자의 새 채팅이 말없이 1번째로 갈아탄다."*
스토어 마이그레이션 자체는 돈다. **그런데 화면과 실행이 그 결과를 첫 세션 내내 못 본다.**

2.6.2 승계 판(`defaultEmail`이 3번째를 가리킴)으로 실측:

```
시드:            one > two > three | defaultEmail: three
부팅 후 파일:    three > one > two | defaultEmail: three     ← 마이그레이션 OK
그 세션의 UI:    설정 ▸ Account 목록 = one, two, three       ← ★ 옛 순서
                「맨 위로」 버튼이 one@에 없다(= UI는 one을 기본으로 안다)
본채팅 chip:     … · one                                      ← ★ 옛 기본(three)이 아니다
새 채팅 chip:    … · one                                      ← ★ 그 사고 그대로
─ 재시작 ─
재시작 새채팅:   … · three                                    ← 그제서야 맞다
```

원인 둘이 겹친다:
1. `ipc/system.rs::list_claude_accounts`는 `accounts.json`을 **직접** 읽는다 —
   `ccg_auth::claude::list_accounts()`를 안 거치므로 `ensure_default_migrated()`를 촉발하지 않고,
   마이그레이션 전 순서를 그대로 돌려준다.
2. 마이그레이션을 실제로 트리거하는 것은 `accounts_usage`인데, 워밍은
   `ensureAccounts().then(() => refreshUsage(...))`라 **목록 조회가 언제나 먼저**다.
   그 목록이 렌더러 스토어에 60초 TTL(`LIST_TTL`)로 눌러앉고 아무도 무효화하지 않는다.

같은 이유로 `engine/ident.rs::defaults()`도 `accounts.json`을 직접 읽어 마이그레이션 이전
배열의 0번을 실행 정체성의 기본으로 쓴다.

정상(이미 마이그레이션된) 세션의 §4는 **문제없다** — 실측:
「맨 위로」(two@) 클릭 → 파일 `two > three > one` · `defaultEmail: two`, 탭 목록 즉시 반영,
새 채팅 chip = `two`. 순서가 곧 기본이라는 규약과 `defaultEmail` 되채움(2.6.2 공존)도 확인했다.

### F4 §3 — 본채팅의 자리 이름이 「본채팅」이 아니라 「1번 자리」다

`lite::build`는 `panelId`를 `panel_id_for_chat()`으로 채우는데, 마이그레이션이 만드는
`default` 보드(`count:1`, `chrome:"ide"` = 본채팅 화면)가 본채팅을 슬롯 0으로 물고 있다.
실측 `panelId = "default::0"` → `slotsUsing`이 `slotOf() != null`이라 **패널 번호를 먼저 고른다**
→ 문구가 「사용 중 · 1번 자리」. 결과:

- `MAIN_SLOT_NAME`(「본채팅」)·`putSlotNames('chats', …)`의 제목 이름표는 **실사용에서 도달 불가**.
- 멀티 보드의 첫 자리도 「1번 자리」라 **본채팅과 문구가 충돌**한다 — 어디서 쓰는지 못 가린다.

`scripts/poc-acct-store.mjs`의 E 절이 「사용 중 · 본채팅」을 통과시킨 이유는
픽스처가 `panelId: ''`이기 때문이다. 실 셸은 그런 행을 안 낸다 — **하네스가 현실과 갈렸다.**

### F5 §1 — 「다시 시도」가 격리 3분 동안 셸에서 **무동작**

`accounts_usage`의 건너뛰기는
`skip = cached_only || is_dead(&email) || (warm && 토큰 만료)`다. **수동 재시도를 알리는
인자가 없다**(`force`는 렌더러 TTL만 넘고 셸에는 안 실린다 — `refreshUsage`가 보내는 것은
`{priority, warm}`뿐). 그래서 연속 2회 실패로 격리된 계정은 사용자가 「다시 시도」를 눌러도
`fallback_row`로 곧장 떨어지고 조회가 아예 안 나간다. 3분 동안 그 버튼은 아무 일도 안 한다.
(§1의 요구가 「실패를 데이터 없음으로 뭉개지 않기 **+ 수동 재시도**」인데 뒷쪽이 반만 산다.)
※ 이 건은 **코드 경로 확정**이다 — `CCG_NO_NET`에서는 「격리로 건너뜀」과 「조회 후 실패」가
바깥에서 구분되지 않아 실측 판별식을 만들지 못했다. 그 점을 감안해 F1~F4보다 낮게 둔다.

부수: `refreshUsage`는 인플라이트가 있으면 `force`를 무시하고 합류한다. 워밍(토큰 만료 계정을
건너뛰는 조회)이 도는 사이 누른 재시도는 그 워밍 결과를 받는다.

### 사소

- `poc-acct-store.mjs`는 **18항목**인데 커밋 메시지·보고서는 16이라 적었다.
- 추가 채팅 창(`SessionWindow`)에 칩이 없는 것은 `renderer-divergence.md` §6.6에 한계로
  기록돼 있다 — 이번 라운드의 결함으로 세지 않는다.
- `renderer-divergence.md` §6.5·§6.6·§6.7 기록은 **존재한다**(체크리스트 4번 충족).
  다만 §6.6의 「키가 있으면 살아 있는 런타임」 문장은 F1이 참이라 **문서도 함께 틀렸다.**

---

## 수정 라운드에 넘기는 것 (우선순위)

1. **F1** — `account`·`panelId`가 `status.json`에 실리지 않게 한다(가장 단순한 자리는
   `ccg_store::status`의 디스크 직렬화에서 두 키를 빼는 것, 또는 `load_boot`의 부팅 강제에
   두 키 제거를 추가하는 것). 겸해 `Op::Dispose`가 마지막 lite를 계정 없이 다시 앉히게 한다.
   **회귀 못으로**: 「턴 1회 → 종료 → 재기동 → 설정 ▸ Account에 「사용 중」 0건」을 실 exe로.
2. **F2** — 되돌리기가 정체성에 닿게 한다. 에코 가드를 우회할 명시 경로가 필요하다
   (되돌리기 시 투영 지문을 무효화하거나, 계정 복원을 `chats:save`가 아닌 정체성 채널로 보낸다).
   **회귀 못으로**: 「전환 → 되돌리기 → 턴 없이 재시작 → 원 계정으로 실행」.
3. **F3** — 마이그레이션을 **부팅에서 한 번, 첫 목록 조회보다 먼저** 확정한다
   (`ipc/system.rs`의 두 목록과 `engine/ident.rs::defaults()`가 `ccg_auth` 파생값을 지나게 하거나,
   부팅 경로에서 `ensure_default_migrated()`를 명시 호출). **회귀 못으로**:
   「`defaultEmail`=3번째 스토어로 첫 부팅 → 그 세션의 새 채팅이 3번째 계정」.
4. **F4** — 본채팅 판별을 자리 번호보다 앞세운다(`default` 보드/`chrome:"ide"`를 자리로 세지 않기).
5. **F5** — `auth:accounts-usage`에 수동 재시도 표식을 하나 더해 `is_dead`를 넘게 한다.

## 부기 — 이 라운드가 지킨 규율

- 남의 미커밋 변경(`src-tauri/src/engine/codex_limit.rs`·`limit_probe.rs`)은 읽지도 고치지도 않았다.
- 코드·하네스 **0줄 수정**. 크리틱 주행 스크립트는 전부 레포 밖(`%TEMP%\ccg-critacct\`)에 두었다.
- 기준 결과 파일 무보존 훼손 없음(`--out=-critacct`).
- 산출물: `docs/critic/m11-r1-switch-critacct.json`(poc-account-switch 6시나리오 PASS 리포트).
  실 exe 주행 스크립트와 격리 홈은 `%TEMP%\ccg-critacct\`에 남겨 두었다(레포 밖).

> 커밋 사고 한 줄: 이 파일을 스테이징한 순간 병렬 갈래(GIT)의 커밋이 겹쳐 한 번은 그쪽
> 커밋(`3e6d42a`)에 딸려 들어갔다. 남의 커밋은 손대지 않았고, 그쪽이 스스로 정리한 뒤
> (`530ad23`) 이 판정문은 제 커밋으로 따로 앉았다.

---
---

# 2차 독립 패스 (같은 라운드 · 다른 크리틱 · 새 컨텍스트)

오케스트레이터가 **같은 프롬프트로 ACCT 확인 크리틱 R1을 한 번 더 스폰**했다. 위 판정문은
이미 커밋(`84ec0e8`·`3aec086`)돼 있었고, 그 사이 ACCT 갈래는 F1·F2·F3의 수정을 워킹트리에
**미커밋으로** 들고 있었다. 그래서 이 패스는 **위 판정문을 근거로 쓰지 않는다** — 커밋
`65bf1d7` 자체를 레포 밖 추출본에서 처음부터 다시 재고, 위 결론이 독립 재현되는지만 본다.
결론은 하나 갈렸다(F3의 **크기**). 그리고 양쪽 다 못 본 자리가 둘 나왔다.

## 격리 (이 패스가 만진 것 전부)

| 항목 | 값 |
|---|---|
| 대상 트리 | `git archive 65bf1d7` → `%TEMP%\ccg-critacct2\wt` (**`git worktree` 미등록** — 공유 `.git` 상태 무변) |
| `node_modules` | 레포 것을 **정션**(읽기 전용 사용) |
| `CARGO_TARGET_DIR` | `%TEMP%\ccg-critacct2\target` · `…\target2` (`target-acct`는 ACCT 갈래가 그 시각 재빌드 중이라 안 건드렸다) |
| 실 HTTP · 실계정 토큰 | **0건 · 0회** — 네트워크를 타는 경로를 아예 안 돌렸고 홈은 전부 합성이다 |
| 프로세스 | `cargo`·`node`·`tsc`만. **이름 기반 kill 0회** |
| 레포 워킹트리 | **무접촉** — 남의 미커밋 변경은 `git diff`로 읽기만 했다 |

## 초록 — 내가 직접 잰 수치 (앞 판정과 두 군데 다르다)

| 항목 | 이 패스의 실측 | 비고 |
|---|---|---|
| `typecheck` + `typecheck:app` | **3종 초록** | 일치 |
| `cargo test -p ccg-auth` | 바이너리 7벌 = 82 + 0 + 0 + 14 + 2 + 1 + 1 = **100 통과** | ★ 보고서도 앞 판정도 **99**로 적었다. `tests/t1_list_edit_race.rs`(1건)가 양쪽에서 빠졌다. 또 `critic_m11r2_tls`·`critic_m11r2_token`은 **0 tests**로 돈다(`0 filtered out` — 컴파일 자체에 테스트가 없다). 이 두 벌이 조용히 비어 있는 것은 ACCT의 일이 아니지만, 「99 통과」라는 문장이 그것을 덮고 있었다 |
| `cargo test -p ccg-store` | **76 통과** | 두 보고 모두 이 크레이트를 따로 세지 않았다 |
| `cargo test -p agentcodegui` | **133 통과** | 일치 |
| `node scripts/poc-acct-store.mjs` | **18항목 통과**(`ok` 줄을 세서) | 보고서의 「16항목」은 틀렸다. 앞 판정과 일치 |
| `node scripts/poc-limit-resume.mjs` | **141 통과 · 0 실패** | M11 경로 무회귀 |
| `node scripts/poc-store-fanout.mjs` | **10항목 통과** | |
| `renderer-divergence.md` §6.5·§6.6·§6.7 | **존재**(443·478·495행) | 체크리스트 4번의 기록 요구 충족 |

## 결함 재확인 — 이번엔 **런타임 프로브**로

앞 판정은 실 exe로 쟀고, 이 패스는 실 exe를 다시 짓는 대신 **추출본 안에**(레포 밖이다)
통합 테스트 두 벌을 세워 같은 자리를 눌렀다. 둘 다 `ccg_store::testhome::take()` 증표 안에서
돈다.

### F1 — 재현됨. 문장이 아니라 파일이 반증한다

`crates/ccg-store/tests/critacct2_f1_probe.rs`(추출본 전용) 출력 그대로:

```
[F1-probe] 디스크 = {"version":1,"statuses":{"c-a":{"chatId":"c-a","status":"done",
            "account":"one@ccg.test","panelId":"default::0","busy":false,…}}}
[F1-probe] 재기동 직후 행 = {"chatId":"c-a","status":"done",
            "account":"one@ccg.test","panelId":"default::0",…}
[F1-probe] 결론: 디스크에 account=true panelId=true /
            재기동 행 account=Some("one@ccg.test") panelId=Some("default::0")
```

`status::set`이 `lite::build`의 결과를 통째로 맵에 넣고 `flush`가 그대로 쓰며 `load_boot`는
`busy`·`ask`·`bgActive`·`status`·`unread`만 강제한다 — **런타임이 0개인 부팅에서 두 키가
그대로 살아난다.** 「키가 있으면 살아 있는 런타임」(`engine/lite.rs` 주석 · `protocol.ts` ·
divergence §6.6)은 **거짓**이다. 앞 판정의 F1이 그대로 선다.

### F2 — 재현됨. 그리고 **왜 단위 테스트를 빠져나갔는지**까지 나왔다

첫 시도는 **헛초록**이었다. 손으로 만든 `chats:save` payload를 보냈더니 되돌리기가 파일에
잘 닿았다. 이유는 에코 판정이 *지문 동일성*이라 **손으로 만든 모양은 애초에 지문이 달라 늘
통과**하기 때문이다. 실렌더러는 `chats:get`으로 **받은 사본**을 들고 있다가 `picker.account`만
갈아 되돌려 보낸다. 그 사본을 그대로 쓰도록 프로브를 고치자 바로 재현됐다:

```
[F2-probe] 렌더러 사본의 picker = {"model":"haiku","effort":"xhigh","mode":"normal","account":"one@ccg.test"}
[F2-probe] ② 전환(one→two) 뒤 디스크 = Some("two@ccg.test")   ← 전환은 닿는다
[F2-probe] ③ 되돌리기 뒤 디스크     = Some("two@ccg.test")   ← ★ 되돌리기는 안 닿는다
[F2-probe/대조군] 투영이 낀 되돌리기 = Some("one@ccg.test")   ← chats:get이 한 번 끼면 먹는다
```

**이 헛초록 자체가 이 라운드의 교훈이다.** 「합성 payload로 도는 테스트」는 이 결함을 절대
못 잡는다 — 못은 반드시 *`chats:get`이 준 사본을 되보내는* 모양으로 박아야 한다.

### F3 — 기제는 참. **크기는 앞 판정이 과대**하다 (이 패스의 정정)

기제는 전부 확인했다:
- `src-tauri/src/main.rs`에 계정 마이그레이션 호출이 **없다**(`ipc::boot_prewarm()`은 LSP 전용 —
  `ipc/lsp.rs:91`, 계정을 안 만진다).
- `ipc/system.rs::list_claude_accounts`(120행)·`list_codex_accounts`(160행)·
  `engine/ident.rs::defaults()`는 `accounts.json`을 **직접** 읽어 `ccg_auth`의 문을 안 지난다.
- `warmUsage`는 `ensureAccounts().then(() => refreshUsage({warm:true}))` — **목록이 언제나 먼저**다.
- `invalidateAccounts()`의 호출자는 `Settings.tsx:428` **한 곳뿐**이다(로그인·삭제·정렬 뒤).
  부팅 마이그레이션 뒤에 목록을 무효화하는 자리는 없다.

**그런데 자기 치유가 있다.** 마이그레이션을 실제로 돌리는 것은 워밍의 `accounts_usage`
(→`ccg_auth::claude::list_accounts()`→`ensure_default_migrated()`)이고 그건 시작 1.5초 뒤에
돈다. 그 뒤 렌더러 목록은 `LIST_TTL = 60_000`이 지나 **다시 읽히는 순간 스스로 낫는다**
(`list_claude_accounts`는 파일을 직접 읽으니 그때는 이미 이관된 순서다). 실행 정체성
(`ident::defaults()`)도 같은 이유로 마이그레이션 직후부터 맞는다.

따라서 정확한 크기는 「업그레이드 **첫 세션 내내**」가 아니라 **「부팅 후 최대 60초, 그리고
그 창 안에서 만들거나 계정을 고른 채팅」**이다. 앞 판정의 실 exe 실측(재시작해야 맞더라)은
그 60초 창 안에서 찍혔을 가능성이 크다. **나는 실 exe 재현을 하지 않았다** — 이 정정은
코드 확정이지 실측 반증이 아니다. 어느 쪽이든 **결함인 것은 같고**, 고칠 자리도 같다.

### F4 · F5 — 코드로 확정(앞 판정과 동일)

- F4: `migrate_v3.rs:474~485`가 `id:"default"` 보드를 만들며 `def_slots[0] = active_chat_id`를
  넣는다 → `panel_id_for_chat(본채팅) = "default::0"` → `accounts.ts:347`의
  `slot != null ? panelSlotName(slot) : slotNames[…]`이 **번호를 먼저 고른다** → 「1번 자리」.
  `MAIN_SLOT_NAME`은 도달 불가. 하네스가 이걸 통과시킨 이유도 확인했다 —
  `poc-acct-store.mjs:135`의 본채팅 픽스처가 `panelId: null`이다(실 셸은 그런 행을 안 낸다).
- F5: `skip = cached_only || is_dead(&email) || (warm && …)` — **수동 재시도를 알리는 인자가
  없다.** `force`는 렌더러 TTL만 넘고 셸로 안 실린다. 격리 3분 동안 「다시 시도」는 무동작.

## 양쪽 다 못 본 것 둘

### N1 ★ §1의 「동시 두 표면 중복 0」은 **한 창 안에서만** 참이다

`app/src/main.tsx:13~15` — `#session`(추가 채팅 창)·`#mapanel`(멀티 팝아웃)은 **같은 번들을
다른 OS 창에서** 띄운다. 즉 `lib/accounts.ts`의 단일 스토어는 **창마다 한 벌**이고, 그 창들도
`PickerChip`을 그린다(`Chat.tsx:5706`). 그리고 셸의 `accounts_usage`에는 인플라이트 합류가
**없다** — `net.rs`의 `lane(email)`은 토큰 회전용이고 `GATE`는 1200ms 직렬화이지 중복 제거가
아니다. 게다가 `accounts_usage`는 디스크 캐시를 루프 **앞에서 한 번** 읽으므로:

- 두 창이 겹쳐 열리면 조회가 **계정 수 × 2벌** 나간다(코드 주석 자신이 「분당 1~2건 실측」이라
  적은 엔드포인트다 — 429는 `Retry-After`만큼 자며 훑기를 통째로 세운다).
- 나중에 끝난 쪽의 `write_usage_cache(&disk)`가 **자기 낡은 스냅샷으로** 상대의 신선한 값을
  덮는다.

이 라운드는 §3에서 *"창이 여럿이라 렌더러가 모은 표는 자기 창의 자리만 안다"*를 근거로 판정
소스를 셸로 올렸다. **§1은 같은 사실을 안 썼다** — 한 라운드 안의 비대칭이다.
(실 두 창 재현은 못 했다 — 코드 확정. 미커밋 R2 수정에도 이 자리는 안 보인다.)

### N2 「워밍이 토큰을 회전시키는 건 구조적으로 불가능」은 **거의** 참이다

`warm`의 스킵은 `account_access_token()`(디스크 + `expiresAt` 비교, 네트워크·회전 없음)만 본다 —
여기까지는 보고서 그대로고, M11 R2 C1 재발 방지로서 **실제로 산다**. 다만 로컬로는 살아 있는데
**서버가 무효화한** 토큰이면 `fetch_account_usage`가 401/403에서 `force_refresh(email, …)` →
`rotate(email)`로 간다(`net.rs:507~518`, `force_refresh`). 즉 워밍이 회전을 부르는 경로가
하나 남아 있다. 좁고 서버 사정에 달렸지만, 「구조적으로 불가능」이라는 문장은 사실보다 세다.

## 판정 (2차 패스)

**불합격 유지.** 앞 판정의 결론은 독립 재현으로 선다 — F1·F2는 이 패스에서 **런타임으로**
다시 재현했고, F4·F5는 코드로 확정된다. F3은 결함이되 크기가 「첫 세션 내내」가 아니라
**「부팅 후 최대 60초 창」**이다. 여기에 N1·N2가 더해진다.

수정 라운드 우선순위: **F1 → F2 → F3 → N1 → F4 → F5 → N2.**
회귀 못은 앞 판정의 것을 그대로 쓰되, **F2의 못은 반드시 「`chats:get`이 준 사본을 되보내는」
모양**이어야 한다(합성 payload로는 영원히 초록이다 — 이 패스가 그 함정을 직접 밟았다).

## 워킹트리 부기 (판정 시각 2026-08-24 23:35 KST 기준)

빌더 보고의 *"남은 미커밋은 전부 남의 갈래 파일이다"*는 **판정 시각에는 사실이 아니었다** —
`app/src/lib/accounts.ts`·`crates/ccg-auth/src/{claude,codex}.rs`·`crates/ccg-store/src/{status,
legacy_bridge,legacy_bridge_tests}.rs`·`src-tauri/src/{engine/lite.rs,engine/ident.rs,
ipc/parity/usage.rs,ipc/system.rs}`·`src/shared/protocol.ts`·`scripts/poc-acct-store.mjs` 및
신규 `scripts/poc-acct-live.mjs`가 ACCT 자신의 미커밋 변경으로 떠 있었다. 내용은 **1차 판정의
F1·F2·F3에 대한 R2 수정**이다(주석이 「확인 크리틱 R1 F1/F2/F3」을 명시적으로 인용한다).
보고 문장이 쓰인 시점과 판정 시점 사이에 그 라운드가 진행된 것으로 보인다.

**판정 대상은 커밋 `65bf1d7`이므로 그 미커밋 변경은 점수에 넣지 않았고 읽기만 했다.**
참고로 그 변경은 F1(`RUNTIME_ONLY_KEYS` + `clear_runtime`) · F2(`absorb_legacy`가 채택한 지문을
`PROJECTED`에 되적기) · F3(`ensure_default_migrated`를 `pub`으로 올려 세 자리에서 호출)을
겨냥한다. **N1·N2는 그 안에 없다.**

## 부기 — 이 패스가 지킨 규율

- 레포 코드·하네스 **0줄 수정**. 프로브 두 벌(`critacct2_f1_probe.rs`·`critacct2_f2_probe.rs`)은
  **레포 밖 추출본에만** 존재한다(`%TEMP%\ccg-critacct2\wt`).
- `git worktree`를 등록하지 않았다(`git archive` + `tar`) — 공유 `.git` 상태 무변.
- 남의 미커밋 변경 `reset`·`checkout`·`stash` **0회**. `git add -A` **0회**.
- 기준 결과 파일(`bench/results/*`·`bench/shots/*/report.json`·`docs/critic/*.json`) **무훼손** —
  이 패스는 결과 파일을 하나도 쓰지 않았다.
- **위 1차 판정문을 지우지 않았다.** 같은 라운드의 독립 두 패스를 나란히 남기는 편이,
  덮어써서 한쪽 실측을 잃는 것보다 낫다고 판단했다.
