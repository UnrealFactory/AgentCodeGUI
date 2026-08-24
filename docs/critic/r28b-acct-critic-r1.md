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
